// A backup import keeps what belongs to this PC: the switch for paired devices, the AI key,
// PC Control, what widgets were allowed and the programs the favourite apps start,
// and it does not merge against nothing when the saved settings could not be read.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { test } from 'node:test';

import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { settingsBeforeImport, keepThisPcOnImport, setUpAgainOnImport, deckOnImport, deckActionsHeldBack } = require('../settings/backup-keep.js');
const { remoteMayRun, remoteMayLaunch } = require('../paired/remote-actions.js');
const { normalizeDeckStore } = require('../deck/store-normalize.js');

test('a backup cannot switch access for paired devices on at this PC', () => {
  const incoming = keepThisPcOnImport({ remoteAccess: { enabled: true, https: true } }, { remoteAccess: { enabled: false } });
  assert.deepEqual(incoming.remoteAccess, { enabled: false });
});

test('a backup cannot switch access for paired devices off while devices are connected', () => {
  const incoming = keepThisPcOnImport({ remoteAccess: { enabled: false } }, { remoteAccess: { enabled: true, https: true } });
  assert.deepEqual(incoming.remoteAccess, { enabled: true, https: true });
});

test('on a PC with nothing saved the backup\'s switch is dropped, so access stays off', () => {
  assert.equal('remoteAccess' in keepThisPcOnImport({ remoteAccess: { enabled: true } }, null), false);
  assert.equal('remoteAccess' in keepThisPcOnImport({ remoteAccess: { enabled: true } }, { clock: 24 }), false);
});

test('the AI key saved here survives a backup that has none, and a key in the backup wins', () => {
  assert.equal(keepThisPcOnImport({}, { geminiApiKey: 'here' }).geminiApiKey, 'here');
  assert.equal(keepThisPcOnImport({ geminiApiKey: 'file' }, { geminiApiKey: 'here' }).geminiApiKey, 'file');
});

test('a backup cannot switch PC Control on or off: the choice made at this PC stands', () => {
  const on = keepThisPcOnImport({ aiFeatures: { enabled: true, pcControl: true } }, { aiFeatures: { enabled: true, pcControl: false } });
  assert.deepEqual(on.aiFeatures, { enabled: true, pcControl: false });
  assert.equal(keepThisPcOnImport({ aiFeatures: { pcControl: true } }, null).aiFeatures.pcControl, false);
  assert.equal(keepThisPcOnImport({ aiFeatures: { pcControl: true } }, { aiFeatures: 'yes' }).aiFeatures.pcControl, false);
  // The rest of Bit's switches come from the file; a file without them leaves the choice in place.
  const off = keepThisPcOnImport({ aiFeatures: { enabled: false, guardian: true } }, { aiFeatures: { enabled: true, pcControl: true } });
  assert.deepEqual(off.aiFeatures, { enabled: false, guardian: true, pcControl: true });
  assert.deepEqual(keepThisPcOnImport({}, { aiFeatures: { pcControl: true } }).aiFeatures, { pcControl: true });
  assert.equal('aiFeatures' in keepThisPcOnImport({}, { aiFeatures: { pcControl: false } }), false);
});

test('a backup gives a widget no permission and takes none away', () => {
  const here = { enabled: true, grants: { clock: { actions: ['media'], hosts: [] } } };
  const file = { enabled: false, suspended: ['clock'], grants: { clock: { actions: ['media', 'openUrl'], secrets: true }, spy: { hosts: ['example.com'], ai: true } } };
  const incoming = keepThisPcOnImport({ sdkWidgets: file }, { sdkWidgets: here });
  assert.deepEqual(incoming.sdkWidgets, { enabled: true, suspended: [], grants: { clock: { actions: ['media'], hosts: [] } } });
  // Nothing allowed here: nothing allowed after the import, whatever the file says.
  assert.deepEqual(keepThisPcOnImport({ sdkWidgets: file }, null).sdkWidgets.grants, {});
  assert.deepEqual(keepThisPcOnImport({ sdkWidgets: file }, { sdkWidgets: { grants: ['clock'] } }).sdkWidgets.grants, {});
  // A file that says nothing about widgets leaves what was allowed here.
  assert.deepEqual(keepThisPcOnImport({}, { sdkWidgets: here }).sdkWidgets, { enabled: true, suspended: [], grants: here.grants });
  assert.equal('sdkWidgets' in keepThisPcOnImport({}, { clock: 24 }), false);
});

