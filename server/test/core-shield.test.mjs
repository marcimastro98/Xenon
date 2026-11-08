// Core Shield (perf-session/core-shield.js): in a Performance session with a game
// running, when the PC runs out of free cores, the busiest other apps move aside until
// the session or the game ends. What matters here is what it must never touch, and
// that everything it moved goes back, whatever happens to the server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCoreShield, coresUsed, busiestApps, BUSY_SHARE, PRESSURE_SAMPLES, APP_MIN_CORES, MAX_APPS } = require('../perf-session/core-shield.js');
const { isSharedRuntime } = require('../perf-session/process-names.js');

const OWN = 10;
const GAME = 20;
const LAUNCHER = 15;
const USER = 1;
const SERVICES = 0;
const TICK_MS = 3000;

const row = (pid, name, more = {}) => ({ pid, ppid: 1, name, cpuMs: 0, memBytes: 1, startedAt: 100, owner: USER, ...more });

function desktop() {
  return [
    row(OWN, 'node'),
    row(LAUNCHER, 'steam'),
    row(GAME, 'game', { ppid: LAUNCHER, startedAt: 200 }),
    row(21, 'crashpad', { ppid: GAME, startedAt: 210 }),
    row(30, 'handbrake'),
    row(40, 'notepad'),
    row(50, 'discord'),
    row(60, 'msmpeng', { owner: SERVICES }),
    row(70, 'obs64'),
  ];
}

function rig({ rows = desktop(), cpus = 16, ready = { cores: 2 }, ledger = [] } = {}) {
  const s = {
    rows, at: 1_000_000, refuse: new Set(), applied: [], asked: [], cleared: [], saved: [], logs: [], reads: 0,
    ledger, readable: true, gate: null,
  };
  const shield = createCoreShield({
    table: {
      read: async () => { s.reads += 1; return s.readable ? s.rows.map((r) => ({ ...r })) : null; },
      available: () => s.readable,
    },
    fence: {
      ready: async () => ready,
      apply: async (r, parent) => {
        s.asked.push(r.pid);
        if (s.gate) await s.gate;
        if (s.refuse.has(r.pid)) return null;
        s.applied.push({ pid: r.pid, parent: parent ? parent.pid : 0 });
        return { priority: parent ? parent.priority : 0 };
      },
      clear: async (record) => { s.cleared.push(record.pid); return true; },
    },
    ledger: { read: async () => s.ledger, save: async (list) => { s.ledger = list.slice(); s.saved.push(list.map((r) => r.pid)); } },
    logicalCpus: cpus,
    ownPid: OWN,
    now: () => s.at,
    log: (line) => s.logs.push(line),
  });
  return { s, shield };
}

const wish = (more = {}) => ({ session: true, on: true, gamePid: GAME, gameName: 'game', foregroundPid: GAME, keep: new Set(), ...more });

// One status tick later, with these processes having used this many cores.
async function tick(r, load = {}, w = wish()) {
  r.s.at += TICK_MS;
  r.s.rows = r.s.rows.map((p) => (load[p.pid] ? { ...p, cpuMs: p.cpuMs + load[p.pid] * TICK_MS } : p));
  await r.shield.sync(w);
}

const FULL = { [GAME]: 8, 30: 6 };
const movedPids = (r) => r.s.applied.map((a) => a.pid);

async function underPressure(r, load = FULL, w = wish()) {
  await tick(r, load, w);
  for (let i = 0; i < PRESSURE_SAMPLES; i += 1) await tick(r, load, w);
}

test('with cores to spare nothing moves, however long the game runs', async () => {
  const r = rig();
  for (let i = 0; i < 6; i += 1) await tick(r, { [GAME]: 6, 30: 3 });
  assert.deepEqual(r.s.applied, []);
  assert.deepEqual(r.s.saved, [], 'and nothing is written');
});

test('a PC that stays full moves its busiest app, a spike does not', async () => {
  const spike = rig();
  await tick(spike, FULL);
  await tick(spike, FULL);
  await tick(spike, {});
  await tick(spike, FULL);
  assert.deepEqual(spike.s.applied, [], 'one busy read in a row is not pressure');

  const full = rig();
  await underPressure(full);
  assert.deepEqual(movedPids(full), [30]);
  assert.deepEqual(full.s.ledger.map((x) => x.pid), [30], 'and it is written down at once');
});

