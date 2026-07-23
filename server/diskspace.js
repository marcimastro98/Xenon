'use strict';

// ── Disk space orchestrator ─────────────────────────────────────────────────
// Drives the helper's `disk-scan` (streaming full-tree size accounting),
// classifies what came back through the CLOSED category list
// (disk-categories.js), guards every deletion through the hard blocklist
// (disk-guard.js) and executes it ONLY via the helper's recycle-bin delete.
// Helper-gated by design (like the Second screen): without the exe the widget
// shows a clear hint and nothing else runs.
//
// Wire contract (the Slideshow shape): the client addresses items as
// categoryId + item ids resolved against THIS module's enumeration — no path
// ever travels client→server. Before deletion each resolved path is re-stated
// live (exists? reparse?) and re-checked against the guard; a refusal is
// reported, never silently dropped.
//
// Duplicates are honest: same-size candidates from the scan are verified by
// full SHA-256 (async streams, bounded per-file and per-scan) and only
// verified groups are shown as duplicates.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const DiskCategories = require('./disk-categories');
const DiskGuard = require('./disk-guard');
const DiskIntelligence = require('./js/disk-intelligence');
const { writeFileAtomic } = require('./atomic-write');

const SUMMARY_FILE = 'disk-summary.json';
const SCAN_TIMEOUT_MS = 15 * 60 * 1000;   // a wedged scan must not hang forever
const CLIENT_DIRS_MAX = 1500;             // treemap payload bound
const CLIENT_FILES_MAX = 200;
const CATEGORY_ITEMS_MAX = 5000;          // per category, size-ordered
const HASH_FILE_MAX = 200 * 1024 * 1024;  // never hash a file beyond this
const HASH_TOTAL_MAX = 2 * 1024 * 1024 * 1024; // …or more than this per scan
const DUPE_GROUPS_MAX = 40;
const DELETE_BATCH_MAX = 16;
// A shell-delete call is bounded, but generously. Recycling a folder on the
// same volume is one rename, but EMPTYING the Bin really deletes per-file: a
// 38 GB Bin is legitimately many minutes of work, and the old 120s bound
// killed the helper mid-operation — every attempt emptied two minutes' worth
// and then reported empty_failed while the Bin visibly shrank.
const SHELL_DELETE_TIMEOUT_MS = 30 * 60 * 1000;
// SHFileOperation answers with these when something INSIDE the tree is held
// open by a running program (an npm debug log, a uv .lock): the move of a
// folder is one rename, so one open file refuses the whole folder. These are
// the signal to descend and recycle the children individually instead.
const IN_USE_RCS = new Set([5 /* ERROR_ACCESS_DENIED */, 32 /* SHARING_VIOLATION */, 120 /* DE_ACCESSDENIEDSRC */]);
const DESCEND_MAX_DEPTH = 4;
const DU_WALK_CAP = 120000;   // bounded remaining-size walk after a partial clear

