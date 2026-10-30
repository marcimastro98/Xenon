// "Widgets only": the Store widgets' background frames (their Deck actions,
// webhooks and key states) run in a hidden widget host (sdk-service.html +
// js/sdk-service.js) that the driver page holds only while a widget has a
// granted Deck action (js/driver-sdk-host.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const DriverSdkHost = require('../js/driver-sdk-host.js');
const { grantedPackages } = require('../js/sdk-service.js');
const { remotePathAllowed } = require('../remote-access.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const UMD = "typeof window !== 'undefined' ? window : globalThis";

const granted = (grants, extra = {}) => ({ sdkWidgets: { enabled: true, grants }, ...extra });

test('the host is wanted only with widgets on, safe mode off and a granted Deck action', () => {
  const { wanted } = DriverSdkHost;
  assert.equal(wanted(granted({ timer: { handlers: ['start'] } })), true);
  assert.equal(wanted(granted({ timer: { handlers: [] }, clock: { badge: true } })), false, 'a badge has no bar to show in');
  assert.equal(wanted(granted({ timer: { handlers: ['start'] } }, { safeMode: true })), false);
  assert.equal(wanted({ sdkWidgets: { enabled: false, grants: { timer: { handlers: ['start'] } } } }), false);
  assert.equal(wanted(granted({ timer: null, bad: { handlers: 'start' } })), false);
  for (const junk of [null, undefined, 'x', {}, { sdkWidgets: null }, { sdkWidgets: { enabled: true } }]) {
    assert.equal(wanted(junk), false, JSON.stringify(junk));
  }
});

test('the driver adds one hidden frame, and removes it when no action is left', () => {
  const added = [];
  const doc = {
    createElement: (tag) => ({ tag, removed: false, remove() { this.removed = true; } }),
    body: { appendChild: (n) => { added.push(n); } },
  };
  const host = DriverSdkHost.create(doc);
  const on = granted({ timer: { handlers: ['start'] } });
  assert.equal(host.sync(on), true);
  host.sync(on);
  assert.equal(added.length, 1, 'one frame however often the settings arrive');
  assert.equal(added[0].tag, 'iframe');
  assert.equal(added[0].hidden, true);
  assert.equal(added[0].src, '/sdk-service');
  assert.equal(host.sync(granted({})), false);
  assert.equal(added[0].removed, true, 'its memory goes back');
  assert.equal(host.active(), false);
  host.sync(on);
  assert.equal(added.length, 2, 'and comes back when an action is granted again');
});

test('the driver page carries the host and syncs it with every settings read', () => {
  const html = read('../shell-driver.html');
  assert.ok(html.indexOf('src="js/driver-sdk-host.js"') > 0 && html.indexOf('src="js/driver-sdk-host.js"') < html.indexOf('src="js/shell-driver.js"'));
  const driver = read('../js/shell-driver.js');
  assert.match(driver, /if \(stepFor\(next\) === 'leave'\) \{ go\(MAIN_URL\); return true; \}\n\s+if \(window\.LayersShell\) window\.LayersShell\.sync\(\);\n\s+if \(sdkHost\) sdkHost\.sync\(next\);/);
});

// The host page in a vm, with custom-widget.js faked: what reaches it and when.
async function boot(settings) {
  const sources = [];
  const fetched = [];
  const calls = { refreshPackages: 0, render: 0, theme: 0, lang: 0, reload: 0, hooks: [], handlers: [], data: [] };
  const timers = [];
  const served = { settings };
  class FakeEventSource {
    constructor(url) { this.url = url; this.on = {}; sources.push(this); }
    addEventListener(name, fn) { (this.on[name] ||= []).push(fn); }
    emit(name, payload) { for (const fn of this.on[name] || []) fn({ data: JSON.stringify(payload) }); }
  }
  const json = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  const ctx = {
    console, JSON, URLSearchParams,
    SERVER: 'http://127.0.0.1:3030',
    normalizeLangCode: (v) => (['it', 'en', 'de', 'ja'].includes(v) ? v : ''),
    fetch: (url, opts) => { fetched.push({ url, opts }); return json({ settings: served.settings }); },
    fetchWithDeadline: (url) => { fetched.push({ url }); return json({ temp: 20 }); },
    EventSource: FakeEventSource,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    ThemeTokens: { derivePalette: (s, { resolve }) => ({ tone: resolve(s.appearance) }) },
    document: { documentElement: { hasAttribute: (a) => a === 'data-sdk-service' } },
  };
  ctx.window = {
    matchMedia: () => ({ matches: true }),
    location: { reload: () => { calls.reload++; } },
    CustomWidget: {
      onData: (stream, d) => calls.data.push([stream, d]),
      onHook: (d) => calls.hooks.push(d),
      onHandler: (d) => calls.handlers.push(d),
      onStoreChanged() {}, onAutoUpdated() {}, onDiscordNotification() {},
      refreshPackages: () => { calls.refreshPackages++; },
      renderWidgets: () => { calls.render++; },
      refreshTheme: () => { calls.theme++; },
      refreshLang: () => { calls.lang++; },
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext("let lang = 'en'; const i18n = { en: {}, it: {} };", ctx);
  vm.runInContext(read('../js/widget-feed.js').replace(UMD, 'globalThis'), ctx);
  vm.runInContext(read('../js/sdk-service.js').replace(UMD, 'window'), ctx);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  await settle();
  const saved = async (next) => {
    served.settings = next;
    sources[0].emit('settings', {});
    timers.splice(0).forEach((fn) => fn());
    await settle();
  };
  return { ctx, sources, fetched, calls, saved, hub: () => vm.runInContext('hubSettings', ctx) };
}

test('the host reads the settings, lists the packages once and starts the background frames', async () => {
  const b = await boot(granted({ timer: { handlers: ['start'] } }, { language: 'it', appearance: 'auto' }));
  assert.equal(b.hub().language, 'it');
  assert.equal(vm.runInContext('lang', b.ctx), 'it');
  assert.equal(b.calls.refreshPackages, 1, 'the first read lists the packages');
  assert.equal(b.calls.render, 1, 'renderWidgets starts the background frames');
  assert.equal(b.ctx.window.getEffectiveThemePalette().tone, 'dark', 'widgets get the palette in init');
  assert.equal(b.sources.length, 1);
  assert.equal(b.sources[0].url, '/sse');
});

test('Deck actions and webhooks reach the widgets here, and so does live data', async () => {
  const b = await boot(granted({ timer: { handlers: ['start'] } }));
  const es = b.sources[0];
  es.emit('sdk_handler', { pkg: 'timer', handler: 'start', callId: 'h1' });
  es.emit('sdk_hook', { pkg: 'timer', hook: 'done', data: { n: 1 } });
  es.emit('system', { cpu: 3 });
  assert.deepEqual(b.calls.handlers, [{ pkg: 'timer', handler: 'start', callId: 'h1' }]);
  assert.deepEqual(b.calls.hooks, [{ pkg: 'timer', hook: 'done', data: { n: 1 } }]);
  assert.ok(b.calls.data.some(([s, d]) => s === 'system' && d.cpu === 3));
  assert.ok(b.calls.data.some(([s]) => s === 'weather'), 'the weather is fed as on the dashboard');
  for (const f of b.fetched) assert.ok(!f.opts || !f.opts.method || f.opts.method === 'GET', 'never writes: ' + f.url);
});

test('a new grant lists the packages again; a language it lacks reloads it', async () => {
  const b = await boot(granted({ timer: { handlers: ['start'] } }));
  await b.saved(granted({ timer: { handlers: ['start', 'stop'] } }));
  assert.equal(b.calls.refreshPackages, 1, 'same packages: no new list, no reload of the frames');
  assert.equal(b.calls.render, 2);
  await b.saved(granted({ timer: { handlers: ['start'] }, notes: { handlers: ['add'] } }));
  assert.equal(b.calls.refreshPackages, 2, 'a package installed elsewhere');
  await b.saved(granted({ timer: { handlers: ['start'] } }, { language: 'ja' }));
  assert.equal(b.calls.reload, 1);
  assert.equal(grantedPackages(null), '');
  assert.equal(grantedPackages(granted({ b: {}, a: {} })), 'a\nb');
});

test('only the hidden host answers: the page, its order, the route and the phone', () => {
  const html = read('../sdk-service.html');
  assert.match(html, /<html lang="en" data-sdk-service>/);
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['shared/src/constants.js', 'js/utils.js', 'js/state.js', 'layer-i18n.js',
    'js/theme-palette.js', 'js/theme-tokens.js', 'js/native-bridge.js', 'js/deck-actions.js',
    'js/custom-widget.js', 'js/widget-feed.js', 'js/sdk-service.js']);
  assert.doesNotMatch(html, /stylesheet/);
  assert.match(read('../server.js'), /reqPath === '\/sdk-service' && req\.method === 'GET'[\s\S]{0,400}'sdk-service\.html'/);
  assert.equal(remotePathAllowed('/sdk-service', 'GET'), false, 'a phone would run every Deck action twice');
  const cw = read('../js/custom-widget.js');
  assert.match(cw, /const handlersOnly = document\.documentElement\.hasAttribute\('data-sdk-service'\);/);
  assert.match(cw, /if \(!handlersLive && \(handlersOnly \|\| \(!badgeLive && !islandLive && !miniLive && !buttonLive\)\)\) continue;/);
});
