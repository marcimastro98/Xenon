// What Airflow does when its learning stops being true (server/airflow/loop-learning.js), end
// to end on the pretend board (tools/airflow-sim/bench.mjs): a fan replaced on its header goes
// back to the PC and asks for a check, a new processor or graphics card starts only that part's
// learning (a card's name must come back on a second run), and "learn from scratch" forgets
// what was learned but keeps every choice and fan check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createBench, defaultBench } from '../../tools/airflow-sim/bench.mjs';
import { createFakeDriver } from '../../tools/airflow-sim/fake-driver.mjs';

const require = createRequire(import.meta.url);
const { createAirflowLoop } = require('../airflow/loop.js');
const { createAirflowStore } = require('../airflow/store.js');
const Learning = require('../airflow/loop-learning.js');

const GPU_FAN = 'lhm:gpu:control-1';
const CPU = 'AMD Ryzen 7 7800X3D 8-Core Processor';
const CARD = 'NVIDIA GeForce RTX 4080';

// Each run starts later than the one before, as on a real PC (a check's time is compared with
// the time a new card was first seen).
const RUN_GAP_MS = 10 * 3600000;
let runs = 0;

// One engine run on a folder of its own (or the one of an earlier run, as after a restart).
// parts: the names this PC gives, or a function asked each tick.
async function rig(t, { model = null, dataDir: shared = null, parts = { cpu: CPU, gpu: CARD } } = {}) {
  const dataDir = shared ?? await fs.mkdtemp(path.join(os.tmpdir(), 'airflow-learning-'));
  const store = createAirflowStore({ dataDir });
  if (model) await store.update((m) => ({ ...m, ...model }));
  runs += 1;
  const bench = createBench(defaultBench(), { latencyMs: 1500, start: runs * RUN_GAP_MS });
  const driver = createFakeDriver(bench);
  const timers = {
    fn: null,
    setInterval(fn) { this.fn = fn; return {}; }, clearInterval() { this.fn = null; },
    setTimeout() { return {}; }, clearTimeout() {},
  };
  const warnings = [];
  const loop = createAirflowLoop({
    drivers: [driver], store, clock: bench.now, timers, situation: () => ({ hour: 14 }),
    warn: (m) => warnings.push(m), parts: typeof parts === 'function' ? parts : () => parts,
  });
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await loop.stop(); } };
  // The engine stops (and saves) before its folder goes; a run on an earlier one's folder stops itself.
  t.after(async () => { await stop(); if (!shared) await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 3 }); });
  async function run(seconds) {
    for (let n = 0; n < seconds && timers.fn; n += 1) { await timers.fn(); bench.advance(1000); }
  }
  return { store, bench, driver, loop, run, warnings, dataDir, stop };
}

// The fans the check measured on the default board.
let measured = null;
async function checkedFans(t) {
  if (measured) return measured;
  const r = await rig(t);
  await r.loop.start();
  assert.equal(r.loop.startCheck().ok, true);
  await r.run(15 * 60);
  measured = { fans: r.store.peek().fans, check: r.store.peek().check };
  return measured;
}

// A run that drove long enough to learn both parts, stopped (so it saved).
async function learnedRun(t, seconds = 600) {
  const { fans } = await checkedFans(t);
  const r = await rig(t, { model: { drive: 'on', fans } });
  await r.loop.start();
  await r.run(seconds);
  await r.stop();
  return { fans, dataDir: r.dataDir };
}

const appliedIds = (driver, from) => new Set(driver.log.slice(from).filter((e) => e.call === 'apply').flatMap((e) => Object.keys(e.verdicts)));

test('a fan that turns far from its check is left to the PC and asks for a check; the others drive on', async (t) => {
  const { fans, check } = await checkedFans(t);
  const board = Object.keys(fans).filter((id) => fans[id].calib && !fans[id].leave && !id.includes(':gpu:'));
  const [swapped] = board;
  // The check said this header turns twice as fast: another fan went on it since.
  const calib = fans[swapped].calib;
  const told = { ...fans, [swapped]: { ...fans[swapped], calib: { ...calib, maxRpm: calib.maxRpm * 2, curve: calib.curve.map(([d, rpm]) => [d, rpm * 2]) } } };
  const { loop, run, store, driver } = await rig(t, { model: { drive: 'on', fans: told, check } });
  await loop.start();
  await run(400);
  const m = store.peek();
  assert.equal(m.fans[swapped].calib, null, 'no check any more');
  assert.equal(m.check?.problems?.[swapped], 'changed');
  assert.equal(m.check.at, check.at, 'the last check is still the one the person ran');
  for (const id of board.slice(1)) assert.ok(m.fans[id].calib, `${id} keeps its check`);
  const from = driver.log.length;
  await run(20);
  const applied = appliedIds(driver, from);
  assert.ok(!applied.has(swapped), 'the PC has it');
  assert.ok(board.slice(1).some((id) => applied.has(id)), 'the others are still driven');
  assert.equal(loop.status().state, 'driving');
});

