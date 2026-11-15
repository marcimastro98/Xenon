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

const { fsp, SKIP_DIRS, SKIP_PREFIXES, AGG_DEPTH } = require('./linux-index-rules.js');
require('../disk-kinds'); // nothing is taken from it here, but it runs code when it loads

const DEFAULT_MAX_ENTRIES = 300000;
const DEFAULT_MAX_AGG = 60000;
const DEFAULT_RESCAN_MS = 10 * 60 * 1000;

// ── Pure query core (exported for tests) ─────────────────────────────────────
// An entry is { p, n, s, m, d } — path, name, size, mtime ms, isDir. `nl` is
// the lowercased name, precomputed because it is compared on every keystroke
// against every entry and recomputing it there is the whole cost of a query.

const { foldName, matchTier, queryEntries, queryIndex } = require('./linux-index-query.js');


// ── Disk map (exported for tests) ────────────────────────────────────────────
// The same walk that answers search already knows every file's size, so the
// disk widget needs no second traversal and no helper — it needs this list
// grouped four ways. disk-space/overview.js asks for all four in one `overview` call and
// does the rest itself (categories, and the SHA-256 verification that turns
// same-size candidates into real duplicates).

const { overviewFrom, browseFrom } = require('./linux-index-overview.js');

// ── The index ────────────────────────────────────────────────────────────────

const { makeWalks } = require('./linux-index-walks.js');

const { makeQuestions } = require('./linux-index-questions.js');

