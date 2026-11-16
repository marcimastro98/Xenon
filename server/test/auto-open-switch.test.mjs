// The switch "Open in the browser at sign-in", from the page to the settings file.
//
// A browser tab at every sign-in is something a person has to have asked for, at the PC, in
// a real browser. The switch is on for everyone by default, so the switch alone says nothing:
// what counts is a second, engine-owned key (autoOpenArmed) that only the address
// /startup/auto-open can set. This checks every way to that key: what the engine answers and
// writes, who is refused before reaching it, that an ordinary settings save cannot carry it,
// and that the page asks only from a real browser and hides the row everywhere else. The
// engine's parts and the page's surroundings are stand-ins: no settings file is written and
// no system is asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync as readFile } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { createAutoOpenSwitch, createSupportCheck, SUPPORT_TTL_MS } = require('../install/auto-open-switch.js');
const { REMOTE_DENY } = require('../paired/refused-paths.js');
const { remotePathAllowed } = require('../paired/remote-access.js');
const { keepStoredOnSave } = require('../settings/keep-stored-on-save.js');
const { normalizeHubApp } = require('../settings/normalize-app.js');
const { HUB_DEFAULTS_APP } = require('../settings/defaults-app.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADDRESS = '/startup/auto-open';

// ── What the engine answers and writes ───────────────────────────────────────

/** The switch on an engine whose settings are an object in memory. */
function engine({ can = true, stored = {} } = {}) {
  const did = [];
  const settings = { ...stored };
  const sw = createAutoOpenSwitch({
    port: 3030,
    supported: async (asked) => { did.push('supported ' + asked.port); return can; },
    readSettings: async () => { did.push('read'); return settings; },
    setArmed: async (on) => { did.push('write ' + on); settings.autoOpenArmed = on; return on; },
  });
  return { sw, did, settings };
}

test('the engine says whether the switch is shown and whether a browser asked', async () => {
  assert.deepEqual(await engine({ stored: { autoOpenArmed: true } }).sw.state(), { ok: true, supported: true, enabled: true });
  assert.deepEqual(await engine().sw.state(), { ok: true, supported: true, enabled: false });
  for (const autoOpenArmed of ['true', 1, null]) {
    assert.equal((await engine({ stored: { autoOpenArmed } }).sw.state()).enabled, false, String(autoOpenArmed));
  }
});

test('where the tab cannot open, the answer is "not here" and the settings are not even read', async () => {
  const pc = engine({ can: false, stored: { autoOpenArmed: true } });
  assert.deepEqual(await pc.sw.state(), { ok: true, supported: false, enabled: false });
  assert.deepEqual(pc.did, ['supported 3030']);
});

test('asking for the tab writes the one key, and only where the tab can open', async () => {
  const pc = engine();
  assert.deepEqual(await pc.sw.turn(true), { ok: true, supported: true, enabled: true });
  assert.deepEqual(pc.did, ['supported 3030', 'write true']);
  assert.equal(pc.settings.autoOpenArmed, true);

  const cannot = engine({ can: false });
  assert.deepEqual(await cannot.sw.turn(true), { ok: true, supported: false, enabled: false });
  assert.deepEqual(cannot.did, ['supported 3030'], 'nothing is written');
  assert.equal('autoOpenArmed' in cannot.settings, false);
});

test('turning it off is honoured everywhere, also where the tab could not open', async () => {
  for (const can of [true, false]) {
    const pc = engine({ can, stored: { autoOpenArmed: true } });
    assert.deepEqual(await pc.sw.turn(false), { ok: true, supported: can, enabled: false });
    assert.equal(pc.settings.autoOpenArmed, false);
  }
});

test('only a plain true turns it on', async () => {
  for (const on of ['true', 1, {}, null, undefined]) {
    const pc = engine();
    assert.equal((await pc.sw.turn(on)).enabled, false, String(on));
    assert.equal(pc.settings.autoOpenArmed, false);
  }
});

test('a save that fails is an error for the page, not a silent "on"', async () => {
  const sw = createAutoOpenSwitch({ port: 3030, supported: async () => true, readSettings: async () => ({}), setArmed: async () => { throw new Error('disk full'); } });
  await assert.rejects(sw.turn(true), /disk full/);
});

test('the system is asked at most once a minute, however many pages ask', async () => {
  let clock = 1000;
  let checks = 0;
  let answer = true;
  const supported = createSupportCheck({ check: async () => { checks += 1; return answer; }, now: () => clock });
  assert.deepEqual(await Promise.all([supported({ port: 3030 }), supported({ port: 3030 }), supported({ port: 3030 })]), [true, true, true]);
  assert.equal(checks, 1);
  clock += SUPPORT_TTL_MS - 1;
  answer = false;
  assert.equal(await supported({ port: 3030 }), true, 'the same answer inside the minute');
  clock += 1;
  assert.equal(await supported({ port: 3030 }), false, 'asked again after it: the app start can be switched on meanwhile');
  assert.equal(checks, 2);
  assert.equal(SUPPORT_TTL_MS, 60_000);
});

test('a check that breaks reads as "not here"', async () => {
  const supported = createSupportCheck({ check: async () => { throw new Error('broken'); } });
  assert.equal(await supported({ port: 3030 }), false);
  const sync = createSupportCheck({ check: () => { throw new Error('broken'); } });
  assert.equal(await sync({ port: 3030 }), false);
});

// ── Who is refused before reaching it ────────────────────────────────────────

const ENGINE = engineSource().replace(/\r\n/g, '\n');
const ROUTES = readFile(new URL('../install/routes.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const routeBody = (name) => {
  const from = ROUTES.indexOf(`'${name}': async`);
  assert.ok(from > 0, name + ' not found');
  return ROUTES.slice(from, ROUTES.indexOf('\n  },\n', from));
};

test('a paired device cannot ask for the tab, or read whether someone did', () => {
  assert.ok(REMOTE_DENY.has(ADDRESS));
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    assert.equal(remotePathAllowed(ADDRESS, method), false, method);
  }
});

test('a page on another site cannot ask for it either', () => {
  const list = ENGINE.slice(ENGINE.indexOf('const CSRF_MUTATION_PATHS = new Set(['), ENGINE.indexOf(']);', ENGINE.indexOf('const CSRF_MUTATION_PATHS = new Set([')));
  assert.match(list, /'\/startup\/auto-open',/);
  // What that list does: a request from another site, or a navigation, never reaches a route.
  assert.match(ENGINE, /CSRF_MUTATION_PATHS\.has\(reqPath\) \|\| isSdkSensitive \|\| isPackMutation\) &&\s+\(String\(req\.headers\['sec-fetch-site'\] \|\| ''\)\.toLowerCase\(\) === 'cross-site' \|\| isTopLevelNav\)/);
});