test('the threshold is the share measured, of the cores this PC has', async () => {
  const cores = 16;
  const justUnder = rig({ cpus: cores });
  const below = { [GAME]: cores * BUSY_SHARE - 3.1, 30: 3 };
  await underPressure(justUnder, below);
  assert.deepEqual(justUnder.s.applied, []);

  const justOver = rig({ cpus: cores });
  await underPressure(justOver, { [GAME]: cores * BUSY_SHARE - 2.9, 30: 3 });
  assert.deepEqual(movedPids(justOver), [30]);
});

test('the game, what it started and what started it are never touched', async () => {
  const r = rig();
  await underPressure(r, { [GAME]: 8, 21: 2, [LAUNCHER]: 2, 30: 2 });
  assert.deepEqual(movedPids(r), [30]);
});

test('a game known only by name is still protected, with its children', async () => {
  const r = rig();
  await underPressure(r, { [GAME]: 8, 21: 2, 30: 3 }, wish({ gamePid: 0 }));
  assert.deepEqual(movedPids(r), [30]);
});

test('a game that cannot be found stops everything: what is unnamed cannot be protected', async () => {
  const r = rig();
  await underPressure(r, FULL, wish({ gamePid: 999, gameName: 'nothere' }));
  assert.deepEqual(r.s.applied, []);
});

test('the server and its tree stay where they are', async () => {
  const r = rig();
  r.s.rows.push(row(11, 'xenon-capture', { ppid: OWN, startedAt: 300 }), row(12, 'ffmpeg', { ppid: OWN, startedAt: 300 }));
  await underPressure(r, { [GAME]: 8, [OWN]: 2, 11: 2, 12: 2, 30: 2 });
  assert.deepEqual(movedPids(r), [30]);
});

// Found on a real game, 7 Nov 2026: the dashboard and the counter over the game are
// WebView2 windows of the shell, and they moved with every other app's web views.
test('Xenon\'s windows and what it started stay where they are, whatever draws them', async () => {
  const r = rig();
  r.s.rows.push(
    row(90, 'xenon-native'),
    row(91, 'msedgewebview2', { ppid: 90, startedAt: 300 }),
    row(92, 'msedgewebview2', { ppid: 91, startedAt: 310 }),
    row(93, 'ffmpeg', { ppid: 90, startedAt: 300 }),
  );
  await underPressure(r, { [GAME]: 8, 91: 2, 92: 2, 93: 2, 30: 2 });
  assert.deepEqual(movedPids(r), [30]);
});

test('a web view many apps share is part of the app that opened it, and goes back with it', async () => {
  const r = rig();
  r.s.rows.push(
    row(95, 'ms-teams'),
    row(96, 'msedgewebview2', { ppid: 95, startedAt: 300 }),
    row(97, 'msedgewebview2', { ppid: 96, startedAt: 310 }),
    row(98, 'widgets'),
    row(99, 'msedgewebview2', { ppid: 98, startedAt: 300 }),
  );
  await underPressure(r, { [GAME]: 12, 96: 1, 97: 1 });
  assert.deepEqual(movedPids(r).sort((a, b) => a - b), [95, 96, 97], 'the other app on the same runtime stays');
  assert.deepEqual((await r.shield.status()).moved, ['ms-teams']);

  await tick(r, { [GAME]: 12 }, wish({ foregroundPid: 95 }));
  assert.deepEqual(r.s.cleared.sort((a, b) => a - b), [95, 96, 97], 'brought to the front, all of it goes back');

  const view = rig();
  view.s.rows.push(row(95, 'ms-teams'), row(96, 'msedgewebview2', { ppid: 95, startedAt: 300 }));
  await underPressure(view, { [GAME]: 12, 96: 2 });
  await tick(view, { [GAME]: 12 }, wish({ foregroundPid: 96 }));
  assert.deepEqual(view.s.cleared.sort((a, b) => a - b), [95, 96], 'a web view in front stands for its app');
});

test('a shared runtime with no app of the user above it is never moved', async () => {
  const r = rig();
  r.s.rows.push(
    row(1, 'launchd', { ppid: 0, owner: SERVICES, startedAt: 1 }),
    row(101, 'com.apple.webkit.webcontent', { startedAt: 300 }),
    row(102, 'com.apple.webkit.webcontent', { startedAt: 300 }),
    row(103, 'msedgewebview2', { ppid: 104, startedAt: 300 }),
    row(104, 'msedgewebview2', { ppid: 103, startedAt: 300 }),
  );
  await underPressure(r, { [GAME]: 12, 101: 1, 102: 1, 103: 1, 104: 1 });
  assert.deepEqual(r.s.applied, [], 'nor one whose table loops');
});

