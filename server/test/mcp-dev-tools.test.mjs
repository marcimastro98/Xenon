// What the xenon-mcp tools do on the server (server/mcp/mcp-dev-tools.js), with
// fake deps standing in for server.js, plus the real package validator for
// the starter widget and the screen box maths for screenshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadServerSettingsSlice, serverDashboardWidgets } from './server-settings-slice.mjs';

const require = createRequire(import.meta.url);
const T = require('../mcp/mcp-dev-tools.js');
const sdk = require('../sdk-widgets.js');

function deps(over = {}) {
  const calls = [];
  const base = {
    appVersion: '9.9.9',
    sdkApiVersion: 1,
    sdkEnabled: () => true,
    dashboardOpen: () => true,
    getSdkReference: async (s) => ({ ok: true, section: s }),
    validateWidgetPayload: (p) => sdk.validateWidgetPayload(p),
    critiqueWidget: () => ({ critique: { notes: [] }, code: 'XW1-abc' }),
    scanWidgetSource: () => [],
    isInstalled: async () => false,
    isOwn: () => true,
    install: async (p) => { calls.push(['install', p.id]); return { ok: true, id: p.id, name: 'Clock', streams: ['system'] }; },
    place: async (id) => { calls.push(['place', id]); return true; },
    ask: async () => null,
    captureRect: async () => ({ ok: true, data: 'BASE64', width: 300, height: 200 }),
    listOwn: async () => [{ id: 'clock' }],
    readPayload: async (id) => ({ id, files: [{ path: 'manifest.json', data: '' }] }),
  };
  return { d: { ...base, ...over }, calls };
}

const starter = () => T.templateFiles({ name: 'My clock', size: 'wide' });

test('the starter widget passes Xenon\'s own package check', () => {
  const v = sdk.validateWidgetPayload({ id: 'my-clock', files: starter() });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.manifest.name, 'My clock');
  assert.equal(v.manifest.size, 'wide');
  const js = Buffer.from(starter().find((f) => f.path === 'main.js').data, 'base64').toString('utf8');
  assert.ok(js.includes('textContent'));
  assert.ok(!js.includes('innerHTML'));
});

// Found on the real run: the starter failed its own check_widget with "no
// color-scheme declared", so every first widget began with
// a fix item the person never wrote.
test('the starter widget has nothing to fix in the design check, and follows the theme', () => {
  const P = require('../ai/ai-presets.js');
  const presetDeps = { normalizeSettings: loadServerSettingsSlice(), dashboardWidgets: serverDashboardWidgets(), sdkEnabled: true, appVersion: '9.9.9' };
  const checked = P.critiqueWidget('my-clock', starter(), presetDeps);
  assert.ok(checked, 'the starter builds as a widget share');
  assert.equal(checked.critique.fix, 0, JSON.stringify(checked.critique.findings));
  const css = Buffer.from(starter().find((f) => f.path === 'style.css').data, 'base64').toString('utf8');
  const js = Buffer.from(starter().find((f) => f.path === 'main.js').data, 'base64').toString('utf8');
  assert.match(css, /:root \{ color-scheme: dark;/);
  assert.match(js, /m\.type === 'init' \|\| m\.type === 'theme'/);
  assert.match(js, /colorScheme = theme\.appearance === 'light' \? 'light' : 'dark'/);
});

test('unknown op and status', async () => {
  const { d } = deps();
  assert.equal((await T.runOp('rm -rf', {}, d)).error, 'unknown_op');
  assert.equal((await T.runOp('__proto__', {}, d)).error, 'unknown_op');
  const s = await T.runOp('status', null, d);
  assert.equal(s.xenon, '9.9.9');
  assert.equal(s.mcpApi, T.MCP_API);
  assert.equal(s.widgetsOn, true);
});

test('widget_template: refuses a bad id, defaults the size', async () => {
  const { d } = deps();
  assert.equal((await T.runOp('widget_template', { id: '../x' }, d)).error, 'bad_id');
  const r = await T.runOp('widget_template', { id: 'gpu-temp', size: 'giant' }, d);
  assert.equal(r.ok, true);
  const m = JSON.parse(Buffer.from(r.files[0].data, 'base64').toString('utf8'));
  assert.equal(m.size, 'medium');
  assert.equal(m.name, 'gpu-temp');
});

// A widget for an AIO pump's screen: the starter says so and stays inside the circle,
// and check_widget gives back the shapes the app kept with the rules for them.
test('widget_template and check_widget: a widget made for a pump screen', async () => {
  const { d } = deps();
  const r = await T.runOp('widget_template', { id: 'pump-cpu', pump: true }, d);
  const file = (p) => Buffer.from(r.files.find((f) => f.path === p).data, 'base64').toString('utf8');
  assert.equal(JSON.parse(file('manifest.json')).pump, true);
  assert.match(file('style.css'), /flex-direction: column;[^}]*padding: 15cqmin;/, 'stacked, inside the circle');
  const plain = await T.runOp('widget_template', { id: 'tile-cpu' }, d);
  assert.equal(JSON.parse(Buffer.from(plain.files[0].data, 'base64').toString('utf8')).pump, undefined);
  const checked = await T.runOp('check_widget', { id: 'pump-cpu', files: r.files }, d);
  assert.deepEqual(checked.pump, ['round', 'square']);
  assert.match(checked.pumpHint, /inside the circle/);
  const tile = await T.runOp('check_widget', { id: 'tile-cpu', files: plain.files }, d);
  assert.deepEqual(tile.pump, []);
  assert.equal(tile.pumpHint, undefined);
});

