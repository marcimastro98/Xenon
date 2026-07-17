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

// Mirror-widget predicate matching DashboardInstances.MIRROR_WIDGETS, injected so
// the helper stays pure (no window) in the test environment.
const isMirror = (id) => /^(system|media|chat|mic|audio|agenda|calendar|tasks|timer|notes)(~|$)/.test(id);

test('promoteSurvivingPrimaries moves a standalone mirror primary onto a surviving copy slot', () => {
  const layout = {
    widgets: {
      system: { visible: true, page: 'p2', x: 8, y: 0, w: 4, h: 9 },
      deck: { visible: true, page: 'p2', x: 0, y: 0, w: 4, h: 4 },
    },
    groups: {},
    copies: [
      { id: 'system~aa', widget: 'system', page: 'p1', x: 0, y: 0, w: 4, h: 9 },
      { id: 'deck~bb', widget: 'deck', page: 'p1', x: 4, y: 0, w: 4, h: 4 },
    ],
  };
  p.promoteSurvivingPrimaries(layout, 'p2', isMirror); // deleting p2 (primary's page)
  // System primary relocated to the surviving copy's slot on p1; copy dropped.
  assert.equal(layout.widgets.system.page, 'p1');
  assert.equal(layout.widgets.system.visible, true);
  assert.equal(layout.widgets.system.x, 0);
  assert.ok(!layout.copies.some(c => c.id === 'system~aa'));
  // Deck is independent-per-instance → primary untouched, copy preserved.
  assert.equal(layout.widgets.deck.page, 'p2');
  assert.ok(layout.copies.some(c => c.id === 'deck~bb'));
});

test('promoteSurvivingPrimaries leaves the primary alone when it is not on the removed page', () => {
  const layout = {
    widgets: { system: { visible: true, page: 'p1', x: 0, y: 0, w: 4, h: 9 } },
    groups: {},
    copies: [{ id: 'system~aa', widget: 'system', page: 'p2', x: 0, y: 0, w: 4, h: 9 }],
  };
  p.promoteSurvivingPrimaries(layout, 'p2', isMirror); // deleting p2 (the copy's page)
  assert.equal(layout.widgets.system.page, 'p1');            // primary stays put
  assert.ok(layout.copies.some(c => c.id === 'system~aa'));  // copy left for page-removal to clear
});

test('promoteSurvivingPrimaries skips grouped placements (group relocation handles those)', () => {
  const layout = {
    widgets: { media: { visible: false, page: 'p2' }, system: { visible: true, page: 'p2', x: 0, y: 0, w: 4, h: 4 } },
    groups: { g1: { members: ['media', 'chat'], page: 'p2' } },
    copies: [
      { id: 'media~aa', widget: 'media', page: 'p1' },          // standalone copy, but primary is grouped
      { id: 'system~bb', widget: 'system', page: 'p3', x: 1, y: 1, w: 4, h: 4 }, // grouped copy below
    ],
    // make the system copy a group member on a surviving page
  };
  layout.groups.g2 = { members: ['system~bb', 'notes~cc'], page: 'p3' };
  p.promoteSurvivingPrimaries(layout, 'p2', isMirror);
  assert.equal(layout.widgets.media.page, 'p2');          // grouped primary untouched
  assert.equal(layout.widgets.system.page, 'p2');         // only a GROUPED copy survives → no promotion
  assert.equal(layout.copies.length, 2);                  // nothing dropped
});

test('removePageInstances drops a tab-group on the page and deletes its copy members', () => {
  const layout = {
    widgets: { media: {}, chat: {} },
    groups: {
      // a duplicated Media+Chat group living on the page being deleted
      'g-dup': { id: 'g-dup', page: 'p2', members: ['media~aa', 'chat~bb'], active: 'chat~bb' },
      // an unrelated group on a surviving page stays
      'g-keep': { id: 'g-keep', page: 'p1', members: ['calendar', 'notes'], active: 'notes' },
    },
    copies: [
      { id: 'media~aa', widget: 'media', page: 'p2' },
      { id: 'chat~bb', widget: 'chat', page: 'p2' },
      { id: 'deck~cc', widget: 'deck', page: 'p1' }, // on a surviving page → kept
    ],
  };
  const removed = p.removePageInstances(layout, 'p2');
  assert.deepEqual(Object.keys(layout.groups), ['g-keep']);      // duplicate group gone
  assert.deepEqual(layout.copies.map(c => c.id), ['deck~cc']);   // its copy members gone, survivor kept
  assert.deepEqual(removed.map(c => c.id).sort(), ['chat~bb', 'media~aa']);
});

