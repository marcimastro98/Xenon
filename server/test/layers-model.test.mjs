// Widgets outside the dashboard (desktop / overlay / anchored): one set of rules
// in js/layers-model.js, shared by the client, the server and the capabilities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const L = require('../js/layers-model.js');
const { createLayersHost, REPORT_TTL_MS } = require('../layers-host.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const W = (over = {}) => ({ id: 'lw_abcd1234', kind: 'tile', widget: 'weather', surface: 'desktop', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 }, ...over });

test('the default is off with nothing placed, so an existing user sees no new window', () => {
  assert.deepEqual(L.normalize(undefined), { enabled: false, screens: 'auto', excludeFromCapture: true, hidden: [], overlayKey: 'ctrl+shift+f9', menuKey: 'alt+shift+x', menuPad: true, pages: [], page: '', widgets: [] });
  assert.equal(L.normalize({ menuPad: false }).menuPad, false, 'the controller chord can be turned off');
  assert.equal(L.normalize({ menuPad: 'no' }).menuPad, true, 'anything but false keeps it on');
  assert.deepEqual(L.normalize(null), L.DEFAULTS);
  assert.deepEqual(L.surfaceKeys({ widgets: [W()] }), [], 'placed but switched off draws nothing');
});

test('a placed tile keeps its shape and fills the defaults', () => {
  const n = L.normalize({ enabled: true, widgets: [W()] });
  assert.deepEqual(n.widgets[0], { id: 'lw_abcd1234', kind: 'tile', widget: 'weather', surface: 'desktop', monitor: '', rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.3 }, opacity: 1, show: 'always' });
});

test('a rectangle never leaves the screen and never collapses', () => {
  const r = L.normalize({ widgets: [W({ rect: { x: 0.95, y: -3, w: 0.5, h: 0 } })] }).widgets[0].rect;
  assert.equal(r.w, 0.5); assert.equal(r.h, 0.02);
  assert.equal(r.x, 0.5, 'pushed back so the right edge stays on screen');
  assert.equal(r.y, 0);
  const big = L.normalize({ widgets: [W({ rect: { x: 0, y: 0, w: 9, h: 9 } })] }).widgets[0].rect;
  assert.deepEqual(big, { x: 0, y: 0, w: 1, h: 1 });
});

test('bad entries are dropped: wrong id, unknown widget name, duplicate, path-like package', () => {
  const n = L.normalize({ widgets: [
    W({ id: 'x' }), W({ widget: 'Weather!' }), W(), W(), W({ id: 'lw_pkg00001', kind: 'sdk', pkg: '../evil' }),
    W({ id: 'lw_pkg00002', kind: 'sdk', pkg: 'wall-plate' }),
  ] });
  assert.deepEqual(n.widgets.map(w => w.id), ['lw_abcd1234', 'lw_pkg00002']);
  assert.deepEqual(n.widgets[1].pkg, 'wall-plate');
  assert.equal(n.widgets[1].widget, undefined);
});

test('an anchored widget without an app to follow falls back to the desktop', () => {
  assert.equal(L.normalize({ widgets: [W({ surface: 'anchor' })] }).widgets[0].surface, 'desktop');
  assert.equal(L.normalize({ widgets: [W({ surface: 'anchor', anchor: { app: 'C:\\x\\krita.exe' } })] }).widgets[0].surface, 'desktop', 'a path is not an app name');
  const a = L.normalize({ widgets: [W({ surface: 'anchor', anchor: { app: 'krita.exe', corner: 'zz', dx: 1e9, w: 5 } })] }).widgets[0];
  assert.equal(a.surface, 'anchor');
  assert.deepEqual(a.anchor, { app: 'krita.exe', title: '', corner: 'tr', dx: 4000, dy: 16, w: 80, h: 240 });
});

test('opacity, show rule, screens and monitor key are bounded', () => {
  const n = L.normalize({ screens: 'moon', excludeFromCapture: false, widgets: [W({ opacity: 0, show: 'never', monitor: 'x'.repeat(65) })] });
  assert.equal(n.screens, 'auto');
  assert.equal(n.excludeFromCapture, false);
  assert.equal(n.widgets[0].opacity, 0.2);
  assert.equal(n.widgets[0].show, 'always');
  assert.equal(n.widgets[0].monitor, '');
});

test('never more than 24 widgets', () => {
  const many = Array.from({ length: 40 }, (_, i) => W({ id: 'lw_' + String(i).padStart(6, '0') }));
  assert.equal(L.normalize({ widgets: many }).widgets.length, L.MAX_WIDGETS);
  let layers = { widgets: many.slice(0, 24) };
  assert.deepEqual(L.addWidget(layers, { widget: 'media' }), { error: 'too_many' });
});

