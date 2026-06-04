import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const ol = require('../actions/obs-launch.js');

test('obsExeFromDir joins the OBS exe under bin/64bit, empty for a falsy dir', () => {
  assert.equal(ol.obsExeFromDir('C:\\Program Files\\obs-studio'), path.join('C:\\Program Files\\obs-studio', 'bin', '64bit', 'obs64.exe'));
  assert.equal(ol.obsExeFromDir(''), '');
  assert.equal(ol.obsExeFromDir(null), '');
});

test('isConnError is true only for connection-level OBS errors', () => {
  for (const m of ['obs_connect_failed', 'obs_timeout', 'obs_closed']) assert.equal(ol.isConnError(new Error(m)), true);
  for (const m of ['obs_request_failed', 'nope', '']) assert.equal(ol.isConnError(new Error(m)), false);
  assert.equal(ol.isConnError(null), false);
});

test('findObsExe prefers the registry dir, falls back to common dirs, validates exe + existence', async () => {
  const exeOf = (dir) => ol.obsExeFromDir(dir);
  const regDir = 'C:\\OBS';
  assert.equal(
    await ol.findObsExe({ readInstallDir: async () => regDir, fileExists: (p) => p === exeOf(regDir) }),
    exeOf(regDir));
  const common = ol.COMMON_OBS_DIRS[0];
  assert.equal(
    await ol.findObsExe({ readInstallDir: async () => null, fileExists: (p) => p === exeOf(common) }),
    exeOf(common));
  assert.equal(await ol.findObsExe({ readInstallDir: async () => null, fileExists: () => false }), null);
  // registry dir present but its exe missing → still falls back to a common dir that exists
  assert.equal(
    await ol.findObsExe({ readInstallDir: async () => 'C:\\Missing', fileExists: (p) => p === exeOf(common) }),
    exeOf(common));
  // a thrown readInstallDir is swallowed → common dirs still tried
  assert.equal(
    await ol.findObsExe({ readInstallDir: async () => { throw new Error('reg fail'); }, fileExists: (p) => p === exeOf(common) }),
    exeOf(common));
});
