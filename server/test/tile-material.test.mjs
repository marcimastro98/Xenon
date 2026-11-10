// The six materials of the style window. They are plain values in keys a tile
// style already had: a card that stored something new would break copied styles,
// shared pages and the Maker, so the round trip is what these tests pin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const DI = require('../js/dashboard-instances.js');
globalThis.window = { DashboardInstances: DI };
const TM = require('../js/tile-material.js');
const { workingCopy, buildStyle } = require('../js/tile-style-editor.js');

const luminance = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('every material survives the store and is recognised on the way back', () => {
  for (const { id } of TM.MATERIALS) {
    const work = workingCopy({});
    assert.equal(TM.applyMaterial(work, id), true, id);
    const stored = buildStyle(work);
    assert.equal(TM.materialOf(stored || {}), id, id);
    assert.equal(TM.materialOf(workingCopy(stored || {})), id, `${id} after reopening the window`);
  }
});

test('a tile with no style of its own is on the theme card', () => {
  assert.equal(TM.materialOf({}), 'theme');
  assert.equal(TM.materialOf(null), 'theme');
  assert.equal(TM.materialOf(workingCopy({})), 'theme');
});

test('choosing the theme clears the values, so nothing is left stored', () => {
  const work = workingCopy({ mode: 'inherit', panelAlpha: 0.35, glassBlur: 10, glassSaturate: 180 });
  TM.applyMaterial(work, 'theme');
  assert.equal(buildStyle(work), null);
});

test('values of the user\'s own match no card', () => {
  assert.equal(TM.materialOf({ panelAlpha: 0.6, glassBlur: 22, glassSaturate: 160 }), '');
  assert.equal(TM.materialOf({ glassBlur: 22 }), '');
});

test('a material leaves the colours and the edges alone', () => {
  const work = workingCopy({ mode: 'custom', panel: '#112233', radius: 0.5, borderStrength: 2 });
  TM.applyMaterial(work, 'frosted');
  const stored = buildStyle(work);
  assert.equal(stored.panel, '#112233');
  assert.equal(stored.radius, 0.5);
  assert.equal(stored.borderStrength, 2);
  assert.equal(stored.panelAlpha, 0.72);
});

test('an unknown material changes nothing', () => {
  const style = { panelAlpha: 0.4 };
  assert.equal(TM.applyMaterial(style, 'chrome'), false);
  assert.deepEqual(style, { panelAlpha: 0.4 });
});

test('the theme\'s text stays readable on every tint', () => {
  for (const tint of TM.tintsFor('dark')) assert.ok(contrast(tint, '#f2f4f3') >= 4.5, tint);
  for (const tint of TM.tintsFor('light')) assert.ok(contrast(tint, '#14181c') >= 4.5, tint);
});

test('both tones offer the same number of tints, all valid colours', () => {
  assert.equal(TM.tintsFor('dark').length, TM.tintsFor('light').length);
  for (const tint of [...TM.tintsFor('dark'), ...TM.tintsFor('light')]) {
    assert.equal(DI.normalizeTileStyle({ mode: 'custom', panel: tint }).panel, tint);
  }
});

test('a request Bit cannot carry out comes back with the real choices', () => {
  const ids = TM.MATERIALS.map((m) => m.id);
  assert.equal(TM.requestMiss({ material: 'clear' }), null);
  assert.equal(TM.requestMiss({ tint: '#6D28D9' }), null);
  assert.equal(TM.requestMiss({ tint: 'none' }), null);
  assert.equal(TM.requestMiss({ material: 'theme', tint: 'none' }), null);
  assert.deepEqual(TM.requestMiss({ material: 'wood' }), { ok: false, error: 'unknown_material', materials: ids });
  assert.equal(TM.requestMiss({ tint: 'violet' }).error, 'bad_tint');
  assert.equal(TM.requestMiss({ tint: '#123' }).error, 'bad_tint');
  assert.equal(TM.requestMiss({}).error, 'nothing_to_change');
  assert.equal(TM.requestMiss().error, 'nothing_to_change');
});
