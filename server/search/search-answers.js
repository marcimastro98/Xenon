'use strict';
// Answering a search: a pasted path, the index, the apps and the catalog merged and ranked by
// what was opened before, and the list of what was opened lately.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const SearchQuery = require('../search-query.js');
const SearchRank = require('../search-rank.js');
const { pastedPath } = require('../search-pasted-path.js');
const { FOLDERS_MAX, POOL_MAX, QUERY_MAX, PASTED_STAT_MS } = require('./search-limits.js');

function makeAnswers({
  o, PLATFORM, livingIndex, appsProvider, warm, loadUsage, registerResult, registerApp,
  startCatalog, catalogItems, isPathRec, appKey,
}) {
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

  // Search. Returns { ok, chips, terms, results, wds, index } — `wds` is 'ok' /
  // 'unavailable' / 'error'; `index` is 'ready' / 'building' / 'off' so the UI
  // can say "sto imparando il disco" while the initial walk runs.
  async function search(rawQuery, options) {
    const opt = options || {};
    const now = Number.isFinite(opt.now) ? opt.now : Date.now();
    const pasted = await pastedTarget(rawQuery);
    if (pasted && pasted.hit) {
      return { ok: true, chips: [], terms: [], wds: 'ok', index: 'ready', apps: [], pasted: true, results: [publicResult(pasted.hit, [])] };
    }
    const q = SearchQuery.parseQuery(queryText(rawQuery, pasted), { now, disable: opt.disable });
    return execQuery(q, opt, now);
  }

  // A pasted path: the item itself when it exists. When it does not (moved,
  // renamed folder, a path from another PC) the search goes on with its last
  // part, the file's name, which is how a moved file is still found.
  async function pastedTarget(rawQuery) {
    const abs = pastedPath(rawQuery, { platform: PLATFORM, home: o.home || os.homedir() });
    if (!abs) return null;
    const P = PLATFORM === 'win32' ? path.win32 : path.posix;
    let st = null;
    try { st = await withTimeout(fs.promises.stat(abs).catch(() => null), PASTED_STAT_MS); } catch { st = null; }
    if (!st) return { name: P.basename(abs) };
    const folder = st.isDirectory();
    return {
      name: P.basename(abs),
      hit: { path: abs, name: P.basename(abs), dir: P.dirname(abs), size: folder ? 0 : st.size, mtime: st.mtimeMs, folder },
    };
  }

  function queryText(rawQuery, pasted) {
    return pasted ? pasted.name : String(rawQuery == null ? '' : rawQuery).slice(0, QUERY_MAX);
  }

  function withTimeout(promise, ms) {
    if (!Number.isFinite(ms)) return promise;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), Math.max(0, ms));
      promise.then((v) => { clearTimeout(timer); resolve(v); });
    });
  }

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
    // the user is after FILES). Matching quality gates at word/prefix level:
    // a bare substring must not surface half the app list.
    const appsPromise = (plain && typeof appsProvider === 'function')
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
    const pasted = await pastedTarget(rawQuery);
    if (pasted && pasted.hit) return { ok: true, results: [], wds: 'ok' };   // search() already answered with it
    const q = SearchQuery.parseQuery(queryText(rawQuery, pasted), { now, disable: opt.disable });
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

  return { search, catalog, recent };
}

module.exports = { makeAnswers };
