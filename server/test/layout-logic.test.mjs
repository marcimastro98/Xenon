import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const layout = require('../js/dashboard-layout.js');

test('nextAppendOrder returns one past the max order on the target page', () => {
  const widgets = {
    a: { order: 0, page: 'dashboard' },
    b: { order: 3, page: 'dashboard' },
    c: { order: 1, page: 'lighting' },
  };
  assert.equal(layout.nextAppendOrder(widgets, 'dashboard'), 4);
  assert.equal(layout.nextAppendOrder(widgets, 'lighting'), 2);
  assert.equal(layout.nextAppendOrder(widgets, 'empty'), 0);
});

test('otherPage toggles within the fixed page set', () => {
  assert.equal(layout.otherPage('dashboard', ['dashboard', 'lighting']), 'lighting');
  assert.equal(layout.otherPage('lighting', ['dashboard', 'lighting']), 'dashboard');
});
