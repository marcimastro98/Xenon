import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Asked for on Discord by someone whose Ambient scene is their whole dashboard:
// "on startup/restart I need to press the button in the top left for ambient
// mode. Having the option to skip that and boot straight into what the button
// press would take me to would be swell".
//
// The idle auto-start could not stand in for it: it waits for the whole PC to
// go quiet and closes the moment the PC is used anywhere. `openOnStartup` opens
// once per page load and behaves like the button, so nothing but the user
// closes it. These pin the three ways it could quietly fail: the setting not
// surviving a normalizer, the startup open being treated as a screensaver, and
// the open landing on top of something the user has to answer first.

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const { ambientStartupDecision } = require('../js/ambient-mode.js');
const MODE = read('js', 'ambient-mode.js');
const SETTINGS = read('js', 'settings.js');
const SERVER = read('server.js');
const I18N = read('js', 'i18n.js');
const INDEX = read('index.html');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

const DEFAULTS = "{ ambientMode: { enabled: true, idleMinutes: 0, sceneId: 'builtin', openOnStartup: false } }";

function clientNormalize() {
  return new Function([
    'const AMBIENT_IDLE_MINUTES = [0, 1, 2, 5, 10, 15, 30];',
    'const AMBIENT_SCENE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;',
    `const DEFAULT_HUB_SETTINGS = ${DEFAULTS};`,
    extractFunction(SETTINGS, 'normalizeAmbientMode'),
    'return normalizeAmbientMode;',
  ].join('\n'))();
}

function serverNormalize() {
  return new Function([
    'const AMBIENT_IDLE_MINUTES = new Set([0, 1, 2, 5, 10, 15, 30]);',
    'const AMBIENT_SCENE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;',
    'const AMBIENT_CANVAS_REF_RE = /^canvas:[a-z0-9][a-z0-9-]{1,40}$/;',
    `const DEFAULT_HUB_SETTINGS = ${DEFAULTS};`,
    extractFunction(SERVER, 'normalizeAmbientMode'),
    'return normalizeAmbientMode;',
  ].join('\n'))();
}

const CLEAR = { enabled: true, openOnStartup: true, firstRun: false, open: false, hidden: false, busyBodyClass: false, overlayOpen: false };

test('a clear screen with the option on opens', () => {
  assert.equal(ambientStartupDecision(CLEAR), 'open');
});

test('off, Ambient disabled, or already open: nothing to do', () => {
  assert.equal(ambientStartupDecision({ ...CLEAR, openOnStartup: false }), 'skip');
  assert.equal(ambientStartupDecision({ ...CLEAR, enabled: false }), 'skip');
  assert.equal(ambientStartupDecision({ ...CLEAR, open: true }), 'skip');
  assert.equal(ambientStartupDecision(null), 'skip');
});

test('it waits for anything the user has to deal with first', () => {
  assert.equal(ambientStartupDecision({ ...CLEAR, overlayOpen: true }), 'wait');
  assert.equal(ambientStartupDecision({ ...CLEAR, busyBodyClass: true }), 'wait');
  assert.equal(ambientStartupDecision({ ...CLEAR, hidden: true }), 'wait');
});

test('the screen picker, the first-run tour and the greeting hold it back', () => {
  const sel = MODE.match(/const STARTUP_OVERLAY_SELECTOR = '([^']+)'/);
  assert.ok(sel, 'STARTUP_OVERLAY_SELECTOR is declared');
  for (const cls of ['.sp-overlay', '.onb-overlay', '.greeting-splash']) {
    assert.ok(sel[1].includes(cls), `${cls} must hold the startup open back`);
  }
  // …and those are the classes those modules really create.
  assert.match(read('js', 'surface-picker.js'), /overlay\.className = 'sp-overlay'/);
  assert.match(read('js', 'onboarding.js'), /overlay\.className = 'onb-overlay'/);
  assert.match(read('js', 'greeting.js'), /el\('div', `greeting-splash /);
});

test('a load that runs the first-run questions is skipped, not waited out', () => {
  // The screen picker and the tour open a beat AFTER the hydrate the startup
  // check runs on, so an empty screen at that instant proves nothing — and the
  // tour, answered or not, would be pointing at a dashboard hidden behind a scene.
  assert.equal(ambientStartupDecision({ ...CLEAR, firstRun: true }), 'skip');
  // Read the way those modules decide it themselves.
  const fn = extractFunction(MODE, 'firstRunPending');
  assert.match(fn, /sp\.shouldAsk\(\)/);
  assert.match(fn, /onb\.isActive\(\)/);
  assert.match(fn, /Number\(onb\.version\) > seen/);
  assert.match(read('js', 'surface-picker.js'), /window\.SurfacePicker = \{[^}]*shouldAsk[^}]*isOpen/);
  assert.match(read('js', 'onboarding.js'), /window\.Onboarding = \{[^}]*isActive[^}]*version: ONBOARDING_VERSION/);
});

test('a running game does not hold it back', () => {
  // The scene sits on the second screen; the screensaver's game rule is about
  // not starting a screensaver, which this is not.
  assert.match(MODE, /BUSY_BODY_CLASSES\.filter\(cl => cl !== 'game-mode' && cl !== 'perf-mode'\)/);
});

test('the startup open is never treated as the screensaver', () => {
  const open = extractFunction(MODE, 'open');
  // Not flagged idle-started → no dismiss-on-input, no whole-PC-idle close.
  assert.match(open, /const markAuto = \(\) => \{ if \(!manual && !startup && isOpen\(\)\)/);
  // Not aborted because the user is at the PC — at boot they usually are.
  assert.match(open, /if \(!manual && !startup && \(\(sysIdleSec != null/);
  // And it never pops the permission dialog at boot: only `manual` requests a grant.
  assert.match(open, /if \(manual\) CustomWidget\.requestGrant/);
});

test('it runs after the settings have arrived from the server', () => {
  assert.match(MODE, /XenonStartupCards\.whenReady\(openOnStartup\)/);
  // settings.js defines XenonStartupCards, so it must load first.
  assert.ok(INDEX.indexOf('<script src="js/settings.js">') < INDEX.indexOf('<script src="js/ambient-mode.js">'));
});

test('the option is off by default and survives both normalizers', () => {
  const c = clientNormalize();
  const s = serverNormalize();
  assert.equal(c({}).openOnStartup, false);
  assert.equal(s({}).openOnStartup, false);
  assert.equal(c({ openOnStartup: true }).openOnStartup, true);
  assert.equal(s({ openOnStartup: true }).openOnStartup, true);
  for (const junk of ['true', 1, {}, null]) {
    assert.equal(c({ openOnStartup: junk }).openOnStartup, false);
    assert.equal(s({ openOnStartup: junk }).openOnStartup, false);
  }
  assert.match(SETTINGS, /ambientMode: Object\.freeze\(\{[^}]*openOnStartup: false \}\)/);
  assert.match(SERVER, /ambientMode: Object\.freeze\(\{[^}]*openOnStartup: false \}\)/);
});

test('Settings has the toggle and every language names it', () => {
  assert.match(INDEX, /id="settings-ambient-startup"[^>]*onchange="updateAmbientSetting\('openOnStartup', this\.checked\)"/);
  assert.match(extractFunction(SETTINGS, 'updateAmbientSetting'), /'openOnStartup'/);
  for (const key of ['ambient_startup', 'ambient_startup_hint']) {
    const defs = I18N.match(new RegExp(`("?)${key}\\1\\s*:`, 'g')) || [];
    assert.equal(defs.length, 11, `${key} should be translated in all 11 languages`);
  }
});
