// js/screen-scene-model.js: which animated wallpapers and screensavers exist
// right now, outside the dashboard. Both are off unless the user turns them on,
// never cover the dashboard's own screen when there are others, and a game
// closes both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../js/screen-scene-model.js');

const DISPLAYS = [{ id: 'A', primary: true }, { id: 'B' }, { id: 'C' }];
const amb = (o) => ({ ambientMode: { enabled: true, wallpaper: false, saverMinutes: 0, ...o } });
const keys = (ctx) => M.surfaces(ctx).map((s) => s.key);

test('off by default: nothing at all', () => {
  assert.deepEqual(keys({ settings: amb({}), displays: DISPLAYS, active: 'A', status: { idleSec: 99999 } }), []);
  assert.deepEqual(keys({ settings: {}, displays: DISPLAYS, active: 'A' }), []);
  assert.deepEqual(keys(null), []);
  assert.equal(M.wantsIdle({}), false);
});

test('the wallpaper goes on every screen but the dashboard one', () => {
  assert.deepEqual(keys({ settings: amb({ wallpaper: true }), displays: DISPLAYS, active: 'A' }), ['wallpaper:B', 'wallpaper:C']);
  const s = M.surfaces({ settings: amb({ wallpaper: true }), displays: DISPLAYS, active: 'B' })[0];
  assert.deepEqual(s, { key: 'wallpaper:A', kind: 'wallpaper', monitor: 'A' });
});

test('one screen, or no dashboard: every screen', () => {
  assert.deepEqual(keys({ settings: amb({ wallpaper: true }), displays: [{ id: 'A' }], active: 'A' }), ['wallpaper:A']);
  assert.deepEqual(keys({ settings: amb({ wallpaper: true }), displays: DISPLAYS, active: 'A', noDashboard: true }),
    ['wallpaper:A', 'wallpaper:B', 'wallpaper:C']);
});

test('Ambient turned off turns both off', () => {
  assert.deepEqual(keys({ settings: amb({ enabled: false, wallpaper: true, saverMinutes: 5 }), displays: DISPLAYS, active: 'A', status: { idleSec: 600 } }), []);
  assert.equal(M.wantsIdle(amb({ enabled: false, saverMinutes: 5 })), false);
});

test('the screensaver comes after the chosen idle time, not before', () => {
  const base = { settings: amb({ saverMinutes: 5 }), displays: DISPLAYS, active: 'A' };
  assert.deepEqual(keys({ ...base, status: { idleSec: 299 } }), []);
  assert.deepEqual(keys({ ...base, status: { idleSec: 300 } }), ['saver:B', 'saver:C']);
  assert.deepEqual(keys({ ...base, status: { idleSec: null } }), [], 'no idle reading = no saver');
  assert.deepEqual(keys({ ...base, status: null }), []);
  assert.deepEqual(keys({ ...base, status: { idleSec: 'x' } }), []);
  assert.equal(M.wantsIdle(base.settings), true);
});

test('a game closes both', () => {
  const ctx = { settings: amb({ wallpaper: true, saverMinutes: 5 }), displays: DISPLAYS, active: 'A' };
  assert.deepEqual(keys({ ...ctx, status: { idleSec: 900, gaming: false } }), ['wallpaper:B', 'wallpaper:C', 'saver:B', 'saver:C']);
  assert.deepEqual(keys({ ...ctx, status: { idleSec: 900, gaming: true } }), []);
});

test('stored values outside the list read as off', () => {
  for (const v of [3, -1, '5x', null, 1e9]) assert.equal(M.settingsOf(amb({ saverMinutes: v })).saverMinutes, 0, String(v));
  assert.equal(M.settingsOf(amb({ saverMinutes: '10' })).saverMinutes, 10);
  assert.equal(M.settingsOf(amb({ wallpaper: 'yes' })).wallpaper, false);
});

test('monitor ids the shell would refuse are dropped', () => {
  const displays = [{ id: 'A' }, { id: 'bad\nid' }, { id: 'x'.repeat(65) }, {}, null, { id: '' }];
  assert.deepEqual(keys({ settings: amb({ wallpaper: true }), displays, active: '', noDashboard: true }), ['wallpaper:A']);
  assert.deepEqual(keys({ settings: amb({ wallpaper: true }), displays: 'nope', active: 'A' }), []);
});

test('scene keys', () => {
  for (const k of ['wallpaper:A', 'saver:\\\\.\\DISPLAY1']) assert.equal(M.isSceneKey(k), true, k);
  for (const k of ['overlay:A', 'saver:', 'wallpaper', ':A', 'wallpaper:a\nb', 5, null]) assert.equal(M.isSceneKey(k), false, String(k));
});

test('the scene page fetches only what its scene draws', () => {
  const names = (s) => [...s].sort();
  assert.deepEqual(names(M.readingsFor({ builtin: true }, {})), ['calendar', 'weather']);
  assert.deepEqual(names(M.readingsFor({ builtin: true }, { weather: false, calendar: false })), []);
  assert.deepEqual(names(M.readingsFor({ builtin: false, pkg: { id: 'x' } })), ['weather']);
  const canvas = { canvas: true, scene: { components: [{ type: 'clock' }, { type: 'agenda' }, { type: 'network' }, { type: 'notes' }, { type: 'toString' }, null] } };
  assert.deepEqual(names(M.readingsFor(canvas)), ['calendar', 'network', 'notes']);
  assert.deepEqual(names(M.readingsFor(null)), []);
});