test('a backup neither lets community widgets run nor stops the ones this PC runs', () => {
  const file = { enabled: true, assign: { clock: 'page-1' }, suspended: ['clock'] };
  // Off here stays off, and a widget this PC stopped for being heavy stays stopped.
  const off = keepThisPcOnImport({ sdkWidgets: file }, { sdkWidgets: { enabled: false, suspended: ['heavy'] } }).sdkWidgets;
  assert.deepEqual(off, { enabled: false, assign: { clock: 'page-1' }, suspended: ['heavy'], grants: {} });
  assert.equal(keepThisPcOnImport({ sdkWidgets: file }, null).sdkWidgets.enabled, false);
  assert.equal(keepThisPcOnImport({ sdkWidgets: file }, { sdkWidgets: { enabled: 'yes' } }).sdkWidgets.enabled, false);
  // On here stays on, and the file cannot stop a widget that runs here.
  const on = keepThisPcOnImport({ sdkWidgets: { enabled: false, suspended: ['clock'] } }, { sdkWidgets: { enabled: true, suspended: 'clock' } }).sdkWidgets;
  assert.deepEqual(on, { enabled: true, suspended: [], grants: {} });
});

test('the list after an import names what the file had on and this PC left off', () => {
  const file = { aiFeatures: { pcControl: true }, sdkWidgets: { enabled: true, grants: { clock: { actions: ['media'] } } } };
  const can = { pcControl: true };
  assert.deepEqual(setUpAgainOnImport(file, {}, can), ['pcControl', 'widgetPermissions']);
  assert.deepEqual(setUpAgainOnImport(file, { aiFeatures: { pcControl: true }, sdkWidgets: { enabled: true, grants: { clock: {} } } }, can), []);
  assert.deepEqual(setUpAgainOnImport(file, { aiFeatures: { pcControl: true }, sdkWidgets: { enabled: true, grants: {} } }, can), ['widgetPermissions']);
  assert.deepEqual(setUpAgainOnImport(file, { sdkWidgets: { enabled: false, grants: { clock: {} } } }, can), ['pcControl', 'widgetPermissions']);
  // Where PC Control cannot exist (no PowerShell to run its commands) it is not something to turn on again.
  assert.deepEqual(setUpAgainOnImport(file, {}, { pcControl: false }), ['widgetPermissions']);
  assert.deepEqual(setUpAgainOnImport({ aiFeatures: { pcControl: true } }, {}, { pcControl: false }), []);
  // Asked without saying, the answer is this machine's own: the same word the engine offers the tool by.
  const { POWERSHELL_SUPPORTED } = require('../powershell/supported.js');
  assert.deepEqual(setUpAgainOnImport({ aiFeatures: { pcControl: true } }, {}), POWERSHELL_SUPPORTED ? ['pcControl'] : []);
  assert.match(engineSource(), /_features.pcControl === true && POWERSHELL_SUPPORTED/);
  // A file that had them off, or is not settings at all, asks for nothing.
  assert.deepEqual(setUpAgainOnImport({ aiFeatures: { pcControl: false }, sdkWidgets: { enabled: false, grants: {} } }, {}), []);
  for (const odd of [undefined, null, 'settings', [], { aiFeatures: 'on', sdkWidgets: [] }]) assert.deepEqual(setUpAgainOnImport(odd, {}), []);
});

