// The desktop scene (scene.html + js/screen-scene.js + js/scene-feed.js): the
// Ambient scene as the animated wallpaper behind the desktop icons or as the
// PC's screensaver, one shell window per screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const scenePage = require('../scene-page.js');
const ScreenSceneModel = require('../js/screen-scene-model.js');
const ViewerTheme = require('../js/viewer-theme.js');
const { resolveAmbientScene } = require('../js/ambient-resolve.js');
const { remotePathAllowed } = require('../remote-access.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// ── The page ─────────────────────────────────────────────────────
test('the page carries the three scene overlays from index.html, and only the scene files', () => {
  const html = scenePage.compose(read('../scene.html'), read('../index.html'));
  for (const id of ['lockscreen-overlay', 'ambient-scene-overlay', 'ambient-scene-frame-host', 'ambient-canvas-overlay', 'ambient-canvas-stage']) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  assert.ok(!html.includes(scenePage.SCENE_MARK));
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  // Order matters: the model and the resolver before the page script, the
  // renderers before the feed that fills their globals.
  const before = (a, b) => assert.ok(scripts.indexOf(a) >= 0 && scripts.indexOf(a) < scripts.indexOf(b), a + ' before ' + b);
  before('js/state.js', 'js/lockscreen.js');
  before('js/viewer-theme.js', 'js/screen-scene.js');
  before('js/ambient-resolve.js', 'js/screen-scene.js');
  before('js/screen-scene-model.js', 'js/screen-scene.js');
  before('js/scene-feed.js', 'js/screen-scene.js');
  before('js/scene-frame-rate.js', 'js/screen-scene.js');
  before('js/ambient-scene.js', 'js/ambient-canvas.js');
  assert.equal(scripts.at(-1), 'js/screen-scene.js');
  // Never the dashboard's idle logic: it would open and close scenes itself.
  for (const no of ['js/ambient-mode.js', 'js/ambient-idle.js', 'js/settings.js', 'js/main.js', 'js/i18n.js']) {
    assert.ok(!scripts.includes(no), no);
  }
  for (const s of scripts) assert.ok(s === 'layer-i18n.js' || s.startsWith('js/') || s.startsWith('shared/'), s);
});

test('a missing overlay is left out, and a "$" in the markup stays as written', () => {
  const dash = '<div class="x" id="lockscreen-overlay" hidden><span>$& $1</span></div>';
  const out = scenePage.compose('<body>\n<!-- scene markup -->\n</body>', dash);
  assert.ok(out.includes('<span>$& $1</span>'));
  assert.ok(!out.includes('ambient-canvas-overlay'));
  assert.equal(scenePage.compose('<!-- scene markup -->', ''), '');
});

test('the route serves it uncached on this PC only', () => {
  assert.match(read('../server.js'), /reqPath === '\/scene' && req\.method === 'GET'[\s\S]{0,600}'scene\.html'[\s\S]{0,300}'no-store'[\s\S]{0,80}scenePage\.compose/);
  assert.equal(remotePathAllowed('/scene', 'GET'), false);
});

test('nothing on the scene is a control: exits hidden, no lock button reachable', () => {
  const css = read('../components/ScreenScene/ScreenScene.css');
  assert.match(css, /\[data-desktop-scene\] \.lockscreen-exit \{ display: none !important; \}/);
  assert.match(css, /\.lockscreen-overlay \*,\n\[data-desktop-scene\] \.ambient-canvas-overlay \* \{ pointer-events: none !important; \}/);
  assert.match(css, /html\[data-scene="saver"\] \* \{ cursor: none !important; \}/);
  assert.match(read('../scene.html'), /<html lang="en" data-desktop-scene>/);
});

// ── The feed (js/scene-feed.js) ─────────────────────────────────
function feedBox() {
  const timers = new Map();
  let seq = 0;
  const fetched = [];
  const answers = {
    '/events': { events: [{ id: 'e1' }] },
    '/tasks': { tasks: [{ id: 't1' }] },
    '/notes/list': { activeId: 'n1', notes: [{ id: 'n1' }], rev: 3 },
    '/network': { down: 5 },
  };
  const ctx = {
    console, JSON, Set, Map, Array, Object, Date,
    SERVER: 'http://127.0.0.1:3030',
    document: { hidden: false },
    hubSettings: {},
    fetchWithDeadline: (url) => {
      const p = url.replace('http://127.0.0.1:3030', '');
      fetched.push(p);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(answers[p]) });
    },
    WidgetFeed: { weatherDelay: () => 900000 },
    DriverAlbumLights: require('../js/driver-album-lights.js'),
    setTimeout: (fn, ms) => { seq += 1; timers.set(seq, { fn, ms }); return seq; },
    clearTimeout: (id) => { timers.delete(id); },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(`
    let calendarEvents = [], tasksData = [], notesState = { v: 1, activeId: '', notes: [] };
    let lastNetworkData = null, lastSystemData = null, mediaData = null, audioData = null, speakerMuted = false;
    let weatherFetches = 0;
    function fetchWeather() { weatherFetches += 1; return Promise.resolve(); }
  `, ctx);
  vm.runInContext(read('../js/scene-feed.js') + '\nglobalThis.SceneFeed = SceneFeed;', ctx);
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const g = (name) => vm.runInContext(name, ctx);
  return { ctx, timers, fetched, settle, g, feed: ctx.SceneFeed };
}

