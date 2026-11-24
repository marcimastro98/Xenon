// Xenon drawing on a pump screen by itself in the Xenon menu (menu/menu-pump-direct.js): the card of
// a pump just found leads with the switch and says what happens now, iCUE stays a second way only
// where it is installed, a failure offers "Try again", and a pump's Look tab carries the switch on
// the first screen. Where Xenon cannot draw itself (macOS, a copy beside the real one) nothing changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pumpViews } = require('../menu/menu-pump.js');
const { directRows } = require('../menu/menu-pump-direct.js');
const Model = require('../js/pump/pump-model.js');

const CORSAIR = { brand: 'corsair', route: 'icue', vendorId: 0x1b1c, productId: 0x0c4e, direct: true };
const state = (pump) => ({ probes: {}, pump: { icue: true, detected: [CORSAIR], screens: [], url: 'http://127.0.0.1:3030/pump-face', ...pump } });
const ids = (rows) => rows.map((r) => r.id);
const card = (pump) => pumpViews(state(pump))[0];

test('a pump Xenon can draw on leads with the switch, and a tap on the card no longer opens iCUE', () => {
  const c = card({ direct: { on: true, state: 'busy', app: 'iCUE' } });
  assert.deepEqual(ids(c.tabs[0].rows), ['pump-direct', 'pump-icue']);
  const sw = c.tabs[0].rows[0];
  assert.equal(sw.kind, 'toggle');
  assert.equal(sw.on, true);
  assert.deepEqual(sw.sub, { key: 'xmenu_pump_direct_busy_sub', vars: { app: 'iCUE' } });
  assert.deepEqual(sw.acts, { on: { run: { type: 'pumpDirect', on: 'on' } }, off: { run: { type: 'pumpDirect', on: 'off' } } });
  assert.equal(c.tabs[0].rows[1].primary, false, 'iCUE is the second way');
  assert.equal(c.act, null);
  assert.deepEqual(c.chip, { key: 'xmenu_pump_found_direct' });
});

test('without iCUE (Linux, or not installed) the card never asks for it', () => {
  const c = card({ icue: false, direct: { on: true, state: 'busy', app: 'OpenLinkHub' } });
  assert.deepEqual(ids(c.tabs[0].rows), ['pump-direct']);
  assert.deepEqual(c.tabs[0].rows[0].sub.vars, { app: 'OpenLinkHub' });
});

test('each state says what is true now, and a failure offers to try again', () => {
  const sub = (direct) => directRows(state({ direct }))[0].sub.key;
  assert.equal(sub({ on: false, state: 'off' }), 'xmenu_pump_direct_off_sub');
  assert.equal(sub({ on: true, state: 'drawing', model: 'x' }), 'xmenu_pump_direct_drawing_sub');
  assert.equal(sub({ on: true, state: 'none' }), 'xmenu_pump_direct_none_sub');
  assert.equal(sub({ on: true, state: 'off' }), 'xmenu_pump_direct_none_sub', 'just turned on, before the first look');
  const failed = directRows(state({ direct: { on: true, state: 'failed', reason: 'hung' } }));
  assert.deepEqual(ids(failed), ['pump-direct', 'pump-direct-retry']);
  assert.deepEqual(failed[1].act, { run: { type: 'pumpDirect', on: 'on' } });
  assert.equal(directRows(state({ direct: { on: false, state: 'off' } })).length, 1, 'no retry while off');
});

test('no switch where Xenon cannot draw itself, or with no such screen plugged in', () => {
  assert.deepEqual(directRows(state({ direct: null })), []);
  assert.deepEqual(directRows(state({ direct: { on: true, state: 'none' }, detected: [{ ...CORSAIR, productId: 0x0c39, direct: false }] })), []);
  const old = card({ direct: null });
  assert.deepEqual(ids(old.tabs[0].rows), ['pump-icue']);
  assert.deepEqual(old.act, { run: { type: 'pumpIcue' } }, 'as before: a tap takes the iCUE step');
  assert.deepEqual(old.chip, { key: 'xmenu_pump_found_icue' });
});

test('a pump showing Xenon has the switch in its Look tab, on the first screen only', () => {
  const screen = (id) => ({ screen: id, ...Model.screenFor({ screens: {}, seen: {} }, id), set: false, here: true, seen: { shape: 'round', w: 480, h: 480, via: 'direct' }, now: null });
  const views = pumpViews(state({ screens: [screen('pump'), screen('two')], direct: { on: true, state: 'drawing', model: 'iCUE LINK AIO LCD' } }));
  const look = (v) => v.tabs.find((t) => t.id === 'look');
  assert.ok(ids(look(views[0]).rows).includes('pump-direct'));
  assert.ok(!ids(look(views[1]).rows).includes('pump-direct'));
});
