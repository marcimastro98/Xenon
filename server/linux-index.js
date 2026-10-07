'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// linux-index.js — the file-search backend for Linux.
//
// living-index.js drives the .NET/Swift helper's `index-serve` host, and there
// is no helper on Linux: `helperPresent()` is false forever, so `available()`
// answered false, every query returned null, and search had no backend at all.
// Spotlight then told the user to "add a folder in Settings → Search and disk
// to enable search" — advice that could not work, because adding a folder
// changed nothing. A dead end that reads like the user's mistake.
//
// This is the same job in plain Node: walk the configured roots, hold a compact
// record per entry in memory, answer name queries from it. Deliberately NOT
// `locate`/`plocate` — that needs a package the distro may not ship, a database
// only root refreshes, and it indexes the whole filesystem rather than the
// roots the user chose. A walk we own answers exactly the question that was
// asked.
//
// It implements the surface living-index.js exports, so server.js can swap one
// for the other and nothing downstream knows. The disk-map half (overview,
// sizes, dirs, top, dupes, list, browse) is served from the same walk.
//
// Cost control, in the two places it matters:
//   • The walk never follows symlinks, so a link into a parent cannot make it
//     loop, and never descends the pseudo-filesystems or the caches that make
//     up most of a home directory's inode count and none of its interest.
//   • Entries are capped. Past the cap the walk stops and says so (`capped`),
//     rather than growing until the backend is killed for RAM on a machine
//     whose whole point is to sit in the background.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const DiskKinds = require('./disk-kinds');

// Directory names never worth SEARCHING: caches and build output, which are
// large, numerous, and never what someone types a filename to find. They are
// still MEASURED (see sizeWalk): they are exactly what the disk widget's
// cleanup categories are about, and skipping them outright meant browser
// caches, package caches, build output and the Trash could never appear on
// Linux at all.
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', '.cache', '__pycache__',
  '.venv', 'venv', '.tox', '.gradle', '.m2', '.npm', '.cargo', '.rustup',
  'target', '.next', '.nuxt', '.turbo', 'dist-cache', '.pnpm-store',
  '.local/share/Trash', 'Trash',
]);

// Absolute prefixes that are not really files: kernel and runtime interfaces
// where a walk either loops, blocks, or reports sizes that mean nothing.
const SKIP_PREFIXES = ['/proc', '/sys', '/dev', '/run', '/snap', '/var/lib/docker'];

const DEFAULT_MAX_ENTRIES = 300000;
// A measured-only subtree is recorded as one row per directory down to this
// depth below the skipped folder, deeper folders folding into their ancestor.
// Deep enough for every POSIX category path in disk-categories.js
// (~/.cache/google-chrome/Default/Cache is 3 below .cache), shallow enough that
// a node_modules tree costs a few hundred rows instead of its 100k files.
const AGG_DEPTH = 5;
const DEFAULT_MAX_AGG = 60000;
const DEFAULT_RESCAN_MS = 10 * 60 * 1000;

function isSkippedPath(abs) {
  for (const p of SKIP_PREFIXES) {
    if (abs === p || abs.startsWith(p + '/')) return true;
  }
  return false;
}

// ── Pure query core (exported for tests) ─────────────────────────────────────
// An entry is { p, n, s, m, d } — path, name, size, mtime ms, isDir. `nl` is
// the lowercased name, precomputed because it is compared on every keystroke
// against every entry and recomputing it there is the whole cost of a query.

