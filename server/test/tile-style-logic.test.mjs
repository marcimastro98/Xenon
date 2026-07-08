import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeTileStyle, normalizeCopies } = require('../js/dashboard-instances.js');
const { normalizePresets, insertPreset } = require('../js/dashboard-presets.js');

// Per-tile visual style: the shared normalizer is the single validation boundary
// (layout stores + imported presets). It keeps only known, well-formed fields and
// drops everything else, so a hostile or stale style can never widen a tile's
// influence beyond its own accent/panel/text/opacity/font.

const KNOWN = ['media', 'system', 'chat'];

test('normalizeTileStyle keeps valid custom fields and lowercases hex', () => {
  const s = normalizeTileStyle({ mode: 'custom', accent: '#FF7EB6', panel: '#111314', text: '#eeeeee', panelAlpha: 0.5, font: 'vt323' });
  assert.deepEqual(s, { mode: 'custom', accent: '#ff7eb6', panel: '#111314', text: '#eeeeee', panelAlpha: 0.5, font: 'vt323' });
});

test('normalizeTileStyle drops bad hex, out-of-range alpha, unknown font and unknown keys', () => {
  const s = normalizeTileStyle({ mode: 'custom', accent: 'red', panel: '#12', panelAlpha: 5, font: 'comic', evil: '<script>' });
  assert.deepEqual(s, { mode: 'custom' });   // custom mode kept, every invalid field stripped
});

test('normalizeTileStyle collapses a pure inherit with nothing set to null', () => {
  assert.equal(normalizeTileStyle({ mode: 'inherit' }), null);
  assert.equal(normalizeTileStyle(null), null);
  assert.equal(normalizeTileStyle('nope'), null);
});

test('normalizeTileStyle clamps panelAlpha precision and rejects font "inherit"', () => {
  const s = normalizeTileStyle({ mode: 'custom', panelAlpha: 0.333333, font: 'inherit' });
  assert.equal(s.panelAlpha, 0.33);
  assert.equal('font' in s, false);
});

test('normalizeTileStyle keeps the extended tokens (muted/radius/glass/border/shadow)', () => {
  const s = normalizeTileStyle({ mode: 'custom', mutedText: '#AABBCC', radius: 1.5, glassBlur: 30, glassSaturate: 180, borderStrength: 0.5, shadowStrength: 1.2 });
  assert.deepEqual(s, { mode: 'custom', mutedText: '#aabbcc', radius: 1.5, glassBlur: 30, glassSaturate: 180, borderStrength: 0.5, shadowStrength: 1.2 });
});

test('normalizeTileStyle drops out-of-range extended tokens', () => {
  const s = normalizeTileStyle({ mode: 'custom', mutedText: 'nope', radius: 9, glassBlur: 999, glassSaturate: 50, borderStrength: -1, shadowStrength: 5 });
  assert.deepEqual(s, { mode: 'custom' });   // every extended field out of range → dropped
});

test('normalizeCopies carries a valid style and omits it when absent/invalid', () => {
  const widgets = { media: { x: 0, y: 0, w: 8, h: 6, visible: true, page: 'dashboard' } };
  const out = normalizeCopies([
    { id: 'media~a1', widget: 'media', x: 0, y: 0, w: 8, h: 6, page: 'dashboard', style: { mode: 'custom', accent: '#00ff00' } },
    { id: 'media~b2', widget: 'media', x: 0, y: 0, w: 8, h: 6, page: 'dashboard', style: { mode: 'inherit' } },
  ], widgets, ['dashboard']);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].style, { mode: 'custom', accent: '#00ff00' });
  assert.equal('style' in out[1], false);   // inherit-only collapses away
});

test('page preset round-trips a valid tile style and strips a malformed one', () => {
  const out = normalizePresets([{
    id: 'pg', name: 'Styled', kind: 'page', createdAt: 1, gridCols: 24,
    data: {
      items: [
        { type: 'widget', widget: 'system', x: 0, y: 0, w: 8, h: 6, style: { mode: 'custom', accent: '#1ed760', font: 'pressstart' } },
        { type: 'widget', widget: 'media', x: 8, y: 0, w: 8, h: 6, style: { mode: 'custom', accent: 'not-a-color', bad: 1 } },
      ],
    },
  }], KNOWN);
  const items = out[0].data.items;
  assert.deepEqual(items[0].style, { mode: 'custom', accent: '#1ed760', font: 'pressstart' });
  assert.deepEqual(items[1].style, { mode: 'custom' });   // invalid accent + unknown key dropped, mode survives
});

test('inserting a page preset materialises the widget WITH its per-tile style', () => {
  const layout = {
    widgets: { system: { x: 0, y: 0, w: 8, h: 6, visible: false, page: 'dashboard' } },
    copies: [], groups: {}, pages: [{ id: 'dashboard', name: 'D' }],
  };
  const preset = {
    kind: 'page', name: 'Styled page',
    data: { items: [{ type: 'widget', widget: 'system', x: 0, y: 0, w: 8, h: 6, style: { mode: 'custom', accent: '#1ed760' } }] },
  };
  const res = insertPreset(layout, preset);
  assert.equal(res.ok, true);
  assert.equal(layout.widgets.system.visible, true);
  assert.deepEqual(layout.widgets.system.style, { mode: 'custom', accent: '#1ed760' });
});
