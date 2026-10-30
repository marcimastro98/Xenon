// capabilities/benchmark.js: the Deck key and the voice for a benchmark. Pinned
// here: only a backend with single frame times offers it, a path never comes
// back, and "show the file" with nothing saved says so instead of opening a
// random folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bench = require('../capabilities/benchmark.js');
const { createCapabilities, aiFunctions } = require('../capabilities/index.js');

const presentmon = { backend: 'presentmon', isAvailable: () => true, getFramesSince: () => null };

function fakeRunner(file = '') {
  const calls = [];
  return {
    calls,
    lastFile: () => file,
    start: () => { calls.push('start'); return { ok: true, running: true }; },
    stop: async () => { calls.push('stop'); return { ok: true, saved: true, file: 'g 2026.csv' }; },
    toggle: async () => { calls.push('toggle'); return { ok: true, running: true }; },
  };
}

test('only PresentMon offers it: MangoHud has no single frames, macOS no frame rate', () => {
  assert.equal(bench.available(presentmon), true);
  assert.equal(bench.available({ ...presentmon, isAvailable: () => false }), false);
  assert.equal(bench.available({ backend: 'mangohud', isAvailable: () => true, getFramesSince: () => null }), false);
  assert.equal(bench.available({ backend: null }), false);
  assert.equal(bench.available(null), false);
});

test('modes reach the runner; an unknown one toggles, like an unset Deck key', async () => {
  const r = fakeRunner();
  const d = { bench: { store: () => r, reveal: () => {} } };
  await bench.run(d, { mode: 'start' });
  await bench.run(d, { mode: 'stop' });
  await bench.run(d, { mode: 'toggle' });
  await bench.run(d, { mode: 'weird' });
  await bench.run(d, {});
  assert.deepEqual(r.calls, ['start', 'stop', 'toggle', 'toggle', 'toggle']);
  assert.deepEqual(await bench.run({}, { mode: 'start' }), { ok: false, error: 'unavailable' });
});

test('reveal opens the last file locally and answers without its path', async () => {
  const shown = [];
  const none = { bench: { store: () => fakeRunner(''), reveal: (p) => shown.push(p) } };
  assert.deepEqual(await bench.run(none, { mode: 'reveal' }), { ok: false, error: 'no_file' });
  const some = { bench: { store: () => fakeRunner('C:\\Users\\u\\Documents\\Xenon\\Benchmark\\g.csv'), reveal: (p) => shown.push(p) } };
  const res = await bench.run(some, { mode: 'reveal' });
  assert.deepEqual(res, { ok: true, shown: true });
  assert.deepEqual(shown, ['C:\\Users\\u\\Documents\\Xenon\\Benchmark\\g.csv']);
  assert.doesNotMatch(JSON.stringify(res), /Users/);
});

test('the registry probes it, runs it, and hands the AI run_benchmark only where it works', async () => {
  const r = fakeRunner();
  const caps = createCapabilities({ fps: presentmon, bench: { store: () => r, reveal: () => {} } });
  assert.equal(caps.probes().benchmark, true);
  assert.deepEqual(await caps.run({ type: 'benchmark', mode: 'start' }), { ok: true, running: true });
  const off = createCapabilities({ fps: { backend: 'mangohud', isAvailable: () => true } });
  assert.deepEqual(await off.run({ type: 'benchmark', mode: 'start' }), { ok: false, error: 'unavailable' });
  assert.ok(aiFunctions({ benchmark: true }).some((f) => f.name === 'run_benchmark'));
  assert.ok(!aiFunctions({ benchmark: false }).some((f) => f.name === 'run_benchmark'));
});
