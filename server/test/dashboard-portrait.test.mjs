import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../js/dashboard-portrait.js');

const EDGE = { width: 720, height: 2400 };

// A landscape layout shaped like a real one: three tall tiles side by side on
// the first page, five short ones on the second.
function layout(extra = {}) {
  return {
    pages: [{ id: 'dashboard', name: '1' }, { id: 'p2', name: '2' }],
    widgets: {
      deck: { visible: true, page: 'dashboard', x: 0, y: 0, w: 8, h: 37 },
      media: { visible: true, page: 'dashboard', x: 8, y: 0, w: 8, h: 37 },
      chat: { visible: true, page: 'dashboard', x: 16, y: 0, w: 8, h: 37 },
      clock: { visible: true, page: 'p2', x: 0, y: 0, w: 5, h: 11 },
      weather: { visible: true, page: 'p2', x: 5, y: 0, w: 6, h: 11 },
      claude: { visible: true, page: 'p2', x: 11, y: 0, w: 13, h: 11 },
      notes: { visible: true, page: 'p2', x: 0, y: 11, w: 8, h: 11 },
      hidden: { visible: false, page: 'p2', x: 0, y: 0, w: 8, h: 8 },
    },
    groups: {},
    copies: [],
    ...extra,
  };
}

const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
function assertNoOverlap(plan, pageId) {
  const rects = Object.values(plan).filter((r) => r.page === pageId);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) assert.ok(!overlaps(rects[i], rects[j]), JSON.stringify([rects[i], rects[j]]));
  }
}

test('the generated layout fills each page, in reading order, inside the columns', () => {
  const plan = P.planPortrait(layout(), EDGE);
  assert.deepEqual(Object.keys(plan).sort(), ['chat', 'claude', 'clock', 'deck', 'media', 'notes', 'weather']);
  for (const r of Object.values(plan)) {
    assert.ok(r.x >= 0 && r.x + r.w <= P.COLUMNS, JSON.stringify(r));
    assert.ok(r.h >= 4, JSON.stringify(r));
  }
  assert.equal(P.planRowSpan(plan, 'dashboard'), P.PORTRAIT_ROWS, 'page 1 fills the screen exactly');
  // Three wide tiles: one under the other, full width, left to right becoming top to bottom.
  assert.deepEqual(['deck', 'media', 'chat'].map((id) => [plan[id].x, plan[id].w]), [[0, 24], [0, 24], [0, 24]]);
  assert.ok(plan.deck.y < plan.media.y && plan.media.y < plan.chat.y);
  assertNoOverlap(plan, 'dashboard');
  assertNoOverlap(plan, 'p2');
});

// The reported bug: a tile built for a 720px-tall landscape panel spread over
// half a vertical one. Generated tiles keep their shape instead.
test('no generated tile takes most of the screen on a page with several', () => {
  const plan = P.planPortrait(layout(), EDGE);
  for (const r of Object.values(plan)) assert.ok(r.h <= P.MAX_GEN_H, JSON.stringify(r));
  assert.ok(plan.deck.h < P.PORTRAIT_ROWS / 2);
});

// A narrow tile alone in its band is widened to the full width; it keeps the
// height it had, so it does not end up taller than its wide neighbours.
test('a widened narrow tile is no taller than tiles of the same landscape height', () => {
  const l = layout();
  l.widgets.transfer = { visible: true, page: 'p3', x: 19, y: 0, w: 5, h: 11 };
  l.widgets.stocks = { visible: true, page: 'p3', x: 0, y: 0, w: 11, h: 11 };
  l.widgets.news = { visible: true, page: 'p3', x: 11, y: 0, w: 8, h: 11 };
  l.pages.push({ id: 'p3', name: '3' });
  const plan = P.planPortrait(l, EDGE);
  assert.equal(plan.transfer.w, P.COLUMNS);
  assert.ok(plan.transfer.h <= Math.max(plan.stocks.h, plan.news.h), JSON.stringify(plan));
});

test('narrow tiles pair up side by side; a lone narrow one takes the whole band', () => {
  const plan = P.planPortrait(layout(), EDGE);
  // clock + weather are narrow and adjacent: one band, half each.
  assert.equal(plan.clock.w, 12);
  assert.equal(plan.weather.w, 12);
  assert.equal(plan.clock.y, plan.weather.y);
  assert.equal(plan.weather.x, 12);
  // claude is wide; notes is narrow but alone in its band.
  assert.equal(plan.claude.w, 24);
  assert.equal(plan.notes.w, 24);
});

test('a screen too narrow for two tiles side by side draws one per band', () => {
  const plan = P.planPortrait(layout(), { width: 480, height: 1600 });
  for (const r of Object.values(plan)) assert.equal(r.w, 24, JSON.stringify(r));
  assertNoOverlap(plan, 'p2');
});

