// stutter-why.js: the local rules behind "why does it stutter?". Pinned here:
// each cause fires on its reading and only then, the most decisive one wins,
// a capped frame rate is not called a problem, nothing is guessed when every
// reading is normal, and the tile's line needs two ticks in a row to change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { diagnose, hitchesOf, capOf, createStutterWatch, REASONS, SENTENCES } = require('../stutter-why.js');

// 600 frames at `ms`, with `spikes` frames of `spikeMs` spread through them.
function frames(ms, spikes = 0, spikeMs = 80) {
  const out = Array(600).fill(ms);
  for (let i = 0; i < spikes; i++) out[Math.floor((i + 0.5) * (600 / spikes))] = spikeMs;
  return out;
}
const statsOf = (avgFps, low1Fps, p99Ms, extra = {}) => ({ avgFps, low1Fps, low01Fps: low1Fps, p99Ms, count: 600, process: 'game.exe', ...extra });
const quiet = { gpu: 70, cpu: 30, cpuMaxCore: 50, vramUsed: 4000, vramTotal: 12000, memory: { percent: 50 }, gpuTemp: 60, cpuTemp: 60 };
const sample = (over) => ({ ...quiet, ...over });

test('a steady game without spikes is smooth', () => {
  const r = diagnose({ stats: statsOf(110, 95, 10), frames: frames(9), samples: [quiet] });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'smooth');
  assert.equal(r.reason, 'smooth');
  assert.equal(r.process, 'game.exe');
  assert.equal(typeof r.summary, 'string');
});

test('a frame rate pinned to a common limit is capped, also when it is low', () => {
  const r = diagnose({ stats: statsOf(59.8, 57, 17.5), frames: frames(16.7), samples: [quiet] });
  assert.equal(r.verdict, 'smooth');
  assert.equal(r.reason, 'capped');
  assert.equal(r.cap, 60);
  assert.match(r.summary, /60 FPS/);
  const thirty = diagnose({ stats: statsOf(30, 29, 34), frames: frames(33.3), samples: [quiet] });
  assert.equal(thirty.reason, 'capped');
  // Uneven frame times at 60 are not a cap.
  assert.equal(capOf(60, 30), null);
  assert.equal(capOf(87, 12), null);
});

test('spikes make a stutter; with every reading normal the answer is loading, not a guess', () => {
  const r = diagnose({ stats: statsOf(100, 70, 12), frames: frames(10, 6), samples: [quiet] });
  assert.equal(r.verdict, 'stutter');
  assert.equal(r.reason, 'loading');
  assert.equal(r.hitches, 6);
  // One spike in the window is not a stutter.
  assert.equal(diagnose({ stats: statsOf(100, 90, 11), frames: frames(10, 1), samples: [quiet] }).verdict, 'smooth');
});

test('a 1% low under half the average is a stutter even without big spikes', () => {
  const r = diagnose({ stats: statsOf(120, 50, 20), frames: frames(8), samples: [quiet] });
  assert.equal(r.verdict, 'stutter');
});

test('full video memory comes before everything else', () => {
  const s = [sample({ vramUsed: 11800, vramTotal: 12000, memory: { percent: 95 }, gpuTemp: 90 })];
  const r = diagnose({ stats: statsOf(100, 70, 12), frames: frames(10, 6), samples: s });
  assert.equal(r.reason, 'vram_full');
  assert.deepEqual(r.also, ['ram_full', 'gpu_hot']);
  assert.equal(r.vramPct, 98);
});

test('heat, one reading at a time', () => {
  const st = statsOf(100, 70, 12);
  const f = frames(10, 6);
  assert.equal(diagnose({ stats: st, frames: f, samples: [sample({ gpuTemp: 88 })] }).reason, 'gpu_hot');
  assert.equal(diagnose({ stats: st, frames: f, samples: [sample({ cpuTemp: 96 })] }).reason, 'cpu_hot');
  assert.equal(diagnose({ stats: st, frames: f, samples: [sample({ cpuTemp: 94 })] }).reason, 'loading');
  // The peak of the last minute counts, not the latest reading.
  assert.equal(diagnose({ stats: st, frames: f, samples: [sample({ gpuTemp: 89 }), quiet] }).reason, 'gpu_hot');
});

test('a low frame rate says which part holds it back', () => {
  const st = statsOf(42, 35, 28);
  const f = frames(25);
  assert.equal(diagnose({ stats: st, frames: f, samples: [sample({ gpu: 98 })] }).reason, 'gpu_bound');
  assert.equal(diagnose({ stats: st, frames: f, samples: [sample({ gpu: 55 })] }).reason, 'cpu_bound');
  const none = diagnose({ stats: st, frames: f, samples: [sample({ gpu: null })] });
  assert.equal(none.verdict, 'low');
  assert.equal(none.reason, 'no_gpu_reading');
  // Between "waiting" and "busy" neither part is named.
  assert.equal(diagnose({ stats: st, frames: f, samples: [sample({ gpu: 82 })] }).reason, 'mixed');
  assert.equal(diagnose({ stats: st, frames: f, samples: [sample({ gpu: 86 })] }).reason, 'gpu_bound');
});