test('a fan turning as checked is never left to the PC', async (t) => {
  const { fans } = await checkedFans(t);
  const { loop, run, store } = await rig(t, { model: { drive: 'on', fans } });
  await loop.start();
  await run(400);
  const m = store.peek();
  for (const [id, f] of Object.entries(fans)) assert.deepEqual(!!m.fans[id].calib, !!f.calib, id);
  assert.ok(!Object.values(m.check?.problems || {}).includes('changed'));
});

test('a new processor starts its own learning at once; the card, the fans and their checks stay', async (t) => {
  const { fans, dataDir } = await learnedRun(t);
  const before = await createAirflowStore({ dataDir }).readLearned();
  assert.ok(before.brain.cpu && before.brain.gpu, 'both parts were learned');
  assert.deepEqual({ cpu: before.parts.cpu, gpu: before.parts.gpu }, { cpu: CPU, gpu: CARD });
  const r = await rig(t, { dataDir, parts: { cpu: 'AMD Ryzen 9 9950X3D 16-Core Processor', gpu: CARD } });
  await r.loop.start();
  await r.run(1);
  await r.stop();
  const after = await r.store.readLearned();
  assert.deepEqual(after.brain.gpu, before.brain.gpu, 'the card keeps what it learned');
  assert.notDeepEqual(after.brain.cpu, before.brain.cpu, 'the processor starts again');
  assert.equal(after.parts.cpu, 'AMD Ryzen 9 9950X3D 16-Core Processor');
  assert.match(after.health.parts.cpu, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(after.health.parts.gpu, null);
  for (const [id, f] of Object.entries(fans)) assert.deepEqual(!!r.store.peek().fans[id].calib, !!f.calib, id);
  assert.ok(r.warnings.some((w) => /new cpu/.test(w)));
});

test('a new graphics card counts on its second run: then its learning and its own fans\' checks start again', async (t) => {
  const { dataDir } = await learnedRun(t);
  const kept = createAirflowStore({ dataDir });
  const before = await kept.readLearned();
  await kept.saveLearned({ ...before, games: { 'game.exe': { cpu: 60, gpu: 220, n: 3 } } });
  const card = { cpu: CPU, gpu: 'AMD Radeon RX 7900 XTX' };
  const once = await rig(t, { dataDir, parts: card });
  await once.loop.start();
  await once.run(1);
  await once.stop();
  const waiting = await once.store.readLearned();
  assert.deepEqual(waiting.brain.gpu, before.brain.gpu, 'one run is not enough');
  assert.equal(waiting.parts.gpu, CARD);
  assert.equal(waiting.games['game.exe'].gpu, 220, 'nor for the games');
  assert.ok(once.store.peek().fans[GPU_FAN].calib);
  const twice = await rig(t, { dataDir, parts: card });
  await twice.loop.start();
  await twice.run(1);
  await twice.stop();
  const after = await twice.store.readLearned();
  // An idle card teaches little in a few minutes: the day it was found says the learning restarted.
  assert.match(after.health.parts.gpu, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(after.health.parts.cpu, null);
  assert.equal(after.parts.gpu, card.gpu);
  assert.deepEqual(after.parts.pending, {});
  assert.deepEqual(after.games, {}, 'the heat a game brought was the old card\'s');
  const m = twice.store.peek();
  assert.equal(m.fans[GPU_FAN].calib, null, 'the new card\'s fans need the check');
  assert.equal(m.check.problems[GPU_FAN], 'changed');
  assert.ok(Object.entries(m.fans).some(([id, f]) => id !== GPU_FAN && f.calib), 'the board fans keep theirs');
});

test("a new card's fans checked after it was first seen keep that check", async (t) => {
  const { dataDir } = await learnedRun(t, 300);
  const card = { cpu: CPU, gpu: 'AMD Radeon RX 7900 XTX' };
  const kept = createAirflowStore({ dataDir });
  // Airflow off: the engine ticks only for the check the person runs right after the swap.
  await kept.update((m) => ({ ...m, drive: 'off' }));
  const checking = await rig(t, { dataDir, parts: card });
  await checking.loop.start();
  assert.equal(checking.loop.startCheck().ok, true);
  await checking.run(15 * 60);
  await checking.stop();
  const checkedAt = checking.store.peek().fans[GPU_FAN].calib.at;
  // A store read afresh: the one above still holds the choices from before the check.
  await createAirflowStore({ dataDir }).update((m) => ({ ...m, drive: 'on' }));
  const next = await rig(t, { dataDir, parts: card });
  await next.loop.start();
  await next.run(2);
  await next.stop();
  const after = await next.store.readLearned();
  assert.match(after.health.parts.gpu, /^\d{4}-\d{2}-\d{2}$/, 'the check run was its first');
  assert.equal(next.store.peek().fans[GPU_FAN].calib?.at, checkedAt, 'the check already measured the new card');
  assert.notEqual(next.store.peek().check.problems[GPU_FAN], 'changed');
});

test('a processor named late in a run restarts its learning even with the brain at work', async (t) => {
  const { dataDir } = await learnedRun(t);
  const before = await createAirflowStore({ dataDir }).readLearned();
  let named = '';
  const r = await rig(t, { dataDir, parts: () => ({ cpu: named, gpu: CARD }) });
  await r.loop.start();
  await r.run(60);
  named = 'AMD Ryzen 9 9950X3D 16-Core Processor';
  await r.run(5);
  await r.stop();
  const after = await r.store.readLearned();
  assert.match(after.health.parts.cpu, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(after.brain.cpu.est.updates < before.brain.cpu.est.updates / 2,
    `${after.brain.cpu.est.updates} updates kept of ${before.brain.cpu.est.updates}: the old processor's learning stayed`);
});

test('index.js gives the engine the processor and the parts\' names', async () => {
  const index = await fs.readFile(new URL('../airflow/index.js', import.meta.url), 'utf8');
  assert.match(index, /const cpuName = getCpuName\(\) \|\| '';/);
  assert.match(index, /createAirflowLoop\(\{[^}]*\bcpuName, parts: \(\) => \(\{ cpu: cpuName, gpu: sensorReads\.gpuCache\.gpuName \}\)/);
});

test('the same card named another way, or a card seen once, is no new card', async (t) => {
  const { dataDir } = await learnedRun(t, 300);
  for (const gpu of ['GeForce RTX 4080', 'AMD GPU', 'AMD Radeon RX 7900 XTX', CARD, 'AMD Radeon RX 7900 XTX']) {
    const r = await rig(t, { dataDir, parts: { cpu: CPU, gpu } });
    await r.loop.start();
    await r.run(1);
    await r.stop();
  }
  const after = await createAirflowStore({ dataDir }).readLearned();
  assert.equal(after.health.parts.gpu, null, 'never two runs in a row');
  assert.ok(after.brain.gpu);
  assert.equal(after.parts.gpu, CARD);
  assert.equal(after.parts.pending.gpu.runs, 1, 'the other card waits for a second run in a row');
});

test('a part with no name kept, or not known yet, starts nothing', async (t) => {
  const { fans } = await checkedFans(t);
  const unknown = await rig(t, { model: { drive: 'on', fans }, parts: { cpu: '', gpu: null } });
  await unknown.loop.start();
  await unknown.run(30);
  await unknown.stop();
  const first = await unknown.store.readLearned();
  assert.equal(first.parts?.cpu, undefined);
  const named = await rig(t, { dataDir: unknown.dataDir });
  await named.loop.start();
  await named.run(30);
  await named.stop();
  const after = await named.store.readLearned();
  assert.deepEqual({ cpu: after.parts.cpu, gpu: after.parts.gpu }, { cpu: CPU, gpu: CARD });
  assert.deepEqual(after.health.parts, { cpu: null, gpu: null });
  assert.ok(!named.warnings.some((w) => /was found/.test(w)));
});

test('learning from scratch forgets what was learned; choices, checks and the parts\' names stay', async (t) => {
  const { fans, dataDir } = await learnedRun(t, 300);
  await createAirflowStore({ dataDir }).update((m) => ({ ...m, mode: 'quiet', slider: 30 }));
  const r = await rig(t, { dataDir });
  await r.loop.start();
  await r.run(5);
  await r.loop.relearn();
  const saved = await r.store.readLearned();
  assert.equal(saved.brain, undefined);
  assert.equal(saved.games, undefined);
  assert.deepEqual(saved.health.wear, {});
  assert.deepEqual(saved.health.history, []);
  assert.equal(saved.parts.cpu, CPU);
  const m = r.store.peek();
  assert.equal(m.mode, 'quiet');
  assert.equal(m.slider, 30);
  for (const [id, f] of Object.entries(fans)) assert.deepEqual(!!m.fans[id].calib, !!f.calib, id);
  await r.run(30);
  assert.equal(r.loop.status().state, 'driving', 'it drives on, learning again');
  await r.stop();
});

test('another part: a model number on both sides and neither name holding the other', () => {
  const { another } = Learning;
  assert.equal(another(CARD, 'GeForce RTX 4080'), false);
  assert.equal(another(CARD, 'NVIDIA GeForce RTX 4080 SUPER'), false);
  assert.equal(another('AMD GPU', 'AMD Radeon RX 7900 XTX'), false);
  assert.equal(another('Intel(R) Core(TM) i7-12700K', 'Intel Core i7-12700K'), false);
  assert.equal(another(CARD, 'AMD Radeon RX 7900 XTX'), true);
  assert.equal(another(CPU, 'AMD Ryzen 9 9950X3D 16-Core Processor'), true);
});