test('the shared web runtimes are known by the names each system gives them', () => {
  for (const name of ['msedgewebview2', 'com.apple.webkit.webcontent', 'com.apple.webkit.networking', 'webkitwebproces', 'webkitnetworkpr']) {
    assert.equal(isSharedRuntime(name), true, name);
  }
  for (const name of ['msedge', 'chrome', 'xenon-native', 'webkit']) assert.equal(isSharedRuntime(name), false, name);
});

test('services and other people\'s processes are out of reach', async () => {
  const r = rig();
  await underPressure(r, { [GAME]: 8, 60: 6 });
  assert.deepEqual(r.s.applied, []);
});

test('voice, sound and overlays stay, and so does what the user keeps', async () => {
  const r = rig();
  await underPressure(r, { [GAME]: 8, 50: 3, 70: 3 }, wish({ keep: new Set(['obs64']) }));
  assert.deepEqual(r.s.applied, []);
});

test('what the user keeps stays with everything it started', async () => {
  const r = rig();
  r.s.rows.push(row(71, 'obs-browser-page', { ppid: 70, startedAt: 300 }));
  await underPressure(r, { [GAME]: 8, 71: 3, 30: 2 }, wish({ keep: new Set(['obs64']) }));
  assert.deepEqual(movedPids(r), [30]);
});

test('what a moved app started goes back with it when it comes to the front', async () => {
  const r = rig();
  await underPressure(r);
  r.s.rows.push(row(32, 'encoder', { ppid: 30, startedAt: 500 }));
  await tick(r, { [GAME]: 8 });
  await tick(r, FULL, wish({ foregroundPid: 30 }));
  assert.deepEqual(r.s.cleared.sort((a, b) => a - b), [30, 32]);
});

test('the app in front is not moved, and one brought to the front goes back for the session', async () => {
  const front = rig();
  await underPressure(front, FULL, wish({ foregroundPid: 30 }));
  assert.deepEqual(front.s.applied, []);

  const r = rig();
  await underPressure(r);
  assert.deepEqual(movedPids(r), [30]);
  await tick(r, FULL, wish({ foregroundPid: 30 }));
  assert.deepEqual(r.s.cleared, [30]);
  assert.deepEqual(r.s.ledger, []);
  await tick(r, FULL);
  await tick(r, FULL);
  await tick(r, FULL);
  assert.deepEqual(movedPids(r), [30], 'alt-tabbing back to the game does not move it again');
  assert.deepEqual((await r.shield.status()).moved, ['handbrake'], 'it did move, so the note at the end counts it');
});

// Firefox on Linux: its tabs are processes of the browser with a name of their own,
// as a browser's helpers are on macOS.
const browser = () => [
  row(61, 'firefox'),
  row(62, 'isolated web co', { ppid: 61, startedAt: 300 }),
  row(63, 'isolated web co', { ppid: 61, startedAt: 300 }),
];
const TABS = { [GAME]: 8, 62: 2, 63: 2 };

test('the app in front keeps everything it started, and brings it back with it', async () => {
  const front = rig();
  front.s.rows.push(...browser());
  await underPressure(front, TABS, wish({ foregroundPid: 61 }));
  assert.deepEqual(front.s.applied, [], 'nothing of the app in front moves');

  const r = rig();
  r.s.rows.push(...browser());
  await underPressure(r, TABS);
  assert.deepEqual(movedPids(r).sort((a, b) => a - b), [62, 63]);
  await tick(r, TABS, wish({ foregroundPid: 61 }));
  assert.deepEqual(r.s.cleared.sort((a, b) => a - b), [62, 63], 'looking at the browser brings its tabs back');

  r.s.rows.push(row(64, 'isolated web co', { ppid: 61, startedAt: 400 }));
  for (let i = 0; i < 3; i += 1) await tick(r, { ...TABS, 64: 2 });
  assert.deepEqual(movedPids(r).sort((a, b) => a - b), [62, 63], 'back at the game, neither they nor a new tab move again');
});

