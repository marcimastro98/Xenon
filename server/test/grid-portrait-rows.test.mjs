// How a page is divided into rows, and what that does to resizing.
//
// The grid has 24 COLUMNS on every screen, but its rows are not a resolution:
// the count comes from whatever the layout happens to span, and the row height
// is stretched so those rows fill the page. On a landscape screen that is right.
// On a display mounted vertically it is not, because the layout is shared with
// every other surface — so a tall screen stretches the same handful of rows over
// three times the height.
//
// Two things were reported, and both are that one fact: the vertical resize has
// as many stops as the layout has rows (against 24 across, so it reads as "it
// only resizes sideways"), and MIN_TILE_H — a floor expressed in ROWS — becomes
// about half the screen, so a tile cannot be made smaller than that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const grid = require('../js/dashboard-grid.js');
const { fitPageRows, MIN_TILE_H, MIN_FILL_ROWS, MAX_PORTRAIT_CELL, GRID_COLUMNS } = grid;

// A rotated 1440x2560 monitor, which is what the report came from: wide enough
// to keep the grid (PhoneView leaves anything over 1120 alone), tall enough for
// the stretch to be extreme. Page box ≈ the panel minus the topbar and pager.
const ROTATED = { avail: 2400, width: 1440, rows: 8, tiles: 5 };

// ── The reported symptom ─────────────────────────────────────────────────────

test('a tile on a vertical screen can be made far smaller than half the screen', () => {
  // 8 rows over 2400px is a 300px row, and MIN_TILE_H is 4 of them: 1200px, or
  // half the screen to the pixel. That is the report, arrived at from the code.
  const before = Math.floor(ROTATED.avail / ROTATED.rows) * MIN_TILE_H;
  assert.equal(before, ROTATED.avail / 2, 'the old floor really was half the screen');

  const floor = fitPageRows(ROTATED).cellHeight * MIN_TILE_H;
  assert.ok(floor < ROTATED.avail / 5, `smallest tile is ${floor}px of ${ROTATED.avail}px`);
});

// 24 stops across against 8 down is what "it gives priority to horizontal" means.
// They do not have to match, but they have to be the same order of magnitude or
// one axis feels broken.
test('the two axes get comparable resolution', () => {
  const { rows } = fitPageRows(ROTATED);
  assert.ok(rows >= GRID_COLUMNS / 2, `${rows} vertical stops against ${GRID_COLUMNS} horizontal`);
  assert.ok(rows > ROTATED.rows * 2, 'the extra height buys rows, not taller rows');
});

test('no row on a vertical screen is taller than the cap', () => {
  for (const box of [
    { avail: 2400, width: 1440, rows: 8, tiles: 5 },    // rotated 1440x2560
    { avail: 1800, width: 1080, rows: 8, tiles: 5 },    // rotated 1080x1920
    { avail: 2400, width: 700, rows: 4, tiles: 2 },     // a vertical Edge kept on the grid
    { avail: 1300, width: 1200, rows: 6, tiles: 3 },    // barely taller than wide
  ]) {
    const { cellHeight, portrait } = fitPageRows(box);
    assert.equal(portrait, true, JSON.stringify(box));
    assert.ok(cellHeight <= MAX_PORTRAIT_CELL, `${cellHeight}px row for ${JSON.stringify(box)}`);
  }
});

// ── Landscape must not move ──────────────────────────────────────────────────

// The cap exists for a layout stretched over a shape it was not built for. A
// landscape screen does not have that problem: its rows are big because the
// whole screen is big, and the tiles are proportionally what they are at 1080p.
// Touching those would be a visible change nobody asked for — and the Edge, the
// panel the dashboard is designed around, is the one that must not move at all.
test('every landscape screen fills the page exactly, as before', () => {
  for (const box of [
    { avail: 630, width: 2560, rows: 8, tiles: 5 },     // Xeneon Edge
    { avail: 900, width: 1920, rows: 16, tiles: 6 },    // 1080p
    { avail: 2000, width: 3840, rows: 16, tiles: 6 },   // 4K — a big row, but a big screen
    { avail: 700, width: 1280, rows: 12, tiles: 4 },    // a windowed browser
  ]) {
    const fit = fitPageRows(box);
    assert.equal(fit.portrait, false, JSON.stringify(box));
    assert.equal(fit.rows, box.rows, 'row count untouched');
    assert.equal(fit.cellHeight, Math.max(18, Math.floor(box.avail / box.rows)), 'height untouched');
  }
});

