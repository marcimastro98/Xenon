// enable-sensors.ps1 and compact-vhdx.ps1 relaunch themselves through UAC.
// They used to do it with `-File $PSCommandPath`: the elevated PowerShell then
// read the script from the install folder, which the user can write, AFTER the
// prompt was answered. A file swapped in between ran as administrator, and the
// prompt the user approved said nothing about it.
//
// Now the text already loaded (captured before the prompt) goes over in
// -EncodedCommand, with the parameters embedded as single-quoted literals in
// which all five PowerShell quote characters are doubled.
//
// compact-vhdx.ps1 also stopped writing a diskpart script into %TEMP% (it pipes
// the commands instead), writes its status only into the install's server\data
// folder, and no longer trusts a WSL BasePath from HKCU on its own.
//
// PowerShell cannot run here, so the rules are asserted on the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SENSORS = readFileSync(new URL('../enable-sensors.ps1', import.meta.url), 'utf8');
const COMPACT = readFileSync(new URL('../compact-vhdx.ps1', import.meta.url), 'utf8');

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

for (const [name, src] of [['enable-sensors.ps1', SENSORS], ['compact-vhdx.ps1', COMPACT]]) {
  test(`${name}: the elevated copy is the text loaded before the prompt`, () => {
    assert.doesNotMatch(src, /'-File', \("`"\$PSCommandPath`"\)/, 'no -File relaunch of the script on disk');
    const capture = src.indexOf('$selfText = $MyInvocation.MyCommand.ScriptBlock.ToString()');
    const paramEnd = src.indexOf('\n)\n');
    const prompt = src.indexOf('-Verb RunAs');
    assert.ok(capture > paramEnd && capture < prompt, 'captured right after param(), before the prompt');
    assert.ok(capture < src.indexOf("$ErrorActionPreference = 'Stop'"), 'as the very first statement');
    assert.match(src, /\$body = Get-ElevationScriptText \$selfText/);
    assert.match(src, /\[Convert\]::ToBase64String\(\[Text\.Encoding\]::Unicode\.GetBytes\(\$command\)\)/, 'UTF-16LE base64, what -EncodedCommand expects');
    assert.match(src, /'-EncodedCommand', \$encoded\)/);
    assert.match(src, /\$command = "& \{`n" \+ \$body \+ "`n\} -/, 'run as a script block so param() binds the values');
  });

  test(`${name}: every PowerShell quote character is doubled in an embedded value`, () => {
    const body = fnBody(src, 'ConvertTo-PsLiteral');
    const codes = [...body.matchAll(/\[char\]0x([0-9A-Fa-f]+)/g)].map((m) => parseInt(m[1], 16)).sort((a, b) => a - b);
    assert.deepEqual(codes, [0x27, 0x2018, 0x2019, 0x201A, 0x201B]);
    assert.match(body, /if \(\$quotes\.IndexOf\(\$ch\) -ge 0\) \{ \[void\]\$sb\.Append\(\$ch\) \}\s*\[void\]\$sb\.Append\(\$ch\)/);
    assert.match(body, /return "'" \+ \$sb\.ToString\(\) \+ "'"/);
  });

  test(`${name}: comments are dropped by the parser, so the command fits`, () => {
    const body = fnBody(src, 'Get-ElevationScriptText');
    assert.match(body, /Language\.Parser\]::ParseInput/);
    assert.match(body, /\$_\.Kind -eq 'Comment'/);
    assert.match(src, /if \(\$encoded\.Length -gt 30000\)/);
    // Rough size of what goes over: the code without comment lines, as UTF-16
    // in base64. Must stay well under the 32767-character command line.
    const code = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.ok(Math.ceil((code.length * 2) / 3) * 4 < 28000, 'encoded size ' + Math.ceil((code.length * 2) / 3) * 4);
  });

  test(`${name}: still pure ASCII`, () => {
    assert.doesNotMatch(src, /[^\x00-\x7F]/);
  });
}

test('enable-sensors.ps1 checks the task name before it goes anywhere', () => {
  const check = SENSORS.indexOf("if ($TaskName -notmatch '^[A-Za-z0-9 ._()-]{1,128}$')");
  assert.ok(check > 0 && check < SENSORS.indexOf('-Verb RunAs'));
  assert.match(SENSORS, /-TaskName " \+ \(ConvertTo-PsLiteral \$TaskName\) \+/);
  assert.match(SENSORS, /' -DataDir ' \+ \(ConvertTo-PsLiteral \$DataDir\) \+ ' -Elevated'/);
});

// Since 5.1.0 the elevated copy may install LHM and PawnIO first, which takes
// minutes, so it answers through a status file instead of the task's run level.
test('enable-sensors.ps1 reports through server\\data, through no link', () => {
  const t = fnBody(SENSORS, 'Test-StatusPath');
  assert.match(t, /\(Split-Path -Leaf \$dir\) -ne 'data'/);
  assert.match(t, /\(Split-Path -Leaf \$serverDir\) -ne 'server'/);
  assert.match(t, /Test-IsLink \$di/);
  assert.match(t, /Test-IsLink \$fi/);
  const w = fnBody(SENSORS, 'Write-Status');
  assert.ok(w.indexOf('if (-not (Test-StatusPath)) { return }') < w.indexOf('[IO.File]::Open'));
  assert.match(w, /\[IO\.FileMode\]::CreateNew/);
  assert.ok(SENSORS.indexOf('if (-not (Test-StatusPath)) {') < SENSORS.indexOf('-Verb RunAs'), 'checked before the prompt');
});

test('enable-sensors.ps1 installs only fixed winget ids, LHM machine-wide', () => {
  const ids = [...SENSORS.matchAll(/'--id', '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(ids)].sort(), ['LibreHardwareMonitor.LibreHardwareMonitor', 'namazso.PawnIO']);
  for (const m of SENSORS.matchAll(/'--id', 'LibreHardwareMonitor\.LibreHardwareMonitor'([^)]*)\)/g)) assert.match(m[1], /'--scope', 'machine'/);
  assert.match(fnBody(SENSORS, 'Test-MachineLhm'), /\[Version\]'0\.9\.5'/, 'never a WinRing0 build');
  assert.ok(SENSORS.indexOf('$parts = Install-SensorParts') < SENSORS.indexOf('/Change /TN $TaskName /RL HIGHEST'), 'installs before the task is raised');
});

test('compact-vhdx.ps1 embeds all three values and pins the data folder', () => {
  assert.match(COMPACT, /"`n\} -Vhdx " \+ \(ConvertTo-PsLiteral \$Vhdx\) \+/);
  assert.match(COMPACT, /' -Status ' \+ \(ConvertTo-PsLiteral \$Status\) \+/);
  assert.match(COMPACT, /' -DataDir ' \+ \(ConvertTo-PsLiteral \$DataDir\) \+ ' -Elevated'/);
  assert.match(COMPACT, /if \(-not \$DataDir -and \$PSScriptRoot\) \{ \$DataDir = Join-Path \$PSScriptRoot 'data' \}/);
});

test('compact-vhdx.ps1 pipes diskpart its commands instead of a %TEMP% script', () => {
  assert.doesNotMatch(COMPACT, /diskpart\.exe'\) \/s|\/s \$script|xenon-compact-/);
  assert.doesNotMatch(COMPACT, /\$env:TEMP/);
  assert.match(COMPACT, /\$diskpart = Join-Path \(\[Environment\]::SystemDirectory\) 'diskpart\.exe'/);
  assert.match(COMPACT, /\$out = \$commands \| & \$diskpart 2>&1 \| Out-String/);
  const cmds = COMPACT.slice(COMPACT.indexOf('$commands = @('), COMPACT.indexOf('$out = $commands'));
  assert.ok(cmds.indexOf("'compact vdisk'") < cmds.indexOf("'detach vdisk'"), 'the detach always follows');
});

test('compact-vhdx.ps1 writes its status only into server\\data, through no link', () => {
  const t = fnBody(COMPACT, 'Test-StatusPath');
  assert.match(t, /\(Split-Path -Leaf \$dir\) -ne 'data'/);
  assert.match(t, /\(Split-Path -Leaf \$serverDir\) -ne 'server'/);
  assert.match(t, /\[string\]::Equals\(\(Split-Path -Parent \$full\), \$dir, \[StringComparison\]::OrdinalIgnoreCase\)/, 'directly inside it');
  assert.match(t, /Test-IsLink \$di/);
  assert.match(t, /Test-IsLink \$fi/);
  const w = fnBody(COMPACT, 'Write-Status');
  assert.ok(w.indexOf('if (-not (Test-StatusPath)) { return }') < w.indexOf('[IO.File]::Open'), 're-checked on every write');
  assert.match(w, /\[IO\.FileMode\]::CreateNew/);
  // Checked before the prompt as well.
  assert.ok(COMPACT.indexOf('if (-not (Test-StatusPath)) { exit 2 }') < COMPACT.indexOf('-Verb RunAs'));
});

test('compact-vhdx.ps1 does not take a WSL BasePath from HKCU on trust', () => {
  const allow = fnBody(COMPACT, 'Get-AllowedVhdx');
  assert.match(allow, /Where-Object \{ Test-UserOwnedDisk \$_ \}/);
  const own = fnBody(COMPACT, 'Test-UserOwnedDisk');
  assert.match(own, /GetFolderPath\(\[Environment\+SpecialFolder\]::UserProfile\)/, 'the profile from the known-folder API');
  assert.match(own, /if \(Test-IsLink \$di\) \{ \$clean = \$false; break \}/, 'no link on the way down');
  assert.match(own, /GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)/);
  assert.match(own, /\.Equals\(\[Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)\.User\)/, 'or owned by this user');
});
