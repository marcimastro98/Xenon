// Two Xenons on one PC, and the setup that could not see the other one.
//
// There are two ways to install: INSTALL.bat runs wherever the zip was extracted
// (a Downloads folder, typically), while the setup .exe always installs into
// %LOCALAPPDATA%\Programs\Xenon. Anyone told to "reinstall over the top" with the
// other one ends up with both, and only one of them can have port 3030.
//
// The checks around that port could not tell them apart:
//   Test-WidgetServer      — is ANYTHING answering on 3030?
//   Get-WidgetServerProcesses — node processes running THIS install's server.js
//
// So a setup run over an older folder install went: something is answering →
// stop it (nothing matched, nothing stopped) → wait for the port (never freed) →
// start our engine (dies on EADDRINUSE in milliseconds) → is something
// answering? the OLD one still is → report a clean, successful install. Every
// run, with no error anywhere, leaving the machine on exactly the install it
// started with.
//
// Reported on Discord by someone who had been told to reinstall over the top
// after the v4.11.6 dependency fix, ran the 4.11.7 setup twice, restarted in
// between, and stayed where he was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const INSTALL = readFileSync(new URL('../install.ps1', import.meta.url), 'utf8');
const UNINSTALL = readFileSync(new URL('../uninstall.ps1', import.meta.url), 'utf8');

/** The body of one PowerShell function, by name. */
function fn(src, name) {
  // Both PowerShell forms: `function X {` and `function X($a) {`.
  const m = src.match(new RegExp(`function ${name}\\s*(\\([^)]*\\))?\\s*\\{`));
  assert.ok(m, `${name} is gone`);
  const rest = src.slice(m.index);
  const end = rest.indexOf('\n}\n');
  return rest.slice(0, end + 2);
}

test('the installer can see a Xenon engine that is not its own', () => {
  assert.match(INSTALL, /function Get-AllXenonEngines \{/);
  const body = fn(INSTALL, 'Get-AllXenonEngines');
  assert.match(body, /Get-XenonServerDirFromCommandLine/,
    'it must identify engines by their command line, not by our own path');
});

test('a server.js alone is never enough to kill a process over', () => {
  // The name is far too common. uninstall.ps1 has always required one of our own
  // PowerShell hosts beside it; the installer now uses the same rule.
  const body = fn(INSTALL, 'Get-XenonServerDirFromCommandLine');
  assert.match(INSTALL, /\$xenonServerMarkers = @\(/);
  const markers = INSTALL.match(/\$xenonServerMarkers = @\(([^)]*)\)/)[1];
  for (const m of ['media.ps1', 'gpu.ps1']) {
    assert.ok(markers.includes(m), `${m} is no longer a marker`);
    // And the marker has to be a file we actually ship, or the rule matches nothing.
    assert.ok(UNINSTALL.includes('Test-XenonServerDir'), 'uninstall.ps1 lost its sibling rule');
  }
  assert.match(body, /Test-Path -LiteralPath \(Join-Path \$dir \$m\)/);
  // IndexOf, never -like: a legal Windows path may contain [ and ].
  assert.match(body, /IndexOf\(\$needle/);
  assert.ok(!/\$commandLine -like/.test(body), '-like would read [ and ] in a path as wildcards');
});

test('"is something answering" is no longer the success test', () => {
  const body = fn(INSTALL, 'Start-WidgetServer');
  // The post-start loop is the one that used to pass on a start that had failed.
  const after = body.slice(body.indexOf('Starting the widget server'));
  assert.match(after, /Get-Port3030Identity/);
  assert.ok(!/if \(Test-WidgetServer\) \{ return \}/.test(after),
    'success is our engine holding the port, not any answer from it');
  assert.match(after, /if \(\$who -eq 'ours'\) \{ return \}/);
});

test('a foreign engine is stopped, and only the foreign one', () => {
  const body = fn(INSTALL, 'Stop-ForeignWidgetServer');
  assert.match(body, /Get-AllXenonEngines/);
  assert.match(body, /Split-Path -Parent \$engine\.ServerDir\) -eq \$dir/,
    'it must stop only the install that owns the port, not every Xenon running');
  // Never a blanket "kill every node on the PC" — someone else's Node app is
  // not ours to end. (Explorer is stopped elsewhere for the edge-swipe policy,
  // by name and on purpose; node never is.)
  assert.ok(!/-Name '?node'?/.test(INSTALL), 'node must only ever be stopped by PID');
  for (const m of [...INSTALL.matchAll(/Stop-Process -Id \$?[\w.()]+/g)]) {
    assert.ok(m[0].includes('-Id'), 'every stop is by PID');
  }
});

test('an unreadable listener counts as ours, not as a stranger', () => {
  // Get-NetTCPConnection can fail. Reading that as "someone else has the port"
  // would restart a perfectly healthy engine on every single setup run.
  const body = fn(INSTALL, 'Get-Port3030Identity');
  assert.match(body, /if \(\$owner -le 0\) \{ return \$\(if \(\$ourPids\.Count -gt 0\) \{ 'ours' \} else \{ 'other' \}\) \}/);
  for (const state of ['free', 'ours', 'foreign', 'other']) {
    assert.ok(body.includes(`'${state}'`), `the ${state} answer is gone`);
  }
});

test('the user is told which folder the other Xenon is in', () => {
  // "It did not work" twice in a row is what this replaces: the second install
  // is invisible from the dashboard, and nothing else on the PC explains it.
  const body = fn(INSTALL, 'Start-WidgetServer');
  assert.match(body, /\$script:foreignServerDir/);
  assert.match(body, /UNINSTALL\.bat/, 'naming the folder without saying how to remove it is half an answer');
});