class FakeEventSource {
  constructor(url) { this.url = url; this.on = {}; FakeEventSource.made.push(this); }
  addEventListener(name, fn) { (this.on[name] ||= []).push(fn); }
  emit(name, payload) { for (const fn of this.on[name] || []) fn({ data: payload === undefined ? '' : JSON.stringify(payload) }); }
}
FakeEventSource.made = [];

test('the feed reads only what the scene draws, and stops what it no longer draws', async () => {
  const b = feedBox();
  b.feed.want(new Set(['weather', 'calendar', 'bogus']));
  await b.settle();
  assert.equal(b.g('weatherFetches'), 1);
  assert.deepEqual(b.fetched, ['/events']);
  assert.equal(b.g('calendarEvents')[0].id, 'e1');
  const repeating = [...b.timers.values()].map((t) => t.ms).sort((x, y) => x - y);
  assert.deepEqual(repeating, [600000, 900000], 'the calendar every 10 min, the weather on the dashboard cadence');
  b.feed.want(new Set(['notes']));
  await b.settle();
  assert.equal(b.timers.size, 0, 'weather and calendar timers gone');
  assert.equal(b.g('notesState').activeId, 'n1');
  assert.equal(b.g('notesState').notes.length, 1);
  b.feed.want(['notes']);
  await b.settle();
  assert.equal(b.fetched.filter((p) => p === '/notes/list').length, 1, 'kept: not read again');
});

test('the network is read every 3 s while the page shows, never when hidden', async () => {
  const b = feedBox();
  b.feed.want(['network']);
  await b.settle();
  assert.equal(b.g('lastNetworkData').down, 5);
  b.ctx.document.hidden = true;
  const [id, t] = [...b.timers.entries()][0];
  assert.equal(t.ms, 3000);
  b.timers.delete(id);
  await t.fn();
  await b.settle();
  assert.equal(b.fetched.filter((p) => p === '/network').length, 1);
});

