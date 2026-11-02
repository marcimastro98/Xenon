// update-apply.ps1 runs its worker ELEVATED whenever the install folder is
// protected (one UAC prompt). Two things that worker used to do handed an
// administrator token to code anyone running as the user could choose:
//
//   * node.exe / npm.cmd were found through PATH (Get-Command), and PATH holds
//     user-writable folders. Elevated, only Program Files\nodejs counts now;
//     node-path.txt and PATH are accepted only when NOT elevated.
//   * the backend was restarted as a child of the worker, so it came back
//     elevated. It is now started through its startup task (schtasks /Run), so
//     the task's own principal decides its rights, and never directly from an
//     elevated worker.
//
// PowerShell cannot run here, so the rules are asserted on the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PS = readFileSync(new URL('../update-apply.ps1', import.meta.url), 'utf8');
const INSTALL = readFileSync(new URL('../install.ps1', import.meta.url), 'utf8');

function fn(name) {
  const at = PS.indexOf('function ' + name);
  assert.ok(at >= 0, name + ' exists');
  const open = PS.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < PS.length; i++) {
    if (PS[i] === '{') depth++;
    else if (PS[i] === '}' && --depth === 0) return PS.slice(at, i + 1);
  }
  return PS.slice(at);
}

test('node.exe and npm.cmd come from Program Files, and from PATH only unelevated', () => {
  const body = fn('Get-TrustedNodeTool');
  assert.match(body, /\[Environment\]::GetFolderPath\(\$sf\)/, 'Program Files from the known-folder API, not %ProgramFiles%');
  assert.match(body, /SpecialFolder\]::ProgramFiles\b/);
  const pf = body.indexOf("Join-Path $pf 'nodejs'");
  const gate = body.indexOf('if ($isAdmin) { return $null }');
  const rec = body.indexOf('node-path.txt');
  const path = body.indexOf('Get-Command $leaf');
  assert.ok(pf > 0 && gate > pf, 'Program Files is tried first');
  assert.ok(rec > gate && path > gate, 'the recorded path and PATH only after the elevation gate');
  assert.match(body, /-Encoding Unicode/, 'node-path.txt is read as the UTF-16 install.ps1 writes');
});

test('the updater resolves both tools through that rule, never straight off PATH', () => {
  assert.match(PS, /\$npmCmd = Get-TrustedNodeTool 'npm\.cmd'/);
  assert.match(fn('Restore-SharedLinks'), /\$nodeExe = Get-TrustedNodeTool 'node\.exe'/);
  assert.doesNotMatch(PS, /Get-Command npm\.cmd/);
  assert.doesNotMatch(PS, /Get-Command node\.exe/);
});

test('npm runs through System32 cmd.exe, not %ComSpec%', () => {
  const body = fn('Invoke-Npm');
  assert.match(body, /Join-Path \(\[Environment\]::SystemDirectory\) 'cmd\.exe'/);
  assert.doesNotMatch(body, /\$env:ComSpec/);
});

test('the backend restarts through its startup task', () => {
  const body = fn('Start-Server');
  assert.match(body, /schtasks\.exe'\) \/Run \/TN \$serverTaskName/);
  const m = /\$serverTaskName = '([^']+)'/.exec(PS);
  assert.ok(m, 'the task name is declared');
  const inst = /\$appName = '([^']+)'/.exec(INSTALL);
  assert.ok(inst, 'install.ps1 names its task');
  assert.equal(m[1], inst[1], 'the same task install.ps1 registers');
  // The task comes first; the direct start is only the no-task fallback.
  assert.ok(body.indexOf('/Run /TN') < body.indexOf('wscript.exe'));
});

test('an elevated worker never starts the backend itself', () => {
  const body = fn('Start-Server');
  const direct = body.indexOf("Start-Process -FilePath (Join-Path $sys32 'wscript.exe')");
  const gate = body.indexOf('if (-not $isAdmin) {');
  assert.ok(gate > 0 && direct > gate, 'the direct wscript start sits behind the not-elevated gate');
  assert.ok(body.indexOf('return', direct) < body.indexOf('Start-ServerAsSignedInUser', direct), 'and returns before the elevated branch');
  const temp = fn('Start-ServerAsSignedInUser');
  assert.match(temp, /New-ScheduledTaskPrincipal -UserId \$user -LogonType Interactive -RunLevel Limited/, 'elevated without a task: a Limited task for the signed-in user');
  assert.match(temp, /Unregister-ScheduledTask -TaskName \$tn/, 'and it is removed again');
});

test('the dashboard is not opened in an elevated browser', () => {
  const at = PS.indexOf("if (-not $quiet) {");
  const block = PS.slice(at, PS.indexOf("Log 'quiet: not opening the dashboard'", at));
  assert.match(block, /if \(\$isAdmin\) \{ Start-Process -FilePath \(Join-Path \(\[Environment\]::GetFolderPath\('Windows'\)\) 'explorer\.exe'\)/);
});

test('still pure ASCII', () => {
  assert.doesNotMatch(PS, /[^\x00-\x7F]/);
});