function createLinuxIndex(o = {}) {
  const maxEntries = o.maxEntries || DEFAULT_MAX_ENTRIES;
  const maxAgg = o.maxAgg || DEFAULT_MAX_AGG;
  const rescanMs = o.rescanMs || DEFAULT_RESCAN_MS;

  const ixState = {
    roots: [],
    entries: [],        // the live, queryable set
    aggs: [],           // measured-only folders (caches, build output): disk map, never search
    building: false,
    ready: false,
    capped: false,
    cappedRoots: [],    // the roots the cap left incomplete — swapped in with `entries`
    stats_: { files: 0, dirs: 0, bytes: 0 },
    scanToken: 0,       // invalidates a walk whose roots changed under it
    version: 0,        // bumped each time a finished walk is swapped in
    scanning: false,    // a walk is in flight — distinct from `building`, which is what a query reports
    rescanTimer: null,
    stopped: false,
    notBefore: undefined, // given its first value further down, where it was declared
    startTimer: null,
    held: false,
    waitingWalks: [],   // walks standing still until the game ends
  };
  ixState.notBefore = Date.now() + (o.startDelayMs || 0);   // see living-index.js

  const { walkRoot } = makeWalks({ maxEntries, maxAgg, ixState });

  function resumeWalks() {
    for (const resume of ixState.waitingWalks.splice(0)) resume();
  }

  async function rebuild() {
    const token = ++ixState.scanToken;
    ixState.scanning = true;
    ixState.building = true;
    ixState.capped = false;
    ixState.stats_ = { files: 0, dirs: 0, bytes: 0 };
    const acc = [];
    const aggAcc = [];
    // Collected locally and published with `entries` below, for the same reason
    // that list is: a superseded walk must not leave its half-finished verdict
    // behind for a query to read.
    const incomplete = [];
    try {
      for (const r of ixState.roots) {
        if (token !== ixState.scanToken || ixState.stopped) return;
        try {
          const st = await fsp.stat(r);
          if (!st.isDirectory()) continue;
        } catch { incomplete.push(r); continue; }
        // Past the cap the remaining roots are still visited, but the first
        // batch of entries is already refused — so they are as absent from the
        // index as the root that was cut short, and are named the same way.
        if (!(await walkRoot(r, token, acc, aggAcc))) incomplete.push(r);
      }
      if (token !== ixState.scanToken || ixState.stopped) return;
      // Swapped in one assignment, never mutated in place: a query that runs
      // during a rescan sees the previous complete index or the new one, never a
      // half-built list that would silently return "no results" for a file that
      // is there.
      ixState.entries = acc;
      ixState.aggs = aggAcc;
      ixState.version++;
      ixState.cappedRoots = incomplete;
      ixState.building = false;
      ixState.ready = true;
    } finally {
      // Only the walk that is still current clears the flag — a superseded one
      // must not hand the newcomer's in-flight mark away. `finally` rather than
      // the tail, so a throw cannot leave the mark set forever (which would
      // stop every future rescan).
      if (token === ixState.scanToken) ixState.scanning = false;
    }
  }

  function scheduleRescan() {
    if (ixState.rescanTimer) clearInterval(ixState.rescanTimer);
    if (!ixState.roots.length || ixState.stopped) { ixState.rescanTimer = null; return; }
    // A periodic rewalk rather than a recursive watch. Node can watch
    // recursively on Linux, but one inotify watch per directory runs into
    // fs.inotify.max_user_watches (8192 by default on many distros) on exactly
    // the large home directories this is for, and failing that limit is silent.
    // A rewalk costs a burst of I/O every few minutes and cannot be defeated by
    // a sysctl.
    ixState.rescanTimer = setInterval(() => {
      // Never pre-empt the walk already running. rebuild() bumps scanToken and
      // walkRoot aborts the instant the token moves, so on any machine where a
      // full walk takes longer than rescanMs — a large or network-backed home, a
      // cold cache — every tick threw the walk away and started from zero: the
      // index never reached `ready`, query() answered {items:[], building:true}
      // forever, overview() stayed null, and the disk was walked continuously.
      // Skipping the tick is right rather than queueing one: the walk in flight
      // is already producing exactly the fresh index this tick wanted.
      if (ixState.scanning || ixState.held) return;
      rebuild().catch(() => {});
    }, rescanMs);
    if (ixState.rescanTimer.unref) ixState.rescanTimer.unref();
  }

  function walkWhenDue() {
    if (ixState.startTimer) { clearTimeout(ixState.startTimer); ixState.startTimer = null; }
    if (ixState.stopped || !ixState.roots.length) return;
    const wait = ixState.notBefore - Date.now();
    if (wait <= 0) { rebuild().catch(() => { ixState.building = false; }); return; }
    ixState.startTimer = setTimeout(walkWhenDue, wait);
    if (ixState.startTimer.unref) ixState.startTimer.unref();
  }

  function setRoots(next) {
    const clean = (Array.isArray(next) ? next : [])
      .map((r) => String(r || '').trim())
      .filter((r) => r.startsWith('/'))
      .slice(0, 8);
    const same = clean.length === ixState.roots.length && clean.every((r, i) => r === ixState.roots[i]);
    if (same) return;
    ixState.roots = clean;
    ixState.entries = [];
    ixState.aggs = [];
    ixState.ready = false;
    ixState.building = clean.length > 0;
    scheduleRescan();
    walkWhenDue();
  }

  function hold(on) {
    ixState.held = on === true;
    if (!ixState.held) resumeWalks();
  }

  function available() { return ixState.roots.length > 0; }

  const {
    query, stats, overview, sizes, dirs, top, dupes, list, browse,
  } = makeQuestions({ maxEntries, ixState, walkWhenDue, available });


  function stop() {
    ixState.stopped = true;
    ixState.scanToken++;
    if (ixState.rescanTimer) { clearInterval(ixState.rescanTimer); ixState.rescanTimer = null; }
    if (ixState.startTimer) { clearTimeout(ixState.startTimer); ixState.startTimer = null; }
    hold(false);
    ixState.entries = [];
    ixState.aggs = [];
  }

  return {
    available, query, stats, setRoots, hold, stop,
    overview, sizes, dirs, list, top, dupes,
    browse,
    _entryCount() { return ixState.entries.length; },
    _rebuild() { return rebuild(); },
  };
}

module.exports = {
  createLinuxIndex, queryEntries, queryIndex, overviewFrom, browseFrom, foldName, matchTier, SKIP_DIRS, SKIP_PREFIXES, AGG_DEPTH,
};
