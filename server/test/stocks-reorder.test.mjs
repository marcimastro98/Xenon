// Reordering the Borsa watchlist by dragging a row.
//
// Asked on Discord: "is there a way to re-order the list of stocks? besides
// deleting and re-adding". There was not. The tile draws the watchlist in the
// order it is stored, `add` appends, and nothing ever moved an entry — so the
// only way to put a symbol first was to remove everything above it and add it
// all back. The ticker reads the same list, so it was stuck in that order too.
//
// The drag itself lives in the browser and is exercised there; what these tests
// hold is everything the drag depends on and that can rot silently: the server
// route it posts to, the order-preserving normalizer behind that route, and the
// handful of decisions in the widget that are invisible until a real finger is
// on a real screen (no handle on a one-row list, no repaint mid-drag, no detail
// view opening on the drop).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const stocks = require(join(here, '..', 'stocks.js'));
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const WIDGET = read('../js/stock-widget.js');
const SERVER = read('../server.js');
const CSS = read('../components/StockWidget/StockWidget.css');
const I18N = read('../js/i18n.js');
const CHANGELOG = read('../../CHANGELOG.md');
const FEATURES = read('../../FEATURES.md');

// ── what the reorder actually saves ────────────────────────────────────────
test('normalizeWatchlist keeps the submitted order', () => {
  // The whole feature is this: the list comes back in the order it was sent.
  const moved = [
    { symbol: 'NVDA', name: 'NVIDIA' },
    { symbol: 'AAPL', name: 'Apple' },
    { symbol: '^GSPC', name: 'S&P 500' },
  ];
  assert.deepEqual(stocks.normalizeWatchlist(moved).map(w => w.symbol), ['NVDA', 'AAPL', '^GSPC']);
  // …and reversing it is a different list, not the same one sorted back.
  assert.deepEqual(stocks.normalizeWatchlist(moved.slice().reverse()).map(w => w.symbol),
    ['^GSPC', 'AAPL', 'NVDA']);
});

test('a reordered list keeps every name', () => {
  // The rows carry only symbols, so saveOrder reorders the stored entries
  // rather than rebuilding them; the names have to survive the round trip or
  // every row would fall back to its ticker.
  const out = stocks.normalizeWatchlist([
    { symbol: 'BTC-EUR', name: 'Bitcoin' },
    { symbol: 'FTSEMIB.MI', name: 'FTSE MIB' },
  ]);
  assert.deepEqual(out, [
    { symbol: 'BTC-EUR', name: 'Bitcoin' },
    { symbol: 'FTSEMIB.MI', name: 'FTSE MIB' },
  ]);
});

test('a reorder cannot smuggle in a bad symbol or a duplicate', () => {
  const out = stocks.normalizeWatchlist([
    { symbol: 'AAPL', name: 'Apple' },
    { symbol: '<script>', name: 'nope' },
    { symbol: 'aapl', name: 'Apple again' },
    { symbol: 'ENI.MI', name: 'x'.repeat(200) },
  ]);
  assert.deepEqual(out.map(w => w.symbol), ['AAPL', 'ENI.MI']);
  assert.equal(out[1].name.length, 60);
});

