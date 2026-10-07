'use strict';

// Duplicate verification for the Disk widget, off the request path and with a
// memory. The index proposes same-size files; a group only becomes "duplicates"
// once the CONTENT is shown equal, which means reading the files. That used to
// happen inside every overview request with no cache: measured on a 2.56M-file
// C:\, the helper answered in under a second and the response still took 26.7 s,
// because up to 2 GB of candidates were SHA-256'd from scratch each time.
//
// Three changes, each measured against that number:
//   • A cache keyed on path + size + mtime (DATA_DIR/disk-hashes.json). A file
//     that has not changed is never read twice.
//   • A cheap first pass: the first and last 64 KB. Same-size files that differ
//     there are not duplicates and are never read whole. That is what makes it
//     affordable to drop the old 200 MB per-file limit, which hid exactly the
//     duplicates worth finding (ISOs, videos, game archives).
//   • The answer does not wait. `cachedOnly()` answers from the cache at once;
//     `verify()` runs in the background, bounded per pass, and the caller is
//     told when it has something new.
//
// Pure apart from the injected fs and the cache file; one pass at a time.

const crypto = require('crypto');
const fsDefault = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const CACHE_FILE = 'disk-hashes.json';
const EDGE_BYTES = 64 * 1024;
const CACHE_MAX = 20000;
const DEFAULT_PASS_BUDGET = 4 * 1024 * 1024 * 1024;   // bytes READ per background pass
const SAVE_DEBOUNCE_MS = 3000;

