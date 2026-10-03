// "Where is the normal Weather widget? It disappeared from my menu."
//
// The "+" panel does not offer a widget that is already on the dashboard, and an
// entry that is simply absent reads as a widget that vanished. It now lists those
// widgets too, last and quietly, saying where each one is, and a tap goes there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const PM = require('../js/palette-model.js');

// LF only, so slices find their ends on a CRLF (Windows) checkout too.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const TABLE = [
  { labelKey: 'palette_cat_productivity', ids: ['agenda', 'notes', 'weather', 'notifications'] },
  { labelKey: 'palette_cat_media', ids: ['media', 'chat'] },
];
const IDS = ['media', 'agenda', 'notes', 'weather', 'notifications', 'chat', 'custom'];
const DUPLICABLE = new Set(['media', 'agenda', 'notes', 'chat', 'custom']);
const base = {
  ids: IDS, pageId: 'home', table: TABLE,
  isDuplicable: (id) => DUPLICABLE.has(id),
  groupOf: () => null,
};
const widgets = (over) => {
  const w = {};
  for (const id of IDS) w[id] = { visible: false, page: 'home' };
  return Object.assign(w, over);
};

test('a visible widget that cannot be added twice is named, with where it is', () => {
  const out = PM.placedBuiltins({
    ...base,
    widgets: widgets({ weather: { visible: true, page: 'home' }, notifications: { visible: true, page: 'work' } }),
  });
  assert.deepEqual(out.map((e) => [e.id, e.where]), [
    ['weather', { type: 'here' }],
    ['notifications', { type: 'page', page: 'work' }],
  ]);
  assert.ok(out.every((e) => e.kind === 'placed' && e.base === e.id));
  assert.deepEqual(out.map((e) => e.category), ['productivity', 'productivity']);
});

test('a hidden widget is offered to add, not listed as placed', () => {
  const out = PM.placedBuiltins({ ...base, widgets: widgets({}) });
  assert.deepEqual(out, []);
});

test('a widget that can be duplicated is offered as a copy, a tab in a group is offered, custom never listed', () => {
  const out = PM.placedBuiltins({
    ...base,
    widgets: widgets({
      agenda: { visible: true, page: 'home' },       // duplicable: the panel offers a copy
      weather: { visible: true, page: 'home' },      // in a group: the panel offers to pull it out
      custom: { visible: true, page: 'home' },
    }),
    groupOf: (id) => (id === 'weather' ? 'g1' : null),
  });
  assert.deepEqual(out, []);
});

test('a widget with no entry in the layout is skipped, not guessed', () => {
  const w = widgets({ weather: { visible: true, page: 'home' } });
  delete w.notifications;
  const out = PM.placedBuiltins({ ...base, widgets: w });
  assert.deepEqual(out.map((e) => e.id), ['weather']);
  assert.deepEqual(PM.placedBuiltins({ ...base, widgets: null }), []);
});

test('in tab mode only the other tabs of that tile are named', () => {
  const out = PM.placedBuiltins({
    ...base,
    widgets: widgets({ weather: { visible: true, page: 'home' } }),   // standalone: not relevant here
    tabTarget: 'media', members: ['media', 'chat', 'agenda~x1', 'custom'],
  });
  assert.deepEqual(out.map((e) => [e.id, e.where.type, e.category]), [['chat', 'tab', 'media']]);
  assert.deepEqual(PM.placedBuiltins({ ...base, widgets: widgets({}), tabTarget: 'media', members: ['media'] }), []);
});

test('the filters apply to them: a category shows its own, Installed shows none', () => {
  const out = PM.placedBuiltins({
    ...base,
    widgets: widgets({ weather: { visible: true, page: 'home' }, chat: { visible: true, page: 'home' } }),
    isDuplicable: () => false,
  });
  assert.deepEqual(PM.filterEntries(out, 'all').map((e) => e.id), ['weather', 'chat']);
  assert.deepEqual(PM.filterEntries(out, 'productivity').map((e) => e.id), ['weather']);
  assert.deepEqual(PM.filterEntries(out, 'media').map((e) => e.id), ['chat']);
  assert.deepEqual(PM.filterEntries(out, 'installed'), []);
});

// ── The panel draws them ────────────────────────────────────────────────────
const PALETTE = read('../js/dashboard-palette.js');

test('the panel lists them last, in the filter that is on, and in the search', () => {
  assert.match(PALETTE, /renderBlock\(pop, 'palette_placed', PM\(\)\.filterEntries\(placedModel, filter\)\.map\(toPlacedItem\), \(e\) => e\.pick\(\)\);\n    \};\n    render\(\);/);
  assert.match(PALETTE, /\.\.\.PM\(\)\.filterEntries\(placedModel, filter\)\.map\(toPlacedItem\),\n    \]\);/);
  // Found by the same words, a little below an entry that can be added.
  assert.match(PALETTE, /weight: \(f\.weight \|\| 1\) \* 0\.85/);
});

test('a tap goes to the widget; one marked placed with no tile on any page is put here', () => {
  const body = PALETTE.slice(PALETTE.indexOf('const showPlaced = (m) => {'), PALETTE.indexOf('const toPlacedItem'));
  assert.match(body, /tg\.setGroupActive\(tabGroupId, m\.id\)/, 'a tab is selected');
  assert.match(body, /P\.goToPage\(at\.page\)/, 'the pager goes to its page');
  assert.match(body, /tile\.closest\('#widget-pool'\)/, 'a tile parked in the pool is not a placement');
  assert.match(body, /addWidgetToPage\(m\.id, pageId\)/);
  assert.match(body, /classList\.add\('widget-found'\)/);
  assert.match(body, /classList\.remove\('widget-found'\), 2000\)/, 'the light goes off by itself');
});

test('a placed item is the same item, quieter, ending in an arrow; the lit tile has its animation', () => {
  assert.match(PALETTE, /btn\.classList\.add\('is-placed'\);/);
  assert.match(PALETTE, /go\.className = 'widget-palette-go';/);
  const css = read('../components/DashboardGrid/DashboardGrid.css');
  assert.match(css, /\.widget-palette-item\.is-placed \{ background: transparent;/);
  assert.match(css, /\.grid-stack-item\.widget-found \{ animation: widget-found 2s ease; \}/);
});

test('every language has the heading and the three "where" lines, and the page name slots in', () => {
  const I18N = read('../js/i18n.js');
  for (const lang of ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']) {
    const m = new RegExp('Object\\.assign\\(i18n\\.' + lang + ', \\{\\n  palette_placed: "([^"]+)",\\n  palette_placed_page: "([^"]+)",\\n  palette_placed_here: "([^"]+)",\\n  palette_placed_tab: "([^"]+)",').exec(I18N);
    assert.ok(m, `${lang} lacks the palette_placed strings`);
    assert.ok(m[2].includes('{page}'), `${lang}: the page line has no {page}`);
  }
});