test('the import result carries that list after the services, with or without the flags of the file', () => {
  const { _backupNeedsSetup } = require('../settings/backup-secrets.js');
  const file = { aiFeatures: { pcControl: true } };
  const can = { pcControl: true };
  assert.deepEqual(_backupNeedsSetup({ obs: true, spotify: true }, { obsPassword: 'kept' }, {}, file, undefined, undefined, can), ['spotify', 'pcControl']);
  assert.deepEqual(_backupNeedsSetup(undefined, {}, {}, file, undefined, undefined, can), ['pcControl']);
  assert.deepEqual(_backupNeedsSetup({ spotify: true }, {}, {}, file, undefined, undefined, { pcControl: false }), ['spotify']);
  assert.deepEqual(_backupNeedsSetup({ spotify: true }, {}, {}), ['spotify']);
  assert.deepEqual(_backupNeedsSetup(null, {}, {}), []);
  const source = engineSource();
  assert.match(source, /const deckNow = await readDeckStore\(\)\.catch\(\(\) => null\);\s*const needsSetup = _backupNeedsSetup\(bundle\.secretsConfigured, [\w.]+ \|\| \{\}, await _readStreamTokensSnapshot\(\), d\.settings, d\.deck, deckNow\);/);
});

// A Deck as the dashboard saves it: one profile, one page, keys found by their place.
const deckOf = (/** @type {any[]} */ keys, extra = {}) => ({
  configs: { main: { profiles: [{ id: 'p1', root: { pages: [{ keys }] } }] } }, rev: 3, ...extra,
});
const keyAt = (/** @type {any} */ store, /** @type {number} */ index) => store.configs.main.profiles[0].root.pages[0].keys[index];
const NOTES = { type: 'openApp', path: 'C:\\Apps\\Notes\\notes.exe' };
const TOOL = { type: 'openApp', path: 'C:\\Downloads\\tool.exe' };

test('a Deck key of a backup keeps an action that starts or types only when this PC\'s Deck holds it', () => {
  const here = deckOf([{ id: 'a', kind: 'action', title: 'Notes', triggers: { tap: NOTES } }]);
  const file = deckOf([
    { id: 'a', kind: 'action', title: 'Notes', triggers: { tap: { ...NOTES, label: 'renamed' } } },
    null,
    { id: 'b', kind: 'action', title: 'Tool', icon: { type: 'emoji', value: 'T' }, triggers: { tap: TOOL, hold: { type: 'media', cmd: 'next' } } },
    { id: 'c', kind: 'action', title: 'Both', triggers: { tap: { steps: [
      { action: { type: 'runScript', path: 'C:\\Downloads\\run.ps1' }, delayMs: 0 },
      { action: { type: 'volume', mode: 'mute' }, delayMs: 200 },
      { action: NOTES, delayMs: 0 },
    ] }, double: { type: 'hotkey', keys: 'ctrl+alt+t' } } },
  ], { presets: [{ name: 'Saved', root: { pages: [{ keys: [{ id: 'd', kind: 'action', triggers: { tap: { type: 'typeText', text: 'hello' } } }] }] } }], keyPresets: [{ id: 'e', kind: 'action', triggers: { tap: TOOL } }] });
  const written = deckOnImport(file, here);

  // The action this PC already had is kept, with the file's own spelling of the key.
  assert.deepEqual(keyAt(written, 0).triggers.tap, { ...NOTES, label: 'renamed' });
  assert.equal(keyAt(written, 1), null);
  // A new program: the key stays in its place with its face, the action is gone, the free one stays.
  assert.deepEqual(keyAt(written, 2), { id: 'b', kind: 'action', title: 'Tool', icon: { type: 'emoji', value: 'T' }, triggers: { hold: { type: 'media', cmd: 'next' } } });
  // In a list of steps the new script leaves a hole, the free step and the known program stay.
  assert.deepEqual(keyAt(written, 3).triggers, { tap: { steps: [null, { action: { type: 'volume', mode: 'mute' }, delayMs: 200 }, { action: NOTES, delayMs: 0 }] } });
  // Saved profiles and saved keys are read the same way.
  assert.deepEqual(written.presets[0].root.pages[0].keys[0], { id: 'd', kind: 'action', triggers: {} });
  assert.deepEqual(written.keyPresets[0], { id: 'e', kind: 'action', triggers: {} });
  assert.equal(written.rev, 3);

  // What a paired device may do with the Deck that was written.
  assert.deepEqual(remoteMayRun(NOTES, written), { ok: true });
  for (const action of [TOOL, { type: 'runScript', path: 'C:\\Downloads\\run.ps1' }, { type: 'hotkey', keys: 'ctrl+alt+t' }, { type: 'typeText', text: 'hello' }]) {
    assert.deepEqual(remoteMayRun(action, written), { ok: false, error: 'needs_pc' }, action.type);
  }
  assert.equal(remoteMayLaunch(TOOL.path, [], written), false);
  assert.equal(remoteMayLaunch(NOTES.path, [], written), true);
  // The file itself would have allowed all of it: that is what the import no longer takes.
  assert.deepEqual(remoteMayRun(TOOL, normalizeDeckStore(file)), { ok: true });
  assert.equal(deckActionsHeldBack(file, written)?.keys, 4, 'the Tool key, the steps key, the key of the saved profile and the saved key');
});