test('check_widget: package errors come back with a hint, good ones with permissions', async () => {
  const { d } = deps();
  const bad = await T.runOp('check_widget', { id: 'clock', files: [] }, d);
  assert.equal(bad.ok, false);
  assert.ok(bad.hint);
  const good = await T.runOp('check_widget', { id: 'clock', files: starter() }, d);
  assert.equal(good.ok, true);
  assert.deepEqual(good.permissions.streams, ['system']);
  assert.deepEqual(good.critique, { notes: [] });
});

// An option the app drops never reaches the Xenon menu: the author learns
// which one here, instead of looking for it there.
test('check_widget: says which Xenon menu options are kept, which dropped, and fit', async () => {
  const { d } = deps();
  const files = starter();
  const m = JSON.parse(Buffer.from(files[0].data, 'base64').toString('utf8'));
  m.options = [
    { id: 'compact', kind: 'toggle', label: 'Compact', default: false },
    { id: 'Bad id', kind: 'toggle', label: 'Bad' },
    { id: 'look', kind: 'select', label: 'Look', choices: [{ value: 'a', label: 'A' }] },
  ];
  m.fit = true;
  files[0] = { path: 'manifest.json', data: Buffer.from(JSON.stringify(m)).toString('base64') };
  const r = await T.runOp('check_widget', { id: 'clock', files }, d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.menu, { options: ['compact'], dropped: ['Bad id', 'look'], fit: true });
  assert.match(r.menuHint, /options/);
  const plain = await T.runOp('check_widget', { id: 'clock', files: starter() }, d);
  assert.deepEqual(plain.menu, { options: [], dropped: [], fit: false });
  assert.equal(plain.menuHint, undefined);
});

test('install_widget: installs as the person\'s own and places it', async () => {
  const { d, calls } = deps();
  const r = await T.runOp('install_widget', { id: 'clock', files: starter() }, d);
  assert.equal(r.ok, true);
  assert.equal(r.onDashboard, true);
  assert.deepEqual(calls, [['install', 'clock'], ['place', 'clock']]);
});