// What a name is MATCHED on: lowercase with accents stripped. The server
// strips accents from every typed term ("città" → "citta"), so a name kept
// with its accents could never match it.
function foldName(s) {
  return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// 0 exact · 1 prefix · 2 word boundary · 3 substring · -1 miss — the tiers the
// Windows and macOS hosts use, so every platform hands the ranker its BEST
// candidates instead of the first ones the walk met.
function matchTier(nl, t) {
  const idx = nl.indexOf(t);
  if (idx < 0) return -1;
  if (idx === 0) {
    if (nl.length === t.length) return 0;
    if (nl.lastIndexOf('.') === t.length) return 0; // exact up to the extension
    return 1;
  }
  return ' -_.('.includes(nl[idx - 1]) ? 2 : 3;
}

// The worst term's tier, or -1 when the entry does not pass. `before` is
// exclusive (the start of the NEXT day/month), as on the other hosts.
// With `opt.pathTerms`, a term the name lacks may be held by a folder above
// the file ("downloads invoice" → ~/Downloads/invoice.pdf), as on the Windows
// host: tier PATH_TIER, counted in `opt.pt`, and never every term (one must be
// in the name). search-rank.js scores such a term below any name match.
const PATH_TIER = 4;
function entryTier(entry, terms, exts, after, before, minBytes, maxBytes, opt) {
  if (entry.x) return -1;
  if (exts && exts.length) {
    if (entry.d) return -1;
    const ext = path.extname(entry.n).slice(1).toLowerCase();
    if (!exts.includes(ext)) return -1;
  }
  if (typeof minBytes === 'number' && entry.s < minBytes) return -1;
  if (typeof maxBytes === 'number' && entry.s > maxBytes) return -1;
  if (typeof after === 'number' && entry.m < after) return -1;
  if (typeof before === 'number' && entry.m >= before) return -1;
  if (!terms || !terms.length) return 0;
  const nl = entry.nl || foldName(entry.n);
  let tier = 0;
  let pathOnly = 0;
  let dirParts = null;
  for (const t of terms) {
    let k = matchTier(nl, t);
    if (k < 0) {
      if (!opt || !opt.pathTerms) return -1;
      if (!dirParts) dirParts = foldName(entry.p.slice(0, entry.p.lastIndexOf('/'))).split('/');
      if (!dirParts.some((part) => part.includes(t))) return -1;
      pathOnly++;
      k = PATH_TIER;
    }
    if (k > tier) tier = k;
  }
  if (pathOnly && pathOnly >= terms.length) return -1;
  if (opt) opt.pt = pathOnly;
  return tier;
}

function entryMatches(entry, terms, exts, after, before, minBytes, maxBytes) {
  return entryTier(entry, terms, exts, after, before, minBytes, maxBytes) >= 0;
}

const byTierThenNewest = (a, b) => (a.tier - b.tier) || (b.e.m - a.e.m);

// Files, best first; and, when `q.dirs` asks for them on a plain name query,
// the folders whose own name holds every term — returned apart, as the
// Windows host does, so a folder never takes a file's place in the list.
function queryEntries(entries, q) {
  return queryIndex(entries, q).items;
}

function queryIndex(entries, q) {
  const terms = (q.terms || []).map((t) => foldName(t)).filter(Boolean);
  const exts = Array.isArray(q.exts) && q.exts.length
    ? q.exts.map((e) => String(e).toLowerCase().replace(/^\./, ''))
    : null;
  const max = Math.max(1, Math.min(500, q.max || 60));
  const dirMax = Math.max(0, Math.min(50, q.dirs || 0));
  const plain = terms.length && !exts && q.after == null && q.before == null && q.minBytes == null && q.maxBytes == null;
  const opt = { pathTerms: q.pathTerms === true && terms.length >= 2, pt: 0 };
  // Bounded best-of over the WHOLE index, trimmed as it grows: stopping at
  // the first `max` hits handed the ranker whatever the walk met first.
  let best = [];
  let bestDirs = [];
  for (const e of entries) {
    if (e.d) {
      if (!dirMax || !plain || e.x) continue;
      const tier = entryTier(e, terms, null, undefined, undefined, undefined, undefined);
      if (tier < 0) continue;
      bestDirs.push({ tier, e, pt: 0 });
      if (bestDirs.length > dirMax * 4) { bestDirs.sort(byTierThenNewest); bestDirs = bestDirs.slice(0, dirMax); }
      continue;
    }
    opt.pt = 0;
    const tier = entryTier(e, terms, exts, q.after, q.before, q.minBytes, q.maxBytes, opt);
    if (tier < 0) continue;
    best.push({ tier, e, pt: opt.pt });
    if (best.length > max * 4) { best.sort(byTierThenNewest); best = best.slice(0, max); }
  }
  best.sort(byTierThenNewest);
  bestDirs.sort(byTierThenNewest);
  return {
    items: best.slice(0, max).map(({ e, pt }) => (pt ? { p: e.p, n: e.n, s: e.s, m: e.m, pt } : { p: e.p, n: e.n, s: e.s, m: e.m })),
    dirs: bestDirs.slice(0, dirMax).map(({ e }) => ({ p: e.p, n: e.n, s: 0, m: e.m })),
  };
}

// ── Disk map (exported for tests) ────────────────────────────────────────────
// The same walk that answers search already knows every file's size, so the
// disk widget needs no second traversal and no helper — it needs this list
// grouped four ways. diskspace.js asks for all four in one `overview` call and
// does the rest itself (categories, and the SHA-256 verification that turns
// same-size candidates into real duplicates).

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

// ── The index ────────────────────────────────────────────────────────────────

function createLinuxIndex(o = {}) {
  const maxEntries = o.maxEntries || DEFAULT_MAX_ENTRIES;
  const maxAgg = o.maxAgg || DEFAULT_MAX_AGG;
  const rescanMs = o.rescanMs || DEFAULT_RESCAN_MS;

  let roots = [];
  let entries = [];        // the live, queryable set
  let aggs = [];           // measured-only folders (caches, build output): disk map, never search
  let building = false;
  let ready = false;
  let capped = false;
  let cappedRoots = [];    // the roots the cap left incomplete — swapped in with `entries`
  let stats_ = { files: 0, dirs: 0, bytes: 0 };
  let scanToken = 0;       // invalidates a walk whose roots changed under it
  let version = 0;        // bumped each time a finished walk is swapped in
  let scanning = false;    // a walk is in flight — distinct from `building`, which is what a query reports
  let rescanTimer = null;
  let stopped = false;

  // false = this walk did not see the whole root (the entry cap stopped it, or
  // the scan was superseded). The caller records which roots those were, so the
  // UI can name the folder search cannot see rather than only saying that some
  // limit was reached.
  // A SKIP_DIRS subtree, measured but not searchable: one row per directory
  // down to AGG_DEPTH below `top` (deeper folders roll into their ancestor),
  // each carrying the bytes and file count directly inside it. Separate from
  // `entries` and its cap, so a big node_modules can never cost search a file
  // and a query can never surface a cache file. false = superseded.
  async function sizeWalk(top, token, out) {
    const rows = new Map();
    const rowFor = (p, n, m) => {
      let r = rows.get(p);
      if (!r) {
        r = { p, n, nl: foldName(n), s: 0, m, d: true, x: true, fc: 0 };
        rows.set(p, r);
        out.push(r);
      }
      return r;
    };
    let topM = 0;
    try { topM = (await fsp.lstat(top)).mtimeMs; } catch { /* keep 0 */ }
    rowFor(top, path.basename(top), topM);
    const stack = [{ dir: top, owner: top, depth: 0 }];
    while (stack.length) {
      if (token !== scanToken || stopped) return false;
      const { dir, owner, depth } = stack.pop();
      let dirents;
      try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      const row = rows.get(owner);
      for (const de of dirents) {
        if (de.isSymbolicLink()) continue;
        const abs = path.join(dir, de.name);
        if (de.isDirectory()) {
          if (isSkippedPath(abs)) continue;
          let child = owner;
          if (depth + 1 <= AGG_DEPTH && out.length < maxAgg) {
            let m = 0;
            try { m = (await fsp.lstat(abs)).mtimeMs; } catch { /* keep 0 */ }
            rowFor(abs, de.name, m);
            child = abs;
          }
          stack.push({ dir: abs, owner: child, depth: depth + 1 });
          continue;
        }
        let size = 0;
        try { size = (await fsp.lstat(abs)).size; } catch { continue; }
        row.s += size;
        row.fc++;
        stats_.files++;
        stats_.bytes += size;
      }
    }
    return true;
  }

  async function walkRoot(root, token, acc, aggAcc) {
    // An explicit stack, not recursion: a deep tree would otherwise be bounded
    // by the JS call stack rather than by the entry cap, and blow up on the
    // machines with the most files — exactly the ones this has to survive.
    const stack = [root];
    while (stack.length) {
      if (token !== scanToken || stopped) return false;
      const dir = stack.pop();
      if (isSkippedPath(dir)) continue;
      let dirents;
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable (permissions, races) — skip, never fail the walk
      }
      for (const de of dirents) {
        if (acc.length >= maxEntries) { capped = true; return false; }
        const abs = path.join(dir, de.name);
        // Symlinks are recorded but never followed: following them is how a
        // walk ends up in a cycle, and how a link into / turns a home-directory
        // index into a whole-filesystem one.
        if (de.isSymbolicLink()) continue;
        const isDir = de.isDirectory();
        if (isDir && isSkippedPath(abs)) continue;
        if (isDir && SKIP_DIRS.has(de.name)) {
          if (!(await sizeWalk(abs, token, aggAcc))) return false;
          continue;
        }
        let size = 0, mtime = 0;
        try {
          const st = await fsp.lstat(abs);
          size = isDir ? 0 : st.size;
          mtime = st.mtimeMs;
        } catch { /* vanished between readdir and lstat — record what we have */ }
        acc.push({ p: abs, n: de.name, nl: foldName(de.name), s: size, m: mtime, d: isDir });
        if (isDir) { stats_.dirs++; stack.push(abs); } else { stats_.files++; stats_.bytes += size; }
      }
    }
    return true;
  }

  async function rebuild() {
    const token = ++scanToken;
    scanning = true;
    building = true;
    capped = false;
    stats_ = { files: 0, dirs: 0, bytes: 0 };
    const acc = [];
    const aggAcc = [];
    // Collected locally and published with `entries` below, for the same reason
    // that list is: a superseded walk must not leave its half-finished verdict
    // behind for a query to read.
    const incomplete = [];
    try {
      for (const r of roots) {
        if (token !== scanToken || stopped) return;
        try {
          const st = await fsp.stat(r);
          if (!st.isDirectory()) continue;
        } catch { incomplete.push(r); continue; }
        // Past the cap the remaining roots are still visited, but the first
        // batch of entries is already refused — so they are as absent from the
        // index as the root that was cut short, and are named the same way.
        if (!(await walkRoot(r, token, acc, aggAcc))) incomplete.push(r);
      }
      if (token !== scanToken || stopped) return;
      // Swapped in one assignment, never mutated in place: a query that runs
      // during a rescan sees the previous complete index or the new one, never a
      // half-built list that would silently return "no results" for a file that
      // is there.
      entries = acc;
      aggs = aggAcc;
      version++;
      cappedRoots = incomplete;
      building = false;
      ready = true;
    } finally {
      // Only the walk that is still current clears the flag — a superseded one
      // must not hand the newcomer's in-flight mark away. `finally` rather than
      // the tail, so a throw cannot leave the mark set forever (which would
      // stop every future rescan).
      if (token === scanToken) scanning = false;
    }
  }

  function scheduleRescan() {
    if (rescanTimer) clearInterval(rescanTimer);
    if (!roots.length || stopped) { rescanTimer = null; return; }
    // A periodic rewalk rather than a recursive watch. Node can watch
    // recursively on Linux, but one inotify watch per directory runs into
    // fs.inotify.max_user_watches (8192 by default on many distros) on exactly
    // the large home directories this is for, and failing that limit is silent.
    // A rewalk costs a burst of I/O every few minutes and cannot be defeated by
    // a sysctl.
    rescanTimer = setInterval(() => {
      // Never pre-empt the walk already running. rebuild() bumps scanToken and
      // walkRoot aborts the instant the token moves, so on any machine where a
      // full walk takes longer than rescanMs — a large or network-backed home, a
      // cold cache — every tick threw the walk away and started from zero: the
      // index never reached `ready`, query() answered {items:[], building:true}
      // forever, overview() stayed null, and the disk was walked continuously.
      // Skipping the tick is right rather than queueing one: the walk in flight
      // is already producing exactly the fresh index this tick wanted.
      if (scanning) return;
      rebuild().catch(() => {});
    }, rescanMs);
    if (rescanTimer.unref) rescanTimer.unref();
  }

  function setRoots(next) {
    const clean = (Array.isArray(next) ? next : [])
      .map((r) => String(r || '').trim())
      .filter((r) => r.startsWith('/'))
      .slice(0, 8);
    const same = clean.length === roots.length && clean.every((r, i) => r === roots[i]);
    if (same) return;
    roots = clean;
    entries = [];
    aggs = [];
    ready = false;
    building = clean.length > 0;
    scheduleRescan();
    if (roots.length) rebuild().catch(() => { building = false; });
  }

  function available() { return roots.length > 0; }

  async function query(q) {
    if (!available()) return null;
    try {
      return { ...queryIndex(entries, q || {}), building };
    } catch { return null; }
  }

  async function stats() {
    if (!roots.length) return { on: false };
    return {
      on: true,
      // `helper: true` is the honest answer to the question the field asks —
      // "is there a backend behind this?" — even though the backend is this
      // module and not an external binary. The UI uses it to decide whether to
      // offer the index at all.
      helper: true,
      ready, building,
      files: stats_.files, dirs: stats_.dirs, bytes: stats_.bytes, version,
      // Rough: the record plus its two strings, which is what actually grows.
      ramMB: Math.round(((entries.length + aggs.length) * 220) / (1024 * 1024)),
      maxEntries,
      roots: roots.slice(),
      capped,
      cappedRoots: cappedRoots.slice(),
      progress: building ? { files: stats_.files, dirs: stats_.dirs } : null,
    };
  }

  // ── Disk map ───────────────────────────────────────────────────────────────
  // All served from the one walk. Each answers null when there is no index, so
  // diskspace.js falls back exactly as it does for an absent helper.
  async function overview(root, opts) {
    if (!available() || !ready) return null;
    try { return { ...overviewFrom(entries, String(root || ''), opts || {}, aggs), capped, building, version }; } catch { return null; }
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
    if (!available() || !ready) return null;
    const d = String(dir || '').replace(/\/+$/, '') || '/';
    const out = [];
    for (const e of entries) {
      if (e.d) continue;
      const parent = e.p.slice(0, e.p.lastIndexOf('/')) || '/';
      if (parent !== d) continue;
      out.push({ p: e.p, n: e.n, s: e.s, m: e.m });
      if (out.length >= (max || 5000)) break;
    }
    return out;
  }
  async function browse(dir, opts) {
    if (!available() || !ready) return null;
    try { return { ...browseFrom(entries, String(dir || ''), opts || {}, aggs), version, building }; } catch { return null; }
  }

  function stop() {
    stopped = true;
    scanToken++;
    if (rescanTimer) { clearInterval(rescanTimer); rescanTimer = null; }
    entries = [];
    aggs = [];
  }

  return {
    available, query, stats, setRoots, stop,
    overview, sizes, dirs, list, top, dupes,
    browse,
    _entryCount() { return entries.length; },
    _rebuild() { return rebuild(); },
  };
}

module.exports = {
  createLinuxIndex, queryEntries, queryIndex, entryMatches, overviewFrom, browseFrom, foldName, matchTier, SKIP_DIRS, SKIP_PREFIXES, AGG_DEPTH,
};
