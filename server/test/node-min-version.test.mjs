// Minimum Node.js version for the backend, and the native app's Node.js MSI
// fallback.
//
// CVE-2026-111497 ("Node2Shell", Brotli decoder) is fixed in 22.23.4, 24.22.1
// and 26.12.1; Node 18 and 20 are end of life. install.ps1 and the native app's
// xenon-bootstrap.ps1 both upgrade a node.exe below that through winget
// (OpenJS.NodeJS.LTS), and must agree on the rule. The rule is re-implemented
// here from the source text and run against sample versions, so a typo in a
// threshold fails a test rather than shipping.
//
// The bootstrap's MSI fallback runs msiexec ELEVATED, so the MSI must come from
// a folder with a random name and carry a valid OpenJS Foundation signature.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const INSTALL = readFileSync(new URL('../install.ps1', import.meta.url), 'utf8');
const BOOT = readFileSync(new URL('../../apps/native/src-tauri/windows/xenon-bootstrap.ps1', import.meta.url), 'utf8');

function fnBody(src, name) {
  const at = src.indexOf('function ' + name);
  assert.ok(at >= 0, name + ' exists');
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

// Turns the PowerShell switch into a JS predicate.
function ruleFrom(src) {
  const body = fnBody(src, 'Test-NodeVersionSupported');
  const mins = {};
  for (const m of body.matchAll(/(\d+) \{ return \(\$v -ge \[Version\]'(\d+)\.(\d+)\.(\d+)'\) \}/g)) {
    mins[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  const future = /return \(\$v\.Major -ge (\d+)\)/.exec(body);
  assert.ok(future, 'a rule for majors after the listed ones');
  return (ver) => {
    const [a, b, c] = ver.split('.').map(Number);
    const min = mins[a];
    if (min) return a > min[0] || b > min[1] || (b === min[1] && c >= min[2]);
    return a >= Number(future[1]);
  };
}

for (const [name, src] of [['install.ps1', INSTALL], ['xenon-bootstrap.ps1', BOOT]]) {
  test(`${name}: the minimum versions are the patched releases`, () => {
    const ok = ruleFrom(src);
    for (const v of ['22.23.4', '22.24.0', '24.22.1', '24.23.0', '26.12.1', '26.13.0', '27.0.0']) assert.equal(ok(v), true, v);
    for (const v of ['18.20.4', '20.19.0', '22.23.3', '22.11.0', '23.11.0', '24.22.0', '24.11.1', '25.9.0', '26.12.0']) assert.equal(ok(v), false, v);
  });
}

test('install.ps1 upgrades a too-old Node through winget before using it', () => {
  const upd = fnBody(INSTALL, 'Update-NodeIfTooOld');
  assert.match(upd, /Invoke-WingetUpgrade -PackageId 'OpenJS\.NodeJS\.LTS'/);
  assert.match(upd, /CVE-2026-111497/);
  const inst = fnBody(INSTALL, 'Install-NodeIfNeeded');
  const found = inst.indexOf('if ($nodePath) {');
  assert.ok(inst.indexOf('$nodePath = Update-NodeIfTooOld $nodePath', found) > found, 'checked on an existing Node');
  assert.ok(inst.lastIndexOf('$nodePath = Update-NodeIfTooOld $nodePath') > inst.indexOf("Invoke-WingetInstall -PackageId 'OpenJS.NodeJS.LTS'"), 'and on a fresh one');
});

test('the bootstrap upgrades a too-old Node too', () => {
  assert.match(BOOT, /if \(\$nodePath -and -not \(Test-NodeVersionSupported \$nodePath\)\) \{\s*\$nodeUpgrade = \$true/);
  assert.match(BOOT, /\$verb = if \(\$nodeUpgrade\) \{ 'upgrade' \} else \{ 'install' \}/);
  assert.match(BOOT, /\$verb, '--id', 'OpenJS\.NodeJS\.LTS'/);
});

test('the bootstrap runs the Node MSI only from a random folder, validly signed by OpenJS', () => {
  const at = BOOT.indexOf("Write-Step 'Downloading Node.js LTS from nodejs.org...'");
  const block = BOOT.slice(BOOT.lastIndexOf('$msiDir =', at), BOOT.indexOf('Remove-DirectoryTree $msiDir', at) + 40);
  assert.match(block, /\$msiDir = Join-Path \$env:TEMP \('xenon-node-' \+ \(New-Guid\)\.Guid\)/, 'random folder');
  assert.match(block, /\$msi = Join-Path \$msiDir /);
  assert.doesNotMatch(block, /Join-Path \$tmp "node-/, 'not the predictable xenon-bootstrap folder');
  const lock = block.indexOf('[IO.File]::Open($msi, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)');
  const sig = block.indexOf('Get-AuthenticodeSignature -LiteralPath $msi');
  const check = block.indexOf("if ($sig.Status -ne 'Valid' -or $signer -notmatch 'OpenJS Foundation') {");
  const run = block.indexOf('msiexec.exe');
  assert.ok(lock > 0 && sig > lock && check > sig && run > check, 'locked, checked, then run');
  assert.match(block.slice(check, run), /throw/, 'fails closed');
  assert.ok(block.indexOf('$msiLock.Dispose()') > run, 'the lock is held until msiexec has finished');
});

test('both scripts stay ASCII', () => {
  assert.doesNotMatch(BOOT, /[^\x00-\x7F]/);
  // install.ps1 carries a BOM; past it, ASCII only.
  assert.doesNotMatch(INSTALL.replace(/^﻿/, ''), /[^\x00-\x7F]/);
});
