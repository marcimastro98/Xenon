// Disk history (disk-history.js): what grew, and when the drive fills up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const H = require(join(ROOT, 'disk-history.js'));

const GB = 1024 ** 3;
const DAY = H.DAY_MS;
const T0 = new Date(2026, 8, 1, 12, 0, 0).getTime();

const snap = (used, folders) => ({
  root: 'C:\\', capacity: 1000 * GB, used,
  tree: [{ p: 'C:\\', s: used }, ...Object.entries(folders).map(([p, s]) => ({ p, s }))],
});

test('one point per day: a second record on the same day replaces the first', () => {
  let h = H.normalize(null);
  h = H.record(h, 'c:', snap(100 * GB, {}), T0);
  h = H.record(h, 'c:', snap(110 * GB, {}), T0 + 3600000);
  assert.equal(h.roots['c:'].length, 1);
  assert.equal(h.roots['c:'][0].used, 110 * GB);
  h = H.record(h, 'c:', snap(120 * GB, {}), T0 + DAY);
  assert.equal(h.roots['c:'].length, 2);
  assert.ok(!h.roots['c:'][0].f.some(([p]) => p === 'C:\\'), 'the root itself is not one of its folders');
});

test('history is bounded to 90 days and survives a round trip through JSON', () => {
  let h = H.normalize(null);
  for (let i = 0; i < 120; i++) h = H.record(h, 'c:', snap(100 * GB + i, { 'C:\\A': i }), T0 + i * DAY);
  assert.equal(h.roots['c:'].length, 90);
  const back = H.normalize(JSON.parse(JSON.stringify(h)));
  assert.deepEqual(back, h);
  assert.deepEqual(H.normalize({ v: 2 }), { v: 1, roots: {} });
  assert.deepEqual(H.normalize({ v: 1, roots: { x: [{ d: 'bad', at: 1 }] } }).roots.x, []);
});

test('growth names the deepest folder that explains it, and ignores folders it cannot compare', () => {
  let h = H.normalize(null);
  h = H.record(h, 'c:', snap(300 * GB, {
    'C:\\Users': 100 * GB, 'C:\\Users\\u\\Downloads': 10 * GB, 'C:\\Games': 50 * GB,
  }), T0);
  h = H.record(h, 'c:', snap(325 * GB, {
    'C:\\Users': 112 * GB, 'C:\\Users\\u\\Downloads': 21 * GB, 'C:\\Games': 52 * GB,
    'C:\\New': 9 * GB, // absent from the older point: below its cut, not empty
  }), T0 + 7 * DAY);
  const g = H.growth(h.roots['c:'], T0 + 7 * DAY, 7);
  assert.equal(g.days, 7);
  assert.equal(g.usedDelta, 25 * GB);
  assert.deepEqual(g.folders.map((f) => f.p), ['C:\\Users\\u\\Downloads', 'C:\\Games']);
  assert.equal(g.folders[0].delta, 11 * GB);
});

test('growth needs two points at least two days apart', () => {
  let h = H.normalize(null);
  h = H.record(h, 'c:', snap(100 * GB, { 'C:\\A': GB }), T0);
  assert.equal(H.growth(h.roots['c:'], T0, 7), null);
  h = H.record(h, 'c:', snap(100 * GB, { 'C:\\A': 5 * GB }), T0 + DAY);
  assert.equal(H.growth(h.roots['c:'], T0 + DAY, 7), null);
});

test('forecast: a steady fill gives a date, noise or a flat line does not', () => {
  const pts = (fn) => {
    let h = H.normalize(null);
    for (let i = 0; i <= 20; i++) h = H.record(h, 'c:', snap(fn(i), {}), T0 + i * DAY);
    return h.roots['c:'];
  };
  const now = T0 + 20 * DAY;
  const filling = H.forecast(pts((i) => 500 * GB + i * 10 * GB), now);
  assert.equal(filling.state, 'filling');
  assert.equal(filling.daysToFull, 30, '300 GB left at 10 GB a day');
  assert.equal(H.forecast(pts(() => 500 * GB), now).state, 'stable');
  const noisy = H.forecast(pts((i) => 500 * GB + (i % 2 ? 40 : -40) * GB + i * GB * 0.2), now);
  assert.equal(noisy.state, 'stable', 'no clear trend is not a prediction');
  assert.equal(H.forecast(pts((i) => 500 * GB + i * GB).slice(-3), now).state, 'unknown', 'too few points');
});
