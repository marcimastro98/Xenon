// "If I change things in the widget style I see no change on that widget."
// Measured with a pixel bench against the real dashboard (every option applied
// through normalizeTileStyle + applyTileStyle, the tile's pixels compared):
//
// - Background tab: 0% of pixels changed on every opaque tile. The picture layer
//   sat behind the widget's own panel, which paints an opaque fill.
// - Tab groups: the member panel painted a second fill over the group's, so a
//   picture or glass on the group stayed hidden and opacity compounded.
// - Glass on tiles under the Minimal island: no blur at all. The island cutout
//   was a clip-path on the tile item, and an ancestor's clip-path is the
//   backdrop root of everything inside it.
// - Shadow: computed correctly but a thin contact band at any strength.
//
// After the fixes below: a background gradient changes 83-93% of a plain tile
// and 26-32% of a tab group (whose cards keep their own fill), and a 40px glass
// visibly blurs the wallpaper behind the Lyrics tile with the cutout intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const LAYOUT = read('../js/dashboard-layout.js');
const GRID = read('../components/DashboardGrid/DashboardGrid.css');
const TOPBAR = read('../components/TopbarMinimal/TopbarMinimal.css');
const TOPBAR_JS = read('../js/topbar-minimal.js');

const rule = (css, selector) => {
  const at = css.indexOf(selector + ' {');
  assert.ok(at >= 0, `rule ${selector} is gone`);
  return css.slice(at, css.indexOf('}', at));
};

test('the background picture takes over the panel fill', () => {
  assert.match(rule(GRID, '.tile-decor-bg'), /background-color: var\(--panel\);/,
    'the panel colour is painted under the picture');
  assert.match(
    rule(GRID, '.grid-stack-item[data-tile-bg] > .grid-stack-item-content > :is(.panel, .dashboard-widget)'),
    /background: transparent;/, 'the widget root no longer covers the picture');
  assert.match(LAYOUT, /el\.setAttribute\('data-tile-bg', ''\);/);
  assert.match(LAYOUT, /el\.removeAttribute\('data-tile-bg'\);/, 'a repaint without a picture restores the panel');
});

test('opacity and blur belong to the art, so the panel colour under it stays put', () => {
  assert.match(LAYOUT, /art\.className = 'tile-decor-bg-art';/);
  assert.match(LAYOUT, /art\.style\.opacity = String\(decor\.bg\.opacity \/ 100\);/);
  assert.match(LAYOUT, /art\.style\.filter = `blur\(\$\{decor\.bg\.blur\}px\)`;/);
  assert.doesNotMatch(LAYOUT, /layer\.style\.opacity = /);
});

test('a panel gradient paints under the picture, not over it', () => {
  assert.match(LAYOUT, /if \(pg && bgLayer\) bgLayer\.style\.backgroundImage = pg;/);
});

test('glass moves to the picture layer when the tile has one', () => {
  assert.match(
    rule(GRID, '.grid-stack-item[data-tile-bg][data-tile-glass] > .grid-stack-item-content > .tile-decor-bg'),
    /backdrop-filter: blur\(var\(--glass-blur\)\) saturate\(var\(--glass-saturate\)\);/);
  assert.match(
    rule(GRID, '.grid-stack-item[data-tile-bg][data-tile-glass] > .grid-stack-item-content > :is(.panel, .dashboard-widget)'),
    /backdrop-filter: none;/, 'a blur on the root would blur the picture itself');
  assert.match(
    rule(GRID, 'body.low-power-gpu .grid-stack-item[data-tile-bg][data-tile-glass] > .grid-stack-item-content > .tile-decor-bg'),
    /backdrop-filter: none;/, 'the hybrid-GPU freeze still drops it');
});

test('a styled tab group paints its fill once', () => {
  assert.match(rule(GRID, '.grid-stack-item[data-tile-style] .tabgroup-body > :is(.panel, .dashboard-widget)'),
    /background: transparent;/);
});

test('a glass tile under the island keeps the cutout on its surfaces', () => {
  assert.match(rule(TOPBAR, 'body.topbar-minimal:not(.layout-editing) .grid-stack-item.island-clear[data-tile-glass]'),
    /clip-path: none;/);
  const at = TOPBAR.indexOf('.island-clear[data-tile-glass]:not([data-tile-shape])');
  assert.ok(at > 0, 'the surface clip rule is gone');
  const body = TOPBAR.slice(at, TOPBAR.indexOf('}', at));
  assert.match(body, /:is\(\.panel, \.dashboard-widget, \.tile-decor-bg, \.tile-decor-overlays, \.tile-decor-above\)/);
  assert.match(body, /clip-path: var\(--island-notch-surface, none\);/);
  // A full-screen player is position:fixed inside the panel: a clip there would
  // cut it down to the tile, which is what the item rule already avoids.
  assert.match(body, /:not\(:has\(\.tww-tile-expanded, \.yt-tile-expanded, \.cw-expanded, \.lyw-staged\)\)/);
  assert.match(TOPBAR_JS, /item\.style\.setProperty\('--island-notch-surface', N\.surfaceClipPath\(geo\)\);/);
  assert.match(TOPBAR_JS, /'--island-notch', '--island-notch-surface'/, 'dropNotch clears it too');
});

test('a tile shadow reaches further as its strength grows', () => {
  assert.match(LAYOUT, /const lift = s > 0 \? `, 0 \$\{Math\.round\(6 \* s\)\}px \$\{Math\.round\(22 \* s\)\}px -4px/);
  assert.match(LAYOUT, /el\.style\.setProperty\('--panel-drop', drop \+ lift\);/);
});
