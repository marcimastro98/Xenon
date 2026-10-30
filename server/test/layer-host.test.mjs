// The dashboard as a layer surface (js/layer-host.js): only the tiles placed on
// THIS surface are moved into slots, the page never writes settings, and a
// Store widget gets its package from memory, never from sdkWidgets.assign.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const LayersModel = require('../js/layers-model.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/layer-host.js');

const W = (over = {}) => ({ id: 'lw_aaaa0001', kind: 'tile', widget: 'weather', surface: 'desktop', rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, ...over });

function boot(search, layers, { dashboardWidgets = {}, shell = false, lite = false, tiles, hydrated, store = {}, Observer } = {}) {
  const dom = makeDom();
  const { document } = dom;
  if (lite) document.documentElement.setAttribute('data-layer-lite', '');
  if (tiles !== undefined) document.documentElement.setAttribute('data-layer-tiles', tiles);
  const reloads = { n: 0 };
  const grid = document.createElement('div');
  grid.className = 'pager-page';
  document.body.appendChild(grid);
  const atom = (widget, instance) => {
    const el = document.createElement('div');
    el.setAttribute('data-dashboard-widget', widget);
    if (instance) el.setAttribute('data-dashboard-instance', instance);
    el.dataset.dashboardHidden = 'true';
    grid.appendChild(el);
    return el;
  };
  const assigned = [];
  const signals = [];
  const timers = [];
  const location = { search };
  Object.defineProperty(location, 'href', { set: (v) => signals.push(v), get: () => '' });
  location.reload = () => { reloads.n++; };
  const ctx = {
    window: { location, __XENON_LAYER_SHELL__: shell, devicePixelRatio: 1.5, addEventListener() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    document,
    console: { warn() {} },
    URLSearchParams,
    sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    hubSettings: { layers, dashboardLayout: { widgets: dashboardWidgets } },
    moveNode: (parent, node) => parent.appendChild(node),
    createCopyAtom: (widget, id) => { const el = document.createElement('div'); el.setAttribute('data-dashboard-widget', widget); if (id) el.setAttribute('data-dashboard-instance', id); return el; },
  };
  ctx.window.LayersModel = LayersModel;
  const paints = { n: 0 };
  ctx.window.CustomWidget = { setLayerAssign: (m) => assigned.push(m), renderWidgets() { paints.n++; } };
  if (hydrated !== undefined) ctx._hubHydratedFromServer = hydrated;
  if (Observer) ctx.MutationObserver = Observer;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const flush = () => { while (timers.length) timers.shift()(); };
  return { host: ctx.window.LayerHost, document, atom, grid, ctx, assigned, paints, signals, flush, reloads, store, timers };
}

const slotsOf = (document) => {
  const root = document.getElementById('layer-root');
  return root ? root.children : [];
};

test('a normal dashboard is not a layer and does nothing', () => {
  const { host, document } = boot('', { enabled: true, widgets: [W()] });
  assert.equal(host.active, false);
  host.place();
  assert.equal(document.documentElement.dataset.layer, undefined);
  assert.equal(document.getElementById('layer-root'), null);
});

test('a malformed layer key is refused, not guessed', () => {
  for (const bad of ['?layer=desk:', '?layer=anchor:../x', '?layer=overlay:' + 'x'.repeat(65), '?layer=desktop:\u0001']) {
    assert.equal(boot(bad, { enabled: true, widgets: [W()] }).host.active, false, bad);
  }
});

test('only the tiles placed on this surface move into slots, at their rectangle', () => {
  const layers = { enabled: true, widgets: [
    W(), W({ id: 'lw_aaaa0002', widget: 'media', monitor: 'DISPLAY2' }), W({ id: 'lw_aaaa0003', widget: 'clock', surface: 'overlay' }),
  ] };
  const { host, document, atom, grid } = boot('?layer=desktop:', layers);
  assert.equal(host.active, true);
  assert.equal(document.documentElement.dataset.layer, 'desktop');
  const weather = atom('weather');
  const media = atom('media');
  const clock = atom('clock');
  host.place();
  const slots = slotsOf(document);
  assert.equal(slots.length, 1);
  assert.equal(weather.parentNode, slots[0]);
  assert.equal(weather.dataset.dashboardHidden, 'false');
  assert.equal(media.parentNode, grid, 'another monitor draws its own');
  assert.equal(clock.parentNode, grid, 'the overlay draws its own');
  const p = slots[0].style._props;
  assert.deepEqual([p['--layer-x'], p['--layer-y'], p['--layer-w'], p['--layer-h'], p['--layer-opacity']], ['10%', '20%', '30%', '40%', '1']);
  assert.equal(slots[0].dataset.show, 'always');
});

test('the primary tile is used, never a duplicated copy of it', () => {
  const { host, document, atom } = boot('?layer=desktop:', { enabled: true, widgets: [W()] });
  const copy = atom('weather', 'weather-2');
  const primary = atom('weather');
  host.place();
  assert.equal(primary.parentNode, slotsOf(document)[0]);
  assert.notEqual(copy.parentNode, slotsOf(document)[0]);
});

test('switched off, nothing is shown', () => {
  const { host, document, atom, grid } = boot('?layer=desktop:', { enabled: false, widgets: [W()] });
  const weather = atom('weather');
  host.place();
  assert.equal(slotsOf(document).length, 0);
  assert.equal(weather.parentNode, grid);
});

test('a removed placement takes its slot away on the next apply', () => {
  const { host, document, atom, ctx } = boot('?layer=desktop:', { enabled: true, widgets: [W(), W({ id: 'lw_aaaa0002', widget: 'media' })] });
  atom('weather'); atom('media');
  host.place();
  assert.equal(slotsOf(document).length, 2);
  ctx.hubSettings.layers = { enabled: true, widgets: [W()] };
  host.place();
  assert.equal(slotsOf(document).length, 1);
  assert.equal(slotsOf(document)[0].dataset.layerId, 'lw_aaaa0001');
});

test('a removed tile is parked in the page, never detached; a removed Store widget is released', () => {
  const sdk = W({ id: 'lw_sdkw0001', kind: 'sdk', pkg: 'wall-plate', widget: undefined });
  const { host, document, atom, ctx, paints } = boot('?layer=desktop:', { enabled: true, widgets: [W(), sdk] });
  const weather = atom('weather');
  host.place();
  assert.equal(paints.n, 1, 'the Store widget arrived: one repaint');
  host.place();
  assert.equal(paints.n, 1, 'nothing changed: no repaint');
  const sdkAtom = slotsOf(document).find(s => s.dataset.layerId === 'lw_sdkw0001').children[0];
  ctx.hubSettings.layers = { enabled: true, widgets: [] };
  host.place();
  assert.equal(weather.isConnected, true, 'still findable by the next layout apply');
  assert.equal(weather.dataset.dashboardHidden, 'true');
  assert.equal(sdkAtom.isConnected, false);
  assert.equal(paints.n, 2, 'the Store widget left: its frame is released');
  ctx.hubSettings.layers = { enabled: true, widgets: [W()] };
  host.place();
  assert.equal(weather.parentNode, slotsOf(document)[0], 'placed again, the same tile comes back');
});

test('an anchored window is the widget: the slot fills it', () => {
  const w = W({ id: 'lw_anch0001', surface: 'anchor', anchor: { app: 'krita.exe' } });
  const { host, document, atom } = boot('?layer=anchor:lw_anch0001', { enabled: true, widgets: [w] });
  atom('weather');
  host.place();
  const p = slotsOf(document)[0].style._props;
  assert.deepEqual([p['--layer-x'], p['--layer-w'], p['--layer-h']], ['0%', '100%', '100%']);
});

test('a Store widget gets its own atom and its package from memory only', () => {
  const sdk = W({ id: 'lw_sdkw0001', kind: 'sdk', pkg: 'wall-plate', widget: undefined });
  const { host, document, assigned, ctx } = boot('?layer=desktop:', { enabled: true, widgets: [sdk] });
  host.place();
  const slot = slotsOf(document)[0];
  assert.equal(slot.children[0].getAttribute('data-dashboard-instance'), 'lw_sdkw0001');
  assert.equal(assigned.at(-1).get('lw_sdkw0001'), 'wall-plate');
  assert.equal(ctx.hubSettings.sdkWidgets, undefined, 'never written into the saved assignment');
  host.place();
  assert.equal(slot.children.length, 1, 'the next apply reuses the same atom');
});

test('placed tiles are forced visible in memory so hub-embedded ones extract', () => {
  const widgets = { weather: { visible: false }, media: { visible: false } };
  const { host } = boot('?layer=desktop:', { enabled: true, widgets: [W()] }, { dashboardWidgets: widgets });
  host.forceVisible();
  assert.equal(widgets.weather.visible, true);
  assert.equal(widgets.media.visible, false, 'a tile not placed here keeps its state');
});

test('stress: 24 placements across surfaces, applied 50 times, never leak slots', () => {
  const surfaces = ['desktop', 'overlay'];
  const widgets = Array.from({ length: 24 }, (_, i) => W({ id: 'lw_s' + String(i).padStart(4, '0'), widget: 'w' + i, surface: surfaces[i % 2] }));
  const { host, document, atom, ctx } = boot('?layer=overlay:', { enabled: true, widgets });
  for (let i = 0; i < 24; i++) atom('w' + i);
  for (let round = 0; round < 50; round++) {
    const keep = widgets.filter((_, i) => (i + round) % 3 !== 0);
    ctx.hubSettings.layers = { enabled: true, widgets: keep };
    host.place();
    const expected = keep.filter(w => w.surface === 'overlay').length;
    assert.equal(slotsOf(document).length, expected, 'round ' + round);
  }
});

test('inside the shell, the page reports where its tiles are, in device pixels', () => {
  const layers = { enabled: true, widgets: [W(), W({ id: 'lw_aaaa0002', widget: 'media' })] };
  const { host, document, atom, signals, flush, ctx } = boot('?layer=desktop:', layers, { shell: true });
  atom('weather'); atom('media');
  host.place();
  const [a, b] = slotsOf(document);
  a.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 100 });
  b.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 });
  flush();
  assert.deepEqual(signals, ['xenon-app:layer-rects?d=' + encodeURIComponent('15,30,300,150')], 'a hidden slot is not clickable');
  host.place();
  flush();
  assert.equal(signals.length, 1, 'unchanged rectangles are not re-sent');
  ctx.hubSettings.layers = { enabled: true, widgets: [] };
  host.place();
  flush();
  assert.equal(signals.at(-1), 'xenon-app:layer-rects?d=', 'nothing placed: nothing clickable');
});

