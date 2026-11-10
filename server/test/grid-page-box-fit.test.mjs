// GitHub #152: after swiping to the desktop and back, every tile stopped short of
// the bottom of the screen until Layout mode was opened and closed.
//
// The row height is fitted to the page box on a window resize, 120 ms later. The
// way back passes through a window 84 px wide, which turns the phone view on; it
// turns off again 150 ms after the resize and takes its chrome with it, and the
// page then eases to its final height. Neither is a window resize, so the fit
// that ran in between was the last one, sized for a box 120 px shorter. The grid
// now watches each page box as well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../js/dashboard-grid.js', import.meta.url), 'utf8');

// Loads the classic script into a page with no window resize at all: only the
// ResizeObserver the grid itself creates can tell it the box changed.
function loadGrid() {
  const observers = [];
  const timers = [];
  const box = { clientHeight: 576, clientWidth: 2532, closest: () => null };
  const gridEl = { parentElement: box, style: {}, closest: () => null };
  const cellHeights = [];
  const grid = {
    el: gridEl,
    on() {}, setStatic() {}, destroy() {},
    getRow: () => 8,
    cellHeight(v) { cellHeights.push(v); },
  };
  const win = { addEventListener() {}, DashboardPortrait: null };
  const ctx = {
    window: win,
    document: { body: { classList: { contains: () => false, toggle() {} } }, querySelectorAll: () => [], getElementById: () => null },
    GridStack: { init: () => grid },
    ResizeObserver: class { constructor(cb) { this.cb = cb; this.seen = new Set(); observers.push(this); } observe(el) { this.seen.add(el); } unobserve(el) { this.seen.delete(el); } },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    requestAnimationFrame: () => 0,
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const flush = () => { while (timers.length) timers.shift()(); };
  return { api: win.DashboardGrid, box, gridEl, cellHeights, observers, flush };
}

test('a page box that changes size with no window resize re-fits its rows (#152)', () => {
  const t = loadGrid();
  t.api.mountPageGrid('main', t.gridEl);
  const ro = t.observers.find((o) => o.seen.has(t.box));
  assert.ok(ro, 'the page box is watched');

  t.api.fitGridHeights();            // the fit made while the phone chrome was still there
  assert.equal(t.cellHeights.at(-1), 72);

  t.box.clientHeight = 696;          // the chrome goes away: the box grows, the window does not
  ro.cb([{ target: t.box }]);
  t.flush();
  assert.equal(t.cellHeights.at(-1), 87, 'the rows fill the box again');
});

test('a page whose grid is pruned stops being watched (#152)', () => {
  const t = loadGrid();
  t.api.mountPageGrid('main', t.gridEl);
  const ro = t.observers.find((o) => o.seen.has(t.box));
  t.api.pruneGrids([]);
  assert.equal(ro.seen.has(t.box), false);
});
