'use strict';
// What the Linux file index says about disk space: the overview of a drive by kind of file, and
// the contents of one folder with sizes.

const DiskKinds = require('../disk-kinds.js');

const isUnder = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');

// `aggs` are sizeWalk's measured-only folder rows: they count in the totals and
// the folder map, never as files (no top files, duplicates or detail lists).
function overviewFrom(entries, root, opts = {}, aggs = []) {
  const r = root.length > 1 ? root.replace(/\/+$/, '') : root;
  const dirMinBytes = opts.dirMinBytes || 0;
  const dirMax = opts.dirMax || 4000;
  const topMax = opts.topMax || 200;
  const dupeMinBytes = opts.dupeMinBytes || 0;
  const dupeMax = opts.dupeMax || 100;
  const detailRoots = Array.isArray(opts.detailRoots) ? opts.detailRoots : [];
  const detailMax = opts.detailMax || 5000;
  const staleMinBytes = opts.staleMinBytes || 0;
  const staleBefore = opts.staleBefore || 0;
  const staleMax = opts.staleMax || 100;

  let total = 0, files = 0;
  const kinds = DiskKinds.emptyKinds();
  const staleFiles = [];
  const dirBytes = new Map();   // dir path -> bytes below it
  const dirFiles = new Map();   // dir path -> files below it
  const dirMtime = new Map();   // dir path -> the directory's own mtime
  const fileList = [];
  const bySize = new Map();     // size -> [paths], duplicate candidates
  const detailFiles = [];

  const roll = (start, bytes, count) => {
    // Roll a size into every directory between `start` and the root. A
    // treemap is a nesting of totals, so a file 6 levels down has to count in
    // all 6 — summing only the immediate parent draws a map where the branches
    // are empty and only the leaves have weight.
    let dir = start;
    while (true) {
      dirBytes.set(dir, (dirBytes.get(dir) || 0) + bytes);
      dirFiles.set(dir, (dirFiles.get(dir) || 0) + count);
      if (dir === r || dir === '/' || !isUnder(dir, r)) break;
      const cut = dir.lastIndexOf('/');
      dir = cut <= 0 ? '/' : dir.slice(0, cut);
    }
  };

  for (const a of aggs) {
    if (!isUnder(a.p, r)) continue;
    dirMtime.set(a.p, a.m);
    total += a.s;
    files += a.fc;
    kinds[DiskKinds.kindOf('', a.p)] += a.s;
    roll(a.p, a.s, a.fc);
  }

  for (const e of entries) {
    if (!isUnder(e.p, r)) continue;
    if (e.d) { dirMtime.set(e.p, e.m); continue; }
    total += e.s;
    files++;
    fileList.push(e);
    kinds[DiskKinds.kindOf(e.n, e.p.slice(0, e.p.lastIndexOf('/')))] += e.s;
    if (staleMinBytes && staleBefore && e.s >= staleMinBytes && e.m > 0 && e.m < staleBefore) staleFiles.push(e);
    if (e.s >= dupeMinBytes && e.s > 0) {
      const arr = bySize.get(e.s);
      if (arr) arr.push(e.p); else bySize.set(e.s, [e.p]);
    }
    if (detailFiles.length < detailMax) {
      for (const dr of detailRoots) {
        if (isUnder(e.p, dr)) { detailFiles.push({ p: e.p, n: e.n, s: e.s, m: e.m }); break; }
      }
    }
    let dir = e.p.slice(0, e.p.lastIndexOf('/'));
    if (dir === '') dir = '/';
    roll(dir, e.s, 1);
  }

  const dirs = [];
  for (const [p, s] of dirBytes) {
    if (s < dirMinBytes || p === r) continue;
    dirs.push({ p, s, m: dirMtime.get(p) || 0, n: dirFiles.get(p) || 0 });
  }
  dirs.sort((a, b) => b.s - a.s);

  const topFiles = fileList
    .slice()
    .sort((a, b) => b.s - a.s)
    .slice(0, topMax)
    // `n` is not decoration: diskspace.js reads it directly (path.extname(f.n))
    // to classify a file, and a row without it threw before the map was drawn.
    .map((e) => ({ p: e.p, n: e.n, s: e.s, m: e.m }));

  // Same-size groups only. Proving they are identical means reading them, and
  // that is deliberately diskspace.js's job — it has the hash budget and the
  // rule that an unverified pair is a guess, not a duplicate.
  const groups = [];
  for (const [s, paths] of bySize) {
    if (paths.length < 2) continue;
    groups.push({ s, paths });
  }
  groups.sort((a, b) => b.s * (b.paths.length - 1) - a.s * (a.paths.length - 1));

  return {
    total,
    files,
    dirs: dirs.slice(0, dirMax),
    topFiles,
    groups: groups.slice(0, dupeMax),
    detailFiles,
    kinds,
    ...(staleMinBytes && staleBefore ? {
      staleFiles: staleFiles.sort((a, b) => b.s - a.s).slice(0, staleMax).map((e) => ({ p: e.p, n: e.n, s: e.s, m: e.m })),
    } : {}),
    // Whether the folder LIST was cut — not the index cap, which is what the
    // `capped` field means on every other host and what the widget's "index
    // reached its safety limit" notice reads. overview() supplies that one.
    dirsTruncated: dirs.length > dirMax,
    detailCapped: detailFiles.length >= detailMax,
  };
}