test('outside the shell (a browser tab on ?layer=) no signal is ever sent', () => {
  const { host, atom, signals, flush } = boot('?layer=desktop:', { enabled: true, widgets: [W()] });
  atom('weather');
  host.place();
  flush();
  assert.equal(signals.length, 0);
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('a layer page never writes settings: local mirror, server save and unload beacon', () => {
  const s = read('../js/settings.js');
  assert.match(s, /const _settingsReadOnly = \/\[\?&\]layer=\/\.test\(/);
  assert.match(s, /function saveLocalHubSettings\(\) \{\n  if \(_settingsReadOnly\) return;/);
  assert.match(s, /function postHubSettingsToServer\(\) \{\n  if \(_settingsReadOnly\) return Promise\.resolve\(null\);/);
  assert.match(s, /if \(toServer && !_settingsReadOnly\) \{/);
  assert.match(s, /if \(!_hubHydratedFromServer \|\| _settingsReadOnly\) return;/);
});

test('every layout apply forces placed tiles visible first and places them last', () => {
  const d = read('../js/dashboard-layout.js');
  const fn = d.slice(d.indexOf('function applyDashboardLayout() {'), d.indexOf('function applyDashboardLayoutWithTransition'));
  assert.ok(fn.indexOf('LayerHost.forceVisible()') < fn.indexOf('const layout = getDashboardLayout();'));
  // The last step: on a layer page it places the tiles, on the main page it
  // tells the shell which layer windows to keep (layers-shell.js).
  assert.match(fn, /step\('layerHost', \(\) => window\.LayerHost\.place\(\)\);\n  else if \(window\.LayersShell\) step\('layersShell', \(\) => window\.LayersShell\.sync\(\)\);\n\}\n/);
});

test('custom widgets read a layer assignment before the saved one, and the page loads it all in order', () => {
  const cw = read('../js/custom-widget.js');
  assert.match(cw, /if \(layerAssign\.has\(instId\)\) return layerAssign\.get\(instId\);/);
  // A layer window mounts its slots only, never the hidden dashboard pages.
  assert.match(cw, /const scope = window\.LayerHost && window\.LayerHost\.active \? '\.layer-slot' : '\.pager-page, \.layer-slot';/);
  assert.match(cw, /\.filter\(n => n\.closest\(scope\)\)/);
  assert.match(cw, /setLayerAssign,/);
  const html = read('../index.html');
  assert.ok(html.indexOf('src="js/custom-widget.js"') < html.indexOf('src="js/layer-host.js"'));
  assert.ok(html.indexOf('src="js/layer-host.js"') < html.indexOf('src="js/main.js"'));
  assert.match(html, /href="components\/LayerHost\/LayerHost\.css"/);
});

test('on a small or portrait screen a tile keeps a usable size and stays on screen', () => {
  const css = read('../components/LayerHost/LayerHost.css');
  assert.match(css, /--layer-box-w: min\(100%, max\(var\(--layer-w, 20%\), var\(--layer-min-w\)\)\);/);
  assert.match(css, /left: clamp\(0px, var\(--layer-x, 0%\), 100% - var\(--layer-box-w\)\);/);
  assert.match(css, /top: clamp\(0px, var\(--layer-y, 0%\), 100% - var\(--layer-box-h\)\);/);
  assert.match(css, /html\[data-layer\] body > :not\(#layer-root\):not\(#picker-overlay\):not\(\[data-layer-sheet\]\) \{\n  display: none !important;/);
});

test('the device picker opens over the tile that was pressed, not over the screen', () => {
  const b = boot('?layer=desktop:', { enabled: true, widgets: [W()] });
  const tile = b.atom('weather');
  const sheet = b.document.createElement('div');
  sheet.id = 'picker-overlay';
  b.document.body.appendChild(sheet);
  b.host.place();
  const root = b.document.getElementById('layer-root');
  const slot = slotsOf(b.document)[0];
  slot._rect = { width: 320, height: 240 };
  const press = (target) => root._handlers.pointerdown.forEach((fn) => fn({ target }));
  press(tile);
  assert.equal(sheet.style.getPropertyValue('--layer-sheet-w'), '320px');
  assert.equal(sheet.style.getPropertyValue('--layer-sheet-h'), '240px');
  slot._rect = { width: 10, height: 10 };
  press(root);
  assert.equal(sheet.style.getPropertyValue('--layer-sheet-w'), '320px', 'outside a slot: unchanged');
  const css = read('../components/LayerHost/LayerHost.css');
  assert.match(css, /html\[data-layer\] #picker-overlay \{\n  inset: auto;\n  left: var\(--layer-sheet-x, 0px\);/);
});

// A dialog a tile opens on the body (the calendar's day, the Deck's mixer) was
// hidden by the CSS and outside the clickable region, so it never showed on a
// layer. Shortly after a press in a slot it is let through and made clickable.
test('a dialog a tile opens is shown and clickable while it is drawn', () => {
  const observers = [];
  class Observer {
    constructor(fn) { this.fn = fn; observers.push(this); }
    observe() {}
    disconnect() {}
  }
  const b = boot('?layer=overlay:', { enabled: true, widgets: [W({ surface: 'overlay' })] }, { shell: true, Observer });
  const tile = b.atom('weather');
  b.host.place();
  const slot = slotsOf(b.document)[0];
  slot._rect = { width: 300, height: 150 };
  const bodyKids = observers[1];
  const el = (tag) => Object.assign(b.document.createElement(tag), { nodeType: 1 });
  const added = (node) => { b.document.body.appendChild(node); bodyKids.fn([{ type: 'childList', addedNodes: [node], removedNodes: [] }]); b.flush(); };

  const early = el('div');
  added(early);
  assert.equal(early.hasAttribute('data-layer-sheet'), false, 'nothing pressed: stays hidden');

  b.document.getElementById('layer-root')._handlers.pointerdown.forEach((fn) => fn({ target: tile }));
  const mixer = el('div');
  mixer._rect = { width: 1000, height: 500 };
  added(mixer);
  assert.equal(mixer.hasAttribute('data-layer-sheet'), true);
  assert.equal(b.signals.at(-1), 'xenon-app:layer-rects?d=' + encodeURIComponent('0,0,450,225;0,0,1500,750'));

  const grid = el('div');
  grid.setAttribute('class', 'dashboard-grid');
  b.document.body.appendChild(grid);
  bodyKids.fn([{ type: 'attributes', target: grid }]);
  assert.equal(grid.hasAttribute('data-layer-sheet'), false, 'a class change on the dashboard is not a dialog');
  const day = el('div');
  day.setAttribute('role', 'dialog');
  b.document.body.appendChild(day);
  bodyKids.fn([{ type: 'attributes', target: day }]);
  assert.equal(day.hasAttribute('data-layer-sheet'), true, 'a dialog opened by class');

  mixer.remove();
  bodyKids.fn([{ type: 'childList', addedNodes: [], removedNodes: [mixer] }]);
  b.flush();
  assert.equal(b.signals.at(-1), 'xenon-app:layer-rects?d=' + encodeURIComponent('0,0,450,225'), 'closed: only the tile again');
});

// The light page (layer-lite.html) runs Store widgets only. A page that finds
// itself the wrong one for what is placed on its surface reloads, and the
// server (same rule, LayersModel.needsDashboard) hands over the other one.
const SDK = (over = {}) => W({ kind: 'sdk', pkg: 'keyring', widget: undefined, ...over });
// A tile only the dashboard draws (js/layer-tiles.js gives it a `full` reason).
const FULL_TILE = (over = {}) => W({ id: 'lw_aaaa0002', widget: 'browser', ...over });

test('the light page reloads into the dashboard when a built-in tile lands on its surface', () => {
  const b = boot('?layer=desktop:', { enabled: true, widgets: [SDK(), FULL_TILE()] }, { lite: true });
  assert.equal(b.host.lite, true);
  b.host.place();
  assert.equal(b.reloads.n, 1);
  assert.equal(b.document.getElementById('layer-root'), null, 'nothing placed on a page that is leaving');
});

test('the light page stays put while its surface holds Store widgets only', () => {
  const b = boot('?layer=desktop:', { enabled: true, widgets: [SDK()] }, { lite: true });
  b.host.place();
  assert.equal(b.reloads.n, 0);
  assert.equal(slotsOf(b.document).length, 1);
});

test("the dashboard page reloads into the light one once its tiles are gone, but only once the server's settings are in", () => {
  const layers = { enabled: true, widgets: [SDK()] };
  const early = boot('?layer=desktop:', layers, { hydrated: false });
  early.host.place();
  assert.equal(early.reloads.n, 0, 'the browser copy of the settings is not the truth yet');
  const settled = boot('?layer=desktop:', layers, { hydrated: true });
  settled.host.place();
  assert.equal(settled.reloads.n, 1);
  const withTile = boot('?layer=desktop:', { enabled: true, widgets: [SDK(), FULL_TILE()] }, { hydrated: true });
  withTile.host.place();
  assert.equal(withTile.reloads.n, 0);
});

test('two reloads inside the gap never happen: the second waits for it, then retries', () => {
  const b = boot('?layer=desktop:', { enabled: true, widgets: [SDK(), FULL_TILE()] }, { lite: true, store: { xenonLayerReloadAt: String(Date.now()) } });
  b.host.place();
  assert.equal(b.reloads.n, 0, 'a reload just happened: no loop');
  b.host.place();
  assert.equal(b.timers.length, 1, 'one retry is queued, not one per call');
  b.store.xenonLayerReloadAt = '0';
  b.flush();
  assert.equal(b.reloads.n, 1, 'after the gap the page still becomes the right one');
});

test('the server serves the light page by the same rule, and only on this machine', () => {
  const s = read('../server.js');
  const at = s.indexOf("if (reqPath === '/' && req.method === 'GET') {");
  const route = s.slice(at, s.indexOf('LayerPage.compose(', at) + 200);
  assert.match(route, /if \(!isRemote && LayersModel\.isSurfaceKey\(layerKey\) && !LayersModel\.needsDashboard\(_serverHubSettings\.layers, layerKey\)\) \{/);
  assert.match(route, /'layer-lite\.html'/);
  assert.match(route, /'Cache-Control': 'no-store'/);
});

test('needsDashboard: a built-in tile on the surface, with layers on', () => {
  const L = (widgets, enabled = true) => ({ enabled, widgets });
  assert.equal(LayersModel.needsDashboard(L([SDK()]), 'desktop:'), false);
  assert.equal(LayersModel.needsDashboard(L([SDK(), FULL_TILE()]), 'desktop:'), true);
  assert.equal(LayersModel.needsDashboard(L([FULL_TILE({ surface: 'overlay' })]), 'desktop:'), false, 'a tile elsewhere does not count');
  assert.equal(LayersModel.needsDashboard(L([FULL_TILE()], false), 'desktop:'), false, 'layers off: nothing to draw');
  assert.equal(LayersModel.needsDashboard(L([SDK(), W()]), 'desktop:'), false, 'the light page carries the weather tile');
  assert.equal(LayersModel.needsDashboard(null, 'desktop:'), false);
  assert.equal(LayersModel.isSurfaceKey('desktop:'), true);
  assert.equal(LayersModel.isSurfaceKey('anchor:lw_ab12cd'), true);
  for (const bad of [null, '', 'desk:', 'anchor:../x', 'overlay:' + 'x'.repeat(65)]) assert.equal(LayersModel.isSurfaceKey(bad), false, String(bad));
});

test('the light page carries the weather tile it was served with, and builds it once', () => {
  const b = boot('?layer=desktop:', { enabled: true, widgets: [SDK(), W({ id: 'lw_aaaa0003' })] }, { lite: true, tiles: 'weather' });
  b.host.place();
  b.host.place();
  assert.equal(b.reloads.n, 0);
  assert.equal(slotsOf(b.document).length, 2);
  assert.equal(b.document.querySelectorAll('[data-dashboard-widget="weather"]').length, 1, 'the same atom on every apply');
});

test('a weather tile placed after the light page loaded reloads it, so the server adds its code', () => {
  const b = boot('?layer=desktop:', { enabled: true, widgets: [SDK(), W({ id: 'lw_aaaa0003' })] }, { lite: true, tiles: '' });
  b.host.place();
  assert.equal(b.reloads.n, 1);
});

test('the dashboard never builds a missing tile: only the light page does', () => {
  const b = boot('?layer=desktop:', { enabled: true, widgets: [W()] }, { hydrated: true });
  b.host.place();
  assert.equal(b.document.querySelectorAll('[data-dashboard-widget="weather"]').length, 0);
});

test('liteTilesFor: the carried tiles on this surface, sorted, once each', () => {
  const L = (widgets, enabled = true) => ({ enabled, widgets });
  assert.deepEqual(LayersModel.liteTilesFor(L([W(), W({ id: 'lw_aaaa0004', instance: 'weather-2' }), FULL_TILE(), SDK({ id: 'lw_aaaa0005' })]), 'desktop:'), ['weather']);
  assert.deepEqual(LayersModel.liteTilesFor(L([W({ id: 'lw_aaaa0006', widget: 'media' })]), 'desktop:'), ['media']);
  assert.equal(LayersModel.needsDashboard(L([W({ id: 'lw_aaaa0006', widget: 'media', instance: 'media-2' })]), 'desktop:'), true, 'a Media copy is built by the dashboard');
  assert.deepEqual(LayersModel.liteTilesFor(L([W({ surface: 'overlay' })]), 'desktop:'), []);
  assert.deepEqual(LayersModel.liteTilesFor(L([W()], false), 'desktop:'), []);
  assert.deepEqual(LayersModel.liteTilesFor(null, 'desktop:'), []);
  const sys = W({ id: 'lw_aaaa0006', widget: 'system' });
  assert.deepEqual(LayersModel.liteTilesFor(L([sys, W(), sys]), 'desktop:'), ['system', 'weather']);
  assert.equal(LayersModel.needsDashboard(L([sys, W()]), 'desktop:'), false, 'CPU/GPU ride the light page');
  // Only the System tile itself: a copy would need the dashboard's copy builder.
  const copy = W({ id: 'lw_aaaa0007', widget: 'system', instance: 'system-2' });
  assert.equal(LayersModel.needsDashboard(L([copy]), 'desktop:'), true);
  assert.deepEqual(LayersModel.liteTilesFor(L([copy]), 'desktop:'), []);
});

// Tabs made by the user: two widgets grouped share one box with the dashboard's tab bar.
const grouped = (over = {}) => ({ enabled: true, widgets: [
  W({ group: 'lt_grp00001' }),
  W({ id: 'lw_aaaa0002', widget: 'media', group: 'lt_grp00001', active: true }),
  ...(over.more || []),
] });
const tabsOf = (slot) => {
  const tile = slot.children[0];
  return { tile, bar: tile.children[0], body: tile.children[1] };
};

test('grouped widgets share one box: a tab each, only the active one shown', () => {
  const { host, document, atom } = boot('?layer=desktop:', grouped());
  const weather = atom('weather');
  const media = atom('media');
  host.place();
  const slots = slotsOf(document);
  assert.equal(slots.length, 1, 'one box for the group');
  assert.equal(slots[0].dataset.layerId, 'lt_grp00001');
  const { tile, bar, body } = tabsOf(slots[0]);
  assert.match(tile.className, /\btabgroup\b/);
  assert.deepEqual(bar.children.map(t => t.dataset.member), ['lw_aaaa0001', 'lw_aaaa0002']);
  assert.deepEqual(bar.children.map(t => /\bactive\b/.test(t.className)), [false, true]);
  assert.equal(weather.parentNode, body);
  assert.equal(media.parentNode, body);
  assert.equal(weather.dataset.dashboardHidden, 'true');
  assert.equal(media.dataset.dashboardHidden, 'false');
  assert.equal(bar.children[1].children.at(-1).textContent, 'media', 'no translation here: the widget name, as text');
});

test('a tab picked in the window holds for that window only, and survives the next apply', () => {
  const { host, document, atom, store } = boot('?layer=desktop:', grouped());
  const weather = atom('weather');
  const media = atom('media');
  host.place();
  tabsOf(slotsOf(document)[0]).bar.children[0].click();
  assert.equal(store['xenonLayerTab:lt_grp00001'], 'lw_aaaa0001');
  assert.equal(weather.dataset.dashboardHidden, 'false');
  assert.equal(media.dataset.dashboardHidden, 'true');
  host.place();
  assert.equal(weather.dataset.dashboardHidden, 'false', 'the pick is kept across applies');
  assert.equal(tabsOf(slotsOf(document)[0]).bar.children.length, 2, 'the bar is redrawn, never doubled');
});

test('a picked tab that left the group falls back to the saved one', () => {
  const store = { 'xenonLayerTab:lt_grp00001': 'lw_gone0001' };
  const { host, atom } = boot('?layer=desktop:', grouped(), { store });
  atom('weather');
  const media = atom('media');
  host.place();
  assert.equal(media.dataset.dashboardHidden, 'false');
});

test('ungrouped, each widget gets its own box back and nothing is lost', () => {
  const { host, document, atom, ctx } = boot('?layer=desktop:', grouped());
  const weather = atom('weather');
  const media = atom('media');
  host.place();
  ctx.hubSettings.layers = LayersModel.ungroupWidget(grouped(), 'lw_aaaa0002').layers;
  host.place();
  const slots = slotsOf(document);
  assert.deepEqual(slots.map(s => s.dataset.layerId).sort(), ['lw_aaaa0001', 'lw_aaaa0002']);
  assert.equal(weather.parentNode.dataset.layerId, 'lw_aaaa0001');
  assert.equal(media.parentNode.dataset.layerId, 'lw_aaaa0002');
  assert.equal(weather.dataset.dashboardHidden, 'false');
  assert.equal(media.dataset.dashboardHidden, 'false');
});

test('a removed group parks its tiles in the page and releases its Store widget', () => {
  const layers = { enabled: true, widgets: [
    W({ group: 'lt_grp00001' }),
    W({ id: 'lw_sdkw0001', kind: 'sdk', pkg: 'keyring', widget: undefined, group: 'lt_grp00001' }),
  ] };
  const { host, document, atom, ctx, assigned } = boot('?layer=desktop:', layers);
  const weather = atom('weather');
  host.place();
  const sdkAtom = tabsOf(slotsOf(document)[0]).body.children.find(a => a.getAttribute('data-dashboard-instance') === 'lw_sdkw0001');
  assert.ok(sdkAtom, 'the Store widget is a tab too');
  assert.equal(assigned.at(-1).get('lw_sdkw0001'), 'keyring');
  ctx.hubSettings.layers = { enabled: true, widgets: [] };
  host.place();
  assert.equal(slotsOf(document).length, 0);
  assert.equal(weather.parentNode, document.body, 'parked, never detached');
  assert.equal(weather.dataset.dashboardHidden, 'true');
  assert.notEqual(sdkAtom.parentNode, document.body, 'the Store atom goes with its box');
  assert.equal(assigned.at(-1).size, 0);
});

// ── Edit mode ────────────────────────────────────────────────────────────────
function fakeStream() {
  const on = {};
  return { on, addEventListener: (type, fn) => { (on[type] ||= []).push(fn); }, emit: (type, data) => (on[type] || []).forEach(fn => fn({ data: JSON.stringify(data) })) };
}

function editBoot(search, layers, opts) {
  const b = boot(search, layers, opts);
  b.document.head = b.document.createElement('head');
  b.document.documentElement.appendChild(b.document.head);
  const editor = { started: [], stopped: 0 };
  b.loadEditor = () => {
    b.ctx.window.LayerEdit = { start: (api) => editor.started.push(api), stop: () => { editor.stopped++; }, refresh() {} };
    const script = b.document.head.children.find(n => n.tag === 'script');
    (script._handlers.load || []).forEach(fn => fn());
    return script;
  };
  b.editor = editor;
  return b;
}

test('edit mode loads its script only when turned on, then hands it the boxes and the runner', () => {
  const { host, atom, document, editor, loadEditor } = editBoot('?layer=desktop:', { enabled: true, widgets: [W()] });
  atom('weather');
  host.place();
  const es = fakeStream();
  host.listen(es);
  assert.equal(document.head.children.length, 0, 'never edited: never loaded');
  es.emit('layers-edit', { on: true });
  const script = loadEditor();
  assert.equal(script.src, 'js/layer-edit.js');
  assert.equal(editor.started.length, 1);
  const api = editor.started[0];
  assert.equal(api.surface, 'desktop');
  assert.equal(api.root(), document.getElementById('layer-root'));
  assert.deepEqual([...api.boxes().map(b => b.box.lead.widget)], ['weather']);
  assert.throws(() => { api.place = null; }, 'the api is frozen');
  es.emit('layers-edit', { on: false });
  assert.equal(editor.stopped, 1);
  es.emit('layers-edit', { on: true });
  assert.equal(document.head.children.length, 1, 'loaded once');
  assert.equal(editor.started.length, 2);
});

test('while editing the window reports its whole root and the mode; after, its tiles again', () => {
  const { host, atom, document, signals, flush, loadEditor } = editBoot('?layer=desktop:', { enabled: true, widgets: [W()] }, { shell: true });
  atom('weather');
  host.place();
  const slot = slotsOf(document)[0];
  slot.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 100 });
  document.getElementById('layer-root').getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500 });
  flush();
  const es = fakeStream();
  host.listen(es);
  es.emit('layers-edit', { on: true });
  loadEditor();
  flush();
  assert.equal(signals.at(-1), 'xenon-app:layer-rects?d=' + encodeURIComponent('0,0,1500,750') + '&edit=1');
  es.emit('layers-edit', { on: false });
  flush();
  assert.equal(signals.at(-1), 'xenon-app:layer-rects?d=' + encodeURIComponent('15,30,300,150'));
});

test('an anchored window keeps its widget rectangle while editing, but still tells the mode', () => {
  const w = W({ id: 'lw_anch0001', surface: 'anchor', anchor: { app: 'krita.exe' } });
  const { host, atom, document, signals, flush } = editBoot('?layer=anchor:lw_anch0001', { enabled: true, widgets: [w] }, { shell: true });
  atom('weather');
  host.place();
  slotsOf(document)[0].getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100 });
  const es = fakeStream();
  host.listen(es);
  es.emit('layers-edit', { on: true });
  flush();
  assert.equal(signals.at(-1), 'xenon-app:layer-rects?d=' + encodeURIComponent('0,0,300,150') + '&edit=1');
});

test('a window that opens or reconnects mid-edit reads the mode; a broken reply changes nothing', async () => {
  const { host, ctx, document } = editBoot('?layer=desktop:', { enabled: true, widgets: [] });
  const asked = [];
  ctx.fetch = (url) => { asked.push(url); return Promise.resolve({ json: () => Promise.resolve({ on: true }) }); };
  const es = fakeStream();
  host.listen(es);
  await es.on.open[0]();
  assert.deepEqual(asked, ['/layers/edit']);
  assert.equal(document.head.children.length, 1, 'turned on: the editor loads');
  ctx.fetch = () => Promise.reject(new Error('offline'));
  await es.on.open[0]();
  es.emit('layers-edit', 'not json at all');
  assert.equal(document.head.children.length, 1);
});

test('an edit frame inside a slot is never taken for a tile', () => {
  const { host, atom, document } = editBoot('?layer=desktop:', { enabled: true, widgets: [W()] });
  const tile = atom('weather');
  host.place();
  const slot = slotsOf(document)[0];
  const frame = document.createElement('div');
  frame.className = 'layer-edit-frame';
  slot.appendChild(frame);
  host.place();
  assert.deepEqual(slot.children, [tile, frame]);
});

test('the editor learns which screen this window covers', () => {
  for (const [key, monitor] of [['desktop:', ''], ['overlay:DISPLAY2', 'DISPLAY2']]) {
    const { host, editor, loadEditor } = editBoot('?layer=' + key, { enabled: true, widgets: [] });
    const es = fakeStream();
    host.listen(es);
    es.emit('layers-edit', { on: true });
    loadEditor();
    assert.equal(editor.started[0].monitor, monitor);
  }
});

// Pages: one shown at a time on every window, switching parks the others.
const PAGES = [{ id: 'lp_work0001', name: 'Work' }, { id: 'lp_game0001', name: 'Games', gaming: true }];
const paged = (page) => ({ enabled: true, pages: PAGES, page, widgets: [
  W({ page: 'lp_work0001' }),
  W({ id: 'lw_aaaa0002', widget: 'media', page: 'lp_game0001' }),
  SDK({ id: 'lw_aaaa0003', page: 'lp_game0001' }),
] });

test('only the page shown is drawn; switching parks its tiles and releases its Store widgets', () => {
  const { host, document, atom, grid, ctx, assigned } = boot('?layer=desktop:', paged('lp_work0001'), { dashboardWidgets: { weather: { visible: false }, media: { visible: false } } });
  const weather = atom('weather');
  const media = atom('media');
  host.forceVisible();
  host.place();
  assert.deepEqual(Array.from(slotsOf(document), (s) => s.dataset.layerId), ['lw_aaaa0001']);
  assert.equal(media.parentNode, grid);
  assert.equal(ctx.hubSettings.dashboardLayout.widgets.media.visible, true, 'a tile on another page is laid out already');
  ctx.hubSettings.layers = paged('lp_game0001');
  host.place();
  assert.deepEqual(Array.from(slotsOf(document), (s) => s.dataset.layerId).sort(), ['lw_aaaa0002', 'lw_aaaa0003']);
  assert.equal(weather.parentNode, document.body, 'parked, not detached');
  assert.equal(weather.dataset.dashboardHidden, 'true');
  assert.equal(JSON.stringify([...assigned.at(-1)]), '[["lw_aaaa0003","keyring"]]');
  ctx.hubSettings.layers = paged('lp_work0001');
  host.place();
  assert.equal(weather.parentNode, slotsOf(document)[0]);
  assert.equal(assigned.at(-1).size, 0);
});

test('stress: switching pages 100 times never leaks a slot or an atom', () => {
  const { host, document, atom, ctx } = boot('?layer=desktop:', paged('lp_work0001'));
  atom('weather'); atom('media');
  for (let i = 0; i < 100; i++) {
    ctx.hubSettings.layers = paged(i % 2 ? 'lp_work0001' : 'lp_game0001');
    host.place();
    assert.equal(slotsOf(document).length, i % 2 ? 1 : 2);
  }
  assert.equal(document.querySelectorAll('[data-dashboard-widget="weather"]').length, 1);
  assert.equal(document.querySelectorAll('[data-dashboard-widget="media"]').length, 1);
});
