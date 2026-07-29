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
// browse, sizes, dirs, top, dupes) answers null exactly as an absent helper
// does, because it is a different feature with a different cost — every caller
// already treats null as "not available here" and falls back.
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

// Directory names never worth indexing: caches and build output, which are
// large, numerous, and never what someone types a filename to find.
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

function entryMatches(entry, terms, exts, after, before, minBytes, maxBytes) {
  if (exts && exts.length) {
    if (entry.d) return false;
    const ext = path.extname(entry.n).slice(1).toLowerCase();
    if (!exts.includes(ext)) return false;
  }
  if (typeof minBytes === 'number' && entry.s < minBytes) return false;
  if (typeof maxBytes === 'number' && entry.s > maxBytes) return false;
  if (typeof after === 'number' && entry.m < after) return false;
  if (typeof before === 'number' && entry.m > before) return false;
  if (!terms || !terms.length) return true;
  // Every term must appear in the NAME. Matching the full path as a fallback is
  // the obvious extra — it would let "downloads invoice" find
  // ~/Downloads/invoice.pdf — and it is deliberately not done, because those
  // rows cannot survive the pipeline they feed. search-rank.js drops any result
  // whose name scores 0 unless it came from an indexed-content match, which
  // exists only on Windows; a path-only row would therefore be returned here,
  // counted against the caller's 100-row budget, and then discarded before the
  // user ever saw it — crowding out real name matches to display nothing.
  // Matching what the ranker will accept is the difference between a backend
  // that looks busy and one that answers.
  const nl = entry.nl || entry.n.toLowerCase();
  for (const t of terms) {
    if (!nl.includes(t)) return false;
  }
  return true;
}

function queryEntries(entries, q) {
  const terms = (q.terms || []).map((t) => String(t).toLowerCase()).filter(Boolean);
  const exts = Array.isArray(q.exts) && q.exts.length
    ? q.exts.map((e) => String(e).toLowerCase().replace(/^\./, ''))
    : null;
  const max = Math.max(1, Math.min(500, q.max || 60));
  const out = [];
  for (const e of entries) {
    if (!entryMatches(e, terms, exts, q.after, q.before, q.minBytes, q.maxBytes)) continue;
    out.push({ p: e.p, n: e.n, s: e.s, m: e.m });
    if (out.length >= max) break;
  }
  return out;
}

// ── Disk map (exported for tests) ────────────────────────────────────────────
// The same walk that answers search already knows every file's size, so the
// disk widget needs no second traversal and no helper — it needs this list
// grouped four ways. diskspace.js asks for all four in one `overview` call and
// does the rest itself (categories, and the SHA-256 verification that turns
// same-size candidates into real duplicates).

const isUnder = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');

function overviewFrom(entries, root, opts = {}) {
  const r = root.length > 1 ? root.replace(/\/+$/, '') : root;
  const dirMinBytes = opts.dirMinBytes || 0;
  const dirMax = opts.dirMax || 4000;
  const topMax = opts.topMax || 200;
  const dupeMinBytes = opts.dupeMinBytes || 0;
  const dupeMax = opts.dupeMax || 100;
  const detailRoots = Array.isArray(opts.detailRoots) ? opts.detailRoots : [];
  const detailMax = opts.detailMax || 5000;

  let total = 0, files = 0;
  const dirBytes = new Map();   // dir path -> bytes below it
  const dirFiles = new Map();   // dir path -> files below it
  const dirMtime = new Map();   // dir path -> the directory's own mtime
  const fileList = [];
  const bySize = new Map();     // size -> [paths], duplicate candidates
  const detailFiles = [];

  for (const e of entries) {
    if (!isUnder(e.p, r)) continue;
    if (e.d) { dirMtime.set(e.p, e.m); continue; }
    total += e.s;
    files++;
    fileList.push(e);
    if (e.s >= dupeMinBytes && e.s > 0) {
      const arr = bySize.get(e.s);
      if (arr) arr.push(e.p); else bySize.set(e.s, [e.p]);
    }
    if (detailFiles.length < detailMax) {
      for (const dr of detailRoots) {
        if (isUnder(e.p, dr)) { detailFiles.push({ p: e.p, n: e.n, s: e.s, m: e.m }); break; }
      }
    }
    // Roll the file's size into every directory between it and the root. A
    // treemap is a nesting of totals, so a file 6 levels down has to count in
    // all 6 — summing only the immediate parent draws a map where the branches
    // are empty and only the leaves have weight.
    let dir = e.p.slice(0, e.p.lastIndexOf('/'));
    if (dir === '') dir = '/';
    while (true) {
      dirBytes.set(dir, (dirBytes.get(dir) || 0) + e.s);
      dirFiles.set(dir, (dirFiles.get(dir) || 0) + 1);
      if (dir === r || dir === '/' || !isUnder(dir, r)) break;
      const cut = dir.lastIndexOf('/');
      dir = cut <= 0 ? '/' : dir.slice(0, cut);
    }
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
    capped: dirs.length > dirMax,
    detailCapped: detailFiles.length >= detailMax,
  };
}

