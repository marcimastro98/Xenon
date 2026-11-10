// capabilities/stutter-why.js: the Deck key and Bit for "why does it stutter?".
// Pinned here: it is offered only where single frame times exist, the answer
// is shown on the screens without its English sentence (each client words it),
// the action validates like any key, and the perf stream carries the line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const { validateAction } = require('../js/deck-actions.js');
const { createPerfStream } = require('../perf-stream.js');

const presentmon = { backend: 'presentmon', isAvailable: () => true, getFrameStats: () => null, getFramesSince: () => null };

test('Bit gets explain_stutter only where frame times are measured', () => {
  const caps = createCapabilities({ fps: presentmon });
  assert.ok(aiFunctions(caps.probes()).some((f) => f.name === 'explain_stutter'));
  const mango = createCapabilities({ fps: { backend: 'mangohud', isAvailable: () => true } });
  assert.ok(!aiFunctions(mango.probes()).some((f) => f.name === 'explain_stutter'));
  assert.deepEqual(aiAction('explain_stutter', { anything: 1 }), { type: 'stutterWhy' });
});

test('the key answers and shows the answer once', async () => {
  const shown = [];
  const answer = { ok: true, verdict: 'stutter', reason: 'vram_full', also: [], fps: 90, summary: 'x' };
  const caps = createCapabilities({ fps: presentmon, stutter: { explain: async () => answer, onAnswer: (r) => shown.push(r) } });
  assert.equal(validateAction({ type: 'stutterWhy' }).ok !== false, true);
  const r = await caps.run({ type: 'stutterWhy' });
  assert.equal(r.reason, 'vram_full');
  assert.equal(r.summary, 'x');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].reason, 'vram_full');
  assert.equal('summary' in shown[0], false);
});

test('an error is not shown on the screens, only returned', async () => {
  const shown = [];
  const caps = createCapabilities({ fps: presentmon, stutter: { explain: async () => ({ ok: false, error: 'no_frames' }), onAnswer: (r) => shown.push(r) } });
  assert.deepEqual(await caps.run({ type: 'stutterWhy' }), { ok: false, error: 'no_frames' });
  assert.equal(shown.length, 0);
});

test('without the watch, or on a Mac, it says unavailable', async () => {
  assert.deepEqual(await createCapabilities({ fps: presentmon }).run({ type: 'stutterWhy' }), { ok: false, error: 'unavailable' });
  const mac = createCapabilities({ fps: { backend: 'none', isAvailable: () => false }, stutter: { explain: async () => ({ ok: true }) } });
  assert.deepEqual(await mac.run({ type: 'stutterWhy' }), { ok: false, error: 'unavailable' });
});

test('a failing toast never loses the answer', async () => {
  const caps = createCapabilities({ fps: presentmon, stutter: { explain: async () => ({ ok: true, reason: 'smooth' }), onAnswer: () => { throw new Error('x'); } } });
  assert.deepEqual(await caps.run({ type: 'stutterWhy' }), { ok: true, reason: 'smooth' });
});

test('the perf stream carries the line, and only a well-formed one', () => {
  const fps = { getFpsDetail: () => ({ fps: 90 }), getFrameStats: () => ({}), getFrameWindow: () => ({ frames: [] }) };
  const make = (why) => createPerfStream({ fps, wanted: () => true, hasClients: () => true, broadcast: () => {}, why });
  assert.deepEqual(make(() => ({ verdict: 'stutter', reason: 'loading', extra: 1 })).snapshot().why, { verdict: 'stutter', reason: 'loading' });
  assert.equal(make(() => null).snapshot().why, null);
  assert.equal(make(() => ({ verdict: 3 })).snapshot().why, null);
  assert.equal(make(() => { throw new Error('x'); }).snapshot().why, null);
  assert.equal(make(undefined).snapshot().why, null);
});