test('a page with one small tile grows it, but not without limit', () => {
  const l = layout();
  l.widgets = { clock: { visible: true, page: 'dashboard', x: 0, y: 0, w: 4, h: 4 } };
  const plan = P.planPortrait(l, EDGE);
  assert.ok(plan.clock.h < P.PORTRAIT_ROWS, 'empty space beats a blown-up tile');
  assert.ok(plan.clock.h >= P.MIN_GEN_H);
});

test('a crowded page still places every tile without overlap', () => {
  const l = layout();
  l.widgets = {};
  for (let i = 0; i < 14; i++) l.widgets['w' + i] = { visible: true, page: 'dashboard', x: (i % 3) * 8, y: Math.floor(i / 3) * 8, w: 8, h: 8 };
  const plan = P.planPortrait(l, EDGE);
  assert.equal(Object.keys(plan).length, 14);
  assertNoOverlap(plan, 'dashboard');
});

test('tab-groups and copies are placed; grouped members and hidden widgets are not', () => {
  const l = layout({
    groups: { g1: { page: 'dashboard', x: 0, y: 0, w: 8, h: 37, members: ['deck', 'media'] } },
    copies: [{ id: 'clock__2', widget: 'clock', page: 'p2', x: 0, y: 22, w: 8, h: 8 }],
  });
  const plan = P.planPortrait(l, EDGE);
  assert.ok(plan.g1 && plan.clock__2);
  assert.equal(plan.deck, undefined);
  assert.equal(plan.media, undefined);
  assert.equal(plan.hidden, undefined);
  assertNoOverlap(plan, 'dashboard');
  assertNoOverlap(plan, 'p2');
});

test('the generated layout follows the landscape one until it is arranged', () => {
  const l = layout();
  const before = P.planPortrait(l, EDGE);
  l.widgets.deck.x = 16; l.widgets.chat.x = 0;   // swapped on the landscape screen
  const after = P.planPortrait(l, EDGE);
  assert.ok(after.chat.y < after.deck.y, 'reading order follows the landscape layout');
  assert.notDeepEqual(before.chat, after.chat);
});

test('once arranged, stored rects stay put whatever the landscape layout does', () => {
  const l = layout();
  P.materialize(l, P.planPortrait(l, EDGE));
  l.portrait.items.deck = { x: 0, y: 30, w: 24, h: 10, page: 'dashboard' };
  l.portrait.items.chat = { x: 0, y: 0, w: 24, h: 14, page: 'dashboard' };
  l.portrait.items.media = { x: 0, y: 14, w: 24, h: 16, page: 'dashboard' };
  l.widgets.deck.x = 16; l.widgets.chat.x = 0;
  const plan = P.planPortrait(l, EDGE);
  assert.deepEqual(plan.deck, { x: 0, y: 30, w: 24, h: 10, page: 'dashboard' });
  assert.deepEqual(plan.chat, { x: 0, y: 0, w: 24, h: 14, page: 'dashboard' });
});

test('a tile new to an arranged page is fitted into free space, not over anything', () => {
  const l = layout();
  P.materialize(l, P.planPortrait(l, EDGE));
  l.widgets.hidden.visible = true;
  l.widgets.hidden.page = 'dashboard';
  const plan = P.planPortrait(l, EDGE);
  assert.ok(plan.hidden);
  assertNoOverlap(plan, 'dashboard');
  // The others did not move.
  const stored = l.portrait.items;
  for (const id of ['deck', 'media', 'chat']) assert.deepEqual(plan[id], stored[id]);
});

test('a tile moved to another page is placed again there', () => {
  const l = layout();
  P.materialize(l, P.planPortrait(l, EDGE));
  l.widgets.deck.page = 'p2';
  const plan = P.planPortrait(l, EDGE);
  assert.equal(plan.deck.page, 'p2');
  assertNoOverlap(plan, 'p2');
});

test('a new tab-group takes the place of the member that had one', () => {
  const l = layout();
  P.materialize(l, P.planPortrait(l, EDGE));
  const media = { ...l.portrait.items.media };
  l.groups = { g1: { page: 'dashboard', x: 8, y: 0, w: 8, h: 37, members: ['media', 'chat'] } };
  const plan = P.planPortrait(l, EDGE);
  assert.deepEqual(plan.g1, media);
  assertNoOverlap(plan, 'dashboard');
});

test('overlapping stored rects heal: the later tile yields', () => {
  const l = layout();
  P.materialize(l, P.planPortrait(l, EDGE));
  l.portrait.items.media = { ...l.portrait.items.deck };
  const plan = P.planPortrait(l, EDGE);
  assertNoOverlap(plan, 'dashboard');
});