// One level of the disk map for one directory: its direct child folders with
// their totals and its own largest files, the Windows host's `browse` answer.
// Without it diskspace.js fell back to the overview's tree, which lists only
// folders of 10 MB and more and the 200 largest files of the whole drive, so a
// folder made of small files opened to "unattributed" space instead of its
// contents. `aggs` (sizeWalk's measured-only rows) count in a child's total,
// never as a direct file.
function browseFrom(entries, dir, opts = {}, aggs = []) {
  const d = dir.length > 1 ? dir.replace(/\/+$/, '') : dir;
  const prefix = d === '/' ? '/' : d + '/';
  const childMax = Math.max(1, Math.min(128, opts.childMax || 64));
  const fileMax = Math.max(1, Math.min(128, opts.fileMax || 64));
  let total = 0, files = 0, directBytes = 0;
  const kids = new Map();   // child path -> { p, s, n, m }
  const direct = [];
  const childOf = (p) => {
    const rest = p.slice(prefix.length);
    const cut = rest.indexOf('/');
    return cut < 0 ? null : prefix + rest.slice(0, cut);
  };
  const addKid = (p, s, n, m) => {
    const k = kids.get(p) || { p, s: 0, n: 0, m: 0 };
    k.s += s; k.n += n; if (m > k.m) k.m = m;
    kids.set(p, k);
  };
  for (const a of aggs) {
    if (a.p !== d && !a.p.startsWith(prefix)) continue;
    total += a.s; files += a.fc;
    // The row IS a child folder, or sits inside one.
    const rest = a.p.slice(prefix.length);
    const cut = rest.indexOf('/');
    addKid(cut < 0 ? a.p : prefix + rest.slice(0, cut), a.s, a.fc, a.m);
  }
  for (const e of entries) {
    if (e.d || e.x || !e.p.startsWith(prefix)) continue;
    total += e.s;
    files++;
    const child = childOf(e.p);
    if (child) { addKid(child, e.s, 1, e.m); continue; }
    directBytes += e.s;
    direct.push(e);
  }
  const children = [...kids.values()].filter((k) => k.n > 0).sort((a, b) => b.s - a.s).slice(0, childMax);
  const directFiles = direct.sort((a, b) => b.s - a.s).slice(0, fileMax).map((e) => ({ p: e.p, n: e.n, s: e.s, m: e.m }));
  return { path: d, total, files, directBytes, children, directFiles };
}

module.exports = { isUnder, overviewFrom, browseFrom };