test('a backup restored on the PC that made it loses nothing of its Deck', () => {
  const store = deckOf([
    { id: 'a', kind: 'action', triggers: { tap: NOTES, hold: { type: 'hotkey', keys: 'ctrl+shift+m' } } },
    { id: 'f', kind: 'folder', folder: { pages: [{ keys: [{ id: 'g', kind: 'action', triggers: { tap: { steps: [{ action: { type: 'runScript', path: 'C:\\Scripts\\night.ps1' }, delayMs: 50 }] } } }] }] } },
  ], { keyPresets: [{ id: 'h', kind: 'action', triggers: { tap: { type: 'webhook', url: 'https://example.com/hook', method: 'POST' } } }] });
  assert.deepEqual(deckOnImport(store, store), normalizeDeckStore(store));
  assert.equal(deckActionsHeldBack(store, deckOnImport(store, store)), null);
});

test('on a PC with no Deck, or one that could not be read, no guarded action comes in', () => {
  const file = deckOf([{ id: 'b', kind: 'action', title: 'Tool', triggers: { tap: TOOL, hold: { type: 'media', cmd: 'next' } } }]);
  for (const here of [null, undefined, {}, 'deck', deckOf([])]) {
    const written = deckOnImport(file, here);
    assert.deepEqual(keyAt(written, 0).triggers, { hold: { type: 'media', cmd: 'next' } });
    assert.equal(remoteMayLaunch(TOOL.path, [], written), false);
  }
  // A file whose Deck is not a Deck is stored as an empty one, as before.
  for (const odd of [null, 'deck', [], 7]) assert.deepEqual(deckOnImport(odd, file).configs, {});
});

test('the list after an import says so, also for a first-format file with no flags', () => {
  const { _backupNeedsSetup } = require('../settings/backup-secrets.js');
  const file = deckOf([{ id: 'b', kind: 'action', triggers: { tap: TOOL } }]);
  const written = deckOnImport(file, null);
  assert.deepEqual(_backupNeedsSetup(undefined, {}, {}, undefined, file, written), ['deckActions']);
  assert.deepEqual(_backupNeedsSetup({ spotify: true }, {}, {}, { aiFeatures: { pcControl: true } }, file, written, { pcControl: true }), ['spotify', 'pcControl', 'deckActions']);
  // Nothing held back, or a file with no Deck: nothing to say.
  assert.deepEqual(_backupNeedsSetup(undefined, {}, {}, undefined, file, normalizeDeckStore(file)), []);
  assert.deepEqual(_backupNeedsSetup(undefined, {}, {}, undefined, undefined, written), []);
  // The engine takes the Deck of every format through it: nothing in that part asks which format the file is.
  const source = engineSource();
  const apply = source.slice(source.indexOf('async function applyBackup('));
  const deck = apply.slice(apply.indexOf("await apply('deck'"), apply.indexOf("if (Array.isArray(d.events))"));
  assert.match(deck, /const cur = await readDeckStore\(\)\.catch\(\(\) => null\);\s*const store = deckOnImport\(d\.deck, cur, keepDeckActions === true && !remote\);/);
  assert.doesNotMatch(deck, /normalizeDeckStore\(d\.deck\)|fmt/);
});

