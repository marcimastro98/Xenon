import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// The shared playback clock in js/media.js (mediaClockStep) drives the lyrics.
// Its inputs are host samples in whole seconds that trail the real position by
// up to ~2 s in a sawtooth (measured with Spotify on Windows). The clock must
// follow the freshest of them, never step backwards on lag, and still catch a
// real seek. The block is pure, so it runs alone in a vm.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'js', 'media.js'), 'utf8');
const start = SRC.indexOf('const MEDIA_CLOCK_WINDOW');
const end = SRC.indexOf('function syncMediaClock');
assert.ok(start > 0 && end > start, 'clock block found in media.js');
const ctx = {};
vm.runInNewContext(SRC.slice(start, end) + '\nthis.step = mediaClockStep; this.at = mediaClockAt; this.blank = _mediaClock;', ctx);

const sample = (posMs, extra = {}) => ({ src: {}, key: 'song|artist', posMs, durMs: 300000, playing: true, ...extra });

// Real position = t. The host refreshes every 2 s with a value up to 0.7 s old,
// rounded to whole seconds, and the poll lands anywhere in between.
function laggySample(t) {
  const refreshedAt = Math.floor(t / 2000) * 2000;
  const stale = refreshedAt - 700 * ((refreshedAt / 2000) % 2);
  return Math.round(stale / 1000) * 1000;
}

test('a lagging sawtooth never moves the clock backwards or changes its epoch', () => {
  let clock = ctx.step(ctx.blank, sample(10000), 10000);
  const epoch = clock.epoch;
  let prev = ctx.at(clock, 10000);
  for (let t = 11000; t < 60000; t += 1100) {
    clock = ctx.step(clock, sample(laggySample(t)), t);
    const now = ctx.at(clock, t);
    assert.ok(now >= prev - 1, `clock went back at ${t}: ${prev} -> ${now}`);
    assert.equal(clock.epoch, epoch, `epoch changed at ${t}`);
    prev = now;
  }
  // It sits on the freshest samples, so within a second of the real position.
  assert.ok(Math.abs(prev - 59500) < 1500, `clock ${prev} far from real position`);
});

test('a seek back past the worst lag re-anchors and starts a new epoch', () => {
  let clock = ctx.step(ctx.blank, sample(50000), 50000);
  clock = ctx.step(clock, sample(51000), 51000);
  const before = clock.epoch;
  clock = ctx.step(clock, sample(20000), 52000);
  assert.equal(ctx.at(clock, 52000), 20000);
  assert.equal(clock.epoch, before + 1);
});

test('a seek forward lifts the clock at once and starts a new epoch', () => {
  let clock = ctx.step(ctx.blank, sample(20000), 20000);
  const before = clock.epoch;
  clock = ctx.step(clock, sample(90000), 21000);
  assert.equal(ctx.at(clock, 21000), 90000);
  assert.equal(clock.epoch, before + 1);
});

test('pause freezes the clock; a new track or resume is a new epoch', () => {
  let clock = ctx.step(ctx.blank, sample(30000), 30000);
  const e0 = clock.epoch;
  clock = ctx.step(clock, sample(31000, { playing: false }), 31000);
  assert.equal(clock.epoch, e0 + 1);
  assert.equal(ctx.at(clock, 40000), 31000);
  clock = ctx.step(clock, sample(31000), 41000);
  assert.equal(clock.epoch, e0 + 2);
  clock = ctx.step(clock, sample(0, { key: 'other|artist' }), 42000);
  assert.equal(clock.epoch, e0 + 3);
  assert.equal(ctx.at(clock, 42000), 0);
});

test('right after our own seek, a sample still at the old spot is ignored', () => {
  let clock = ctx.step(ctx.blank, sample(80000), 80000);
  clock = { ...clock, posMs: 20000, at: 81000, leads: [], epoch: clock.epoch + 1, holdUntil: 81000 + 2500 };
  const held = ctx.step(clock, sample(81000), 82000);
  assert.equal(ctx.at(held, 82000), 21000);
  const landed = ctx.step(held, sample(22000), 83000);
  assert.ok(Math.abs(ctx.at(landed, 83000) - 22000) < 1);
});