test('reset brings one page, or all of them, back to the generated layout', () => {
  const l = layout();
  P.materialize(l, P.planPortrait(l, EDGE));
  l.portrait.items.clock = { x: 0, y: 40, w: 24, h: 8, page: 'p2' };
  l.portrait.items.deck = { x: 0, y: 40, w: 24, h: 8, page: 'dashboard' };
  P.resetPortrait(l, 'p2');
  const generated = P.planPortrait(layout(), EDGE);
  const plan = P.planPortrait(l, EDGE);
  assert.deepEqual(plan.clock, generated.clock, 'page 2 regenerated');
  assert.deepEqual(plan.deck, { x: 0, y: 40, w: 24, h: 8, page: 'dashboard' }, 'page 1 kept');
  P.resetPortrait(l);
  assert.deepEqual(l.portrait, { custom: false, items: {} });
});

test('tap-to-cycle stays inside the vertical grid', () => {
  let r = { x: 12, y: 0, w: 12, h: 8, page: 'dashboard' };
  for (let i = 0; i < 6; i++) {
    r = P.nextSize(r);
    assert.ok(r.x >= 0 && r.x + r.w <= P.COLUMNS, JSON.stringify(r));
    assert.equal(r.page, 'dashboard');
  }
});

// ── The boundary ─────────────────────────────────────────────────────────────

test('anything but an explicit custom layout normalizes to the generated one', () => {
  const l = layout();
  for (const v of [undefined, null, 'x', 42, [], {}, { custom: 'true' }, { custom: false, items: { deck: { x: 0, y: 0, w: 24, h: 8, page: 'dashboard' } } }]) {
    assert.deepEqual(P.normalizePortrait(v, l), { custom: false, items: {} }, JSON.stringify(v));
  }
});

test('stored rects are clamped, and only real tiles on real pages survive', () => {
  const l = layout({ groups: { g1: { page: 'dashboard', members: [] } }, copies: [{ id: 'clock__2', widget: 'clock', page: 'p2' }] });
  const out = P.normalizePortrait({
    custom: true,
    items: {
      deck: { x: 30, y: -4, w: 99, h: 1, page: 'dashboard' },
      media: { x: 20, y: 3.4, w: 12, h: 10, page: 'dashboard' },
      g1: { x: 0, y: 0, w: 12, h: 8, page: 'dashboard' },
      clock__2: { x: 0, y: 0, w: 12, h: 8, page: 'p2' },
      ghost: { x: 0, y: 0, w: 12, h: 8, page: 'dashboard' },
      chat: { x: 0, y: 0, w: 12, h: 8, page: 'nowhere' },
      claude: { x: 'a', y: 0, w: 12, h: 8, page: 'p2' },
      notes: 'nope',
      __proto__: { x: 0, y: 0, w: 1, h: 4, page: 'p2' },
    },
  }, l);
  assert.equal(out.custom, true);
  assert.deepEqual(out.items.deck, { x: 0, y: 0, w: 24, h: 4, page: 'dashboard' });
  assert.deepEqual(out.items.media, { x: 12, y: 3, w: 12, h: 10, page: 'dashboard' });
  assert.ok(out.items.g1 && out.items.clock__2);
  for (const id of ['ghost', 'chat', 'claude', 'notes']) assert.equal(out.items[id], undefined, id);
  assert.equal(Object.getPrototypeOf(out.items), Object.prototype);
  assert.equal(out.items.x, undefined);
});

test('the number of stored rects is bounded', () => {
  const l = layout();
  const items = {};
  for (let i = 0; i < 400; i++) {
    l.widgets['w' + i] = { visible: true, page: 'dashboard', x: 0, y: 0, w: 8, h: 8 };
    items['w' + i] = { x: 0, y: i, w: 24, h: 4, page: 'dashboard' };
  }
  assert.ok(Object.keys(P.normalizePortrait({ custom: true, items }, l).items).length <= 256);
});

test('a normalized custom layout round-trips unchanged', () => {
  const l = layout();
  P.materialize(l, P.planPortrait(l, EDGE));
  const once = P.normalizePortrait(JSON.parse(JSON.stringify(l.portrait)), l);
  assert.deepEqual(P.normalizePortrait(once, l), once);
  assert.deepEqual(once, l.portrait);
});

test('an unmeasurable box falls back to a vertical Edge', () => {
  assert.deepEqual(P.planPortrait(layout(), { width: 0, height: NaN }), P.planPortrait(layout(), P.DEFAULT_BOX));
  assert.deepEqual(P.planPortrait(null, EDGE), {});
});
