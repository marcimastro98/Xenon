// timer-actions.js: "metti in pausa il timer della pasta", "riprendi",
// "fai partire un cronometro". Pinned here: one set of rules for the tile and
// Bit, the timer found by its label (accents and case ignored) or guessed only
// when it is clear, and the server wiring both paths to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ACTIONS, applyTimerAction, findTimer } = require('../timer-actions.js');

const run = (over) => ({ id: 'a', label: 'Pasta', kind: 'countdown', durationSecs: 600, status: 'running', startedAt: 1000, pausedElapsed: 0, chimes: 0, ...over });

test('pause holds, resume counts on, reset restarts, stop holds at the start', () => {
  const paused = applyTimerAction(run(), 'pause', 31000);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.pausedElapsed, 30);
  const resumed = applyTimerAction(paused, 'resume', 90000);
  assert.deepEqual([resumed.status, resumed.startedAt, resumed.pausedElapsed], ['running', 90000, 30]);
  const reset = applyTimerAction(run({ pausedElapsed: 40, chimes: 3 }), 'reset', 5000);
  assert.deepEqual([reset.status, reset.startedAt, reset.pausedElapsed, reset.chimes], ['running', 5000, 0, 0]);
  const stopped = applyTimerAction(run({ pausedElapsed: 40 }), 'stop', 5000);
  assert.deepEqual([stopped.status, stopped.pausedElapsed], ['paused', 0]);
  assert.deepEqual(ACTIONS, ['pause', 'resume', 'reset', 'stop']);
});

test('an action that does nothing in this state says so, and never changes the input', () => {
  const t = run();
  assert.equal(applyTimerAction(t, 'resume', 2000), null);
  assert.equal(applyTimerAction(run({ status: 'paused' }), 'pause', 2000), null);
  assert.equal(applyTimerAction(t, 'explode', 2000), null);
  applyTimerAction(t, 'pause', 9000);
  assert.equal(t.status, 'running');
});

test('the timer is found by label or id; guessed only when it is clear', () => {
  const timers = [run(), run({ id: 'b', label: 'Caffè', status: 'paused' }), run({ id: 'c', label: 'Stretching', kind: 'stopwatch', status: 'running' })];
  assert.equal(findTimer(timers, 'CAFFE').id, 'b');
  assert.equal(findTimer(timers, 'stretch').id, 'c');
  assert.equal(findTimer(timers, 'b').id, 'b');
  assert.equal(findTimer(timers, 'tea'), null);
  assert.equal(findTimer(timers, '', 'resume').id, 'b', 'the only paused one');
  assert.equal(findTimer(timers, '', 'pause').id, 'c', 'the newest running one');
  assert.equal(findTimer(timers, '', 'reset'), null, 'unclear: Bit asks');
  assert.equal(findTimer([run()], '', 'stop').id, 'a', 'the only one');
  assert.equal(findTimer([], '', 'pause'), null);
});

test('the server wires the tile and Bit to the same rules; stopwatch from Bit', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /TimerActions\.applyTimerAction\(_timers\[idx\], action, Date\.now\(\)\)/, 'PATCH /api/timers/:id');
  assert.match(src, /name: 'control_timer'/);
  assert.match(src, /fnName === 'control_timer'[\s\S]{0,400}TimerActions\.findTimer[\s\S]{0,1200}refresh_timers/);
  assert.match(src, /fnName === 'start_timer'[\s\S]{0,900}kind: 'stopwatch', intervalSecs/);
});
