// perf-session/culprit.js: the program that weighs on the PC while a game stutters. Pinned
// here: only a processor or memory verdict looks for one, the game and the system are never
// named, a program that uses little is not blamed, the table is read once at a time and not
// more often than its interval, and an answer for an old verdict is never shown for a new one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickCulprit, createCulpritWatch, READ_EVERY_MS } = require('../perf-session/culprit.js');
const { createStutterWatch } = require('../stutter-why.js');

const APPS = [
  { proc: 'racer', memMB: 9000, cpuPct: 60 },
  { proc: 'svchost', memMB: 300, cpuPct: 30 },
  { proc: 'dwm', memMB: 200, cpuPct: 25 },
  { proc: 'xenon', memMB: 400, cpuPct: 20 },
  { proc: 'msedgewebview2', memMB: 900, cpuPct: 18 },
  { proc: 'videoencoder', memMB: 700, cpuPct: 14.6 },
  { proc: 'browser', memMB: 3400, cpuPct: 3 },
  { proc: 'idle', memMB: 0, cpuPct: 90 },
];

test('a processor verdict names the busiest program, never the game or the system', () => {
  assert.deepEqual(pickCulprit('cpu_bound', APPS, 'Racer.exe'), { name: 'videoencoder', cpu: 15 });
  assert.deepEqual(pickCulprit('mixed', APPS, 'Racer.exe'), { name: 'videoencoder', cpu: 15 });
});

test('a memory verdict names the program holding the most memory', () => {
  assert.deepEqual(pickCulprit('ram_full', APPS, 'Racer.exe'), { name: 'browser', ramMB: 3400 });
});

test('a program that uses little is not blamed', () => {
  const small = [{ proc: 'notes', memMB: 300, cpuPct: 2 }];
  assert.equal(pickCulprit('cpu_bound', small, 'racer'), null);
  assert.equal(pickCulprit('ram_full', small, 'racer'), null);
});

test('other verdicts look for no program', () => {
  for (const reason of ['gpu_bound', 'vram_full', 'gpu_hot', 'cpu_hot', 'loading', 'smooth', 'capped']) {
    assert.equal(pickCulprit(reason, APPS, 'racer'), null, reason);
  }
});

test('the name is shown without .exe and cut to a length a line can hold', () => {
  const r = pickCulprit('cpu_bound', [{ proc: 'Encoder.EXE', memMB: 1, cpuPct: 40 }, { proc: 'x'.repeat(90), memMB: 1, cpuPct: 1 }], '');
  assert.deepEqual(r, { name: 'Encoder', cpu: 40 });
  assert.equal(pickCulprit('cpu_bound', [{ proc: 'y'.repeat(90), memMB: 1, cpuPct: 40 }], '').name.length, 40);
});

test('rows that are not rows are skipped, not trusted', () => {
  assert.equal(pickCulprit('cpu_bound', null, 'racer'), null);
  assert.deepEqual(pickCulprit('cpu_bound', [null, { proc: 7 }, { proc: 'a', cpuPct: 'lots' }, { proc: 'b', cpuPct: 9 }], ''), { name: 'b', cpu: 9 });
});

function rig({ stats = { ok: true, apps: APPS }, available = true } = {}) {
  let t = 1_000_000;
  const calls = [];
  const pending = [];
  const read = () => {
    calls.push(t);
    return new Promise((resolve) => pending.push(() => resolve(typeof stats === 'function' ? stats() : stats)));
  };
  const watch = createCulpritWatch({ read, available: () => available, now: () => t });
  const settle = async () => { while (pending.length) pending.shift()(); await new Promise((r) => setImmediate(r)); };
  return { watch, calls, settle, advance: (ms) => { t += ms; } };
}

const CPU = { verdict: 'low', reason: 'cpu_bound' };
const RAM = { verdict: 'stutter', reason: 'ram_full' };

test('the table is read when the verdict blames the processor, and the program follows it', async () => {
  const r = rig();
  r.watch.onWhy(CPU, 'Racer.exe');
  assert.equal(r.calls.length, 1);
  assert.equal(r.watch.current(), null, 'nothing before the read answers');
  await r.settle();
  assert.deepEqual(r.watch.current(), { name: 'videoencoder', cpu: 15 });
  assert.deepEqual(r.watch.current('cpu_bound'), { name: 'videoencoder', cpu: 15 });
  assert.equal(r.watch.current('ram_full'), null, 'never for another verdict');
});

