// Frame-time statistics: average, 1% and 0.1% lows, p99. The definitions are
// CapFrameX's, so the expected values below are worked out by hand from them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { frameStats, toFrameTimes, createFrameRing, createFrameHistogram, MIN_FRAMES_LOW1, MIN_FRAMES_LOW01 } = require('../frame-stats.js');
const { entryStats, entryWindow, entryFramesSince, entryForGame } = require('../fpsmon.js');

const frames = (n, ms) => Array.from({ length: n }, () => ms);

test('steady 10 ms frames read as 100 fps everywhere', () => {
  const s = frameStats(frames(1000, 10));
  assert.equal(s.count, 1000);
  assert.equal(s.avgFps, 100);
  assert.equal(s.low1Fps, 100);
  assert.equal(s.low01Fps, 100);
  assert.equal(s.p99Ms, 10);
  assert.equal(s.maxMs, 10);
});

test('the average is frames over time, not the mean of per-frame rates', () => {
  // One 1 ms frame and one 19 ms frame: 2 frames in 20 ms = 100 fps. The mean
  // of the per-frame rates would say (1000 + 52.6) / 2 = 526.
  assert.equal(frameStats([1, 19]).avgFps, 100);
});

test('the 1% low is the mean rate of the slowest 1% of frames', () => {
  // 1000 frames: 990 at 10 ms, 10 at 40 ms. The slowest 1% is exactly the ten
  // 40 ms frames → 25 fps; the slowest 0.1% is one of them → 25 fps.
  const s = frameStats([...frames(990, 10), ...frames(10, 40)]);
  assert.equal(s.low1Fps, 25);
  assert.equal(s.low01Fps, 25);
  assert.equal(s.maxMs, 40);
  // avg: 1000 frames in 9900 + 400 ms
  assert.equal(s.avgFps, Math.round(1000 * 1000 / 10300 * 10) / 10);
});

test('a single hitch weighs ten times more on the 0.1% low than on the 1% low', () => {
  // 2000 frames: the 0.1% tail is 2 frames (100 + 10 ms), the 1% tail is 20
  // (100 + 19 × 10 ms).
  const s = frameStats([...frames(1999, 10), 100]);
  assert.equal(s.low01Fps, Math.round(1000 / (110 / 2) * 10) / 10);
  assert.equal(s.low1Fps, Math.round(1000 / (290 / 20) * 10) / 10);
});

test('a low is withheld until the window holds a whole frame of its tail', () => {
  const short = frameStats(frames(MIN_FRAMES_LOW1 - 1, 10));
  assert.equal(short.low1Fps, null);
  assert.equal(short.low01Fps, null);
  const mid = frameStats(frames(MIN_FRAMES_LOW01 - 1, 10));
  assert.equal(mid.low1Fps, 100);
  assert.equal(mid.low01Fps, null);
});

test('pauses, zeros and garbage are not frames', () => {
  assert.equal(frameStats([]), null);
  assert.equal(frameStats(null), null);
  assert.equal(frameStats([0, -5, NaN, 5000]), null);
  assert.equal(frameStats([10, 0, 5000, 10]).count, 2);
});

test('FPS-column captures are converted to frame times', () => {
  assert.deepEqual(toFrameTimes([100, 50], true), [10, 20]);
  const same = [10, 20];
  assert.equal(toFrameTimes(same, false), same);
});

test('the ring keeps the most recent values in order', () => {
  const r = createFrameRing(3);
  assert.deepEqual(r.toArray(), []);
  [1, 2].forEach(v => r.push(v));
  assert.deepEqual(r.toArray(), [1, 2]);
  [3, 4, 5].forEach(v => r.push(v));
  assert.deepEqual(r.toArray(), [3, 4, 5]);
  assert.equal(r.size(), 3);
});

test('fpsmon reports the display side when the capture has it', () => {
  const entry = { usesFps: false, presentRing: createFrameRing(10), displayRing: createFrameRing(10) };
  [5, 5, 5].forEach(v => entry.presentRing.push(v));
  assert.equal(entryStats(entry).side, 'present');
  assert.equal(entryStats(entry).avgFps, 200);
  [10, 10].forEach(v => entry.displayRing.push(v));
  assert.equal(entryStats(entry).side, 'display');
  assert.equal(entryStats(entry).avgFps, 100);
});

test('fpsmon has no stats for an entry it never measured', () => {
  assert.equal(entryStats(null), null);
  assert.equal(entryStats({ samples: [10] }), null);
});

