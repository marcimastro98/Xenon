import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWidgetKeys } = require('../widget-keys.js');

const W = (id, key, over = {}) => ({ id, kind: 'tile', widget: 'weather', surface: 'overlay', rect: { x: 0, y: 0, w: 0.2, h: 0.2 }, ...(key ? { key } : {}), ...over });

function rig(widgets) {
  let layers = { enabled: true, widgets };
  let changes = 0;
  const pending = new Map();
  let n = 0;
  const timers = {
    setTimeout: (fn) => { n += 1; pending.set(n, fn); return n; },
    clearTimeout: (t) => pending.delete(t),
  };
  const keys = createWidgetKeys({ layers: () => layers, onChange: () => { changes += 1; }, timers });
  return {
    keys,
    set: (next) => { layers = { enabled: true, widgets: next }; },
    changes: () => changes,
    fire: () => { const all = [...pending.values()]; pending.clear(); all.forEach((fn) => fn()); },
    pending: () => pending.size,
  };
}

test('a pressed key hides the widget and the next press shows it again', () => {
  const r = rig([W('lw_aaaa0001', { combo: 'ctrl+shift+1' })]);
  assert.deepEqual(r.keys.hidden(), []);
  assert.equal(r.keys.press('lw_aaaa0001'), true);
  assert.deepEqual(r.keys.hidden(), ['lw_aaaa0001']);
  r.keys.press('lw_aaaa0001');
  assert.deepEqual(r.keys.hidden(), []);
  assert.equal(r.changes(), 2, 'every switch is pushed at once');
});

test('a held key shows the widget only while it is down', () => {
  const r = rig([W('lw_aaaa0001', { combo: 'ctrl+shift+1', hold: true })]);
  r.keys.setRelease(true);
  assert.deepEqual(r.keys.hidden(), ['lw_aaaa0001'], 'hidden until held');
  r.keys.press('lw_aaaa0001');
  assert.deepEqual(r.keys.hidden(), []);
  r.keys.press('lw_aaaa0001');
  assert.equal(r.changes(), 1, 'the key repeating changes nothing');
  r.keys.release('lw_aaaa0001');
  assert.deepEqual(r.keys.hidden(), ['lw_aaaa0001']);
  assert.equal(r.keys.release('lw_aaaa0001'), false);
});

test('with no release to wait for, a press shows a held widget for a few seconds', () => {
  const r = rig([W('lw_aaaa0001', { combo: 'ctrl+shift+1', hold: true })]);
  r.keys.press('lw_aaaa0001');
  assert.deepEqual(r.keys.hidden(), []);
  r.keys.press('lw_aaaa0001');
  assert.equal(r.pending(), 1, 'a second press starts the time again, never two timers');
  r.fire();
  assert.deepEqual(r.keys.hidden(), ['lw_aaaa0001']);
});

test('the helper going away lets go of what it held', () => {
  const r = rig([W('lw_aaaa0001', { combo: 'ctrl+shift+1', hold: true })]);
  r.keys.setRelease(true);
  r.keys.press('lw_aaaa0001');
  r.keys.setRelease(false);
  assert.deepEqual(r.keys.hidden(), ['lw_aaaa0001']);
});

test('one binding per box, never on a taken combo or past the room left', () => {
  const r = rig([
    W('lw_aaaa0001', { combo: 'ctrl+shift+1' }, { group: 'lt_box00001' }),
    W('lw_aaaa0002', { combo: 'ctrl+shift+1' }, { group: 'lt_box00001' }),
    W('lw_aaaa0003', { combo: 'ctrl+shift+2' }),
    W('lw_aaaa0004', { combo: 'ctrl+shift+2' }),
    W('lw_aaaa0005', { combo: 'ctrl+shift+3' }),
    W('lw_aaaa0006'),
  ]);
  assert.deepEqual(r.keys.bindings().map((b) => b.widgetId), ['lw_aaaa0001', 'lw_aaaa0003', 'lw_aaaa0005']);
  assert.deepEqual(r.keys.bindings(['ctrl+shift+2']).map((b) => b.combo), ['ctrl+shift+1', 'ctrl+shift+3']);
  assert.equal(r.keys.bindings([], 1).length, 1);
  assert.equal(r.keys.bindings()[0].slot, 'widget-lw_aaaa0001');
  assert.equal(r.keys.press('lw_aaaa0006'), false, 'a widget with no key is not pressed');
});

test('a widget removed or its key changed starts over, and stop clears its timers', () => {
  const r = rig([W('lw_aaaa0001', { combo: 'ctrl+shift+1' }), W('lw_aaaa0002', { combo: 'ctrl+shift+2', hold: true })]);
  r.keys.press('lw_aaaa0001');
  r.keys.press('lw_aaaa0002');
  r.set([W('lw_aaaa0001', { combo: 'ctrl+shift+1', hold: true }), W('lw_aaaa0002', { combo: 'ctrl+shift+2' })]);
  assert.deepEqual(r.keys.hidden(), ['lw_aaaa0001'], 'now held: hidden until held; the other is shown again');
  assert.equal(r.pending(), 0, 'the peek of a key that stopped holding is cancelled');
  r.keys.press('lw_aaaa0001');
  r.keys.stop();
  assert.equal(r.pending(), 0);
});
