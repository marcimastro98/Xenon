// capabilities/screen-pin.js: "Pin on screen" for the Deck, Bit and widgets.
// Pinned here: only screenshots are pinned (a video has no single picture), the
// layer widget carries the opaque capture id and never a path, the box keeps the
// picture's shape, the picker's own answers (cancelled, picking) pass through,
// and a deleted capture takes its pins with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const screenPin = require('../capabilities/screen-pin.js');
const LayersModel = require('../js/layers-model.js');
const pickerLock = require('../capabilities/picker-lock.js');
const { createCapabilities, aiFunctions } = require('../capabilities/index.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');

const SHOT = { id: 'aaaaaaaaaaaaaaaa', kind: 'screenshot', name: 'Desktop 2026-10-27 10-00-00.png', file: 'C:\\Users\\u\\Pictures\\Xenon\\Desktop\\Desktop 2026-10-27 10-00-00.png', width: 1600, height: 900 };
const TALL = { ...SHOT, id: 'bbbbbbbbbbbbbbbb', width: 600, height: 1800 };
const VIDEO = { ...SHOT, id: 'cccccccccccccccc', kind: 'recording' };

function fakeLayers(initial) {
  const state = { layers: initial, writes: 0 };
  return {
    state,
    get: () => state.layers,
    update: async (edit) => {
      const res = edit(state.layers);
      if (!res || res.error || !res.layers) return res || { error: 'failed' };
      state.layers = LayersModel.normalize(res.layers);
      state.writes++;
      return { ...res, layers: state.layers };
    },
  };
}

function deps({ entries = [SHOT, TALL, VIDEO], last = SHOT, reply, layers } = {}) {
  const log = { requests: [] };
  const byId = new Map(entries.map(e => [e.id, e]));
  const store = {
    get: (id) => byId.get(id) || null,
    last: async (kind) => (kind === 'screenshot' ? last : null),
    plan: async () => ({ id: SHOT.id, dir: 'C:\\x', file: SHOT.file, name: SHOT.name }),
    add: (e) => ({ id: e.id, kind: e.kind, name: SHOT.name, width: e.width, height: e.height }),
  };
  const capture = {
    host: { available: () => true, request: async (cmd, body) => { log.requests.push({ cmd, body }); return reply || { ok: true, width: 1600, height: 900, hdr: false, copied: true }; } },
    store: () => store,
    game: () => '',
    mkdir: async () => {},
    reveal: () => {},
    onSaved: () => {},
    hint: async () => 'Drag to pick an area',
  };
  return { d: { capture, layers: layers || fakeLayers(undefined) }, log };
}

const pins = (d) => LayersModel.normalize(d.layers.get()).widgets.filter(w => w.widget === LayersModel.PIN);

test('"last" pins the newest screenshot over everything, by id, in its shape', async () => {
  const { d, log } = deps();
  const r = await screenPin.run(d, { source: 'last' });
  assert.equal(r.ok, true);
  assert.equal(r.surface, 'overlay');
  assert.equal(r.name, SHOT.name);
  assert.equal(log.requests.length, 0, 'no picker for "last"');
  const [w] = pins(d);
  assert.equal(w.id, r.pinned);
  assert.equal(w.kind, 'tile');
  assert.equal(w.instance, SHOT.id);
  assert.ok(!JSON.stringify(d.layers.get()).includes('Pictures'), 'no path in the settings');
  assert.ok(!JSON.stringify(r).includes('Pictures'), 'no path in the result');
  assert.equal(LayersModel.normalize(d.layers.get()).enabled, true, 'pinning turns the layers on');
});

test('an id pins that screenshot; a video, an unknown id and no screenshot say why', async () => {
  const { d } = deps();
  const r = await screenPin.run(d, { id: TALL.id, surface: 'desktop' });
  assert.equal(r.ok, true);
  assert.equal(r.surface, 'desktop');
  assert.equal(pins(d)[0].instance, TALL.id);
  assert.deepEqual(await screenPin.run(d, { id: VIDEO.id }), { ok: false, error: 'not_a_picture' });
  assert.deepEqual(await screenPin.run(d, { id: 'dddddddddddddddd' }), { ok: false, error: 'not_found' });
  assert.deepEqual(await screenPin.run(deps({ last: null }).d, { source: 'last' }), { ok: false, error: 'no_file' });
  assert.equal(pins(d).length, 1, 'the errors wrote nothing');
});

test('"region" (the default) takes an area first, then pins what was saved', async () => {
  const { d, log } = deps();
  const r = await screenPin.run(d, {});
  assert.equal(r.ok, true);
  assert.equal(log.requests[0].cmd, 'screenshot');
  assert.equal(log.requests[0].body.target, 'region');
  assert.equal(pins(d)[0].instance, SHOT.id);
});

test('the picker answers pass through and pin nothing', async () => {
  const cancelled = deps({ reply: { ok: true, cancelled: true } });
  assert.deepEqual(await screenPin.run(cancelled.d, { source: 'region' }), { ok: true, cancelled: true });
  assert.equal(pins(cancelled.d).length, 0);
  // A second press while the picker is open: answered at once, nothing pinned.
  const second = deps();
  let picking;
  await pickerLock.hold(async () => { picking = await screenPin.run(second.d, {}); });
  assert.deepEqual(picking, { ok: true, picking: true });
  assert.equal(second.log.requests.length, 0);
  assert.equal(pins(second.d).length, 0);
});