test('install_widget: widgets off, bad id, someone else\'s widget, no dashboard', async () => {
  assert.equal((await T.runOp('install_widget', { id: 'clock', files: [] }, deps({ sdkEnabled: () => false }).d)).error, 'widgets_off');
  assert.equal((await T.runOp('install_widget', { id: 'A B', files: [] }, deps().d)).error, 'bad_id');
  const store = deps({ isInstalled: async () => true, isOwn: () => false });
  assert.equal((await T.runOp('install_widget', { id: 'clock', files: starter() }, store.d)).error, 'not_yours');
  assert.deepEqual(store.calls, [], 'nothing written over a Store widget');
  const alone = await T.runOp('install_widget', { id: 'clock', files: starter() }, deps({ place: async () => false }).d);
  assert.equal(alone.onDashboard, false);
  assert.match(alone.note, /No dashboard/);
  assert.equal((await T.runOp('install_widget', { id: 'clock', files: [] }, deps({ install: async () => ({ ok: false, error: 'bad_files' }) }).d)).error, 'bad_files');
});

test('widget_issues: what the dashboard saw', async () => {
  assert.equal((await T.runOp('widget_issues', { id: 'clock' }, deps().d)).error, 'not_installed');
  const none = deps({ isInstalled: async () => true });
  assert.equal((await T.runOp('widget_issues', { id: 'clock' }, none.d)).error, 'no_dashboard');
  const seen = deps({ isInstalled: async () => true, ask: async () => ({ found: true, onScreen: true, approved: false, blocked: [{ kind: 'inline-script' }], errors: [], perf: null }) });
  const r = await T.runOp('widget_issues', { id: 'clock' }, seen.d);
  assert.equal(r.onScreen, true);
  // Found on the real run: a tile on another page still has perf stats, so the
  // dashboard knows it, but it is not on screen.
  const elsewhere = deps({ isInstalled: async () => true, ask: async () => ({ found: true, onScreen: false, approved: true, blocked: [], errors: [], perf: { level: 'light' } }) });
  assert.equal((await T.runOp('widget_issues', { id: 'clock' }, elsewhere.d)).onScreen, false);
  assert.equal(r.approved, false);
  assert.deepEqual(r.blocked, [{ kind: 'inline-script' }]);
  assert.equal(r.fit, null, 'no look yet');
  const cut = { width: 300, height: 300, items: [{ kind: 'past', by: 'tile', side: 'right', px: 12, sel: 'div.day', nth: 7, of: 7, count: 1 }] };
  const cutSeen = deps({ isInstalled: async () => true, ask: async () => ({ found: true, onScreen: true, approved: true, blocked: [], errors: [], perf: null, fit: cut }) });
  assert.deepEqual((await T.runOp('widget_issues', { id: 'clock' }, cutSeen.d)).fit, cut, 'what the tile cuts off reaches the assistant');
});

test('widget_shot: needs the tile on screen, returns a jpeg', async () => {
  const off = deps({ isInstalled: async () => true, ask: async () => ({ found: false, rect: null }) });
  assert.equal((await T.runOp('widget_shot', { id: 'clock' }, off.d)).error, 'not_on_screen');
  const on = deps({ isInstalled: async () => true, ask: async () => ({ found: true, rect: { left: 0, top: 0, width: 300, height: 200, screenX: 0, screenY: 0 }, dpr: 1 }) });
  const r = await T.runOp('widget_shot', { id: 'clock' }, on.d);
  assert.deepEqual(r.image, { mimeType: 'image/jpeg', data: 'BASE64' });
  const broke = deps({ isInstalled: async () => true, ask: async () => ({ found: true, rect: {} }), captureRect: async () => ({ ok: false, error: 'capture_failed' }) });
  assert.equal((await T.runOp('widget_shot', { id: 'clock' }, broke.d)).error, 'capture_failed');
});

