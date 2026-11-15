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
const { settingsBeforeImport, keepThisPcOnImport, setUpAgainOnImport } = require('../settings/backup-keep.js');

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
  assert.deepEqual(setUpAgainOnImport(file, {}), ['pcControl', 'widgetPermissions']);
  assert.deepEqual(setUpAgainOnImport(file, { aiFeatures: { pcControl: true }, sdkWidgets: { enabled: true, grants: { clock: {} } } }), []);
  assert.deepEqual(setUpAgainOnImport(file, { aiFeatures: { pcControl: true }, sdkWidgets: { enabled: true, grants: {} } }), ['widgetPermissions']);
  assert.deepEqual(setUpAgainOnImport(file, { sdkWidgets: { enabled: false, grants: { clock: {} } } }), ['pcControl', 'widgetPermissions']);
  // A file that had them off, or is not settings at all, asks for nothing.
  assert.deepEqual(setUpAgainOnImport({ aiFeatures: { pcControl: false }, sdkWidgets: { enabled: false, grants: {} } }, {}), []);
  for (const odd of [undefined, null, 'settings', [], { aiFeatures: 'on', sdkWidgets: [] }]) assert.deepEqual(setUpAgainOnImport(odd, {}), []);
});

test('the import result carries that list after the services, with or without the flags of the file', () => {
  const { _backupNeedsSetup } = require('../settings/backup-secrets.js');
  const file = { aiFeatures: { pcControl: true } };
  assert.deepEqual(_backupNeedsSetup({ obs: true, spotify: true }, { obsPassword: 'kept' }, {}, file), ['spotify', 'pcControl']);
  assert.deepEqual(_backupNeedsSetup(undefined, {}, {}, file), ['pcControl']);
  assert.deepEqual(_backupNeedsSetup({ spotify: true }, {}, {}), ['spotify']);
  assert.deepEqual(_backupNeedsSetup(null, {}, {}), []);
  const source = engineSource();
  assert.match(source, /_backupNeedsSetup\(\s*bundle\.secretsConfigured,\s*[\w.]+ \|\| \{\},\s*await _readStreamTokensSnapshot\(\), d\.settings\s*\)/);
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
    ['notes', 'c:\\apps\\notes\\NOTES.exe'], ['notes2', ''], ['tool', ''],
  ]);
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

test('the message after an import says it in every language', () => {
  const tables = require('../app-strings/tables.js');
  const words = Object.fromEntries(tables.LANGS.map((code) => [code, tables.parse(readFileSync(new URL(`../js/i18n/${code}.js`, import.meta.url), 'utf8'), code)]));
  assert.equal(tables.LANGS.length, 11);
  for (const code of tables.LANGS) {
    for (const key of ['settings_backup_needs_here', 'settings_backup_widget_permissions', 'aifeat_pccontrol']) {
      assert.ok(typeof words[code][key] === 'string' && words[code][key].trim(), `${code} has its own ${key}`);
      assert.doesNotMatch(words[code][key], /—/, `${code} ${key} has no long dash`);
      if (code !== 'en') assert.notEqual(words[code][key], words.en[key], `${code} ${key} is translated`);
    }
  }
  // The page's own code, run on a parked result: the two things of this PC get their own part.
  const shown = [];
  const parked = JSON.stringify({ needsSetup: ['spotify', 'pcControl', 'widgetPermissions'], needsWidgets: [], failed: [] });
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
  assert.deepEqual(shown, [['settings_backup_imported', 'Da ricollegare: Spotify · Da riattivare su questo PC: Controllo PC, permessi dei widget']]);
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
