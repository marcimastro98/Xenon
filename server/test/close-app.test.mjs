// The Deck's "Close or minimize an app" key: what the registry refuses, which windows a press
// acts on, and which body each platform reaches. Every effect here is a fake: nothing is closed,
// minimized or spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { createRegistry } = require('../actions/registry.js');
const appWindow = require('../actions/registry-app-window.js');
const { createAppWindows } = require('../app-windows/app-windows.js');
const win32 = require('../app-windows/app-windows-win32.js');
const { hideAppArgs } = require('../platform/darwin-windows.js');
const linuxWindows = require('../platform/linux-windows.js');
const linux = require('../platform/linux-collectors.js');
const darwin = require('../platform/darwin-collectors.js');
const { ACTION_CATALOG, validateAction } = require('../js/deck/deck-actions.js');
const { DECK_ERR_TEXT, keyToast } = require('../js/deck/deck-error-text.js');
const Tables = require('../app-strings/tables.js');
const ra = require('../paired/remote-actions.js');
const { plan } = require('../ai/ai-deck-run.js');

// A desk of windows, and a record of everything asked of it.
function fakeDesk(rows, answer = () => ({ ok: true })) {
  const calls = [];
  return {
    calls,
    appWindows: {
      available: async () => true,
      list: async () => { calls.push(['list']); return rows; },
      close: async (row) => { calls.push(['close', row.id]); return answer('close', row); },
      minimize: async (row) => { calls.push(['minimize', row.id]); return answer('minimize', row); },
    },
  };
}
const row = (id, app, extra = {}) => ({ id: String(id), app, path: '', title: app, ...extra });

test('the catalog entry asks for a capability, an app and one of two modes', () => {
  const spec = ACTION_CATALOG.find((a) => a.type === 'closeApp');
  assert.equal(spec.requires, 'appWindows', 'a capability, never an OS by proxy');
  assert.equal(spec.group, 'system');
  assert.deepEqual(spec.params.map((p) => p.kind), ['runningApp', 'select']);
  assert.deepEqual(spec.params[1].options, ['close', 'minimize'], 'no force-quit mode');
  assert.equal(validateAction({ type: 'closeApp', app: 'spotify', mode: 'kill' }), null, 'an unknown mode is no action at all');
  assert.equal(validateAction({ type: 'closeApp', app: 'spotify', mode: 'forceQuit' }), null);
});

test('Xenon itself and the system are refused before any window is touched', async () => {
  const names = ['xenon', 'Xenon.exe', 'xenon-helper', 'xenon-native', 'msedgewebview2', 'node.exe', 'pwsh',
    'explorer', 'Explorer.EXE', 'dwm', 'csrss', 'winlogon', 'lsass', 'svchost', 'C:\\Windows\\explorer.exe',
    'Finder', 'WindowServer', 'loginwindow', 'launchd', 'Dock', 'System Events',
    'systemd', 'gnome-shell', 'plasmashell', 'Xorg', 'kwin_x11'];
  for (const app of names) {
    const desk = fakeDesk([row(1, app)]);
    const reg = createRegistry({ appWindows: desk.appWindows });
    const r = await reg.run({ type: 'closeApp', app, mode: 'close' });
    assert.equal(r.ok, false, app);
    assert.ok(['app_protected', 'bad_app_name'].includes(r.error), app + ' -> ' + r.error);
    assert.deepEqual(desk.calls, [], app + ' must not reach the windows');
  }
});

