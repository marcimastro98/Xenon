// Why "Xenon_4.11.7_x64-setup.exe" could leave a PC running 4.11.6.
//
// The .exe installs the app SHELL. The engine behind it is installed by the
// bootstrap the shell runs (windows/xenon-bootstrap.ps1), and that script began
// by asking one question — is a backend already here? — and stopping if it was.
// True on every machine that already runs Xenon, whatever version.
//
// So reinstalling with a versioned setup replaced the shell and left the engine
// where it was: Windows' Apps & Features said 4.11.7, the dashboard said 4.11.6
// and offered an update, and running the setup again changed nothing at all.
// Reported on Discord by someone who did exactly that twice, after being told
// (by us) that reinstalling over the top was the way out of a failed update.
//
// The script now asks WHICH version is here before deciding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BOOT = readFileSync(
  new URL('../../apps/native/src-tauri/windows/xenon-bootstrap.ps1', import.meta.url), 'utf8');

test('"a backend exists" is no longer the whole question', () => {
  // The old form: a bare bail the moment the task was found.
  assert.ok(!/if \(Test-BackendTask\) \{\s*\n\s*Done /.test(BOOT),
    'the task check bails again without looking at the version');
  assert.match(BOOT, /\$backendPresent = \$taskPresent -or \$portTaken/);
  assert.match(BOOT, /function Get-InstalledEngineVersion/);
  assert.match(BOOT, /function Test-VersionNewer/);
});

test('the installed version is read where the engine actually is', () => {
  const fn = BOOT.slice(BOOT.indexOf('function Get-InstalledEngineVersion'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  // The running engine answers wherever it was installed from, which need not
  // be the folder this script installs into.
  assert.match(body, /127\.0\.0\.1:3030\/status/);
  assert.match(body, /\$st\.version/);
  // And a fallback for a backend that is registered but not currently up.
  assert.match(body, /Join-Path \$InstallRoot 'package\.json'/);
  assert.match(body, /return ''/, 'an unknown version must be sayable');
});

test('an unreadable version never triggers an install nobody asked for', () => {
  const fn = BOOT.slice(BOOT.indexOf('function Test-VersionNewer'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /catch \{ return \$false \}/,
    'a tag that will not parse must be "not newer", never "newer"');
  assert.match(body, /-replace '\^v', ''/);
  // [version] compares numerically: 4.11.10 is above 4.11.9, which a string
  // comparison would get backwards.
  assert.match(body, /\[version\]/);
});

test('an equal or older release leaves the engine alone', () => {
  assert.match(BOOT, /if \(-not \(Test-VersionNewer \$tag \$installedVersion\)\) \{\s*\n\s*Done /);
  assert.match(BOOT, /already installed and up to date/);
});

test('an unreachable GitHub with Xenon installed is still "nothing to do"', () => {
  // Before this change that machine never reached the release lookup. Handing it
  // a red failure instead would be a regression the user cannot act on.
  const at = BOOT.indexOf('Could not reach GitHub to find the latest release');
  const around = BOOT.slice(at - 400, at);
  assert.match(around, /if \(\$backendPresent\) \{\s*\n\s*Done /);
});

test('every exit still pauses, so the console cannot flash and vanish', () => {
  // The window is spawned with a console of its own; an exit closes it instantly.
  for (const name of ['Done', 'Fail']) {
    const fn = BOOT.slice(BOOT.indexOf(`function ${name}(`));
    assert.match(fn.slice(0, fn.indexOf('\n}\n')), /Read-Host/, `${name} exits without pausing`);
  }
});

test('the script stays pure ASCII, whatever code page decodes it', () => {
  // No BOM, so PowerShell 5.1 reads it as the system ANSI code page.
  const bad = [...BOOT].filter((c) => c.charCodeAt(0) > 127);
  assert.equal(bad.length, 0, `non-ASCII in the bootstrap: ${bad.join(' ')}`);
});
