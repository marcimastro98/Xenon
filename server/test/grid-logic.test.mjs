import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const g = require('../js/dashboard-grid.js');

test('availableWidgets lists hidden widget ids', () => {
  const widgets = { media: { visible: true }, mic: { visible: false }, audio: { visible: false } };
  assert.deepEqual(g.availableWidgets(widgets, ['media', 'mic', 'audio']).sort(), ['audio', 'mic']);
});

test('firstFreeSlot finds a non-overlapping cell on a 12-col grid', () => {
  const occupied = [{ x: 0, y: 0, w: 4, h: 4 }];
  assert.deepEqual(g.firstFreeSlot(occupied, 4, 2, 12), { x: 4, y: 0 });
});

test('firstFreeSlot wraps to the next row when the row is full', () => {
  const occupied = [{ x: 0, y: 0, w: 12, h: 2 }];
  assert.deepEqual(g.firstFreeSlot(occupied, 6, 2, 12), { x: 0, y: 2 });
});

test('addableWidgetIds lists hidden widgets and group members, not standalone ones', () => {
  const widgets = {
    media: { visible: true }, chat: { visible: true },   // both in a group
    calendar: { visible: true },                          // standalone, placed
    mic: { visible: false },                              // hidden
  };
  const groups = { g1: { members: ['media', 'chat'] } };
  const ids = g.addableWidgetIds(widgets, groups, ['media', 'chat', 'calendar', 'mic']).sort();
  assert.deepEqual(ids, ['chat', 'media', 'mic']);
});

test('largestFreeRect returns the whole grid when empty', () => {
  assert.deepEqual(g.largestFreeRect([], 12, 2), { x: 0, y: 0, w: 12, h: 2 });
});

test('largestFreeRect returns null when the grid is full', () => {
  assert.equal(g.largestFreeRect([{ x: 0, y: 0, w: 12, h: 2 }], 12, 2), null);
});

test('largestFreeRect finds the free columns beside an occupied block', () => {
  // a 4-wide × 2-tall group on the left → free area is the right 8 cols, full height
  assert.deepEqual(g.largestFreeRect([{ x: 0, y: 0, w: 4, h: 2 }], 12, 2), { x: 4, y: 0, w: 8, h: 2 });
});

test('largestFreeRect picks the larger of two free regions', () => {
  // top-left 6×1 taken and bottom-right 6×1 taken → two 6×1 free strips; first found wins on area tie
  const rect = g.largestFreeRect([{ x: 0, y: 0, w: 6, h: 1 }, { x: 6, y: 1, w: 6, h: 1 }], 12, 2);
  assert.equal(rect.w * rect.h, 6);
});

test('resolveLayoutOverlaps relocates only the tile stacked on top of another', () => {
  // Two groups + system all declared at the same cells as the real corrupted
  // layout: a duplicate Media+Chat group sits on top of the seeded one.
  // Geometry in 24-column units (the current grid resolution).
  const layout = {
    pages: [{ id: 'p1', name: 'P' }],
    widgets: { system: { visible: true, page: 'p1', x: 16, y: 0, w: 8, h: 18 } },
    copies: [],
    groups: {
      'media-group': { id: 'media-group', seeded: true, page: 'p1', x: 0, y: 0, w: 8, h: 8, members: ['media', 'chat'], active: 'chat' },
      'g-dup': { id: 'g-dup', seeded: false, page: 'p1', x: 0, y: 0, w: 8, h: 18, members: ['m2', 'c2'], active: 'c2' },
      'g-cnd': { id: 'g-cnd', seeded: false, page: 'p1', x: 8, y: 0, w: 8, h: 18, members: ['calendar', 'notes', 'deck'], active: 'deck' },
    },
  };
  assert.equal(g.resolveLayoutOverlaps(layout), true);
  // Seeded group + the non-overlapping tiles keep their exact slots.
  assert.deepEqual({ x: layout.groups['media-group'].x, y: layout.groups['media-group'].y }, { x: 0, y: 0 });
  assert.deepEqual({ x: layout.groups['g-cnd'].x, y: layout.groups['g-cnd'].y }, { x: 8, y: 0 });
  assert.deepEqual({ x: layout.widgets.system.x, y: layout.widgets.system.y }, { x: 16, y: 0 });
  // Only the duplicate moved — to the first free slot below.
  assert.deepEqual({ x: layout.groups['g-dup'].x, y: layout.groups['g-dup'].y }, { x: 0, y: 8 });
  // And nothing overlaps anymore.
  const rects = [...Object.values(layout.groups), layout.widgets.system];
  const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  let overlaps = 0;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (hit(rects[i], rects[j])) overlaps++;
  assert.equal(overlaps, 0);
});

