'use strict';
// What the living index is asked: a search, the sizes of folders, the overview and the contents
// of a drive, the folders, the biggest files, the duplicates, and how far the index has come.

const { OVERVIEW_TIMEOUT_MS } = require('./living-index-limits.js');

function makeQuestions({ host, indexState, helperPresent, startNow, request, available }) {
  async function query(q) {
    if (!available()) return null;
    startNow();   // someone is asking: nothing left to wait for
    try {
      const out = await request('query', {
        terms: q.terms || [], exts: q.exts || null,
        after: q.after, before: q.before, minBytes: q.minBytes, maxBytes: q.maxBytes,
        max: q.max || 60,
        // Folders whose name matches, and words found in a folder above the
        // file. An older helper ignores both and answers files only.
        dirs: q.dirs || 0,
        pathTerms: q.pathTerms === true,
      }, 10000);
      return { items: out.items || [], dirs: Array.isArray(out.dirs) ? out.dirs : [], building: out.building === true };
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
        staleMinBytes: cfg.staleMinBytes,
        staleBefore: cfg.staleBefore,
        staleMax: cfg.staleMax,
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
    if (!available()) return { on: false, helper: helperPresent(), roots: indexState.wantedRoots };
    try {
      const s = await request('stats', {}, 5000);
      return {
        on: true, helper: true,
        ready: s.ready === true, building: s.building === true, held: indexState.held,
        files: s.files || 0, dirs: s.dirs || 0, bytes: s.bytes || 0,
        // Moves on every change the index applies (absent on an older helper).
        // diskspace.js reuses a disk snapshot for as long as it stands still.
        version: Number.isFinite(s.version) ? s.version : null,
        ramMB: s.ramMB || 0, roots: host.roots.slice(),
        // The entry cap this host derived from the machine's RAM, so the UI
        // can warn BEFORE it is hit — "capped" arrives when it is too late.
        maxEntries: Number.isFinite(s.maxEntries) && s.maxEntries > 0 ? Math.floor(s.maxEntries) : 0,
        capped: s.capped === true,
        // The roots the entry cap left incomplete. Validated the same way every
        // other value off the helper wire is: strings only, bounded, and only
        // roots we actually asked for — the UI names these to the user.
        cappedRoots: Array.isArray(s.cappedRoots)
          ? s.cappedRoots.filter((r) => typeof r === 'string' && r).slice(0, 16)
          : [],
        // What the host is doing BEYOND the initial build. Without these, a
        // host stuck re-walking a root reads exactly like an idle one that
        // happens to be using a core, which is how a permanent rebuild loop
        // went unnoticed until it showed up in Task Manager.
        repairing: s.repairing === true,
        repairs: s.repairs || 0,
        pending: s.pending || 0,
        progress: host.progress,
      };
    } catch {
      return startingStats();
    }
  }

  function startingStats() {
    return { on: true, helper: helperPresent(), ready: false, building: true, starting: true, held: indexState.held, roots: indexState.wantedRoots, progress: host.progress };
  }

  return { query, sizes, overview, browse, dirs, list, top, dupes, stats };
}

module.exports = { makeQuestions };