// The Edge lands around 75px a row, so the cap could not bite there even if the
// orientation test were somehow wrong. Pinned because it is what makes the
// change safe on the one device Xenon is built around.
test('the cap sits above anything a landscape dashboard produces', () => {
  const edge = fitPageRows({ avail: 630, width: 2560, rows: 8, tiles: 5 });
  assert.ok(edge.cellHeight < MAX_PORTRAIT_CELL, `Edge row is ${edge.cellHeight}px`);
});

// ── The rules compose ────────────────────────────────────────────────────────

test('a portrait layout already taller than the cap keeps filling exactly', () => {
  const box = { avail: 2400, width: 1440, rows: 40, tiles: 9 };
  const fit = fitPageRows(box);
  assert.equal(fit.rows, 40, 'a layout that already spans enough rows is not padded');
  assert.equal(fit.cellHeight, 60);
});

test('the lone-tile floor still applies, and the portrait cap wins when stricter', () => {
  // Landscape, one tile: unchanged behaviour — MIN_FILL_ROWS is the floor.
  const flat = fitPageRows({ avail: 900, width: 1920, rows: 2, tiles: 1 });
  assert.equal(flat.rows, MIN_FILL_ROWS);
  // Portrait, one tile: MIN_FILL_ROWS would still give a 300px row, so the cap
  // is what decides. Both rules point the same way — more rows, shorter.
  const tall = fitPageRows({ avail: 2400, width: 1440, rows: 2, tiles: 1 });
  assert.ok(tall.rows > MIN_FILL_ROWS);
  assert.ok(tall.cellHeight <= MAX_PORTRAIT_CELL);
});

// Asking for more rows can only shorten the row, which is what guarantees the
// grid still fits the page — the dashboard is a fixed-height viewport and a
// row height that overflowed would force a scrollbar onto it.
test('the fitted grid never exceeds the page it must fit in', () => {
  for (const box of [
    ROTATED,
    { avail: 2400, width: 1440, rows: 40, tiles: 9 },
    { avail: 630, width: 2560, rows: 8, tiles: 5 },
    { avail: 900, width: 1920, rows: 2, tiles: 1 },
  ]) {
    const fit = fitPageRows(box);
    assert.ok(fit.rows * fit.cellHeight <= box.avail, JSON.stringify(box));
  }
});

// ── Degenerate input ─────────────────────────────────────────────────────────
// fitGridHeights reads these off the DOM and the saved layout, so a zero, a NaN
// or a missing page must produce a usable grid rather than a division by zero.
test('a missing or nonsense box still yields a usable grid', () => {
  for (const box of [
    {}, { avail: 0, width: 0, rows: 0, tiles: 0 },
    { avail: NaN, width: NaN, rows: NaN, tiles: NaN },
    { avail: 2400, width: 0, rows: 8, tiles: 5 },   // width unknown → never portrait
  ]) {
    const fit = fitPageRows(box);
    assert.ok(Number.isFinite(fit.cellHeight) && fit.cellHeight >= 18, JSON.stringify(box));
    assert.ok(Number.isFinite(fit.rows) && fit.rows >= 1, JSON.stringify(box));
  }
  // A page whose width could not be measured is left on the old path rather than
  // guessed at: portrait is a claim about a real box.
  assert.equal(fitPageRows({ avail: 2400, width: 0, rows: 8, tiles: 5 }).portrait, false);
});