test('voice and overlay apps keep what they started: on macOS Discord\'s helpers have names of their own', async () => {
  const r = rig();
  r.s.rows.push(
    row(51, 'discord helper (renderer)', { ppid: 50, startedAt: 300 }),
    row(52, 'discord helper (gpu)', { ppid: 50, startedAt: 300 }),
  );
  await underPressure(r, { [GAME]: 8, 51: 3, 52: 3, 30: 2 });
  assert.deepEqual(movedPids(r), [30]);
});

test('the desktop stays, but neither keeps nor hands back the apps started from it', async () => {
  const r = rig();
  r.s.rows.push(row(5, 'plasmashell'), row(31, 'blender', { ppid: 5, startedAt: 300 }));
  const load = { [GAME]: 8, 5: 1, 31: 6 };
  await underPressure(r, load);
  assert.deepEqual(movedPids(r), [31]);
  await tick(r, load, wish({ foregroundPid: 5 }));
  assert.deepEqual(r.s.cleared, [], 'the desktop in front hands nothing back');
});

test('one app is many processes: they count together and move together', async () => {
  const r = rig();
  r.s.rows.push(...[81, 82, 83, 84].map((pid) => row(pid, 'chrome')));
  await underPressure(r, { [GAME]: 12, 81: 0.1, 82: 0.1, 83: 0.1, 84: 0.1 });
  assert.deepEqual(movedPids(r).sort(), [81, 82, 83, 84]);
});

test('an app below a quarter of a core is not what fills the PC', () => {
  const rows = [row(1, 'small'), row(2, 'big')];
  const used = new Map([[1, APP_MIN_CORES - 0.01], [2, APP_MIN_CORES]]);
  assert.deepEqual(busiestApps(rows, used, () => true), ['big']);
});

test('apps come busiest first, and only as many as the limit', async () => {
  const rows = [row(1, 'a'), row(2, 'b'), row(3, 'c')];
  assert.deepEqual(busiestApps(rows, new Map([[1, 1], [2, 3], [3, 2]]), () => true), ['b', 'c', 'a']);

  const r = rig();
  const load = { [GAME]: 4 };
  for (let i = 0; i < MAX_APPS + 3; i += 1) {
    r.s.rows.push(row(100 + i, 'app' + i));
    load[100 + i] = 1;
  }
  await underPressure(r, load);
  assert.equal(r.s.applied.length, MAX_APPS);
});

test('a new process of a moved app joins it', async () => {
  const r = rig();
  await underPressure(r);
  r.s.rows.push(row(31, 'handbrake', { startedAt: 500 }));
  await tick(r, { [GAME]: 1 });
  assert.deepEqual(movedPids(r), [30, 31]);
  assert.deepEqual(r.s.ledger.map((x) => x.pid), [30, 31]);
});

test('what a moved app started joins it, carrying the level to go back to', async () => {
  const r = rig();
  await underPressure(r);
  r.s.rows.push(row(32, 'encoder', { ppid: 30, startedAt: 500 }));
  await tick(r, { [GAME]: 1 });
  assert.deepEqual(r.s.applied.at(-1), { pid: 32, parent: 30 });
});

test('a pid reused by something newer is not its parent\'s child', async () => {
  const r = rig();
  await underPressure(r);
  // Started before its "parent" did, so that pid was someone else when it was born.
  r.s.rows.push(row(33, 'older', { ppid: 30, startedAt: 50 }));
  await tick(r, { [GAME]: 1 });
  assert.deepEqual(movedPids(r), [30]);
});

test('a process that says no is asked once', async () => {
  const r = rig();
  r.s.refuse.add(30);
  r.s.rows.push(row(31, 'handbrake'));
  await underPressure(r);
  for (let i = 0; i < 3; i += 1) await tick(r, FULL);
  assert.deepEqual(movedPids(r), [31]);
  assert.equal(r.s.asked.filter((pid) => pid === 30).length, 1);
});

test('an app no process of which could move is not held', async () => {
  const r = rig();
  r.s.refuse.add(30);
  await underPressure(r);
  assert.deepEqual(r.s.applied, []);
  assert.deepEqual((await r.shield.status()).moved, []);
});

test('when the game ends everything goes back and the record goes with it', async () => {
  const r = rig();
  await underPressure(r);
  await r.shield.sync(wish({ on: false }));
  assert.deepEqual(r.s.cleared, [30]);
  assert.deepEqual(r.s.ledger, []);
  const reads = r.s.reads;
  await r.shield.sync(wish({ on: false }));
  assert.equal(r.s.reads, reads, 'and with nothing to do it reads nothing');
});

