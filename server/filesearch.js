'use strict';

// ── Local file search orchestrator (Spotlight backend) ──────────────────────
// Ties the pieces together: the deterministic parser (search-query.js), the
// Windows Search catalog host (search.ps1 -Serve, ADODB over SystemIndex),
// the Living Index (living-index.js — the helper's in-RAM, watcher-fed index
// of everything under the configured roots), and the ranker (search-rank.js)
// with its persisted open-frequency log.
//
// Security shape (mirrors the Slideshow folder source): a search RESPONSE
// carries paths as display text, but no request ever accepts one. Results get
// an opaque id; /search/open and /search/reveal resolve the id against THIS
// module's bounded cache, then open through the same rules as the Deck's
// openFile (BLOCKED_OPEN_EXT from actions/registry.js + existence check).
// The usage log lives in DATA_DIR, written atomically, never HTTP-served.
//
// Host lifecycle follows the media-host pattern: spawned on the first query,
// retired gracefully (stdin close) after idle or on shutdown, fast-fail
// backoff on death — a machine with the Windows Search service disabled gets
// a recognizable 'wds_unavailable' state the UI explains, not a hang.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const SearchQuery = require('./search-query');
const SearchRank = require('./search-rank');
const { writeFileAtomic } = require('./atomic-write');
const { isBlockedOpenPath } = require('./actions/registry');

const HOST_IDLE_MS = 5 * 60 * 1000;   // retire the PS host after 5 min without queries
const HOST_RETRY_MS = 10 * 1000;      // after a host death, wait before respawning
const REQ_TIMEOUT_MS = 6000;
const RESULTS_CACHE_MAX = 1000;       // resolvable ids (FIFO eviction)
const WDS_MAX = 100;                  // rows asked of the catalog per query
const USAGE_SAVE_DEBOUNCE_MS = 2000;

