// The other half of the install loop (see splash-engine-not-running.test.mjs).
// An installed engine that did not answer was handed to the bootstrap, which
// found the startup task and said "already installed - restart your PC": the
// restart led back to the same screen. The bootstrap now starts the engine,
// shows the engine's own reason when it will not start, and reinstalls it over
// itself (server\data kept). The shell side pushes "installed" to the splash and
// gives it a guarded start. And an account that is not an administrator no
// longer installs through UAC as ANOTHER account, whose startup task would never
// fire for it - the install that works today and is gone after a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const BOOT = read('../../apps/native/src-tauri/windows/xenon-bootstrap.ps1');
const LIB = read('../../apps/native/src-tauri/src/lib.rs');

function psFunction(name) {
  const at = BOOT.indexOf(`function ${name}`);
  assert.ok(at >= 0, `${name} is missing`);
  const rest = BOOT.slice(at);
  return rest.slice(0, rest.indexOf('\n}\n') + 2);
}

test('an installed, silent engine is started before anything is downloaded', () => {
  const at = BOOT.indexOf('if ($taskPresent -and -not $portTaken) {');
  assert.ok(at >= 0, 'no branch for "installed but not running"');
  assert.ok(at < BOOT.indexOf("Write-Step 'Looking up the latest Xenon release...'"),
    'the start must come before the release lookup');
  const block = BOOT.slice(at, BOOT.indexOf('\n}\n', at));
  assert.match(block, /if \(Start-EngineAndWait\) \{\s*\n\s*Done /);
  assert.match(block, /Show-EngineLog/);
  assert.match(block, /\$repair = \$true/);
});

test('a task that refuses to run does not cost a minute of waiting', () => {
  const fn = psFunction('Start-EngineAndWait');
  assert.match(fn, /\/Run \/TN \$TaskName/);
  assert.match(fn, /if \(\$LASTEXITCODE -ne 0\) \{ return \$false \}/);
  assert.match(fn, /Test-EnginePort/);
});

test('"restart your PC" is no longer the answer to an engine that will not start', () => {
  const printed = psFunction('Done').split('\n').filter((l) => /^\s*Write-Host/.test(l)).join('\n');
  assert.doesNotMatch(printed, /restart your PC/i);
});

test('a repair reinstalls whatever the version, and never "nothing to do"', () => {
  assert.match(BOOT, /if \(\$backendPresent -and -not \$repair\) \{/);
  // Offline during a repair is a failure the user can act on, not a green Done.
  const at = BOOT.indexOf('Could not reach GitHub to find the latest release');
  const around = BOOT.slice(at - 700, at);
  assert.match(around, /if \(\$repair\) \{\s*\n\s*Fail /);
});

test('the engine\'s own reason is shown, so setup.log carries it', () => {
  const fn = psFunction('Show-EngineLog');
  assert.match(fn, /Join-Path \$LogDir 'server\.log'/);
  assert.match(fn, /-Tail 8/);
});

test('an engine installed elsewhere is sent back to its own folder, not reinstalled here', () => {
  // Reinstalling into $InstallRoot would leave that copy's settings behind.
  const at = BOOT.indexOf('if ($taskPresent -and -not $portTaken) {');
  const block = BOOT.slice(at, BOOT.indexOf('\n}\n', at));
  assert.match(block, /Test-SamePath \$engineRoot \$InstallRoot/);
  assert.match(block, /Run INSTALL\.bat in that/);
});

test('only this install\'s own node is stopped before a repair', () => {
  const fn = psFunction('Stop-StuckEngine');
  assert.match(fn, /Name='node\.exe'/);
  assert.match(fn, /server\\server\.js/);
  assert.match(fn, /OrdinalIgnoreCase/);
});

test('UAC is only asked of an administrator account', () => {
  const fn = psFunction('Test-UserIsAdmin');
  // By SID: group names are localised.
  assert.match(fn, /S-1-5-32-544/);
  assert.match(fn, /System32\\whoami\.exe/);
  const elevate = BOOT.indexOf('$elevate = Test-UserIsAdmin');
  const runAs = BOOT.indexOf('-Verb RunAs -ArgumentList $psArgs');
  assert.ok(elevate >= 0 && elevate < runAs, 'the admin check must come before the RunAs');
  assert.match(BOOT.slice(elevate, runAs), /if \(-not \$elevate\) \{ throw /);
});

test('the PowerShell helpers behave on a real Windows', { skip: process.platform !== 'win32' }, () => {
  const ps = [psFunction('Test-SamePath'), psFunction('Test-UserIsAdmin'),
    psFunction('Test-EnginePort'), psFunction('Start-EngineAndWait'),
    "$ErrorActionPreference = 'Stop'",
    "$TaskName = 'Xenon test task that does not exist'",
    "Write-Output (Test-SamePath 'C:\\A\\b\\' 'c:\\a\\B')",
    "Write-Output (Test-SamePath 'C:\\A' 'C:\\B')",
    'Write-Output ((Test-UserIsAdmin).GetType().Name)',
    // A task that cannot run answers at once, not after a minute.
    '$t = [Diagnostics.Stopwatch]::StartNew(); $r = Start-EngineAndWait',
    'Write-Output $r; Write-Output ($t.Elapsed.TotalSeconds -lt 10)'].join('\n');
  const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
    { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(out.stdout.trim().split(/\r?\n/), ['True', 'False', 'Boolean', 'False', 'True']);
});

test('the shell tells the splash an installed engine is installed, and keeps telling it', () => {
  assert.match(LIB, /tell_splash\(&h, "try\{window\.__XENON_BACKEND_INSTALLED__=true;\}catch\(e\)\{\}"\)/);
  // An eval before the page loads is lost: every flag goes through the re-sender.
  assert.doesNotMatch(LIB, /win\.eval\("try\{window\.__XENON_(BACKEND_ABSENT|TASK_DISABLED)__/);
});

test('the splash\'s start never fires at an engine that answers', () => {
  const at = LIB.indexOf('fn start_backend_task');
  const body = LIB.slice(at, LIB.indexOf('\n}\n', at));
  assert.ok(body.indexOf('backend_answers_once(port)') < body.indexOf('"/Run"'),
    'start-hidden.vbs stops whatever listens on the port: probe first');
  assert.match(LIB, /"start" => start_backend_task\(&nav_handle, port\)/);
});

test('the app launched at sign-in gives the logon task time before re-running it', () => {
  assert.match(LIB, /let tries = if autostarted \{ LOGON_PROBE_TRIES \} else \{ PROBE_TRIES \};/);
  const logon = Number(/const LOGON_PROBE_TRIES: u32 = (\d+);/.exec(LIB)?.[1]);
  const usual = Number(/const PROBE_TRIES: u32 = (\d+);/.exec(LIB)?.[1]);
  assert.ok(logon > usual, 'the sign-in wait must be the longer one');
});