test('one read at a time, and not again before its interval', async () => {
  const r = rig();
  r.watch.onWhy(CPU, 'racer');
  r.watch.onWhy(CPU, 'racer');
  assert.equal(r.calls.length, 1, 'one in flight');
  await r.settle();
  r.advance(READ_EVERY_MS - 1);
  r.watch.onWhy(CPU, 'racer');
  assert.equal(r.calls.length, 1, 'not before the interval');
  r.advance(1);
  r.watch.onWhy(CPU, 'racer');
  assert.equal(r.calls.length, 2, 'again once it passed');
});

test('a new verdict reads again soon, and an answer for the old one is dropped', async () => {
  const r = rig();
  r.watch.onWhy(CPU, 'racer');
  r.watch.onWhy(RAM, 'racer');   // while the first read is in flight
  await r.settle();
  assert.equal(r.watch.current(), null, 'the processor answer is not shown for memory');
  r.advance(3000);
  r.watch.onWhy(RAM, 'racer');
  await r.settle();
  assert.deepEqual(r.watch.current(), { name: 'browser', ramMB: 3400 });
});

test('a verdict that blames nothing it can measure, or no game, clears the program and reads nothing', async () => {
  const r = rig();
  r.watch.onWhy(CPU, 'racer');
  await r.settle();
  r.watch.onWhy({ verdict: 'low', reason: 'gpu_bound' }, 'racer');
  assert.equal(r.watch.current(), null);
  r.watch.onWhy(CPU, '');
  r.watch.onWhy(null, 'racer');
  assert.equal(r.calls.length, 1);
});

test('no table on this machine, or a table that fails: no program, no error', async () => {
  const none = rig({ available: false });
  none.watch.onWhy(CPU, 'racer');
  assert.equal(none.calls.length, 0);
  const failing = rig({ stats: null });
  failing.watch.onWhy(CPU, 'racer');
  await failing.settle();
  assert.equal(failing.watch.current(), null);
  const throwing = createCulpritWatch({ read: async () => { throw new Error('denied'); }, now: () => 0 });
  throwing.onWhy(CPU, 'racer');
  await new Promise((r) => setImmediate(r));
  assert.equal(throwing.current(), null);
});

// The stutter watch carries the program as `app`, for the perf stream and for Bit and the Deck.
function lowCpuFps() {
  const frames = Array(600).fill(25);
  return {
    getFrameStats: () => ({ avgFps: 42, low1Fps: 35, low01Fps: 35, p99Ms: 28, count: 600, process: 'racer.exe' }),
    getFrameWindow: () => ({ frames }),
  };
}
const busyCpu = { gpu: 55, cpu: 90, cpuMaxCore: 99, vramUsed: 4000, vramTotal: 12000, memory: { percent: 50 }, gpuTemp: 60, cpuTemp: 60 };

test('the stutter watch adds the program to what it shows, and to its answer', async () => {
  const culprit = { onWhy: () => {}, current: (reason) => (reason == null || reason === 'cpu_bound' ? { name: 'videoencoder', cpu: 15 } : null) };
  const seen = [];
  culprit.onWhy = (shown, game) => seen.push([shown && shown.reason, game]);
  const w = createStutterWatch({ fps: lowCpuFps(), culprit, game: () => 'racer.exe' });
  w.onSystem(busyCpu, 'racer.exe');
  w.onSystem(busyCpu, 'racer.exe');
  assert.deepEqual(w.current(), { verdict: 'low', reason: 'cpu_bound', app: { name: 'videoencoder', cpu: 15 } });
  assert.deepEqual(seen.at(-1), ['cpu_bound', 'racer.exe']);
  const answer = await w.explain();
  assert.deepEqual(answer.app, { name: 'videoencoder', cpu: 15 });
  w.onSystem(null, '');
  assert.deepEqual(seen.at(-1), [null, ''], 'the game ended: the program is let go');
});

test('without a culprit, or one that throws, the stutter watch says what it said before', () => {
  const plain = createStutterWatch({ fps: lowCpuFps() });
  plain.onSystem(busyCpu, 'racer.exe');
  plain.onSystem(busyCpu, 'racer.exe');
  assert.deepEqual(plain.current(), { verdict: 'low', reason: 'cpu_bound' });
  const broken = createStutterWatch({ fps: lowCpuFps(), culprit: { onWhy: () => { throw new Error('x'); }, current: () => { throw new Error('y'); } } });
  broken.onSystem(busyCpu, 'racer.exe');
  broken.onSystem(busyCpu, 'racer.exe');
  assert.deepEqual(broken.current(), { verdict: 'low', reason: 'cpu_bound' });
});