test('names that are not a program name are refused', async () => {
  const desk = fakeDesk([row(1, 'chrome')]);
  const reg = createRegistry({ appWindows: desk.appWindows });
  assert.deepEqual(await reg.run({ type: 'closeApp', app: '', mode: 'close' }), { ok: false, error: 'empty_app' });
  assert.deepEqual(await reg.run({ type: 'closeApp', app: '   ', mode: 'close' }), { ok: false, error: 'empty_app' });
  for (const app of ['*', 'chr*', '../chrome', 'C:\\x\\chrome.exe', '/usr/bin/firefox', '"chrome"', 'a;b', 'x'.repeat(65), '-chrome', 'chrome\nexplorer']) {
    assert.deepEqual(await reg.run({ type: 'closeApp', app, mode: 'close' }), { ok: false, error: 'bad_app_name' }, JSON.stringify(app));
  }
  assert.deepEqual(desk.calls, []);
  assert.equal(appWindow.isProtectedApp('XenonHub'), true, 'every xenon… name');
  assert.equal(appWindow.appKey('/Applications/Safari.app'), 'safari');
});

test('a direct caller with an unknown mode is refused too', async () => {
  const desk = fakeDesk([row(1, 'chrome')]);
  assert.deepEqual(await appWindow.closeApp({ type: 'closeApp', app: 'chrome', mode: 'kill' }, { appWindows: desk.appWindows }),
    { ok: false, error: 'bad_mode' });
  assert.deepEqual(desk.calls, []);
});

test('a window whose program is protected is never touched, whatever the key typed', async () => {
  // A program that calls itself "notes" but runs from explorer.exe.
  const desk = fakeDesk([row(7, 'notes', { path: 'C:\\Windows\\explorer.exe' })]);
  const reg = createRegistry({ appWindows: desk.appWindows });
  assert.deepEqual(await reg.run({ type: 'closeApp', app: 'notes', mode: 'close' }), { ok: false, error: 'app_protected' });
  assert.deepEqual(desk.calls, [['list']]);
});

test('close asks once per process; minimize acts on each window still shown', async () => {
  const rows = [
    row(10, 'Code', { processId: 500 }), row(11, 'code', { processId: 500 }), row(12, 'other', { processId: 600 }),
    row(13, 'x', { path: 'C:\\Apps\\Code.exe', processId: 700 }), row(14, 'code', { processId: 800, minimized: true }),
  ];
  let desk = fakeDesk(rows);
  let reg = createRegistry({ appWindows: desk.appWindows });
  assert.deepEqual(await reg.run({ type: 'closeApp', app: 'code', mode: 'close' }), { ok: true });
  assert.deepEqual(desk.calls, [['list'], ['close', '10'], ['close', '13'], ['close', '14']]);

  desk = fakeDesk(rows);
  reg = createRegistry({ appWindows: desk.appWindows });
  assert.deepEqual(await reg.run({ type: 'closeApp', app: 'Code.exe', mode: 'minimize' }), { ok: true });
  assert.deepEqual(desk.calls, [['list'], ['minimize', '10'], ['minimize', '11'], ['minimize', '13']]);
});

test('one press acts on a bounded number of windows', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => row(100 + i, 'spam'));
  const desk = fakeDesk(rows);
  await createRegistry({ appWindows: desk.appWindows }).run({ type: 'closeApp', app: 'spam', mode: 'minimize' });
  assert.equal(desk.calls.length - 1, appWindow.MAX_TARGETS);
});

test('rows without a window id the platforms use are ignored', async () => {
  const desk = fakeDesk([{ id: '1; rm', app: 'chrome' }, { id: 'abc', app: 'chrome' }]);
  assert.deepEqual(await createRegistry({ appWindows: desk.appWindows }).run({ type: 'closeApp', app: 'chrome', mode: 'close' }),
    { ok: false, error: 'app_not_open' });
});

