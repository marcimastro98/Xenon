// "I still see this shadow. What is it?"
//
// Every dashboard tile casts a drop shadow, painted by the grid item that wraps it
// (DashboardGrid.css) because the panel inside is clipped and cannot draw its own.
// It sits just OUTSIDE the tile's edge. On a tile with nothing left inside, a
// Deck with no faceplate or a tile set to fully transparent, it is the only thing
// still on screen: a soft dark strip under an empty box, about 18% darker along
// the bottom edge and fading over ~12px. Reported as "a card behind the cards".
//
// A tile with nothing in it now casts none, unless the user set a shadow on that
// very tile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// LF only, so the slices below find their ends on a CRLF (Windows) checkout too.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const GRID = read('../components/DashboardGrid/DashboardGrid.css');
const DECKCSS = read('../components/DeckPanel/DeckPanel.css');
const LAYOUT = read('../js/dashboard-layout.js');
const DECK = read('../js/deck.js');
const GROUPS = read('../js/dashboard-tabgroups.js');

function cut(src, start, end) {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `cannot cut ${start}`);
  return src.slice(a, b);
}

function fakeEl() {
  const attrs = new Set();
  const props = {};
  return {
    attrs, props,
    style: { setProperty: (k, v) => { props[k] = v; } },
    setAttribute: (k) => attrs.add(k),
    removeAttribute: (k) => attrs.delete(k),
    hasAttribute: (k) => attrs.has(k),
    toggleAttribute(k, force) { const on = force === undefined ? !attrs.has(k) : !!force; if (on) attrs.add(k); else attrs.delete(k); return on; },
  };
}

const applyTileTokens = new Function('window', cut(LAYOUT, 'function applyTileTokens(el, style) {', 'function applyAllTileStyles')
  + '\nreturn applyTileTokens;')({ PANEL_DROP_CSS: { dark: 'DROP', light: 'DROP' }, getEffectiveThemePalette: () => ({ tone: 'dark' }) });

test('a fully transparent tile casts no shadow, and the border is left alone', () => {
  const rule = GRID.indexOf('.grid-stack-item[data-tile-plain]:not([data-tile-shadow]) { box-shadow: none; }');
  assert.ok(rule >= 0, 'the empty-tile rule is gone');
  // It must come after the general rule it overrides.
  assert.ok(rule > GRID.indexOf('.grid-stack-item { border-radius: var(--radius-tile, 16px); box-shadow: var(--panel-drop); }'));
  const block = GRID.slice(rule, GRID.indexOf('\n', rule));
  assert.doesNotMatch(block, /border/, 'the outline stays: it is a legitimate look');
});

test('a transparent tile is marked plain; a shadow the user set on it is marked, and kept', () => {
  const plain = fakeEl();
  applyTileTokens(plain, { panelAlpha: 0 });
  assert.ok(plain.attrs.has('data-tile-plain'), 'no panel left');
  assert.ok(!plain.attrs.has('data-tile-shadow'), 'nobody asked for a shadow on it');

  const withShadow = fakeEl();
  applyTileTokens(withShadow, { panelAlpha: 0, shadowStrength: 1 });
  assert.ok(withShadow.attrs.has('data-tile-plain'));
  assert.ok(withShadow.attrs.has('data-tile-shadow'), 'the user chose this shadow: it stays');
  assert.equal(withShadow.props['--panel-drop'], 'DROP');

  const opaque = fakeEl();
  applyTileTokens(opaque, { panelAlpha: 0.9 });
  assert.ok(!opaque.attrs.has('data-tile-plain'), 'an ordinary tile keeps its shadow');
});

test('re-applying a style clears the markers first, so they never go stale', () => {
  const at = LAYOUT.indexOf('function applyTileEffects(el, content, style, colorsOnly) {');
  const body = LAYOUT.slice(at, LAYOUT.indexOf('applyTileTokens(el, style)', at));
  for (const a of ['data-tile-glass', 'data-tile-plain', 'data-tile-shadow']) {
    assert.ok(body.includes(`el.removeAttribute('${a}')`), `${a} is not reset`);
  }
});

// The Deck's own way of going transparent: the "None" faceplate.
const stampDeckMount = new Function(cut(DECK, '  function stampDeckMount(tile) {', '  // True while the dashboard Layout editor is open.')
  + '\nreturn stampDeckMount;')();

function deckTile(plate, inGroup) {
  const tile = fakeEl();
  const root = { dataset: { plate }, style: { getPropertyValue: () => (plate === 'none' ? '0' : '1') } };
  tile.querySelector = () => root;
  const mount = fakeEl();
  tile.closest = () => (inGroup ? mount : null);
  return { tile, mount };
}

test('a standalone Deck with no faceplate marks its own tile', () => {
  const a = deckTile('none', false);
  stampDeckMount(a.tile);
  assert.ok(a.tile.attrs.has('data-deck-bare'));
  const b = deckTile('graphite', false);
  stampDeckMount(b.tile);
  assert.ok(!b.tile.attrs.has('data-deck-bare'), 'a Deck with a body keeps the shadow of its tile');
});

test('in a tab group the mounting tile is marked, and unmarked when the finish changes', () => {
  const a = deckTile('none', true);
  stampDeckMount(a.tile);
  assert.ok(a.mount.attrs.has('data-deck-bare'));
  assert.equal(a.mount.props['--deck-mount-alpha'], '0');
  // The same tile after the user picks a faceplate again.
  const root = a.tile.querySelector();
  root.dataset.plate = 'steel';
  stampDeckMount(a.tile);
  assert.ok(!a.mount.attrs.has('data-deck-bare'));
});

test('the tab group re-stamps the mark when the shown tab changes', () => {
  assert.match(GROUPS, /tile\.toggleAttribute\('data-deck-bare', !!\(shownRoot && shownRoot\.dataset\.plate === 'none'\)\);/);
});

test('the Deck rule keys off the mark on a direct child of the grid item, and respects a chosen shadow', () => {
  assert.match(DECKCSS, /\.grid-stack-item:not\(\[data-tile-shadow\]\):has\(> \.grid-stack-item-content > \[data-deck-bare\]\) \{ box-shadow: none; \}/);
  // No deep walk: the child-only chain keeps the :has() cheap.
  assert.doesNotMatch(DECKCSS, /:has\([^)]*\.deck-root/);
});