// ── The index ────────────────────────────────────────────────────────────────

function createLinuxIndex(o = {}) {
  const maxEntries = o.maxEntries || DEFAULT_MAX_ENTRIES;
  const rescanMs = o.rescanMs || DEFAULT_RESCAN_MS;

  let roots = [];
  let entries = [];        // the live, queryable set
  let building = false;
  let ready = false;
  let capped = false;
  let stats_ = { files: 0, dirs: 0, bytes: 0 };
  let scanToken = 0;       // invalidates a walk whose roots changed under it
  let scanning = false;    // a walk is in flight — distinct from `building`, which is what a query reports
  let rescanTimer = null;
  let stopped = false;

  async function walkRoot(root, token, acc) {
    // An explicit stack, not recursion: a deep tree would otherwise be bounded
    // by the JS call stack rather than by the entry cap, and blow up on the
    // machines with the most files — exactly the ones this has to survive.
    const stack = [root];
    while (stack.length) {
      if (token !== scanToken || stopped) return;
      const dir = stack.pop();
      if (isSkippedPath(dir)) continue;
      let dirents;
      try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable (permissions, races) — skip, never fail the walk
      }
      for (const de of dirents) {
        if (acc.length >= maxEntries) { capped = true; return; }
        const abs = path.join(dir, de.name);
        // Symlinks are recorded but never followed: following them is how a
        // walk ends up in a cycle, and how a link into / turns a home-directory
        // index into a whole-filesystem one.
        if (de.isSymbolicLink()) continue;
        const isDir = de.isDirectory();
        if (isDir && (SKIP_DIRS.has(de.name) || isSkippedPath(abs))) continue;
        let size = 0, mtime = 0;
        try {
          const st = await fsp.lstat(abs);
          size = isDir ? 0 : st.size;
          mtime = st.mtimeMs;
        } catch { /* vanished between readdir and lstat — record what we have */ }
        acc.push({ p: abs, n: de.name, nl: de.name.toLowerCase(), s: size, m: mtime, d: isDir });
        if (isDir) { stats_.dirs++; stack.push(abs); } else { stats_.files++; stats_.bytes += size; }
      }
    }
  }

  async function rebuild() {
    const token = ++scanToken;
    scanning = true;
    building = true;
    capped = false;
    stats_ = { files: 0, dirs: 0, bytes: 0 };
    const acc = [];
    try {
      for (const r of roots) {
        if (token !== scanToken || stopped) return;
        try {
          const st = await fsp.stat(r);
          if (!st.isDirectory()) continue;
        } catch { continue; }
        await walkRoot(r, token, acc);
      }
      if (token !== scanToken || stopped) return;
      // Swapped in one assignment, never mutated in place: a query that runs
      // during a rescan sees the previous complete index or the new one, never a
      // half-built list that would silently return "no results" for a file that
      // is there.
      entries = acc;
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
    ready = false;
    building = clean.length > 0;
    scheduleRescan();
    if (roots.length) rebuild().catch(() => { building = false; });
  }

  function available() { return roots.length > 0; }

  async function query(q) {
    if (!available()) return null;
    try {
      return { items: queryEntries(entries, q || {}), building };
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
      files: stats_.files, dirs: stats_.dirs, bytes: stats_.bytes,
      // Rough: the record plus its two strings, which is what actually grows.
      ramMB: Math.round((entries.length * 220) / (1024 * 1024)),
      roots: roots.slice(),
      capped,
      progress: building ? { files: stats_.files, dirs: stats_.dirs } : null,
    };
  }

  // ── Disk map ───────────────────────────────────────────────────────────────
  // All served from the one walk. Each answers null when there is no index, so
  // diskspace.js falls back exactly as it does for an absent helper.
  async function overview(root, opts) {
    if (!available() || !ready) return null;
    try { return { ...overviewFrom(entries, String(root || ''), opts || {}), building }; } catch { return null; }
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
  // Not implemented: diskspace.js already derives the treemap node from the
  // overview it holds, and doing it again here would be a second answer to the
  // same question with its own chance of disagreeing with the first.
  const unavailable = async () => null;

  function stop() {
    stopped = true;
    scanToken++;
    if (rescanTimer) { clearInterval(rescanTimer); rescanTimer = null; }
    entries = [];
  }

  return {
    available, query, stats, setRoots, stop,
    overview, sizes, dirs, list, top, dupes,
    browse: unavailable,
    _entryCount() { return entries.length; },
    _rebuild() { return rebuild(); },
  };
}

module.exports = {
  createLinuxIndex, queryEntries, entryMatches, overviewFrom, SKIP_DIRS, SKIP_PREFIXES,
};