test('the two routes only pass the question on, and take one boolean from the request', () => {
  assert.match(routeBody('GET /startup/auto-open'), /json\(await autoOpenSwitch\.state\(\)\)/);
  const post = routeBody('POST /startup/auto-open');
  assert.match(post, /json\(await autoOpenSwitch\.turn\(!!body && body\.enabled === true\)\)/);
  // Nothing else of the request goes anywhere: no address, no path, no header.
  assert.deepEqual([...post.matchAll(/\b(?:req|body)\.(\w+)/g)].map((m) => m[1]), ['enabled']);
  assert.doesNotMatch(routeBody('GET /startup/auto-open'), /\breq\./);
});

test('the address the engine opens is never built from a request', () => {
  const opener = readFile(new URL('../install/sign-in-open.js', import.meta.url), 'utf8');
  assert.doesNotMatch(opener, /\breq\b|headers|\.host\b|urlObj/);
  assert.match(opener, /return 'http:\/\/127\.0\.0\.1:' \+ port \+ '\/';/);
  const swtch = readFile(new URL('../install/auto-open-switch.js', import.meta.url), 'utf8');
  assert.doesNotMatch(swtch, /\breq\b|headers|urlObj/);
});

test('nothing under install/ starts a program through a shell', () => {
  const files = ['sign-in-open.js', 'sign-in-windows.js', 'sign-in-darwin.js', 'sign-in-linux.js', 'sign-in-browser.js', 'sign-in-file.js',
    'auto-open-switch.js', 'browser-auto-open-task.js'];
  for (const file of files) {
    const text = readFile(new URL('../install/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /shell:\s*true|\bexec\(|execSync|spawnSync|cmd(\.exe)? \/c/, file);
  }
});

// ── An ordinary settings save cannot carry it ────────────────────────────────

test('a settings save keeps the stored answer, whatever the page sent', () => {
  const saved = (prev, incoming, isRemote = false) => { keepStoredOnSave(prev, incoming, isRemote); return incoming.autoOpenArmed; };
  assert.equal(saved({ autoOpenArmed: false }, { autoOpenArmed: true }), false, 'a save cannot ask for the tab');
  assert.equal(saved({}, { autoOpenArmed: true }), false);
  assert.equal(saved(null, { autoOpenArmed: true }), false, 'a first save on a new install');
  assert.equal(saved({ autoOpenArmed: true }, {}), true, 'the page does not model the key: a save without it changes nothing');
  assert.equal(saved({ autoOpenArmed: true }, { autoOpenArmed: false }), true);
  assert.equal(saved({ autoOpenArmed: false }, { autoOpenArmed: true }, true), false, 'nor a paired device');
  assert.equal(saved({ autoOpenArmed: 'true' }, {}), false, 'only a stored true counts');
});

test('nobody has asked on a new install, and on one that updates', () => {
  assert.equal(HUB_DEFAULTS_APP.autoOpenArmed, false);
  assert.equal(HUB_DEFAULTS_APP.autoOpenBrowser, true, 'the switch itself stays on by default, under its old name');
  assert.equal(normalizeHubApp({}).autoOpenArmed, false);
  assert.equal(normalizeHubApp({ autoOpenArmed: true }).autoOpenArmed, true);
  for (const autoOpenArmed of ['true', 1, {}, null]) {
    assert.equal(normalizeHubApp({ autoOpenArmed }).autoOpenArmed, false, String(autoOpenArmed));
  }
});

// ── The page ─────────────────────────────────────────────────────────────────

const PAGE = readFileSync(join(__dirname, '..', 'js', 'settings.js'), 'utf8').replace(/\r\n/g, '\n');
function pageCode() {
  const from = PAGE.indexOf('const _autoOpenEngine = { supported: null, asked: null };');
  const to = PAGE.indexOf('// Claude Code widget: the approval cards');
  const rec = PAGE.indexOf('async function reconcileAutoOpenBrowser() {');
  assert.ok(from > 0 && to > from && rec > 0, 'the switch code moved: point this test at it');
  return PAGE.slice(from, to) + '\n' + PAGE.slice(rec, PAGE.indexOf('\n}\n', rec) + 2)
    + '\nthis.api = { reconcileAutoOpenBrowser, updateAutoOpenBrowser, syncAutoOpenBrowserControl, autoOpenNotOurs };';
}
const PAGE_CODE = pageCode();

/**
 * The switch code running in a page of one kind, against an engine that answers `server`.
 * @param {{ kind?: 'browser' | 'app' | 'tauri' | 'embedded' | 'embedded-elsewhere' | 'paired', settings?: object,
 *   server?: { supported?: boolean, enabled?: boolean, status?: number } }} [page]
 */
function openPage({ kind = 'browser', settings = {}, server = {} } = {}) {
  const engineSide = { supported: true, enabled: false, status: 200, ...server };
  const asked = [];
  const row = { style: { display: 'untouched' } };
  const check = { checked: null };
  const window = {};
  window.self = window;
  window.top = window;
  if (kind === 'app') window.__XENON_NATIVE__ = true;
  if (kind === 'tauri') window.isTauri = true;
  if (kind === 'paired') window.__xenonRemote = { device: 'a phone' };
  if (kind === 'embedded') window.top = {};
  // A page embedded by another site cannot even look at the window above it.
  if (kind === 'embedded-elsewhere') Object.defineProperty(window, 'top', { get() { throw new Error('cross-origin'); } });
  const context = {
    window,
    $: (id) => ({ 'settings-auto-open-row': row, 'settings-auto-open': check })[id],
    hubSettings: { ...settings },
    normalizeSettings: (next) => next,
    saveHubSettings: () => { asked.push('save settings'); },
    setSettingsStatus: (key) => { asked.push('status ' + key); },
    fetch: async (url, init = {}) => {
      const method = init.method || 'GET';
      asked.push(method + ' ' + url + (init.body ? ' ' + init.body : ''));
      if (method === 'POST' && engineSide.supported) engineSide.enabled = JSON.parse(init.body).enabled === true;
      const answer = { ok: true, supported: engineSide.supported, enabled: engineSide.supported && engineSide.enabled };
      return { ok: engineSide.status === 200, json: async () => answer };
    },
  };
  vm.createContext(context);
  vm.runInContext(PAGE_CODE, context);
  const settle = async () => { for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve)); };
  return { api: context.api, asked, row, check, engineSide, settings: () => context.hubSettings, settle };
}

