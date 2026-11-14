'use strict';

// ── Local file search orchestrator (Spotlight backend) ──────────────────────
// Ties the pieces together: the deterministic parser (search-query.js), the
// Windows Search catalog host (search.ps1 -Serve, ADODB over SystemIndex),
// the Living Index (living-index.js — the helper's in-RAM, watcher-fed index
// of everything under the configured roots), and the ranker (search-rank.js)
// with its persisted open-frequency log.
//
// Security shape (mirrors the Slideshow folder source): a search RESPONSE
// carries paths as display text, but no request ever ACTS on one. A path pasted
// as the query is only stat'ed, and comes back as an ordinary result. Results get
// an opaque id; /search/open and /search/reveal resolve the id against THIS
// module's bounded cache, then open through the same rules as the Deck's
// openFile (BLOCKED_OPEN_EXT from actions/registry.js + existence check).
// The usage log lives in DATA_DIR, written atomically, never HTTP-served.
//
// Host lifecycle follows the media-host pattern: spawned on the first query,
// retired gracefully (stdin close) after idle or on shutdown, fast-fail
// backoff on death — a machine with the Windows Search service disabled gets
// a recognizable 'wds_unavailable' state the UI explains, not a hang.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('./search-query');
const SearchRank = require('./search-rank');
const { writeFileAtomic } = require('./atomic-write');
const { isBlockedOpenPath } = require('./actions/registry');

const { REQ_TIMEOUT_MS, RESULTS_CACHE_MAX } = require('./search/search-limits.js');

const { makeHost } = require('./search/search-host.js');

const { makeOpens } = require('./search/search-opens.js');

const { makeCatalog } = require('./search/search-catalog.js');

const { makeAnswers } = require('./search/search-answers.js');