test('the stream keeps media (with its cover), system and audio; tasks and notes only when drawn', async () => {
  const b = feedBox();
  FakeEventSource.made = [];
  const es = new FakeEventSource('/sse');
  b.feed.listen(es);
  es.emit('media', { active: true, title: 'A', artist: 'B', thumbnail: 'data:image/png;base64,AAA' });
  es.emit('media', { active: true, title: 'A', artist: 'B' });
  assert.equal(b.g('mediaData').thumbnail, 'data:image/png;base64,AAA', 'the cover stays while the track is the same');
  es.emit('media', { active: true, title: 'C', artist: 'B' });
  assert.ok(!b.g('mediaData').thumbnail, 'a new track drops the old cover');
  es.emit('system', { cpu: 4 });
  es.emit('audio', { speaker: { muted: true } });
  assert.equal(b.g('lastSystemData').cpu, 4);
  assert.equal(b.g('speakerMuted'), true);
  es.emit('tasks', { tasks: [{ id: 'x' }] });
  es.emit('notes', { activeId: 'z', notes: [] });
  assert.equal(b.g('tasksData').length, 0, 'not drawn: not kept');
  assert.equal(b.g('notesState').activeId, '');
  b.feed.want(['tasks']);
  await b.settle();
  es.emit('tasks', { tasks: [{ id: 'x' }, { id: 'y' }] });
  assert.equal(b.g('tasksData').length, 2);
  es.emit('media', 'not json');
  es.on.system[0]({ data: '{bad' });
  assert.equal(b.g('lastSystemData').cpu, 4, 'a broken payload keeps the last reading');
});

test('a reconnect reads again, the first open does not', async () => {
  const b = feedBox();
  const es = new FakeEventSource('/sse');
  b.feed.listen(es);
  b.feed.want(['calendar']);
  await b.settle();
  es.emit('open');
  await b.settle();
  assert.equal(b.fetched.length, 1);
  es.emit('open');
  await b.settle();
  assert.equal(b.fetched.length, 2);
});

// ── The page script (js/screen-scene.js) ────────────────────────
function el(id) {
  return {
    id, hidden: true, children: [], attrs: {},
    classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    get firstChild() { return this.children[0] || null; },
    replaceChildren(...n) { this.children = n; },
    setAttribute(k, v) { this.attrs[k] = v; },
  };
}

async function sceneBox({ key, settings, packages = [], granted = true, shell = true, battery = null }) {
  const calls = { lock: 0, lockClose: 0, lockRefresh: 0, canvas: [], canvasUnmount: 0, frames: [], unregister: 0, want: [], refresh: [], nav: [], translate: 0, reload: 0, listen: 0 };
  const listeners = {};
  const intervals = [];
  const timers = [];
  let now = 1_000_000;
  const served = { settings };
  const els = Object.fromEntries(['ambient-scene-overlay', 'ambient-scene-frame-host'].map((id) => [id, el(id)]));
  const docListeners = {};
  const ctx = {
    console, JSON, Set, Map, Array, Object, Math, Promise, URLSearchParams,
    Date: { now: () => now },
    SERVER: 'http://127.0.0.1:3030',
    ScreenSceneModel, ViewerTheme, resolveAmbientScene,
    ThemeTokens: {
      applySkin: () => 'glass', derivePalette: (s, { resolve }) => ({ tone: resolve(s.appearance) }),
      applyPalette() {}, applyMaterial() {}, applyFont() {},
    },
    fetch: (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(url.endsWith('/settings') ? { settings: served.settings } : { osDark: true }) }),
    normalizeLangCode: (v) => (['it', 'en', 'ja'].includes(v) ? v : ''),
    translateStatic: () => { calls.translate += 1; },
    openWidgetLockScreen: () => { calls.lock += 1; },
    closeWidgetLockScreen: () => { calls.lockClose += 1; },
    refreshLockScreen: () => { calls.lockRefresh += 1; },
    SceneFeed: {
      want: (names) => calls.want.push([...names].sort()),
      refresh: (names) => calls.refresh.push(names),
      listen: () => { calls.listen += 1; },
    },
    WidgetFeed: { listen() {} },
    AmbientCanvas: { mount: (scene) => { calls.canvas.push(scene); return true; }, unmount: () => { calls.canvasUnmount += 1; } },
    XenonNative: { afterLoad: (fn) => fn() },
    EventSource: FakeEventSource,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    navigator: battery ? { getBattery: () => Promise.resolve(battery) } : {},
    document: {
      documentElement: { dataset: {}, lang: '' },
      getElementById: (id) => els[id] || null,
      createElement: (tag) => Object.assign(el(''), { tag }),
      addEventListener: (n, fn) => { docListeners[n] = fn; },
    },
  };
  const location = { search: '?key=' + encodeURIComponent(key), reload: () => { calls.reload += 1; } };
  Object.defineProperty(location, 'href', { set: (v) => calls.nav.push(v), get: () => '' });
  ctx.window = {
    location,
    __XENON_LAYER_SHELL__: shell,
    matchMedia: () => ({ matches: false }),
    addEventListener: (n, fn) => { (listeners[n] ||= []).push(fn); },
    CustomWidget: {
      getPackages: () => Promise.resolve({ packages }),
      packageGranted: () => granted,
      assetBase: (id) => '/sdk/widget/' + id + '/',
      registerAmbientFrame: (id, frame) => calls.frames.push({ id, frame }),
      unregisterAmbientFrame: () => { calls.unregister += 1; },
      refreshTheme() {}, refreshLang() {},
    },
  };
  ctx.window.ScreenSceneModel = ScreenSceneModel;
  ctx.CustomWidget = ctx.window.CustomWidget;
  ctx.window.AmbientCanvas = ctx.AmbientCanvas;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext("let lang = 'en'; const i18n = { en: {}, it: {} }; let mediaData = null;", ctx);
  vm.runInContext(read('../js/screen-scene.js'), ctx);
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  await settle();
  const fire = (name, e = {}) => { for (const fn of listeners[name] || []) fn(e); };
  const saved = async (next) => {
    served.settings = next;
    FakeEventSource.made.at(-1).emit('settings', {});
    timers.splice(0).forEach((fn) => fn());
    await settle();
  };
  return { ctx, calls, els, fire, settle, saved, intervals, advance: (ms) => { now += ms; }, ds: ctx.document.documentElement.dataset, hub: () => vm.runInContext('hubSettings', ctx) };
}