function createDupeVerifier(opts = {}) {
  const fs = opts.fs || fsDefault;
  const dataDir = opts.dataDir || null;
  const cacheFile = dataDir ? path.join(dataDir, CACHE_FILE) : null;
  const passBudget = opts.passBudget || DEFAULT_PASS_BUDGET;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  let cache = null;            // key -> { s, m, e (edge hash), h (full hash), at }
  let saveTimer = null;
  let running = null;          // the pass in flight (a promise)
  let stopped = false;

  const keyOf = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? String(p).toLowerCase() : String(p));

  async function load() {
    if (cache) return cache;
    cache = new Map();
    if (!cacheFile) return cache;
    try {
      const raw = JSON.parse(await fs.promises.readFile(cacheFile, 'utf8'));
      if (raw && raw.v === 1 && raw.files && typeof raw.files === 'object') {
        for (const [k, r] of Object.entries(raw.files)) {
          if (!r || typeof r !== 'object') continue;
          if (!Number.isFinite(r.s) || !Number.isFinite(r.m)) continue;
          const rec = { s: r.s, m: r.m, at: Number.isFinite(r.at) ? r.at : 0 };
          if (typeof r.e === 'string' && /^[0-9a-f]{64}$/.test(r.e)) rec.e = r.e;
          if (typeof r.h === 'string' && /^[0-9a-f]{64}$/.test(r.h)) rec.h = r.h;
          cache.set(k, rec);
        }
      }
    } catch { /* absent or corrupt: start empty, it is only a cache */ }
    return cache;
  }

  function scheduleSave() {
    if (!cacheFile || saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; void save(); }, SAVE_DEBOUNCE_MS);
    if (saveTimer.unref) saveTimer.unref();
  }

  async function save() {
    if (!cacheFile || !cache) return;
    // Bounded: the most recently used entries survive.
    if (cache.size > CACHE_MAX) {
      const sorted = [...cache.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, CACHE_MAX);
      cache = new Map(sorted);
    }
    const files = {};
    for (const [k, r] of cache) files[k] = r;
    try { await writeFileAtomic(cacheFile, JSON.stringify({ v: 1, files })); } catch { /* next save retries */ }
  }

  async function statOf(p) {
    try {
      const st = await fs.promises.stat(p);
      return st.isFile() ? { s: st.size, m: Math.round(st.mtimeMs) } : null;
    } catch { return null; }
  }

  // The cache record for a file as it is NOW, or a fresh one (stale fields
  // dropped) when its size or mtime moved.
  function recordFor(p, st) {
    const k = keyOf(p);
    let r = cache.get(k);
    if (!r || r.s !== st.s || r.m !== st.m) {
      r = { s: st.s, m: st.m, at: now() };
      cache.set(k, r);
    } else {
      r.at = now();
    }
    return r;
  }

  async function hashRange(p, size, edgeOnly) {
    const hash = crypto.createHash('sha256');
    if (!edgeOnly || size <= EDGE_BYTES * 2) {
      await new Promise((resolve, reject) => {
        fs.createReadStream(p).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject);
      });
      return { h: hash.digest('hex'), read: size };
    }
    const fh = await fs.promises.open(p, 'r');
    try {
      const buf = Buffer.alloc(EDGE_BYTES);
      let r = await fh.read(buf, 0, EDGE_BYTES, 0);
      hash.update(buf.subarray(0, r.bytesRead));
      r = await fh.read(buf, 0, EDGE_BYTES, size - EDGE_BYTES);
      hash.update(buf.subarray(0, r.bytesRead));
    } finally { await fh.close(); }
    return { h: hash.digest('hex'), read: EDGE_BYTES * 2 };
  }

  function groupBy(items, field) {
    const m = new Map();
    for (const it of items) {
      const v = it.rec[field];
      if (!v) continue;
      const arr = m.get(v);
      if (arr) arr.push(it); else m.set(v, [it]);
    }
    return m;
  }

  // Verify the candidate groups ({s, paths[]}). With `readBudget` 0 nothing is
  // read: only what the cache already proves is answered. Returns
  // { groups: [{s, paths, wasted}], pending } where `pending` counts the
  // candidate groups that still need reading before they can be answered.
  async function run(candidates, readBudget) {
    await load();
    let budget = readBudget;
    let pending = 0;
    const verified = [];
    for (const g of Array.isArray(candidates) ? candidates : []) {
      if (stopped) break;
      if (!g || !Array.isArray(g.paths) || g.paths.length < 2 || !(g.s > 0)) continue;
      const items = [];
      for (const p of g.paths) {
        const st = await statOf(p);
        if (st && st.s === g.s) items.push({ p, rec: recordFor(p, st) });
      }
      if (items.length < 2) continue;
      let groupPending = false;

      // First pass: the edges.
      for (const it of items) {
        if (it.rec.e) continue;
        const cost = Math.min(g.s, EDGE_BYTES * 2);
        if (budget < cost) { groupPending = true; continue; }
        try {
          const { h, read } = await hashRange(it.p, g.s, true);
          it.rec.e = h;
          if (g.s <= EDGE_BYTES * 2) it.rec.h = h;   // the edges WERE the whole file
          budget -= read;
          scheduleSave();
        } catch { it.rec.e = undefined; }
      }
      // Second pass: whole files, only inside groups whose edges agree.
      for (const sub of groupBy(items, 'e').values()) {
        if (sub.length < 2) continue;
        for (const it of sub) {
          if (it.rec.h) continue;
          if (budget < g.s) { groupPending = true; continue; }
          try {
            const { h, read } = await hashRange(it.p, g.s, false);
            it.rec.h = h;
            budget -= read;
            scheduleSave();
          } catch { /* unreadable now: left for a later pass */ }
        }
        for (const same of groupBy(sub, 'h').values()) {
          if (same.length >= 2) verified.push({ s: g.s, paths: same.map((x) => x.p), wasted: g.s * (same.length - 1) });
        }
      }
      if (groupPending) pending++;
    }
    verified.sort((a, b) => b.wasted - a.wasted);
    return { groups: verified, pending };
  }

  function cachedOnly(candidates) {
    return run(candidates, 0);
  }

  // One background pass at a time; a second caller joins the one in flight.
  function verify(candidates) {
    if (running) return running;
    running = run(candidates, passBudget).finally(() => { running = null; });
    return running;
  }

  async function stop() {
    stopped = true;
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { await running; } catch { /* ignore */ }
    await save();
  }

  return { cachedOnly, verify, stop, _save: save, busy: () => !!running };
}

module.exports = { createDupeVerifier, EDGE_BYTES };