function createFileSearch(opts) {
  const o = opts || {};
  const dataDir = o.dataDir;
  const scriptPath = o.scriptPath || path.join(__dirname, 'search.ps1');
  const openExternal = o.openExternal; // async (absPath) — deck-actions 'open' verb
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

  function rejectPending(id, err) {
    const p = host.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    host.pending.delete(id);
    p.reject(err);
  }

  function retireHost(reason) {
    const proc = host.proc;
    host.proc = null;
    host.buf = '';
    if (reason !== 'idle') host.diedAt = Date.now();
    if (host.idleTimer) { clearTimeout(host.idleTimer); host.idleTimer = null; }
    for (const id of [...host.pending.keys()]) rejectPending(id, new Error(reason || 'search host down'));
    if (!proc) return;
    // stdin close ends the serve loop → clean exit releases the COM connection.
    try { proc.stdin.end(); } catch {}
    const force = setTimeout(() => { try { proc.kill(); } catch {} }, 3000);
    force.unref();
    proc.once('exit', () => clearTimeout(force));
  }

  function bumpIdle() {
    if (host.idleTimer) clearTimeout(host.idleTimer);
    host.idleTimer = setTimeout(() => retireHost('idle'), HOST_IDLE_MS);
    host.idleTimer.unref();
  }

  function ensureHost() {
    if (host.proc) return host.proc;
    if (Date.now() - host.diedAt < HOST_RETRY_MS) return null;
    let proc;
    try {
      proc = spawn('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Serve'],
        { windowsHide: true });
    } catch { return null; }
    host.proc = proc;
    host.buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      host.buf += chunk;
      let nl;
      while ((nl = host.buf.indexOf('\n')) !== -1) {
        const line = host.buf.slice(0, nl).trim();
        host.buf = host.buf.slice(nl + 1);
        if (!line.startsWith('XESRCH ')) continue;
        let env;
        try { env = JSON.parse(Buffer.from(line.slice(7), 'base64').toString('utf8')); }
        catch { continue; }
        const p = host.pending.get(env.id);
        if (!p) continue;
        clearTimeout(p.timer);
        host.pending.delete(env.id);
        if (env.ok) p.resolve(Array.isArray(env.out) ? env.out : []);
        else p.reject(new Error(env.err || 'search host error'));
      }
    });
    proc.stderr.on('data', () => {});
    proc.on('error', () => { if (host.proc === proc) retireHost('search host spawn error'); });
    proc.on('exit', () => { if (host.proc === proc) retireHost('search host exited'); });
    proc.unref();
    return proc;
  }

  function hostRequest(q) {
    if (hostRunner) return hostRunner(q);
    return new Promise((resolve, reject) => {
      const proc = ensureHost();
      if (!proc) { reject(new Error('wds_unavailable')); return; }
      const id = host.nextId++;
      const timer = setTimeout(() => {
        rejectPending(id, new Error('search host timeout'));
        retireHost('search host timeout');
      }, REQ_TIMEOUT_MS);
      host.pending.set(id, { resolve, reject, timer });
      bumpIdle();
      try {
        proc.stdin.write(JSON.stringify({ id, q }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        host.pending.delete(id);
        reject(e);
      }
    });
  }

  // ── Open-frequency log (ranking signal) ──────────────────────────────────
  let usage = null;          // { opens: {}, folders: {} } — lazy-loaded
  let usageSaveTimer = null;
  let usageDirty = false;

  async function loadUsage() {
    if (usage) return usage;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(usageFile, 'utf8'));
      usage = {
        opens: (parsed && typeof parsed.opens === 'object' && parsed.opens) || {},
        folders: (parsed && typeof parsed.folders === 'object' && parsed.folders) || {},
      };
    } catch { usage = { opens: {}, folders: {} }; }
    return usage;
  }

  function scheduleUsageSave() {
    usageDirty = true;
    if (usageSaveTimer) return;
    usageSaveTimer = setTimeout(() => {
      usageSaveTimer = null;
      if (!usage || !usageDirty) return;
      usageDirty = false;
      writeFileAtomic(usageFile, JSON.stringify(usage)).catch(() => { usageDirty = true; });
    }, USAGE_SAVE_DEBOUNCE_MS);
    usageSaveTimer.unref();
  }

  // ── Living Index (helper index-serve, managed by living-index.js) ────────
  // Instant name matches over EVERYTHING under the configured roots — the
  // primary name source. Answers null when off/unavailable, so search degrades
  // to WDS-only exactly like a helper-less install.
  async function livingMatches(q) {
    if (!livingIndex) return null;
    return livingIndex.query({
      terms: q.terms, exts: SearchQuery.effectiveExts(q),
      after: q.after, before: q.before, minBytes: q.minBytes, maxBytes: q.maxBytes,
      max: 100,
    });
  }

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

  // Search. Returns { ok, chips, terms, results, wds, index } — `wds` is 'ok' /
  // 'unavailable' / 'error'; `index` is 'ready' / 'building' / 'off' so the UI
  // can say "sto imparando il disco" while the initial walk runs.
  async function search(rawQuery, options) {
    const opt = options || {};
    const now = Number.isFinite(opt.now) ? opt.now : Date.now();
    const q = SearchQuery.parseQuery(rawQuery, { now, disable: opt.disable });
    return execQuery(q, opt, now);
  }

  // AI mode: the provider translated the phrase into a structured spec. The
  // spec is UNTRUSTED model output — explicit known-key rebuild at this
  // boundary (anything malformed is dropped, never thrown), then the exact
  // same engine as a typed query. Chips are rebuilt from what SURVIVED, so
  // the UI shows precisely the filter that will run.
  function normalizeStructured(spec) {
    const s = (spec && typeof spec === 'object' && !Array.isArray(spec)) ? spec : {};
    const q = { terms: [], kind: null, exts: null, after: null, before: null, minBytes: null, maxBytes: null, chips: [] };
    for (const term of Array.isArray(s.terms) ? s.terms.slice(0, 8) : []) {
      if (typeof term !== 'string') continue;
      const v = term.trim().slice(0, 80);
      if (v.length >= 2) q.terms.push(v);
    }
    if (typeof s.kind === 'string' && SearchQuery.KIND_EXTS[s.kind]) q.kind = s.kind;
    // "app": the AI understood the user wants an installed APPLICATION (the
    // offline parser never sets this) — forces the Applications tier on even
    // though an exts filter would normally read as a files-only query.
    if (s.app === true) q.wantApps = true;
    if (Array.isArray(s.exts)) {
      const list = [...new Set(s.exts
        .filter((e) => typeof e === 'string')
        .map((e) => e.trim().toLowerCase().replace(/^\./, ''))
        .filter((e) => /^[a-z0-9]{1,6}$/.test(e)))].slice(0, 8);
      if (list.length) q.exts = list;
    }
    // Dates arrive as YYYY-MM-DD (local midnight) or epoch ms; a string
    // `before` means "through that day", so its bound is end-of-day exclusive.
    const toMs = (v) => {
      if (Number.isFinite(v) && v > 0) return v;
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
        const [y, m, d] = v.split('-').map(Number);
        const t = new Date(y, m - 1, d).getTime();
        return Number.isFinite(t) ? t : null;
      }
      return null;
    };
    q.after = toMs(s.after);
    q.before = toMs(s.before);
    if (q.before != null && typeof s.before === 'string') q.before += 86400000;
    const toBytes = (v) => (Number.isFinite(v) && v > 0) ? Math.round(v) : null;
    q.minBytes = toBytes(s.minBytes);
    q.maxBytes = toBytes(s.maxBytes);
    if (q.minBytes != null) q.chips.push({ type: 'size', dir: 'min', bytes: q.minBytes });
    if (q.maxBytes != null) q.chips.push({ type: 'size', dir: 'max', bytes: q.maxBytes });
    if (q.after != null || q.before != null) q.chips.push({ type: 'date', key: 'range', after: q.after, before: q.before });
    if (q.exts) q.chips.push({ type: 'ext', exts: q.exts.slice() });
    if (q.kind) q.chips.push({ type: 'kind', kind: q.kind });
    return q;
  }

  async function searchStructured(spec, options) {
    const opt = options || {};
    const now = Number.isFinite(opt.now) ? opt.now : Date.now();
    return execQuery(normalizeStructured(spec), opt, now);
  }

  // The engine shared by both entries: q is a parsed/normalized query shape.
  async function execQuery(q, opt, now) {
    const hasFilter = q.terms.length || q.exts || q.kind || q.after != null || q.before != null || q.minBytes != null || q.maxBytes != null;
    if (!hasFilter) return { ok: true, chips: q.chips, terms: q.terms, results: [], wds: 'ok', index: 'off' };

    const content = q.terms.length > 0;
    // Applications: only for plain name queries (a kind/date/size filter means
    // the user is after FILES), unless the AI explicitly said the user wants
    // an installed application (q.wantApps). Matching quality gates at
    // word/prefix level — a bare substring must not surface half the app list.
    const wantApps = q.wantApps === true
      ? q.terms.length > 0
      : (content && !q.exts && !q.kind
        && q.after == null && q.before == null && q.minBytes == null && q.maxBytes == null);
    const appsPromise = (wantApps && typeof appsProvider === 'function')
      ? Promise.resolve().then(() => appsProvider()).catch(() => [])
      : Promise.resolve([]);
    const [wdsOut, living, u, appList] = await Promise.all([
      hostRequest({
        terms: q.terms, exts: SearchQuery.effectiveExts(q),
        after: q.after, before: q.before, minBytes: q.minBytes, maxBytes: q.maxBytes,
        content, max: WDS_MAX,
      }).then((items) => ({ items, state: 'ok' }))
        .catch((e) => ({ items: [], state: /wds_unavailable/.test(String(e && e.message)) ? 'unavailable' : 'error' })),
      livingMatches(q),
      loadUsage(),
      appsPromise,
    ]);

    const appHits = (Array.isArray(appList) ? appList : [])
      .map((a) => (a && typeof a.name === 'string' && typeof a.target === 'string')
        ? { a, s: SearchRank.scoreName(a.name, q.terms) } : null)
      .filter((x) => x && x.s >= 0.5)
      .sort((x, y) => y.s - x.s || x.a.name.localeCompare(y.a.name))
      .slice(0, 3)
      .map((x) => ({ id: registerApp(x.a), name: x.a.name }));

    const merged = new Map(); // lower path -> item
    // The Living Index first: its name matches are authoritative and complete
    // (it covers what Windows Search never indexed — proven on this very repo).
    for (const it of (living && living.items) || []) {
      if (!it || typeof it.p !== 'string') continue;
      merged.set(it.p.toLowerCase(), {
        path: it.p, name: it.n || path.basename(it.p), dir: path.dirname(it.p),
        size: it.s || 0, mtime: it.m || 0, contentHit: false,
      });
    }
    for (const it of wdsOut.items) {
      if (!it || typeof it.p !== 'string') continue;
      const k = it.p.toLowerCase();
      if (merged.has(k)) continue;
      merged.set(k, {
        path: it.p, name: it.n || path.basename(it.p), dir: path.dirname(it.p),
        size: it.s || 0, mtime: it.m || 0,
        // The catalog can match on indexed CONTENT: rows whose name misses the
        // terms survive ranking via the content floor only when content search
        // was actually on.
        contentHit: content,
      });
    }

    const ranked = SearchRank.rankResults([...merged.values()], q.terms, u, now);
    const top = ranked.slice(0, Math.max(1, Math.min(60, opt.max || 40)));
    return {
      ok: true,
      chips: q.chips,
      terms: q.terms,
      wds: wdsOut.state,
      index: !living ? 'off' : (living.building ? 'building' : 'ready'),
      apps: appHits,
      results: top.map((it) => ({
        id: registerResult(it),
        name: it.name, path: it.path, dir: it.dir,
        size: it.size, mtime: it.mtime,
        ext: path.extname(it.name).toLowerCase().replace(/^\./, ''),
      })),
    };
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
      return { ok: true };
    }
    if (isBlockedOpenPath(rec.path)) return { ok: false, error: 'blocked_ext', revealable: true };
    try { await fs.promises.stat(rec.path); } catch { return { ok: false, error: 'not_found' }; }
    if (typeof openExternal !== 'function') return { ok: false, error: 'unavailable' };
    try { await openExternal(rec.path); } catch { return { ok: false, error: 'open_failed' }; }
    const u = await loadUsage();
    usage = SearchRank.foldOpen(u, rec.path, rec.dir, Date.now());
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
      // Argv array: "/select,<path>" is a single argument, never a shell string.
      const child = spawn('explorer.exe', ['/select,' + rec.path], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch { return { ok: false, error: 'reveal_failed' }; }
    const u = await loadUsage();
    usage = SearchRank.foldOpen(u, rec.path, rec.dir, Date.now());
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

  // Read-only view of the usage log for the AI full-context mode (strict
  // opt-in in Settings): the folders the user opens results from and the most
  // recent opens, bounded. Names and dirs only — this is exactly the data the
  // user agreed to share with their AI provider, nothing more.
  async function usageSnapshot() {
    const u = await loadUsage();
    const opens = Object.entries(u.opens || {})
      .filter(([, rec]) => rec && Number.isFinite(rec.last))
      .sort((a, b) => b[1].last - a[1].last)
      .slice(0, 20)
      .map(([p, rec]) => ({ name: path.basename(p), dir: path.dirname(p), last: rec.last }));
    const folders = Object.entries(u.folders || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([dir]) => dir);
    return { opens, folders };
  }

  // Stop-what-you-start: retire the PS host and flush a pending usage write.
  // Awaitable so _gracefulShutdown can wait for the flush. (The Living Index
  // host has its own owner — living-index.js — and is stopped there.)
  function stop() {
    retireHost('shutdown');
    if (usageSaveTimer) { clearTimeout(usageSaveTimer); usageSaveTimer = null; }
    if (usage && usageDirty) {
      usageDirty = false;
      return writeFileAtomic(usageFile, JSON.stringify(usage)).catch(() => {});
    }
    return Promise.resolve();
  }

  return {
    search, searchStructured, open, reveal, iconTarget, usageSnapshot, stop,
    _setHostRunner(fn) { hostRunner = typeof fn === 'function' ? fn : null; },
    _resultsCacheSize() { return results.size; },
  };
}

module.exports = { createFileSearch };
