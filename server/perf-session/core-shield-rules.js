'use strict';
// The rules of the core shield: how many cores a process uses, which processes belong to one
// app, which are never moved, which app is in front and which are the busiest.

const { isSharedRuntime, keepsItsTree, leftAlone, processKey } = require('./process-names.js');

// Measured on 16 logical CPUs: 11 busy threads did no harm, 13 did.
const BUSY_SHARE = 0.7;
const PRESSURE_SAMPLES = 2;
// Below a quarter of a core an app is not what is filling the PC.
const APP_MIN_CORES = 0.25;
const MAX_APPS = 8;
// CPU time moves in steps of about 16 ms on Windows: two reads close together say nothing.
const MIN_SAMPLE_MS = 1000;
// More shared runtimes in a row than any app starts: a table that loops ends here.
const MAX_RUNTIME_DEPTH = 16;

// CPU cores each process used between two reads. A process in only one of them has no
// figure, and a reused pid is a different process.
function coresUsed(before, rows, elapsedMs) {
  const earlier = new Map(before.map((r) => [r.pid, r]));
  const used = new Map();
  for (const row of rows) {
    const old = earlier.get(row.pid);
    if (old && old.startedAt === row.startedAt) used.set(row.pid, Math.max(0, row.cpuMs - old.cpuMs) / elapsedMs);
  }
  return used;
}

// A pid can be reused, so a parent must be older than the child that names it.
function parentOf(row, byPid) {
  const parent = byPid.get(row.ppid);
  return parent && parent.pid !== row.pid && parent.startedAt <= row.startedAt ? parent : null;
}

// Parents always come before their children in the set.
function withDescendants(rows, byPid, roots) {
  const children = new Map();
  for (const row of rows) {
    const parent = parentOf(row, byPid);
    if (!parent) continue;
    if (!children.has(parent.pid)) children.set(parent.pid, []);
    children.get(parent.pid).push(row.pid);
  }
  const out = new Set(roots);
  const pending = [...roots];
  while (pending.length) {
    for (const pid of children.get(pending.pop()) || []) {
      if (!out.has(pid)) { out.add(pid); pending.push(pid); }
    }
  }
  return out;
}

function withAncestors(byPid, roots) {
  const out = new Set();
  for (const root of roots) {
    let row = byPid.get(root);
    while (row && !out.has(row.pid)) { out.add(row.pid); row = parentOf(row, byPid); }
  }
  return out;
}

// Everything the game needs, or that could start it again: its name, what it started,
// and what started it (a launcher's child would inherit the launcher's low priority).
// Xenon's own processes, voice and overlay apps and the apps the user keeps bring along
// what they started, as this server does: the shell's windows are web views with names
// of their own.
// Null when the game cannot be found: what cannot be named cannot be protected.
// keptRoots: more processes that bring their tree: the app in front, the apps handed back.
function untouchable(rows, byPid, wish, ownPid, keptRoots = []) {
  const gameName = processKey(wish.gameName);
  const game = rows.filter((r) => r.pid === wish.gamePid || (gameName && r.name === gameName)).map((r) => r.pid);
  if (!game.length) return null;
  const roots = [...game, ownPid];
  const kept = rows.filter((r) => keepsItsTree(r.name) || wish.keep.has(r.name)).map((r) => r.pid);
  return new Set([...withDescendants(rows, byPid, [...roots, ...kept, ...keptRoots]), ...withAncestors(byPid, roots)]);
}

// The process whose name is the app's. A shared runtime (WebView2, WebKit) draws the
// windows of the app that started it, so it stands for that app. With no app of the
// same user above it, as for WebKit on macOS, it belongs to nobody and is never moved.
function appRoot(row, byPid) {
  let at = row;
  for (let depth = 0; at && isSharedRuntime(at.name) && depth < MAX_RUNTIME_DEPTH; depth += 1) at = parentOf(at, byPid);
  return at && !isSharedRuntime(at.name) && at.owner === row.owner ? at : null;
}

function appOf(row, byPid) {
  const root = appRoot(row, byPid);
  return root ? root.name : '';
}

// The app the user is looking at, and everything it started: on macOS a browser's
// helpers and on Linux its tabs have names of their own. Something left alone brings
// no tree here: the desktop started every app, and the others keep theirs anyway.
function inFront(rows, byPid, foregroundPid) {
  const front = byPid.get(foregroundPid);
  const root = front ? appRoot(front, byPid) : null;
  const app = root ? root.name : '';
  const tree = root && !leftAlone(app) ? withDescendants(rows, byPid, [root.pid]) : new Set();
  return { app, tree };
}

// What may move this tick: the user's own processes, outside what is protected, of an
// app that is not left alone, kept, handed back or in front.
function moveRule({ self, keep, wish, handedBack, frontApp, appName }) {
  return (row) => {
    if (row.owner !== self.owner || keep.has(row.pid)) return false;
    const app = appName(row);
    return !!app && !leftAlone(app) && !handedBack.has(app) && !wish.keep.has(app) && app !== frontApp;
  };
}

// The apps worth moving now, busiest first: one app is many processes.
function busiestApps(rows, used, canMove, appName = (row) => row.name) {
  const load = new Map();
  for (const row of rows) {
    if (!canMove(row)) continue;
    const app = appName(row);
    load.set(app, (load.get(app) || 0) + (used.get(row.pid) || 0));
  }
  return [...load].filter(([, cores]) => cores >= APP_MIN_CORES).sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

module.exports = {
  BUSY_SHARE, PRESSURE_SAMPLES, APP_MIN_CORES, MAX_APPS, MIN_SAMPLE_MS, MAX_RUNTIME_DEPTH,
  coresUsed, parentOf, withDescendants, withAncestors, untouchable, appRoot, appOf, inFront,
  moveRule, busiestApps,
};