function createFileSearch(opts) {
  const o = opts || {};
  const dataDir = o.dataDir;
  // Overridable so both branches are reachable from a test run on either OS,
  // the way createDiskSpace and createRegistry take their platform.
  const PLATFORM = o.platform || process.platform;
  // Windows Search has no counterpart the other platforms ship: the Living
  // Index IS the search backend there, and saying so is not a degradation to
  // apologise for. (macOS does have Spotlight, and `mdfind` would be the exact
  // twin of this host — that is a feature, not this gate.)
  // macOS brings its own catalog (Spotlight, through mdfind.js), injected as
  // a runner: same query shape, same {p, n, s, m} rows, no PowerShell host.
  const catalogRunner = typeof o.catalogRunner === 'function' ? o.catalogRunner : null;
  const CATALOG_SUPPORTED = PLATFORM === 'win32' || !!catalogRunner;
  const scriptPath = o.scriptPath || path.join(__dirname, 'search.ps1');
  const openExternal = o.openExternal; // async (absPath) — deck-actions 'open' verb
  const revealExternal = o.revealExternal; // (absPath, dir) — the file manager's "show me where"
  const usageFile = path.join(dataDir, 'search-usage.json');
  const livingIndex = o.livingIndex || null; // living-index.js instance (optional)
  // Applications tier (macOS-style): appsProvider returns the server's cached
  // list of installed apps [{ name, kind: 'lnk'|'store', target }] and
  // launchApp starts one. Both injected by server.js — this module never
  // enumerates or spawns anything for apps itself.
  const appsProvider = o.appsProvider || null;
  const launchApp = o.launchApp || null;

  // ── Windows Search host (search.ps1 -Serve) ──────────────────────────────
  const host = { proc: null, buf: '', nextId: 1, pending: new Map(), diedAt: 0, idleTimer: null };
  // Test seam: replaces the whole host round-trip (query → items array).
  let hostRunner = null;

  const {
    rejectPending, retireHost, bumpIdle, ensureHost,
  } = makeHost({ CATALOG_SUPPORTED, scriptPath, host });

  // The host answers one query at a time, so a fast typist used to queue every
  // keystroke's query behind the previous ones: "f", "fa", "fat"… each waited
  // for the one before, and the answer to what was actually typed came last.
  // Latest wins: one request in flight, at most one waiting, and a newer one
  // replaces the waiting one, which is told 'superseded' (its caller has been
  // aborted by the client anyway).
  let waiting = null;   // { q, resolve, reject }
  let inFlight = false;

  function dispatch(job) {
    inFlight = true;
    const proc = ensureHost();
    if (!proc) { inFlight = false; job.reject(new Error('wds_unavailable')); drain(); return; }
    const id = host.nextId++;
    const timer = setTimeout(() => {
      rejectPending(id, new Error('search host timeout'));
      retireHost('search host timeout');
    }, REQ_TIMEOUT_MS);
    const settle = (fn) => (v) => { inFlight = false; fn(v); drain(); };
    host.pending.set(id, { resolve: settle(job.resolve), reject: settle(job.reject), timer });
    bumpIdle();
    try {
      proc.stdin.write(JSON.stringify({ id, q: job.q }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      host.pending.delete(id);
      inFlight = false;
      job.reject(e);
      drain();
    }
  }

  function drain() {
    if (inFlight || !waiting) return;
    const next = waiting;
    waiting = null;
    dispatch(next);
  }

  function hostRequest(q) {
    if (hostRunner) return hostRunner(q);
    if (catalogRunner) return catalogRunner(q);
    if (!CATALOG_SUPPORTED) return Promise.reject(new Error('wds_unsupported'));
    return new Promise((resolve, reject) => {
      const job = { q, resolve, reject };
      if (!inFlight) { dispatch(job); return; }
      if (waiting) waiting.reject(new Error('superseded'));
      waiting = job;
    });
  }

  // Start the catalog host before it is needed (the Spotlight popup opening):
  // the first query otherwise pays powershell.exe's start plus the ADODB
  // connection, and the 5-minute idle retirement brings that back often.
  // The installed-apps list is built the same way (cold, it is a Get-StartApps
  // run: measured 1.8 s on the first search after a restart, 76 ms after).
  function warm() {
    if (CATALOG_SUPPORTED && !hostRunner && !catalogRunner) { try { ensureHost(); bumpIdle(); } catch { /* best effort */ } }
    if (typeof appsProvider === 'function') Promise.resolve().then(() => appsProvider()).catch(() => {});
  }

  const tally = {
    // ── Open-frequency log (ranking signal) ──────────────────────────────────
    usage: null,          // { opens: {}, folders: {} } — lazy-loaded
    usageSaveTimer: null,
    usageDirty: false,
  };

  const { loadUsage, scheduleUsageSave, usageSnapshot } = makeOpens({ usageFile, tally });

  // ── Result-id cache (opaque ids the open/reveal endpoints resolve) ───────
  const results = new Map(); // id -> { path, name, dir }

  function evictOldest() {
    if (results.size <= RESULTS_CACHE_MAX) return;
    // Map iterates in insertion order → FIFO eviction of the oldest ids.
    for (const k of results.keys()) {
      if (results.size <= RESULTS_CACHE_MAX) break;
      results.delete(k);
    }
  }

  function registerResult(item) {
    const id = 'r' + crypto.randomBytes(8).toString('hex');
    results.set(id, { path: item.path, name: item.name, dir: item.dir });
    evictOldest();
    return id;
  }

  // App results share the id space and cache, but resolve to a LAUNCH of a
  // server-enumerated app entry — never to a filesystem open.
  function registerApp(app) {
    const id = 'r' + crypto.randomBytes(8).toString('hex');
    results.set(id, { app: true, name: app.name, kind: app.kind, target: app.target });
    evictOldest();
    return id;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  // ── The catalog half, decoupled from the answer ──────────────────────────
  // Windows Search is the slow source (a powershell host, an ADODB query) and
  // the only one that reads file CONTENT. The answer used to wait for it on
  // every keystroke. Now a query starts it, waits at most `catalogWaitMs`, and
  // answers with what the index had; the catalog's own answer is kept here for
  // a few seconds so the dashboard's follow-up (`catalog()`) collects it
  // instead of asking again.
  const catalogStash = new Map();   // key -> { at, promise }

  const { startCatalog, catalogItems } = makeCatalog({ hostRequest, catalogStash });

  // A usage record for a FILE or folder: app launches share the log under an
  // "app:" key, and records from before real paths were kept have none.
  const isPathRec = (r) => !!r && typeof r.p === 'string' && path.isAbsolute(r.p);

  const appKey = (name) => 'app:' + SearchRank.norm(name);

  const {
    search, catalog, recent,
  } = makeAnswers({ o, PLATFORM, livingIndex, appsProvider, warm, loadUsage, registerResult, registerApp, startCatalog, catalogItems, isPathRec, appKey });

  // The image behind a result id, for the preview: raster types a browser
  // decodes, bounded, re-stat'ed. Same opaque-id contract as open/reveal.
  const THUMB_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);
  const THUMB_MAX = 20 * 1024 * 1024;
  async function thumbTarget(id) {
    const rec = results.get(String(id || ''));
    if (!rec || rec.app || !rec.path) return null;
    const ext = path.extname(rec.path).toLowerCase().replace(/^\./, '');
    if (!THUMB_EXTS.has(ext)) return null;
    try {
      const st = await fs.promises.stat(rec.path);
      if (!st.isFile() || st.size > THUMB_MAX) return null;
      return { path: rec.path, ext, size: st.size };
    } catch { return null; }
  }

  // Open a result with its registered handler — same rules as the Deck's
  // openFile: executable/script extensions refuse (the UI offers "reveal"
  // instead; folders have no extension and open in Explorer normally).
  async function open(id) {
    const rec = results.get(String(id || ''));
    if (!rec) return { ok: false, error: 'unknown_id' };
    if (rec.app) {
      // Launching an app the SERVER enumerated from the Start Menu / Store —
      // the exe/lnk blocklist guards arbitrary FILE results, not these.
      if (typeof launchApp !== 'function') return { ok: false, error: 'unavailable' };
      try { await launchApp(rec); } catch { return { ok: false, error: 'open_failed' }; }
      // Counted like a file open, under its own key: an app launched from here
      // often is the one a short query means.
      const u = await loadUsage();
      tally.usage = SearchRank.foldOpen(u, appKey(rec.name), '', Date.now());
      scheduleUsageSave();
      return { ok: true };
    }
    if (isBlockedOpenPath(rec.path)) return { ok: false, error: 'blocked_ext', revealable: true };
    try { await fs.promises.stat(rec.path); } catch { return { ok: false, error: 'not_found' }; }
    if (typeof openExternal !== 'function') return { ok: false, error: 'unavailable' };
    try { await openExternal(rec.path); } catch { return { ok: false, error: 'open_failed' }; }
    const u = await loadUsage();
    tally.usage = SearchRank.foldOpen(u, rec.path, rec.dir, Date.now());
    scheduleUsageSave();
    return { ok: true };
  }

  // Reveal a result in Explorer (select it in its folder). The one path an
  // exe/lnk result can take — showing where something is executes nothing.
  async function reveal(id) {
    const rec = results.get(String(id || ''));
    if (!rec || rec.app) return { ok: false, error: 'unknown_id' };
    try { await fs.promises.stat(rec.path); } catch { return { ok: false, error: 'not_found' }; }
    try {
      // The platform switch lives in server.js next to openExternalPath and is
      // injected, because the transfer widget's "show in folder" is the same
      // verb — and two copies of a three-way platform branch drift into one of
      // them quietly not working off Windows.
      if (typeof revealExternal !== 'function') return { ok: false, error: 'unavailable' };
      revealExternal(rec.path, rec.dir || path.dirname(rec.path));
    } catch { return { ok: false, error: 'reveal_failed' }; }
    const u = await loadUsage();
    tally.usage = SearchRank.foldOpen(u, rec.path, rec.dir, Date.now());
    scheduleUsageSave();
    return { ok: true };
  }

  // Read-only id → target resolution for the icon endpoint: exe/lnk results
  // show their real embedded logo in the UI. Same opaque-id contract as
  // open/reveal (a path never travels IN), and it leaks nothing the result
  // row didn't already display.
  function iconTarget(id) {
    const rec = results.get(String(id || ''));
    if (!rec) return null;
    if (rec.app) return { app: true, kind: rec.kind, target: rec.target };
    const m = /\.([a-z0-9]{1,6})$/i.exec(rec.path);
    return { path: rec.path, ext: m ? m[1].toLowerCase() : '' };
  }

  // Stop-what-you-start: retire the PS host and flush a pending usage write.
  // Awaitable so _gracefulShutdown can wait for the flush. (The Living Index
  // host has its own owner — living-index.js — and is stopped there.)
  function stop() {
    retireHost('shutdown');
    if (tally.usageSaveTimer) { clearTimeout(tally.usageSaveTimer); tally.usageSaveTimer = null; }
    if (tally.usage && tally.usageDirty) {
      tally.usageDirty = false;
      return writeFileAtomic(usageFile, JSON.stringify(tally.usage)).catch(() => {});
    }
    return Promise.resolve();
  }

  return {
    search, catalog, recent, thumbTarget, warm, open, reveal, iconTarget, usageSnapshot, stop,
    _setHostRunner(fn) { hostRunner = typeof fn === 'function' ? fn : null; },
    _resultsCacheSize() { return results.size; },
  };
}

module.exports = { createFileSearch };
