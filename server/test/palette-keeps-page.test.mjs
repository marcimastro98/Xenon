import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Opening Add widget on the last page sent the dashboard back to page 1: the panel's
// fresh list reloaded every widget, and one that focuses itself on load (a password
// field) made the browser scroll the pager to its page.

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), 'utf8');
const BRIDGE = read('../js/custom-widget.js');
const PALETTE = read('../js/dashboard-palette.js');

function slice(src, from, to) {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `missing: ${from}`);
  const end = src.indexOf(to, start);
  assert.ok(end > start, `missing end: ${to}`);
  return src.slice(start, end + to.length);
}

function packagesRig() {
  const code = [
    'let pkgCache = null; let pkgFetchPromise = null; let assetVersion = 1;',
    'const leftPage = new Set(); const blockedByPkg = new Map(); const errorsByPkg = new Map();',
    'function hostLimits() { return null; } function paint() {} function syncServiceFrames() {}',
    'async function api() { return { ok: true, packages: [{ id: "a" }] }; }',
    slice(BRIDGE, '  function bumpAssets() {', '\n  }\n'),
    slice(BRIDGE, '  async function fetchPackages(force, listOnly) {', '\n  }\n'),
    slice(BRIDGE, '  async function getPackages(force, opts) {', '\n  }\n'),
    '({ getPackages, version: () => assetVersion });',
  ].join('\n');
  return vm.runInNewContext(code, { window: { dispatchEvent() {} }, CustomEvent: class {} });
}

test('a list-only refresh reads the list again and leaves the widgets on screen alone', async () => {
  const r = packagesRig();
  await r.getPackages(false);
  const before = r.version();
  const got = await r.getPackages(true, { listOnly: true });
  assert.equal(got.packages[0].id, 'a');
  assert.equal(r.version(), before);
});

test('a real rescan still reloads every widget: its files may have changed', async () => {
  const r = packagesRig();
  await r.getPackages(false);
  const before = r.version();
  await r.getPackages(true);
  assert.equal(r.version(), before + 1);
});

test('the Add widget panel asks for the list only', () => {
  assert.match(PALETTE, /C\.getPackages\(true, \{ listOnly: true \}\)/);
});

function guardRig({ onPage }) {
  const listeners = {};
  const calls = { blur: 0, goTo: [] };
  const frame = { classList: { contains: (c) => c === 'cw-frame' }, blur() { calls.blur++; } };
  const window = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    DashboardPager: {
      isOnCurrentPage: () => onPage,
      getCurrentPage: () => 'page-last',
      goToPage: (id) => calls.goTo.push(id),
    },
  };
  const timers = [];
  const code = slice(BRIDGE, "  window.addEventListener('blur', () => {", '\n  });\n');
  vm.runInNewContext(code, { window, document: { activeElement: frame }, setTimeout: (fn) => timers.push(fn) });
  listeners.blur();
  timers.forEach((fn) => fn());
  return calls;
}

test('a widget on a page nobody is looking at cannot take the focus and move the pager', () => {
  const calls = guardRig({ onPage: false });
  assert.equal(calls.blur, 1);
  assert.deepEqual(calls.goTo, ['page-last']);
});

test('a widget on the page in view keeps the focus the person gave it', () => {
  const calls = guardRig({ onPage: true });
  assert.equal(calls.blur, 0);
  assert.deepEqual(calls.goTo, []);
});
