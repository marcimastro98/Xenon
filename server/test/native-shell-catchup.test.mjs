// The native app must not stay behind the dashboard it shows.
//
// Reported from a Mac on 4.11.12: the window still landed on the wrong screen
// after sleep, and every line of the crash log said v4.11.7. The app is two
// pieces, the shell the OS launches and the dashboard behind it, and only the
// dashboard had updated. On macOS the applier ends by relaunching the whole app
// (the backend is its child), which closes the page that was about to start the
// shell's own update; Settings then read "up to date", because it only asked
// the dashboard. The wake fix and the placement fix live in the shell, so they
// never arrived.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync as readFileSyncRaw } from 'node:fs';
import { createRequire } from 'node:module';
// A Windows checkout (core.autocrlf) has CRLF; everything below matches on LF.
const readFileSync = (p, enc) => { const s = readFileSyncRaw(p, enc); return typeof s === 'string' ? s.replace(/\r\n/g, '\n') : s; };

const require = createRequire(import.meta.url);
const { createSelfUpdate } = require('../self-update.js');

const UPDATE = readFileSync(new URL('../js/update.js', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

/** One top-level function of update.js's IIFE, as source. */
function fnSource(name) {
  const m = UPDATE.match(new RegExp('\\n  (?:async )?function ' + name + '\\('));
  assert.ok(m, name + ' exists');
  const start = m.index + 1;
  const end = UPDATE.indexOf('\n  }\n', start);
  assert.ok(end > -1, name + ' ends');
  return UPDATE.slice(start, end + 4);
}

/** One `const NAME = ...;` line of update.js, as source. */
function constSource(name) {
  const m = UPDATE.match(new RegExp('\\n  const ' + name + ' = [^\\n]*'));
  assert.ok(m, name + ' exists');
  return m[0];
}

function load(names, consts, globals) {
  const ctx = vm.createContext({ ...(globals || {}) });
  const src = consts.map(constSource).join('\n') + '\n' + names.map(fnSource).join('\n')
    + '\nthis.out = {' + names.join(', ') + '};';
  vm.runInContext(src, ctx);
  return ctx.out;
}

const { shellCatchUpPlan } = load(['shellCatchUpPlan'], ['SHELL_RESUME_MS', 'stripV']);
const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-16T10:00:00Z');
const base = {
  behind: true, updateAvailable: false, current: '4.11.13', latest: '4.11.13',
  tried: '', pending: null, skipped: false, now: NOW,
};
const plan = (over) => shellCatchUpPlan({ ...base, ...over });

test('an update tapped a moment ago finishes its app half after the relaunch', () => {
  assert.equal(plan({ pending: { to: '4.11.13', at: NOW - 2 * MIN } }), 'now');
  assert.equal(plan({ pending: { to: 'v4.11.13', at: NOW - 14 * MIN }, current: 'v4.11.13' }), 'now',
    'a leading v on either side changes nothing');
  // The user asked for this version: a skip set earlier does not undo the tap.
  assert.equal(plan({ pending: { to: '4.11.13', at: NOW - MIN }, skipped: true }), 'now');
});

test('the tap only speaks for that update, and only for a while', () => {
  // The dashboard is not on the version that was tapped (rolled back, or a
  // different one): nothing is finished on its behalf.
  assert.equal(plan({ pending: { to: '4.11.14', at: NOW - MIN }, latest: '4.11.14' }), '');
  // Old, from the future (a clock that moved), or garbage: not a fresh tap.
  assert.equal(plan({ pending: { to: '4.11.13', at: NOW - 16 * MIN } }), 'quiet');
  assert.equal(plan({ pending: { to: '4.11.13', at: NOW + MIN } }), 'quiet');
  assert.equal(plan({ pending: { to: '4.11.13', at: NaN } }), 'quiet');
});

test('the dashboard always goes first', () => {
  assert.equal(plan({ updateAvailable: true, pending: { to: '4.11.13', at: NOW - MIN } }), '');
  // A newer release exists that the dashboard has not taken yet (it waits a
  // day before doing that on its own): the shell's updater would install the
  // newest, so it is not started behind the dashboard's back.
  assert.equal(plan({ latest: '4.11.14' }), '');
  assert.equal(plan({ latest: '' }), '', 'unknown latest: nothing automatic');
});

test('each version is tried once, and only where it can be remembered', () => {
  assert.equal(plan({ tried: '4.11.13', pending: { to: '4.11.13', at: NOW - MIN } }), '');
  assert.equal(plan({ tried: '4.11.13' }), '');
  assert.equal(plan({ tried: null, pending: { to: '4.11.13', at: NOW - MIN } }), '',
    'no storage, no record of a try: a failing update would run forever');
  assert.equal(plan({ tried: '4.11.12' }), 'quiet', 'an older try does not block a newer version');
});

test('a quiet catch-up respects a skipped version and a shell that is not behind', () => {
  assert.equal(plan({ skipped: true }), '');
  assert.equal(plan({ behind: false, pending: { to: '4.11.13', at: NOW - MIN } }), '');
  assert.equal(shellCatchUpPlan(null), '');
});

test('the pending tap is read once, validated, and dropped', () => {
  const store = new Map();
  let broken = false;
  const localStorage = {
    getItem: (k) => { if (broken) throw new Error('denied'); return store.has(k) ? store.get(k) : null; },
    setItem: (k, v) => { if (broken) throw new Error('denied'); store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const fns = load(['rememberShellPending', 'takeShellPending'], ['SHELL_PENDING_KEY', 'stripV'],
    { localStorage, JSON, Date, Number, String });
  assert.equal(fns.takeShellPending(), null, 'nothing written, nothing read');

  fns.rememberShellPending('v4.11.13');
  const p = fns.takeShellPending();
  assert.equal(p.to, '4.11.13');
  assert.ok(Number.isFinite(p.at));
  assert.equal(fns.takeShellPending(), null, 'dropped after the first read');

  store.set('xenon.update.shellPending', '{not json');
  assert.equal(fns.takeShellPending(), null, 'garbage reads as nothing');
  assert.equal(store.size, 0, 'and is dropped too');

  store.set('xenon.update.shellPending', '"4.11.13"');
  assert.equal(fns.takeShellPending(), null, 'a bare string is not a record');

  broken = true;
  assert.equal(fns.takeShellPending(), null, 'storage that throws reads as nothing');
  assert.doesNotThrow(() => fns.rememberShellPending('4.11.13'));
});

test('shellBehind trusts only a shell that reports its version and can update itself', () => {
  const win = { __XENON_NATIVE__: true, __XENON_NATIVE_CAPS__: { shellVersion: '4.11.7' } };
  const fns = load(['semverNewer', 'isNativeShell', 'shellBehind'], ['stripV'], { window: win });
  assert.equal(fns.shellBehind({ current: '4.11.12' }), true);
  assert.equal(fns.shellBehind({ current: '4.11.7' }), false);
  win.__XENON_NATIVE_CAPS__ = { shellVersion: '4.11.13' };
  assert.equal(fns.shellBehind({ current: '4.11.12' }), false, 'a newer shell is not behind');
  win.__XENON_NATIVE_CAPS__ = {};
  assert.equal(fns.shellBehind({ current: '4.11.12' }), false, 'an old shell without caps: nothing assumed');
  win.__XENON_NATIVE_CAPS__ = { shellVersion: '4.11.7', shellSelfUpdate: false };
  assert.equal(fns.shellBehind({ current: '4.11.12' }), false, 'pacman owns an Arch install');
  win.__XENON_NATIVE__ = false;
  win.__XENON_NATIVE_CAPS__ = { shellVersion: '4.11.7' };
  assert.equal(fns.shellBehind({ current: '4.11.12' }), false, 'a browser has no shell');
});

test('the tap is written before anything restarts, and only when the app half is due', () => {
  const body = fnSource('nativeUpdateFlowInner');
  const branch = body.indexOf('backendOutdated && st && st.supported');
  const mark = body.indexOf('if (shellOutdated) rememberShellPending(latest);');
  assert.ok(branch > -1 && mark > branch, 'inside the dashboard branch');
  assert.ok(mark < body.indexOf("'/update/prepare'"), 'before the download');
  assert.ok(mark < body.indexOf("'/update/apply'"), 'and before the applier can relaunch the app');
});

test('the shell update starts once per page and is remembered', () => {
  const body = fnSource('runShellPhase');
  assert.match(body, /if \(shellPhaseRunning\) return;\n\s*shellPhaseRunning = true;\n\s*rememberShellTried\(target\);/);
  assert.ok(body.indexOf('rememberShellTried(target)') < body.indexOf("'xenon-update:install'"),
    'remembered before the shell is asked');
  assert.match(fnSource('nativeUpdateFlow'), /if \(nativeFlowActive \|\| shellPhaseRunning\) return;/,
    'a tap on the toast or the pill during it is a no-op, not a second download');
  // Both calls in the tapped flow name the version they go for.
  assert.equal((fnSource('nativeUpdateFlowInner').match(/runShellPhase\(ctrl, caps, latest\)/g) || []).length, 2);
});

test('the catch-up runs from boot and asks the server before a quiet update', () => {
  const boot = fnSource('boot');
  assert.ok(boot.indexOf('catchUpShell(info);') > boot.indexOf('refreshIndicators(info);'));
  const body = fnSource('catchUpShell');
  assert.ok(body.indexOf('takeShellPending()') < body.indexOf('if (!shellBehind(info)'),
    'the tap is consumed even when there is nothing to catch up');
  assert.match(body, /'\/update\/auto-status\?safe=1'/);
  assert.match(body, /if \(!a\.enabled \|\| a\.shellSilent !== true\) return;/,
    'never unattended where a password prompt can appear, never with automatic updates off');
  assert.match(body, /if \(a\.latest && stripV\(a\.latest\) !== target\) return;/, 'a newer release: dashboard first');
  assert.match(body, /a\.safeNow === true && !\(a\.postponedUntil > 0\)/, 'a quiet moment, not a postponed one');
  assert.match(body, /SHELL_QUIET_FIRST_MS/);
});

test('an app behind its dashboard shows as an update, on the pill and on the button', () => {
  assert.match(fnSource('hasUpdate'), /info\.updateAvailable \|\| \(info\.latest && shellBehind\(info\)\)/);
  assert.match(fnSource('refreshIndicators'), /const available = hasUpdate\(info\);/);
  const manual = UPDATE.slice(UPDATE.indexOf('window.checkForUpdatesNow = async function'));
  assert.match(manual.slice(0, 800), /if \(hasUpdate\(info\)\) \{\n\s*openModal\(info\);/);
});

test('only Windows updates the app with nobody at the PC', () => {
  const mk = (platform) => createSelfUpdate({ root: '/x', dataDir: '/x/data', platform });
  assert.equal(mk('win32').shellUpdatesSilently(), true);
  assert.equal(mk('darwin').shellUpdatesSilently(), false);
  assert.equal(mk('linux').shellUpdatesSilently(), false);
  const route = SERVER.slice(SERVER.indexOf("reqPath === '/update/auto-status'"));
  assert.match(route.slice(0, 1200),
    /if \(urlObj\.searchParams\.get\('safe'\) === '1'\) \{\n\s*out\.safeNow = await autoUpdater\.safeNow\(\);\n\s*out\.shellSilent = selfUpdate\.shellUpdatesSilently\(\);/);
});

test('Settings names the app version when it differs, in every language', () => {
  assert.match(SETTINGS, /out\.textContent = `Xenon v\$\{version\}\$\{shellVersionSuffix\(version\)\}`/);
  assert.match(SETTINGS, /t\('settings_version_app'\)\.replace\('\{v\}', shell\)/);
  const hits = I18N.match(/["']?settings_version_app["']?: ["'][^"'\n]*\{v\}[^"'\n]*["']/g) || [];
  assert.equal(hits.length, LANGS.length, 'one per language, each with the {v} slot');
});
