import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PM = require('../js/palette-model.js');

// The "+" panel's model. A Store widget is an entry of its own, filed under a
// category (its manifest's, else its catalog entry's, else "other"); the
// generic "custom" host tile is never offered.

const TABLE = [
  { labelKey: 'palette_cat_productivity', ids: ['notes', 'weather'] },
  { labelKey: 'palette_cat_media', ids: ['media'] },
  { labelKey: 'palette_cat_system', ids: ['system'] },
  { labelKey: 'palette_cat_streaming', ids: ['obs'] },
];

test('a package category: manifest first, then the catalog, then other', () => {
  assert.equal(PM.packageCategory({ category: 'media' }, { category: 'system' }), 'media');
  assert.equal(PM.packageCategory({ category: 'nonsense' }, { category: 'system' }), 'system');
  assert.equal(PM.packageCategory({}, { category: 'smart-home' }), 'system');
  assert.equal(PM.packageCategory({}, { category: 'deck' }), 'streaming');
  assert.equal(PM.packageCategory({}, { category: 'tools' }), 'productivity');
  assert.equal(PM.packageCategory({}, { category: 'style' }), 'other');
  assert.equal(PM.packageCategory({}, null), 'other');
  // Every catalog category has a home in the panel.
  for (const c of ['deck', 'streaming', 'media', 'smart-home', 'system', 'style', 'fun', 'tools']) {
    assert.ok(PM.CATEGORIES.includes(PM.FROM_CATALOG[c]), c);
  }
});

test('the catalog entry of a package: its own pkgId, else the bundle that installed it', () => {
  const entries = [
    { id: 'river', pkgId: 'workload-river', category: 'system' },
    { id: 'nitrato', category: 'style' },
    { id: 'vanguard-50', category: 'fun', limited: { dropId: 'vanguard-50' } },
  ];
  const receipts = [
    { source: 'catalog', sourceId: 'nitrato', resources: { widgetIds: ['nitrato-clock'] } },
    { source: 'catalog', sourceId: 'vanguard-50-07', resources: { widgetIds: ['vanguard-hud'] } },
    { source: 'import', sourceId: 'river', resources: { widgetIds: ['pasted'] } },
  ];
  assert.equal(PM.catalogEntryForPackage('workload-river', entries, receipts).id, 'river');
  assert.equal(PM.catalogEntryForPackage('nitrato-clock', entries, receipts).id, 'nitrato');
  assert.equal(PM.catalogEntryForPackage('vanguard-hud', entries, receipts).id, 'vanguard-50', 'a numbered copy finds its drop');
  assert.equal(PM.catalogEntryForPackage('pasted', entries, receipts), null, 'a pasted code proves nothing');
  assert.equal(PM.catalogEntryForPackage('x', null, receipts), null);
});

test('entries: built-ins in their category, custom dropped, packages filed and named', () => {
  const entries = PM.buildEntries({
    builtins: [{ id: 'notes' }, { id: 'system' }, { id: 'custom' }, { id: 'custom~ab12', base: 'custom' }, { id: 'future' }],
    packages: [
      { id: 'zed', name: 'Zed', category: 'media' },
      { id: 'river', name: 'Workload River' },
      { id: 'scene', name: 'Scene', surface: 'ambient' },
      { id: 'noname' },
    ],
    table: TABLE,
    catalog: [{ id: 'river', pkgId: 'river', category: 'system' }],
    receipts: [],
  });
  assert.deepEqual(entries.map(e => e.id), ['notes', 'system', 'future', 'river', 'zed'], 'no custom, no ambient, no nameless; packages by name');
  const by = Object.fromEntries(entries.map(e => [e.id, e]));
  assert.equal(by.notes.category, 'productivity');
  assert.equal(by.future.category, 'other', 'an unknown built-in still has a home');
  assert.equal(by.river.category, 'system');
  assert.equal(by.zed.category, 'media');
  assert.equal(by.river.installed, true);
  assert.equal(by.notes.installed, false);
});

test('filters: installed shows only Store widgets, a category shows its own, empty ones are not offered', () => {
  const entries = PM.buildEntries({
    builtins: [{ id: 'notes' }, { id: 'media' }],
    packages: [{ id: 'river', name: 'River', category: 'system' }],
    table: TABLE, catalog: [], receipts: [],
  });
  assert.deepEqual(PM.filterEntries(entries, 'installed').map(e => e.id), ['river']);
  assert.deepEqual(PM.filterEntries(entries, 'media').map(e => e.id), ['media']);
  assert.equal(PM.filterEntries(entries, 'all').length, 3);
  assert.deepEqual(PM.availableFilters(entries), ['all', 'installed', 'productivity', 'media', 'system']);
  const builtinOnly = PM.buildEntries({ builtins: [{ id: 'notes' }], packages: [], table: TABLE });
  assert.deepEqual(PM.availableFilters(builtinOnly), ['all', 'productivity'], 'no Store widgets, no Installed filter');
  assert.deepEqual(PM.availableFilters(builtinOnly, true), ['all', 'installed', 'productivity'], 'unless asked, to point at the Store');
  assert.deepEqual(PM.groupByCategory(entries).map(([c]) => c), ['productivity', 'media', 'system'], 'in the panel order');
});
