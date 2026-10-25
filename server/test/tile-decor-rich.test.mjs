// The richer widget decor (tinted frames, overlays with colour/glow/motion,
// patterns, glow, edge bar, ready-made looks) and the widget's own controls.
// The validator is the boundary every saved layout, share code and Maker export
// goes through, so these pin what it keeps and what it drops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const DI = require('../js/dashboard-instances.js');
const TDS = require('../js/tile-decor-schema.js');
const TDP = require('../js/tile-decor-presets.js');
const TDL = require('../js/tile-decor-layers.js');
const TC = require('../js/tile-controls.js');
const Model = require('../js/tile-style-decor-model.js');
globalThis.window = { DashboardInstances: DI };
const { workingCopy, buildStyle } = require('../js/tile-style-editor.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('a frame keeps its colour, glow, inset and pulse, and drops what is out of range', () => {
  const d = DI.normalizeTileDecor({ frame: { preset: 'hud', width: 18, tint: 'accent', tint2: '#ABCDEF', opacity: 140, glow: 99, inset: -3, anim: 'flow' } });
  assert.deepEqual(d.frame, { preset: 'hud', width: 18, tint: 'accent', tint2: '#abcdef', glow: 24 });
});

test('a second frame colour needs a first one', () => {
  const d = DI.normalizeTileDecor({ frame: { preset: 'hud', tint2: '#112233' } });
  assert.equal(d.frame.tint2, undefined);
});

test('overlays keep colour, glow, shadow, motion and layer; at most eight', () => {
  const ov = { preset: 'star', tint: '#ff0000', glow: 6, shadow: 4, anim: 'twinkle', layer: 'behind' };
  const d = DI.normalizeTileDecor({ overlays: Array.from({ length: 10 }, () => ov) });
  assert.equal(d.overlays.length, 8);
  assert.deepEqual(d.overlays[0], { preset: 'star', anchor: 'bottom-right', size: 40, tint: '#ff0000', glow: 6, shadow: 4, anim: 'twinkle', layer: 'behind' });
  const bad = DI.normalizeTileDecor({ overlays: [{ preset: 'star', tint: 'red', anim: 'explode', layer: 'under' }] });
  assert.deepEqual(bad.overlays[0], { preset: 'star', anchor: 'bottom-right', size: 40 });
});

test('pattern, glow and bar are validated and clamped', () => {
  assert.equal(TDS.normalizeTilePattern({ kind: 'plaid' }), null);
  assert.deepEqual(TDS.normalizeTilePattern({ kind: 'lines', color: 'accent', opacity: 0, size: 200, weight: 9, angle: 45, fade: 'edges', layer: 'above' }),
    { kind: 'lines', color: 'accent', opacity: 1, size: 96, weight: 8, angle: 45, fade: 'edges', layer: 'above' });
  assert.equal(TDS.normalizeTileGlow({ color: '#ffffff' }), null, 'a glow with no size is nothing');
  assert.deepEqual(TDS.normalizeTileGlow({ inner: 80, outer: 10 }), { inner: 60, outer: 10 });
  assert.equal(TDS.normalizeTileBar({ side: 'middle' }), null);
  assert.deepEqual(TDS.normalizeTileBar({ side: 'left', length: 100, align: 'center', size: 3 }), { side: 'left', size: 3 });
});

test('controls keep only hex colours, known variants and clamped sizes', () => {
  assert.equal(TDS.normalizeTileControls({}), null);
  assert.deepEqual(TDS.normalizeTileControls({ variant: 'neon', bg: 'red', text: '#FFFFFF', radius: 99, borderWidth: -1 }),
    { text: '#ffffff', radius: 40, borderWidth: 0 });
  const s = DI.normalizeTileStyle({ controls: { variant: 'outline', border: '#00ff00' } });
  assert.deepEqual(s, { mode: 'inherit', controls: { variant: 'outline', border: '#00ff00' } }, 'controls alone are a style');
});

test('every curated frame and overlay has its picture on disk', () => {
  TDP.TILE_DECOR_FRAMES.forEach((f) => assert.ok(existsSync(new URL(`../assets/decor/frame-${f.id}.svg`, import.meta.url)), f.id));
  TDP.TILE_DECOR_OVERLAYS.forEach((o) => assert.ok(existsSync(new URL(`../assets/decor/overlay-${o.id}.svg`, import.meta.url)), o.id));
  const cats = new Set(TDP.TILE_DECOR_OVERLAY_CATS.map((c) => c.id));
  TDP.TILE_DECOR_OVERLAYS.forEach((o) => assert.ok(cats.has(o.cat), `${o.id} has a known category`));
});