test('a session with no moved apps costs no read after it ends', async () => {
  const r = rig();
  await r.shield.sync({ session: false, on: false });
  assert.equal(r.s.reads, 0);
});

test('a process that ended takes its settings with it', async () => {
  const r = rig();
  await underPressure(r);
  r.s.rows = r.s.rows.filter((p) => p.pid !== 30);
  await tick(r, { [GAME]: 1 });
  assert.deepEqual(r.s.ledger, []);
  await r.shield.sync(wish({ on: false }));
  assert.deepEqual(r.s.cleared, [], 'there is nothing left to put back');
});

test('a reused pid is someone else, and nothing is done to it', async () => {
  const r = rig();
  await underPressure(r);
  r.s.rows = r.s.rows.map((p) => (p.pid === 30 ? { ...p, name: 'stranger', startedAt: 999 } : p));
  await r.shield.sync(wish({ on: false }));
  assert.deepEqual(r.s.cleared, []);
});

test('whatever a moved app started at the last moment goes back with it', async () => {
  const r = rig();
  await underPressure(r);
  r.s.rows.push(row(34, 'encoder', { ppid: 30, startedAt: 500 }));
  await r.shield.sync(wish({ on: false }));
  assert.deepEqual(r.s.cleared.slice().sort(), [30, 34]);
});

test('a table nobody can read leaves things as they are, and the next tick tries again', async () => {
  const r = rig();
  await underPressure(r);
  r.s.readable = false;
  await r.shield.sync(wish({ on: false }));
  assert.deepEqual(r.s.cleared, []);
  assert.deepEqual(r.s.ledger.map((x) => x.pid), [30], 'the record stays until they are back');
  r.s.readable = true;
  await r.shield.sync(wish({ on: false }));
  assert.deepEqual(r.s.cleared, [30]);
  assert.deepEqual(r.s.ledger, []);
});

test('a start after a crash puts back what the dead server moved, and only that', async () => {
  const r = rig({ ledger: [
    { pid: 30, startedAt: 100, name: 'handbrake', priority: 0 },
    { pid: 40, startedAt: 1, name: 'notepad', priority: 0 },
    { pid: 888, startedAt: 100, name: 'gone', priority: 0 },
  ] });
  await r.shield.recover();
  assert.deepEqual(r.s.cleared, [30], 'pid 40 is a new process now, pid 888 is gone');
  assert.deepEqual(r.s.ledger, []);
});

test('a clean start touches nothing and reads no table', async () => {
  const r = rig();
  await r.shield.recover();
  assert.equal(r.s.reads, 0);
  assert.deepEqual(r.s.saved, []);
});

test('a start that cannot read the table retries on the next tick', async () => {
  const r = rig({ ledger: [{ pid: 30, startedAt: 100, name: 'handbrake', priority: 0 }] });
  r.s.readable = false;
  await r.shield.recover();
  assert.deepEqual(r.s.cleared, []);
  r.s.readable = true;
  await r.shield.sync({ session: false, on: false });
  assert.deepEqual(r.s.cleared, [30]);
});

test('shutdown puts everything back, and a late tick moves nothing again', async () => {
  const r = rig();
  await underPressure(r);
  await r.shield.stop();
  assert.deepEqual(r.s.cleared, [30]);
  const moved = r.s.applied.length;
  await underPressure(r);
  assert.equal(r.s.applied.length, moved);
});

test('shutdown waits for the work in flight, or what lands after it would stay moved', async () => {
  const r = rig();
  await tick(r, FULL);
  await tick(r, FULL);
  let open;
  r.s.gate = new Promise((resolve) => { open = resolve; });
  const inFlight = tick(r, FULL);
  const stopping = r.shield.stop();
  open();
  await Promise.all([inFlight, stopping]);
  assert.deepEqual(movedPids(r), [30]);
  assert.deepEqual(r.s.cleared, [30]);
  assert.deepEqual(r.s.ledger, []);
});

test('ticks do not stack up behind a slow read', async () => {
  const r = rig();
  const first = r.shield.sync(wish());
  const second = r.shield.sync(wish());
  await Promise.all([first, second]);
  assert.equal(r.s.reads, 1);
});