test('a stutter with the GPU waiting and one core pegged points at the processor', () => {
  const r = diagnose({ stats: statsOf(100, 70, 12), frames: frames(10, 6), samples: [sample({ gpu: 50, cpuMaxCore: 96 })] });
  assert.equal(r.reason, 'cpu_bound');
  // A smooth game is never told its processor is the limit.
  const smooth = diagnose({ stats: statsOf(110, 95, 10), frames: frames(9), samples: [sample({ gpu: 50, cpuMaxCore: 96 })] });
  assert.equal(smooth.reason, 'smooth');
  assert.deepEqual(smooth.also, []);
});

test('no game and too few frames are errors, not answers', () => {
  assert.deepEqual(diagnose({}), { ok: false, error: 'no_frames' });
  assert.deepEqual(diagnose({ stats: statsOf(100, 90, 11), frames: Array(50).fill(10) }), { ok: false, error: 'too_soon' });
  assert.deepEqual(diagnose({ stats: statsOf(100, 90, 11, { count: 60 }), frames: frames(10) }), { ok: false, error: 'too_soon' });
});

test('bad readings are ignored instead of failing the answer', () => {
  const r = diagnose({ stats: statsOf(110, 95, 10), frames: [...frames(9), NaN, -1, 'x'], samples: [null, 'x', { gpu: 'abc', memory: null }] });
  assert.equal(r.ok, true);
  assert.equal(r.gpu, null);
  assert.equal(hitchesOf([]).count, 0);
});

test('every reason has its sentence, every placeholder is filled', () => {
  for (const id of REASONS) assert.ok(SENTENCES[id], id);
  const r = diagnose({ stats: statsOf(42, 35, 28), frames: frames(25), samples: [sample({ gpu: 98 })] });
  assert.doesNotMatch(r.summary, /\{|\?/);
  assert.match(r.summary, /98%/);
});

test('the watch: two ticks in a row before the line changes, another game starts over', async () => {
  let st = statsOf(100, 70, 12);
  let f = frames(10, 6);
  const fps = { getFrameStats: () => st, getFrameWindow: () => ({ frames: f }) };
  const w = createStutterWatch({ fps });
  w.onSystem(sample({ vramUsed: 11900, vramTotal: 12000 }), 'game');
  assert.equal(w.current(), null);
  w.onSystem(quiet, 'game');
  assert.deepEqual(w.current(), { verdict: 'stutter', reason: 'vram_full' });
  // One different tick does not change the line; the second does.
  st = statsOf(110, 95, 10); f = frames(9);
  w.onSystem(quiet, 'game');
  assert.deepEqual(w.current(), { verdict: 'stutter', reason: 'vram_full' });
  w.onSystem(quiet, 'game');
  assert.equal(w.current().verdict, 'smooth');
  // Another game: the first one's readings are gone.
  w.onSystem(quiet, 'other');
  assert.equal(w.current(), null);
  w.onSystem(quiet, '');
  assert.equal(w.current(), null);
  const r = await w.explain();
  assert.equal(r.ok, true);
});

test('explain takes one reading when no tick came yet', async () => {
  let reads = 0;
  const fps = { getFrameStats: () => statsOf(42, 35, 28), getFrameWindow: () => ({ frames: frames(25) }) };
  const w = createStutterWatch({ fps, readSystem: async () => { reads++; return sample({ gpu: 99 }); } });
  const r = await w.explain();
  assert.equal(reads, 1);
  assert.equal(r.reason, 'gpu_bound');
  const broken = createStutterWatch({ fps: { getFrameStats: () => { throw new Error('x'); } }, readSystem: async () => { throw new Error('y'); } });
  assert.deepEqual(await broken.explain(), { ok: false, error: 'no_frames' });
});

test('without a game in front there is nothing to judge, whatever else draws frames', async () => {
  let running = '';
  const fps = { getFrameStats: () => statsOf(60, 58, 17), getFrameWindow: () => ({ frames: frames(16.7) }) };
  const w = createStutterWatch({ fps, game: () => running, readSystem: async () => quiet });
  assert.deepEqual(await w.explain(), { ok: false, error: 'no_frames' });
  running = 'game.exe';
  assert.equal((await w.explain()).reason, 'capped');
  const broken = createStutterWatch({ fps, game: () => { throw new Error('x'); } });
  assert.deepEqual(await broken.explain(), { ok: false, error: 'no_frames' });
});
