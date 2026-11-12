// What sits inside a tile on a new install: one calm sheet, colour left to state. Someone on
// another look must see nothing change, a widget without its panel keeps the words readable,
// and the colours drawn for a dark sheet must not reach a light one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as readFileSyncRaw } from 'node:fs';
// A Windows checkout (core.autocrlf) has CRLF; everything below matches on LF.
const read = (rel) => readFileSyncRaw(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const CSS = read('../styles/liquid-tiles.css');
const LIGHT = read('../styles/themes-light.css');
const uncommented = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const selectors = (css) => [...uncommented(css).matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());
const body = (part) => {
  const at = CSS.indexOf(part);
  assert.ok(at >= 0, part);
  return CSS.slice(CSS.indexOf('{', at), CSS.indexOf('}', at));
};

test('both pages load it after the look it builds on', () => {
  const page = read('../index.html');
  assert.ok(page.indexOf('styles/liquid-chrome.css') < page.indexOf('styles/liquid-tiles.css'));
  const lite = read('../layer-lite.html');
  assert.ok(lite.indexOf('themes-liquid.css') < lite.indexOf('styles/liquid-tiles.css'));
});

test('every rule waits for Liquid, so another look sees no change', () => {
  for (const rule of selectors(CSS).filter((s) => !s.startsWith('@'))) {
    assert.match(rule, /^:root\[data-style="liquid"\]/, rule);
  }
});

test('a tile runs no loop and blurs nothing of its own', () => {
  assert.doesNotMatch(uncommented(CSS), /animation|@keyframes|backdrop-filter|filter:/);
});

test('the tokens change on the tile, so Settings and the Store keep theirs', () => {
  const tile = body(':root[data-style="liquid"] :is(.panel, .dashboard-widget) {');
  for (const token of ['--card-surface', '--control-bg', '--input-bg', '--hover-bg', '--line']) {
    assert.match(tile, new RegExp(`${token}:`), token);
  }
  const root = body(':root[data-style="liquid"] {');
  assert.doesNotMatch(root, /--control-bg|--card-surface/);
});

test('the light theme\'s own tokens follow, as they resolve on the root', () => {
  const tile = body(':root[data-style="liquid"] :is(.panel, .dashboard-widget) {');
  for (const token of ['--lt-border', '--lt-divider', '--lt-track', '--lt-hover']) assert.match(tile, new RegExp(`${token}:`), token);
});

test('a widget without its panel keeps the thick sheet behind its cards', () => {
  assert.match(CSS, /\.layer-slot\[data-bare\] :is\(\.panel, \.dashboard-widget\) \{ --card-surface: var\(--panel-soft\); \}/);
});

test('a chosen tab is a neutral thumb and the accent stays for state', () => {
  assert.doesNotMatch(uncommented(CSS), /var\(--accent|var\(--green/);
  const contract = read('../styles/theme-contract.css');
  assert.match(contract, /\.panel \.vt-row \.vt-seg\.on/);
  assert.match(contract, /\.panel \.day-cell\.today/);
});

test('today in the calendar is readable on paper', () => {
  assert.match(LIGHT, /\.panel \.day-cell\.today \{ color: var\(--accent-ink/);
});

test('a player with a cover stays a dark card, so its keys stay white on light', () => {
  const rules = selectors(LIGHT).filter((s) => s.includes('.sp-ctl'));
  assert.ok(rules.length > 0);
  for (const rule of rules) assert.match(rule, /\.sp-now:not\(\.has-cover\)/, rule);
});

test('a bare widget\'s dark words get a light edge', () => {
  const host = read('../components/LayerHost/LayerHost.css');
  assert.match(host, /\[data-appearance="light"\] \.layer-slot\[data-bare\] > \[data-dashboard-widget\] \{ text-shadow: 0 0 2px #fff/);
});

test('nothing playing: no hint under the title, and the picture has no caption', () => {
  const css = read('../components/MediaPanel/MediaPanel.css');
  assert.doesNotMatch(css, /\.media-panel\.is-empty \.media-artist/);
  assert.match(css, /\.media-panel\.is-empty \.ph-label \{ display: none; \}/);
  assert.match(read('../js/media.js'), /root\.classList\.toggle\('is-empty', !!ctx\.empty\);/);
});

test('the area under a System graph is its own path, with no filter', () => {
  assert.match(read('../js/utils.js'), /stat-spark-area/);
  assert.doesNotMatch(read('../components/SystemPanel/SystemPanel.css'), /\.stat-spark-area[^{]*\{[^}]*filter/);
});

// Tab groups read as the tile's titles: a second strip of tabs over the widget's own read
// as nested tabs and left the row beside it empty (he rejected it on 7 Nov 2026).
test('a tab group names its widgets as plain titles, the open one heavier at the same width', () => {
  const bar = body(':root[data-style="liquid"] .tabgroup-bar:not([data-tgc-bar]) {');
  assert.match(bar, /background: none;/);
  assert.match(bar, /padding: 0;/);
  const tab = body(':root[data-style="liquid"] .tabgroup-bar:not([data-tgc-bar]) .tabgroup-tab {');
  assert.match(tab, /padding: 13px 8px;/, '44px tall for a finger');
  assert.match(tab, /font-size: 15px;/);
  const open = body(':root[data-style="liquid"] .tabgroup-bar:not([data-tgc-bar]) .tabgroup-tab.active {');
  assert.match(open, /-webkit-text-stroke:/);
  assert.doesNotMatch(open, /font-weight|font-size/, 'a weight or size change would shift the row');
  assert.ok(CSS.includes('.tabgroup-bar:not([data-tgc-bar]) .tabgroup-tab-ico { display: none; }'), 'words, not words and icons');
});

test('a group painted in its own colours keeps the strip it was painted on', () => {
  const titled = selectors(CSS).filter((rule) => rule.includes('.tabgroup-bar') && !rule.includes(':is('));
  assert.ok(titled.length >= 4);
  for (const rule of titled) {
    if (/\.tabgroup-bar$/.test(rule)) continue; // the width every strip shares
    assert.ok(rule.includes('.tabgroup-bar:not([data-tgc-bar])'), rule);
  }
});