function createDiskSpace(opts) {
  const o = opts || {};
  const dataDir = o.dataDir;
  const helperExe = o.helperExe;
  const appRoot = o.appRoot || path.join(__dirname, '..');
  const getSettings = typeof o.getSettings === 'function' ? o.getSettings : () => ({});
  const shellDeleteRunner = typeof o.shellDelete === 'function' ? o.shellDelete : null;
  // A cleanup can take minutes (500 items, many of them folders with thousands
  // of files), so it runs as a background JOB, not inside the HTTP response.
  // The client is told progress over SSE (`disk_clean`) and can re-attach to a
  // running job after a reload through status(). `onCleanProgress` broadcasts;
  // absent (tests) it is a no-op.
  const onCleanProgress = typeof o.onCleanProgress === 'function' ? o.onCleanProgress : () => {};
  // The Living Index (living-index.js). When it is on, the widget needs no
  // scan at all: sizes/top/dupes/categories come from the always-current
  // in-RAM index, per root, on demand.
  const livingIndex = o.livingIndex || null;
  // The index roots as the user configured them (searchSettings.indexRoots) —
  // the ONLY roots /disk/overview will resolve. The wire carries an INDEX into
  // this list, never a path (the Slideshow shape).
  const getIndexRoots = typeof o.getIndexRoots === 'function' ? o.getIndexRoots : async () => [];
  // Display-only volume metadata comes from server.js' existing, cached
  // Get-Volume probe. It never participates in root resolution or cleanup.
  const getDriveDetails = typeof o.getDriveDetails === 'function' ? o.getDriveDetails : async () => ({});
  const summaryFile = path.join(dataDir, SUMMARY_FILE);

  const userProfile = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');
  const windir = process.env.WINDIR || 'C:\\Windows';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  // Only the user's own %TEMP%. C:\Windows\Temp is deliberately absent: the
  // guard protects %WINDIR% outright, so classifying it produced a Clean button
  // that always came back `protected:windir` (same reason the winUpdate
  // category was retired — see disk-categories.js). The filter keeps that true
  // even if %TEMP% itself ever resolves under Windows.
  const tempDirs = [os.tmpdir()].filter((d) => {
    const dl = String(d || '').toLowerCase();
    const wl = windir.toLowerCase().replace(/\\+$/, '');
    return dl !== wl && !dl.startsWith(wl + '\\');
  });
  const downloads = path.join(userProfile, 'Downloads');
  // Defaults; a relocated Documents (OneDrive) is additionally covered by
  // protecting the OneDrive root itself when the env names one.
  const known = (n) => path.join(userProfile, n);

  function guardCtx(root) {
    return DiskGuard.buildGuardCtx({
      windir, programFiles, programFilesX86,
      documents: known('Documents'), pictures: known('Pictures'), desktop: known('Desktop'),
      music: known('Music'), videos: known('Videos'),
      dataDir, appRoot, userProfile, root,
    });
  }
  // ── container directories: the contents are disposable, the folder is not ──
  // %TEMP% is the case that matters. Windows and every running app resolve that
  // path from the environment, so recycling the FOLDER would be a real breakage
  // — and it never even got that far: one file held open by any running app
  // makes SHFileOperation refuse the whole folder, so the category reported the
  // same 9.42 GB after every attempt with nothing moved. A container is
  // therefore never an item; its children are, so a locked child refuses on its
  // own and everything else is freed.
  const containerDirs = new Set(tempDirs.map((d) => String(d).toLowerCase().replace(/[\\/]+$/, '')));
  function isContainerDir(p) {
    return containerDirs.has(String(p || '').toLowerCase().replace(/[\\/]+$/, ''));
  }

  // Live existence/reparse probe, shared by the selection check and the
  // descend path: lstat sees symlinks, but an NTFS junction needs the realpath
  // comparison (a junction must never become a delete of its target).
  async function probeFlags(p) {
    let flags = { exists: false, isReparse: false, isDir: false, size: 0 };
    try {
      const st = await fs.promises.lstat(p);
      flags = { exists: true, isReparse: st.isSymbolicLink(), isDir: st.isDirectory(), size: st.size };
      if (!flags.isReparse && st.isDirectory()) {
        const real = await fs.promises.realpath(p).catch(() => p);
        if (real.toLowerCase() !== p.toLowerCase()) flags.isReparse = true;
      }
    } catch { /* stays exists:false */ }
    return flags;
  }

  // Bounded "what is left" walk for a partially-cleared folder: after the
  // children were recycled around a locked file, the leftover is typically a
  // few KB — walking it is cheap and makes the freed-bytes number honest.
  async function remainingBytes(root) {
    let total = 0, seen = 0;
    async function walk(dir) {
      if (seen >= DU_WALK_CAP) return;
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (seen++ >= DU_WALK_CAP) return;
        const p = path.join(dir, e.name);
        try {
          if (e.isSymbolicLink()) continue;
          if (e.isDirectory()) await walk(p);
          else if (e.isFile()) total += (await fs.promises.lstat(p)).size;
        } catch { /* vanished mid-walk */ }
      }
    }
    await walk(root);
    return seen >= DU_WALK_CAP ? null : total;   // null = too big to answer honestly
  }

  // OneDrive is guarded as an extra protected prefix via a tiny wrapper.
  const oneDrive = process.env.OneDrive || '';
  function guardDelete(abs, gctx, flags) {
    // Belt and braces: a stale cached enumeration must not be able to address
    // the container itself even if it once held it as an item.
    if (isContainerDir(abs)) return { ok: false, reason: 'container_root' };
    if (oneDrive) {
      const p = String(abs || '').toLowerCase().replace(/\//g, '\\');
      const od = oneDrive.toLowerCase().replace(/\//g, '\\').replace(/\\+$/, '');
      if (p === od || p.startsWith(od + '\\')) return { ok: false, reason: 'protected:oneDrive' };
    }
    return DiskGuard.guardDelete(abs, gctx, flags);
  }

  async function catCtx() {
    const s = (await Promise.resolve(getSettings()).catch(() => ({}))) || {};
    return {
      tempDirs, localAppData, userProfile, windir,
      devFolders: Array.isArray(s.devFolders) ? s.devFolders.filter((d) => typeof d === 'string') : [],
      downloads,
      installerAgeDays: Number.isFinite(s.installerAgeDays) ? s.installerAgeDays : 30,
      now: Date.now(),
    };
  }

  function helperPresent() {
    try { return !!helperExe && fs.existsSync(helperExe); } catch { return false; }
  }

  // ── scan state ───────────────────────────────────────────────────────────
  const scan = {
    proc: null, running: false, root: '', startedAt: 0,
    progress: { dirs: 0, files: 0, bytes: 0 },
    dirs: [],            // [{p,s,n,m,d}] every reported dir (server-side full list)
    detailFiles: [],     // [{p,n,s,m}] files under the detail roots
    topFiles: [],
    dupeCandidates: [],  // [{s, paths:[]}] same-size candidates from the helper
    dupes: [],           // verified groups [{s, paths:[], wasted}]
    categories: {},      // cat -> { bytes, count, items: [{i,p,s,m,kind}] }
    error: null, doneAt: 0, cancelled: false, timer: null,
    buf: '',
  };
  let lastSummary = null;      // persisted lite summary for at-rest rendering
  let summaryLoaded = false;

  // ── clean-job state ──────────────────────────────────────────────────────
  // A single cleanup at a time (a second request while one runs is refused
  // with `busy`), tracked here so status() can re-expose it to a reloaded page
  // and _gracefulShutdown can cancel it. `jobSeq` gives each run an id so a
  // late progress event from a previous run can't paint over a new one.
  let jobSeq = 0;
  const cleanJob = {
    id: 0, running: false, cat: '', root: null,
    total: 0, totalBytes: 0,          // what this run set out to remove
    processed: 0, deleted: 0, freed: 0, refusedCount: 0,
    phase: 'idle',                    // idle | processing | refreshing | done
    permanent: false, cancelled: false,
    startedAt: 0, doneAt: 0,
    report: null,                     // final machine-readable outcome
  };
  const liveDeleteProcs = new Set();  // shell-delete children in flight (no job object)

  function cleanSnapshot() {
    if (cleanJob.phase === 'idle') return null;
    return {
      id: cleanJob.id, running: cleanJob.running, cat: cleanJob.cat, root: cleanJob.root,
      total: cleanJob.total, totalBytes: cleanJob.totalBytes,
      processed: cleanJob.processed, deleted: cleanJob.deleted,
      freedBytes: cleanJob.freed, refusedCount: cleanJob.refusedCount,
      phase: cleanJob.phase, permanent: cleanJob.permanent, cancelled: cleanJob.cancelled,
      startedAt: cleanJob.startedAt, doneAt: cleanJob.doneAt,
      report: cleanJob.report,
    };
  }
  function emitClean() { try { onCleanProgress(cleanSnapshot()); } catch { /* never break a delete */ } }

  async function loadSummary() {
    if (summaryLoaded) return;
    summaryLoaded = true;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(summaryFile, 'utf8'));
      if (parsed && parsed.v === 1) lastSummary = parsed;
    } catch { /* none yet */ }
  }

  // ── which drive letters exist ────────────────────────────────────────────
  // Never synchronously: this runs on the /disk/status request path, which the
  // widget polls while the index builds, and a single existsSync on a
  // mapped-but-disconnected network drive or an empty optical drive blocks the
  // event loop for seconds — taking SSE, sensors and media down with it. Async,
  // in parallel, cached, and stale-while-revalidate so a slow letter never
  // holds a response open twice.
  const DRIVES_TTL_MS = 30000;
  const drivesCache = { at: 0, list: [], pending: null };
  function refreshDrives() {
    if (drivesCache.pending) return drivesCache.pending;
    const letters = [];
    for (let c = 65; c <= 90; c++) letters.push(String.fromCharCode(c));
    drivesCache.pending = Promise.all(letters.map(async (letter) => {
      try { await fs.promises.access(letter + ':\\'); return letter; } catch { return null; }
    })).then((found) => {
      drivesCache.list = found.filter(Boolean);
      drivesCache.at = Date.now();
      return drivesCache.list;
    }).catch(() => drivesCache.list).finally(() => { drivesCache.pending = null; });
    return drivesCache.pending;
  }
  function listDrives() {
    if (!drivesCache.at) return refreshDrives();          // first call waits
    if (Date.now() - drivesCache.at >= DRIVES_TTL_MS) refreshDrives();  // in background
    return Promise.resolve(drivesCache.list);
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
      const lower = d.p.toLowerCase();
      if (classifiedDirs.some((a) => lower.startsWith(a + '\\'))) continue;
      classifiedDirs.push(lower);
      add(r.cat, d.p, d.s, d.m, 'dir');
    }
    for (const f of scan.detailFiles) {
      const lower = f.p.toLowerCase();
      if (classifiedDirs.some((a) => lower.startsWith(a + '\\'))) continue;
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
    lastSummary = {
      v: 1, at: Date.now(), root: scan.root,
      bytes: scan.progress.bytes, files: scan.progress.files, dirs: scan.progress.dirs,
      byCategory,
      dupesWasted: scan.dupes.reduce((a, g) => a + g.wasted, 0),
    };
    try { await writeFileAtomic(summaryFile, JSON.stringify(lastSummary)); } catch {}
  }

  function startScan(rootRaw) {
    if (!helperPresent()) return { ok: false, error: 'helper_missing' };
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
    const detailRoots = [downloads, ...tempDirs].filter((d) => d.toLowerCase().startsWith(root.toLowerCase()));
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

  // ── status (what the widget renders) ─────────────────────────────────────
  async function status() {
    await loadSummary();
    const out = {
      ok: true,
      helper: helperPresent(),
      running: scan.running,
      progress: scan.progress,
      last: lastSummary,
    };
    // Living-Index state + the configured roots (by index — the wire contract)
    // + which drive letters exist, so the widget can offer them as one-tap
    // additions.
    out.index = livingIndex ? await livingIndex.stats() : { on: false };
    const details = (await getDriveDetails().catch(() => ({}))) || {};
    const metadata = (drive) => {
      const raw = details[String(drive || '').toUpperCase()] || {};
      return {
        drive: String(drive || '').slice(0, 2).toUpperCase(),
        label: String(raw.label || '').trim().slice(0, 80),
        model: String(raw.model || '').trim().slice(0, 120),
        fileSystem: String(raw.fileSystem || '').trim().slice(0, 24),
        driveType: String(raw.driveType || '').trim().slice(0, 40),
      };
    };
    out.roots = ((await getIndexRoots().catch(() => [])) || []).map((p, i) => {
      const rootPath = String(p || '');
      const match = /^([A-Za-z]:)/.exec(rootPath);
      return { i, path: rootPath, ...metadata(match ? match[1] : '') };
    });
    const drives = await listDrives();
    out.driveDetails = drives.map((letter) => ({ letter, ...metadata(letter + ':') }));
    out.drives = drives;
    // A running (or just-finished) cleanup so a reloaded page re-attaches to it
    // instead of showing a spinner that resolves against nothing.
    out.clean = cleanSnapshot();
    if (!scan.running && scan.doneAt) {
      const dirsBySize = [...scan.dirs].sort((a, b) => b.s - a.s).slice(0, CLIENT_DIRS_MAX);
      out.result = {
        root: scan.root,
        cancelled: scan.cancelled,
        error: scan.error,
        bytes: scan.progress.bytes, files: scan.progress.files, dirs: scan.progress.dirs,
        tree: dirsBySize,
        topFiles: scan.topFiles.slice(0, CLIENT_FILES_MAX),
        dupes: scan.dupes.map((g) => ({ s: g.s, wasted: g.wasted, paths: g.paths })),
        categories: Object.fromEntries(Object.entries(scan.categories).map(([cat, c]) => [cat, {
          bytes: c.bytes, count: c.count,
          items: c.items.slice(0, 500).map((it) => ({ i: it.i, p: it.p, s: it.s, m: it.m, kind: it.kind })),
        }])),
      };
    }
    return out;
  }

  // ── clean (category + ids → guard → helper recycle delete) ───────────────
  // Two enumeration sources, one contract: with `body.root` (an index into the
  // configured roots) the ids resolve against that root's cached overview
  // (the Living-Index path); without it, against the legacy scan. Either way
  // no path ever comes from the wire and the guard re-checks everything.
  //
  // Runs as a background JOB: this returns as soon as the work is accepted, and
  // the actual deletion streams progress over SSE and lands in cleanJob.report.
  // Emptying the Recycle Bin is fast and stays synchronous.
  async function clean(body) {
    if (!helperPresent()) return { ok: false, error: 'helper_missing' };
    if (cleanJob.running) return { ok: false, error: 'busy' };
    const cat = String((body && body.category) || '');

    // Emptying the Recycle Bin is its own explicit, permanent action. It is a
    // real per-file deletion, so a large Bin takes minutes — it runs as the
    // same background job (permanent:true), not inside the HTTP response.
    if (cat === 'recycleBin') {
      const id = ++jobSeq;
      const binKey = (body && body.root != null) ? String(await resolveRoot(body.root) || '').toLowerCase() : null;
      cleanJob.id = id;
      cleanJob.running = true;
      cleanJob.cat = cat;
      cleanJob.root = (body && body.root != null) ? body.root : null;
      cleanJob.total = 0;
      cleanJob.totalBytes = 0;
      cleanJob.processed = 0;
      cleanJob.deleted = 0;
      cleanJob.freed = 0;
      cleanJob.refusedCount = 0;
      cleanJob.phase = 'processing';
      cleanJob.permanent = true;
      cleanJob.cancelled = false;
      cleanJob.startedAt = Date.now();
      cleanJob.doneAt = 0;
      cleanJob.report = null;
      emitClean();
      (async () => {
        let report;
        try {
          const res = await runShellDelete({ emptyRecycleBin: true });
          report = res.ok ? { ok: true, emptied: true } : { ok: false, error: 'empty_failed' };
        } catch { report = { ok: false, error: 'empty_failed' }; }
        if (cleanJob.id === id) {
          if (report.ok && binKey) overviews.delete(binKey);
          cleanJob.report = report;
          cleanJob.running = false;
          cleanJob.phase = 'done';
          cleanJob.doneAt = Date.now();
          emitClean();
        }
      })();
      return { ok: true, started: true, id };
    }

    let c, sourceRoot, overviewKey = null;
    if (body && body.root != null) {
      const rootPath = await resolveRoot(body.root);
      if (!rootPath) return { ok: false, error: 'bad_root' };
      overviewKey = rootPath.toLowerCase();
      const ov = overviews.get(overviewKey);
      if (!ov) return { ok: false, error: 'no_overview' };
      // A snapshot taken while the index was still walking the drive has
      // partial sizes and partial item lists — deleting against it acts on
      // wrong data (empirically: uv\cache listed at 291 MB of its real
      // 1.96 GB mid-build). Refuse; the widget re-offers when the map is real.
      if (ov.index && ov.index.building === true) return { ok: false, error: 'index_building' };
      c = ov.categories[cat];
      sourceRoot = rootPath;
    } else {
      if (scan.running) return { ok: false, error: 'scan_running' };
      c = scan.categories[cat];
      sourceRoot = scan.root;
    }
    if (!c) return { ok: false, error: 'unknown_category' };
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, CATEGORY_ITEMS_MAX) : [];
    if (!ids.length) return { ok: false, error: 'no_items' };

    // Resolve + guard the whole selection up front, so the job's `total` is the
    // number we will actually attempt (a refused-by-guard item never counts as
    // work to do). Resolve by stable id, never array position.
    const gctx = guardCtx(sourceRoot);
    const approved = [];
    const refused = [];
    const byId = new Map(c.items.map((it) => [it.i, it]));
    for (const rawId of ids) {
      const idx = Number(rawId);
      const item = Number.isInteger(idx) && idx >= 0 ? byId.get(idx) : null;
      if (!item) { refused.push({ id: rawId, reason: 'unknown_id' }); continue; }
      const flags = await probeFlags(item.p);
      const verdict = guardDelete(item.p, gctx, flags);
      if (verdict.ok) approved.push(item);
      else refused.push({ path: item.p, reason: verdict.reason });
    }
    if (!approved.length) return { ok: false, error: 'nothing_approved', refused };

    // Accept the job. Everything past here runs in the background; the HTTP
    // caller gets { ok, started, id } immediately.
    const id = ++jobSeq;
    cleanJob.id = id;
    cleanJob.running = true;
    cleanJob.cat = cat;
    cleanJob.root = (body && body.root != null) ? body.root : null;
    cleanJob.total = approved.length;
    cleanJob.totalBytes = approved.reduce((sum, it) => sum + (it.s || 0), 0);
    cleanJob.processed = 0;
    cleanJob.deleted = 0;
    cleanJob.freed = 0;
    cleanJob.refusedCount = refused.length;
    cleanJob.phase = 'processing';
    cleanJob.permanent = false;
    cleanJob.cancelled = false;
    cleanJob.startedAt = Date.now();
    cleanJob.doneAt = 0;
    cleanJob.report = null;
    emitClean();

    runCleanJob({ id, approved, refused, c, overviewKey, gctx })
      .catch(() => { /* runCleanJob settles cleanJob itself */ });
    return { ok: true, started: true, id };
  }

  // The actual deletion loop, off the request path. Streams progress and always
  // settles cleanJob (running:false, a report) exactly once.
  async function runCleanJob({ id, approved, refused, c, overviewKey, gctx }) {
    // One locked cache file must not make a large cleanup look like a total
    // failure after Windows already recycled everything else. Small batches
    // isolate failures; a failed batch is split until the stubborn path is
    // identified. The live filesystem remains the final source of truth.
    const attempted = new Set();
    const shellFailed = [];
    // Top-level items we had to open up because something inside was in use.
    const descended = new Set();

    // Recycling a folder is ONE rename, so one file held open by a running
    // program (an npm debug log, uv's .lock) refuses the entire folder — the
    // empirically-proven "2 GB cache never moves" case. When Windows answers
    // with an in-use code for a single directory, open it up and recycle its
    // children individually: everything movable moves, and only the locked
    // subtree stays behind. Every child is re-checked against the guard —
    // descending must never reach further than the approved item could.
    async function descendInto(dirPath, depth) {
      if (cleanJob.cancelled || depth > DESCEND_MAX_DEPTH) return;
      let entries;
      try { entries = await fs.promises.readdir(dirPath, { withFileTypes: true }); } catch { return; }
      const files = [];
      const dirs = [];
      for (const e of entries) {
        const p = path.join(dirPath, e.name);
        const flags = await probeFlags(p);
        if (!flags.exists) continue;
        if (guardDelete(p, gctx, flags).ok !== true) continue;   // silently keep what the guard protects
        if (flags.isDir) dirs.push(p); else files.push(p);
      }
      // Files in one call; on refusal isolate per file like the main loop.
      for (let i = 0; i < files.length && !cleanJob.cancelled; i += DELETE_BATCH_MAX) {
        const batch = files.slice(i, i + DELETE_BATCH_MAX);
        const res = await runShellDelete({ paths: batch });
        if (!res.ok || res.aborted === true) {
          for (const p of batch) {
            const r1 = await runShellDelete({ paths: [p] });
            if (!r1.ok || r1.aborted === true) {
              shellFailed.push({ path: p, reason: (IN_USE_RCS.has(r1.rc) || r1.aborted === true) ? 'in_use' : 'shell_refused' });
            }
          }
        }
      }
      // Directories one by one; any refusal recurses a level deeper until the
      // depth bound, so the locked leaf is isolated as precisely as possible.
      for (const p of dirs) {
        if (cleanJob.cancelled) return;
        const res = await runShellDelete({ paths: [p] });
        if (res.ok && res.aborted !== true) continue;
        if (depth < DESCEND_MAX_DEPTH) await descendInto(p, depth + 1);
        else {
          const inUse = IN_USE_RCS.has(res.rc) || res.aborted === true;
          shellFailed.push({ path: p, reason: inUse ? 'in_use' : 'shell_refused' });
        }
      }
    }

    async function deleteBatch(items) {
      if (cleanJob.cancelled) return;
      const pending = [];
      for (const it of items) {
        // Re-probe AND re-guard LIVE at the batch boundary — not just for
        // existence. The up-front guard in clean() ran moments ago; between
        // then and now the path could have been swapped to a junction/symlink,
        // and recycling a reparse point must never become a delete of its
        // target. Mirrors descendInto's per-child check so a top-level item is
        // held to the same live test as a descended one. A vanished item counts
        // as attempted (verified gone below); a now-refused one is reported, not
        // deleted.
        const flags = await probeFlags(it.p);
        if (!flags.exists) { attempted.add(it); continue; }
        if (guardDelete(it.p, gctx, flags).ok !== true) {
          shellFailed.push({ path: it.p, reason: 'guard_refused' });
          continue;
        }
        pending.push(it);
      }
      if (!pending.length) return;
      const res = await runShellDelete({ paths: pending.map((it) => it.p) });
      pending.forEach((it) => attempted.add(it));
      if (res.ok) return;
      if (pending.length === 1) {
        const it = pending[0];
        // A refused DIRECTORY is always opened up, whatever the code: the
        // shell answers in-use (5/32/120), rc 0 + aborted (FOF_NOERRORUI turns
        // the error dialog into a silent cancel), or 124 DE_INVALIDFILES for a
        // tree holding hardlinks whose target is loaded by a running process
        // (uv's archive cache, empirically). Descending isolates the exact
        // locked leaf and moves everything else; the guard re-checks every
        // child, so this never reaches further than the approved item could.
        if (it.kind === 'dir') {
          descended.add(it);
          await descendInto(it.p, 0);
        } else {
          const inUse = IN_USE_RCS.has(res.rc) || res.aborted === true;
          shellFailed.push({ path: it.p, reason: inUse ? 'in_use' : 'shell_refused' });
        }
        return;
      }
      const mid = Math.ceil(pending.length / 2);
      await deleteBatch(pending.slice(0, mid));
      await deleteBatch(pending.slice(mid));
    }

    try {
      for (let i = 0; i < approved.length; i += DELETE_BATCH_MAX) {
        if (cleanJob.cancelled) break;
        const batch = approved.slice(i, i + DELETE_BATCH_MAX);
        await deleteBatch(batch);
        // Progress is measured on what has been ATTEMPTED (moved or proven
        // stubborn), not on batch index, so a re-split batch still counts once.
        cleanJob.processed = Math.min(attempted.size, approved.length);
        emitClean();
      }

      // Verify what is actually gone and report partial success honestly. A
      // descended container that still exists is measured: what it lost is
      // freed space, what it kept is reported as in use.
      let deleted = 0, freed = 0;
      const gone = new Set();
      const remaining = [];
      for (const it of attempted) {
        try { await fs.promises.lstat(it.p); }
        catch { deleted++; freed += it.s; gone.add(it); }
        if (gone.has(it)) continue;
        if (descended.has(it)) {
          const left = await remainingBytes(it.p);
          const clearedHere = left == null ? 0 : Math.max(0, (it.s || 0) - left);
          if (clearedHere > 0) {
            freed += clearedHere;
            remaining.push({ path: it.p, reason: 'partly_in_use', freedBytes: clearedHere });
            continue;
          }
        }
        remaining.push({ path: it.p, reason: 'still_present' });
      }
      // Order matters for the per-path dedup below (the Map keeps the LAST
      // entry): specific reasons (in_use, partly_in_use, shell_refused) must
      // win over the generic still_present, so `remaining` goes first.
      const allRefused = [...refused, ...remaining, ...shellFailed];
      // A cancelled run reports the not-yet-attempted items as such, so the
      // count the user sees adds up to the whole selection.
      if (cleanJob.cancelled) {
        for (const it of approved) {
          if (!attempted.has(it)) allRefused.push({ path: it.p, reason: 'cancelled' });
        }
      }
      const uniqueRefused = [...new Map(allRefused.map((entry) => {
        const key = entry.path ? 'path:' + String(entry.path).toLowerCase() : 'id:' + String(entry.id);
        return [key, entry];
      })).values()];

      cleanJob.deleted = deleted;
      cleanJob.freed = freed;
      cleanJob.refusedCount = uniqueRefused.length;

      // Success = bytes actually left the drive, whether items vanished whole
      // or a container was cleared around a locked file (deleted 0, freed 2 GB
      // is a SUCCESS the old `if (deleted)` gate reported as total failure).
      if (freed > 0) {
        // Drop the deleted items so a second click can't re-address them, and
        // subtract only what this run verified as gone (bytes/count describe
        // the whole category, the in-memory item list is capped).
        c.items = c.items.filter((it) => !gone.has(it));
        c.bytes = Math.max(0, c.bytes - freed);
        c.count = Math.max(0, c.count - deleted);
        if (overviewKey) overviews.delete(overviewKey);
        else await persistSummary();
      }

      cleanJob.report = freed > 0
        ? {
            ok: true, deleted, attempted: attempted.size, freedBytes: freed,
            toRecycleBin: true, partial: uniqueRefused.length > 0,
            cancelled: cleanJob.cancelled, refused: uniqueRefused,
          }
        : {
            ok: false, error: cleanJob.cancelled ? 'cancelled' : 'delete_failed',
            deleted: 0, freedBytes: 0, cancelled: cleanJob.cancelled, refused: uniqueRefused,
          };
    } catch (e) {
      cleanJob.report = { ok: false, error: 'clean_failed', deleted: cleanJob.deleted, freedBytes: cleanJob.freed };
    } finally {
      // A stale progress event from a superseded run must never revive this.
      if (cleanJob.id === id) {
        cleanJob.running = false;
        cleanJob.phase = 'done';
        cleanJob.doneAt = Date.now();
        emitClean();
      }
    }
  }

  function cancelClean() {
    if (!cleanJob.running) return { ok: true, idle: true };
    cleanJob.cancelled = true;
    // The current shell-delete batch is allowed to finish (killing it mid-move
    // could orphan a half-done operation); the loop stops before the next one.
    emitClean();
    return { ok: true };
  }

  function runShellDelete(payload) {
    if (shellDeleteRunner) {
      return Promise.resolve().then(() => shellDeleteRunner(payload)).catch(() => ({ ok: false }));
    }
    return new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(helperExe, ['shell-delete'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      } catch { resolve({ ok: false }); return; }
      // Tracked so _gracefulShutdown can wait a beat and then kill: a
      // shell-delete child has no job object, so process.exit would orphan it
      // (the bug that kept moving files after the server was killed).
      liveDeleteProcs.add(proc);
      let out = '';
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; liveDeleteProcs.delete(proc); resolve(r); } };
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (ch) => { out += ch; });
      const timer = setTimeout(() => { try { proc.kill(); } catch {} done({ ok: false }); }, SHELL_DELETE_TIMEOUT_MS);
      proc.on('exit', () => {
        clearTimeout(timer);
        try { done(JSON.parse(out.trim() || '{}')); } catch { done({ ok: false }); }
      });
      proc.on('error', () => { clearTimeout(timer); done({ ok: false }); });
      try {
        proc.stdin.write(JSON.stringify(payload) + '\n');
        proc.stdin.end();
      } catch { /* exit handler resolves */ }
    });
  }

  // ── Living-Index overviews (the no-scan path) ────────────────────────────
  // One overview per configured root, computed on demand from the live index
  // and cached briefly (the index is current by construction; the cache only
  // bounds classification work). Item ids for /disk/clean are indices into the
  // cached category lists — the same opaque-id contract as the scan path.
  const OVERVIEW_TTL_MS = 30 * 1000;
  const overviews = new Map();   // rootLower -> { at, root, total, files, tree, topFiles, dupes, categories }
  const overviewBuilds = new Map(); // rootLower -> Promise (dedupe UI + AI requests)

  // Drill-down ids live only with one cached overview. The browser may display
  // paths, but it can navigate only by an opaque id minted here; a path never
  // travels client→server and cannot escape the configured root.
  function browseIds(ov) {
    if (ov._browseIds) return ov._browseIds;
    const state = { next: 0, byId: new Map(), byPath: new Map() };
    Object.defineProperty(ov, '_browseIds', { value: state, enumerable: false });
    return state;
  }

  function registerBrowsePath(ov, rawPath) {
    const value = String(rawPath || '').replace(/[\\/]+$/, '');
    const root = String(ov.root || '').replace(/[\\/]+$/, '');
    const lower = value.toLowerCase();
    const rootLower = root.toLowerCase();
    if (!value || (lower !== rootLower && !lower.startsWith(rootLower + '\\'))) return '';
    const state = browseIds(ov);
    const known = state.byPath.get(lower);
    if (known) return known;
    const id = 'n' + (state.next++).toString(36);
    state.byPath.set(lower, id);
    state.byId.set(id, value);
    return id;
  }

  async function resolveRoot(rawIndex) {
    const roots = (await getIndexRoots().catch(() => [])) || [];
    const i = Number(rawIndex);
    if (!Number.isInteger(i) || i < 0 || i >= roots.length) return null;
    return roots[i];
  }

  async function buildOverview(root) {
    const rl = root.toLowerCase().replace(/\\+$/, '');
    const detailRoots = [downloads, ...tempDirs].filter((dr) => {
      const drl = dr.toLowerCase();
      return drl === rl || drl.startsWith(rl + '\\');
    });

    let sz, bigDirs, topFiles, dupeGroups, detailFiles, indexMeta;
    const combined = typeof livingIndex.overview === 'function'
      ? await livingIndex.overview(root, {
        dirMinBytes: 10 * 1024 * 1024,
        dirMax: 4000,
        topMax: CLIENT_FILES_MAX,
        dupeMinBytes: 10 * 1024 * 1024,
        dupeMax: DUPE_GROUPS_MAX,
        detailRoots,
        detailMax: 5000,
      })
      : null;
    if (combined) {
      sz = { total: combined.total, files: combined.files };
      bigDirs = combined.dirs || [];
      topFiles = combined.topFiles || [];
      dupeGroups = combined.groups || [];
      detailFiles = combined.detailFiles || [];
      indexMeta = {
        building: combined.building === true,
        capped: combined.capped === true,
        detailCapped: combined.detailCapped === true,
      };
    } else {
      // Compatibility with a helper that predates the combined overview
      // protocol. The helper updater replaces it on the next restart.
      [sz, bigDirs, topFiles, dupeGroups] = await Promise.all([
        livingIndex.sizes(root),
        livingIndex.dirs(root, 10 * 1024 * 1024, 4000),
        livingIndex.top(root, CLIENT_FILES_MAX),
        livingIndex.dupes(root, 10 * 1024 * 1024, DUPE_GROUPS_MAX),
      ]);
      detailFiles = [];
      for (const dr of detailRoots) {
        const files = await livingIndex.list(dr, 5000);
        if (files) detailFiles.push(...files);
      }
      indexMeta = { building: false, capped: false, detailCapped: false };
    }
    if (!sz) return null;

    // Categories: classify the big dirs (caches/build dirs are dirs)…
    const ctx = await catCtx();
    const cats = {};
    const add = (cat, p, s, m, kind) => {
      const c = cats[cat] || (cats[cat] = { bytes: 0, count: 0, items: [] });
      c.bytes += s; c.count++;
      c.items.push({ p, s, m, kind });
    };
    const classifiedDirs = [];
    for (const d of byPathAsc(bigDirs)) {
      const r = DiskCategories.classify({ path: d.p, name: path.basename(d.p), isDir: true, size: d.s, mtime: d.m }, ctx);
      if (!r) continue;
      if (isContainerDir(d.p)) continue;   // its children are the items
      const lower = d.p.toLowerCase();
      if (classifiedDirs.some((a) => lower.startsWith(a + '\\'))) continue;
      classifiedDirs.push(lower);
      add(r.cat, d.p, d.s, d.m, 'dir');
    }
    // …then per-file detail where files classify individually (installers in
    // Downloads, loose temp files), asked from the index only for the detail
    // roots that live under THIS root.
    for (const f of detailFiles) {
      const lower = f.p.toLowerCase();
      if (classifiedDirs.some((a) => lower.startsWith(a + '\\'))) continue;
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

    // Verified duplicates: same-size candidates from the index, then the same
    // bounded SHA-256 pass the scan path uses (only equal hashes are shown).
    const verifiedDupes = await verifyDupeCandidates(dupeGroups || []);

    let volume = null;
    try {
      const v = await fs.promises.statfs(root);
      const capacity = Number(v.bsize) * Number(v.blocks);
      const free = Number(v.bsize) * Number(v.bavail);
      if (Number.isFinite(capacity) && capacity > 0 && Number.isFinite(free)) {
        volume = { capacity, free: Math.max(0, free), used: Math.max(0, capacity - free) };
      }
    } catch { /* a configured folder can disappear between requests */ }

    return {
      at: Date.now(), root,
      total: sz.total || 0, files: sz.files || 0,
      volume,
      index: indexMeta,
      tree: (bigDirs || []).sort((a, b) => b.s - a.s).slice(0, CLIENT_DIRS_MAX),
      topFiles: topFiles || [],
      dupes: verifiedDupes.map((g) => ({ s: g.s, wasted: g.wasted, paths: g.paths })),
      categories: cats,
    };
  }

  // Overview for the Nth configured root. Wire shape: index in, display data
  // out; the client acts via {root, category, ids} against this cache.
  async function overview(rawIndex, refresh) {
    if (!livingIndex || !livingIndex.available()) return { ok: false, error: 'index_off' };
    const root = await resolveRoot(rawIndex);
    if (!root) return { ok: false, error: 'bad_root' };
    const key = root.toLowerCase();
    const cached = overviews.get(key);
    if (!refresh && cached && Date.now() - cached.at < OVERVIEW_TTL_MS) return toClientOverview(cached);
    let pending = overviewBuilds.get(key);
    if (!pending) {
      pending = buildOverview(root).finally(() => overviewBuilds.delete(key));
      overviewBuilds.set(key, pending);
    }
    const built = await pending;
    if (!built) return { ok: false, error: 'index_unavailable' };
    overviews.set(key, built);
    return toClientOverview(built);
  }

  function toClientOverview(ov) {
    const rootId = registerBrowsePath(ov, ov.root);
    return {
      ok: true,
      root: ov.root, total: ov.total, files: ov.files,
      rootId,
      volume: ov.volume,
      index: ov.index,
      generatedAt: ov.at,
      tree: ov.tree.map((dir) => ({ ...dir, id: registerBrowsePath(ov, dir.p) })),
      topFiles: ov.topFiles, dupes: ov.dupes,
      categories: Object.fromEntries(Object.entries(ov.categories).map(([cat, c]) => [cat, {
        bytes: c.bytes, count: c.count,
        listedCount: Math.min(500, c.items.length),
        listedBytes: c.items.slice(0, 500).reduce((sum, it) => sum + it.s, 0),
        truncated: c.items.length > 500 || c.count > c.items.length,
        items: c.items.slice(0, 500).map((it) => ({ i: it.i, p: it.p, s: it.s, m: it.m, kind: it.kind })),
      }])),
    };
  }

  // One-level live drill-down. `node` is an opaque id from this overview (or a
  // previous browse response), never a client path. New helpers answer in one
  // pass; the cached overview remains a truthful fallback during an update.
  async function browse(rawIndex, rawNode) {
    if (!livingIndex || !livingIndex.available()) return { ok: false, error: 'index_off' };
    const root = await resolveRoot(rawIndex);
    if (!root) return { ok: false, error: 'bad_root' };
    const ov = overviews.get(root.toLowerCase());
    if (!ov) return { ok: false, error: 'no_overview' };
    const node = String(rawNode || '');
    if (!/^n[a-z0-9]+$/.test(node)) return { ok: false, error: 'bad_node' };
    const target = browseIds(ov).byId.get(node);
    if (!target) return { ok: false, error: 'bad_node' };

    let snapshot = typeof livingIndex.browse === 'function'
      ? await livingIndex.browse(target, { childMax: 64, fileMax: 64 })
      : null;
    if (!snapshot) {
      const targetLower = target.toLowerCase().replace(/\\+$/, '');
      const children = ov.tree.filter((dir) => {
        const p = String(dir.p || '').toLowerCase().replace(/\\+$/, '');
        const cut = p.lastIndexOf('\\');
        return cut >= 0 && p.slice(0, cut) === targetLower;
      }).slice(0, 64);
      const directFiles = ov.topFiles.filter((file) => {
        const p = String(file.p || '').toLowerCase();
        return p.slice(0, p.lastIndexOf('\\')) === targetLower;
      }).slice(0, 64);
      const rootEntry = ov.tree.find((dir) =>
        String(dir.p || '').toLowerCase().replace(/\\+$/, '') === targetLower);
      snapshot = {
        path: target,
        total: rootEntry ? rootEntry.s : (targetLower === String(ov.root).toLowerCase().replace(/\\+$/, '') ? ov.total : 0),
        files: rootEntry ? rootEntry.n : 0,
        directBytes: directFiles.reduce((sum, file) => sum + (Number(file.s) || 0), 0),
        children,
        directFiles,
        fallback: true,
      };
    }

    const children = (Array.isArray(snapshot.children) ? snapshot.children : [])
      .filter((dir) => dir && dir.p)
      .slice(0, 64)
      .map((dir) => ({
        id: registerBrowsePath(ov, dir.p),
        p: String(dir.p), s: Number(dir.s) || 0,
        n: Number(dir.n) || 0, m: Number(dir.m) || 0,
      }))
      .filter((dir) => dir.id);
    const directFiles = (Array.isArray(snapshot.directFiles) ? snapshot.directFiles : [])
      .filter((file) => file && file.p)
      .slice(0, 64)
      .map((file) => ({
        p: String(file.p), n: String(file.n || path.basename(file.p)),
        s: Number(file.s) || 0, m: Number(file.m) || 0,
      }));
    const total = Math.max(0, Number(snapshot.total) || 0);
    const represented = children.reduce((sum, dir) => sum + dir.s, 0) +
      directFiles.reduce((sum, file) => sum + file.s, 0);
    return {
      ok: true,
      node,
      path: target,
      total,
      files: Math.max(0, Number(snapshot.files) || 0),
      directBytes: Math.max(0, Number(snapshot.directBytes) || 0),
      otherBytes: Math.max(0, total - represented),
      children,
      directFiles,
      fallback: snapshot.fallback === true,
    };
  }

  // ── AI insight (read-only; the AI can explain, never delete) ─────────────
  async function insights(rawIndex) {
    await loadSummary();
    const s = await status();
    const out = { helper: s.helper, lastScanAt: lastSummary ? lastSummary.at : null };
    // Living-Index path: current stats plus the requested configured root
    // (default first). The AI receives a root INDEX, never an arbitrary path.
    if (s.index && s.index.on && s.index.ready && s.roots && s.roots.length) {
      const requested = Number(rawIndex);
      const rootRec = Number.isInteger(requested)
        ? s.roots.find((r) => r.i === requested)
        : null;
      const selected = rootRec || s.roots[0];
      const ov = await overview(selected.i).catch(() => null);
      if (ov && ov.ok) {
        out.rootIndex = selected.i;
        out.root = ov.root;
        out.drive = {
          drive: selected.drive,
          label: selected.label,
          model: selected.model,
          fileSystem: selected.fileSystem,
          driveType: selected.driveType,
        };
        out.livingIndex = {
          files: s.index.files,
          ramMB: s.index.ramMB,
          capped: s.index.capped === true,
          roots: s.roots.map((r) => ({ index: r.i, path: r.path })),
        };
        out.totalBytes = ov.total;
        out.volume = ov.volume;
        out.categories = Object.fromEntries(Object.entries(ov.categories).map(([k, v]) => [k, { bytes: v.bytes, count: v.count }]));
        out.topFolders = ov.tree.slice(0, 15).map((d) => ({ path: d.p, bytes: d.s }));
        out.topFiles = ov.topFiles.slice(0, 15).map((f) => ({ path: f.p, bytes: f.s, modified: f.m ? new Date(f.m).toISOString() : '' }));
        out.duplicatesWastedBytes = ov.dupes.reduce((a, g) => a + g.wasted, 0);
        out.advice = DiskIntelligence.analyze(ov);
        out.note = 'consistent snapshot from the living index; cleanup re-checks every target against the live filesystem';
        return out;
      }
    }
    if (s.result) {
      out.totalBytes = s.result.bytes;
      out.categories = Object.fromEntries(Object.entries(s.result.categories).map(([k, v]) => [k, { bytes: v.bytes, count: v.count }]));
      out.topFolders = s.result.tree.slice(0, 15).map((d) => ({ path: d.p, bytes: d.s }));
      out.topFiles = s.result.topFiles.slice(0, 15).map((f) => ({ path: f.p, bytes: f.s, modified: f.m ? new Date(f.m).toISOString() : '' }));
      out.duplicatesWastedBytes = s.result.dupes.reduce((a, g) => a + g.wasted, 0);
    } else if (lastSummary) {
      out.totalBytes = lastSummary.bytes;
      out.categories = lastSummary.byCategory;
      out.note = 'summary of the previous scan; run a new scan from the disk widget for details';
    } else {
      out.note = 'no scan has been run yet; the user starts one from the disk widget';
    }
    return out;
  }

  // On shutdown: stop a running scan, cancel the clean loop so it opens no new
  // batches, and give any in-flight shell-delete child a moment to finish its
  // current move before killing it (the moves it already handed to Windows
  // complete; we just stop launching more and don't orphan the child).
  function stop() {
    killScan('shutdown');
    cleanJob.cancelled = true;
    for (const proc of liveDeleteProcs) {
      try { proc.stdin.end(); } catch {}
      const kill = setTimeout(() => { try { proc.kill(); } catch {} }, 1500);
      kill.unref();
      proc.once('exit', () => clearTimeout(kill));
    }
  }

  return {
    startScan, cancelScan, status, overview, browse, clean, cancelClean,
    insights, stop, helperPresent,
  };
}

module.exports = { createDiskSpace };