const canvasScene = { id: 'c1', name: 'Mine', components: [{ type: 'clock' }, { type: 'agenda' }, { type: 'network' }] };

test('a key the shell never sends shows nothing', async () => {
  for (const key of ['', 'saver:', 'other:1', 'wallpaper:\u0001']) {
    FakeEventSource.made = [];
    const b = await sceneBox({ key, settings: {} });
    assert.equal(b.calls.lock, 0, key);
    assert.equal(FakeEventSource.made.length, 0, key);
  }
});

test('the built-in scene is the lock screen, fed only what its widgets show', async () => {
  const b = await sceneBox({ key: 'wallpaper:\\\\.\\DISPLAY1', settings: { lockWidgets: { calendar: false } } });
  assert.equal(b.calls.lock, 1);
  assert.equal(b.ds.scene, 'wallpaper');
  assert.equal(b.ds.sceneShown, 'builtin');
  assert.deepEqual(b.calls.want.at(-1), ['weather']);
  assert.equal(b.calls.listen, 1);
  assert.equal(FakeEventSource.made.at(-1).url, '/sse');
  // A save that does not change the scene does not remount it.
  const closed = b.calls.lockClose;
  await b.saved({ lockWidgets: { calendar: true }, accent: '#fff' });
  assert.equal(b.calls.lock, 1);
  assert.equal(b.calls.lockClose, closed);
  assert.deepEqual(b.calls.want.at(-1), ['calendar', 'weather']);
  assert.ok(b.calls.lockRefresh >= 1, 'the toggles show at once');
});