test('loading the page in a real browser never asks for the tab: the switch reads off until somebody turns it on', async () => {
  // The setting is on by default, and nobody has asked the engine.
  const page = openPage();
  await page.api.reconcileAutoOpenBrowser();
  assert.deepEqual(page.asked, ['GET /startup/auto-open'], 'one read, and no request');
  assert.equal(page.engineSide.enabled, false);
  assert.equal(page.row.style.display, '', 'the row is shown');
  assert.equal(page.check.checked, false, 'the switch shows what the engine holds');
  // Somebody asked before: the load reads that and shows it on.
  const again = openPage({ server: { enabled: true } });
  await again.api.reconcileAutoOpenBrowser();
  assert.deepEqual(again.asked, ['GET /startup/auto-open']);
  assert.equal(again.check.checked, true);
});

test('no load of the page, of any kind and with any settings, sends a request for the tab', async () => {
  for (const kind of ['browser', 'app', 'tauri', 'embedded', 'embedded-elsewhere', 'paired']) {
    for (const settings of [{}, { autoOpenBrowser: true }, { autoOpenBrowser: false }]) {
      for (const server of [{}, { enabled: true }, { supported: false }, { status: 404 }, { status: 500 }]) {
        const page = openPage({ kind, settings, server });
        await page.api.reconcileAutoOpenBrowser();
        page.api.syncAutoOpenBrowserControl();
        await page.settle();
        const where = JSON.stringify({ kind, settings, server });
        assert.ok(!page.asked.some((request) => request.includes('"enabled":true')), where);
        assert.ok(page.engineSide.enabled === (server.enabled === true) || page.engineSide.enabled === false, where);
      }
    }
  }
});

