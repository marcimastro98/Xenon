'use strict';
// Core Shield. In a Performance session with a game running, when the PC runs out of
// free cores, the busiest other apps move to a few cores of their own (fence-*.js) and
// stay there until the session or the game ends. The game itself is never touched.
//
// It reads the process table on the status tick that already runs, so it adds no timer,
// and does nothing at all while the cores have room: on a stand-in game, moving apps
// changed nothing with 4 busy threads around it, and took late frames from 47-66% to
// 1.3% with 16.
//
// Everything moved is written down (ledger.js), so a server that dies mid-game puts the
// apps back at its next start.

const { isSharedRuntime, keepsItsTree, leftAlone, processKey } = require('./process-names');

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

function createCoreShield({ table, fence, ledger, logicalCpus, ownPid = process.pid, now = Date.now, log = console.warn }) {
  const moved = new Map();       // pid -> record
  const names = new Set();       // apps held this session: new processes of theirs join
  const handedBack = new Set();  // apps the user brought to the front: they stay out
  const refused = new Set();     // pids that said no, asked once per session
  let report = [];               // apps moved this session, for the note at its end
  let before = null;
  let beforeAt = 0;
  let pressure = 0;
  let running = null;
  let stopped = false;

  // forgetEnded has run by the time this is asked, so a pid here is that process.
  const isMoved = (row) => moved.has(row.pid);

  // app: the app it moves for, whose return to the front brings it back too.
  async function move(row, parent, app) {
    const result = await fence.apply(row, parent);
    if (!result) { refused.add(row.pid); return false; }
    moved.set(row.pid, { pid: row.pid, startedAt: row.startedAt, name: row.name, app, ...result });
    return true;
  }

  // A record read back from the ledger after a crash has no app: its name stands in.
  const appMoved = (record) => record.app || record.name;

  // A process that is gone took its settings with it. A reused pid is someone else.
  function forgetEnded(byPid) {
    let changed = false;
    for (const [pid, record] of moved) {
      const row = byPid.get(pid);
      if (!row || row.startedAt !== record.startedAt) { moved.delete(pid); changed = true; }
    }
    return changed;
  }

  // The app brought to the front goes back, with everything moved for it and
  // everything it started, and stays out until the session ends.
  async function handBack({ app, tree }) {
    if (!app) return false;
    const back = [...moved.values()].filter((record) => appMoved(record) === app || tree.has(record.pid));
    if (!names.has(app) && !back.length) return false;
    names.delete(app);
    handedBack.add(app);
    for (const record of back) {
      await fence.clear(record);
      moved.delete(record.pid);
    }
    return true;
  }

  // New processes of a moved app, and whatever a moved app started: its children get
  // the low priority from it but not the cores.
  async function followApps(rows, byPid, canMove, appName) {
    let changed = false;
    for (const row of rows) {
      if (isMoved(row) || refused.has(row.pid) || !canMove(row)) continue;
      const parent = parentOf(row, byPid);
      const parentRecord = parent && isMoved(parent) ? moved.get(parent.pid) : null;
      const app = parentRecord ? appMoved(parentRecord) : appName(row);
      if (parentRecord || names.has(app)) changed = await move(row, parentRecord, app) || changed;
    }
    return changed;
  }

  // Null while the reads are too close together to mean anything.
  function sample(rows) {
    const at = now();
    if (before && at - beforeAt < MIN_SAMPLE_MS) return null;
    const used = before ? coresUsed(before, rows, at - beforeAt) : new Map();
    if (before) {
      let total = 0;
      for (const cores of used.values()) total += cores;
      pressure = total / logicalCpus >= BUSY_SHARE ? pressure + 1 : 0;
    }
    before = rows;
    beforeAt = at;
    return used;
  }

  async function moveBusiest(rows, used, canMove, appName) {
    let changed = false;
    for (const app of busiestApps(rows, used, canMove, appName)) {
      if (names.size >= MAX_APPS) break;
      if (names.has(app)) continue;
      names.add(app);
      for (const row of rows) {
        if (appName(row) === app && !isMoved(row) && !refused.has(row.pid) && canMove(row)) changed = await move(row, null, app) || changed;
      }
      if (![...moved.values()].some((r) => r.app === app)) names.delete(app);
    }
    return changed;
  }

  async function tick(wish) {
    if (!await fence.ready()) return;
    const rows = await table.read();
    if (!rows) return;
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const self = byPid.get(ownPid);
    const front = inFront(rows, byPid, wish.foregroundPid);
    const handedBackPids = rows.filter((r) => handedBack.has(r.name)).map((r) => r.pid);
    const keep = untouchable(rows, byPid, wish, ownPid, [...handedBackPids, ...front.tree]);
    if (!self || !keep) return;
    const appName = (row) => appOf(row, byPid);
    const canMove = moveRule({ self, keep, wish, handedBack, frontApp: front.app, appName });

    let changed = forgetEnded(byPid);
    changed = await handBack(front) || changed;
    changed = await followApps(rows, byPid, canMove, appName) || changed;
    const used = sample(rows);
    if (used && pressure >= PRESSURE_SAMPLES) changed = await moveBusiest(rows, used, canMove, appName) || changed;
    if (changed) await ledger.save([...moved.values()]);
    report = [...new Set([...report, ...names])];
  }

  // Whatever a moved app started since the last tick took its low priority with it, so
  // it is written down before everything goes back.
  async function adoptChildren(rows, byPid) {
    for (const pid of withDescendants(rows, byPid, [...moved.keys()])) {
      const row = byPid.get(pid);
      if (!row || isMoved(row)) continue;
      const parent = parentOf(row, byPid);
      const record = parent && isMoved(parent) ? moved.get(parent.pid) : null;
      if (record) await move(row, record, appMoved(record));
    }
  }

  // An unreadable table leaves everything as it is, ledger included, for the next try.
  async function releaseAll() {
    if (!moved.size) return;
    const rows = await table.read();
    if (!rows) return;
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    forgetEnded(byPid);
    await adoptChildren(rows, byPid);
    for (const record of moved.values()) await fence.clear(record);
    moved.clear();
    await ledger.save([]);
  }

  function reset() {
    names.clear();
    handedBack.clear();
    refused.clear();
    before = null;
    pressure = 0;
  }

  // One piece of work at a time: a slow read must not stack up behind the next tick.
  function serial(work) {
    running = work().catch((e) => log('core shield: ' + e.message)).finally(() => { running = null; });
    return running;
  }

  // Called on the status tick. wish: { session, on, gamePid, gameName, foregroundPid, keep }.
  // `session` outlives the game, so the report is still there when the session ends.
  function sync(wish) {
    if (stopped) return Promise.resolve();
    if (running) return running;
    const w = wish || {};
    if (!w.session) report = [];
    if (w.on) return serial(() => tick(w));
    if (!moved.size && !before) return Promise.resolve();
    return serial(() => releaseAll().then(reset));
  }

  // Shutdown: whatever is moved goes back now, after the work in flight.
  async function stop() {
    stopped = true;
    if (running) await running;
    await serial(releaseAll);
    reset();
  }

  // A start after a crash: the apps a dead server left moved go back. If the table
  // cannot be read they stay in `moved`, and the next status tick tries again.
  function recover() {
    return serial(async () => {
      for (const record of await ledger.read()) moved.set(record.pid, record);
      await releaseAll();
    });
  }

  async function status() {
    const plan = await fence.ready();
    return { available: !!plan && table.available(), cores: plan ? plan.cores : 0, moved: report.slice() };
  }

  return { sync, stop, recover, status, movedCount: () => report.length };
}

module.exports = { createCoreShield, coresUsed, busiestApps, BUSY_SHARE, PRESSURE_SAMPLES, APP_MIN_CORES, MAX_APPS };