// The capture (mcp/dev-capture.js) reads the screen box with screenRect, which wants the whole answer: given only
// the box it found no rect and every widget_screenshot came back "not_on_screen".
test('widget_shot: the capture gets what screenRect reads, scale included', async () => {
  const where = { found: true, rect: { left: 10, top: 20, width: 300, height: 200, screenX: 100, screenY: 50 }, dpr: 2 };
  let rect = null;
  const on = deps({ isInstalled: async () => true, ask: async () => where, captureRect: async (w) => { rect = T.screenRect('win32', w); return { ok: true, data: 'B', width: 1, height: 1 }; } });
  assert.equal((await T.runOp('widget_shot', { id: 'clock' }, on.d)).ok, true);
  assert.deepEqual(rect, { x: 220, y: 140, width: 600, height: 400 });
});

test('my_widgets and share_widget: own work only', async () => {
  const { d } = deps();
  assert.deepEqual((await T.runOp('my_widgets', {}, d)).widgets, [{ id: 'clock' }]);
  assert.equal((await T.runOp('my_widgets', { id: 'clock' }, d)).files.length, 1);
  const store = deps({ isOwn: () => false });
  assert.equal((await T.runOp('my_widgets', { id: 'clock' }, store.d)).error, 'not_yours_or_missing');
  assert.equal((await T.runOp('share_widget', { id: 'clock' }, store.d)).error, 'not_yours_or_missing');
  const share = await T.runOp('share_widget', { id: 'clock' }, d);
  assert.equal(share.code, 'XW1-abc');
  assert.equal((await T.runOp('share_widget', { id: 'clock' }, deps({ critiqueWidget: () => null }).d)).error, 'not_shareable');
  assert.equal((await T.runOp('share_widget', { id: 'clock' }, deps({ readPayload: async () => null }).d)).error, 'not_found');
});

test('screenRect: device pixels on Windows and Linux, points on macOS', () => {
  const where = { rect: { left: 100, top: 50, width: 300, height: 200, screenX: 1920, screenY: 0 }, dpr: 1.5 };
  assert.deepEqual(T.screenRect('win32', where), { x: 3030, y: 75, width: 450, height: 300 });
  assert.deepEqual(T.screenRect('linux', where), { x: 3030, y: 75, width: 450, height: 300 });
  assert.deepEqual(T.screenRect('darwin', where), { x: 2020, y: 50, width: 300, height: 200 });
  assert.equal(T.screenRect('win32', { rect: { ...where.rect, width: 4 } }), null, 'too small');
  assert.equal(T.screenRect('win32', { rect: { ...where.rect, height: 9000 } }), null, 'too big');
  assert.equal(T.screenRect('win32', { rect: { ...where.rect, left: 'x' } }), null);
  assert.equal(T.screenRect('win32', null), null);
  assert.equal(T.screenRect('win32', { ...where, dpr: 99 }).width, 1200, 'dpr clamped to 4');
});