test('distributeCols with equal weights reproduces the even split (sums to columns)', () => {
  assert.deepEqual(g.distributeCols([1, 1, 1], 12), [4, 4, 4]);
  assert.deepEqual(g.distributeCols([1, 1], 12), [6, 6]);
  assert.deepEqual(g.distributeCols([1, 1, 1, 1], 12), [3, 3, 3, 3]);
  assert.deepEqual(g.distributeCols([1], 12), [12]);
});

test('distributeCols weights a tile wider while keeping the row summed to columns', () => {
  const cols = g.distributeCols([2, 1, 1], 12);
  assert.equal(cols.reduce((a, b) => a + b, 0), 12);
  assert.ok(cols[0] > cols[1] && cols[0] > cols[2], 'the weighted tile is widest');
  assert.ok(Math.min(...cols) >= 2, 'every tile keeps at least 2 columns');
});

test('distributeCols still sums to columns when a row has more tiles than min-width allows', () => {
  // 7 tiles × min 2 = 14 > 12: must not overflow — falls back below min to fit.
  const cols = g.distributeCols([1, 1, 1, 1, 1, 1, 1], 12);
  assert.equal(cols.reduce((a, b) => a + b, 0), 12);
  assert.ok(cols.every(c => c >= 1));
});

test('packPageItems lays out three tiles in one full-width row', () => {
  const layout = {
    widgets: {
      media: { visible: true, page: 'p1' },
      system: { visible: true, page: 'p1' },
      mic: { visible: true, page: 'p1' },
    },
    groups: {}, copies: [],
  };
  g.packPageItems(layout, 'p1');
  const rects = [layout.widgets.media, layout.widgets.system, layout.widgets.mic];
  assert.deepEqual(rects.map(r => r.w), [8, 8, 8]);
  assert.deepEqual(rects.map(r => r.x), [0, 8, 16]);
  assert.ok(rects.every(r => r.y === 0 && r.h === 8));
});

test('packPageItems honours a per-widget width weight', () => {
  const layout = {
    widgets: {
      obs: { visible: true, page: 'p1' },
      twitch: { visible: true, page: 'p1' },
      deck: { visible: true, page: 'p1' },
    },
    groups: {}, copies: [],
  };
  g.packPageItems(layout, 'p1', { obs: 2 });
  assert.ok(layout.widgets.obs.w > layout.widgets.twitch.w, 'obs tile is wider');
  const total = layout.widgets.obs.w + layout.widgets.twitch.w + layout.widgets.deck.w;
  assert.equal(total, 24);
});

test('packPageItems weights a tab-group tile by its widest member', () => {
  // packPageItems reads window.DashboardTabGroups.widgetGroupOf to exclude grouped
  // members; wire the real helper onto a temporary global window for this test.
  const tg = require('../js/dashboard-tabgroups.js');
  const prev = globalThis.window;
  globalThis.window = { DashboardTabGroups: { widgetGroupOf: tg.widgetGroupOf } };
  try {
    const layout = {
      widgets: {
        obs: { visible: true, page: 'p1' },       // grouped
        twitch: { visible: true, page: 'p1' },    // grouped
        deck: { visible: true, page: 'p1' },      // standalone
      },
      groups: { g1: { id: 'g1', page: 'p1', members: ['obs', 'twitch'], active: 'obs' } },
      copies: [],
    };
    g.packPageItems(layout, 'p1', { obs: 3 });
    // Two tiles on the page: the tab-group (widest member obs, weight 3) and deck.
    assert.ok(layout.groups.g1.w > layout.widgets.deck.w, 'the tab-group tile is wider');
    assert.equal(layout.groups.g1.w + layout.widgets.deck.w, 24);
  } finally {
    globalThis.window = prev;
  }
});

test('resolveLayoutOverlaps is a no-op for a healthy non-overlapping layout', () => {
  const layout = {
    pages: [{ id: 'p1', name: 'P' }],
    widgets: { media: { visible: true, page: 'p1', x: 0, y: 0, w: 4, h: 4 }, system: { visible: true, page: 'p1', x: 4, y: 0, w: 4, h: 4 } },
    copies: [],
    groups: {},
  };
  assert.equal(g.resolveLayoutOverlaps(layout), false);
  assert.deepEqual({ x: layout.widgets.media.x, y: layout.widgets.media.y }, { x: 0, y: 0 });
  assert.deepEqual({ x: layout.widgets.system.x, y: layout.widgets.system.y }, { x: 4, y: 0 });
});
