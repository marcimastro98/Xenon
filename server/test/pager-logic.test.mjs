import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { clampPageIndex, resolvePageId, shouldPageOnWheel, computeActivePages } = require('../js/dashboard-pager.js');

test('clampPageIndex keeps index inside [0, count-1]', () => {
  assert.equal(clampPageIndex(-2, 3), 0);
  assert.equal(clampPageIndex(0, 3), 0);
  assert.equal(clampPageIndex(2, 3), 2);
  assert.equal(clampPageIndex(9, 3), 2);
  assert.equal(clampPageIndex(0, 0), 0);
});

test('resolvePageId maps an id to its index, -1 when unknown', () => {
  const pages = [{ id: 'dashboard' }, { id: 'lighting' }];
  assert.equal(resolvePageId('dashboard', pages), 0);
  assert.equal(resolvePageId('lighting', pages), 1);
  assert.equal(resolvePageId('nope', pages), -1);
});

test('shouldPageOnWheel only pages on a clear horizontal intent', () => {
  assert.equal(shouldPageOnWheel({ deltaX: 60, deltaY: 0, shiftKey: false }), 1);
  assert.equal(shouldPageOnWheel({ deltaX: -60, deltaY: 0, shiftKey: false }), -1);
  assert.equal(shouldPageOnWheel({ deltaX: 0, deltaY: 60, shiftKey: true }), 1);
  assert.equal(shouldPageOnWheel({ deltaX: 0, deltaY: 60, shiftKey: false }), 0);
  assert.equal(shouldPageOnWheel({ deltaX: 3, deltaY: 0, shiftKey: false }), 0);
});

test('computeActivePages: editing shows all pages in declared order', () => {
  const all = ['dashboard', 'lighting'];
  const widgets = { media: { visible: true, page: 'dashboard' } };
  assert.deepEqual(computeActivePages(all, widgets, true), ['dashboard', 'lighting']);
});

test('computeActivePages: not editing hides pages with no visible widget', () => {
  const all = ['dashboard', 'lighting'];
  const widgets = {
    media: { visible: true, page: 'dashboard' },
    lighting: { visible: false, page: 'lighting' },
  };
  assert.deepEqual(computeActivePages(all, widgets, false), ['dashboard']);
});

test('computeActivePages: a page with a visible widget stays', () => {
  const all = ['dashboard', 'lighting'];
  const widgets = {
    media: { visible: true, page: 'dashboard' },
    lighting: { visible: true, page: 'lighting' },
  };
  assert.deepEqual(computeActivePages(all, widgets, false), ['dashboard', 'lighting']);
});
