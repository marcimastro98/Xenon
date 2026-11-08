// A game Windows composes (a widget above it, the focus elsewhere) reaches the
// display-tracking session as a handful of rows: measured 14 rows in 8 s on a
// game running 240 fps, while a session without display tracking saw all 1667.
// These pin the second session that counts such a game.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createGameSession, LINGER_MS, FAIL_BACKOFF_MS, FAST_EXIT_MS, LIVE_MS } = require('../fps-game-session.js');
const { createFrameRing } = require('../frame-stats.js');

function rig() {
  const procs = [];
  const chunks = [];
  const logs = [];
  const state = { t: 1000, stopped: 0 };
  const session = createGameSession({
    log: (line) => logs.push(line),
    launch(pid) {
      const p = new EventEmitter();
      p.pid = pid;
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      p.killed = false;
      p.kill = () => { p.killed = true; };
      procs.push(p);
      return p;
    },
    onChunk: (text, fresh) => chunks.push({ text, fresh }),
    stopTrace: () => { state.stopped++; },
    now: () => state.t,
  });
  return { session, procs, chunks, state, logs };
}

test('asking for a game starts one session, however many rows ask', () => {
  const { session, procs } = rig();
  session.want('42');
  session.want('42');
  assert.equal(procs.length, 1);
  assert.equal(procs[0].pid, '42');
});

test('a name instead of a pid starts nothing: PresentMon only takes a number', () => {
  const { session, procs } = rig();
  session.want('game.exe');
  session.want('');
  assert.equal(procs.length, 0);
});

test('it owns the game only while its frames arrive', () => {
  const { session, procs, state } = rig();
  session.want('42');
  assert.equal(session.owns('42'), false, 'no frames yet: the main session still counts');
  procs[0].stdout.emit('data', Buffer.from('row\n'));
  assert.equal(session.owns('42'), true);
  assert.equal(session.owns('43'), false);
  state.t += LIVE_MS + 1;
  assert.equal(session.owns('42'), false, 'a game that went quiet goes back to the main session');
});

test('each process starts its reader afresh', () => {
  const { session, procs, chunks } = rig();
  session.want('42');
  procs[0].stdout.emit('data', Buffer.from('a'));
  procs[0].stdout.emit('data', Buffer.from('b'));
  session.stop();
  session.want('42');
  procs[1].stdout.emit('data', Buffer.from('c'));
  assert.deepEqual(chunks.map((c) => c.fresh), [true, false, true]);
});

test('it stops once nothing has asked for a while', () => {
  const { session, procs, state } = rig();
  session.want('42');
  state.t += LINGER_MS - 1;
  session.tick();
  assert.equal(procs[0].killed, false, 'a few quiet seconds must not start and stop a trace');
  state.t += 2;
  session.tick();
  assert.equal(procs[0].killed, true);
  assert.equal(state.stopped, 1, 'a killed PresentMon leaves its trace running');
});

test('another game replaces the old session', () => {
  const { session, procs, state } = rig();
  session.want('42');
  session.want('43');
  assert.equal(procs[0].killed, true);
  assert.equal(state.stopped, 1);
  assert.equal(procs.length, 2);
  assert.equal(procs[1].pid, '43');
});

test('a late close of a replaced process changes nothing', () => {
  const { session, procs, chunks } = rig();
  session.want('42');
  session.want('43');
  procs[0].stdout.emit('data', Buffer.from('old'));
  procs[0].emit('close');
  assert.equal(chunks.length, 0, 'only the current process may feed the reader');
  procs[1].stdout.emit('data', Buffer.from('new'));
  assert.equal(session.owns('43'), true);
});

test('a process that dies at once is not relaunched on the next row', () => {
  const { session, procs, state } = rig();
  session.want('42');
  state.t += FAST_EXIT_MS - 1;
  procs[0].emit('close');
  session.want('42');
  assert.equal(procs.length, 1, 'without admin rights this would spin');
  state.t += FAIL_BACKOFF_MS + 1;
  session.want('42');
  assert.equal(procs.length, 2);
});

test('a game that closed after a real run can be followed again at once', () => {
  const { session, procs, state } = rig();
  session.want('42');
  state.t += FAST_EXIT_MS + 1;
  procs[0].emit('close');
  session.want('43');
  assert.equal(procs.length, 2);
});

test('a launch that throws is a failed start, not a crash', () => {
  const state = { t: 0, launches: 0 };
  const logs = [];
  const session = createGameSession({
    launch() { state.launches++; throw new Error('no exe'); },
    onChunk() {}, stopTrace() {}, now: () => state.t, log: (line) => logs.push(line),
  });
  session.want('42');
  session.want('42');
  assert.equal(state.launches, 1);
  assert.equal(session.owns('42'), false);
  assert.deepEqual(logs, ["fps: the game's frame reader did not start (no exe)"]);
});

test('an end it did not ask for is written down, a stop it asked for is not', () => {
  const { session, procs, state, logs } = rig();
  session.want('42');
  session.stop();
  procs[0].emit('close', 1, null);
  assert.deepEqual(logs, [], 'stopped on purpose');
  session.want('42');
  state.t += 90_000;
  procs[1].emit('close', 0, null);
  assert.deepEqual(logs, ["fps: the game's frame reader ended after 90 s (code 0)"]);
});

test('a reader that keeps failing writes one line a minute at most', () => {
  const { session, procs, state, logs } = rig();
  for (let i = 0; i < 5; i += 1) {
    session.want('42');
    state.t += FAST_EXIT_MS + 1;
    procs[procs.length - 1].emit('close', 1, null);
  }
  assert.equal(procs.length, 5);
  assert.equal(logs.length, 1);
  state.t += 60_000;
  session.want('42');
  procs[procs.length - 1].emit('close', 1, null);
  assert.equal(logs.length, 2);
});

test('stop on a session that never ran leaves no trace call', () => {
  const { session, state } = rig();
  session.stop();
  assert.equal(state.stopped, 0);
});

test('a cleared ring forgets its frames but not how many it has seen', () => {
  const ring = createFrameRing(4);
  ring.push(1); ring.push(2);
  ring.clear();
  assert.equal(ring.size(), 0);
  assert.equal(ring.total(), 2, 'a reader by mark must not see the count go backwards');
  assert.deepEqual(ring.last(4), []);
  ring.push(3);
  assert.deepEqual(ring.last(4), [3]);
});

test("the reader's end says why PresentMon would not start", () => {
  const { session, procs, logs } = rig();
  session.want('42');
  procs[0].stderr.emit('data', Buffer.from('warning: a trace session named "XenonFpsGame" is already running and it will be stopped.\n'));
  procs[0].stderr.emit('data', Buffer.from('error: failed to start trace session (access denied).\n'));
  procs[0].emit('close', 6, null);
  assert.deepEqual(logs, ["fps: the game's frame reader ended after 0 s (code 6, error: failed to start trace session (access denied).)"]);
});
