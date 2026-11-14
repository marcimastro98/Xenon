// What the game detector remembers between two readings of the window in front, and what it
// answers from it: is a game in front, is it still running, which one, what the user is doing.
// Every test loads its own copy of the module, feeds it readings the way the probe does
// (applySample) and moves the clock by hand. No probe is started and no window is read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T0 = Date.parse('2026-07-01T12:00:00Z');
const GAME_PID = 4242;   // a made-up process id; whether it is alive is decided by each test

// A copy of the detector that knows nothing yet. Every module of the server is loaded again,
// so what the detector remembers is new wherever it is kept.
function fresh(t, { alive = () => true } = {}) {
  for (const key of Object.keys(require.cache)) if (!key.includes('node_modules')) delete require.cache[key];
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(signal, 0, 'the detector only ever asks whether a process exists');
    if (alive(pid)) return true;
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  const gd = require('../gamedetect.js');
  const flips = [];
  gd.onGamingChange((gaming) => flips.push(gaming));
  return { gd, flips, later: (ms) => t.mock.timers.tick(ms) };
}
const game = { fullscreen: true, process: 'Starfall.exe', pid: GAME_PID };
const desk = { fullscreen: false, process: 'explorer.exe', pid: 77 };

test('a full-screen window in front is a game, told once, with its name and process id', (t) => {
  const { gd, flips } = fresh(t);
  assert.equal(gd.isGaming(), false, 'nothing read yet');
  gd.applySample(game);
  gd.applySample(game);
  assert.deepEqual(flips, [true]);
  assert.equal(gd.isGaming(), true);
  assert.equal(gd.getGameProcess(), 'starfall');
  assert.equal(gd.getForegroundProcess(), 'starfall');
  assert.equal(gd.getForegroundPid(), GAME_PID);
  assert.equal(gd.getActivity(), 'gaming');
  assert.deepEqual(gd.getGamingWindow(), { process: 'starfall.exe', fullscreen: true, ignored: false });
  assert.deepEqual(gd.getGameDiag(), { gamePid: GAME_PID, gameProc: 'starfall', lastGamingAt: T0, gameSeenAt: T0 });
});

test('a reading that is not an object changes nothing', (t) => {
  const { gd, flips } = fresh(t);
  for (const bad of [null, undefined, 'x', 7]) gd.applySample(bad);
  assert.deepEqual(flips, []);
  assert.equal(gd.getGamingWindow(), null);
});

test('another window in front for a moment does not end the game, four seconds of it do', (t) => {
  const { gd, flips, later } = fresh(t);
  gd.applySample(game);
  later(1000);
  gd.applySample(desk);
  assert.equal(gd.isGaming(), true, 'inside the grace time');
  assert.equal(gd.getGameProcess(), 'starfall', 'the game is still the game, not what took the front');
  assert.equal(gd.getForegroundProcess(), 'explorer');
  later(3500);
  gd.applySample(desk);
  assert.deepEqual(flips, [true, false]);
  assert.equal(gd.isGaming(), false);
  assert.equal(gd.getActivity(), 'other');
});

test('the grace time is cut short when the game process is gone', (t) => {
  let alive = true;
  const { gd, flips, later } = fresh(t, { alive: () => alive });
  gd.applySample(game);
  later(500);
  alive = false;
  gd.applySample(desk);
  assert.deepEqual(flips, [true, false]);
  assert.equal(gd.getGameDiag().lastGamingAt, 0);
});

test('a reading older than six seconds counts for nothing', (t) => {
  const { gd, later } = fresh(t);
  gd.applySample(game);
  later(6001);
  assert.equal(gd.isGaming(), false);
  assert.equal(gd.getForegroundProcess(), '');
  assert.equal(gd.getForegroundPid(), 0);
  assert.equal(gd.getGamingWindow(), null);
  assert.equal(gd.getActivity(), 'other');
});

test('a game out of the front is still running while its process lives, and over after two noes', (t) => {
  let alive = true;
  const { gd, later } = fresh(t, { alive: () => alive });
  gd.applySample(game);
  later(5000);
  gd.applySample(desk);
  assert.equal(gd.isGaming(), false, 'not in front any more');
  assert.equal(gd.isGameRunning(), true, 'but its process is alive');
  assert.equal(gd.getGameDiag().gameSeenAt, T0 + 5000);
  alive = false;
  assert.equal(gd.isGameRunning(), true, 'one no is not enough');
  later(1000);
  assert.equal(gd.isGameRunning(), true, 'nor a second one too soon');
  later(1500);
  assert.equal(gd.isGameRunning(), false);
  assert.equal(gd.getGameProcess(), '');
  assert.equal(gd.getGameDiag().gamePid, 0);
});

test('a process that came back between two noes starts the count again', (t) => {
  let alive = false;
  const { gd, later } = fresh(t, { alive: () => alive });
  gd.applySample(game);
  later(5000);
  gd.applySample(desk);
  assert.equal(gd.isGameRunning(), true, 'first no');
  alive = true;
  later(3000);
  assert.equal(gd.isGameRunning(), true);
  alive = false;
  assert.equal(gd.isGameRunning(), true, 'a first no again, not the second');
});

test('a window that is not full-screen is a game only when the frame reader names the same program at game speed', (t) => {
  const windowed = { fullscreen: false, process: 'starfall.exe', pid: GAME_PID };
  const cases = [
    [{ name: 'Starfall.exe', fps: 60 }, true],
    [{ name: 'Starfall.exe', fps: 23 }, false],
    [{ name: 'other.exe', fps: 144 }, false],
    [{ name: 'Starfall.exe', fps: Number.NaN }, false],
    [null, false],
  ];
  for (const [hint, expected] of cases) {
    const { gd } = fresh(t);
    gd.setGameHint(() => hint);
    gd.applySample(windowed);
    assert.equal(gd.isGaming(), expected, JSON.stringify(hint));
    t.mock.timers.reset();
    t.mock.restoreAll();
  }
  const { gd } = fresh(t);
  gd.setGameHint(() => { throw new Error('reader not ready'); });
  gd.applySample(windowed);
  assert.equal(gd.isGaming(), false, 'a frame reader that throws is no proof of a game');
});

test('a program on the user\'s own list is not a game, and stops being one the moment it is listed', (t) => {
  const { gd, later } = fresh(t);
  let list = [];
  gd.setIgnoreSource(() => list);
  gd.applySample(game);
  assert.equal(gd.isGaming(), true);
  later(100);
  list = ['Starfall.exe'];
  assert.equal(gd.isGaming(), false, 'no grace time for a program the user ruled out');
  assert.deepEqual(gd.getGameDiag(), { gamePid: 0, gameProc: '', lastGamingAt: 0, gameSeenAt: T0 });
  assert.equal(gd.getGamingWindow().ignored, true);
  gd.setIgnoreSource(null);
});

test('with no game in front the program in front says what the user is doing', (t) => {
  const { gd } = fresh(t);
  gd.applySample({ fullscreen: false, process: 'Code.exe', pid: 5 });
  assert.equal(gd.getActivity(), 'coding');
  gd.applySample({ fullscreen: false, process: 'winword.exe', pid: 6 });
  assert.equal(gd.getActivity(), 'writing');
  gd.applySample(desk);
  assert.equal(gd.getActivity(), 'other');
});

test('a callback that throws does not break the reading, and none at all is fine', (t) => {
  const { gd } = fresh(t);
  gd.onGamingChange(() => { throw new Error('listener broke'); });
  gd.applySample(game);
  assert.equal(gd.isGaming(), true);
  gd.onGamingChange(null);
  gd.applySample(desk);
});