// A starter that is a whole pump screen's style: the manifest says so, and main.js draws
// the line placement.line names and moves the ring, once per change, never past 1 a second.
test('widget_template pumpStyle: a style that draws each line and moves the ring', async () => {
  const vm = await import('node:vm');
  const { d } = deps();
  const r = await T.runOp('widget_template', { id: 'neon-dial', pumpStyle: true }, d);
  const file = (p) => Buffer.from(r.files.find((f) => f.path === p).data, 'base64').toString('utf8');
  const m = JSON.parse(file('manifest.json'));
  assert.equal(m.pump, true);
  assert.equal(m.pumpStyle, true);
  assert.deepEqual(m.streams, ['system', 'media']);
  assert.match(file('style.css'), /padding: 15cqmin;/, 'inside the circle');
  const checked = await T.runOp('check_widget', { id: 'neon-dial', files: r.files }, d);
  assert.equal(checked.pumpStyle, true);
  assert.match(checked.pumpHint, /placement\.line/);
  assert.match(checked.pumpHint, /"comet"/, "every effect a widget may ask for, from the ring's own list");
  assert.doesNotMatch(checked.pumpHint, /"beat"|"meter"/, 'never one that reads the sound');
  assert.match(checked.pumpHint, /live\?/, 'the live colours of a line');
  const plain = await T.runOp('widget_template', { id: 'pump-cpu', pump: true }, d);
  assert.doesNotMatch(Buffer.from(plain.files.find((f) => f.path === 'main.js').data, 'base64').toString('utf8'), /pumpRing/);

  // main.js in a stand-in page: one frame per line.
  const frame = (placement) => {
    const el = () => ({ textContent: '' });
    const nodes = { cpu: el(), mem: el() };
    const labels = [el(), el()];
    const posted = [];
    let onMessage = null;
    let now = Date.UTC(2026, 0, 1);
    const timers = [];
    const ctx = {
      Date: { now: () => now },
      document: { getElementById: (id) => nodes[id], querySelectorAll: () => labels, documentElement: { style: { setProperty: (k, v) => { ctx.css = [k, v]; } } } },
      window: { addEventListener: (_t, f) => { onMessage = f; }, parent: { postMessage: (msg) => posted.push(msg) } },
      setInterval: (f, ms) => timers.push(ms),
      Math, JSON, Array,
    };
    ctx.Date = Object.assign(function () { return new Date(Date.UTC(2026, 0, 1, 9, 5)); }, { now: () => now });
    vm.runInNewContext(file('main.js'), ctx);
    const say = (msg) => onMessage({ data: { xenonSdk: 1, ...msg } });
    say({ type: 'init', placement });
    return { nodes, labels, posted, say, timers, ctx, tick: (ms) => { now += ms; } };
  };
  const rings = (f) => f.posted.filter((p) => p.type === 'pumpRing').map(({ xenonSdk, type, ...w }) => w);

  const sensors = frame({ where: 'pump', shape: 'round', look: { colors: ['#00e5ff', '#111111', '#222222', '#333333'] }, line: { face: 'sensors', moment: 'base', readings: ['cpu'] } });
  assert.equal(sensors.posted[0].type, 'hello');
  assert.deepEqual(sensors.ctx.css, ['--text', '#00e5ff'], 'the colours the user chose for the line');
  sensors.tick(5000);
  sensors.say({ type: 'data', stream: 'system', data: { cpu: 71.6, memory: { percent: 40 } } });
  assert.equal(sensors.nodes.cpu.textContent, '72%');
  assert.equal(sensors.nodes.mem.textContent, '40%');
  sensors.say({ type: 'data', stream: 'system', data: { cpu: 90, memory: { percent: 40 } } });
  sensors.tick(1500);
  sensors.say({ type: 'data', stream: 'system', data: { cpu: 71, memory: { percent: 40 } } });
  sensors.tick(1500);
  sensors.say({ type: 'data', stream: 'system', data: { cpu: 300, memory: { percent: 40 } } });
  assert.deepEqual(rings(sensors), [{ effect: 'heat', level: 0.7 }, { effect: 'heat', level: 1 }], 'not twice in a second, not twice the same, never past full');
  sensors.say({ type: 'data', stream: 'media', data: { title: 'Song' } });
  assert.equal(sensors.nodes.cpu.textContent, '300%', 'a readings line leaves the song alone');

  const music = frame({ where: 'pump', shape: 'round', line: { face: 'music', moment: 'music', readings: [] } });
  music.say({ type: 'data', stream: 'media', data: { title: 'Song', artist: 'Band' } });
  music.say({ type: 'data', stream: 'system', data: { cpu: 50 } });
  assert.deepEqual([music.nodes.cpu.textContent, music.nodes.mem.textContent, music.labels[0].textContent], ['Song', 'Band', '']);
  assert.deepEqual(rings(music), [{ effect: 'aurora' }]);

  const clock = frame({ where: 'pump', shape: 'round', line: { face: 'clock', moment: 'base', readings: [] } });
  assert.match(clock.nodes.cpu.textContent, /\d/);
  assert.deepEqual(clock.timers, [10000]);
  clock.say({ type: 'data', stream: 'system', data: { cpu: 50 } });
  assert.notEqual(clock.nodes.cpu.textContent, '50%');
  assert.deepEqual(rings(clock), [{ effect: 'clock' }]);
});
