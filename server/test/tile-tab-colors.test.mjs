// A tab group's own tab colours (style.tabs): the shared normalizer, the paint
// mapping, the server's pruning, the style editor's Tabs pane and its strings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DI = require('../js/dashboard-instances.js');
const TG = require('../js/dashboard-tabgroups.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('normalizeTileTabs keeps valid colours per tab and drops the rest', () => {
  const out = DI.normalizeTileTabs({
    barBg: '#112233',
    items: {
      deck: { activeBg: '#FF2D92', text: 'red', junk: '#000000' },
      'custom~i7tv': { activeText: '#ffcc00' },
      agenda: {},
      'bad id!': { bg: '#000000' },
      __proto__: { bg: '#000000' },
      constructor: { bg: '#000000' },
    },
  });
  assert.deepEqual(out, { barBg: '#112233', items: { deck: { activeBg: '#ff2d92' }, 'custom~i7tv': { activeText: '#ffcc00' } } });
  assert.equal(DI.normalizeTileTabs({ items: { deck: { bg: 'nope' } } }), null);
  assert.equal(DI.normalizeTileTabs(null), null);
});

test('normalizeTileTabs caps the number of tabs it keeps', () => {
  const items = {};
  for (let i = 0; i < 40; i++) items['w' + i] = { bg: '#101010' };
  assert.equal(Object.keys(DI.normalizeTileTabs({ items }).items).length, 24);
});

test('tab colours alone make a style worth keeping, in any colour mode', () => {
  const s = DI.normalizeTileStyle({ mode: 'inherit', tabs: { barBg: '#123456' } });
  assert.deepEqual(s, { mode: 'inherit', tabs: { barBg: '#123456' } });
  assert.equal(DI.normalizeTileStyle({ mode: 'inherit', tabs: { items: {} } }), null);
});

test('tabColorVars maps one tab and keeps a picked background readable', () => {
  const tabs = { items: { deck: { activeBg: '#ffffff' }, agenda: { bg: '#000000', text: '#00c7be' } } };
  const deck = TG.tabColorVars(tabs, 'deck');
  assert.equal(deck['--tgc-active-bg'], '#ffffff');
  assert.match(deck['--tgc-active-text'], /^#[0-9a-f]{6}$/i);
  assert.notEqual(deck['--tgc-active-text'].toLowerCase(), '#ffffff');
  assert.deepEqual(TG.tabColorVars(tabs, 'agenda'), { '--tgc-bg': '#000000', '--tgc-text': '#00c7be' });
  assert.deepEqual(TG.tabColorVars(tabs, 'news'), {});
  assert.deepEqual(TG.tabColorVars(tabs, 'toString'), {});
  assert.deepEqual(TG.tabColorVars(null, 'deck'), {});
});

test('the group tile paints its tabs on render and on a live style repaint', () => {
  const src = read('../js/dashboard-tabgroups.js');
  assert.match(src, /paintGroupTabs\(gridItem, group\.style && group\.style\.tabs\);/);
  const layout = read('../js/dashboard-layout.js');
  assert.match(layout, /window\.DashboardTabGroups\.paintGroupTabs\(el, style && style\.tabs\);/);
  // A style pasted onto a tile that is not a tab group drops the tab colours.
  assert.match(layout, /if \(style && style\.tabs && !\(layout\.groups && layout\.groups\[id\]\)\)/);
  const css = read('../components/DashboardGrid/DashboardGrid.css');
  for (const r of [
    '.tabgroup-bar[data-tgc-bar] { background: var(--tgc-bar-bg) !important; }',
    '.tabgroup-tab[data-tgc-bg]:not(.active) { background: var(--tgc-bg) !important; }',
    '.tabgroup-tab[data-tgc-text]:not(.active) { color: var(--tgc-text) !important; }',
    '.tabgroup-tab[data-tgc-active-bg].active { background: var(--tgc-active-bg) !important; }',
    '.tabgroup-tab[data-tgc-active-text].active { color: var(--tgc-active-text) !important; }',
  ]) assert.ok(css.includes(r), r);
});

test('the server drops colours of a tab that left the group', () => {
  const src = read('../server.js');
  assert.match(src, /Object\.keys\(style\.tabs\.items\)\.forEach\(mid => \{ if \(!members\.includes\(mid\)\) delete style\.tabs\.items\[mid\]; \}\);/);
});

test('the style editor shows a Tabs pane only for a tab group, one section per tab', () => {
  const ed = read('../js/tile-style-editor.js');
  assert.match(ed, /const members = groupTabs\(id\);\s+if \(members\.length && window\.TileStyleTabsPane\) panes\.push/);
  assert.match(ed, /if \(!group \|\| !Array\.isArray\(group\.members\)\) return \[\];/);
  assert.match(ed, /tabs: tabsWorkingCopy\(cur\.tabs\),/);
  const pane = read('../js/tile-style-tabs-pane.js');
  assert.match(pane, /members\.forEach\(\(\{ id, label \}\) => \{/);
  for (const k of ['activeBg', 'activeText', "'bg'", "'text'"]) assert.ok(pane.includes(k), k);
  assert.match(read('../index.html'), /<script src="js\/tile-style-controls-pane\.js"><\/script>\r?\n<script src="js\/tile-style-tabs-pane\.js"><\/script>/);
});

test('the Tabs pane strings exist in all 11 languages', () => {
  const i18n = read('../js/i18n.js');
  for (const k of ['tile_style_tab_tabs', 'tile_style_tabs_hint', 'tile_style_tabs_bar', 'tile_style_tabs_active_bg',
    'tile_style_tabs_active_text', 'tile_style_tabs_bg', 'tile_style_tabs_text']) {
    assert.equal((i18n.match(new RegExp('\\b' + k + '"?: "', 'g')) || []).length, 11, k);
  }
});

test('a preset carries tab colours by widget and gives them to the new members', () => {
  const P = require('../js/dashboard-presets.js');
  const src = {
    widgets: { deck: { visible: false }, agenda: { visible: false } },
    copies: [{ id: 'news~ab12', widget: 'news' }],
    groups: { g1: { id: 'g1', members: ['deck', 'news~ab12'], active: 'deck', w: 8, h: 8,
      style: { mode: 'inherit', tabs: { barBg: '#123456', items: { deck: { activeBg: '#ff2d92' }, 'news~ab12': { text: '#00c7be' } } } } } },
  };
  const data = P.captureGroup(src, 'g1');
  assert.deepEqual(data.members, ['deck', 'news']);
  assert.deepEqual(data.style.tabs.items, { deck: { activeBg: '#ff2d92' }, news: { text: '#00c7be' } });
  // Installed where deck and news are free primaries: the colours follow them.
  const dest = { widgets: { deck: { visible: false }, news: { visible: false } }, groups: {}, copies: [] };
  assert.equal(P.insertPreset(dest, { kind: 'group', data }, 'dashboard').ok, true);
  const g = Object.values(dest.groups)[0];
  assert.deepEqual(g.members, ['deck', 'news']);
  assert.deepEqual(g.style.tabs, { barBg: '#123456', items: { deck: { activeBg: '#ff2d92' }, news: { text: '#00c7be' } } });
});
