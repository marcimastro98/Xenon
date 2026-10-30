// "Widgets only": the app's main window holds a small driver page instead of
// the dashboard (js/shell-driver.js, shell-driver.html, route `/` in server.js,
// monitor::set_driver in the shell), and the dashboard trades itself for it when
// the user switches (js/layers-shell.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const UsageMode = require('../js/usage-mode.js');
const LayersModel = require('../js/layers-model.js');
const ShellDriver = require('../js/shell-driver.js');
const { remotePathAllowed } = require('../remote-access.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const DRIVER_SRC = read('../js/shell-driver.js');
const SHELL_SRC = read('../js/layers-shell.js');
const SERVER = read('../server.js');
const HTML = read('../shell-driver.html');

test('only a strictly newer server version reloads the driver', () => {
  assert.equal(ShellDriver.isNewer('4.12.0', '4.11.13'), true);
  assert.equal(ShellDriver.isNewer('4.11.13', '4.11.13'), false);
  assert.equal(ShellDriver.isNewer('4.11.9', '4.11.13'), false, 'numeric, not text');
  assert.equal(ShellDriver.isNewer('4.12', '4.12.0'), false);
  assert.equal(ShellDriver.isNewer('', '4.12.0'), false);
});

test('the driver stays only while the mode is "widgets only"', () => {
  assert.equal(ShellDriver.stepFor({ usageMode: 'widgets' }), 'sync');
  for (const m of ['dashboard', 'both', '', undefined]) assert.equal(ShellDriver.stepFor({ usageMode: m }), 'leave');
  assert.equal(ShellDriver.stepFor(null), 'leave');
});

// Runs the driver page's script against a fake server and stream.
function bootDriver(settings) {
  const timers = [];
  const replaced = [];
  const hrefs = [];
  const posts = [];
  const listeners = {};
  const synced = [];
  const location = { replace: (u) => replaced.push(u) };
  Object.defineProperty(location, 'href', { set: (v) => hrefs.push(v), get: () => '' });
  const window = { location, UsageMode, LayersShell: { sync: () => synced.push(true) } };
  const ctx = {
    window,
    document: { documentElement: { hasAttribute: (a) => a === 'data-shell-driver' } },
    SERVER: 'http://127.0.0.1:3030',
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    fetch: async (url, opts) => {
      if (opts && opts.method === 'POST') { posts.push(url); return { ok: true }; }
      return { ok: true, json: async () => ({ settings: settings() }) };
    },
    EventSource: function EventSource() { this.addEventListener = (ev, fn) => { listeners[ev] = fn; }; },
  };
  vm.createContext(ctx);
  vm.runInContext(DRIVER_SRC, ctx);
  const tick = async () => { await new Promise((r) => setImmediate(r)); while (timers.length) timers.shift()(); await new Promise((r) => setImmediate(r)); };
  return { ctx, listeners, replaced, hrefs, posts, synced, tick };
}

test('in "widgets only" the driver syncs the widget windows and listens', async () => {
  const d = bootDriver(() => ({ usageMode: 'widgets', layers: {} }));
  await d.tick();
  assert.equal(d.synced.length, 1);
  assert.deepEqual(d.replaced, []);
  for (const ev of ['settings', 'open', 'status', 'spotlight_hotkey']) assert.equal(typeof d.listeners[ev], 'function', ev);
});

test('switching back to the dashboard sends the window to it at once', async () => {
  let mode = 'widgets';
  const d = bootDriver(() => ({ usageMode: mode }));
  await d.tick();
  mode = 'both';
  d.listeners.settings();
  await d.tick();
  assert.deepEqual(d.replaced, ['/?shell=main']);
});

test('the search shortcut is claimed and opened in the shell, like on the dashboard', async () => {
  const d = bootDriver(() => ({ usageMode: 'widgets' }));
  await d.tick();
  d.listeners.spotlight_hotkey();
  assert.deepEqual(d.posts, ['http://127.0.0.1:3030/spotlight/claimed']);
  assert.deepEqual(d.hrefs, ['xenon-app:spotlight-open']);
});

test('a newer server reloads the driver once; an older one is ignored', async () => {
  const d = bootDriver(() => ({ usageMode: 'widgets' }));
  await d.tick();
  const status = (v) => d.listeners.status({ data: JSON.stringify({ version: v }) });
  status('4.12.0');
  status('4.11.13');
  assert.deepEqual(d.replaced, []);
  status('4.12.1');
  status('4.12.2');
  assert.deepEqual(d.replaced, ['/?shell=main']);
});

// The dashboard in the app's window, when the mode becomes "widgets only".
function bootShell(search, usageMode) {
  const replaced = [];
  const location = { search, replace: (u) => replaced.push(u) };
  Object.defineProperty(location, 'href', { set: () => {}, get: () => '' });
  const window = { location, UsageMode, LayersModel, __XENON_NATIVE__: true, __XENON_NATIVE_CAPS__: { layers: true }, XenonNative: { afterLoad: () => {} } };
  const ctx = {
    window, document: { readyState: 'complete' }, hubSettings: { usageMode, layers: {} }, URLSearchParams,
    SERVER: 'http://127.0.0.1:3030', console: { warn() {} },
    setTimeout: () => 0, setInterval: () => 0, fetch: async () => ({ ok: true }),
  };
  vm.createContext(ctx);
  vm.runInContext(SHELL_SRC, ctx);
  window.LayersShell.sync();
  return replaced;
}

test('the dashboard in the app window gives way to the driver when the mode changes', () => {
  assert.deepEqual(bootShell('?shell=main', 'widgets'), ['/?shell=main']);
  assert.deepEqual(bootShell('?shell=main', 'both'), []);
  assert.deepEqual(bootShell('?shell=main&full=1', 'widgets'), [], 'the tray asked for the dashboard');
  assert.deepEqual(bootShell('', 'widgets'), [], 'a browser tab is not the app window');
});

test('route `/` redirects only the app window, only on this PC, only in "widgets only"', () => {
  const at = SERVER.indexOf("if (reqPath === '/' && req.method === 'GET') {");
  const body = SERVER.slice(at, at + 1400);
  assert.match(body, /if \(!isRemote && query\.get\('shell'\) === 'main' && query\.get\('full'\) !== '1'\n\s+&& UsageMode\.widgetsOnly\(_serverHubSettings\.usageMode\)\) \{\n\s+res\.writeHead\(302, \{ Location: '\/shell-driver'/);
  assert.match(SERVER, /reqPath === '\/shell-driver' && req\.method === 'GET'/);
  assert.equal(remotePathAllowed('/shell-driver', 'GET'), false, 'a phone has nothing to drive');
});

test('the driver page carries only what it needs, in order', () => {
  const scripts = [...HTML.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, [
    'shared/src/constants.js', 'js/utils.js', 'js/state.js', 'js/layer-tiles.js', 'js/layers-model.js', 'js/usage-mode.js',
    'js/native-bridge.js', 'js/screen-scene-model.js', 'js/layers-shell.js', 'js/dashboard-open.js', 'js/update.js', 'js/album-theme.js',
    'js/driver-album-lights.js', 'js/driver-sdk-host.js', 'js/driver-perf.js', 'js/shell-driver.js',
  ]);
  assert.doesNotMatch(HTML, /stylesheet/);
});

test('without a dashboard the wake word is armed only when the alerts window can answer it', () => {
  const fn = SERVER.slice(SERVER.indexOf('function wakeWordWanted() {'), SERVER.indexOf('function _sttInputArgs('));
  assert.match(fn, /if \(UsageMode\.widgetsOnly\(_serverHubSettings && _serverHubSettings\.usageMode\)\) \{\n\s+const n = _serverHubSettings\.notifications;\n\s+if \(n && n\.onScreen === false\) return false;/);
  const alerts = SERVER.slice(SERVER.indexOf('async function updateScreenAlertsSetting('), SERVER.indexOf('async function updateUsageModeSetting('));
  assert.match(alerts, /refreshWakeWordWatch\(\);/);
  assert.match(SERVER, /return saved\.usageMode;/);
  assert.match(SERVER, /refreshWakeWordWatch\(\);\n\s+return saved\.usageMode;/);
});

test('the shell hides the window for the driver URL and the splash marks its window', () => {
  const monitor = read('../../apps/native/src-tauri/src/monitor.rs');
  const lib = read('../../apps/native/src-tauri/src/lib.rs');
  const splash = read('../../apps/native/splash/index.html');
  assert.match(monitor, /pub const DRIVER_PATH: &str = "\/shell-driver";/);
  assert.match(monitor, /if DRIVER\.load\(Ordering::SeqCst\) \{\n\s+return Target::Nothing\(NoScreen::Phone\);/);
  assert.match(monitor, /cache\.mode == Placement::Phone \|\| DRIVER\.load\(Ordering::SeqCst\)/);
  assert.match(lib, /if monitor::set_driver\(&win, _payload\.url\(\)\.path\(\) == monitor::DRIVER_PATH\) \{/);
  assert.match(splash, /var DASHBOARD = 'http:\/\/127\.0\.0\.1:' \+ port \+ '\/\?shell=main';/);
});
