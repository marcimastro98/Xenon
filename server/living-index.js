'use strict';

// ── The Living Index: server-side lifecycle ─────────────────────────────────
// Manages the helper's `index-serve` host — the one in-memory, watcher-fed
// index of every file under the configured roots that powers BOTH the local
// search (instant name matches over everything, including what Windows Search
// never indexed) and the disk widget (treemap/top/dupes with no scan button).
//
// Measured on this repo: 26k files indexed in ~0.5s, 15 MB RAM, queries in
// 15-50ms, watcher picks up create/delete within ~1s.
//
// Lifecycle mirrors the media host: spawn when wanted, graceful retire (stdin
// close), fast-fail backoff, stopped in _gracefulShutdown. Roots changes
// restart the host (the index rebuilds — cheap enough to be the simple,
// correct answer). Without the helper exe everything answers null and the
// callers keep their fallbacks.

const { spawn } = require('child_process');
const fs = require('fs');

const RETRY_MS = 15 * 1000;
const REQ_TIMEOUT_MS = 30000;
const OVERVIEW_TIMEOUT_MS = 120000; // one consistent pass over as many as 2M entries

function createLivingIndex(opts) {
  const o = opts || {};
  const helperExe = o.helperExe;

  const host = {
    proc: null, buf: '', nextId: 1, pending: new Map(), diedAt: 0,
    roots: [],            // roots the RUNNING host was spawned with
    ready: false,
    progress: { files: 0 },
  };
  let wantedRoots = [];
  let testRunner = null;  // test seam: replaces the whole round-trip

  function helperPresent() {
    try { return !!helperExe && fs.existsSync(helperExe); } catch { return false; }
  }

  function rejectPending(id, err) {
    const p = host.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    host.pending.delete(id);
    p.reject(err);
  }

  function retire(reason) {
    const proc = host.proc;
    host.proc = null;
    host.buf = '';
    host.ready = false;
    if (reason !== 'restart' && reason !== 'shutdown') host.diedAt = Date.now();
    for (const id of [...host.pending.keys()]) rejectPending(id, new Error(reason || 'index host down'));
    if (!proc) return;
    try { proc.stdin.end(); } catch {}
    const force = setTimeout(() => { try { proc.kill(); } catch {} }, 3000);
    force.unref();
    proc.once('exit', () => clearTimeout(force));
  }

  function ensure() {
    if (host.proc) return host.proc;
    if (!wantedRoots.length || !helperPresent()) return null;
    if (Date.now() - host.diedAt < RETRY_MS) return null;
    let proc;
    try {
      proc = spawn(helperExe, ['index-serve', ...wantedRoots], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { return null; }
    host.proc = proc;
    host.roots = wantedRoots.slice();
    host.ready = false;
    host.progress = { files: 0 };
    host.buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      host.buf += chunk;
      let nl;
      while ((nl = host.buf.indexOf('\n')) !== -1) {
        const line = host.buf.slice(0, nl).trim();
        host.buf = host.buf.slice(nl + 1);
        if (!line.startsWith('XEIDX ')) continue;
        let env;
        try { env = JSON.parse(Buffer.from(line.slice(6), 'base64').toString('utf8')); }
        catch { continue; }
        if (env.event === 'ready') { host.ready = true; continue; }
        if (env.event === 'progress') { host.progress = { files: env.files || 0, root: env.root }; continue; }
        const p = host.pending.get(env.id);
        if (!p) continue;
        clearTimeout(p.timer);
        host.pending.delete(env.id);
        if (env.ok) p.resolve(env);
        else p.reject(new Error(env.err || 'index host error'));
      }
    });
    proc.on('error', () => { if (host.proc === proc) retire('index host spawn error'); });
    proc.on('exit', () => { if (host.proc === proc) retire('index host exited'); });
    proc.unref();
    return proc;
  }

  function request(op, extra, timeout) {
    if (testRunner) return testRunner(op, extra);
    return new Promise((resolve, reject) => {
      const proc = ensure();
      if (!proc) { reject(new Error('index_unavailable')); return; }
      const id = host.nextId++;
      const timer = setTimeout(() => {
        rejectPending(id, new Error('index host timeout'));
      }, timeout || REQ_TIMEOUT_MS);
      host.pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin.write(JSON.stringify({ id, op, ...extra }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        host.pending.delete(id);
        reject(e);
      }
    });
  }

  // ── public API — every call answers null when the index is off, so callers
  // fall back instead of failing ─────────────────────────────────────────────

  function available() { return !!(wantedRoots.length && helperPresent()); }

  async function query(q) {
    if (!available()) return null;
    try {
      const out = await request('query', {
        terms: q.terms || [], exts: q.exts || null,
        after: q.after, before: q.before, minBytes: q.minBytes, maxBytes: q.maxBytes,
        max: q.max || 60,
      }, 10000);
      return { items: out.items || [], building: out.building === true };
    } catch { return null; }
  }

  async function sizes(path) {
    if (!available()) return null;
    try { return await request('sizes', { path }); } catch { return null; }
  }
  async function overview(path, opts) {
    if (!available()) return null;
    const cfg = opts || {};
    try {
      return await request('overview', {
        path,
        dirMinBytes: cfg.dirMinBytes,
        dirMax: cfg.dirMax,
        topMax: cfg.topMax,
        dupeMinBytes: cfg.dupeMinBytes,
        dupeMax: cfg.dupeMax,
        detailRoots: cfg.detailRoots,
        detailMax: cfg.detailMax,
      }, OVERVIEW_TIMEOUT_MS);
    } catch { return null; }
  }
  async function browse(path, opts) {
    if (!available()) return null;
    const cfg = opts || {};
    try {
      return await request('browse', {
        path,
        childMax: cfg.childMax || 64,
        fileMax: cfg.fileMax || 64,
      }, OVERVIEW_TIMEOUT_MS);
    } catch { return null; }
  }
  async function dirs(path, minBytes, max) {
    if (!available()) return null;
    try { const out = await request('dirs', { path, minBytes, max }); return out.items || null; } catch { return null; }
  }
  async function list(path, max) {
    if (!available()) return null;
    try { const out = await request('list', { path, max }); return out.items || null; } catch { return null; }
  }
  async function top(path, max) {
    if (!available()) return null;
    try { const out = await request('top', { path, max }); return out.items || null; } catch { return null; }
  }
  async function dupes(path, minBytes, max) {
    if (!available()) return null;
    try { const out = await request('dupes', { path, minBytes, max }); return out.groups || null; } catch { return null; }
  }

  async function stats() {
    if (!available()) return { on: false, helper: helperPresent(), roots: wantedRoots };
    try {
      const s = await request('stats', {}, 5000);
      return {
        on: true, helper: true,
        ready: s.ready === true, building: s.building === true,
        files: s.files || 0, dirs: s.dirs || 0, bytes: s.bytes || 0,
        ramMB: s.ramMB || 0, roots: host.roots.slice(),
        capped: s.capped === true,
        progress: host.progress,
      };
    } catch {
      return { on: true, helper: helperPresent(), ready: false, building: true, starting: true, roots: wantedRoots, progress: host.progress };
    }
  }

  // Roots come from settings (searchSettings.indexRoots). A change restarts
  // the host — rebuilding is cheap and the simple path is the correct one.
  function setRoots(roots) {
    const next = (Array.isArray(roots) ? roots : [])
      .map((r) => String(r || '').trim())
      .filter((r) => /^[A-Za-z]:[\\/]?/.test(r))
      .slice(0, 8);
    const changed = JSON.stringify(next) !== JSON.stringify(wantedRoots);
    wantedRoots = next;
    if (!changed && host.proc) return;
    if (host.proc) retire('restart');
    // Clear the fast-fail backoff ONLY when the roots actually changed (a new
    // configuration deserves a fresh attempt). Clearing it unconditionally made
    // every POST /settings relaunch a host that had just died, so an
    // index-serve that exits immediately — bad root, an older helper that does
    // not know the mode, an OOM on a huge drive — was respawned with no
    // throttle at all.
    if (changed) host.diedAt = 0;
    if (wantedRoots.length) ensure();
  }

  function stop() { retire('shutdown'); }

  return {
    available, query, overview, browse, sizes, dirs, list, top, dupes, stats, setRoots, stop,
    _setTestRunner(fn) { testRunner = typeof fn === 'function' ? fn : null; },
    _running() { return !!host.proc; },
  };
}

module.exports = { createLivingIndex };