test('words become a rectangle in the right corner, with a margin', () => {
  assert.deepEqual(L.rectFor('top-right', 'medium'), { x: 0.78, y: 0.02, w: 0.2, h: 0.3 });
  assert.deepEqual(L.rectFor('bottom-left', 'small'), { x: 0.02, y: 0.78, w: 0.14, h: 0.2 });
  assert.deepEqual(L.rectFor('center', 'large'), { x: 0.35, y: 0.275, w: 0.3, h: 0.45 });
  assert.deepEqual(L.rectFor('nowhere', 'huge'), L.rectFor('top-right', 'medium'));
});

test('add, update and remove return new objects and turn the feature on when placing', () => {
  const r = L.addWidget(undefined, { widget: 'weather', position: 'top-left', size: 'small' }, () => 0.5);
  assert.equal(r.layers.enabled, true);
  assert.equal(r.widget.surface, 'desktop');
  assert.match(r.widget.id, /^lw_[a-z0-9]+$/);
  assert.deepEqual(L.addWidget(undefined, { widget: '' }), { error: 'bad_widget' });
  assert.equal(L.addWidget(undefined, { widget: 'weather', surface: 'anchor' }).widget.surface, 'desktop', 'anchoring needs the editor, not words');

  const u = L.updateWidget(r.layers, r.widget.id, { surface: 'overlay', kind: 'sdk', opacity: 0.5 });
  assert.equal(u.widget.surface, 'overlay');
  assert.equal(u.widget.kind, 'tile', 'the kind of a placement never changes');
  assert.equal(u.widget.opacity, 0.5);
  assert.deepEqual(L.updateWidget(r.layers, 'lw_nothere1', {}), { error: 'not_found' });

  const two = L.addWidget(u.layers, { widget: 'weather' }).layers;
  assert.equal(L.removeWidget(two, 'weather').removed, 2, 'a name removes every copy');
  assert.deepEqual(L.removeWidget(two, 'media'), { error: 'not_found' });
  assert.equal(L.removeWidget(two, r.widget.id).layers.widgets.length, 1);
});

test('surfaces: one window per monitor for desktop and overlay, one per anchored widget', () => {
  const layers = { enabled: true, widgets: [
    W({ id: 'lw_aaaa0001' }), W({ id: 'lw_aaaa0002' }), W({ id: 'lw_aaaa0003', monitor: 'DISPLAY2' }),
    W({ id: 'lw_aaaa0004', surface: 'overlay' }),
    W({ id: 'lw_aaaa0005', surface: 'anchor', anchor: { app: 'krita.exe' } }),
  ] };
  assert.deepEqual(L.surfaceKeys(layers), ['desktop:', 'desktop:DISPLAY2', 'overlay:', 'anchor:lw_aaaa0005']);
  assert.deepEqual(L.widgetsFor(layers, 'desktop:').map(w => w.id), ['lw_aaaa0001', 'lw_aaaa0002']);
});

test('stress: any input normalizes to a valid, stable shape', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const junk = () => {
    const pool = [null, undefined, '', 'x', -1, 0, 0.5, 1e9, NaN, Infinity, true, [], {}, 'desktop', 'overlay', 'anchor', 'tile', 'sdk', 'weather', 'krita.exe', 'lw_abcd1234', 'lw_zzzz9999'];
    return pool[Math.floor(rnd() * pool.length)];
  };
  for (let i = 0; i < 2000; i++) {
    const raw = { enabled: junk(), screens: junk(), widgets: Array.from({ length: Math.floor(rnd() * 30) }, () => ({
      id: rnd() < 0.7 ? 'lw_' + Math.floor(rnd() * 1e8).toString(36).padStart(4, '0') : junk(),
      kind: junk(), widget: junk(), pkg: junk(), instance: junk(), surface: junk(), monitor: junk(),
      rect: { x: junk(), y: junk(), w: junk(), h: junk() }, opacity: junk(), show: junk(),
      anchor: rnd() < 0.5 ? { app: junk(), corner: junk(), dx: junk(), w: junk() } : junk(),
    })) };
    const n = L.normalize(raw);
    assert.deepEqual(L.normalize(n), n, 'normalizing twice changes nothing');
    assert.ok(n.widgets.length <= L.MAX_WIDGETS);
    for (const w of n.widgets) {
      const { x, y, w: rw, h } = w.rect;
      assert.ok(x >= 0 && y >= 0 && rw >= 0.02 && h >= 0.02 && x + rw <= 1.0001 && y + h <= 1.0001, JSON.stringify(w.rect));
      assert.ok(L.SURFACES.includes(w.surface));
      if (w.surface === 'anchor') assert.ok(w.anchor && w.anchor.app);
    }
  }
});