test('the ring hands back its newest values, oldest first, across the wrap', () => {
  const r = createFrameRing(4);
  assert.deepEqual(r.last(3), []);
  [1, 2, 3, 4, 5, 6].forEach(v => r.push(v));
  assert.deepEqual(r.last(2), [5, 6]);
  assert.deepEqual(r.last(4), [3, 4, 5, 6]);
  assert.deepEqual(r.last(99), [3, 4, 5, 6], 'never more than it holds');
  assert.deepEqual(r.last(0), []);
  assert.deepEqual(r.last('x'), []);
});

test("the tile's graph window reads the same side the stats do", () => {
  const entry = { usesFps: true, presentRing: createFrameRing(10), displayRing: createFrameRing(10) };
  assert.equal(entryWindow(entry, 5), null, 'nothing measured yet');
  [100, 50, 0, 200].forEach(v => entry.presentRing.push(v));
  // fps rows become frame times; a zero row is not a frame.
  assert.deepEqual(entryWindow(entry, 5), { side: 'present', frames: [10, 20, 5] });
  [8, 9].forEach(v => entry.displayRing.push(v));
  assert.deepEqual(entryWindow(entry, 1), { side: 'display', frames: [9] });
  assert.equal(entryWindow(null, 5), null);
});

test('a session histogram gives the same numbers as the exact list', () => {
  // A realistic mix: steady 7 ms frames, a band of slower ones, a few hitches.
  const frames = [];
  for (let i = 0; i < 20000; i++) frames.push(6.9 + (i % 7) * 0.05);
  for (let i = 0; i < 300; i++) frames.push(14 + (i % 30) * 0.13);
  for (let i = 0; i < 25; i++) frames.push(40 + i * 9);
  frames.push(0, -1, NaN, 5000);
  const h = createFrameHistogram();
  for (let i = 0; i < frames.length; i += 997) h.add(frames.slice(i, i + 997));
  const exact = frameStats(frames);
  const got = h.stats();
  assert.equal(got.count, exact.count);
  assert.equal(got.avgFps, exact.avgFps);
  assert.ok(Math.abs(got.low1Fps - exact.low1Fps) <= 0.2, got.low1Fps + ' vs ' + exact.low1Fps);
  assert.ok(Math.abs(got.low01Fps - exact.low01Fps) <= 0.2, got.low01Fps + ' vs ' + exact.low01Fps);
});

test('a short session histogram withholds the lows like the live stats', () => {
  const h = createFrameHistogram();
  assert.equal(h.stats(), null);
  h.add(new Array(MIN_FRAMES_LOW1 - 1).fill(10));
  assert.equal(h.stats().low1Fps, null);
  h.add([10]);
  assert.equal(h.stats().low1Fps, 100);
  assert.equal(h.stats().low01Fps, null);
  h.add('junk');
  assert.equal(h.count(), MIN_FRAMES_LOW1);
});

test('the ring counts every push, so a reader can take only what is new', () => {
  const r = createFrameRing(3);
  [1, 2, 3, 4, 5].forEach(v => r.push(v));
  assert.equal(r.total(), 5);
  assert.equal(r.size(), 3);
});

test('a game session reads each frame once, and starts over on a new entry', () => {
  const entry = { usesFps: false, presentRing: createFrameRing(10), displayRing: createFrameRing(10) };
  [5, 6].forEach(v => entry.presentRing.push(v));
  let r = entryFramesSince(entry, null);
  assert.deepEqual(r.frames, [], 'the first read only sets the mark');
  [7, 8].forEach(v => entry.presentRing.push(v));
  r = entryFramesSince(entry, r.mark);
  assert.deepEqual(r.frames, [7, 8]);
  r = entryFramesSince(entry, r.mark);
  assert.deepEqual(r.frames, [], 'nothing new');
  entry.displayRing.push(9);
  r = entryFramesSince(entry, r.mark);
  assert.deepEqual(r.frames, [], 'the side changed: not comparable, start over');
  entry.displayRing.push(10);
  assert.deepEqual(entryFramesSince(entry, r.mark).frames, [10]);
  const other = { usesFps: false, presentRing: createFrameRing(10), displayRing: createFrameRing(10) };
  other.presentRing.push(3);
  assert.deepEqual(entryFramesSince(other, r.mark).frames, [], 'another process (the game restarted)');
  assert.deepEqual(entryFramesSince(null, r.mark), { mark: null, frames: [] });
});

test('the session follows its game by name, not the foreground window', () => {
  const map = new Map([
    [1, { name: 'Overlay.exe', lastSeen: 50 }],
    [2, { name: 'Game.exe', lastSeen: 10 }],
    [3, { name: 'game.exe', lastSeen: 20 }],
  ]);
  assert.equal(entryForGame(map, 'game'), map.get(3), 'the most recent presenter of that name');
  assert.equal(entryForGame(map, 'GAME.EXE'), map.get(3));
  assert.equal(entryForGame(map, ''), null);
  assert.equal(entryForGame(map, 'other'), null);
});
