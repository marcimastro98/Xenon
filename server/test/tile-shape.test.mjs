import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeTileShape, normalizeTileStyle, TILE_SHAPE_PRESETS } = require('../js/dashboard-instances.js');
const { normalizePresets, insertPreset } = require('../js/dashboard-presets.js');
const { TILE_SHAPES, tileShapePath, tileShapeSafe } = require('../js/tile-shape-presets.js');

// Per-tile SHAPE: a tile is a rectangle unless it says otherwise. A shape is
// either a curated preset id (no bytes in a share code) or the author's own SVG
// path in a unit square. The path never reaches CSS as a string — it is set with
// setAttribute('d', …) on an inert <path> — but this is still the boundary an
// imported preset arrives through, so the character set is an allowlist.

test('the preset manifest and the validator agree on the id set', () => {
  assert.deepEqual(TILE_SHAPES.map(s => s.id), TILE_SHAPE_PRESETS);
  // Every curated shape carries geometry AND an honest safe rectangle: a shape
  // whose safe inset is missing would cut the widget's own content.
  TILE_SHAPES.forEach((s) => {
    assert.ok(/^M/.test(s.d) && /[Zz]\s*$/.test(s.d.trim()), `${s.id} must be a closed path`);
    assert.ok(normalizeTileShape({ path: s.d }), `${s.id} must pass the path validator`);
    ['t', 'r', 'b', 'l'].forEach(k => assert.equal(typeof s.safe[k], 'number', `${s.id}.safe.${k}`));
    assert.equal(tileShapePath(s.id), s.d);
    assert.deepEqual(tileShapeSafe(s.id), s.safe);
  });
});

test('a curated preset is kept and an unknown one is dropped', () => {
  assert.deepEqual(normalizeTileShape({ preset: 'hexagon' }), { preset: 'hexagon' });
  assert.equal(normalizeTileShape({ preset: 'not-a-shape' }), null);
  assert.equal(normalizeTileShape({ preset: '../etc' }), null);
  assert.equal(normalizeTileShape(null), null);
  assert.equal(normalizeTileShape('hexagon'), null);
});

test('a hand-written path is kept when it is closed and made of path syntax only', () => {
  const d = 'M 0.5 0 L 1 0.5 L 0.5 1 L 0 0.5 Z';
  assert.deepEqual(normalizeTileShape({ path: d }), { path: d });
  assert.deepEqual(normalizeTileShape({ path: `  ${d}  ` }), { path: d });   // trimmed
});

test('a path that could carry anything but geometry is refused', () => {
  const bad = [
    'url(#evil)',                                   // a reference, not a path
    'M 0 0 L 1 1 Z; background: url(x)',            // CSS injection shape
    'M 0 0 <script> Z',                             // markup
    'M 0 0 L 1 1 Z" onload="x',                     // attribute break-out
    'M 0 0 L 1 1 Z /* comment */',
    'javascript:alert(1)',
    'L 0 0 L 1 1 Z',                                // must start with a move
    'M 0 0 L 1 0 L 1 1',                            // never closed
    'M'.padEnd(1100, ' 0 0 L 1 1') + ' Z',          // over the length cap
  ];
  bad.forEach(d => assert.equal(normalizeTileShape({ path: d }), null, `must refuse: ${d.slice(0, 40)}`));
  // Over the command cap, even while under the length cap.
  const manyCmds = 'M 0 0 ' + 'L 1 1 '.repeat(210) + 'Z';
  assert.equal(normalizeTileShape({ path: manyCmds }), null);
});

test('a preset wins over a path when a style carries both', () => {
  const s = normalizeTileShape({ preset: 'diamond', path: 'M 0 0 L 1 1 Z' });
  assert.deepEqual(s, { preset: 'diamond' });      // the reviewed geometry, never the ambiguity
});