test('a full screen of widgets refuses the pin with too_many', async () => {
  let layers = undefined;
  for (let i = 0; i < LayersModel.MAX_WIDGETS; i++) layers = LayersModel.addWidget(layers, { kind: 'tile', widget: 'weather' }).layers;
  const { d } = deps({ layers: fakeLayers(layers) });
  assert.deepEqual(await screenPin.run(d, { source: 'last' }), { ok: false, error: 'too_many' });
});

test('pinRect keeps the picture\'s shape and stays on screen', () => {
  const wide = LayersModel.pinRect(1600, 900);
  assert.ok(Math.abs(wide.h - wide.w) < 0.01, 'a 16:9 picture on a 16:9 screen is as tall as wide in fractions');
  const tall = LayersModel.pinRect(600, 1800);
  assert.ok(tall.h <= 0.6 + 1e-9, 'a tall picture is capped');
  assert.ok(Math.abs(tall.h / tall.w - 3 * 16 / 9) < 0.01, 'and keeps its shape');
  const unknown = LayersModel.pinRect(0, 0);
  assert.ok(Math.abs(unknown.h - unknown.w) < 0.01, 'no size: 16:9');
  for (const r of [wide, tall, unknown]) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9);
    assert.ok(Math.abs(r.x + r.w / 2 - 0.5) < 0.01, 'centered');
  }
});

test('unpinCapture takes every pin of that capture and nothing else', () => {
  let l = LayersModel.addWidget(undefined, { kind: 'tile', widget: 'weather' }).layers;
  l = LayersModel.addWidget(l, { kind: 'tile', widget: LayersModel.PIN, instance: SHOT.id, surface: 'overlay' }).layers;
  l = LayersModel.addWidget(l, { kind: 'tile', widget: LayersModel.PIN, instance: SHOT.id, surface: 'desktop' }).layers;
  l = LayersModel.addWidget(l, { kind: 'tile', widget: LayersModel.PIN, instance: TALL.id, surface: 'overlay' }).layers;
  const r = LayersModel.unpinCapture(l, SHOT.id);
  assert.equal(r.removed, 2);
  assert.deepEqual(r.layers.widgets.map(w => w.instance || w.widget).sort(), [TALL.id, 'weather'].sort());
  assert.deepEqual(LayersModel.unpinCapture(r.layers, SHOT.id), { error: 'not_found' });
});

test('a pin never asks for the full dashboard page', () => {
  const l = LayersModel.addWidget(undefined, { kind: 'tile', widget: LayersModel.PIN, instance: SHOT.id, surface: 'overlay' }).layers;
  const key = 'overlay:' + l.widgets[0].monitor;
  assert.equal(LayersModel.needsDashboard(l, key), false);
  assert.deepEqual(LayersModel.liteTilesFor(l, key), []);
});

test('the catalog entry, the runner and the AI function line up', async () => {
  const entry = CAPABILITIES.find(c => c.type === 'screenPin');
  assert.equal(entry.capability.risk, 'sensitive');
  assert.equal(entry.capability.requires, 'layers');
  assert.deepEqual(entry.params.find(p => p.name === 'source').options, screenPin.SOURCES.slice());
  assert.deepEqual(entry.params.find(p => p.name === 'surface').options, screenPin.SURFACES.slice());
  assert.ok(aiFunctions({ layers: true }).some(f => f.name === 'pin_screenshot'));
  assert.ok(!aiFunctions({ layers: false }).some(f => f.name === 'pin_screenshot'));
  const { d } = deps();
  const run = createCapabilities({ capture: d.capture, layers: d.layers, layersHost: { available: () => true } });
  const r = await run.run({ type: 'screenPin', source: 'last' });
  assert.equal(r.ok, true);
});

test('"the pin" names a placed pin for a move, so Bit can make it see-through', async () => {
  const { d } = deps();
  const L = d.layers;
  L.catalog = async () => ({ tiles: ['weather'], packages: [] });
  await screenPin.run(d, { source: 'last' });
  const run = createCapabilities({ capture: d.capture, layers: L, layersHost: { available: () => true } });
  const r = await run.run({ type: 'layerMove', target: 'pin', opacity: '40' });
  assert.equal(r.ok, true);
  assert.equal(pins(d)[0].opacity, 0.4);
  await screenPin.run(d, { id: TALL.id });
  assert.equal((await run.run({ type: 'layerMove', target: 'pin', opacity: '50' })).error, 'ambiguous', 'two pins: the id decides');
});

test('the pin key says where it stays in its own words, in 11 languages', () => {
  const entry = CAPABILITIES.find(c => c.type === 'screenPin');
  const surface = entry.params.find(p => p.name === 'surface');
  assert.equal(surface.labelKey, 'deck_param_screenPin_surface');
  assert.deepEqual({ ...surface.optionKeys }, { overlay: 'deck_opt_over_windows' });
  const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  for (const k of ['deck_param_screenPin_surface', 'deck_opt_over_windows', 'deck_opt_desktop', 'deck_act_screenPin', 'deck_param_screenPin_source', 'deck_opt_last']) {
    assert.equal((i18n.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 11, k);
  }
  const editor = readFileSync(new URL('../js/deck-editor.js', import.meta.url), 'utf8');
  assert.match(editor, /const key = \(p\.optionKeys && p\.optionKeys\[o\]\) \|\| \('deck_opt_' \+ o\);/);
});