// ── Wiring ───────────────────────────────────────────────────────────────────

test('client and server both normalize layers with this one file', () => {
  const settings = read('../js/settings.js');
  const server = read('../server.js');
  const index = read('../index.html');
  assert.match(settings, /layers: LayersModel\.normalize\(null\),/);
  assert.match(settings, /layers: LayersModel\.normalize\(value\.layers\),/);
  assert.match(server, /const LayersModel = require\('\.\/js\/layers-model\.js'\);/);
  assert.match(server, /layers: LayersModel\.DEFAULTS,/);
  assert.match(server, /layers: LayersModel\.normalize\(source\.layers\),/);
  assert.ok(index.indexOf('src="js/layers-model.js"') < index.indexOf('src="js/settings.js"'));
});

test('server edits to layers run under the settings lock, bump rev and tell the other surfaces', () => {
  const server = read('../server.js');
  const fn = server.slice(server.indexOf('async function updateLayersSetting'), server.indexOf('async function updateLayersSetting') + 900);
  assert.match(fn, /withHubSettingsLock\(async \(\) => \{\n\s+const cur = \(await readHubSettings\(\)/, 'prev is read INSIDE the lock');
  assert.match(fn, /if \(!res \|\| res\.error \|\| !res\.layers\) return/);
  assert.match(fn, /rev: nextSettingsRev\(cur\.rev\)/);
  assert.match(fn, /broadcastSSE\('settings', \{ rev: saved\.rev \}\)/);
});

// ── The shell's report ───────────────────────────────────────────────────────

test('layers are available only while a shell that draws them has reported', () => {
  let t = 1000;
  const host = createLayersHost({ now: () => t });
  assert.equal(host.available(), false);
  host.accept({ layers: true, monitors: [{ key: 'DISPLAY1', primary: true }, { key: 'DISPLAY2' }, { key: 'DISPLAY2' }, { key: '\u0000' }] });
  assert.equal(host.available(), true);
  assert.equal(host.secondMonitor(), 'DISPLAY2');
  assert.deepEqual(host.monitors(), [{ key: 'DISPLAY1', primary: true }, { key: 'DISPLAY2', primary: false }]);
  t += REPORT_TTL_MS;
  assert.equal(host.available(), false, 'a shell that went quiet stops counting');
  assert.equal(host.secondMonitor(), '');
  host.accept({ layers: false });
  assert.equal(host.available(), false, 'a shell that cannot draw layers says so');
  host.accept(null);
  assert.equal(host.available(), false);
});

test('only the shell on this PC reports: CSRF-guarded, refused to a paired phone, size-capped', () => {
  const server = read('../server.js');
  const csrf = server.slice(server.indexOf('const CSRF_MUTATION_PATHS = new Set(['), server.indexOf(']);', server.indexOf('const CSRF_MUTATION_PATHS = new Set([')));
  assert.match(csrf, /'\/layers\/host',/);
  assert.match(server, /reqPath === '\/layers\/host' && req\.method === 'POST'\) \{[\s\S]{0,400}readBody\(req, 16 \* 1024\)[\s\S]{0,80}layersHost\.accept\(body\)/);
  const { remotePathAllowed } = require('../remote-access.js');
  assert.equal(remotePathAllowed('/layers/host', 'POST'), false);
  assert.equal(remotePathAllowed('/layers/host', 'GET'), false);
});

// Tabs: widgets sharing a `group` are one box, like the dashboard's tab groups.
const id = (n) => 'lw_tabs000' + n;
const seq = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test('grouping puts the source in the target box as its shown tab; ungrouping gives it a box beside', () => {
  let cur = L.normalize({ enabled: true, widgets: [W({ id: id(1) }), W({ id: id(2), widget: 'media', surface: 'overlay', rect: { x: 0.6, y: 0.6, w: 0.2, h: 0.2 } })] });
  const g = L.groupWidgets(cur, id(1), id(2));
  cur = g.layers;
  const [a, b] = cur.widgets;
  assert.match(a.group, /^lt_[a-z0-9]{4,24}$/);
  assert.equal(b.group, a.group);
  assert.equal(b.surface, 'desktop', 'the tab moves to the box surface');
  assert.deepEqual(b.rect, a.rect);
  assert.deepEqual([a.active, b.active], [undefined, true]);
  assert.deepEqual(L.boxes(cur.widgets).map(x => [x.key, x.members.length, x.active]), [[a.group, 2, id(2)]]);
  const u = L.ungroupWidget(cur, id(2));
  assert.equal(u.widget.group, undefined);
  assert.equal(u.layers.widgets[0].group, undefined, 'the one left is a plain widget again');
  assert.ok(u.widget.rect.x + u.widget.rect.w <= 1, 'kept on screen');
  assert.notEqual(u.widget.rect.x, a.rect.x, 'beside, not on top');
});

test('grouping refuses what it cannot do', () => {
  const cur = L.normalize({ enabled: true, widgets: [W({ id: id(1) }), W({ id: id(2), surface: 'anchor', anchor: { app: 'krita.exe' } })] });
  assert.equal(L.groupWidgets(cur, id(1), id(1)).error, 'same_widget');
  assert.equal(L.groupWidgets(cur, id(1), id(9)).error, 'not_found');
  assert.equal(L.groupWidgets(cur, id(1), id(2)).error, 'anchored', 'an anchored window is the widget: no tabs');
  assert.equal(L.ungroupWidget(cur, id(1)).error, 'not_grouped');
});

test('a group holds at most MAX_TABS tabs', () => {
  const widgets = Array.from({ length: L.MAX_TABS + 1 }, (_, i) => W({ id: 'lw_many' + String(i).padStart(4, '0') }));
  let cur = L.normalize({ enabled: true, widgets });
  for (let i = 1; i < L.MAX_TABS; i++) cur = L.groupWidgets(cur, widgets[0].id, widgets[i].id, seq([0.1])).layers;
  assert.equal(L.boxes(cur.widgets)[0].members.length, L.MAX_TABS);
  assert.equal(L.groupWidgets(cur, widgets[0].id, widgets[L.MAX_TABS].id).error, 'too_many_tabs');
});

test('saved groups are settled: lone, anchored, other-surface and extra members leave; one active; the lead sets the box', () => {
  const g = 'lt_saved001';
  const n = L.normalize({ enabled: true, widgets: [
    W({ id: id(1), group: g, rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 }, opacity: 0.8 }),
    W({ id: id(2), group: g, active: true, rect: { x: 0.7, y: 0.7, w: 0.1, h: 0.1 } }),
    W({ id: id(3), group: g, active: true }),
    W({ id: id(4), group: g, surface: 'overlay' }),
    W({ id: id(5), group: g, surface: 'anchor', anchor: { app: 'krita.exe' } }),
    W({ id: id(6), group: 'lt_alone001' }),
    W({ id: id(7), group: 'BAD/../x' }),
  ] }).widgets;
  const by = Object.fromEntries(n.map(w => [w.id, w]));
  assert.deepEqual([1, 2, 3].map(i => by[id(i)].group), [g, g, g]);
  assert.deepEqual(by[id(2)].rect, by[id(1)].rect, 'followers take the lead rectangle');
  assert.equal(by[id(2)].opacity, 0.8);
  assert.deepEqual([1, 2, 3].map(i => !!by[id(i)].active), [false, true, false], 'one active tab');
  for (const i of [4, 5, 6, 7]) assert.equal(by[id(i)].group, undefined, id(i));
  assert.equal(L.boxes(n).length, 5);
});

test('removing a tab of two leaves a plain widget; any removal keeps groups valid', () => {
  let cur = L.normalize({ enabled: true, widgets: [W({ id: id(1) }), W({ id: id(2), widget: 'media' })] });
  cur = L.groupWidgets(cur, id(1), id(2)).layers;
  const r = L.removeWidget(cur, 'media');
  assert.equal(r.layers.widgets.length, 1);
  assert.equal(r.layers.widgets[0].group, undefined);
});

test('hidden surfaces and the overlay shortcut survive only in a known shape', () => {
  assert.deepEqual(L.normalize({ hidden: ['overlay', 'kitchen', 'overlay'] }).hidden, ['overlay']);
  assert.deepEqual(L.normalize({ hidden: 'overlay' }).hidden, []);
  assert.equal(L.normalize({ overlayKey: 'alt+shift+o' }).overlayKey, 'alt+shift+o');
  assert.equal(L.normalize({ overlayKey: 'off' }).overlayKey, 'off');
  for (const bad of ['', 'f9', 'ctrl+<script>', 42, 'a+b+c+d+e+f+g']) assert.equal(L.normalize({ overlayKey: bad }).overlayKey, L.OVERLAY_KEY, String(bad));
});

test('toggleSurface hides one surface and keeps the rest; shownFor draws nothing there', () => {
  const both = L.normalize({ enabled: true, widgets: [W({ id: id(1) }), W({ id: id(2), surface: 'overlay' })] });
  const off = L.toggleSurface(both, 'overlay');
  assert.equal(off.shown, false);
  assert.deepEqual(off.layers.hidden, ['overlay']);
  assert.equal(off.layers.enabled, true);
  assert.equal(L.surfaceShown(off.layers, 'desktop'), true);
  assert.equal(L.shownFor(off.layers, 'overlay:DISPLAY1').length, 0);
  assert.equal(L.toggleSurface(off.layers, 'overlay', 'off').layers.hidden.length, 1, 'off twice stays one entry');
  const on = L.toggleSurface(off.layers, 'overlay');
  assert.equal(on.shown, true);
  assert.deepEqual(on.layers.hidden, []);
  // Everything off, then one surface on: only that one shows.
  const alone = L.toggleSurface({ ...both, enabled: false }, 'overlay', 'on');
  assert.equal(alone.layers.enabled, true);
  assert.deepEqual(alone.layers.hidden, ['desktop', 'anchor']);
  // The whole switch clears the per-surface choices when it turns on.
  assert.deepEqual(L.toggleSurface({ ...off.layers, enabled: false }, 'all', 'on').layers.hidden, []);
  assert.equal(L.toggleSurface(both, 'all').layers.enabled, false);
  assert.equal(L.surfaceShown({ ...both, enabled: false }, 'overlay'), false);
});

test('placing on a hidden surface shows it again', () => {
  const hidden = L.normalize({ enabled: true, hidden: ['overlay'], widgets: [W({ id: id(1), surface: 'overlay' })] });
  const r = L.addWidget(hidden, { kind: 'tile', widget: 'media', surface: 'overlay', rect: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } });
  assert.deepEqual(r.layers.hidden, []);
});

test('desktops: the host tells which one is shown only while the shell says it can', () => {
  let t = 1000;
  const host = createLayersHost({ now: () => t });
  host.setDesk(2, 3);
  assert.equal(host.shownDesk(), null, 'no report yet');
  host.accept({ layers: true, desks: true, monitors: [] });
  assert.deepEqual(host.shownDesk(), { current: 2, count: 3 });
  assert.equal(host.desks(), true);
  host.accept({ layers: true, desks: 'yes', monitors: [] });
  assert.equal(host.desks(), false, 'only a real true counts');
  host.accept({ layers: false, desks: true });
  assert.equal(host.desks(), false, 'no layers, no desktops');
  host.accept({ layers: true, desks: true });
  t += REPORT_TTL_MS;
  assert.equal(host.shownDesk(), null, 'a quiet shell stops counting');
});

test('controller: the host says a pad opens the menu only with a menu to open', () => {
  let t = 1000;
  const host = createLayersHost({ now: () => t });
  assert.equal(host.pads(), false, 'no report yet');
  host.accept({ layers: true, menu: true, pad: true, monitors: [] });
  assert.equal(host.pads(), true);
  host.accept({ layers: true, menu: false, pad: true, monitors: [] });
  assert.equal(host.pads(), false, 'no menu, no chord');
  host.accept({ layers: true, menu: true, pad: 1, monitors: [] });
  assert.equal(host.pads(), false, 'only a real true counts');
  host.accept({ layers: true, menu: true, pad: true, monitors: [] });
  t += REPORT_TTL_MS;
  assert.equal(host.pads(), false, 'a quiet shell stops counting');
});

test('desktops: a page keeps a number from 1 to 9, one page per desktop, and the way back only when it makes sense', () => {
  const pages = [{ id: 'lp_aaaa0001', name: 'A' }, { id: 'lp_aaaa0002', name: 'B', desktop: 2 }, { id: 'lp_aaaa0003', name: 'C', desktop: 2 }, { id: 'lp_aaaa0004', name: 'D', desktop: 10 }];
  const n = L.normalize({ enabled: true, widgets: [], pages, page: 'lp_aaaa0002', deskBack: 'lp_aaaa0001' });
  assert.deepEqual(n.pages.map(p => p.desktop), [undefined, 2, undefined, undefined]);
  assert.equal(n.deskBack, 'lp_aaaa0001');
  assert.equal(L.normalize({ ...n, deskBack: 'lp_aaaa0002' }).deskBack, undefined, 'a tied page is never the way back');
  assert.equal(L.normalize({ ...n, page: 'lp_aaaa0001' }).deskBack, undefined, 'nor the page shown');
  assert.equal(L.normalize({ ...n, deskBack: 'lp_zzzz9999' }).deskBack, undefined, 'nor a page that is gone');
  assert.equal(L.MAX_DESKTOP, 9);
});
