'use strict';
// Looking inside an overview: the ids that stand for its folders and files, the overview as the
// browser gets it, one folder opened, and a file shown in its folder. A path never comes in
// from the browser.

const path = require('node:path');
const fs = require('node:fs');

function makeBrowse({
  revealExternal, livingIndex, getIndexRoots, IS_WIN, SEP, cmpKey, trimSep, isBelow, overviews,
}) {
  // Drill-down and file ids live only with one cached overview. The browser may
  // display paths, but it can navigate or reveal only by an opaque id minted
  // here; a path never travels client→server and cannot escape the root.
  function browseIds(ov) {
    if (ov._browseIds) return ov._browseIds;
    const state = { next: 0, byId: new Map(), byPath: new Map(), nextFile: 0, fileById: new Map(), fileByPath: new Map() };
    Object.defineProperty(ov, '_browseIds', { value: state, enumerable: false });
    return state;
  }

  function insideRoot(ov, rawPath) {
    const value = trimSep(rawPath);
    const key = cmpKey(value);
    const rootKey = cmpKey(trimSep(ov.root));
    return value && (key === rootKey || isBelow(key, rootKey)) ? value : '';
  }

  function registerBrowsePath(ov, rawPath) {
    // `trimSep`, not a bare strip: a POSIX root is "/" and stripping it left
    // the empty string, which failed the guard below and minted no id for the
    // root itself — the drill-down had nothing to start from.
    // This test ADMITS a path into the id space, so it is the strict one: an
    // id minted here is what /disk/browse resolves against, and nothing
    // outside the root may ever get one.
    const value = insideRoot(ov, rawPath);
    if (!value) return '';
    const state = browseIds(ov);
    const key = cmpKey(value);
    const known = state.byPath.get(key);
    if (known) return known;
    const id = 'n' + (state.next++).toString(36);
    state.byPath.set(key, id);
    state.byId.set(id, value);
    return id;
  }

  // The file twin: an id the widget can hand back to "show in folder". Same
  // admission rule as a folder id.
  function registerFilePath(ov, rawPath) {
    const value = insideRoot(ov, rawPath);
    if (!value) return '';
    const state = browseIds(ov);
    const key = cmpKey(value);
    const known = state.fileByPath.get(key);
    if (known) return known;
    const id = 'f' + (state.nextFile++).toString(36);
    state.fileByPath.set(key, id);
    state.fileById.set(id, value);
    return id;
  }

  async function resolveRoot(rawIndex) {
    const roots = (await getIndexRoots().catch(() => [])) || [];
    const i = Number(rawIndex);
    if (!Number.isInteger(i) || i < 0 || i >= roots.length) return null;
    return roots[i];
  }

  function toClientOverview(ov) {
    const rootId = registerBrowsePath(ov, ov.root);
    const withId = (f) => ({ ...f, id: registerFilePath(ov, f.p) });
    return {
      ok: true,
      root: ov.root, total: ov.total, files: ov.files,
      rootId,
      volume: ov.volume,
      index: ov.index,
      generatedAt: ov.at,
      kinds: ov.kinds || null,
      insights: ov.insights || null,
      tree: ov.tree.map((dir) => ({ ...dir, id: registerBrowsePath(ov, dir.p) })),
      topFiles: ov.topFiles.map(withId),
      staleFiles: ov.staleFiles ? ov.staleFiles.map(withId) : null,
      dupes: ov.dupes.map((g) => ({ s: g.s, wasted: g.wasted, paths: g.paths.map((p) => ({ p, id: registerFilePath(ov, p) })) })),
      dupesPending: ov.dupesPending === true,
      categories: Object.fromEntries(Object.entries(ov.categories).map(([cat, c]) => [cat, {
        bytes: c.bytes, count: c.count,
        listedCount: Math.min(500, c.items.length),
        listedBytes: c.items.slice(0, 500).reduce((sum, it) => sum + it.s, 0),
        truncated: c.items.length > 500 || c.count > c.items.length,
        items: c.items.slice(0, 500).map((it) => ({ i: it.i, p: it.p, s: it.s, m: it.m, kind: it.kind })),
      }])),
    };
  }

  // "Show in folder" for a file or folder the widget is displaying, by the
  // opaque id this overview minted. Re-stat'ed first; reveals, never opens:
  // showing where something is runs nothing, so no extension gate is needed
  // (the same reasoning as /search/reveal).
  async function reveal(rawIndex, rawId) {
    const root = await resolveRoot(rawIndex);
    if (!root) return { ok: false, error: 'bad_root' };
    const ov = overviews.get(cmpKey(root));
    if (!ov) return { ok: false, error: 'no_overview' };
    const id = String(rawId || '');
    const ids = browseIds(ov);
    let target = '';
    if (/^f[a-z0-9]+$/.test(id)) target = ids.fileById.get(id) || '';
    else if (/^n[a-z0-9]+$/.test(id)) target = ids.byId.get(id) || '';
    if (!target) return { ok: false, error: 'bad_id' };
    try { await fs.promises.stat(target); } catch { return { ok: false, error: 'not_found' }; }
    if (typeof revealExternal !== 'function') return { ok: false, error: 'unavailable' };
    try {
      // A folder is shown selected inside its parent, the same way a file is.
      revealExternal(target, path.dirname(target));
    } catch { return { ok: false, error: 'reveal_failed' }; }
    return { ok: true };
  }

  // One-level live drill-down. `node` is an opaque id from this overview (or a
  // previous browse response), never a client path. New helpers answer in one
  // pass; the cached overview remains a truthful fallback during an update.
  async function browse(rawIndex, rawNode) {
    if (!livingIndex || !livingIndex.available()) return { ok: false, error: 'index_off' };
    const root = await resolveRoot(rawIndex);
    if (!root) return { ok: false, error: 'bad_root' };
    const ov = overviews.get(cmpKey(root));
    if (!ov) return { ok: false, error: 'no_overview' };
    const node = String(rawNode || '');
    if (!/^n[a-z0-9]+$/.test(node)) return { ok: false, error: 'bad_node' };
    const target = browseIds(ov).byId.get(node);
    if (!target) return { ok: false, error: 'bad_node' };

    let snapshot = typeof livingIndex.browse === 'function'
      ? await livingIndex.browse(target, { childMax: 64, fileMax: 64 })
      : null;
    if (!snapshot) {
      const targetKey = cmpKey(trimSep(target));
      // The parent of "/x" is "/", not "" — slicing at the separator index
      // loses a POSIX root that the Windows shape ("C:\x" → "C:") never hits.
      const parentKey = (p) => {
        const cut = p.lastIndexOf(SEP);
        if (cut < 0) return '';
        return cut === 0 && !IS_WIN ? '/' : p.slice(0, cut);
      };
      const children = ov.tree.filter((dir) => {
        const p = cmpKey(trimSep(dir.p));
        return p.includes(SEP) && parentKey(p) === targetKey;
      }).slice(0, 64);
      const directFiles = ov.topFiles.filter((file) =>
        parentKey(cmpKey(file.p)) === targetKey).slice(0, 64);
      const rootEntry = ov.tree.find((dir) => cmpKey(trimSep(dir.p)) === targetKey);
      snapshot = {
        path: target,
        total: rootEntry ? rootEntry.s : (targetKey === cmpKey(trimSep(ov.root)) ? ov.total : 0),
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
        id: registerFilePath(ov, String(file.p)),
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

  return { resolveRoot, toClientOverview, reveal, browse };
}

module.exports = { makeBrowse };
