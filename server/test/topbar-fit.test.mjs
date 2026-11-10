import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { needsSqueeze, CLEARANCE } = require('../js/topbar-fit.js');

const clock = { left: 1000, right: 1200 };

test('a bar with room to spare keeps its labels', () => {
  assert.equal(needsSqueeze({ clock, actions: { left: 1400 }, quick: { right: 800, height: 36 }, buttonHeight: 36 }), false);
});

test('the right group reaching the clock squeezes the bar', () => {
  assert.equal(needsSqueeze({ clock, actions: { left: 1200 + CLEARANCE - 1 }, quick: { right: 800, height: 36 }, buttonHeight: 36 }), true);
});

test('the left group reaching the clock squeezes the bar', () => {
  assert.equal(needsSqueeze({ clock, actions: { left: 1400 }, quick: { right: 1000 - CLEARANCE + 1, height: 36 }, buttonHeight: 36 }), true);
});

test('a quickbar that wrapped to two rows squeezes the bar', () => {
  assert.equal(needsSqueeze({ clock, actions: { left: 1400 }, quick: { right: 800, height: 80 }, buttonHeight: 36 }), true);
});

test('no clock (Minimal mode, hidden bar) never squeezes', () => {
  assert.equal(needsSqueeze(null), false);
  assert.equal(needsSqueeze({ clock: { left: 0, right: 0 }, actions: { left: 0 } }), false);
});