test('the request for the tab is made by the click on the switch', async () => {
  const page = openPage();
  await page.api.reconcileAutoOpenBrowser();
  assert.equal(page.check.checked, false);
  page.asked.length = 0;
  page.api.updateAutoOpenBrowser(true);
  assert.equal(page.check.checked, true, 'on at once, before the engine answers');
  await page.settle();
  assert.deepEqual(page.asked, ['save settings', 'POST /startup/auto-open {"enabled":true}', 'status settings_saved']);
  assert.equal(page.engineSide.enabled, true);
  assert.equal(page.check.checked, true);
  // Another part of Settings redraws its controls: the switch stays as the engine holds it.
  page.api.syncAutoOpenBrowserControl();
  assert.equal(page.check.checked, true);
});

test('a real browser with the switch off takes the request back', async () => {
  const page = openPage({ settings: { autoOpenBrowser: false }, server: { enabled: true } });
  await page.api.reconcileAutoOpenBrowser();
  assert.deepEqual(page.asked, ['GET /startup/auto-open', 'POST /startup/auto-open {"enabled":false}']);
  assert.equal(page.engineSide.enabled, false);
  assert.equal(page.check.checked, false);
  assert.equal(page.row.style.display, '');
});

test('the app, an embedded view and a paired device never ask, and never see the row', async () => {
  for (const kind of ['app', 'tauri', 'embedded', 'embedded-elsewhere', 'paired']) {
    const page = openPage({ kind });
    assert.equal(page.api.autoOpenNotOurs(), true, kind);
    await page.api.reconcileAutoOpenBrowser();
    assert.deepEqual(page.asked, [], kind + ' sent a request');
    assert.equal(page.row.style.display, 'none', kind);
  }
  assert.equal(openPage().api.autoOpenNotOurs(), false);
});

test('where the engine cannot open the tab, the row is hidden and nothing is asked for', async () => {
  const page = openPage({ server: { supported: false } });
  await page.api.reconcileAutoOpenBrowser();
  assert.deepEqual(page.asked, ['GET /startup/auto-open']);
  assert.equal(page.row.style.display, 'none');
});

test('an engine that does not answer leaves the row as it was and asks for nothing', async () => {
  const page = openPage({ server: { status: 404 } });
  await page.api.reconcileAutoOpenBrowser();
  assert.deepEqual(page.asked, ['GET /startup/auto-open']);
  assert.equal(page.row.style.display, '');
});

test('turning the switch saves the setting under its old name and tells the engine', async () => {
  const page = openPage({ server: { enabled: true } });
  page.api.updateAutoOpenBrowser(false);
  await page.settle();
  assert.equal(page.settings().autoOpenBrowser, false);
  assert.deepEqual(page.asked, ['save settings', 'POST /startup/auto-open {"enabled":false}', 'status settings_saved']);
  assert.equal(page.engineSide.enabled, false);

  page.asked.length = 0;
  page.api.updateAutoOpenBrowser(true);
  await page.settle();
  assert.equal(page.settings().autoOpenBrowser, true);
  assert.deepEqual(page.asked, ['save settings', 'POST /startup/auto-open {"enabled":true}', 'status settings_saved']);
});

test('turned on where the engine cannot open the tab, the row goes away instead of pretending', async () => {
  const page = openPage({ server: { supported: false } });
  page.api.updateAutoOpenBrowser(true);
  await page.settle();
  assert.equal(page.row.style.display, 'none');
  assert.ok(!page.asked.includes('status settings_saved'));
});

test('the page has no word left for the old launcher', () => {
  assert.ok(!PAGE.includes('launcher_missing'));
  assert.ok(!PAGE.includes('open-dashboard.vbs'));
});
