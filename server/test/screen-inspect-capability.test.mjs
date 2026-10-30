// capabilities/screen-inspect.js: the colour picker and the ruler for the Deck,
// Bit and widgets. Pinned here: the engine gets the mode, the format and the
// hint in the user's language; a colour or a size comes back checked (a broken
// engine answer is "failed", never passed on); the picker's own answers
// (cancelled, picking) pass through; one picker at a time with the screenshot
// and OCR; the toast learns the value; catalog, runner and AI line up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const inspect = require('../capabilities/screen-inspect.js');
const pickerLock = require('../capabilities/picker-lock.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');

const COLOUR = { ok: true, rgb: [30, 144, 255], hex: '#1E90FF', text: 'hsl(210, 100%, 56%)', copied: true, monitor: 2 };
const SIZE = { ok: true, width: 333, height: 177, text: '333 × 177', copied: true, monitor: 2 };

function deps(reply, { available = true } = {}) {
  const log = { requests: [], told: [], hints: [] };
  const capture = {
    host: {
      available: () => available,
      request: async (cmd, body, opts) => { log.requests.push({ cmd, body, opts }); return typeof reply === 'function' ? reply(body) : reply; },
    },
    inspectHint: async (mode) => { log.hints.push(mode); return mode === 'colour' ? 'Click a point' : 'Drag to measure'; },
    onInspect: (r) => log.told.push(r),
  };
  return { d: { capture }, log };
}

test('the colour picker asks the engine with the format and the hint, and returns the colour', async () => {
  const { d, log } = deps(COLOUR);
  const r = await inspect.color(d, { format: 'hsl' });
  assert.deepEqual(r, { ok: true, hex: '#1E90FF', rgb: [30, 144, 255], text: 'hsl(210, 100%, 56%)', copied: true });
  assert.equal(log.requests[0].cmd, 'inspect');
  assert.deepEqual(log.requests[0].body, { mode: 'colour', format: 'hsl', hint: 'Click a point' });
  assert.ok(log.requests[0].opts.timeoutMs > 120000, 'waits longer than the engine keeps the picker open');
  assert.deepEqual(log.told, [{ mode: 'colour', text: 'hsl(210, 100%, 56%)', copied: true }]);
  // An unknown format is the default, never passed on.
  await inspect.color(d, { format: 'cmyk' });
  assert.equal(log.requests[1].body.format, 'hex');
});

test('the ruler returns the size; it sends no format', async () => {
  const { d, log } = deps(SIZE);
  const r = await inspect.measure(d, { format: 'rgb' });
  assert.deepEqual(r, { ok: true, width: 333, height: 177, text: '333 × 177', copied: true });
  assert.deepEqual(log.requests[0].body, { mode: 'measure', hint: 'Drag to measure' });
  assert.deepEqual(log.told, [{ mode: 'measure', text: '333 × 177', copied: true }]);
});

test('a broken engine answer is "failed" and tells no toast', async () => {
  for (const bad of [
    { ...COLOUR, hex: '#zzz' }, { ...COLOUR, rgb: [1, 2] }, { ...COLOUR, rgb: [1, 2, 300] }, { ok: true },
  ]) {
    const { d, log } = deps(bad);
    assert.deepEqual(await inspect.color(d, {}), { ok: false, error: 'failed' }, JSON.stringify(bad));
    assert.equal(log.told.length, 0);
  }
  for (const bad of [{ ...SIZE, width: 0 }, { ...SIZE, height: -3 }, { ...SIZE, width: 1.5 }, { ok: true }]) {
    assert.deepEqual(await inspect.measure(deps(bad).d, {}), { ok: false, error: 'failed' }, JSON.stringify(bad));
  }
  // A long text from the engine is cut before it reaches a toast.
  const { d, log } = deps({ ...SIZE, text: 'x'.repeat(500) });
  assert.equal((await inspect.measure(d, {})).text.length, 40);
  assert.equal(log.told[0].text.length, 40);
});

test('the picker answers pass through; engine errors are known codes or "failed"', async () => {
  assert.deepEqual(await inspect.color(deps({ ok: true, cancelled: true }).d, {}), { ok: true, cancelled: true });
  assert.deepEqual(await inspect.measure(deps({ ok: false, error: 'unsupported' }).d, {}), { ok: false, error: 'unsupported' });
  assert.deepEqual(await inspect.measure(deps({ ok: false, error: 'bad_request' }).d, {}), { ok: false, error: 'failed' });
  assert.deepEqual(await inspect.color(deps(null).d, {}), { ok: false, error: 'failed' });
  assert.deepEqual(await inspect.color(deps(COLOUR, { available: false }).d, {}), { ok: false, error: 'unavailable' });
  assert.deepEqual(await inspect.color({}, {}), { ok: false, error: 'unavailable' });
});

test('one picker at a time with the screenshot and the text reader', async () => {
  const { d, log } = deps(COLOUR);
  let second;
  await pickerLock.hold(async () => { second = await inspect.measure(d, {}); });
  assert.deepEqual(second, { ok: true, picking: true });
  assert.equal(log.requests.length, 0);
  // While the colour picker is open, a screenshot area waits its turn too.
  let release;
  const slow = deps(() => new Promise((res) => { release = () => res(COLOUR); }));
  const open = inspect.color(slow.d, {});
  await new Promise((r) => setImmediate(r));
  assert.equal(pickerLock.held(), true);
  release();
  assert.equal((await open).ok, true);
  assert.equal(pickerLock.held(), false);
});

test('the catalog entries, the runner and the AI functions line up', async () => {
  const color = CAPABILITIES.find(c => c.type === 'screenColor');
  const measure = CAPABILITIES.find(c => c.type === 'screenMeasure');
  for (const c of [color, measure]) {
    assert.equal(c.group, 'capture');
    assert.equal(c.capability.risk, 'sensitive');
  }
  assert.equal(color.capability.requires, 'captureInspect');
  assert.equal(measure.capability.requires, 'captureMeasure');
  assert.deepEqual(color.params.find(p => p.name === 'format').options, inspect.FORMATS.slice());
  const names = aiFunctions({ capture: true }).map(f => f.name);
  assert.ok(names.includes('pick_screen_color') && names.includes('measure_screen'));
  assert.ok(!aiFunctions({ captureInspect: false }).some(f => f.name === 'pick_screen_color'));
  // An engine that picks colours but has no ruler offers only the colour.
  const colourOnly = aiFunctions({ captureInspect: true, captureMeasure: false }).map(f => f.name);
  assert.ok(colourOnly.includes('pick_screen_color') && !colourOnly.includes('measure_screen'));
  assert.deepEqual(aiAction('pick_screen_color', { format: 'rgb', extra: 1 }), { type: 'screenColor', format: 'rgb' });
  const { d } = deps(SIZE);
  const run = createCapabilities({ capture: d.capture });
  assert.equal((await run.run({ type: 'screenMeasure' })).width, 333);
});

test('the strings and the Deck icons exist, in 11 languages', () => {
  const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  for (const k of ['deck_act_screenColor', 'deck_act_screenMeasure', 'deck_param_screenColor_format', 'deck_opt_hex', 'deck_opt_rgb', 'deck_opt_hsl',
    'color_pick_hint', 'measure_pick_hint', 'color_copied', 'measure_copied', 'inspect_not_copied']) {
    assert.equal((i18n.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 11, k);
  }
  const editor = readFileSync(new URL('../js/deck-editor.js', import.meta.url), 'utf8');
  assert.match(editor, /screenColor: _ai\(/);
  assert.match(editor, /screenMeasure: _ai\(/);
});
