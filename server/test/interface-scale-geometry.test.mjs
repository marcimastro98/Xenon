// GitHub #158: under the interface scale (CSS zoom on <html>, native-bridge.js)
// a rect and a pointer read in screen px, while layout px (clientHeight, inline
// lengths) are smaller by the zoom. Code that mixed the two zoomed things twice:
// GridStack's resize auto-scroll scrolled with the pointer far from the edge, and
// the top bar's cutouts and clearance came out too big.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { readFileSync } = await import('./browser-source.mjs');

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// The page as the engine reports it: <html> 1000 layout px wide, its rect `rectZoom` times that.
const page = (rectZoom) => ({ documentElement: { offsetWidth: 1000, getBoundingClientRect: () => ({ width: 1000 * rectZoom }) } });

// js/grid/page-zoom.js wraps GridStack.Utils as it loads; in the app shell it stops right after.
function wrappedUtils(original) {
  const scroller = { clientHeight: 800, scrolls: [], scrollBy(o) { this.scrolls.push(o.top); }, getBoundingClientRect: () => ({ top: 0 }) };
  const Utils = { updateScrollResize: original, getScrollElement: (el) => (el ? scroller : null) };
  const ctx = vm.createContext({ document: page(1), window: { __XENON_NATIVE__: true, GridStack: { Utils } } });
  vm.runInContext(read('../js/grid/page-zoom.js'), ctx);
  return { scroller, Utils, zoom: (z) => { ctx.document = page(z); } };
}

test('at 130% a resize with the pointer mid-screen does not scroll the page', () => {
  const { scroller, Utils, zoom } = wrappedUtils(() => { throw new Error('the zoom-blind rule ran'); });
  zoom(1.3);
  // 800 layout px = 1040 screen px tall; a pointer at 900 screen px is 140 px from the bottom.
  Utils.updateScrollResize({ clientY: 900 }, {}, 20);
  assert.deepEqual(scroller.scrolls, []);
});

test('at 130% the pointer at the real bottom edge still scrolls, by layout px', () => {
  const { scroller, Utils, zoom } = wrappedUtils(() => { throw new Error('the zoom-blind rule ran'); });
  zoom(1.3);
  Utils.updateScrollResize({ clientY: 1033 }, {}, 20); // 7 screen px from the bottom
  assert.equal(scroller.scrolls.length, 1);
  assert.ok(Math.abs(scroller.scrolls[0] - 13 / 1.3) < 1e-9);
  Utils.updateScrollResize({ clientY: 5 }, {}, 20); // near the top
  assert.ok(Math.abs(scroller.scrolls[1] - (5 - 20) / 1.3) < 1e-9);
});

test('at 100%, or with rects already in layout px, GridStack keeps its own rule', () => {
  const calls = [];
  const { Utils } = wrappedUtils((e, el, d) => calls.push([e.clientY, d]));
  Utils.updateScrollResize({ clientY: 900 }, {}, 20);
  assert.deepEqual(calls, [[900, 20]]);
});

// notch-motion.js, run as the page runs it.
function layoutRectAt(rectZoom) {
  const ctx = vm.createContext({ document: page(rectZoom), window: { __pageZoom: 1.3 } });
  vm.runInContext(read('../js/topbar/topbar-minimal/notch-motion.js'), ctx);
  return ctx.window.TopbarMinimalNotchMotion.layoutRect;
}

test('the top bar turns screen rects into layout px under the interface scale', () => {
  const rect = { left: 130, right: 650, top: 26, bottom: 78, width: 520, height: 52 };
  assert.deepEqual({ ...layoutRectAt(1.3)(rect) }, { left: 100, right: 500, top: 20, bottom: 60, width: 400, height: 40 });
  // Browser, phone, macOS shell, or an engine that already gives rects in layout px: no change.
  assert.deepEqual({ ...layoutRectAt(1)(rect) }, rect);
});

test('every rect the cutouts are built from goes through layoutRect', () => {
  const src = read('../js/topbar/topbar-minimal.js');
  const at = src.indexOf('  function reflowIsland() {');
  const raw = src.slice(at, at + 4000).split('\n').filter((l) => /getBoundingClientRect\(\)/.test(l) && !/layoutRect\(/.test(l));
  assert.deepEqual(raw, []);
  assert.match(src, /boxOf\(layoutRect\(ui\.pill\.getBoundingClientRect\(\)\)/);
  assert.match(src, /under: layoutRect\(body\.getBoundingClientRect\(\)\)\.top/);
  assert.match(src, /const \{ motionOk, SOFT_PROPS, boxOf, layoutRect \} = window\.TopbarMinimalNotchMotion;/);
});
