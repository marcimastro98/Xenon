// capabilities/screen-draw.js: drawing on the screen for the Deck, Bit and
// widgets. Pinned here: the engine gets the mode and the hint in the user's
// language (no hint to close it); an unknown mode is the toggle; the answer is
// only whether it is open; engine errors are known codes or "failed"; it is a
// `layers` action for widgets; catalog, runner and AI line up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const draw = require('../capabilities/screen-draw.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const { CAPABILITIES } = require('../js/capability-catalog.js');
const { SDK_ACTION_CATEGORIES } = require('../sdk-widgets.js');

function deps(reply, { available = true } = {}) {
  const log = { requests: [], hints: 0 };
  const capture = {
    host: {
      available: () => available,
      request: async (cmd, body) => { log.requests.push({ cmd, body }); return reply; },
    },
    drawHint: async () => { log.hints++; return 'Draw with the mouse.'; },
  };
  return { d: { capture }, log };
}

test('opening sends the mode and the hint; closing sends no hint', async () => {
  const { d, log } = deps({ ok: true, drawing: true, monitor: 1 });
  assert.deepEqual(await draw.run(d, { mode: 'start' }), { ok: true, drawing: true });
  assert.deepEqual(log.requests[0], { cmd: 'draw', body: { action: 'start', hint: 'Draw with the mouse.' } });
  const off = deps({ ok: true, drawing: false });
  assert.deepEqual(await draw.run(off.d, { mode: 'stop' }), { ok: true, drawing: false });
  assert.deepEqual(off.log.requests[0].body, { action: 'stop', hint: '' });
  assert.equal(off.log.hints, 0);
});

test('an unknown or missing mode is the toggle; a broken hint does not stop it', async () => {
  const { d, log } = deps({ ok: true, drawing: true });
  await draw.run(d, { mode: 'erase' });
  await draw.run(d, {});
  assert.deepEqual(log.requests.map(r => r.body.action), ['toggle', 'toggle']);
  d.capture.drawHint = async () => { throw new Error('no strings'); };
  assert.equal((await draw.run(d, { mode: 'start' })).ok, true);
  assert.equal(log.requests[2].body.hint, '');
});

test('engine errors are known codes or "failed"; no engine is "unavailable"', async () => {
  assert.deepEqual(await draw.run(deps({ ok: false, error: 'unsupported' }).d, {}), { ok: false, error: 'unsupported' });
  assert.deepEqual(await draw.run(deps({ ok: false, error: 'draw_failed' }).d, {}), { ok: false, error: 'failed' });
  assert.deepEqual(await draw.run(deps(null).d, {}), { ok: false, error: 'failed' });
  assert.deepEqual(await draw.run(deps({ ok: true }, { available: false }).d, {}), { ok: false, error: 'unavailable' });
  assert.deepEqual(await draw.run({}, {}), { ok: false, error: 'unavailable' });
  // "drawing" is true only when the engine says so.
  assert.deepEqual(await draw.run(deps({ ok: true, drawing: 'yes' }).d, {}), { ok: true, drawing: false });
});

test('the catalog entry, the runner, the AI function and the SDK category line up', async () => {
  const c = CAPABILITIES.find(x => x.type === 'screenDraw');
  assert.equal(c.group, 'capture');
  assert.equal(c.capability.risk, 'safe');
  assert.equal(c.capability.requires, 'captureDraw');
  assert.deepEqual(c.params.find(p => p.name === 'mode').options, draw.MODES.slice());
  assert.ok(aiFunctions({ capture: true }).some(f => f.name === 'draw_on_screen'));
  assert.ok(!aiFunctions({ captureDraw: false }).some(f => f.name === 'draw_on_screen'));
  assert.deepEqual(aiAction('draw_on_screen', { mode: 'stop', extra: 1 }), { type: 'screenDraw', mode: 'stop' });
  const { d } = deps({ ok: true, drawing: true });
  assert.equal((await createCapabilities({ capture: d.capture }).run({ type: 'screenDraw' })).drawing, true);
  assert.ok(SDK_ACTION_CATEGORIES.layers.includes('screenDraw'));
  const bridge = readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'latin1');
  assert.match(bridge, /layers: \['layersToggle', 'layerPage', 'screenDraw', 'xenonMenu', 'gameCompanion'\]/);
});

test('the strings and the Deck icon exist, in 11 languages', () => {
  const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  for (const k of ['deck_act_screenDraw', 'draw_hint', 'cw_act_layers']) {
    assert.equal((i18n.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 11, k);
  }
  // The hint sits under the bar on one line: the engine cuts it at 160.
  for (const m of i18n.matchAll(/\bdraw_hint: '((?:[^'\\]|\\.)*)'/g)) assert.ok(m[1].length <= 160, m[1]);
  assert.match(readFileSync(new URL('../js/deck-editor.js', import.meta.url), 'utf8'), /screenDraw: _ai\(/);
});
