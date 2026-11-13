// A backup import keeps what belongs to this PC: the switch for paired devices, the AI key,
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
