'use strict';
// What the Linux index is asked: a search, how far the walk has come, the overview of a drive
// and the views cut from it, the files of a folder, and the contents of a folder.

const { queryIndex } = require('./linux-index-query.js');
const { overviewFrom, browseFrom } = require('./linux-index-overview.js');

function makeQuestions({ maxEntries, ixState, walkWhenDue, available }) {
  async function query(q) {
    if (!available()) return null;
    ixState.notBefore = 0;   // someone is asking: nothing left to wait for
    if (ixState.startTimer) walkWhenDue();
    try {
      return { ...queryIndex(ixState.entries, q || {}), building: ixState.building };
    } catch { return null; }
  }

  async function stats() {
    if (!ixState.roots.length) return { on: false };
    return {
      on: true,
      // `helper: true` is the honest answer to the question the field asks —
      // "is there a backend behind this?" — even though the backend is this
      // module and not an external binary. The UI uses it to decide whether to
      // offer the index at all.
      helper: true,
      ready: ixState.ready, building: ixState.building, held: ixState.held,
      files: ixState.stats_.files, dirs: ixState.stats_.dirs, bytes: ixState.stats_.bytes, version: ixState.version,
      // Rough: the record plus its two strings, which is what actually grows.
      ramMB: Math.round(((ixState.entries.length + ixState.aggs.length) * 220) / (1024 * 1024)),
      maxEntries,
      roots: ixState.roots.slice(),
      capped: ixState.capped,
      cappedRoots: ixState.cappedRoots.slice(),
      progress: ixState.building ? { files: ixState.stats_.files, dirs: ixState.stats_.dirs } : null,
    };
  }

  // ── Disk map ───────────────────────────────────────────────────────────────
  // All served from the one walk. Each answers null when there is no index, so
  // diskspace.js falls back exactly as it does for an absent helper.
  async function overview(root, opts) {
    if (!available() || !ixState.ready) return null;
    try { return { ...overviewFrom(ixState.entries, String(root || ''), opts || {}, ixState.aggs), capped: ixState.capped, building: ixState.building, version: ixState.version }; } catch { return null; }
  }
  async function sizes(root) {
    const ov = await overview(root, { dirMax: 0, topMax: 0, dupeMax: 0 });
    return ov ? { total: ov.total, files: ov.files } : null;
  }
  async function dirs(root, minBytes, max) {
    const ov = await overview(root, { dirMinBytes: minBytes || 0, dirMax: max || 4000, topMax: 0, dupeMax: 0 });
    return ov ? ov.dirs : null;
  }
  async function top(root, max) {
    const ov = await overview(root, { dirMax: 0, topMax: max || 200, dupeMax: 0 });
    return ov ? ov.topFiles : null;
  }
  async function dupes(root, minBytes, max) {
    const ov = await overview(root, { dirMax: 0, topMax: 0, dupeMinBytes: minBytes || 0, dupeMax: max || 100 });
    return ov ? ov.groups : null;
  }
  // Files directly inside one directory — no descent, which is what makes this
  // different from top(): the caller wants that folder's own contents.
  async function list(dir, max) {
    if (!available() || !ixState.ready) return null;
    const d = String(dir || '').replace(/\/+$/, '') || '/';
    const out = [];
    for (const e of ixState.entries) {
      if (e.d) continue;
      const parent = e.p.slice(0, e.p.lastIndexOf('/')) || '/';
      if (parent !== d) continue;
      out.push({ p: e.p, n: e.n, s: e.s, m: e.m });
      if (out.length >= (max || 5000)) break;
    }
    return out;
  }
  async function browse(dir, opts) {
    if (!available() || !ixState.ready) return null;
    try { return { ...browseFrom(ixState.entries, String(dir || ''), opts || {}, ixState.aggs), version: ixState.version, building: ixState.building }; } catch { return null; }
  }

  return { query, stats, overview, sizes, dirs, top, dupes, list, browse };
}

module.exports = { makeQuestions };
