// How many things from the Store have an update, told outside the Store: the
// Xenon menu (menu-store.js -> menu-now.js storeTile -> xenon-menu.js) and the
// phone's settings button (phone-view.js mirrorCount).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const MenuStore = require('../menu-store.js');
const Menu = require('../xenon-menu.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const CATALOG = { ok: true, entries: [{ id: 'orbit-clock', pkgId: 'orbit-clock', kind: 'widget', name: 'Orbit Clock', version: '1.1.0', shots: 1 }] };
const PACKAGES = [{ id: 'orbit-clock', version: '1.0.2', catalogVersion: '1.0.2' }, { id: 'desk-notes', version: '0.3.0' }];

test('the menu counts the Store\'s updates with the Store\'s own join', async () => {
  const out = await MenuStore.read({ catalog: async () => CATALOG, packages: async () => PACKAGES, installs: [] });
  assert.equal(out.updates, 1);
  assert.ok(out.shots['orbit-clock'], 'the picture of the installed widget');
  const none = await MenuStore.read({ catalog: async () => CATALOG, packages: async () => [{ id: 'orbit-clock', version: '1.1.0', catalogVersion: '1.1.0' }], installs: [] });
  assert.equal(none.updates, 0);
});

test('a catalog that is slow, failing or wrong gives no number, never a guess', async () => {
  const slow = () => new Promise((done) => setTimeout(done, MenuStore.MENU_CATALOG_WAIT_MS + 300, CATALOG));
  assert.deepEqual(await MenuStore.read({ catalog: slow, packages: async () => PACKAGES, installs: [] }), { shots: {}, updates: null });
  const fail = async () => { throw new Error('offline'); };
  assert.deepEqual(await MenuStore.read({ catalog: fail, packages: async () => PACKAGES, installs: [] }), { shots: {}, updates: null });
  assert.deepEqual(await MenuStore.read({ catalog: async () => ({ ok: false }), packages: async () => PACKAGES, installs: [] }), { shots: {}, updates: null });
});

test('a package list that fails still counts what the receipts know', async () => {
  const catalog = async () => ({ ok: true, entries: [{ id: 'nocturne', kind: 'theme', name: 'Nocturne', version: '1.2.0' }] });
  const installs = [{ source: 'catalog', sourceId: 'nocturne', sourceVersion: '1.0.0', kind: 'theme' }];
  const out = await MenuStore.read({ catalog, packages: async () => { throw new Error('scan'); }, installs });
  assert.equal(out.updates, 1);
});

const tiles = (out) => {
  const found = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') { if (n.kind === 'tile' && n.id === 'store') found.push(n); Object.values(n).forEach(walk); }
  };
  walk(out);
  return found;
};
const BASE = { probes: { layers: true }, layers: { enabled: true, widgets: [] }, keys: {}, keyStates: {}, deck: [], tiles: [], packages: [], now: 0 };

test('the Store tile says how many updates wait and opens Installed', () => {
  const two = tiles(Menu.compose({ ...BASE, storeUpdates: 2 }));
  assert.ok(two.length, 'the Store tile is in the menu');
  for (const tile of two) {
    assert.equal(tile.updates, 2);
    assert.deepEqual(tile.sub, { key: 'installed_update_n', vars: { n: 2 } });
    assert.match(JSON.stringify(tile.act), /store:__installed/);
  }
  for (const tile of tiles(Menu.compose({ ...BASE, storeUpdates: 1 }))) assert.deepEqual(tile.sub, { key: 'installed_update_one' });
  for (const n of [0, null, undefined, -1, 1.5]) {
    for (const tile of tiles(Menu.compose({ ...BASE, storeUpdates: n }))) {
      assert.equal(tile.updates, undefined, String(n));
      assert.deepEqual(tile.sub, { key: 'xmenu_sub_store' }, String(n));
      assert.doesNotMatch(JSON.stringify(tile.act), /__installed/, String(n));
    }
  }
});

test('the menu shows the count by the Store link and reads it out with the words', () => {
  const src = read('../js/xenon-menu.js');
  const fn = src.slice(src.indexOf('function drawFootLink'), src.indexOf('async function refreshBalance'));
  assert.match(fn, /if \(r\.id === 'store' && r\.updates > 0\) \{\n\s+b\.appendChild\(el\('span', 'xm-nav-value is-update', String\(r\.updates\)\)\);\n\s+b\.setAttribute\('aria-label', text\(r\.label, tt\) \+ ', ' \+ text\(r\.sub, tt\)\);/);
  assert.match(read('../server.js'), /storeUpdates: store\.updates,/);
});

// phone-view.js mirrorCount, lifted verbatim, on a small DOM.
function phone() {
  const src = read('../js/phone-view.js');
  const body = src.slice(src.indexOf('  function mirrorCount'), src.indexOf('  function pageDots'));
  const observers = [];
  const node = (cls = '') => ({
    className: cls, textContent: '', hidden: false, children: [], attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
    querySelector(sel) { return this.children.find((c) => c.className.split(' ').includes(sel.slice(1))) || null; },
  });
  const real = node('qbtn-settings');
  const ctx = {
    document: { querySelector: (sel) => (sel === '.qbtn-settings' ? real : null), createElement: () => node() },
    MutationObserver: class { constructor(fn) { this.fn = fn; observers.push(this); } observe(_target, opts) { this.opts = opts; } },
    dotWatchers: [],
  };
  vm.runInNewContext(`${body}\nthis.mirrorCount = mirrorCount;`, ctx);
  const btn = node('ph-btn');
  ctx.mirrorCount(btn, '.qbtn-settings', 'cgal-store-dot');
  const change = () => observers.forEach((o) => o.fn());
  return { real, copy: btn.children[0], change, node, watchers: ctx.dotWatchers, observers };
}

test('the phone\'s settings button shows the same count the gear gets, and drops it with it', () => {
  const p = phone();
  assert.equal(p.copy.hidden, true, 'nothing to show yet');
  assert.equal(p.copy.attrs['aria-hidden'], 'true');
  const dot = p.real.appendChild(p.node('cgal-store-dot is-update'));
  dot.textContent = '3';
  p.change();
  assert.equal(p.copy.hidden, false);
  assert.equal(p.copy.textContent, '3');
  assert.equal(p.copy.className, 'cgal-store-dot is-update ph-count', 'same look as the gear');
  p.real.children.length = 0;
  p.change();
  assert.equal(p.copy.hidden, true);
  assert.equal(p.copy.textContent, '');
  assert.equal(p.watchers.length, 1, 'stopped with the other watchers');
  assert.equal(p.observers[0].opts.subtree, true);
});

test('the settings button is the one that mirrors the Store\'s count', () => {
  const src = read('../js/phone-view.js');
  assert.match(src, /\{ sel: '\.qbtn-settings', glyph: '⚙', key: 'ph_settings', dot: 'settings-update-dot', count: 'cgal-store-dot' \}/);
  assert.match(src, /if \(spec\.count\) mirrorCount\(b, spec\.sel, spec\.count\);/);
});