test('removePageInstances deletes a group copy member even if the copy carries a different page', () => {
  const layout = {
    widgets: {},
    groups: { 'g-dup': { id: 'g-dup', page: 'p2', members: ['media~aa', 'chat~bb'] } },
    // copy member mistakenly tagged with the first page — still removed by membership
    copies: [{ id: 'media~aa', widget: 'media', page: 'p1' }, { id: 'chat~bb', widget: 'chat', page: 'p2' }],
  };
  const removed = p.removePageInstances(layout, 'p2');
  assert.deepEqual(layout.groups, {});
  assert.equal(layout.copies.length, 0);
  assert.deepEqual(removed.map(c => c.id).sort(), ['chat~bb', 'media~aa']);
});

test('removePageInstances hides a dropped group\'s primary members and resets their geometry', () => {
  const defaults = { media: { x: 0, y: 0, w: 8, h: 8 }, chat: { x: 8, y: 0, w: 8, h: 8 } };
  const layout = {
    widgets: {
      // Stale page field (points at a SURVIVING page) — the classic pre-fix
      // state that made the widget "teleport" to p1 when p2 was deleted.
      media: { visible: true, page: 'p1', x: 5, y: 5, w: 3, h: 3 },
      chat: { visible: true, page: 'p2', x: 6, y: 6, w: 3, h: 3 },
    },
    groups: { g1: { id: 'g1', page: 'p2', members: ['media', 'chat'], active: 'media' } },
    copies: [],
  };
  p.removePageInstances(layout, 'p2', defaults);
  assert.deepEqual(layout.groups, {});
  assert.equal(layout.widgets.media.visible, false);
  assert.equal(layout.widgets.media.page, 'p2');   // truthful again → orphan reassignment re-homes it
  assert.equal(layout.widgets.media.x, 0);
  assert.equal(layout.widgets.media.w, 8);
  assert.equal(layout.widgets.chat.visible, false);
  assert.equal(layout.widgets.chat.x, 8);
});

test('removePageInstances leaves grouped primaries on OTHER pages alone', () => {
  const layout = {
    widgets: { calendar: { visible: true, page: 'p1', x: 1, y: 1, w: 4, h: 4 } },
    groups: { g1: { id: 'g1', page: 'p1', members: ['calendar', 'notes~aa'] } },
    copies: [{ id: 'notes~aa', widget: 'notes', page: 'p1' }],
  };
  p.removePageInstances(layout, 'p2', { calendar: { x: 0, y: 0, w: 8, h: 8 } });
  assert.equal(layout.widgets.calendar.visible, true);
  assert.equal(layout.widgets.calendar.x, 1);
  assert.ok(layout.groups.g1);
});

test('removePageInstances is a no-op when the page has no instance tiles', () => {
  const layout = {
    widgets: { media: { page: 'p1' } },
    groups: { 'media-group': { id: 'media-group', page: 'p1', members: ['media', 'chat'] } },
    copies: [{ id: 'deck~cc', widget: 'deck', page: 'p1' }],
  };
  const removed = p.removePageInstances(layout, 'p2');
  assert.deepEqual(Object.keys(layout.groups), ['media-group']);
  assert.equal(layout.copies.length, 1);
  assert.equal(removed.length, 0);
});

test('normalizePagesList preserves the imported marker and never invents it', () => {
  const out = p.normalizePagesList([
    { id: 'a', name: 'Mine' },
    { id: 'b', name: 'Theirs', imported: true },
    { id: 'c', name: 'Hostile', imported: 1 },
  ], SEED);
  assert.equal('imported' in out[0], false);
  assert.equal(out[1].imported, true);
  assert.equal('imported' in out[2], false);
});

test('normalizePagesList preserves a valid receipt id only on imported pages', () => {
  const out = p.normalizePagesList([
    { id: 'a', name: 'Tracked', imported: true, installId: 'xi_m5abc123deadbeef' },
    { id: 'b', name: 'Mine', installId: 'xi_m5abc123deadbeef' },
    { id: 'c', name: 'Bad', imported: true, installId: '../bad' },
  ], SEED);
  assert.equal(out[0].installId, 'xi_m5abc123deadbeef');
  assert.equal('installId' in out[1], false);
  assert.equal('installId' in out[2], false);
});
