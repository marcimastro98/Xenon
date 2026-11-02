// Three smaller hardening rules in the Windows scripts, asserted on the source
// because PowerShell cannot run here.
//
// 1. uninstall.ps1 clears %TEMP%\xenon*. Windows PowerShell 5.1's Remove-Item
//    -Recurse follows directory junctions, and anything running as the user can
//    plant one there, so an elevated uninstall could delete whatever it points
//    at. Links are now unlinked, and only real directories are descended into.
// 2. install-native.ps1 hashed the installer by path and then launched it by
//    path. The hash now comes from a handle that denies writers and stays open
//    until the installer has started.
// 3. cpu-temp.ps1 / gpu.ps1 load LibreHardwareMonitorLib.dll into a process
//    that may be elevated. Before 0.9.5 it installs the WinRing0 driver
//    (CVE-2020-14979); and the per-user folders it was searched in are
//    user-writable. Now: >= 0.9.5 only, Program Files first, user-writable
//    locations only when not elevated. install.ps1 upgrades an old copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const UNINSTALL = read('../uninstall.ps1');
const NATIVE = read('../install-native.ps1');
const CPU = read('../cpu-temp.ps1');
const GPU = read('../gpu.ps1');
const INSTALL = read('../install.ps1');

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

test('uninstall: %TEMP%\\xenon* is cleared without following links', () => {
  const sweep = UNINSTALL.slice(UNINSTALL.indexOf("Get-ChildItem -LiteralPath $env:TEMP -Filter 'xenon*'"));
  assert.match(sweep.slice(0, 200), /Remove-PathNoFollowSafe \$_\.FullName/);
  const tree = fnBody(UNINSTALL, 'Remove-TreeNoFollow');
  const link = tree.indexOf('if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {');
  const recurse = tree.indexOf('Remove-TreeNoFollow $child.FullName');
  assert.ok(link > 0 && recurse > link, 'a link is handled before any descent');
  const linkBlock = tree.slice(link, tree.indexOf('return', link));
  assert.match(linkBlock, /\[IO\.Directory\]::Delete\(\$item\.FullName, \$false\)/, 'a directory link is unlinked, not emptied');
  assert.match(linkBlock, /\[IO\.File\]::Delete\(\$item\.FullName\)/);
  assert.doesNotMatch(tree, /Remove-Item[^\n]*-Recurse/, 'never a recursive Remove-Item');
  assert.doesNotMatch(tree, /Delete\([^)]*\$true\)/, 'never a recursive .NET delete either');
});

test('install-native: the hash comes from a handle held until the installer has started', () => {
  const open = NATIVE.indexOf('$lock = [System.IO.File]::Open($exe, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)');
  assert.ok(open > 0, 'read-only handle that lets only readers in');
  const hash = NATIVE.indexOf('$sha.ComputeHash($lock)');
  assert.ok(hash > open, 'hashed from that handle');
  const launch = NATIVE.indexOf("$proc = Start-Process -FilePath $exe -ArgumentList '/S', '/NOBOOTSTRAP' -PassThru");
  assert.ok(launch > hash);
  const release = NATIVE.indexOf('$lock.Dispose(); $lock = $null', launch);
  assert.ok(release > launch && release < NATIVE.indexOf('$proc.WaitForExit()'), 'released only after the start');
  const task = NATIVE.indexOf('schtasks /Run /TN $taskName');
  const taskRelease = NATIVE.indexOf('$lock.Dispose(); $lock = $null', task);
  assert.ok(taskRelease > task && NATIVE.slice(task, taskRelease).includes('$_.Path -eq $exe'), 'the task hand-off waits for the installer to be seen running');
  assert.match(NATIVE, /\$ExpectedSha256\.ToUpperInvariant\(\)/);
});

for (const [name, src, fail] of [['cpu-temp.ps1', CPU, 'XenonCpuLhmFailedAt'], ['gpu.ps1', GPU, 'XenonGpuLhmFailedAt']]) {
  test(`${name}: LibreHardwareMonitor 0.9.5+ only, machine-wide copies first`, () => {
    assert.match(src, /\$script:LhmMinVersion = \[Version\]'0\.9\.5'/);
    const dll = fnBody(src, 'Get-LibreHardwareMonitorDll');
    assert.match(dll, /GetFolderPath\(\$sf\)/, 'Program Files from the known-folder API');
    // Per-user copies are still used when elevated (the normal install puts
    // LibreHardwareMonitor there), but only after the machine-wide ones.
    const pf = dll.indexOf("'LibreHardwareMonitor\\LibreHardwareMonitorLib.dll'");
    assert.ok(pf > 0);
    for (const userPath of ['Get-Command LibreHardwareMonitor.exe', "'Microsoft\\WinGet\\Packages'", "'Programs\\LibreHardwareMonitor\\LibreHardwareMonitorLib.dll'"]) {
      assert.ok(dll.indexOf(userPath) > pf, `${userPath} after Program Files`);
    }
    assert.match(dll, /foreach \(\$candidate in @\(\$trusted \+ \$userWritable\)\)/, 'trusted first');
    assert.match(dll, /Test-LhmDllVersion \$candidate/, 'an old library is never returned');
    // ...and checked again right beside Add-Type, so Open() never runs on one.
    const guard = src.indexOf(`if (-not $dll -or -not (Test-LhmDllVersion $dll)) { $global:${fail} = Get-Date; return $null }`);
    assert.ok(guard > 0 && guard < src.indexOf('Add-Type -Path $dll') && src.indexOf('Add-Type -Path $dll') < src.indexOf('$computer.Open()'));
  });

  test(`${name}: still pure ASCII`, () => {
    assert.doesNotMatch(src, /[^\x00-\x7F]/);
  });
}

test('the version rule is the same in both sensor scripts', () => {
  assert.equal(fnBody(CPU, 'Test-LhmDllVersion'), fnBody(GPU, 'Test-LhmDllVersion'));
  assert.equal(fnBody(CPU, 'Get-LibreHardwareMonitorDll'), fnBody(GPU, 'Get-LibreHardwareMonitorDll'));
});

test('install.ps1 upgrades a LibreHardwareMonitor older than 0.9.5', () => {
  assert.match(INSTALL, /\$script:lhmMinVersion = \[Version\]'0\.9\.5'/);
  const body = fnBody(INSTALL, 'Install-LibreHardwareMonitorIfNeeded');
  assert.match(body, /if \(-not \$libVersion -or \$libVersion -lt \$script:lhmMinVersion\) \{[\s\S]{0,400}Invoke-WingetUpgrade -PackageId \$hardwareMonitorPackageId/);
  // Elevated installs put it where the elevated sensor scripts will load it.
  assert.match(body, /if \(Test-IsElevated\) \{ \$scopeArgs = @\('--scope', 'machine'\) \}/);
  assert.match(body, /Invoke-WingetInstall -PackageId \$hardwareMonitorPackageId -ExtraArgs \$scopeArgs/);
});
