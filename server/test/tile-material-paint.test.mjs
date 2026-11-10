// What the Material tab depends on outside its own file: the mark that keeps thin
// glass readable when the blur is off, the order the page loads things, and which
// layer Escape closes first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// LF only, so the slices below find their ends on a CRLF (Windows) checkout too.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const GRID = read('../components/DashboardGrid/DashboardGrid.css');
const SAMPLE = read('../components/DashboardGrid/TileStyleMaterial.css');
const EDIT = read('../styles/liquid-edit.css');
const LAYOUT = read('../js/dashboard-layout.js');
const PANE = read('../js/tile-style-material-pane.js');
const MAIN = read('../js/main.js');
const PAGE = read('../index.html');

function cut(src, start, end) {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `cannot cut ${start}`);
  return src.slice(a, b);
}

function fakeEl() {
  const attrs = new Set();
  return {
    attrs,
    style: { setProperty() {} },
    setAttribute: (k) => attrs.add(k),
    removeAttribute: (k) => attrs.delete(k),
    hasAttribute: (k) => attrs.has(k),
    toggleAttribute(k, force) { if (force) attrs.add(k); else attrs.delete(k); },
  };
}

const applyTileTokens = new Function('window', cut(LAYOUT, 'const TILE_THIN_BELOW', 'function applyAllTileStyles')
  + '\nreturn applyTileTokens;')({ PANEL_DROP_CSS: { dark: 'DROP', light: 'DROP' }, getEffectiveThemePalette: () => ({ tone: 'dark' }) });

const marks = (style) => { const el = fakeEl(); applyTileTokens(el, style); return el.attrs; };

test('a see-through panel is marked thin, a panel thick enough or gone is not', () => {
  assert.ok(marks({ panelAlpha: 0.35 }).has('data-tile-thin'));
  assert.ok(marks({ panelAlpha: 0.85 }).has('data-tile-thin'));
  assert.ok(!marks({ panelAlpha: 0.86 }).has('data-tile-thin'), 'already at the floor');
  assert.ok(!marks({ panelAlpha: 1 }).has('data-tile-thin'));
  assert.ok(!marks({ panelAlpha: 0 }).has('data-tile-thin'), 'No panel stays no panel');
  assert.ok(!marks({}).has('data-tile-thin'), 'a tile following the theme is left to the theme');
});

test('the floor only reaches glass: a tile set translucent with no blur stays as chosen', () => {
  const low = 'body.low-power-gpu .grid-stack-item[data-tile-thin][data-tile-glass] { --panel-alpha: 0.86 !important; }';
  const reduced = '.grid-stack-item[data-tile-thin][data-tile-glass] { --panel-alpha: 0.92 !important; }';
  assert.ok(GRID.includes(low), 'low power');
  assert.ok(cut(GRID, '@media (prefers-reduced-transparency: reduce) {', '/* Per-tile custom font').includes(reduced), 'reduced transparency');
  assert.ok(!/\[data-tile-thin\](?!\[data-tile-glass\])/.test(GRID), 'every rule asks for both marks');
});

test('the floors match the sheets of Liquid Glass, and the samples show the same ones', () => {
  const liquid = read('../styles/themes-liquid.css');
  assert.match(liquid, /body\.low-power-gpu \{ --panel-alpha: 0\.86;/);
  assert.match(LAYOUT, /const TILE_THIN_BELOW = 0\.86;/);
  assert.ok(SAMPLE.includes('body.low-power-gpu .tsm-sheet.is-glass { --tsm-alpha: 0.86 !important; }'));
  assert.ok(SAMPLE.includes('.tsm-sheet.is-glass { --tsm-alpha: 0.92 !important; }'));
  assert.match(PANE, /'is-glass', look\.glassBlur > 0 && look\.panelAlpha > 0\.02/);
});

test('with no blur the style window is solid, or the tiles read through its text', () => {
  assert.ok(EDIT.includes(':root[data-style="liquid"] body.low-power-gpu .tile-style-overlay .tile-style-pop { background: rgb(var(--panel-rgb)); }'));
  const reduced = cut(EDIT, '@media (prefers-reduced-transparency: reduce) {', '.tile-style-tabs');
  assert.ok(reduced.includes('.tile-style-overlay .tile-style-pop { background: rgb(var(--panel-rgb)); }'));
});

test('the page loads the materials before the panes that use them, and the Liquid sheet last', () => {
  const at = (needle) => {
    const i = PAGE.indexOf(needle);
    assert.ok(i >= 0, `${needle} is not on the page`);
    return i;
  };
  assert.ok(at('js/tile-material.js') < at('js/tile-style-material-pane.js'));
  assert.ok(at('js/tile-style-material-pane.js') < at('js/tile-style-editor.js'));
  assert.ok(at('styles/liquid-tiles.css') < at('styles/liquid-edit.css'), 'it uses the keys of the tiles');
  at('components/DashboardGrid/TileStyleMaterial.css');
});

test('Escape closes the style window before it leaves layout mode', () => {
  const handler = MAIN.slice(MAIN.indexOf("if (e.key === 'Escape') {"));
  const style = handler.indexOf('window.closeTileStyleEditor()');
  const layout = handler.indexOf('setDashboardLayoutEditMode(false)');
  assert.ok(style >= 0 && layout > style);
  assert.match(handler.slice(style, layout), /e\.preventDefault\(\);\s+return;/);
});