test('reads closer than a second say nothing about load', async () => {
  const r = rig();
  await r.shield.sync(wish());
  for (let i = 0; i < 6; i += 1) {
    r.s.at += 100;
    r.s.rows = r.s.rows.map((p) => (p.pid === 30 ? { ...p, cpuMs: p.cpuMs + 1600 } : p));
    await r.shield.sync(wish());
  }
  assert.deepEqual(r.s.applied, []);
});

test('with no fence on this PC it does nothing at all', async () => {
  const r = rig({ ready: null });
  await underPressure(r);
  assert.equal(r.s.reads, 0);
  assert.deepEqual(await r.shield.status(), { available: false, cores: 0, moved: [] });
});

test('the status names what moved until the session ends', async () => {
  const r = rig();
  await underPressure(r);
  assert.deepEqual(await r.shield.status(), { available: true, cores: 2, moved: ['handbrake'] });
  assert.equal(r.shield.movedCount(), 1);
  await r.shield.sync(wish({ on: false }));
  assert.deepEqual((await r.shield.status()).moved, ['handbrake'], 'the game ended, the session has not');
  await r.shield.sync({ session: false, on: false });
  assert.deepEqual((await r.shield.status()).moved, []);
  assert.equal(r.shield.movedCount(), 0);
});

test('the next game starts from nothing', async () => {
  const r = rig();
  r.s.rows.push(row(90, 'blender'));
  r.s.refuse.add(90);
  await underPressure(r, { [GAME]: 8, 30: 3, 90: 3 });
  await tick(r, { [GAME]: 8, 30: 3, 90: 3 }, wish({ foregroundPid: 30 }));
  await r.shield.sync(wish({ on: false }));
  assert.deepEqual(r.s.cleared, [30], 'it was handed back, the rest of the session was this game');
  const asked = r.s.asked.length;

  await tick(r, {});
  await tick(r, FULL);
  assert.equal(r.s.asked.length, asked, 'no held app, no old pressure: one busy read is still one');

  await tick(r, { [GAME]: 8, 30: 3, 90: 3 });
  assert.ok(r.s.asked.includes(90) && r.s.asked.filter((pid) => pid === 90).length === 2, 'who refused is asked again');
  assert.deepEqual(movedPids(r), [30, 30], 'and who was handed back may move again');
});

test('an app that went back stays back, and a new game needs its own busy reads', async () => {
  const r = rig();
  await underPressure(r);
  await r.shield.sync(wish({ on: false }));
  await tick(r, FULL);
  await tick(r, FULL);
  assert.deepEqual(movedPids(r), [30], 'the first read of a game only sets the mark');
  await tick(r, FULL);
  assert.deepEqual(movedPids(r), [30, 30]);
});

test('a server whose own row is missing does nothing, quietly', async () => {
  const r = rig();
  r.s.rows = r.s.rows.filter((p) => p.pid !== OWN);
  await underPressure(r);
  assert.deepEqual(r.s.applied, []);
  assert.deepEqual(r.s.logs, []);
});

test('a table that cannot be read says it is not available', async () => {
  const r = rig();
  r.s.readable = false;
  assert.equal((await r.shield.status()).available, false);
});

test('cores used: only processes in both reads, and a reused pid has no figure', () => {
  const before = [row(1, 'a', { cpuMs: 1000 }), row(2, 'b', { cpuMs: 1000 }), row(3, 'c', { cpuMs: 1000 })];
  const after = [row(1, 'a', { cpuMs: 4000 }), row(2, 'b', { cpuMs: 9000, startedAt: 999 }), row(4, 'd', { cpuMs: 9000 })];
  assert.deepEqual([...coresUsed(before, after, 3000)], [[1, 1]]);
  assert.deepEqual([...coresUsed([row(1, 'a', { cpuMs: 5000 })], [row(1, 'a', { cpuMs: 1000 })], 1000)], [[1, 0]], 'never negative');
});

test('the server runs it on the status tick, and puts things back at start and at shutdown', () => {
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const at = server.indexOf('function broadcastStatusNow');
  assert.ok(at > 0);
  assert.match(server.slice(at, at + 1500), /try \{ syncCoreShield\(\); \} catch \{\}/, 'no timer of its own');
  assert.match(server, /\nperfSession\.shield\.recover\(\);\n/);
  assert.match(server, /shutdownFlush = Promise\.all\(\[shutdownFlush, perfSession\.shield\.stop\(\)\]\)/);
  assert.match(server, /moved: perfSession\.shield\.movedCount\(\)/, 'and a played game says how many apps moved');
});
