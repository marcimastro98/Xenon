'use strict';
// The overview of one drive built from the living index: sizes, categories, kinds, old files
// and duplicates, reused while it is fresh, with today's point in the drive's history.

const path = require('node:path');
const fs = require('node:fs');
const DiskCategories = require('../disk-categories.js');
const DiskHistory = require('../disk-history.js');
const DiskKinds = require('../disk-kinds.js');
const {
  CLIENT_DIRS_MAX, CLIENT_FILES_MAX, CATEGORY_ITEMS_MAX, DUPE_GROUPS_MAX,
} = require('./limits.js');

function makeOverview({
  onDiskUpdate, livingIndex, cmpKey, trimSep, isBelow, tempDirs, downloads, isContainerDir, catCtx,
  byPathAsc, OVERVIEW_TTL_MS, overviews, overviewBuilds, STALE_MIN_BYTES, STALE_AFTER_DAYS,
  dupeVerifier, saved, resolveRoot, toClientOverview, loadPersisted, schedulePersist, snapshotOf,
}) {
  async function buildOverview(root) {
    // Which of the detail roots sit inside the root being scanned. Off Windows
    // this answered "none" unless a temp dir equalled the root exactly, so the
    // index was asked for no detail files at all and the temp and downloads
    // categories came back empty on every Mac and every Linux box.
    const rl = cmpKey(trimSep(root));
    const detailRoots = [downloads, ...tempDirs].filter((dr) => {
      const drl = cmpKey(trimSep(dr));
      return drl === rl || isBelow(drl, rl);
    });
    const now = Date.now();

    let sz, bigDirs, topFiles, dupeGroups, detailFiles, indexMeta;
    let kinds = null, staleFiles = null, version = null;
    const combined = typeof livingIndex.overview === 'function'
      ? await livingIndex.overview(root, {
        dirMinBytes: 10 * 1024 * 1024,
        dirMax: 4000,
        topMax: CLIENT_FILES_MAX,
        dupeMinBytes: 10 * 1024 * 1024,
        dupeMax: DUPE_GROUPS_MAX,
        detailRoots,
        detailMax: 5000,
        staleMinBytes: STALE_MIN_BYTES,
        staleBefore: now - STALE_AFTER_DAYS * 86400000,
        staleMax: 50,
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
      kinds = cleanKinds(combined.kinds);
      staleFiles = Array.isArray(combined.staleFiles) ? combined.staleFiles : null;
      version = Number.isFinite(combined.version) ? combined.version : null;
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
      const key = cmpKey(d.p);
      if (classifiedDirs.some((a) => isBelow(key, a))) continue;
      classifiedDirs.push(key);
      add(r.cat, d.p, d.s, d.m, 'dir');
    }
    // …then per-file detail where files classify individually (installers in
    // Downloads, loose temp files), asked from the index only for the detail
    // roots that live under THIS root.
    for (const f of detailFiles) {
      const key = cmpKey(f.p);
      if (classifiedDirs.some((a) => isBelow(key, a))) continue;
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

    // Duplicates: what the hash cache already proves, at once. The rest is
    // verified in the background (see scheduleDupes) and pushed when done.
    const quick = await dupeVerifier.cachedOnly(dupeGroups || []);

    let volume = null;
    try {
      const v = await fs.promises.statfs(root);
      const capacity = Number(v.bsize) * Number(v.blocks);
      const free = Number(v.bsize) * Number(v.bavail);
      if (Number.isFinite(capacity) && capacity > 0 && Number.isFinite(free)) {
        volume = { capacity, free: Math.max(0, free), used: Math.max(0, capacity - free) };
      }
    } catch { /* a configured folder can disappear between requests */ }

    const tree = (bigDirs || []).sort((a, b) => b.s - a.s).slice(0, CLIENT_DIRS_MAX);
    // Today's point in the drive's history, and what that history says. Only
    // from a complete index: a half-built one would record a fake drop and
    // then a fake growth when it finishes.
    let insightsOut = null;
    if (volume && !indexMeta.building) {
      await loadPersisted();
      const hk = cmpKey(trimSep(root));
      saved.history = DiskHistory.record(saved.history, hk, { root, capacity: volume.capacity, used: volume.used, tree }, now);
      const pts = saved.history.roots[hk] || [];
      insightsOut = {
        growth: DiskHistory.growth(pts, now, 7),
        forecast: DiskHistory.forecast(pts, now),
        historyDays: pts.length,
      };
    }

    return {
      at: now, version, root,
      total: sz.total || 0, files: sz.files || 0,
      volume,
      index: indexMeta,
      tree,
      topFiles: topFiles || [],
      staleFiles,
      kinds,
      insights: insightsOut,
      dupes: quick.groups.map((g) => ({ s: g.s, wasted: g.wasted, paths: g.paths })),
      dupesPending: quick.pending > 0,
      _dupeCandidates: dupeGroups || [],
      categories: cats,
    };
  }

  // Only the known kinds, as non-negative numbers: this travels to the client.
  function cleanKinds(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const k of DiskKinds.KINDS) {
      const v = Number(raw[k]);
      out[k] = Number.isFinite(v) && v > 0 ? v : 0;
    }
    return out;
  }

  // The background half of the duplicate check, for the overview just cached.
  // When it proves more than the overview shows, the cached overview is
  // updated and the dashboard told (`onDiskUpdate`), which refetches it.
  function scheduleDupes(key, built) {
    if (!built.dupesPending) return;
    void dupeVerifier.verify(built._dupeCandidates).then((out) => {
      if (overviews.get(key) !== built) return;   // superseded meanwhile
      built.dupes = out.groups.map((g) => ({ s: g.s, wasted: g.wasted, paths: g.paths }));
      built.dupesPending = out.pending > 0;
      try { onDiskUpdate({ root: built.root, what: 'dupes' }); } catch { /* best effort */ }
      // A pass bounded by its budget leaves work; the next overview continues it.
    }).catch(() => {});
  }

  async function currentVersion() {
    try {
      const s = await livingIndex.stats();
      return s && Number.isFinite(s.version) ? s.version : null;
    } catch { return null; }
  }

  // Overview for the Nth configured root. Wire shape: index in, display data
  // out; the client acts via {root, category, ids} against this cache.
  async function overview(rawIndex, refresh) {
    if (!livingIndex || !livingIndex.available()) return { ok: false, error: 'index_off' };
    const root = await resolveRoot(rawIndex);
    if (!root) return { ok: false, error: 'bad_root' };
    const key = cmpKey(root);
    const cached = overviews.get(key);
    if (!refresh && cached) {
      if (Date.now() - cached.at < OVERVIEW_TTL_MS) return toClientOverview(cached);
      // Older than the TTL but nothing changed since: still the truth.
      if (cached.version != null && (await currentVersion()) === cached.version) return toClientOverview(cached);
    }
    let pending = overviewBuilds.get(key);
    if (!pending) {
      pending = buildOverview(root).finally(() => overviewBuilds.delete(key));
      overviewBuilds.set(key, pending);
    }
    const built = await pending;
    if (!built) return { ok: false, error: 'index_unavailable' };
    if (overviews.get(key) !== built) {
      overviews.set(key, built);
      scheduleDupes(key, built);
    }
    const client = toClientOverview(built);
    if (!built.index.building) {
      await loadPersisted();
      saved.snapshots.set(key, snapshotOf(client));
      schedulePersist();
    }
    return client;
  }

  return { overview };
}

module.exports = { makeOverview };
