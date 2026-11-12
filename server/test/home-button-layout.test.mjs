// GitHub #152, second half. Swiped to the desktop, the native window becomes a
// round button about 84 px wide (native-bridge.js marks the body
// `xenon-home-mode`). That size read as a phone: the tiles were stacked in one
// column under the button, then put back on the way out, and the row heights
// were fitted to a box a few pixels tall. Back on the dashboard every tile
// jumped three times before settling (measured: 72 → 85 → 87 px rows). While
// collapsed, neither decision runs; the resize of the return makes them once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const pv = require('../js/phone-view.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

function classList(initial = []) {
  const set = new Set(initial);
  return {
    contains: (c) => set.has(c),
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, on) => { const want = on === undefined ? !set.has(c) : !!on; if (want) set.add(c); else set.delete(c); return want; },
    list: () => [...set],
  };
}

// A page with the round button's size and the body class native-bridge sets.
function collapsedPage() {
  const html = classList();
  const body = classList(['xenon-home-mode']);
  const win = { innerWidth: 84, innerHeight: 84, addEventListener() {}, dispatchEvent() {} };
  const ctx = {
    window: win,
    document: {
      readyState: 'complete',
      documentElement: { classList: html },
      body: { classList: body },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    MutationObserver: class { observe() {} disconnect() {} },
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    setTimeout: () => 0, clearTimeout() {},
    console,
  };
  return { ctx, html, body, win };
}

test('the round button is phone-sized, which is why it must not be measured (#152)', () => {
  assert.notEqual(pv.stackMode({ width: 84, height: 84, preference: 'auto' }), 'off');
});

test('the phone view leaves the dashboard as it was while collapsed to the button (#152)', () => {
  const { ctx, html } = collapsedPage();
  vm.createContext(ctx);
  vm.runInContext(read('../js/phone-view.js'), ctx);
  ctx.window.PhoneView.sync();
  assert.deepEqual(html.list().filter((c) => /^is-/.test(c)), [], 'no stacked or phone class at 84 px');
  assert.equal(ctx.window.PhoneView.isActive(), false);
});

test('the grid does not fit its rows to the button (#152)', () => {
  const { ctx } = collapsedPage();
  const cellHeights = [];
  const box = { clientHeight: 0, clientWidth: 60 };
  const grid = { el: { parentElement: box, style: {}, closest: () => null }, on() {}, setStatic() {}, getRow: () => 8, cellHeight(v) { cellHeights.push(v); } };
  Object.assign(ctx, { GridStack: { init: () => grid }, ResizeObserver: class { observe() {} unobserve() {} } });
  vm.createContext(ctx);
  vm.runInContext(read('../js/dashboard-grid.js'), ctx);
  ctx.window.DashboardGrid.mountPageGrid('main', grid.el);
  box.clientHeight = 40;
  ctx.window.DashboardGrid.fitGridHeights();
  assert.deepEqual(cellHeights, [], 'no row height taken from a 40 px box');

  ctx.document.body.classList.remove('xenon-home-mode');
  box.clientHeight = 696;
  ctx.window.DashboardGrid.fitGridHeights();
  assert.deepEqual(cellHeights, [87], 'back on the screen, one fit to the real box');
});
