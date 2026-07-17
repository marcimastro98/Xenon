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

test('normalizeTileStyle round-trips the complete semantic widget palette', () => {
  const s = normalizeTileStyle({
    mode: 'custom', surfaceAlt: '#F4F1E8', controlColor: '#E8E1D0',
    lineColor: '#50483E', accentText: '#FFFFFF', successColor: '#147A4A',
    warningColor: '#805800', dangerColor: '#BD303B', infoColor: '#176783',
    contrastGuard: false,
  });
  assert.deepEqual(s, {
    mode: 'custom', surfaceAlt: '#f4f1e8', controlColor: '#e8e1d0',
    lineColor: '#50483e', accentText: '#ffffff', successColor: '#147a4a',
    warningColor: '#805800', dangerColor: '#bd303b', infoColor: '#176783',
    contrastGuard: false,
  });
});

test('normalizeTileStyle accepts a panel-background gradient and drops a half one', () => {
  const s = normalizeTileStyle({ mode: 'custom', panelGrad: { c1: '#1ED760', c2: '#0A0D12', angle: 90 } });
  assert.deepEqual(s.panelGrad, { c1: '#1ed760', c2: '#0a0d12', angle: 90 });
  assert.equal('panelGrad' in normalizeTileStyle({ mode: 'custom', panelGrad: { c1: '#1ed760' } }), false); // needs both stops
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

// ── Per-tile DECOR (images + effects) ───────────────────────────────────────
const DATA_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

test('normalizeTileStyle accepts a full valid decor and clamps its values', () => {
  const s = normalizeTileStyle({
    mode: 'inherit',
    decor: {
      bg: { src: DATA_PNG, fit: 'cover', dim: 40, blur: 3, opacity: 90 },
      frame: { preset: 'sengoku', width: 12 },
      overlays: [{ src: DATA_PNG, anchor: 'bottom-right', size: 35, opacity: 80, rotate: 10, flip: true }, { preset: 'dragon' }],
    },
  });
  assert.equal(s.mode, 'inherit');                 // decor rides an inherit tile
  assert.equal(s.decor.bg.src, DATA_PNG);
  assert.equal(s.decor.frame.preset, 'sengoku');
  assert.equal(s.decor.overlays.length, 2);
  assert.equal(s.decor.overlays[1].preset, 'dragon');
  assert.equal(s.decor.overlays[1].anchor, 'bottom-right'); // default anchor filled
});

test('normalizeTileDecor rejects non-image / non-local srcs (only data: and /uploads /assets/decor)', () => {
  assert.equal(normalizeTileStyle({ decor: { bg: { src: 'javascript:alert(1)' } } }), null);
  assert.equal(normalizeTileStyle({ decor: { bg: { src: 'http://evil.example/x.png' } } }), null);
  assert.equal(normalizeTileStyle({ decor: { overlays: [{ src: 'file:///etc/passwd' }] } }), null);
  const ok = normalizeTileStyle({ decor: { bg: { src: '/uploads/tileasset-1-ab.png' } } });
  assert.equal(ok.decor.bg.src, '/uploads/tileasset-1-ab.png');
});

test('normalizeTileDecor drops unknown frame/overlay presets and caps overlays at 4', () => {
  const s = normalizeTileStyle({
    decor: {
      frame: { preset: '../etc' },   // not in the curated set
      overlays: [{ preset: 'dragon' }, { preset: 'koi' }, { preset: 'wave' }, { preset: 'moon' }, { preset: 'dragon' }],
    },
  });
  assert.equal('frame' in s.decor, false);         // bad preset → frame dropped
  assert.equal(s.decor.overlays.length, 4);        // 5th overlay dropped
});

test('normalizeTileDecor ignores the removed glow/anim effect keys entirely', () => {
  // Effects were removed; any leftover glow/anim on an imported/persisted decor is dropped.
  assert.equal(normalizeTileStyle({ decor: { glow: { color: '#ff2200', strength: 1.5 } } }), null);
  assert.equal(normalizeTileStyle({ decor: { anim: 'breathe' } }), null);
  const s = normalizeTileStyle({ decor: { bg: { grad: { c1: '#1ed760', c2: '#0a0d12' } }, glow: { color: '#fff', strength: 1 }, anim: 'argb' } });
  assert.equal('glow' in s.decor, false);
  assert.equal('anim' in s.decor, false);
});

test('normalizeTileDecor refuses a decor that blows the inline-bytes budget', () => {
  const huge = 'data:image/png;base64,' + 'A'.repeat(2000000);   // ~2MB, > overlay cap
  const s = normalizeTileStyle({ decor: { bg: { src: DATA_PNG }, overlays: [{ src: huge }] } });
  // The oversized overlay is rejected by the per-image cap; the small bg survives.
  assert.equal(s.decor.bg.src, DATA_PNG);
  assert.equal('overlays' in s.decor, false);
});

test('normalizeTileDecor accepts a two-colour gradient (with or without an image)', () => {
  const g = normalizeTileStyle({ decor: { bg: { grad: { c1: '#1ED760', c2: '#0A0D12', angle: 120 } } } });
  assert.deepEqual(g.decor.bg.grad, { c1: '#1ed760', c2: '#0a0d12', angle: 120 });
  assert.equal('src' in g.decor.bg, false);                       // gradient alone is a valid bg
  const both = normalizeTileStyle({ decor: { bg: { src: DATA_PNG, grad: { c1: '#ffffff', c2: '#000000' } } } });
  assert.equal(both.decor.bg.src, DATA_PNG);
  assert.equal(both.decor.bg.grad.angle === undefined, true);     // angle optional
});

test('normalizeTileDecor drops a half-specified gradient (both stops required)', () => {
  assert.equal(normalizeTileStyle({ decor: { bg: { grad: { c1: '#ffffff' } } } }), null);       // missing c2
  assert.equal(normalizeTileStyle({ decor: { bg: { grad: { c1: 'red', c2: '#000000' } } } }), null); // bad c1
});

test('normalizeTileDecor keeps overlay free x/y only when BOTH are present and valid', () => {
  const s = normalizeTileStyle({ decor: { overlays: [{ preset: 'koi', x: 25, y: 70 }] } });
  assert.deepEqual([s.decor.overlays[0].x, s.decor.overlays[0].y], [25, 70]);
  // x without y (or null) must NOT fall through to 0 (Number(null) === 0 guard).
  const only = normalizeTileStyle({ decor: { overlays: [{ preset: 'koi', x: 25 }] } });
  assert.equal('x' in only.decor.overlays[0], false);
  assert.equal('y' in only.decor.overlays[0], false);
  const nulled = normalizeTileStyle({ decor: { overlays: [{ preset: 'koi', x: null, y: null }] } });
  assert.equal('x' in nulled.decor.overlays[0], false);
});

test('decor round-trips through a page preset and re-validates on insert', () => {
  const out = normalizePresets([{
    id: 'pg', name: 'Decor', kind: 'page', createdAt: 1, gridCols: 24,
    data: { items: [{ type: 'widget', widget: 'system', x: 0, y: 0, w: 8, h: 6, style: { mode: 'inherit', decor: { frame: { preset: 'neon' }, overlays: [{ preset: 'dragon', anchor: 'top-left', size: 30 }] } } }] },
  }], KNOWN);
  const st = out[0].data.items[0].style;
  assert.equal(st.decor.frame.preset, 'neon');
  assert.equal(st.decor.overlays[0].anchor, 'top-left');

  const layout = { widgets: { system: { x: 0, y: 0, w: 8, h: 6, visible: false, page: 'dashboard' } }, copies: [], groups: {}, pages: [{ id: 'dashboard', name: 'D' }] };
  const res = insertPreset(layout, { kind: 'page', name: 'Decor', data: out[0].data });
  assert.equal(res.ok, true);
  assert.equal(layout.widgets.system.style.decor.frame.preset, 'neon');
});