test('the answer says what happened in words a person can act on', async () => {
  const reg = (rows, answer, extra = {}) => createRegistry({ appWindows: { ...fakeDesk(rows, answer).appWindows, ...extra } });
  assert.deepEqual(await reg([row(1, 'chrome')]).run({ type: 'closeApp', app: 'spotify', mode: 'close' }), { ok: false, error: 'app_not_open' });
  assert.deepEqual(await reg([row(1, 'gedit')], () => ({ ok: false, error: 'no_window_tool' })).run({ type: 'closeApp', app: 'gedit', mode: 'minimize' }),
    { ok: false, error: 'no_window_tool' });
  assert.deepEqual(await reg([row(1, 'word')], () => ({ ok: false, error: 'close_refused' })).run({ type: 'closeApp', app: 'word', mode: 'close' }),
    { ok: false, error: 'app_close_refused' });
  assert.deepEqual(await reg([row(1, 'word')], () => { throw new Error('boom'); }).run({ type: 'closeApp', app: 'word', mode: 'minimize' }),
    { ok: false, error: 'window_failed' });
  assert.deepEqual(await reg([row(1, 'word')], undefined, { available: async () => false }).run({ type: 'closeApp', app: 'word', mode: 'close' }),
    { ok: false, error: 'unavailable' });
  assert.deepEqual(await createRegistry({}).run({ type: 'closeApp', app: 'word', mode: 'close' }), { ok: false, error: 'unavailable' });
  for (const code of ['app_not_open', 'app_protected', 'app_close_refused', 'no_window_tool', 'empty_app', 'bad_app_name']) {
    assert.ok(DECK_ERR_TEXT[code], code + ' has a sentence');
  }
  assert.equal(keyToast('app_not_open', 'x', (k, f) => f).type, 'info', 'an app that is not open is a notice, not an error');
});

test('windowMove still runs through the same module with its fixed verbs', async () => {
  let verb = null;
  const reg = createRegistry({ windowAction: (v) => { verb = v; return { ok: true }; } });
  assert.deepEqual(await reg.run({ type: 'windowMove', dir: 'center' }), { ok: true });
  assert.equal(verb, 'center');
});

test('Windows: the helper closes, a refused main window gets taskkill without /F, user32 minimizes', async () => {
  const tool = [];
  const body = [];
  const fakeWin32 = {
    closeProcess: async (pid) => { body.push(['taskkill', pid]); return { ok: true }; },
    minimizeWindow: async (id) => { body.push(['minimize', id]); return { ok: true }; },
  };
  const make = (answer) => createAppWindows({
    nativeCollectors: null, win32: fakeWin32,
    runWindowsTool: async (args) => { tool.push(args); return args[0] === 'list' ? { windows: [row(5, 'a')] } : answer; },
  });
  assert.deepEqual(await make({ ok: true }).close({ id: '5', processId: 42 }), { ok: true });
  assert.deepEqual(await make({ ok: false }).close({ id: '6', processId: 43 }), { ok: true });
  assert.deepEqual(await make({ ok: false, error: 'protected' }).close({ id: '7', processId: 44 }), { ok: false, error: 'protected' });
  assert.deepEqual(await make({}).minimize({ id: '8' }), { ok: true });
  assert.deepEqual(await make({}).list(), [row(5, 'a')]);
  assert.equal(await make({}).available(), true);
  assert.deepEqual(tool, [['close', '5'], ['close', '6'], ['close', '7'], ['list']]);
  assert.deepEqual(body, [['taskkill', 43], ['minimize', '8']], 'never taskkill a protected process');
});

test('macOS and Linux go through the collector seam, close included', async () => {
  const seen = [];
  const native = {
    windows: async (action, id) => { seen.push([action, id]); return { ok: true }; },
    appWindowsAvailable: async () => false,
  };
  const fakeWin32 = { closeProcess: () => { throw new Error('no taskkill off Windows'); }, minimizeWindow: () => { throw new Error('no user32'); } };
  const w = createAppWindows({ nativeCollectors: native, win32: fakeWin32, runWindowsTool: async () => ({ ok: false, error: 'not_found' }) });
  assert.deepEqual(await w.minimize({ id: '321' }), { ok: true });
  assert.deepEqual(await w.close({ id: '9', processId: 9 }), { ok: false, error: 'not_found' });
  assert.equal(await w.available(), false);
  assert.deepEqual(seen, [['minimize', '321']]);
  for (const c of [linux, darwin]) assert.equal(typeof c.appWindowsAvailable, 'function');
  assert.equal(await linux.appWindowsAvailable({ WAYLAND_DISPLAY: 'wayland-0' }), false, 'Wayland gives no window list');
  assert.equal(await linux.appWindowsAvailable({ DISPLAY: ':0' }), true);
  assert.equal(await darwin.appWindowsAvailable(), true);
});

