// GitHub #158: under the interface scale (CSS zoom on <html>, native-bridge.js)
// a rect and a pointer read in screen px, while layout px (clientHeight, inline
// lengths) are smaller by the zoom. Code that mixed the two zoomed things twice:
// GridStack's resize auto-scroll scrolled with the pointer far from the edge, and
// the top bar's cutouts and clearance came out too big.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// A GridStack Utils stand-in: a scroller 800 layout px tall at the top of the screen.
function utils(original) {
  const scroller = { clientHeight: 800, scrolls: [], scrollBy(o) { this.scrolls.push(o.top); }, getBoundingClientRect: () => ({ top: 0 }) };
  return { scroller, Utils: { updateScrollResize: original, getScrollElement: (el) => (el ? scroller : null) } };
}

// The page as the engine reports it: <html> 1000 layout px wide, its rect `rectZoom` times that.
const page = (rectZoom) => ({ documentElement: { offsetWidth: 1000, getBoundingClientRect: () => ({ width: 1000 * rectZoom }) } });
function withZoom(z, fn) {
  const prev = globalThis.document;
  globalThis.document = page(z);
  try { return fn(); } finally { globalThis.document = prev; }
}

test('at 130% a resize with the pointer mid-screen does not scroll the page', () => {
  const { zoomSafeResizeScroll } = require('../js/dashboard-grid.js');
  const { scroller, Utils } = utils(() => { throw new Error('the zoom-blind rule ran'); });
  zoomSafeResizeScroll(Utils);
  // 800 layout px = 1040 screen px tall; a pointer at 900 screen px is 140 px from the bottom.
  withZoom(1.3, () => Utils.updateScrollResize({ clientY: 900 }, {}, 20));
  assert.deepEqual(scroller.scrolls, []);
});

test('at 130% the pointer at the real bottom edge still scrolls, by layout px', () => {
  const { zoomSafeResizeScroll } = require('../js/dashboard-grid.js');
  const { scroller, Utils } = utils(() => { throw new Error('the zoom-blind rule ran'); });
  zoomSafeResizeScroll(Utils);
  withZoom(1.3, () => Utils.updateScrollResize({ clientY: 1033 }, {}, 20)); // 7 screen px from the bottom
  assert.equal(scroller.scrolls.length, 1);
  assert.ok(Math.abs(scroller.scrolls[0] - 13 / 1.3) < 1e-9);
  withZoom(1.3, () => Utils.updateScrollResize({ clientY: 5 }, {}, 20)); // near the top
  assert.ok(Math.abs(scroller.scrolls[1] - (5 - 20) / 1.3) < 1e-9);
});

test('rects already in layout px (factor 1) keep the GridStack rule', () => {
  const { zoomSafeResizeScroll } = require('../js/dashboard-grid.js');
  const calls = [];
  const { Utils } = utils((e) => calls.push(e.clientY));
  zoomSafeResizeScroll(Utils);
  withZoom(1, () => Utils.updateScrollResize({ clientY: 700 }, {}, 20));
  assert.deepEqual(calls, [700]);
});

test('at 100% GridStack keeps its own rule, and the wrap is applied once', () => {
  const { zoomSafeResizeScroll } = require('../js/dashboard-grid.js');
  const calls = [];
  const { Utils } = utils((e, el, d) => calls.push([e.clientY, d]));
  zoomSafeResizeScroll(Utils);
  const wrapped = Utils.updateScrollResize;
  zoomSafeResizeScroll(Utils);
  assert.equal(Utils.updateScrollResize, wrapped);
  withZoom(1, () => Utils.updateScrollResize({ clientY: 900 }, {}, 20));
  assert.deepEqual(calls, [[900, 20]]);
});

// The top bar's rect helper, run as the page runs it.
function layoutRectAt(rectZoom) {
  const src = read('../js/topbar-minimal.js');
  const start = src.indexOf('  const layoutRect = (r) => {');
  assert.ok(start >= 0, 'layoutRect not found in topbar-minimal.js');
  const body = src.slice(start, src.indexOf('\n  };\n', start) + 5);
  const ctx = vm.createContext({ document: page(rectZoom), window: { __pageZoom: 1.3 } });
  const helper = src.slice(src.indexOf('  const screenPerLayoutPx = () => {'), start);
  vm.runInContext(helper + body.replace('const layoutRect', 'globalThis.layoutRect'), ctx);
  return ctx.layoutRect;
}

test('the top bar turns screen rects into layout px under the interface scale', () => {
  const rect = { left: 130, right: 650, top: 26, bottom: 78, width: 520, height: 52 };
  assert.deepEqual({ ...layoutRectAt(1.3)(rect) }, { left: 100, right: 500, top: 20, bottom: 60, width: 400, height: 40 });
  assert.deepEqual({ ...layoutRectAt(1)(rect) }, rect); // browser, phone, macOS shell: no change
  // An engine that already gives rects in layout px (WebKit adjusts them for zoom) measures 1.
  assert.deepEqual({ ...layoutRectAt(1)(rect) }, rect);
});

test('every rect the cutouts are built from goes through layoutRect', () => {
  const src = read('../js/topbar-minimal.js');
  const reflow = src.slice(src.indexOf('  function reflowIsland() {'), src.indexOf('  function reflowIsland() {') + 4000);
  const raw = reflow.split('\n').filter((l) => /getBoundingClientRect\(\)/.test(l) && !/layoutRect\(/.test(l));
  assert.deepEqual(raw, []);
  assert.match(src, /boxOf\(layoutRect\(ui\.pill\.getBoundingClientRect\(\)\)/);
  assert.match(src, /under: layoutRect\(body\.getBoundingClientRect\(\)\)\.top/);
});