test('a favourite app of a backup keeps its path only when this PC already starts that program', () => {
  const here = [{ key: 'notes', app: 'Notes', path: 'C:\\Apps\\Notes\\notes.exe' }];
  const file = [
    { key: 'notes', app: 'Notes', title: 'Notes', path: 'c:\\apps\\notes\\NOTES.exe' },
    { key: 'notes2', app: 'Notes', path: 'C:\\Apps\\Other\\notes.exe' },
    { key: 'tool', app: 'Tool', path: 'C:\\Downloads\\tool.exe', extra: 'dropped' },
    'not a favourite',
  ];
  const incoming = keepThisPcOnImport({ appFavorites: file }, { appFavorites: here });
  assert.deepEqual(incoming.appFavorites.map((fav) => [fav.key, fav.path]), [
    ['notes', 'C:\\Apps\\Notes\\notes.exe'], ['notes2', ''], ['tool', ''],
  ]);
  // The path kept is this PC's own, letter for letter: where capitals tell files apart the
  // file's spelling could be another program. The same spelling wins over a near one.
  const unix = [{ key: 'draw', app: 'Draw', path: '/opt/Draw/draw' }, { key: 'draw2', app: 'Draw', path: '/opt/draw/draw' }];
  const asked = [{ key: 'a', app: 'Draw', path: '/OPT/DRAW/DRAW' }, { key: 'b', app: 'Draw', path: '/opt/draw/draw' }, { key: 'c', app: 'Draw', path: '/opt/Draw/draw' }];
  assert.deepEqual(keepThisPcOnImport({ appFavorites: asked }, { appFavorites: unix }).appFavorites.map((fav) => fav.path), ['/opt/Draw/draw', '/opt/draw/draw', '/opt/Draw/draw']);
  for (const fav of keepThisPcOnImport({ appFavorites: asked }, { appFavorites: unix }).appFavorites) assert.ok(unix.some((mine) => mine.path === fav.path));
  // Stored as a save stores them: the known fields and nothing else.
  assert.deepEqual(Object.keys(incoming.appFavorites[2]).sort(), ['app', 'icon', 'key', 'path', 'title']);
  // On a PC with no favourites, or none saved, no path comes in at all.
  assert.deepEqual(keepThisPcOnImport({ appFavorites: file }, null).appFavorites.map((fav) => fav.path), ['', '', '']);
  assert.deepEqual(keepThisPcOnImport({ appFavorites: file }, { appFavorites: [{ key: 'empty', app: 'Empty', path: '' }] }).appFavorites.map((fav) => fav.path), ['', '', '']);
  assert.deepEqual(keepThisPcOnImport({ appFavorites: 'all of them' }, { appFavorites: here }).appFavorites, []);
  assert.equal('appFavorites' in keepThisPcOnImport({}, { appFavorites: here }), false);
});

test('what the import keeps reaches the file that is written', () => {
  const { normalizeHubSettings } = require('../settings/normalize-hub-settings.js');
  const here = normalizeHubSettings({ aiFeatures: { enabled: true }, sdkWidgets: { enabled: true, grants: { clock: { actions: ['media'] } } }, appFavorites: [] });
  const file = { aiFeatures: { enabled: true, pcControl: true }, sdkWidgets: { enabled: true, grants: { spy: { ai: true } } }, appFavorites: [{ key: 'tool', app: 'Tool', path: 'C:\\Downloads\\tool.exe' }] };
  const written = normalizeHubSettings(keepThisPcOnImport(file, here));
  assert.equal(written.aiFeatures.pcControl, false);
  assert.deepEqual(written.sdkWidgets.grants, { clock: { actions: ['media'] } });
  assert.deepEqual(written.appFavorites.map((fav) => [fav.key, fav.path]), [['tool', '']]);
});

test('a backup cannot ask for the browser tab at sign-in, and cannot take the request back', () => {
  // Nobody asked at this PC: whatever the file says, nobody has.
  for (const prev of [null, {}, { autoOpenArmed: false }, { autoOpenArmed: 'true' }, { autoOpenArmed: 1 }]) {
    assert.equal(keepThisPcOnImport({ autoOpenArmed: true, autoOpenBrowser: true }, prev).autoOpenArmed, false, JSON.stringify(prev));
  }
  assert.equal(keepThisPcOnImport({}, null).autoOpenArmed, false, 'a file without the key');
  // Somebody did: a file without the key, or with it off, changes nothing.
  for (const file of [{}, { autoOpenArmed: false }, { autoOpenArmed: null }]) {
    assert.equal(keepThisPcOnImport(file, { autoOpenArmed: true }).autoOpenArmed, true, JSON.stringify(file));
  }
});

