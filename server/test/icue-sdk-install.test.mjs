// The iCUE SDK client DLL is fetched, never shipped.
//
// CORSAIR's SDK EULA (inside the archive's PDF; the cue-sdk repo carries no
// LICENSE file) grants "a nonexclusive, nontransferable ... royalty-free license
// to allow You to use the Software" and forbids transferring "all or any portion
// of the Software ... to any other person". So the DLL must never be committed
// here or attached to one of our releases, however convenient. These tests pin
// the arrangement that keeps that true, and the single source of truth for the
// pinned version + hash (icue-sdk-update.ps1), which the installer and the
// in-app button both call instead of holding copies that could drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

const updatePs1 = read('server', 'icue-sdk-update.ps1');
const installPs1 = read('server', 'install.ps1');
const installJs = read('server', 'icue-sdk-install.js');
const lighting = read('server', 'lighting.js');
const gitignore = read('.gitignore');

test('the DLL is never committed to the repo', () => {
  assert.match(gitignore, /^server\/icue-sdk\/$/m, 'server/icue-sdk/ must stay gitignored');
  assert.equal(existsSync(join(ROOT, 'server', 'vendor', 'iCUESDK.x64_2019.dll')), false,
    'the SDK DLL must not be committed under server/vendor/');
});

test('version and hash live in exactly one place', () => {
  assert.match(updatePs1, /\$sdkVersion\s*=\s*'[\d.]+'/);
  assert.match(updatePs1, /\$sdkZipSha\s*=\s*'[0-9A-F]{64}'/);
  // Neither caller may carry its own copy: a second constant is a second thing
  // to remember on a version bump, and the one nobody updates wins silently.
  for (const [name, src] of [['install.ps1', installPs1], ['icue-sdk-install.js', installJs]]) {
    assert.equal(/sdkZipSha|[0-9A-F]{64}/.test(src), false, `${name} must not hold its own hash`);
    assert.equal(/cue-sdk\/releases/.test(src), false, `${name} must not hold its own download URL`);
  }
});

test('both callers route through the shared script', () => {
  assert.match(installPs1, /icue-sdk-update\.ps1/);
  assert.match(installJs, /icue-sdk-update\.ps1/);
  // -File with an argv array, never a composed -Command string.
  assert.match(installJs, /'-File', SCRIPT/);
  assert.equal(/-Command/.test(installJs), false, 'spawn must not build a shell command');
});

test('the archive is hash-verified BEFORE anything is extracted', () => {
  const check = updatePs1.indexOf('checksum mismatch');
  const extract = updatePs1.indexOf('Expand-Archive');
  assert.ok(check > 0 && extract > 0, 'both steps must exist');
  assert.ok(check < extract, 'the checksum test must precede extraction');
});

test('the fetched copy is preferred over an incidental third-party one', () => {
  const mine = lighting.indexOf("path.join(__dirname, 'icue-sdk', SDK_DLL_NAME)");
  const gigabyte = lighting.indexOf('GIGABYTE');
  assert.ok(mine > 0 && gigabyte > 0);
  assert.ok(mine < gigabyte, 'the pinned copy must be probed before the GIGABYTE fallback');
});

test('a fetched DLL is visible immediately, not after the probe TTL', () => {
  // Without this the page keeps saying "not installed" for the whole cache
  // window right after the user pressed the button, which reads as a failure.
  assert.match(lighting, /function refreshAvailability\(\)/);
  assert.match(lighting, /refreshAvailability/);
});
