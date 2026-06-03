import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const p = require('../js/dashboard-pages.js');

const SEED = [{ id: 'dashboard', name: '', nameKey: 'page_dashboard' }, { id: 'lighting', name: '', nameKey: 'page_lighting' }];

test('normalizePagesList keeps valid pages, dedupes ids, clamps count', () => {
  assert.deepEqual(p.normalizePagesList([{ id: 'a', name: 'A' }, { id: 'a', name: 'dup' }], SEED), [{ id: 'a', name: 'A' }]);
  assert.deepEqual(p.normalizePagesList(null, SEED), SEED);
  assert.deepEqual(p.normalizePagesList([], SEED), SEED);
  const many = Array.from({ length: 12 }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));
  assert.equal(p.normalizePagesList(many, SEED).length, p.DASHBOARD_PAGES_MAX);
});

test('normalizePagesList clamps long names and preserves nameKey', () => {
  const out = p.normalizePagesList([{ id: 'dashboard', name: '   ', nameKey: 'page_dashboard' }], SEED);
  assert.equal(out[0].name, '');
  assert.equal(out[0].nameKey, 'page_dashboard');
  const long = p.normalizePagesList([{ id: 'x', name: 'z'.repeat(80) }], SEED);
  assert.equal(long[0].name.length, 40);
});

test('reassignOrphanWidgetPages sends widgets on missing pages to the first page', () => {
  const widgets = { a: { page: 'gone' }, b: { page: 'dashboard' } };
  p.reassignOrphanWidgetPages(widgets, ['dashboard', 'lighting'], 'dashboard');
  assert.equal(widgets.a.page, 'dashboard');
  assert.equal(widgets.b.page, 'dashboard');
});

test('movePageInList swaps neighbours and clamps at the ends', () => {
  const pages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(p.movePageInList(pages, 'b', -1).map(x => x.id), ['b', 'a', 'c']);
  assert.deepEqual(p.movePageInList(pages, 'b', 1).map(x => x.id), ['a', 'c', 'b']);
  assert.deepEqual(p.movePageInList(pages, 'a', -1).map(x => x.id), ['a', 'b', 'c']);
});
