// The light layer page (layer-lite.html + js/layer-lite.js): a layer window whose
// surface holds Store widgets only. It must hand widgets the same live data the
// dashboard does, wear the same theme, never write anything, and leave hooks,
// Deck handlers and background frames to the dashboard (two copies would run
// them twice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/layer-lite.js');
const FEED = read('../js/widget-feed.js');
const TILES = read('../js/layer-lite-tiles.js');
const TABLE = read('../js/layer-tiles.js');
const MAIN = read('../js/main.js');

async function boot(settings, { active = true, weatherTile = false } = {}) {
  const { document } = makeDom();
  const sources = [];
  const fetched = [];
  const data = [];
  const calls = { place: 0, render: 0, theme: 0, lang: 0, skin: [], reload: 0 };
  const timers = [];
  const served = { settings };
  class FakeEventSource {
    constructor(url) { this.url = url; this.on = {}; sources.push(this); }
    addEventListener(name, fn) { (this.on[name] ||= []).push(fn); }
    emit(name, payload) { for (const fn of this.on[name] || []) fn({ data: JSON.stringify(payload) }); }
  }
  const json = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  const ctx = {
    document,
    console,
    URLSearchParams,
    JSON,
    SERVER: 'http://127.0.0.1:3030',
    normalizeLangCode: (v) => (['it', 'en', 'de', 'ja'].includes(v) ? v : ''),
    fetch: (url, opts) => { fetched.push({ url, opts }); return url.endsWith('/settings') ? json({ settings: served.settings }) : json({ osDark: true }); },
    fetchWithDeadline: (url) => { fetched.push({ url }); return json({ ok: true, temp: 20 }); },
    EventSource: FakeEventSource,
    setTimeout: (fn) => { timers.push(fn); return 0; },
    clearTimeout() {},
    setInterval: () => 0,
    ThemeTokens: {
      applySkin: (...args) => { calls.skin.push(args[1].styleMode); return {}; },
      derivePalette: (s, { resolve }) => ({ tone: resolve(s.appearance) }),
      applyPalette() {},
      applyMaterial() {},
      applyFont: (doc, font) => { calls.font = font; },
    },
  };
  ctx.window = {
    matchMedia: () => ({ matches: false }),
    location: { reload: () => { calls.reload++; } },
    LayerHost: { active, place: () => { calls.place++; }, listen: (es) => { calls.listened = es; } },
    CustomWidget: {
      onData: (stream, d) => data.push([stream, d]),
      onDiscordNotification: (d) => data.push(['discordNotification', d]),
      onStoreChanged: (d) => data.push(['store', d]),
      onAutoUpdated: (d) => data.push(['autoUpdated', d]),
      onHook: () => assert.fail('hooks belong to the dashboard'),
      onHandler: () => assert.fail('Deck handlers belong to the dashboard'),
      renderWidgets: () => { calls.render++; },
      refreshTheme: () => { calls.theme++; },
      refreshLang: () => { calls.lang++; },
    },
  };
  if (weatherTile) {
    // What system.js brings along on a page served with the weather tile.
    ctx.renderWeatherTile = () => { calls.weatherRender = (calls.weatherRender || 0) + 1; };
    ctx.fetchWeather = () => { calls.weatherFetch = (calls.weatherFetch || 0) + 1; };
  }
  vm.createContext(ctx);
  vm.runInContext("let lang = 'en'; const i18n = { en: {}, it: {}, de: {} };", ctx);
  vm.runInContext(FEED.replace("typeof window !== 'undefined' ? window : globalThis", 'globalThis'), ctx);
  vm.runInContext(TABLE.replace("typeof window !== 'undefined' ? window : globalThis", 'globalThis'), ctx);
  vm.runInContext(TILES, ctx);
  vm.runInContext(SRC, ctx);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  // Another surface saved: the page reads the settings again (coalesced timer).
  const saved = async (next) => {
    served.settings = next;
    sources[0].emit('settings', {});
    timers.splice(0).forEach((fn) => fn());
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  return { ctx, document, sources, fetched, data, calls, saved, hub: () => vm.runInContext('hubSettings', ctx) };
}

test('it reads the settings, wears the theme and the language, then places the widgets', async () => {
  const b = await boot({ language: 'de', appearance: 'dark', styleMode: 'retro', weather: { mode: 'auto' } });
  assert.equal(b.hub().language, 'de');
  assert.equal(vm.runInContext('lang', b.ctx), 'de');
  assert.deepEqual(b.calls.skin, ['retro']);
  assert.equal(b.ctx.window.getEffectiveThemePalette().tone, 'dark', 'widgets read the same palette the page wears');
  assert.equal(b.calls.place, 1);
  assert.equal(b.calls.lang, 1, 'widgets hear the language change');
  assert.equal(b.sources.length, 1);
  assert.equal(b.sources[0].url, '/sse');
  assert.equal(b.calls.listened, b.sources[0], 'the host hears edit mode on the same stream');
});

test('nothing is ever written: GET only, and no browser storage', async () => {
  const b = await boot({ appearance: 'auto', weather: { mode: 'manual', city: 'Roma' } });
  for (const f of b.fetched) assert.ok(!f.opts || !f.opts.method || f.opts.method === 'GET', f.url);
  assert.doesNotMatch(SRC, /localStorage|sessionStorage|saveHubSettings|method:\s*'(POST|PUT|DELETE)'/);
  assert.ok(b.fetched.some((f) => f.url.includes('/weather?') && f.url.includes('city=Roma')), 'the weather follows the chosen city');
  assert.ok(b.fetched.some((f) => f.url.endsWith('/system/theme')), "'auto' asks the server for the OS scheme");
});

test('a language this page was not served with reloads it; one it has is applied in place', async () => {
  const b = await boot({ language: 'de' });
  await b.saved({ language: 'it' });
  assert.equal(b.calls.reload, 0);
  assert.equal(vm.runInContext('lang', b.ctx), 'it');
  await b.saved({ language: 'ja' });
  assert.equal(b.calls.reload, 1, 'ja was not in /layer-i18n.js');
});

test('a page without a valid layer key does nothing', async () => {
  const b = await boot({}, { active: false });
  assert.equal(b.fetched.length, 0);
  assert.equal(b.sources.length, 0);
});

test('live data reaches widgets in the same shape the dashboard sends', async () => {
  const b = await boot({});
  assert.deepEqual(b.data.splice(0), [['weather', { ok: true, temp: 20 }]], 'the weather starts with the first settings');
  const es = b.sources[0];
  es.emit('system', { cpu: 5 });
  es.emit('script_states', { states: { a: 1 } });
  es.emit('audiolevels', { peaks: { spk: 0.4 } });
  es.emit('audiolevels', { problem: 'helper-old', minVersion: '2.1' });
  es.emit('codex', { tile: 'private', sdk: { used: 3 } });
  es.emit('codex', { tile: 'private' });
  es.emit('discord_notification', { n: 1 });
  es.emit('sdk_store', { pkg: 'k' });
  es.emit('widget_auto_updated', { id: 'k' });
  assert.deepEqual(JSON.parse(JSON.stringify(b.data)), [
    ['system', { cpu: 5 }],
    ['scriptStates', { states: { a: 1 } }],
    ['audioLevels', { spk: 0.4 }],
    ['audioLevels', { peaks: {}, problem: 'helper-old', minVersion: '2.1' }],
    ['codex', { used: 3 }],
    ['discordNotification', { n: 1 }],
    ['store', { pkg: 'k' }],
    ['autoUpdated', { id: 'k' }],
  ]);
  assert.equal(es.on.sdk_hook, undefined);
  assert.equal(es.on.sdk_handler, undefined);
});

test('"show when gaming" follows full status payloads only', async () => {
  const b = await boot({});
  const es = b.sources[0];
  es.emit('status', { gaming: true });
  assert.ok(b.document.body.classList.contains('game-running'));
  es.emit('status', { muted: true });
  assert.ok(b.document.body.classList.contains('game-running'), 'a partial payload is not "game ended"');
  es.emit('status', { gaming: false, gameRunning: false });
  assert.ok(!b.document.body.classList.contains('game-running'));
});

// Every stream main.js relays to widgets must be relayed here too, or a widget
// works on the dashboard and goes blank in a layer window.
test('every stream the dashboard relays to widgets is relayed here', () => {
  const dashboard = new Set([...MAIN.matchAll(/CustomWidget\.onData\('([A-Za-z]+)'/g)].map((m) => m[1]));
  const lite = new Set([...FEED.matchAll(/:\s*'([A-Za-z]+)'/g)].map((m) => m[1]));
  for (const m of (FEED + SRC).matchAll(/onData\('([A-Za-z]+)'/g)) lite.add(m[1]);
  const missing = [...dashboard].filter((s) => !lite.has(s));
  assert.deepEqual(missing, [], 'add these to PLAIN_STREAMS or SHAPED_STREAMS in js/widget-feed.js');
  for (const fn of ['onDiscordNotification', 'onStoreChanged', 'onAutoUpdated']) {
    assert.match(MAIN, new RegExp('CustomWidget\\.' + fn));
    assert.match(FEED, new RegExp('cw\\.' + fn));
  }
});

test('the page loads only what a Store widget needs, in order', () => {
  const html = read('../layer-lite.html');
  assert.match(html, /<html lang="en" data-layer-lite>/);
  const order = ['shared/src/constants.js', 'js/utils.js', 'js/state.js', 'layer-i18n.js', 'js/theme-palette.js',
    'js/theme-tokens.js', 'js/layer-tiles.js', 'js/layers-model.js', 'js/native-bridge.js', 'js/custom-widget.js', 'js/widget-feed.js', 'js/layer-pin.js', 'js/layer-host.js', 'js/layer-lite-tiles.js', 'js/tile-play.js', 'js/layer-lite.js'];
  const at = order.map((src) => html.indexOf('src="' + src + '"'));
  assert.ok(at.every((i) => i > 0), 'a script is missing');
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'scripts out of order');
  assert.equal((html.match(/<script /g) || []).length, order.length, 'nothing else is loaded');
  assert.match(html, /href="components\/LayerHost\/LayerHost\.css"/);
  assert.match(html, /href="components\/CustomWidget\/CustomWidget\.css"/);
});

test('a layer window never runs background frames: the dashboard already does', () => {
  const cw = read('../js/custom-widget.js');
  const fn = cw.slice(cw.indexOf('function syncServiceFrames() {'));
  assert.match(fn.slice(0, 900), /const layerSurface = !!\(window\.LayerHost && window\.LayerHost\.active\);\n[\s\S]{0,300}\n    if \(sdk\(\)\.enabled === true && !layerSurface\) \{/);
});

test('served with the weather tile, it builds that tile and runs its fetch; without it, neither', async () => {
  const withTile = await boot({ language: 'en' }, { weatherTile: true });
  const tile = vm.runInContext("createCopyAtom('weather')", withTile.ctx);
  assert.equal(tile.dataset.dashboardWidget, 'weather');
  assert.equal(tile.dataset.dashboardInstance, undefined, 'the primary tile, not a copy');
  assert.equal(tile.children[0].className, 'weather-widget-mount');
  assert.equal(withTile.calls.weatherFetch, 1, "the tile's own fetch: it draws and relays");
  assert.ok(withTile.calls.weatherRender >= 1, 'drawn as the settings land');
  assert.equal(withTile.fetched.filter((f) => String(f.url).includes('/weather')).length, 0, 'never fetched twice');

  const font = await boot({ language: 'en', uiFont: { url: '/uploads/f.woff2' } });
  assert.deepEqual(font.calls.font, { url: '/uploads/f.woff2' }, "the user's font, as on the dashboard");

  const bare = await boot({ language: 'en' });
  assert.equal(vm.runInContext("createCopyAtom('weather')", bare.ctx), null);
  assert.equal(vm.runInContext("createCopyAtom('system')", bare.ctx), null);
  assert.equal(bare.fetched.filter((f) => String(f.url).includes('/weather')).length, 1, 'widgets still get the weather');
});
