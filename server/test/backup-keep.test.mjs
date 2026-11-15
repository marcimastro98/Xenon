// A backup import keeps what belongs to this PC: the switch for paired devices, the AI key,
// PC Control, what widgets were allowed and the programs the favourite apps start,
// and it does not merge against nothing when the saved settings could not be read.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { settingsBeforeImport, keepThisPcOnImport } = require('../settings/backup-keep.js');

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
  assert.deepEqual(incoming.sdkWidgets, { enabled: false, suspended: ['clock'], grants: { clock: { actions: ['media'], hosts: [] } } });
  // Nothing allowed here: nothing allowed after the import, whatever the file says.
  assert.deepEqual(keepThisPcOnImport({ sdkWidgets: file }, null).sdkWidgets.grants, {});
  assert.deepEqual(keepThisPcOnImport({ sdkWidgets: file }, { sdkWidgets: { grants: ['clock'] } }).sdkWidgets.grants, {});
  // A file that says nothing about widgets leaves what was allowed here.
  assert.deepEqual(keepThisPcOnImport({}, { sdkWidgets: here }).sdkWidgets, { grants: here.grants });
  assert.equal('sdkWidgets' in keepThisPcOnImport({}, { clock: 24 }), false);
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
