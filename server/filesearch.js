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
const CATALOG_STASH_MS = 15000;      // a catalog answer is collectable this long
const CATALOG_STASH_MAX = 20;
const FOLDERS_MAX = 8;                // folder results asked of the index
const POOL_MAX = 12;                  // usage-log files re-checked per query

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
    // The catalog host is powershell.exe running search.ps1 against the Windows
    // SystemIndex. Off Windows there is nothing to spawn, and trying produced an
    // ENOENT the caller reported as `error` — indistinguishable from a catalog
    // that broke, which is why the Spotlight popup told a Mac user that
    // "Windows Search is turned off on this PC". `unsupported` is a different
    // fact from `unavailable` and the UI is entitled to say so.
    if (!CATALOG_SUPPORTED) return null;
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
    // A write to a pipe whose child is already gone reports EPIPE/ECONNRESET
    // ASYNCHRONOUSLY, as an 'error' event on the stream — the try/catch around
    // stdin.write() never sees it, and an unhandled 'error' on a stream takes
    // the whole server down. Route it to the same retire path the exit handler
    // uses: the host is dead either way, and every caller already falls back.
    proc.stdin.on('error', () => { if (host.proc === proc) retireHost('search host pipe error'); });
    proc.on('error', () => { if (host.proc === proc) retireHost('search host spawn error'); });
    proc.on('exit', () => { if (host.proc === proc) retireHost('search host exited'); });
    proc.unref();
    return proc;
  }

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
  // to WDS-only exactly like a helper-less install. A plain name query also
  // asks for matching FOLDERS, and a query of two or more words lets a word be
  // found in a folder above the file ("download fattura").
  async function livingMatches(q, plain) {
    if (!livingIndex) return null;
    return livingIndex.query({
      terms: q.terms, exts: SearchQuery.effectiveExts(q),
      after: q.after, before: q.before, minBytes: q.minBytes, maxBytes: q.maxBytes,
      max: 100,
      dirs: plain ? FOLDERS_MAX : 0,
      pathTerms: q.terms.length >= 2,
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

  // ── The catalog half, decoupled from the answer ──────────────────────────
  // Windows Search is the slow source (a powershell host, an ADODB query) and
  // the only one that reads file CONTENT. The answer used to wait for it on
  // every keystroke. Now a query starts it, waits at most `catalogWaitMs`, and
  // answers with what the index had; the catalog's own answer is kept here for
  // a few seconds so the dashboard's follow-up (`catalog()`) collects it
  // instead of asking again.
  const catalogStash = new Map();   // key -> { at, promise }

  function catalogKey(q) {
    return JSON.stringify([q.terms, SearchQuery.effectiveExts(q), q.after, q.before, q.minBytes, q.maxBytes]);
  }

  function startCatalog(q) {
    const key = catalogKey(q);
    const now = Date.now();
    const hit = catalogStash.get(key);
    if (hit && now - hit.at < CATALOG_STASH_MS) return hit.promise;
    const content = q.terms.length > 0;
    const promise = hostRequest({
      terms: q.terms, exts: SearchQuery.effectiveExts(q),
      after: q.after, before: q.before, minBytes: q.minBytes, maxBytes: q.maxBytes,
      content, max: WDS_MAX,
    }).then((items) => ({ items, state: 'ok' }))
      .catch((e) => {
        const msg = String(e && e.message);
        const state = /wds_unsupported/.test(msg) ? 'unsupported'
          : /wds_unavailable/.test(msg) ? 'unavailable'
            : /superseded/.test(msg) ? 'superseded' : 'error';
        return { items: [], state };
      });
    catalogStash.set(key, { at: now, promise });
    for (const [k, v] of catalogStash) {
      if (catalogStash.size <= CATALOG_STASH_MAX && now - v.at < CATALOG_STASH_MS) break;
      catalogStash.delete(k);
    }
    return promise;
  }

  function withTimeout(promise, ms) {
    if (!Number.isFinite(ms)) return promise;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), Math.max(0, ms));
      promise.then((v) => { clearTimeout(timer); resolve(v); });
    });
  }

  function catalogItems(wdsOut, content) {
    const out = [];
    for (const it of (wdsOut && wdsOut.items) || []) {
      if (!it || typeof it.p !== 'string') continue;
      out.push({
        path: it.p, name: it.n || path.basename(it.p), dir: path.dirname(it.p),
        size: it.s || 0, mtime: it.m || 0,
        // The catalog can match on indexed CONTENT: rows whose name misses the
        // terms survive ranking via the content floor only when content search
        // was actually on.
        contentHit: content,
        source: 'catalog',
      });
    }
    return out;
  }

  // A usage record for a FILE or folder: app launches share the log under an
  // "app:" key, and records from before real paths were kept have none.
  const isPathRec = (r) => !!r && typeof r.p === 'string' && path.isAbsolute(r.p);

  // Files the user opened from Xenon before, matched against the query with
  // typo tolerance. The pool is small (the usage log holds 500), which is what
  // makes a fuzzy match affordable here and nowhere else; and a file the user
  // keeps opening must never be cut by a backend's top-100.
  async function usagePool(q, u, have) {
    const recs = Object.values((u && u.opens) || {})
      .filter((r) => isPathRec(r) && !have.has(r.p.toLowerCase()))
      .filter((r) => SearchRank.scoreName(path.basename(r.p), q.terms, { dir: path.dirname(r.p), typos: true }) > 0)
      .sort((a, b) => (b.last || 0) - (a.last || 0))
      .slice(0, POOL_MAX);
    const out = [];
    await Promise.all(recs.map(async (r) => {
      try {
        const st = await fs.promises.stat(r.p);
        out.push({
          path: r.p, name: path.basename(r.p), dir: path.dirname(r.p),
          size: st.isFile() ? st.size : 0, mtime: st.mtimeMs, contentHit: false,
          typos: true, folder: st.isDirectory(),
        });
      } catch { /* gone since it was opened: not a result */ }
    }));
    return out;
  }

  const appKey = (name) => 'app:' + SearchRank.norm(name);

  function scoreApp(a, terms, u, now) {
    let s = SearchRank.scoreName(a.name, terms);
    if (s < 0.5) {
      // A typo in an app name ("spotfy") still finds it; a mere letters-in-
      // order match (0.2) does not.
      const typo = SearchRank.scoreName(a.name, terms, { typos: true });
      s = typo >= 0.25 ? typo : 0;
    }
    if (!s) return 0;
    // Apps launched from here before come first among equals.
    return s * (1 + 0.3 * SearchRank.freqScore(appKey(a.name), u, now));
  }

  // The engine shared by both entries: q is a parsed/normalized query shape.
  //   opt.catalogWaitMs  how long to wait for Windows Search before answering
  //                      without it (the dashboard passes a short one and
  //                      fetches the rest through catalog()); absent = wait
  async function execQuery(q, opt, now) {
    const hasFilter = q.terms.length || q.exts || q.kind || q.after != null || q.before != null || q.minBytes != null || q.maxBytes != null;
    if (!hasFilter) {
      // An empty query is what the dashboard sends when Spotlight opens.
      warm();
      return { ok: true, chips: q.chips, terms: q.terms, results: [], wds: 'ok', index: 'off' };
    }

    const content = q.terms.length > 0;
    const plain = content && !q.exts && !q.kind
      && q.after == null && q.before == null && q.minBytes == null && q.maxBytes == null;
    // Applications: only for plain name queries (a kind/date/size filter means
    // the user is after FILES), unless the AI explicitly said the user wants
    // an installed application (q.wantApps). Matching quality gates at
    // word/prefix level — a bare substring must not surface half the app list.
    const wantApps = q.wantApps === true ? q.terms.length > 0 : plain;
    const appsPromise = (wantApps && typeof appsProvider === 'function')
      ? Promise.resolve().then(() => appsProvider()).catch(() => [])
      : Promise.resolve([]);
    const catalogP = startCatalog(q);
    const [living, u, appList] = await Promise.all([livingMatches(q, plain), loadUsage(), appsPromise]);
    const wdsOut = await withTimeout(catalogP, opt.catalogWaitMs);

    const appHits = (Array.isArray(appList) ? appList : [])
      .map((a) => (a && typeof a.name === 'string' && typeof a.target === 'string')
        ? { a, s: scoreApp(a, q.terms, u, now) } : null)
      .filter((x) => x && x.s > 0)
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
        size: it.s || 0, mtime: it.m || 0, contentHit: false, viaPath: (it.pt || 0) > 0,
      });
    }
    for (const it of (living && living.dirs) || []) {
      if (!it || typeof it.p !== 'string' || merged.has(it.p.toLowerCase())) continue;
      merged.set(it.p.toLowerCase(), {
        path: it.p, name: it.n || path.basename(it.p), dir: path.dirname(it.p),
        size: it.s || 0, mtime: it.m || 0, contentHit: false, folder: true, files: it.f || 0,
      });
    }
    for (const it of catalogItems(wdsOut, content)) {
      const k = it.path.toLowerCase();
      if (!merged.has(k)) merged.set(k, it);
    }
    if (plain) {
      for (const it of await usagePool(q, u, merged)) merged.set(it.path.toLowerCase(), it);
    }

    const ranked = SearchRank.rankResults([...merged.values()], q.terms, u, now);
    const top = ranked.slice(0, Math.max(1, Math.min(60, opt.max || 40)));
    return {
      ok: true,
      chips: q.chips,
      terms: q.terms,
      wds: wdsOut ? wdsOut.state : 'pending',
      index: !living ? 'off' : (living.building ? 'building' : 'ready'),
      apps: appHits,
      results: top.map((it) => publicResult(it, q.terms)),
    };
  }

  // One result as the dashboard sees it. `kind` groups the list (folders
  // apart), `content` marks a row found only inside the file, `viaPath` a row
  // where a word matched a folder above it rather than the name.
  function publicResult(it, terms) {
    const content = !!it.contentHit && SearchRank.scoreName(it.name, terms, { dir: it.dir }) === 0;
    return {
      id: registerResult(it),
      name: it.name, path: it.path, dir: it.dir,
      size: it.size, mtime: it.mtime,
      ext: it.folder ? '' : path.extname(it.name).toLowerCase().replace(/^\./, ''),
      kind: it.folder ? 'folder' : 'file',
      ...(it.folder && it.files ? { files: it.files } : {}),
      ...(content ? { content: true } : {}),
      ...(it.viaPath ? { viaPath: true } : {}),
      ...(it.source === 'catalog' ? { source: 'catalog' } : {}),
    };
  }

  // The rest of a query the dashboard was answered without: what Windows
  // Search found, ranked, for the client to add below what it already shows
  // (it drops the paths it has). Shares the in-flight catalog request.
  async function catalog(rawQuery, options) {
    const opt = options || {};
    const now = Number.isFinite(opt.now) ? opt.now : Date.now();
    const q = SearchQuery.parseQuery(rawQuery, { now, disable: opt.disable });
    const hasFilter = q.terms.length || q.exts || q.kind || q.after != null || q.before != null || q.minBytes != null || q.maxBytes != null;
    if (!hasFilter) return { ok: true, results: [], wds: 'ok' };
    const [wdsOut, u] = await Promise.all([startCatalog(q), loadUsage()]);
    const ranked = SearchRank.rankResults(catalogItems(wdsOut, q.terms.length > 0), q.terms, u, now);
    return {
      ok: true,
      wds: wdsOut.state,
      results: ranked.slice(0, Math.max(1, Math.min(60, opt.max || 40))).map((it) => publicResult(it, q.terms)),
    };
  }

  // What the empty search shows: files and folders recently opened from Xenon,
  // newest first, each checked to still exist. From the usage log only, which
  // lives in DATA_DIR and is never served as is.
  async function recent(options) {
    const opt = options || {};
    const max = Math.max(1, Math.min(12, opt.max || 8));
    const u = await loadUsage();
    const recs = Object.values(u.opens || {})
      .filter((r) => isPathRec(r) && Number.isFinite(r.last))
      .sort((a, b) => b.last - a.last)
      .slice(0, max * 2);
    const files = [];
    for (const r of recs) {
      if (files.length >= max) break;
      try {
        const st = await fs.promises.stat(r.p);
        files.push(publicResult({
          path: r.p, name: path.basename(r.p), dir: path.dirname(r.p),
          size: st.isFile() ? st.size : 0, mtime: st.mtimeMs, folder: st.isDirectory(),
        }, []));
      } catch { /* gone: not offered */ }
    }
    // The folders those files live in, by how often the user opens from them.
    const byDir = new Map();
    for (const r of Object.values(u.opens || {})) {
      if (!isPathRec(r)) continue;
      const d = path.dirname(r.p);
      const e = byDir.get(d.toLowerCase()) || { dir: d, n: 0 };
      e.n += r.n || 1;
      byDir.set(d.toLowerCase(), e);
    }
    const folders = [];
    for (const e of [...byDir.values()].sort((a, b) => b.n - a.n).slice(0, 8)) {
      if (folders.length >= 4) break;
      try {
        if (!(await fs.promises.stat(e.dir)).isDirectory()) continue;
        folders.push(publicResult({ path: e.dir, name: path.basename(e.dir) || e.dir, dir: path.dirname(e.dir), size: 0, mtime: 0, folder: true }, []));
      } catch { /* gone */ }
    }
    return { ok: true, files, folders };
  }

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
      usage = SearchRank.foldOpen(u, appKey(rec.name), '', Date.now());
      scheduleUsageSave();
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
      // The platform switch lives in server.js next to openExternalPath and is
      // injected, because the transfer widget's "show in folder" is the same
      // verb — and two copies of a three-way platform branch drift into one of
      // them quietly not working off Windows.
      if (typeof revealExternal !== 'function') return { ok: false, error: 'unavailable' };
      revealExternal(rec.path, rec.dir || path.dirname(rec.path));
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
    search, searchStructured, catalog, recent, thumbTarget, warm, open, reveal, iconTarget, usageSnapshot, stop,
    _setHostRunner(fn) { hostRunner = typeof fn === 'function' ? fn : null; },
    _resultsCacheSize() { return results.size; },
  };
}

module.exports = { createFileSearch };