test('every spawn is an argv array: taskkill never forces, the macOS hide carries the pid apart', async () => {
  assert.deepEqual(win32.taskkillArgs(1234), ['/PID', '1234']);
  for (const bad of [0, 4, -1, '12; del', 'abc', 1.5, null]) assert.equal(win32.taskkillArgs(bad), null, String(bad));
  let spawned = null;
  const fakeRun = (cmd, args, opts, cb) => { spawned = { cmd, args, opts }; cb(null); };
  assert.deepEqual(await win32.closeProcess(1234, fakeRun), { ok: true });
  assert.equal(spawned.cmd, 'taskkill.exe');
  assert.ok(!spawned.args.some((a) => /^\/f$/i.test(a)), 'never /F');
  assert.notEqual(spawned.opts.shell, true);
  spawned = null;
  assert.deepEqual(await win32.closeProcess('1; calc', fakeRun), { ok: false, error: 'not_found' });
  assert.equal(spawned, null);
  assert.equal(win32.hwndOf('123'), 123);
  for (const bad of ['', '0', '-1', '1e3', '0x10', '99999999999999999999']) assert.equal(win32.hwndOf(bad), null, bad);
  assert.equal(win32.SW_MINIMIZE, 6);
  const fakeUser32 = () => ({ isWindow: { async: (_h, cb) => cb(null, 0) }, show: { async: () => { throw new Error('must not show'); } } });
  assert.deepEqual(await win32.minimizeWindow('77', fakeUser32), { ok: false, error: 'not_found' });

  const args = hideAppArgs('4321');
  assert.deepEqual(args.slice(0, 2), ['-l', 'JavaScript']);
  assert.equal(args[2], '-e');
  assert.equal(args[4], '4321');
  assert.ok(!args[3].includes('4321'), 'the pid is an argument, never part of the script');
  assert.deepEqual(hideAppArgs('12; rm -rf'), ['-l', 'JavaScript', '-e', args[3], 'NaN']);
});

test('Linux minimize refuses an id that is not a window id without running anything', async () => {
  for (const bad of ['', 'abc', '1;2', '0x10']) {
    assert.deepEqual(await linuxWindows.minimizeWindow(bad), { ok: false, error: 'not_found' }, bad);
  }
});

test('the key is guarded from phones and from Bit', () => {
  assert.equal(ra.FREE.has('closeApp'), false, 'a phone runs it only as a key the user built');
  assert.equal(plan({ type: 'closeApp', app: 'spotify', mode: 'close' }).mode, 'confirm', 'Bit asks first');
});

test('its words exist in every language, and the editor offers the open apps', async () => {
  const keys = ['deck_act_closeApp', 'deck_info_closeApp', 'deck_opt_runningapp', 'deck_err_app_not_open',
    'deck_err_app_protected', 'deck_err_app_close_refused', 'deck_err_no_window_tool'];
  assert.equal(Tables.LANGS.length, 11);
  for (const lang of Tables.LANGS) {
    const words = await Tables.read(lang);
    for (const k of keys) assert.ok(typeof words[k] === 'string' && words[k].trim(), lang + ':' + k);
  }
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(src('../js/deck-editor/step-params.js'), /p\.kind === 'runningApp'[\s\S]{0,160}runningAppPickControl\(step, p\.name\)/);
  assert.match(src('../js/deck-editor/menu-lists.js'), /fetch\('\/windows'\)/);
  assert.match(src('../js/deck-editor/action-icons.js'), /closeApp: _ai\(/);
  assert.match(src('../deck/routes-keys.js'), /appWindows: await appWindows\.available\(\)/);
});
