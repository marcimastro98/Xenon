import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { clampPageIndex, resolvePageId, shouldPageOnWheel, computeActivePages, computeParkedIndices, shouldFloatDots } = require('../js/dashboard-pager.js');

test('computeParkedIndices: every active page except the current one', () => {
  const pages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(computeParkedIndices(pages, 0), [1, 2]);
  assert.deepEqual(computeParkedIndices(pages, 1), [0, 2]);
});

test('computeParkedIndices: inactive pages are never parked (they are display:none already)', () => {
  const pages = [{ id: 'a' }, { id: 'b', active: false }, { id: 'c' }];
  assert.deepEqual(computeParkedIndices(pages, 0), [2]);
});

test('computeParkedIndices: tolerates empty and malformed input', () => {
  assert.deepEqual(computeParkedIndices([], 0), []);
  assert.deepEqual(computeParkedIndices(null, 0), []);
  assert.deepEqual(computeParkedIndices([null, { id: 'b' }], 1), []);
});

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

// The floating fallback page indicator exists for one situation: a full-page
// tile in a chrome where the normal dots are not shown (the "None" bar, or
// Minimal with the dots segment hidden), where the page swipe cannot begin over
// the widget's iframe. It must appear ONLY then.
test('shouldFloatDots: only with >1 page, not editing, and the real dots hidden', () => {
  // The one case it exists for: two pages, dots off-screen, not editing.
  assert.equal(shouldFloatDots(2, false, false), true);
  // Real dots on screen (Full bar, or Minimal with dots shown) → never doubles them.
  assert.equal(shouldFloatDots(2, false, true), false);
  // A single page has nowhere to go.
  assert.equal(shouldFloatDots(1, false, false), false);
  // Editing: the topbar host carries the page-manager controls; don't float.
  assert.equal(shouldFloatDots(3, true, false), false);
});