test('fit and inset are clamped, and the default fit is not stored', () => {
  assert.equal('fit' in normalizeTileShape({ preset: 'arch', fit: 'stretch' }), false);
  assert.equal('fit' in normalizeTileShape({ preset: 'arch', fit: 'nope' }), false);
  assert.equal(normalizeTileShape({ preset: 'arch', fit: 'fit' }).fit, 'fit');
  assert.equal(normalizeTileShape({ preset: 'arch', inset: 99 }).inset, 25);      // clamped
  assert.equal(normalizeTileShape({ preset: 'arch', inset: -5 }).inset, 0);
  assert.equal(normalizeTileShape({ preset: 'arch', inset: 6.4 }).inset, 6);      // rounded
  assert.equal('inset' in normalizeTileShape({ preset: 'arch', inset: 'lots' }), false);
});

test('a shape rides an inherit tile, exactly like decor does', () => {
  const s = normalizeTileStyle({ shape: { preset: 'blob' } });
  assert.equal(s.mode, 'inherit');                 // no colour override needed to have a shape
  assert.deepEqual(s.shape, { preset: 'blob' });
  // …and a style whose shape is junk collapses back to nothing.
  assert.equal(normalizeTileStyle({ shape: { preset: 'evil' } }), null);
});

test('panelAlpha reaches 0 — a card asked to disappear can disappear', () => {
  assert.equal(normalizeTileStyle({ panelAlpha: 0 }).panelAlpha, 0);
  assert.equal(normalizeTileStyle({ panelAlpha: 0.5 }).panelAlpha, 0.5);
  assert.equal('panelAlpha' in normalizeTileStyle({ mode: 'custom', panelAlpha: 1.4 }), false);
  assert.equal('panelAlpha' in normalizeTileStyle({ mode: 'custom', panelAlpha: -0.2 }), false);
});

test('a shape round-trips through a page preset and is re-validated on insert', () => {
  const out = normalizePresets([{
    id: 'pg', name: 'Shaped', kind: 'page', createdAt: 1, gridCols: 24,
    data: {
      items: [
        { type: 'widget', widget: 'system', x: 0, y: 0, w: 8, h: 6, style: { mode: 'inherit', shape: { preset: 'hexagon', inset: 4 } } },
        { type: 'widget', widget: 'media', x: 8, y: 0, w: 8, h: 6, style: { mode: 'inherit', shape: { path: 'url(#x)' } } },
      ],
    },
  }], ['media', 'system', 'chat']);
  const items = out[0].data.items;
  assert.deepEqual(items[0].style.shape, { preset: 'hexagon', inset: 4 });
  assert.equal(items[1].style, undefined);         // the hostile one carried nothing else, so it collapsed

  const layout = {
    widgets: { system: { x: 0, y: 0, w: 8, h: 6, visible: false, page: 'dashboard' } },
    copies: [], groups: {}, pages: [{ id: 'dashboard', name: 'D' }],
  };
  const res = insertPreset(layout, { kind: 'page', name: 'Shaped', data: out[0].data });
  assert.equal(res.ok, true);
  assert.deepEqual(layout.widgets.system.style.shape, { preset: 'hexagon', inset: 4 });
});

// The SDK manifest is the SECOND door onto the same validator — a package may
// declare the silhouette of its own tile. It must not be a second set of rules.
test('an SDK manifest goes through the same shape validator', async () => {
  const sdk = require('../sdk-widgets.js');
  const ok = sdk.normalizeManifest({ api: 1, name: 'Shaped', shape: { preset: 'ticket', fit: 'fit' } }, 'shaped-widget');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.manifest.shape, { preset: 'ticket', fit: 'fit' });

  // Malformed cosmetics are dropped, never a rejected package (same rule as
  // surface/accent): a bad shape must not stop a widget from installing.
  const bad = sdk.normalizeManifest({ api: 1, name: 'Shaped', shape: { path: 'url(#x)' } }, 'shaped-widget');
  assert.equal(bad.ok, true);
  assert.equal(bad.manifest.shape, null);

  // An ambient scene already owns the whole screen: a silhouette there would
  // clip nothing the user asked to be clipped.
  const amb = sdk.normalizeManifest({ api: 1, name: 'Scene', surface: 'ambient', shape: { preset: 'circle' } }, 'shaped-widget');
  assert.equal(amb.manifest.shape, null);
});