test('a canvas scene mounts, remounts only when it changes, and asks for its readings', async () => {
  const settings = { ambientMode: { sceneId: 'canvas:c1' }, ambientScenes: [canvasScene] };
  const b = await sceneBox({ key: 'saver:M1', settings });
  assert.equal(b.calls.canvas.length, 1);
  assert.equal(b.calls.lock, 0);
  assert.equal(b.ds.sceneShown, 'canvas');
  assert.deepEqual(b.calls.want.at(-1), ['calendar', 'network']);
  await b.saved(JSON.parse(JSON.stringify(settings)));
  assert.equal(b.calls.canvas.length, 1, 'same scene: left alone');
  const edited = { ...settings, ambientScenes: [{ ...canvasScene, components: [{ type: 'weather' }] }] };
  await b.saved(edited);
  assert.equal(b.calls.canvas.length, 2);
  assert.equal(b.calls.canvasUnmount >= 1, true);
  await b.saved({ ambientMode: { sceneId: 'builtin' } });
  assert.equal(b.calls.lock, 1);
});

test('a Store scene runs in the same sandbox as on the dashboard; an ungranted one never prompts', async () => {
  const pkg = { id: 'aurora', name: 'Aurora', version: '1.0.0', entry: 'index.html', surface: 'ambient' };
  const settings = { ambientMode: { sceneId: 'aurora' }, sdkWidgets: { enabled: true } };
  const b = await sceneBox({ key: 'wallpaper:M1', settings, packages: [pkg] });
  assert.equal(b.calls.frames.length, 1);
  const frame = b.calls.frames[0].frame;
  assert.equal(frame.attrs.sandbox, 'allow-scripts');
  assert.equal(frame.attrs.referrerpolicy, 'no-referrer');
  assert.equal(frame.src, '/sdk/widget/aurora/index.html');
  assert.equal(b.els['ambient-scene-overlay'].hidden, false);
  assert.ok(b.els['ambient-scene-overlay'].classList.contains('dismiss-armed'));
  assert.deepEqual(b.calls.want.at(-1), ['weather']);
  await b.saved({ ambientMode: { sceneId: 'builtin' } });
  assert.equal(b.calls.unregister, 1);
  assert.equal(b.els['ambient-scene-overlay'].hidden, true);

  const ungranted = await sceneBox({ key: 'wallpaper:M1', settings, packages: [pkg], granted: false });
  assert.equal(ungranted.calls.frames.length, 0);
  assert.equal(ungranted.calls.lock, 1);
  const suspended = await sceneBox({ key: 'wallpaper:M1', settings: { ...settings, sdkWidgets: { enabled: true, suspended: ['aurora'] } }, packages: [pkg] });
  assert.equal(suspended.calls.frames.length, 0);
  const safe = await sceneBox({ key: 'wallpaper:M1', settings: { ...settings, safeMode: true }, packages: [pkg] });
  assert.equal(safe.calls.frames.length, 0);
});

test('the screensaver ends once on input after the grace, never on a still mouse', async () => {
  const b = await sceneBox({ key: 'saver:M1', settings: {} });
  b.fire('keydown');
  assert.equal(b.calls.nav.length, 0, 'inside the grace: the window just appeared');
  b.advance(1500);
  b.fire('pointermove', { screenX: 100, screenY: 100 });
  b.fire('pointermove', { screenX: 110, screenY: 105 });
  assert.equal(b.calls.nav.length, 0, 'a twitch is not someone back');
  b.fire('pointermove', { screenX: 140, screenY: 100 });
  assert.deepEqual(b.calls.nav, ['xenon-app:saver-done']);
  b.fire('pointerdown');
  b.fire('wheel');
  assert.equal(b.calls.nav.length, 1, 'once');
  assert.equal(b.ds.sceneDone, '1');
});

test('outside the shell (a browser tab) the screensaver never navigates', async () => {
  const b = await sceneBox({ key: 'saver:M1', settings: {}, shell: false });
  b.advance(5000);
  b.fire('keydown');
  assert.equal(b.calls.nav.length, 0);
  assert.equal(b.ds.sceneDone, '1');
});

