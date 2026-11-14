'use strict';
// The full scan through the helper: started and stopped, what came back sorted into the
// categories, same-size files proven duplicates, and the summary kept for the next start.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const DiskCategories = require('../disk-categories.js');
const DiskGuard = require('../disk-guard.js');
const { writeFileAtomic } = require('../atomic-write.js');
const {
  SCAN_TIMEOUT_MS, CATEGORY_ITEMS_MAX, HASH_FILE_MAX, HASH_TOTAL_MAX, DUPE_GROUPS_MAX,
} = require('./limits.js');

function makeScan({
  helperExe, getSettings, summaryFile, PLATFORM, IS_WIN, cmpKey, trimSep, isBelow, userProfile,
  localAppData, windir, tempDirs, downloads, trashDirs, isContainerDir, helperPresent, scan,
  lastScan,
}) {
  async function catCtx() {
    const s = (await Promise.resolve(getSettings()).catch(() => ({}))) || {};
    return {
      platform: PLATFORM,
      tempDirs, localAppData, userProfile, windir, trashDirs,
      // The guard's own list, so "what the categories refuse to offer" and
      // "what the guard refuses to delete" can never drift apart. A category
      // that always comes back `protected:system` is worse than no category.
      systemDirs: DiskGuard.SYSTEM_PREFIXES,
      devFolders: Array.isArray(s.devFolders) ? s.devFolders.filter((d) => typeof d === 'string') : [],
      downloads,
      installerAgeDays: Number.isFinite(s.installerAgeDays) ? s.installerAgeDays : 30,
      now: Date.now(),
    };
  }

  async function loadSummary() {
    if (lastScan.summaryLoaded) return;
    lastScan.summaryLoaded = true;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(summaryFile, 'utf8'));
      if (parsed && parsed.v === 1) lastScan.lastSummary = parsed;
    } catch { /* none yet */ }
  }

  function killScan(reason) {
    const p = scan.proc;
    scan.proc = null;
    scan.running = false;
    if (scan.timer) { clearTimeout(scan.timer); scan.timer = null; }
    if (reason) scan.error = reason;
    // Mark the run finished HERE, not in the child's exit handler: that handler
    // bails out on `scan.proc === proc`, which is already false by now. Without
    // this, a timeout, a spawn error or a cancel left status() reporting
    // "not running, no result, no error" forever — the failure was invisible.
    scan.doneAt = Date.now();
    if (p) {
      // stdin close is the cancel signal (the helper watches for EOF).
      try { p.stdin.end(); } catch {}
      const force = setTimeout(() => { try { p.kill(); } catch {} }, 2000);
      force.unref();
      p.once('exit', () => clearTimeout(force));
    }
  }

  // Ancestor-before-descendant order for the classified-ancestor skip below.
  // That skip only works when the parent is seen FIRST, and neither the scan
  // stream nor the Living Index returns directories in path order: with
  // "…\Default\Cache\Cache_Data" classified before "…\Default\Cache", both
  // became items and the category counted the same gigabytes twice while
  // offering two overlapping rows. A plain ascending path sort is enough — a
  // real ancestor is always a strict prefix of its descendants, so it always
  // sorts first.
  function byPathAsc(list) {
    return [...(list || [])].sort((a, b) => {
      const x = String((a && a.p) || '').toLowerCase();
      const y = String((b && b.p) || '').toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
  }

  // Classify everything the scan reported and build the category item lists
  // the clean endpoint resolves ids against. Dirs first (a cache DIR is one
  // item, not thousands of files), then detail files not already covered by a
  // classified ancestor dir.
  async function buildCategories() {
    const ctx = await catCtx();
    const cats = {};
    const add = (cat, p, s, m, kind) => {
      const c = cats[cat] || (cats[cat] = { bytes: 0, count: 0, items: [] });
      c.bytes += s; c.count++;
      c.items.push({ p, s, m, kind });
    };
    const classifiedDirs = [];
    for (const d of byPathAsc(scan.dirs)) {
      const r = DiskCategories.classify({ path: d.p, name: path.basename(d.p), isDir: true, size: d.s, mtime: d.m }, ctx);
      if (!r) continue;
      // A container is skipped WITHOUT joining classifiedDirs, so its children
      // stay eligible and become the items instead of it.
      if (isContainerDir(d.p)) continue;
      // Skip a dir whose classified ANCESTOR is already an item — deleting the
      // ancestor covers it, and double-counting would inflate the category.
      const key = cmpKey(d.p);
      if (classifiedDirs.some((a) => isBelow(key, a))) continue;
      classifiedDirs.push(key);
      add(r.cat, d.p, d.s, d.m, 'dir');
    }
    for (const f of scan.detailFiles) {
      const key = cmpKey(f.p);
      if (classifiedDirs.some((a) => isBelow(key, a))) continue;
      const ext = path.extname(f.n).replace(/^\./, '');
      const r = DiskCategories.classify({ path: f.p, name: f.n, isDir: false, size: f.s, mtime: f.m, ext }, ctx);
      if (!r) continue;
      add(r.cat, f.p, f.s, f.m, 'file');
    }
    for (const c of Object.values(cats)) {
      c.items.sort((a, b) => b.s - a.s);
      if (c.items.length > CATEGORY_ITEMS_MAX) c.items = c.items.slice(0, CATEGORY_ITEMS_MAX);
      c.items.forEach((it, i) => { it.i = i; });
    }
    scan.categories = cats;
  }

  // Verify same-size candidates by full SHA-256, async and bounded. Only
  // verified groups become "duplicates" — a same-size pair alone is a guess.
  async function verifyDupeCandidates(candidates) {
    const groups = (candidates || []).slice(0, DUPE_GROUPS_MAX);
    let hashedBytes = 0;
    const verified = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.paths) || g.paths.length < 2) continue;
      if (g.s > HASH_FILE_MAX) continue;
      // Skip a group that would overflow the per-scan hash budget, but keep
      // going — later groups are not size-ordered, so a smaller one may still
      // fit the remaining budget. `break` here silently dropped every group
      // after the first oversized one, under-reporting verified duplicates.
      if (hashedBytes + g.s * g.paths.length > HASH_TOTAL_MAX) continue;
      const byHash = new Map();
      for (const p of g.paths) {
        try {
          const h = await new Promise((resolve, reject) => {
            const hash = crypto.createHash('sha256');
            fs.createReadStream(p).on('data', (c) => hash.update(c)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
          });
          hashedBytes += g.s;
          const arr = byHash.get(h) || [];
          arr.push(p);
          byHash.set(h, arr);
        } catch { /* vanished or unreadable — skip the file */ }
      }
      for (const paths of byHash.values()) {
        if (paths.length >= 2) verified.push({ s: g.s, paths, wasted: g.s * (paths.length - 1) });
      }
    }
    verified.sort((a, b) => b.wasted - a.wasted);
    return verified;
  }

  async function persistSummary() {
    const byCategory = {};
    for (const [cat, c] of Object.entries(scan.categories)) byCategory[cat] = { bytes: c.bytes, count: c.count };
    lastScan.lastSummary = {
      v: 1, at: Date.now(), root: scan.root,
      bytes: scan.progress.bytes, files: scan.progress.files, dirs: scan.progress.dirs,
      byCategory,
      dupesWasted: scan.dupes.reduce((a, g) => a + g.wasted, 0),
    };
    try { await writeFileAtomic(summaryFile, JSON.stringify(lastScan.lastSummary)); } catch {}
  }

  function startScan(rootRaw) {
    if (!helperPresent()) return { ok: false, error: 'helper_missing' };
    // The mac helper has no `disk-scan` mode, and spawning it would exit
    // non-zero into a generic "scan failed" the user cannot act on. Refuse with
    // a reason instead: the Living Index serves the whole map on that platform,
    // so nothing is actually lost here.
    if (!IS_WIN) return { ok: false, error: 'scan_unsupported' };
    if (scan.running) return { ok: false, error: 'already_running' };
    // Root: a plain drive letter, strictly validated (default C:).
    const m = /^([A-Za-z]):?\\?$/.exec(String(rootRaw || 'C').trim());
    if (!m) return { ok: false, error: 'bad_root' };
    const root = m[1].toUpperCase() + ':\\';

    scan.running = true;
    scan.root = root;
    scan.startedAt = Date.now();
    scan.progress = { dirs: 0, files: 0, bytes: 0 };
    scan.dirs = [];
    scan.detailFiles = [];
    scan.topFiles = [];
    scan.dupeCandidates = [];
    scan.dupes = [];
    scan.categories = {};
    scan.error = null;
    scan.doneAt = 0;
    scan.cancelled = false;
    scan.buf = '';

    // Detail roots: where per-file listing matters (installers + temp files).
    // Segment-safe, so a sibling that merely shares a prefix (D:\Datax against
    // D:\Data) is not swept in — the same test buildOverview makes below.
    const scanRootKey = cmpKey(trimSep(root));
    const detailRoots = [downloads, ...tempDirs].filter((d) => {
      const key = cmpKey(trimSep(d));
      return key === scanRootKey || isBelow(key, scanRootKey);
    });
    let proc;
    try {
      proc = spawn(helperExe, ['disk-scan', root, ...detailRoots], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      scan.running = false;
      return { ok: false, error: 'spawn_failed' };
    }
    scan.proc = proc;
    scan.timer = setTimeout(() => killScan('timeout'), SCAN_TIMEOUT_MS);
    scan.timer.unref();

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      scan.buf += chunk;
      let nl;
      while ((nl = scan.buf.indexOf('\n')) !== -1) {
        const line = scan.buf.slice(0, nl).trim();
        scan.buf = scan.buf.slice(nl + 1);
        if (!line.startsWith('XEDSK ')) continue;
        let ev;
        try { ev = JSON.parse(Buffer.from(line.slice(6), 'base64').toString('utf8')); }
        catch { continue; }
        if (ev.event === 'progress') scan.progress = { dirs: ev.dirs, files: ev.files, bytes: ev.bytes };
        else if (ev.event === 'dirs') scan.dirs.push(...(ev.items || []));
        else if (ev.event === 'files') scan.detailFiles.push(...(ev.items || []));
        else if (ev.event === 'topfiles') scan.topFiles = ev.items || [];
        else if (ev.event === 'dupes') scan.dupeCandidates = ev.groups || [];
        else if (ev.event === 'done') {
          scan.progress = { dirs: ev.dirs, files: ev.files, bytes: ev.bytes };
          scan.cancelled = !!ev.cancelled;
        }
      }
    });
    proc.on('error', () => killScan('scan_failed'));
    proc.on('exit', async () => {
      if (scan.proc === proc) {
        scan.proc = null;
        if (scan.timer) { clearTimeout(scan.timer); scan.timer = null; }
        try {
          if (!scan.cancelled && !scan.error) {
            await buildCategories();
            scan.dupes = await verifyDupeCandidates(scan.dupeCandidates);
            await persistSummary();
          }
        } catch { /* partial state is still shown */ }
        scan.running = false;
        scan.doneAt = Date.now();
      }
    });
    return { ok: true };
  }

  function cancelScan() {
    if (!scan.running) return { ok: true };
    scan.cancelled = true;
    killScan(null);
    return { ok: true };
  }

  return { catCtx, loadSummary, killScan, byPathAsc, persistSummary, startScan, cancelScan };
}

module.exports = { makeScan };
