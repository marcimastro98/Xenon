// The main dashboard driving the shell's layer windows (js/layers-shell.js):
// what it sends, when it stays quiet, and the report that keeps the `layers`
// probe honest. The shell side is unit-tested in apps/native (layers/spec.rs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const LayersModel = require('../js/layers-model.js');
const UsageMode = require('../js/usage-mode.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/layers-shell.js');
const BRIDGE = read('../js/native-bridge.js');
const AFTER_LOAD_AT = BRIDGE.indexOf('function afterLoad(');
const AFTER_LOAD = BRIDGE.slice(AFTER_LOAD_AT, BRIDGE.indexOf('\n  }\n', AFTER_LOAD_AT) + 4);

const W = (over = {}) => ({ id: 'lw_aaaa0001', kind: 'tile', widget: 'weather', surface: 'desktop', rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 }, ...over });

function boot({ search = '', native = true, caps = { layers: true, displays: [{ id: '\\\\.\\DISPLAY1', primary: true }, { id: '\\\\.\\DISPLAY2' }] }, layers, readyState = 'complete', driver = false, settings = {} } = {}) {
  const timers = [];
  const intervals = [];
  const signals = [];
  const posts = [];
  const location = { search };
  Object.defineProperty(location, 'href', { set: (v) => signals.push(v), get: () => '' });
  // A `load` listener is never called: in the shell another signal may have
  // cancelled the event, and the sync must not depend on it.
  const window = { location, __XENON_NATIVE__: native, __XENON_NATIVE_CAPS__: caps, LayersModel, UsageMode, addEventListener() {} };
  const stateListeners = [];
  const document = {
    readyState,
    documentElement: { hasAttribute: (name) => driver && name === 'data-shell-driver' },
    addEventListener: (type, fn) => { if (type === 'readystatechange') stateListeners.push(fn); },
    removeEventListener: (type, fn) => { const i = stateListeners.indexOf(fn); if (i >= 0) stateListeners.splice(i, 1); },
  };
  const ctx = {
    window,
    document,
    hubSettings: { layers, ...settings },
    SERVER: 'http://127.0.0.1:3030',
    URLSearchParams,
    console: { warn() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    fetch: async (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { ok: true }; },
  };
  vm.createContext(ctx);
  window.XenonNative = { afterLoad: vm.runInContext(`(${AFTER_LOAD})`, ctx) };
  vm.runInContext(SRC, ctx);
  const flush = () => { while (timers.length) timers.shift()(); };
  const finishLoading = () => { document.readyState = 'complete'; for (const fn of stateListeners.slice()) fn(); };
  const sent = () => signals.map((s) => {
    assert.match(s, /^xenon-app:layers-sync\?d=/);
    return JSON.parse(decodeURIComponent(s.slice('xenon-app:layers-sync?d='.length)));
  });
  return { shell: window.LayersShell, ctx, flush, finishLoading, sent, signals, posts, intervals };
}

test('one window per layer per monitor, and one per anchored widget', () => {
  const { shell } = boot();
  const spec = shell.specFor({ enabled: true, excludeFromCapture: false, widgets: [
    W(), W({ id: 'lw_aaaa0002', widget: 'media' }),
    W({ id: 'lw_aaaa0003', widget: 'clock', surface: 'overlay', monitor: '\\\\.\\DISPLAY2' }),
    W({ id: 'lw_aaaa0004', widget: 'notes', surface: 'anchor', anchor: { app: 'EXCEL.EXE', corner: 'br' } }),
  ] });
  assert.equal(spec.exclude, false);
  assert.deepEqual(spec.surfaces.map((s) => [s.key, s.kind]), [
    ['desktop:', 'desktop'], ['overlay:\\\\.\\DISPLAY2', 'overlay'], ['anchor:lw_aaaa0004', 'anchor'],
  ]);
  assert.equal(spec.surfaces[2].anchor.app, 'EXCEL.EXE');
  assert.equal(spec.surfaces[1].monitor, '\\\\.\\DISPLAY2');
});

test('"widgets only": the driver page opens the alerts window first, unless the user turned it off', () => {
  const layers = { enabled: true, widgets: [W()] };
  const keys = (b) => { b.ctx.window.LayersShell.sync(); b.flush(); return b.sent().at(-1).surfaces.map((s) => [s.key, s.kind]); };
  assert.deepEqual(keys(boot({ driver: true, layers, settings: { usageMode: 'widgets' } })),
    [['alerts:', 'overlay'], ['desktop:', 'desktop']]);
  // No widgets placed: the alerts window still opens.
  assert.deepEqual(keys(boot({ driver: true, layers: { enabled: false, widgets: [] }, settings: { usageMode: 'widgets' } })),
    [['alerts:', 'overlay']]);
  assert.deepEqual(keys(boot({ driver: true, layers, settings: { usageMode: 'widgets', notifications: { onScreen: false } } })),
    [['desktop:', 'desktop']]);
  // The dashboard shows its own pop-ups, also when opened from the tray in "widgets only".
  assert.deepEqual(keys(boot({ layers, settings: { usageMode: 'both' } })), [['desktop:', 'desktop']]);
  assert.deepEqual(keys(boot({ search: '?shell=main&full=1', layers, settings: { usageMode: 'widgets' } })), [['desktop:', 'desktop']]);
});

test('the alerts window is never pushed out by a full set of widgets', () => {
  const widgets = Array.from({ length: 24 }, (_, i) => W({ id: 'lw_b' + String(i).padStart(7, '0'), surface: 'anchor', anchor: { app: 'a.exe' } }));
  const spec = boot().shell.specFor({ enabled: true, widgets }, { alerts: true });
  assert.equal(spec.surfaces[0].key, 'alerts:');
  assert.equal(spec.surfaces.length, 25);
});

test('switched off, there is nothing to open', () => {
  const { shell } = boot();
  assert.deepEqual(shell.specFor({ enabled: false, widgets: [W()] }).surfaces, []);
});

test('a browser, an older shell or a layer page never sends a shell signal', () => {
  const layers = { enabled: true, widgets: [W()] };
  for (const opts of [{ native: false }, { caps: {} }, { search: '?layer=desktop:' }]) {
    const b = boot({ ...opts, layers });
    b.shell.sync();
    b.flush();
    assert.equal(b.signals.length, 0, JSON.stringify(opts));
    assert.equal(b.posts.length, 0, 'no report either');
    assert.equal(b.intervals.length, 0, 'and no timer');
  }
});

test('a shell that cannot draw layers never reports that it can, even on a screen push', () => {
  const b = boot({ caps: { layers: false, layersWhy: 'wayland', displays: [{ id: 'screen', primary: true }] }, layers: { enabled: true, widgets: [W()] } });
  b.shell.onDisplays();
  b.ctx.window.__XENON_NATIVE_CAPS__.displays = [{ id: 'screen2', primary: true }];
  b.shell.onDisplays();
  b.flush();
  assert.equal(b.posts.length, 0);
  assert.equal(b.signals.length, 0);
});

test('nothing placed, nothing sent: a launch without layers costs no signal', () => {
  const b = boot({ layers: { enabled: false, widgets: [] } });
  b.shell.sync();
  b.flush();
  assert.equal(b.signals.length, 0);
});

test('a change is sent once, a repeat is not, and switching off closes the windows', () => {
  const b = boot({ layers: { enabled: true, widgets: [W()] } });
  b.shell.sync();
  b.shell.sync();
  b.flush();
  assert.equal(b.signals.length, 1, 'two calls in a row coalesce');
  assert.equal(b.sent()[0].surfaces[0].key, 'desktop:');
  b.shell.sync();
  b.flush();
  assert.equal(b.signals.length, 1, 'unchanged: no signal');
  b.ctx.hubSettings.layers = { enabled: false, widgets: [W()] };
  b.shell.sync();
  b.flush();
  assert.deepEqual(b.sent()[1].surfaces, [], 'an empty list closes every layer window');
});

test('a page still loading waits for it to end, even when its load event never comes', async () => {
  const b = boot({ layers: { enabled: true, widgets: [W()] }, readyState: 'interactive' });
  b.shell.sync();
  b.shell.sync();
  b.flush();
  assert.deepEqual(b.signals, [], 'a signal now would cancel the load');
  assert.equal(b.posts.length, 0);
  b.finishLoading();
  b.flush();
  b.flush();
  assert.equal(b.sent().length, 1, 'one sync, however many asked while loading');
  assert.equal(b.sent()[0].surfaces[0].key, 'desktop:');
  await Promise.resolve();
  assert.equal(b.posts.length, 1, 'the shell reports it can draw layers');
});

test('a monitor change re-sends the same layers, so the windows move with the screens', () => {
  const b = boot({ layers: { enabled: true, widgets: [W()] } });
  b.shell.sync();
  b.flush();
  b.shell.onDisplays();
  b.flush();
  assert.equal(b.signals.length, 2);
});

test('a display push with the same screens sends nothing: the shell pushes after every load', async () => {
  // Each signal is a navigation the shell cancels, and the shell used to push
  // the display state when one completed: answering every push looped ~3 times
  // a second.
  const caps = { layers: true, displays: [{ id: '\\\\.\\DISPLAY1', primary: true }], display: { active: '\\\\.\\DISPLAY1' } };
  const b = boot({ caps, layers: { enabled: true, widgets: [W()] } });
  await Promise.resolve();
  const reports = b.posts.length;
  b.shell.onDisplays();
  b.flush();
  assert.equal(b.signals.length, 1);
  for (let i = 0; i < 5; i++) { b.shell.onDisplays(); b.flush(); }
  assert.equal(b.signals.length, 1, 'same screens: no signal');
  assert.equal(b.posts.length, reports + 1, 'and no report');
  caps.displays = [...caps.displays, { id: '\\\\.\\DISPLAY2' }];
  b.shell.onDisplays();
  b.flush();
  assert.equal(b.signals.length, 2, 'a screen added: re-sent');
  caps.display = { active: '\\\\.\\DISPLAY2' };
  b.shell.onDisplays();
  b.flush();
  assert.equal(b.signals.length, 3, 'the dashboard moved: re-sent');
});

test('the report names the screens the shell sees, and repeats with a self-healing sync', async () => {
  const b = boot({ layers: { enabled: true, widgets: [W()] } });
  await Promise.resolve();
  assert.equal(b.posts.length, 1);
  assert.equal(b.posts[0].url, 'http://127.0.0.1:3030/layers/host');
  assert.deepEqual(b.posts[0].body, { layers: true, scene: false, draw: false, menu: false, anchor: false, desks: false, pad: false, monitors: [{ key: '\\\\.\\DISPLAY1', primary: true }, { key: '\\\\.\\DISPLAY2', primary: false }] });
  b.shell.sync();
  b.flush();
  b.intervals[0]();
  b.flush();
  assert.equal(b.posts.length, 2);
  assert.equal(b.signals.length, 2, 'the periodic pass re-sends even when nothing changed');
});

test('the report says when the shell can follow an app, and only a real true counts', async () => {
  const yes = boot({ caps: { layers: true, anchor: true, displays: [{ id: 'D1', primary: true }] }, layers: { enabled: true, widgets: [W()] } });
  const odd = boot({ caps: { layers: true, anchor: 'yes', displays: [{ id: 'D1', primary: true }] }, layers: { enabled: true, widgets: [W()] } });
  await Promise.resolve();
  assert.equal(yes.posts[0].body.anchor, true);
  assert.equal(odd.posts[0].body.anchor, false);
});

test('wiring: the main page syncs at the end of every layout apply, after layer-host', () => {
  const d = read('../js/dashboard-layout.js');
  assert.match(d, /step\('layerHost', \(\) => window\.LayerHost\.place\(\)\);\n  else if \(window\.LayersShell\) step\('layersShell', \(\) => window\.LayersShell\.sync\(\)\);/);
  assert.match(read('../js/native-bridge.js'), /function onDisplaysChanged\(\) \{\n    \/\/ [^\n]*\n    if \(window\.LayersShell\) window\.LayersShell\.onDisplays\(\);/);
  const html = read('../index.html');
  assert.ok(html.indexOf('src="js/layers-model.js"') < html.indexOf('src="js/layers-shell.js"'));
  assert.ok(html.indexOf('src="js/layer-host.js"') < html.indexOf('src="js/layers-shell.js"'));
});

// The Ambient scene on the other screens (js/screen-scene-model.js).
const ScreenSceneModel = require('../js/screen-scene-model.js');
const SCENE_CAPS = { layers: true, scene: true, display: { active: 'D1' }, displays: [{ id: 'D1', primary: true }, { id: 'D2' }] };
function bootScene(opts) {
  const b = boot({ caps: SCENE_CAPS, ...opts });
  b.ctx.window.ScreenSceneModel = ScreenSceneModel;
  const keys = () => { b.flush(); const all = b.sent(); return all.length ? all.at(-1).surfaces.map((s) => [s.key, s.kind]) : null; };
  return { ...b, keys };
}

test('the wallpaper opens on the screen without the dashboard, after the widgets', () => {
  const b = bootScene({ layers: { enabled: true, widgets: [W()] }, settings: { ambientMode: { wallpaper: true } } });
  b.shell.sync();
  assert.deepEqual(b.keys(), [['desktop:', 'desktop'], ['wallpaper:D2', 'wallpaper']]);
});

test('the screensaver follows the idle time from the status, and a game closes both', () => {
  const b = bootScene({ settings: { ambientMode: { wallpaper: true, saverMinutes: 5 } } });
  b.shell.sync();
  assert.deepEqual(b.keys(), [['wallpaper:D2', 'wallpaper']]);
  b.shell.onStatus({ gaming: false, idleSec: 120 });
  assert.equal(b.sent().length, 1, 'idle time moving inside the same state sends nothing');
  b.shell.onStatus({ gaming: false, idleSec: 300 });
  assert.deepEqual(b.keys(), [['wallpaper:D2', 'wallpaper'], ['saver:D2', 'saver']]);
  b.shell.onStatus({ muted: true });
  assert.equal(b.sent().length, 2, 'a partial status changes nothing');
  b.shell.onStatus({ gaming: true, idleSec: 900 });
  assert.deepEqual(b.keys(), []);
});

test('a shell without the scene windows gets none', () => {
  const b = boot({ settings: { ambientMode: { wallpaper: true } } });
  b.ctx.window.ScreenSceneModel = ScreenSceneModel;
  b.shell.sync(); b.flush();
  assert.deepEqual(b.sent(), []);
});

test('the driver puts the scene on every screen', () => {
  const b = bootScene({ driver: true, settings: { usageMode: 'widgets', notifications: { onScreen: false }, ambientMode: { wallpaper: true } } });
  b.shell.sync();
  assert.deepEqual(b.keys(), [['wallpaper:D1', 'wallpaper'], ['wallpaper:D2', 'wallpaper']]);
});

test('wiring: the dashboard and the driver pass every status on, and load the model first', () => {
  assert.match(read('../js/main.js'), /window\.LayersShell\.onStatus\(data\)/);
  assert.match(read('../js/shell-driver.js'), /window\.LayersShell\.onStatus\(d\)/);
  for (const page of ['../index.html', '../shell-driver.html']) {
    const html = read(page);
    assert.ok(html.indexOf('js/screen-scene-model.js') > 0 && html.indexOf('js/screen-scene-model.js') < html.indexOf('js/layers-shell.js'), page);
  }
  assert.match(read('../server.js'), /a\.enabled !== false && Number\(a\.saverMinutes\) > 0\) return true;/);
});

test('drawing on the screen opens the sheet first, only where the shell draws it, and closes it after', () => {
  const caps = { layers: true, draw: true, displays: [{ id: '\\\\.\\DISPLAY1', primary: true }] };
  const b = boot({ caps, layers: { enabled: false, widgets: [] } });
  b.shell.onDraw({ drawing: true });
  b.flush();
  assert.deepEqual(b.sent().at(-1).surfaces, [{ key: 'draw:', kind: 'draw', monitor: '' }]);
  b.shell.onDraw({ drawing: true });
  b.flush();
  assert.equal(b.signals.length, 1, 'the same state twice is one signal');
  b.shell.onDraw({ drawing: false });
  b.flush();
  assert.deepEqual(b.sent().at(-1).surfaces, []);
  // With widgets and the alerts window, the sheet still goes first.
  const w = boot({ caps, driver: true, layers: { enabled: true, widgets: [W()] }, settings: { usageMode: 'widgets' } });
  w.shell.onDraw({ drawing: true });
  w.flush();
  assert.deepEqual(w.sent().at(-1).surfaces.map((s) => s.key), ['draw:', 'alerts:', 'desktop:']);
  // Windows draws with the capture engine: its shell never says `draw`.
  const win = boot({ layers: { enabled: false, widgets: [] } });
  win.shell.onDraw({ drawing: true });
  win.flush();
  assert.equal(win.signals.length, 0);
});

test('the report tells the server whether the shell can open the drawing sheet', async () => {
  const yes = boot({ caps: { layers: true, draw: true, displays: [] } });
  const no = boot();
  for (const b of [yes, no]) { b.flush(); await new Promise((r) => setImmediate(r)); }
  assert.equal(yes.posts.find((p) => p.url.endsWith('/layers/host')).body.draw, true);
  assert.equal(no.posts.find((p) => p.url.endsWith('/layers/host')).body.draw, false);
});

test('desktops: the shell watches them only when a page is tied to one, even with nothing shown', () => {
  const pages = [{ id: 'lp_aaaa0001', name: 'Work' }, { id: 'lp_aaaa0002', name: 'Play', desktop: 2 }];
  const caps = { layers: true, desks: true, displays: [{ id: 'D1', primary: true }] };
  const tied = boot({ caps, layers: { enabled: true, widgets: [], pages, page: 'lp_aaaa0001' } });
  tied.shell.sync();
  tied.flush();
  assert.equal(tied.sent()[0].desks, true, 'no widget on the shown page, but the desktop still has to be watched');
  const untied = boot({ caps, layers: { enabled: true, widgets: [W()], pages: [pages[0]], page: 'lp_aaaa0001' } });
  untied.shell.sync();
  untied.flush();
  assert.equal(untied.sent()[0].desks, undefined);
  const noShell = boot({ caps: { ...caps, desks: false }, layers: { enabled: true, widgets: [W()], pages, page: 'lp_aaaa0001' } });
  noShell.shell.sync();
  noShell.flush();
  assert.equal(noShell.sent()[0].desks, undefined, 'a shell that cannot tell is never asked');
});

test('controller: the shell reads it only where it can and the menu can open, unless turned off', () => {
  const caps = { layers: true, menu: true, pad: true, displays: [{ id: 'D1', primary: true }] };
  const on = boot({ caps, layers: { enabled: false, widgets: [] } });
  on.shell.sync();
  on.flush();
  assert.equal(on.sent()[0].pad, true, 'no widget anywhere, but the chord still has to open the menu');
  const off = boot({ caps, layers: { enabled: true, widgets: [W()], menuPad: false } });
  off.shell.sync();
  off.flush();
  assert.equal(off.sent()[0].pad, undefined);
  const noMenu = boot({ caps: { ...caps, menu: false }, layers: { enabled: true, widgets: [W()] } });
  noMenu.shell.sync();
  noMenu.flush();
  assert.equal(noMenu.sent()[0].pad, undefined, 'no menu to open, nothing to read');
});

test('desktops: a change goes to the server once, bad values never, and the report repeats it', async () => {
  const b = boot({ caps: { layers: true, desks: true, displays: [{ id: 'D1', primary: true }] }, layers: { enabled: true, widgets: [W()] } });
  await Promise.resolve();
  assert.equal(b.posts[0].body.desks, true);
  await b.shell.onDesk({ current: 2, count: 3 });
  await b.shell.onDesk({ current: 2, count: 3 });
  await b.shell.onDesk({ current: -1, count: 3 });
  await b.shell.onDesk({ current: 'x', count: 3 });
  const desk = b.posts.filter((p) => p.url.endsWith('/layers/desk'));
  assert.deepEqual(desk.map((p) => p.body), [{ current: 2, count: 3 }]);
  b.intervals[0]();
  await Promise.resolve();
  assert.equal(b.posts.filter((p) => p.url.endsWith('/layers/desk')).length, 2, 'a restarted server hears it again');
});

test("Bit's vitals popup opens the alerts window with the dashboard up, only while it shows", async () => {
  const caps = { layers: true, displays: [{ id: '\\.\DISPLAY1', primary: true }] };
  const b = boot({ caps, layers: { enabled: false, widgets: [] } });
  b.shell.onVitalsPopup({ text: 'stand up', until: Date.now() - 1 });
  b.flush();
  assert.equal(b.signals.length, 0, 'a popup already over opens nothing');
  b.shell.onVitalsPopup({ text: 'stand up', until: Date.now() + 40 });
  b.flush();
  assert.deepEqual(b.sent().at(-1).surfaces, [{ key: 'alerts:', kind: 'overlay', monitor: '' }]);
  await new Promise((r) => setTimeout(r, 60));
  b.shell.sync();
  b.flush();
  assert.deepEqual(b.sent().at(-1).surfaces, [], 'the window closes once the popup is over');
  // A shell that cannot draw layers never opens it.
  const none = boot({ caps: { layers: false }, layers: { enabled: false, widgets: [] } });
  none.shell.onVitalsPopup({ text: 'x', until: Date.now() + 5000 });
  none.flush();
  assert.equal(none.signals.length, 0);
});

test('wiring: the dashboard and the driver pass the vitals popup on, and the alerts window shows it', () => {
  assert.match(read('../js/main.js'), /addEventListener\('vitals_nag'[\s\S]{0,160}LayersShell\.onVitalsPopup/);
  assert.match(read('../js/shell-driver.js'), /addEventListener\('vitals_nag', onVitalsNag\)/);
  const alerts = read('../js/screen-alerts.js');
  assert.match(alerts, /ALWAYS = Object\.freeze\(\{ vitals_nag: vitalsPopup \}\)/);
  assert.match(alerts, /if \(!always && !routine\(\)\) return;/);
  assert.match(read('../screen-alerts.html'), /js\/usage-mode\.js[\s\S]*js\/screen-alerts\.js/);
});