test('the request for the tab in a backup does not reach the file that is written', () => {
  const { normalizeHubSettings } = require('../settings/normalize-hub-settings.js');
  const file = { autoOpenArmed: true, autoOpenBrowser: true };
  // A new PC, and one whose user never asked.
  assert.equal(normalizeHubSettings(keepThisPcOnImport({ ...file }, null)).autoOpenArmed, false);
  assert.equal(normalizeHubSettings(keepThisPcOnImport({ ...file }, normalizeHubSettings({}))).autoOpenArmed, false);
  // The switch itself is an ordinary preference and still travels.
  assert.equal(normalizeHubSettings(keepThisPcOnImport({ autoOpenArmed: true, autoOpenBrowser: false }, normalizeHubSettings({}))).autoOpenBrowser, false);
  // The PC that made the backup keeps its own answer.
  assert.equal(normalizeHubSettings(keepThisPcOnImport({ ...file }, normalizeHubSettings({ autoOpenArmed: true }))).autoOpenArmed, true);
});

test('the message after an import says it in every language', () => {
  const tables = require('../app-strings/tables.js');
  const words = Object.fromEntries(tables.LANGS.map((code) => [code, tables.parse(readFileSync(new URL(`../js/i18n/${code}.js`, import.meta.url), 'utf8'), code)]));
  assert.equal(tables.LANGS.length, 11);
  for (const code of tables.LANGS) {
    for (const key of ['settings_backup_needs_here', 'settings_backup_widget_permissions', 'settings_backup_deck_actions', 'aifeat_pccontrol']) {
      assert.ok(typeof words[code][key] === 'string' && words[code][key].trim(), `${code} has its own ${key}`);
      assert.doesNotMatch(words[code][key], /—/, `${code} ${key} has no long dash`);
      if (code !== 'en') assert.notEqual(words[code][key], words.en[key], `${code} ${key} is translated`);
    }
  }
  // The page's own code, run on a parked result: the two things of this PC get their own part.
  const shown = [];
  const parked = JSON.stringify({ needsSetup: ['spotify', 'pcControl', 'widgetPermissions', 'deckActions'], needsWidgets: [], failed: [] });
  const sandbox = {
    console,
    sessionStorage: { getItem: () => parked, removeItem: () => {} },
    document: { getElementById: () => null, addEventListener: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.t = (/** @type {string} */ key) => words.it[key] ?? words.en[key];
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../js/settings/backup-reset.js', import.meta.url), 'utf8'), sandbox);
  sandbox.backupToast = (/** @type {string} */ key, /** @type {string} */ meta) => shown.push([key, meta]);
  sandbox.showPendingBackupSummary();
  assert.deepEqual(shown, [['settings_backup_imported', 'Da ricollegare: Spotify · Da riattivare su questo PC: Controllo PC, permessi dei widget · ' + words.it.settings_backup_deck_actions]]);
});

test('settings that cannot be read fail the import, a broken file counts as empty', async () => {
  assert.deepEqual(await settingsBeforeImport(async () => ({ a: 1 })), { a: 1 });
  assert.equal(await settingsBeforeImport(async () => null), null);
  assert.equal(await settingsBeforeImport(async () => JSON.parse('{broken')), null);
  await assert.rejects(settingsBeforeImport(async () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); }), /locked/);
});

test('the import in the engine goes through both', () => {
  const source = engineSource();
  const apply = source.slice(source.indexOf('async function applyBackup('));
  const body = apply.slice(0, apply.indexOf('\n}\n'));
  assert.match(body, /const prev = await settingsBeforeImport\(readHubSettings\);/);
  assert.match(body, /keepThisPcOnImport\(preserveSettingsSecrets\(\{ \.\.\.d\.settings \}, prev\), prev\)/);
  assert.doesNotMatch(body, /readHubSettings\(\)\.catch\(\(\) => null\)/);
});