// ── the route the drag posts to ────────────────────────────────────────────
test("the 'set' route normalizes instead of storing what it was handed", () => {
  const route = SERVER.slice(SERVER.indexOf("reqPath === '/api/stocks/watchlist'"));
  const branch = route.slice(0, route.indexOf("} else if (action === 'remove')"));
  assert.match(branch, /action === 'set' && Array\.isArray\(body\.watchlist\)/);
  assert.match(branch, /stocks\.normalizeWatchlist\(body\.watchlist\)/,
    "'set' is user-facing now — it cannot store the posted array as it arrives");
  // An empty result is a rejected payload, not an instruction to wipe the list.
  assert.match(branch, /if \(!wl\.length\) \{ res\.writeHead\(400\)/);
  assert.doesNotMatch(branch, /wl = body\.watchlist;/);
});

test('the widget posts the whole list under the set action', () => {
  assert.match(WIDGET, /postWatchlist\('set', '', '', next\)/);
  assert.match(WIDGET, /action === 'set'\s*\?\s*\{ action, watchlist:/);
});

// ── the decisions a screenshot cannot check ────────────────────────────────
test('a one-row list gets no handle', () => {
  assert.match(WIDGET, /function reorderable\(\) \{ return displayRows\(\)\.length > 1; \}/);
  assert.match(WIDGET, /function gripEl\(\) \{\s*\n\s*if \(!reorderable\(\)\) return null;/);
  assert.match(WIDGET, /if \(reorderable\(\)\) initListDrag\(list\);/);
});

test('a dead row can be moved like any other', () => {
  // A symbol the provider cannot quote still occupies a place in the list; if
  // it could not move, everything under it would be pinned to the bottom.
  const dead = WIDGET.slice(WIDGET.indexOf('function unresolvedRow'));
  assert.match(dead.slice(0, dead.indexOf('function reorderable')), /gripEl\(\)/);
});

test('an SSE quote update cannot delete the row under the finger', () => {
  const paint = WIDGET.slice(WIDGET.indexOf('function paint()'));
  assert.match(paint.slice(0, 400), /if \(dragging\) \{ repaintPending = true; return; \}/);
  // …and the held-back repaint is not lost: both ends of a drag run it.
  assert.match(WIDGET, /if \(repaintPending\) \{ repaintPending = false; paint\(\); \}/);
});

test('the drop does not open the dropped symbol, and does not eat the next tap', () => {
  // The grip sits inside the row button, so the pointerup that ends a drag
  // would click the row. The guard is armed by a drag that moved…
  assert.match(WIDGET, /swallowClick = true;/);
  assert.match(WIDGET, /list\.addEventListener\('click', \(e\) => \{[\s\S]*?\}, true\);/);
  // …and disarmed by the next pointerdown, because with pointer capture held by
  // the grip that click never arrives and a standing guard would swallow the
  // user's next real tap instead.
  const down = WIDGET.slice(WIDGET.indexOf("list.addEventListener('pointerdown'"));
  assert.match(down.slice(0, 300), /swallowClick = false;/);
});

test('a row swaps after half a row of travel, not a whole one', () => {
  // Comparing the two rows' midpoints (the obvious version) only swaps once the
  // dragged row has passed the neighbour completely, which reads as a list that
  // is not listening. Measured pitch on the tile: ~65px, so this is the
  // difference between a 32px drag and a 65px one.
  assert.match(WIDGET, /dy < -p \/ 2/);
  assert.match(WIDGET, /dy > p \/ 2/);
  // The slot is derived, never remembered, so a scroll mid-drag cannot strand it.
  assert.match(WIDGET, /const slotTop = d\.row\.getBoundingClientRect\(\)\.top - dy;/);
});

test('a second finger cannot hijack a drag in progress', () => {
  assert.match(WIDGET, /e\.pointerId !== d\.pointerId/);
  assert.match(WIDGET, /if \(dragging \|\| e\.button > 0\) return;/);
});

test('a refused save puts the list back', () => {
  const save = WIDGET.slice(WIDGET.indexOf('async function saveOrder'));
  const body = save.slice(0, save.indexOf('function removeBtn'));
  assert.match(body, /const before = watchlist;/);
  assert.match(body, /watchlist = before;/);
  assert.match(body, /XenonToast/);
});

// ── the handle has to be visible without a hover ───────────────────────────
test('the grip is visible on a touchscreen and owns its pointer stream', () => {
  const grip = CSS.slice(CSS.indexOf('.sw-row-grip {'));
  const block = grip.slice(0, grip.indexOf('}') + 1);
  assert.match(block, /opacity: 0\.(?!0)/, 'the grip must not start invisible — the Edge has no hover');
  assert.match(block, /touch-action: none/, 'without this the scroller eats the drag on a touchscreen');
});

test('the lifted row is opaque', () => {
  // A translucent row shows the row it is passing over straight through itself.
  const drag = CSS.slice(CSS.indexOf('.sw-row.is-dragging {'));
  assert.match(drag.slice(0, drag.indexOf('}') + 1), /background-color: var\(--panel/);
});

test('the handle is named in every locale that carries the stocks strings', () => {
  // es/fr/de/pt/ru inherit the whole stocks family from en, so the key belongs
  // exactly where its siblings are.
  const withRemove = (I18N.match(/["']?stocks_remove["']?\s*:/g) || []).length;
  const withReorder = (I18N.match(/["']?stocks_reorder["']?\s*:/g) || []).length;
  assert.equal(withReorder, withRemove);
  assert.ok(withRemove >= 6);
});

test('it is written down', () => {
  // The whole file, not the [Unreleased] section: entries move into a version
  // section when a release is cut, and pinning the section turned this into a
  // test that broke on the release rather than on the thing it is guarding.
  // (It had already rotted silently — the headings gained a `v` and a date, so
  // the old slice matched nothing and read the entire file.)
  assert.match(CHANGELOG, /re-order the list of stocks/);
  assert.match(FEATURES, /drag(ging)? (a|the) (row|stock)/i);
});