test('the wallpaper rests on battery and wakes on the charger; it never listens to input', async () => {
  const battery = { charging: false, on: {}, addEventListener(n, fn) { this.on[n] = fn; } };
  const b = await sceneBox({ key: 'wallpaper:M1', settings: {}, battery });
  assert.deepEqual(b.calls.nav, ['xenon-app:scene-pause?on=1']);
  battery.charging = true;
  battery.on.chargingchange();
  battery.on.chargingchange();
  assert.deepEqual(b.calls.nav, ['xenon-app:scene-pause?on=1', 'xenon-app:scene-pause?on=0']);
  b.advance(5000);
  b.fire('keydown');
  assert.equal(b.calls.nav.length, 2);
  const desk = await sceneBox({ key: 'wallpaper:M1', settings: {}, battery: { charging: true, addEventListener() {} } });
  assert.deepEqual(desk.calls.nav, ['xenon-app:scene-pause?on=0']);
});

test('the language and weather follow the settings; a language not served reloads', async () => {
  const b = await sceneBox({ key: 'wallpaper:M1', settings: { language: 'en' } });
  const translated = b.calls.translate;
  await b.saved({ language: 'it' });
  assert.equal(vm.runInContext('lang', b.ctx), 'it');
  assert.ok(b.calls.translate > translated);
  assert.deepEqual([...b.calls.refresh.at(-1)], ['weather']);
  const n = b.calls.refresh.length;
  await b.saved({ language: 'it', accent: '#000' });
  assert.equal(b.calls.refresh.length, n, 'no weather read for an unrelated save');
  await b.saved({ language: 'it', weather: { mode: 'manual', city: 'Roma' } });
  assert.equal(b.calls.refresh.length, n + 1);
  await b.saved({ language: 'ja' });
  assert.equal(b.calls.reload, 1);
  assert.equal(b.intervals.length, 1, 'one OS theme poll');
});

// ── The shared viewer theme and the network reading ─────────────
test('the viewer theme follows the OS scheme only on auto', async () => {
  let osDark = true;
  const applied = [];
  const theme = ViewerTheme.create({
    server: 'S', doc: { documentElement: {} },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ osDark }) }),
    matchMedia: () => ({ matches: false }),
    tokens: {
      applySkin: () => 'glass', derivePalette: (s, { resolve }) => ({ tone: resolve(s.appearance) }),
      applyPalette: (_root, p) => applied.push(p.tone), applyMaterial() {}, applyFont() {},
    },
  });
  assert.equal(theme.apply({ appearance: 'auto' }).tone, 'light', 'the media query until the server answers');
  assert.equal(await theme.readOs(), true);
  assert.equal(theme.palette().tone, 'dark');
  assert.equal(await theme.readOs(), false, 'unchanged: nothing applied');
  theme.apply({ appearance: 'light' });
  osDark = false;
  assert.equal(await theme.readOs(), false, 'a fixed appearance never asks');
  assert.deepEqual(applied, ['light', 'dark', 'light']);
});

test('the dashboard keeps the last network reading for the canvas Network element', () => {
  assert.match(read('../js/state.js'), /^let lastNetworkData = null;$/m);
  assert.match(read('../js/network.js'), /function applyNetwork\(data\) \{\n\s+lastNetworkData = data;/);
});

test('the canvas Network element writes the rate and its unit, never an object', () => {
  const src = read('../js/ambient-canvas.js');
  const body = src.slice(src.indexOf('    network: {'), src.indexOf('    notifications: {'));
  const fmtSrc = /const fmt = (\(bps\) => \{[\s\S]*?\n {8}\});/.exec(body)[1];
  const ctx = { formatBandwidth: (bps) => ({ value: (bps * 8 / 1e6).toFixed(1), unit: 'Mbps' }), Number };
  vm.createContext(ctx);
  const fmt = vm.runInContext('(' + fmtSrc + ')', ctx);
  assert.equal(fmt(1250000), '10.0 Mbps');
  assert.equal(fmt(undefined), '--');
});