test('curated SVGs carry no script, link or external reference', () => {
  [...TDP.TILE_DECOR_FRAMES.map((f) => `frame-${f.id}`), ...TDP.TILE_DECOR_OVERLAYS.map((o) => `overlay-${o.id}`)].forEach((n) => {
    const svg = read(`../assets/decor/${n}.svg`);
    assert.doesNotMatch(svg, /<script|on[a-z]+=|href=|url\((?!#)/i, n);
  });
});

test('every ready-made look survives the validator whole', () => {
  TDP.TILE_DECOR_LOOKS.forEach((look) => {
    const d = DI.normalizeTileDecor(look.decor);
    assert.ok(d, look.id);
    Object.keys(look.decor).forEach((part) => assert.ok(d[part], `${look.id}.${part} kept`));
    if (look.decor.overlays) assert.equal(d.overlays.length, look.decor.overlays.length, look.id);
  });
});

test('every label key exists in all eleven languages', () => {
  const i18n = read('../js/i18n.js');
  const keys = [
    ...TDP.TILE_DECOR_FRAMES, ...TDP.TILE_DECOR_OVERLAYS, ...TDP.TILE_DECOR_OVERLAY_CATS, ...TDP.TILE_DECOR_LOOKS,
  ].map((e) => e.labelKey).concat(['decor_cat_all', 'tile_style_tab_controls', 'tile_style_ctrl_buttons', 'decor_pattern_noise']);
  keys.forEach((k) => assert.equal((i18n.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 11, k));
});

test('every pattern kind draws, and accent follows the tile token', () => {
  TDS.TILE_PATTERN_KINDS.forEach((kind) => {
    const css = TDL.tilePatternCss({ kind, size: 16, weight: 2 });
    assert.ok(css && (css.image || css.mask), kind);
  });
  assert.equal(TDL.tilePatternCss({ kind: 'plaid' }), null);
  assert.equal(TDL.decorColorCss('accent'), 'var(--accent)');
  assert.equal(TDL.decorColorCss('', 'var(--text)'), 'var(--text)');
  assert.equal(TDL.tilePatternFadeMask('nowhere'), '');
});

test('controls: a button colour alone picks a readable text colour', () => {
  const dark = TC.resolveTileControls({ bg: '#101010' });
  assert.equal(dark.vars['--tb-bg'], '#101010');
  assert.equal(dark.vars['--tb-text'], '#ffffff');
  const light = TC.resolveTileControls({ bg: '#f5f5f5' });
  assert.equal(light.vars['--tb-text'], '#111111');
  assert.deepEqual(light.attrs, ['bg', 'text', 'border', 'hover']);
});

test('controls: variants and the selected state', () => {
  const soft = TC.resolveTileControls({ variant: 'soft', bg: '#ff0000' });
  assert.match(soft.vars['--tb-bg'], /color-mix\(in srgb, #ff0000 18%/);
  assert.equal(soft.vars['--tb-text'], '#ff0000');
  const outline = TC.resolveTileControls({ variant: 'outline' });
  assert.equal(outline.vars['--tb-bg'], 'transparent');
  assert.equal(outline.vars['--tb-border'], 'var(--accent)');
  const ghost = TC.resolveTileControls({ variant: 'ghost' });
  assert.equal(ghost.vars['--tb-border'], 'transparent');
  assert.equal(ghost.vars['--tb-text'], undefined, 'plain keeps the theme text');
  const active = TC.resolveTileControls({ activeBg: '#ffffff' });
  assert.deepEqual(active.attrs, ['active']);
  assert.equal(active.vars['--tb-active-text'], '#111111');
  assert.deepEqual(TC.resolveTileControls(null), { vars: {}, attrs: [] });
  assert.deepEqual(TC.resolveTileControls({ radius: 0, fieldBg: '#000000' }).attrs, ['field-bg', 'radius']);
});

test('the editor round-trips a rich decor and the controls', () => {
  const style = DI.normalizeTileStyle({
    decor: {
      frame: { preset: 'circuit', width: 20, tint: '#22d3ee', tint2: '#a855f7', glow: 6, anim: 'pulse' },
      overlays: [{ preset: 'moon', anchor: 'top-right', size: 22, glow: 10, anim: 'float', tint: 'accent', layer: 'behind' }],
      pattern: { kind: 'grid', color: '#22d3ee', opacity: 8, size: 22, fade: 'edges' },
      glow: { color: 'accent', inner: 18, outer: 6 },
      bar: { side: 'top', size: 3, length: 40, align: 'start' },
    },
    controls: { variant: 'soft', bg: '#ff7eb6', activeBg: '#222222', radius: 14 },
  });
  assert.deepEqual(buildStyle(workingCopy(style)), style);
});

test('a look replaces the decor but keeps the background picture', () => {
  const work = Model.decorWorkingCopy({ bg: { src: '/uploads/a.png' }, frame: { preset: 'gold' } });
  Model.applyLook(work, TDP.TILE_DECOR_LOOKS.find((l) => l.id === 'night-sky'));
  assert.equal(work.bg.src, '/uploads/a.png');
  assert.equal(work.frame.preset, '');
  assert.equal(work.overlays.length, 2);
  Model.clearLook(work);
  assert.equal(work.overlays.length, 0);
  assert.equal(work.pattern.kind, '');
});

test('the controls stylesheet leaves Deck keys alone and pauses nothing it did not start', () => {
  const css = read('../styles/tile-controls.css');
  const rules = css.split('}').filter((r) => r.includes('{'));
  rules.forEach((r) => assert.match(r, /\.grid-stack-item\[data-tb-/, 'every rule is gated on a tile attribute'));
  rules.filter((r) => /button/.test(r) && !/data-tb-field/.test(r)).forEach((r) => assert.match(r, /:not\(\.deck-key, \.deck-key \*/));
  // A space before :not()/the selected-state list would turn it into a descendant
  // selector, and paint what is inside the buttons instead of the buttons.
  assert.doesNotMatch(css, /\)\s+:(not\(\.deck-key|is\(\.is-active)/, 'the filters attach to the button itself');
  const html = read('../index.html');
  assert.ok(html.indexOf('styles/tile-controls.css') > html.indexOf('styles/themes-comic.css'), 'after the skins');
});

test('decor motion pauses with the dashboard and respects reduced motion', () => {
  const css = read('../components/DashboardGrid/DashboardGrid.css');
  assert.match(css, /body\.low-power-gpu, body\.overlay-frozen, body\.ambient-idle, body\.game-mode, body\.perf-mode\) :is\(\.tile-decor-frame, \.tile-decor-ov-motion\)\[data-anim\]/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*:is\(\.tile-decor-frame, \.tile-decor-ov-motion\)\[data-anim\] \{ animation: none; \}/);
  assert.match(css, /:not\(\.tile-decor-above\)/, 'the over-widget layer is not lifted with the content');
});
