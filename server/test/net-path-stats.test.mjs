import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWindow, summarize, median, WINDOW, LOSS_NOW_ECHOES } = require('../net-path/stats.js');

test('median of odd and even lists, null when empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('no echo yet says nothing, it does not say 0', () => {
  assert.deepEqual(summarize([]), { now: null, ms: null, min: null, jitter: null, loss: null, lossNow: null, n: 0 });
});

test('now is the median of the newest answers, so one late echo does not move it', () => {
  const w = createWindow();
  for (const ms of [10, 10, 10, 10, 80]) w.add(ms);
  assert.equal(w.summary().now, 10);
  assert.equal(w.summary().min, 10);
});

test('loss over the window, and over the newest echoes so a burst shows at once', () => {
  const w = createWindow();
  for (let i = 0; i < 20; i += 1) w.add(5);
  for (let i = 0; i < 5; i += 1) w.add(null);
  const s = w.summary();
  assert.equal(s.n, 25);
  assert.equal(s.loss, 20);
  assert.equal(s.lossNow, (5 / LOSS_NOW_ECHOES) * 100);
});

test('jitter is the mean change between answers in a row; a loss breaks the pair', () => {
  const s = summarize([10, 14, null, 20, 18]);
  assert.equal(s.jitter, 3);
  assert.equal(s.ms, 16);
  assert.equal(s.loss, 20);
});

test('the window keeps only the newest echoes', () => {
  const w = createWindow();
  for (let i = 0; i < WINDOW + 5; i += 1) w.add(i < 5 ? null : 7);
  assert.equal(w.count(), WINDOW);
  assert.equal(w.summary().loss, 0);
});

test('an impossible round trip counts as an echo that never came back', () => {
  const w = createWindow();
  for (const v of [-1, NaN, Infinity, undefined]) w.add(v);
  assert.equal(w.summary().loss, 100);
  assert.equal(w.answered(), false);
});
