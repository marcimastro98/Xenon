// How the sensor service puts a reading in place (server/sensor-service.ps1 Write-Snapshot):
// a rename over the old file (MoveFileEx), never File.Replace, which stalled for up to 13 s
// as SYSTEM under a full-core load and let the fans fall back to the BIOS (23 Nov 2026).
// The service's own functions run for real in Windows PowerShell on a scratch folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const { SCRIPTS } = createRequire(import.meta.url)('../sensor-service/reader.js');
const SERVICE = readFileSync(new URL('../sensor-service.ps1', import.meta.url), 'utf8');
const win = { skip: process.platform !== 'win32' };

function snapshotCode() {
  const from = SERVICE.indexOf('function New-SnapshotMove');
  const to = SERVICE.indexOf('function Write-Reading');
  assert.ok(from > 0 && to > from, 'the snapshot functions sit before Write-Reading');
  return SERVICE.slice(from, to);
}

const HARNESS = (code) => `param([string]$OutDir)
$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
function Test-OutDir { return $true }
${code}
$r = [ordered]@{ move = [bool]$SnapshotMove }
$a = Join-Path $OutDir 'a.json'
Write-Snapshot 'a.json' '{"n":1}'
[IO.File]::SetAttributes($a, 'Hidden, Archive')
Write-Snapshot 'a.json' '{"n":2}'
$r.text = [IO.File]::ReadAllText($a)
$r.hidden = [bool]([IO.File]::GetAttributes($a) -band [IO.FileAttributes]::Hidden)
$r.tmp = [IO.File]::Exists("$a.tmp")
$null = New-Item -ItemType Directory (Join-Path $OutDir 'b.json')
$r.blocked = try { Write-Snapshot 'b.json' '{}'; 'written' } catch { 'threw' }
$r | ConvertTo-Json -Compress
`;

test('a reading replaces the old one by a rename, and a swap that fails throws', win, () => {
  const root = mkdtempSync(join(tmpdir(), 'xenon-snapshot-'));
  try {
    const out = join(root, 'out');
    mkdirSync(out);
    const script = join(root, 'harness.ps1');
    writeFileSync(script, HARNESS(snapshotCode()));
    const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const raw = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutDir', out], { windowsHide: true, timeout: 60000, encoding: 'utf8' });
    const r = JSON.parse(raw.trim());
    assert.equal(r.move, true, 'MoveFileEx is declared in memory in Windows PowerShell');
    assert.equal(r.text, '{"n":2}', 'the new reading is in place');
    assert.equal(r.tmp, false, 'no .tmp left behind');
    // File.Replace carries the old file's attributes over; a rename over it does not.
    assert.equal(r.hidden, false, 'swapped by a rename, not by File.Replace');
    assert.equal(r.blocked, 'threw', 'a swap that cannot happen is never taken as written');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the service compiles nothing: the move is declared in memory', () => {
  for (const f of SCRIPTS) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /Add-Type\s+(?:-TypeDefinition|-MemberDefinition|-Source)|Add-Type\s+@/i, `${f} compiles no code`);
  }
  assert.match(snapshotCode(), /DefinePInvokeMethod\('MoveFileExW', 'kernel32\.dll'/);
});
