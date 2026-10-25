// The style editor has no "Follow theme / Customize" switch any more: a colour,
// gradient or font the user sets IS the customization. These tests pin the round
// trip between a stored style and the editor's working copy, so the dashboard
// and the online Maker keep reading the same format.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const DI = require('../js/dashboard-instances.js');
globalThis.window = { DashboardInstances: DI };
const { workingCopy, buildStyle } = require('../js/tile-style-editor.js');

const roundTrip = (style) => buildStyle(workingCopy(style || {}));

test('a colour set in the editor turns the style custom on its own', () => {
  const work = workingCopy({});
  work.accent = '#ff7eb6';
  assert.deepEqual(buildStyle(work), { mode: 'custom', accent: '#ff7eb6' });
});

test('an untouched editor saves nothing', () => {
  assert.equal(roundTrip(null), null);
});

test('effects alone stay on the theme colours', () => {
  const work = workingCopy({});
  work.panelAlpha = 0.55;
  const s = buildStyle(work);
  assert.equal(s.mode, 'inherit');
  assert.equal(s.panelAlpha, 0.55);
  assert.equal(s.accent, undefined);
});

test('colours stored without custom mode are not shown as the user\'s', () => {
  const work = workingCopy({ mode: 'inherit', accent: '#ff0000', font: 'vt323', contrastGuard: false });
  assert.equal(work.accent, '');
  assert.equal(work.font, 'inherit');
  assert.equal(work.contrastGuard, null);
});

test('the contrast toggle is kept only with custom colours', () => {
  const work = workingCopy({});
  work.contrastGuard = false;
  assert.equal(buildStyle(work), null, 'nothing to guard, nothing stored');
  work.text = '#222222';
  assert.equal(buildStyle(work).contrastGuard, false);
});

test('a custom style survives the round trip', () => {
  const style = DI.normalizeTileStyle({
    mode: 'custom', accent: '#ff7eb6', panel: '#111314', font: 'vt323', contrastGuard: false,
    panelGrad: { c1: '#112233', c2: '#445566', angle: 90 },
  });
  assert.deepEqual(roundTrip(style), style);
});

test('clearing the last colour goes back to the theme', () => {
  const work = workingCopy({ mode: 'custom', accent: '#ff7eb6' });
  work.accent = '';
  assert.equal(buildStyle(work), null);
});

test('a background picture with no dim set starts undimmed', () => {
  assert.equal(workingCopy({}).decor.bg.dim, 0);
});
