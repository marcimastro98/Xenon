import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizePresets } = require('../js/dashboard-presets.js');

// Grid-units migration for saved presets: entries saved before the 24-column
// grid carry no gridCols field and are in 12-column units — normalizePresets
// must scale them ×2 exactly once and stamp gridCols on the output, while
// already-stamped entries pass through unscaled.

const KNOWN = ['media', 'system', 'chat'];

test('a legacy (unflagged) widget preset is scaled ×2 and stamped', () => {
  const out = normalizePresets([
    { id: 'p1', name: 'Old', kind: 'widget', createdAt: 1, data: { widget: 'system', w: 4, h: 3 } },
  ], KNOWN);
  assert.equal(out.length, 1);
  assert.equal(out[0].gridCols, 24);
  assert.deepEqual({ w: out[0].data.w, h: out[0].data.h }, { w: 8, h: 6 });
});

test('a stamped (24-col) preset passes through unscaled', () => {
  const out = normalizePresets([
    { id: 'p1', name: 'New', kind: 'widget', createdAt: 1, gridCols: 24, data: { widget: 'system', w: 8, h: 6 } },
  ], KNOWN);
  assert.deepEqual({ w: out[0].data.w, h: out[0].data.h }, { w: 8, h: 6 });
  assert.equal(out[0].gridCols, 24);
});

test('normalize is idempotent once stamped (no double scaling on re-normalize)', () => {
  const once = normalizePresets([
    { id: 'p1', name: 'Old', kind: 'widget', createdAt: 1, data: { widget: 'system', w: 4, h: 3 } },
  ], KNOWN);
  const twice = normalizePresets(once, KNOWN);
  assert.deepEqual({ w: twice[0].data.w, h: twice[0].data.h }, { w: 8, h: 6 });
});

test('a legacy page preset scales every item, groups included', () => {
  const out = normalizePresets([
    {
      id: 'pg', name: 'Page', kind: 'page', createdAt: 1,
      data: {
        items: [
          { type: 'widget', widget: 'system', x: 4, y: 2, w: 4, h: 3 },
          { type: 'group', x: 0, y: 0, w: 4, h: 4, members: ['media', 'chat'], active: 0 },
        ],
      },
    },
  ], KNOWN);
  const [w, g] = out[0].data.items;
  assert.deepEqual({ x: w.x, y: w.y, w: w.w, h: w.h }, { x: 8, y: 4, w: 8, h: 6 });
  assert.deepEqual({ x: g.x, y: g.y, w: g.w, h: g.h }, { x: 0, y: 0, w: 8, h: 8 });
});

test('a legacy group preset scales its tile size', () => {
  const out = normalizePresets([
    { id: 'g1', name: 'Grp', kind: 'group', createdAt: 1, data: { members: ['media', 'chat'], active: 0, w: 4, h: 4 } },
  ], KNOWN);
  assert.deepEqual({ w: out[0].data.w, h: out[0].data.h }, { w: 8, h: 8 });
});

test('the imported marker survives normalize and is never invented', () => {
  const out = normalizePresets([
    { id: 'p1', name: 'Theirs', kind: 'page', createdAt: 1, gridCols: 24, imported: true, data: { items: [{ type: 'widget', widget: 'system', x: 0, y: 0, w: 8, h: 6 }] } },
    { id: 'p2', name: 'Mine', kind: 'page', createdAt: 1, gridCols: 24, data: { items: [{ type: 'widget', widget: 'media', x: 0, y: 0, w: 8, h: 6 }] } },
    { id: 'p3', name: 'Hostile', kind: 'page', createdAt: 1, gridCols: 24, imported: 'yes', data: { items: [{ type: 'widget', widget: 'chat', x: 0, y: 0, w: 8, h: 6 }] } },
  ], KNOWN);
  assert.equal(out[0].imported, true);
  assert.equal('imported' in out[1], false);
  assert.equal('imported' in out[2], false);   // only literal true survives
});

test('an imported preset preserves only a valid install receipt id', () => {
  const out = normalizePresets([
    { id: 'p1', name: 'Tracked', kind: 'page', createdAt: 1, gridCols: 24, imported: true, installId: 'xi_m5abc123deadbeef', data: { items: [{ type: 'widget', widget: 'system', x: 0, y: 0, w: 8, h: 6 }] } },
    { id: 'p2', name: 'Hostile', kind: 'page', createdAt: 1, gridCols: 24, imported: true, installId: '../bad', data: { items: [{ type: 'widget', widget: 'media', x: 0, y: 0, w: 8, h: 6 }] } },
  ], KNOWN);
  assert.equal(out[0].installId, 'xi_m5abc123deadbeef');
  assert.equal('installId' in out[1], false);
});
