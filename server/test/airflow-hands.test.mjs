// Airflow's hands on Windows (server/fan-hands.ps1, inside the SYSTEM sensor
// service): commands only as file names, the service's own rules (lease, heat,
// lost sensor, clamping), the note that tells a later run which fans it cannot
// hand back to the BIOS, and how the service carries it. The rules run for real
// in Windows PowerShell against fake LHM controls that log every write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { tjMax, PUMP_FLOOR } = require('../airflow/limits.js');
const { SCRIPTS } = require('../sensor-service/reader.js');

const SERVER = new URL('../', import.meta.url);
const read = (leaf) => readFileSync(new URL(leaf, SERVER), 'utf8');
// The rules, and the service's side (LHM and the files) that runs them.
const HANDS = read('fan-hands.ps1') + read('fan-hands-lhm.ps1');
const SERVICE = read('sensor-service.ps1');
const ENABLE = read('enable-sensors.ps1');

const CPUS = ['AMD Ryzen 7 9700X', 'AMD Ryzen 7 7800X3D', 'AMD Ryzen 9 5950X', 'AMD Ryzen 7 5800X3D', 'AMD Ryzen 9 9950X3D',
  'AMD Ryzen 5 3600', 'Intel Core i9-13900K', 'Intel Core Ultra 9 285K', 'Some Chip'];

// Every scenario in one PowerShell run; the answers come back as one JSON object.
const HARNESS = `param([string]$Hands, [string]$Dir, [string]$Marker)
$ErrorActionPreference = 'Stop'
. $Hands
$script:saved = New-Object System.Collections.ArrayList
$okSave = { param($Ids) [void]$script:saved.Add((@($Ids) -join ',')); return $true }
$failSave = { param($Ids) return $false }
function New-Fake([string]$Id, [string]$Type = 'mb', [int]$Min = 0, [int]$Max = 100) {
  $c = [pscustomobject]@{ log = (New-Object System.Collections.ArrayList) }
  $c | Add-Member -MemberType ScriptMethod -Name SetSoftware -Value { param($v) [void]$this.log.Add('s' + [int]$v) }
  $c | Add-Member -MemberType ScriptMethod -Name SetDefault -Value { [void]$this.log.Add('d') }
  return @{ id = $Id; hw = 'Chip'; type = $Type; name = $Id; min = $Min; max = $Max; control = $c }
}
function Log($Ctl) { return (@($Ctl.control.log) -join ' ') }
$S1 = New-Object object
$S2 = New-Object object
$cool = @{ cpu = 50; gpu = 45 }
function Hw($Controls, $Temps = $cool, [string]$Cpu = 'AMD Ryzen 7 9700X') { return @{ controls = @($Controls); temps = $Temps; cpuName = $Cpu } }
# A new name every second, as the engine sends them; the first one is a hello (gen 0).
function Drive($St, $Hw, [string]$Set, [long]$From, [long]$To, $Session = $S1, $Save = $okSave) {
  $last = $null
  for ($t = $From; $t -le $To; $t += 1000) { $last = Step-FanHands $St $Hw ('fan-' + $St.gen + '-' + $t + $Set) $t $Session $Save }
  return $last
}
$r = [ordered]@{}

$names = @('fan-5-10-c0_40-c3_d', 'fan-5-10', 'FAN-5-10', 'fan-5-10-c0_101', 'fan-5-10-c0_1-c0_2', 'fan-5-10-c0_40.', 'fan--10', 'fan-5-10-c100_4',
  ('fan-5-10' + ((0..31 | ForEach-Object { '-c' + $_ + '_1' }) -join '')), ('fan-5-10' + ((0..32 | ForEach-Object { '-c' + $_ + '_1' }) -join '')))
$r.parse = @($names | ForEach-Object {
  $c = ConvertFrom-FanCommandName $_
  if ($c) { '' + $c.gen + '/' + $c.seq + '/' + (($c.set.Keys | Sort-Object | Select-Object -First 2 | ForEach-Object { '' + $_ + '=' + $c.set[$_] }) -join ',') } else { 'x' }
})
$r.pick = Get-FanCommandName $Dir
$r.pickMissing = $null -eq (Get-FanCommandName (Join-Path $Dir 'nope'))

$a = New-Fake 'a'; $b = New-Fake 'b' 'gpu' 30
$St = New-FanHandsState; $script:saved.Clear()
$hw = Hw @($a, $b)
[void](Step-FanHands $St $hw 'fan-0-1' 1000 $S1 $okSave)
$gen = $St.gen
[void](Step-FanHands $St $hw ('fan-' + $gen + '-2-c0_40-c1_10') 2000 $S1 $okSave)
[void](Step-FanHands $St $hw ('fan-' + $gen + '-3-c0_40-c1_10') 3000 $S1 $okSave)
$s4 = Step-FanHands $St $hw ('fan-' + $gen + '-4-c0_d-c1_50') 4000 $S1 $okSave
$s8 = Step-FanHands $St $hw ('fan-' + $gen + '-4-c0_d-c1_50') 8999 $S1 $okSave
$s9 = Step-FanHands $St $hw ('fan-' + $gen + '-4-c0_d-c1_50') 9000 $S1 $okSave
$r.obey = [ordered]@{ gen = $gen; a = Log $a; b = Log $b; saved = @($script:saved); heldA4 = $s4.controls[0].held; heldB8 = $s8.controls[1].held
  guard9 = $s9.guard; held9 = $St.held.Count; marker9 = @($St.marker); status = $s4 }

$a = New-Fake 'a'; $St = New-FanHandsState
[void](Step-FanHands $St (Hw @($a)) 'fan-0-1' 1000 $S1 $okSave)
$g = $St.gen
[void](Step-FanHands $St (Hw @($a)) ('fan-' + ($g + 1) + '-2-c0_40') 2000 $S1 $okSave)
[void](Step-FanHands $St (Hw @($a)) 'fan-0-3-c0_40' 3000 $S1 $okSave)
[void](Step-FanHands $St (Hw @($a)) ('fan-' + $g + '-4-c0_40-c0_50') 4000 $S1 $okSave)
$before = Log $a
$c = New-Fake '0first'
[void](Step-FanHands $St (Hw @($a, $c)) ('fan-' + $g + '-6-c0_40') 6000 $S1 $okSave)
$r.gen = [ordered]@{ before = $before; after = (Log $a) + '|' + (Log $c); newGen = $St.gen -gt $g }

$a = New-Fake 'a'; $St = New-FanHandsState; $St.marker = @('a')
$s1 = Step-FanHands $St (Hw @($a)) 'fan-0-1' 1000 $S1 $okSave
$adopt = Log $a; $mode1 = $s1.controls[0].held; $rest1 = $s1.controls[0].restorable
$g = $St.gen
[void](Step-FanHands $St (Hw @($a)) ('fan-' + $g + '-2-c0_70') 2000 $S1 $okSave)
[void](Step-FanHands $St (Hw @($a)) ('fan-' + $g + '-3-c0_d') 3000 $S1 $okSave)
$s = Step-FanHands $St (Hw @($a)) ('fan-' + $g + '-3-c0_d') 60000 $S1 $okSave
$r.marker = [ordered]@{ adopt = $adopt; mode1 = $mode1; rest1 = $rest1; log = Log $a; mode = $s.controls[0].held; held = $St.held.Count }

$a = New-Fake 'a'; $St = New-FanHandsState
[void](Drive $St (Hw @($a)) '-c0_40' 1000 3000 $S1)
[void](Drive $St (Hw @($a)) '-c0_d' 4000 4000 $S2)
$r.session = Log $a

$a = New-Fake 'a'; $z = New-Fake 'z'; $St = New-FanHandsState
[void](Drive $St (Hw @($a, $z)) '-c0_40' 1000 2000)
$hot = Drive $St (Hw @($a, $z) @{ cpu = 93; gpu = 45 }) '-c0_40' 3000 3000
$warm = Drive $St (Hw @($a, $z) @{ cpu = 85; gpu = 45 }) '-c0_40' 4000 80000
$cooling = Drive $St (Hw @($a, $z) @{ cpu = 80; gpu = 45 }) '-c0_40' 81000 140000
$back = Drive $St (Hw @($a, $z) @{ cpu = 80; gpu = 45 }) '-c0_40' 141000 141000
$r.hot = [ordered]@{ log = Log $a; untouched = Log $z; guard = $hot.guard; warm = $warm.controls[0].held; cooling = $cooling.controls[0].held; back = $back.controls[0].held; backHot = $back.hot }

$a = New-Fake 'a'; $St = New-FanHandsState
$gpuHot = Drive $St (Hw @($a) @{ cpu = 50; gpu = 60; gpuMem = 102 }) '-c0_40' 1000 2000
$r.hotMem = [ordered]@{ log = Log $a; guard = $gpuHot.guard }

$r.limits = @($args | ForEach-Object { (Get-FanHotLimits $_).cpu })

$a = New-Fake 'a'; $b = New-Fake 'b' 'gpu'; $St = New-FanHandsState
[void](Drive $St (Hw @($a, $b)) '-c0_40-c1_40' 1000 2000)
$blind = @{ cpu = $null; gpu = 45 }
$s7 = Drive $St (Hw @($a, $b) $blind) '-c0_40-c1_40' 3000 7000
$s8 = Drive $St (Hw @($a, $b) $blind) '-c0_40-c1_40' 8000 8000
$r.sensor = [ordered]@{ a = Log $a; b = Log $b; held7 = $s7.controls[0].held; guard8 = $s8.guard; held8 = $s8.controls[0].held }

$b = New-Fake 'b' 'gpu' 30; $m = New-Fake 'm'; $St = New-FanHandsState
[void](Drive $St (Hw @($b, $m)) '-c0_0-c1_0' 1000 2000)
$first = (Log $b) + '|' + (Log $m)
[void](Drive $St (Hw @($b, $m)) '-c0_50-c1_0' 3000 3000)
[void](Drive $St (Hw @($b, $m)) '-c0_0-c1_0' 4000 4000)
$r.zero = [ordered]@{ first = $first; b = Log $b }

$p = New-Fake 'aio-pump'; $f = New-Fake 'f'; $St = New-FanHandsState
[void](Drive $St (Hw @($p, $f)) '-c0_10-c1_10' 1000 2000)
$p2 = New-Fake 'Pump Fan'; $St2 = New-FanHandsState; $St2.marker = @('Pump Fan')
[void](Step-FanHands $St2 (Hw @($p2) @{ cpu = 30; gpu = 30 }) 'fan-0-1' 1000 $S1 $okSave)
$r.pump = [ordered]@{ pump = Log $p; fan = Log $f; curve = Log $p2; floor = $FanPumpFloor }

$a = New-Fake 'a'; $St = New-FanHandsState
[void](Drive $St (Hw @($a)) '-c0_40' 1000 2000 $S1 $failSave)
$r.noNote = [ordered]@{ log = Log $a; held = $St.held.Count }

$m = New-Fake 'm'; $gc = New-Fake 'g' 'gpu'
$r.curve = @((Get-FanSafetyDuty $m @{ cpu = 30; gpu = 30 }), (Get-FanSafetyDuty $m @{ cpu = 45; gpu = 55 }), (Get-FanSafetyDuty $m @{ cpu = 55; gpu = $null }),
  (Get-FanSafetyDuty $gc @{ cpu = 90; gpu = 65 }), (Get-FanSafetyDuty $m @{ cpu = $null; gpu = $null }), (Get-FanSafetyDuty $gc @{ cpu = 50; gpu = -50 }))

$a = New-Fake 'a'; $b = New-Fake 'b'; $St = New-FanHandsState; $St.marker = @('b')
[void](Drive $St (Hw @($a, $b)) '-c0_40-c1_40' 1000 2000)
Stop-FanHandsControls $St @($a, $b) $okSave
$r.stop = [ordered]@{ a = Log $a; b = Log $b; marker = @($St.marker) }

$a = New-Fake 'a'; $St = New-FanHandsState
$r.idle = $null -eq (Step-FanHands $St (Hw @($a)) '' 100000 $S1 $okSave)
$a3 = New-Fake 'a'; $St3 = New-FanHandsState; $St3.marker = @('a')
[void](Step-FanHands $St3 (Hw @($a3)) '' 100000 $S1 $okSave)
$r.idleNoted = Log $a3

$a = New-Fake 'a'; $b = New-Fake 'b'; $St = New-FanHandsState; $St.marker = @('zz')
[void](Drive $St (Hw @($a, $b)) '-c0_40-c1_40' 1000 2000)
[void](Step-FanHands $St (Hw @($b)) 'x' 2500 $S1 $okSave)
$St2 = New-FanHandsState; $St2.marker = @('a')
[void](Step-FanHands $St2 (Hw @()) 'fan-0-1' 1000 $S1 $okSave)
$r.gone = [ordered]@{ a = Log $a; b = Log $b; held = @($St.held.Keys); marker = @($St.marker); keepOnEmpty = @($St2.marker) }

$r.markerSame = @(Read-FanMarker $Marker 1060000)
$r.markerOld = @(Read-FanMarker $Marker 9000000)
$r.markerUnknown = @(Read-FanMarker $Marker 0)
$r.markerMissing = @(Read-FanMarker ($Marker + '.none') 1000000)

[Console]::Out.Write(($r | ConvertTo-Json -Depth 8 -Compress))
`;

let cached;
function runHarness() {
  if (cached) return cached;
  const root = mkdtempSync(join(tmpdir(), 'xenon-fan-hands-'));
  try {
    const dir = join(root, 'fan');
    mkdirSync(dir);
    for (const n of ['fan-5-10-c0_40', 'fan-5-9-c0_1', 'fan-5-12', 'fan-5-11-c0_d', 'FAN-5-99', 'fan-5-13-c0_101', 'fan-5-14-c0_1-c0_2', 'other']) writeFileSync(join(dir, n), '');
    mkdirSync(join(dir, 'fan-5-50'));
    const marker = join(root, 'fan-held.json');
    writeFileSync(marker, JSON.stringify({ boot: 1000000, ids: ['a', 5, 'b', 'x'.repeat(200)] }));
    const harness = join(root, 'harness.ps1');
    writeFileSync(harness, HARNESS);
    const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const hands = fileURLToPath(new URL('fan-hands.ps1', SERVER));
    const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness, '-Hands', hands, '-Dir', dir, '-Marker', marker, ...CPUS],
      { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    cached = JSON.parse(out);
    return cached;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const win = { skip: process.platform !== 'win32' };

test('command names: a strict grammar, read from the listing alone', win, () => {
  const r = runHarness();
  assert.deepEqual(r.parse, ['5/10/0=40,3=d', '5/10/', 'x', 'x', 'x', 'x', 'x', 'x', '5/10/0=1,1=1', 'x']);
  assert.equal(r.pick, 'fan-5-12', 'the highest seq among valid names, not the last listed; folders and bad names skipped');
  assert.equal(r.pickMissing, true);
});

test('obeys the current list only, clamped to each control, writing on change', win, () => {
  const { obey } = runHarness();
  assert.equal(obey.a, 's40 d', 'd hands the control back to the firmware');
  assert.equal(obey.b, 's30 s50 d', '10 % on a card whose floor is 30 is 30; the same value twice is one write');
  assert.deepEqual(obey.saved, ['a', 'a,b', 'b', ''], 'the note is written before the first write and cleared on hand-back');
  assert.equal(obey.heldA4, null);
  assert.equal(obey.heldB8, 'set', 'still held just under the lease');
  assert.equal(obey.guard9, 'lease', 'five seconds without a new name: everything back');
  assert.equal(obey.held9, 0);
  assert.deepEqual(obey.marker9, []);
  const c = obey.status.controls[1];
  assert.deepEqual([c.k, c.id, c.type, c.min, c.max, c.held, c.duty, c.restorable], [1, 'b', 'gpu', 30, 100, 'set', 50, true]);
  assert.equal(obey.status.gen, obey.gen);
});

test('a command for another list, a hello or a broken name moves nothing; a new list gets a new gen', win, () => {
  const { gen } = runHarness();
  assert.equal(gen.before, '');
  assert.equal(gen.after, '|', 'a command for the old numbering is not obeyed once a control appears');
  assert.equal(gen.newGen, true);
});

test('a fan an earlier run of this boot left behind stays on the safety curve, never "back" to Xenon\'s last value', win, () => {
  const { marker } = runHarness();
  assert.equal(marker.adopt, 's53', 'taken onto the curve at once (CPU 50: 53 %)');
  assert.equal(marker.mode1, 'curve');
  assert.equal(marker.rest1, false);
  assert.equal(marker.log, 's53 s70 s53', 'obeys while asked, and goes back to the curve, not SetDefault');
  assert.equal(marker.mode, 'curve');
  assert.equal(marker.held, 1);
});

test('a new LHM session loses what the old one saved: the curve instead of SetDefault', win, () => {
  assert.equal(runHarness().session, 's40 s53');
});

test('heat: 100 % past the service\'s own level, until a minute 10 degrees under it', win, () => {
  const { hot, hotMem } = runHarness();
  assert.equal(hot.log, 's40 s100 s40');
  assert.equal(hot.untouched, '', 'a fan Xenon was not asked to drive stays with the BIOS, even when hot');
  assert.equal(hot.guard, 'hot');
  assert.equal(hot.warm, 'hot', 'still within 10 degrees: still hot');
  assert.equal(hot.cooling, 'hot', 'a minute is not up yet');
  assert.equal(hot.back, 'set');
  assert.equal(hot.backHot, false);
  assert.equal(hotMem.log, 's100', 'graphics memory at its level counts too');
  assert.equal(hotMem.guard, 'hot');
});

test('the CPU\'s hot level sits 2 degrees under the chip\'s TjMax, from the same table as limits.js', win, () => {
  const { limits } = runHarness();
  assert.deepEqual(limits, CPUS.map((c) => tjMax(c) - 2));
});

test('a temperature unreadable for five seconds hands back the fans that cool it', win, () => {
  const { sensor } = runHarness();
  assert.equal(sensor.held7, 'set');
  assert.equal(sensor.guard8, 'sensor');
  assert.equal(sensor.held8, null);
  assert.equal(sensor.a, 's40 d');
  assert.equal(sensor.b, 's40', 'the card\'s fans follow the card, which still reads');
});

test('zero: a header that allows it stops; a card with a floor goes back to its own stop logic', win, () => {
  const { zero } = runHarness();
  assert.equal(zero.first, '|s0');
  assert.equal(zero.b, 's50 d');
});

test('a pump is never run under the engine\'s pump floor, whatever is asked, on the curve too', win, () => {
  const { pump } = runHarness();
  assert.equal(pump.floor, PUMP_FLOOR, 'the service and limits.js agree');
  assert.equal(pump.pump, `s${PUMP_FLOOR}`, 'a cooler pump asked for 10 % runs at the floor');
  assert.equal(pump.fan, 's10', 'a fan is not a pump');
  assert.equal(pump.curve, `s${PUMP_FLOOR}`, 'the safety curve\'s 30 % is a pump\'s floor');
});

test('the service offers motherboard, NVIDIA, AMD and cooler controls; never Intel cards', () => {
  const lhm = read('fan-hands-lhm.ps1');
  const offer = /if \(\$type -eq 'Control' -and \$s\.Control -and \(([^\n]+)\)\) \{/.exec(lhm)?.[1] || '';
  for (const part of ["$kind -eq 'mb'", "$kind -eq 'ctrl'", "$top -eq 'GpuNvidia'", "$top -eq 'GpuAmd'"]) assert.ok(offer.includes(part), part);
  assert.equal(/Intel/i.test(offer), false);
  assert.ok(lhm.includes("gpu = $(if ($top -eq 'GpuAmd') { 'amd' } else { 'nvidia' })"), 'the card maker reaches the engine, which treats AMD as beta');
});

test('no note on disk, no write to the hardware', win, () => {
  assert.deepEqual(runHarness().noNote, { log: '', held: 0 });
});

test('the safety curve: 30 % cool, 100 % hot, 100 % blind', win, () => {
  assert.deepEqual(runHarness().curve, [30, 65, 65, 65, 100, 100], 'a case fan follows the hotter of CPU and card; a reading out of range is no reading');
});

test('stopping the service: SetDefault where it can, 100 % where it cannot', win, () => {
  const { stop } = runHarness();
  assert.equal(stop.a, 's40 d');
  assert.equal(stop.b, 's53 s40 s100');
  assert.deepEqual(stop.marker, ['b'], 'the next run still knows');
});

test('nobody asking and nothing held: no work at all; a fan left behind is still looked after', win, () => {
  assert.equal(runHarness().idle, true);
  assert.equal(runHarness().idleNoted, 's53');
});

test('a control the hardware no longer lists is forgotten, but never on an empty list', win, () => {
  const { gone } = runHarness();
  assert.equal(gone.a, 's40', 'nothing written to a device that is gone');
  assert.equal(gone.b, 's40 d', 'the new list makes a new gen: the old command lapses');
  assert.deepEqual(gone.held, []);
  assert.deepEqual(gone.marker, []);
  assert.deepEqual(gone.keepOnEmpty, ['a'], 'a session that listed nothing proves nothing');
});

test('the note: this boot only, unknown boot keeps it, bad ids dropped', win, () => {
  const r = runHarness();
  assert.deepEqual(r.markerSame, ['a', 'b']);
  assert.deepEqual(r.markerOld, []);
  assert.deepEqual(r.markerUnknown, ['a', 'b']);
  assert.deepEqual(r.markerMissing, []);
});

test('the service carries the hands: installed, hashed, ticking and handing back on exit', () => {
  const listed = (text, start) => text.slice(text.indexOf(start), text.indexOf(')', text.indexOf(start)));
  for (const f of ['fan-hands.ps1', 'fan-hands-lhm.ps1']) {
    assert.ok(SCRIPTS.includes(f), `${f}: the engine hashes it too, a changed copy shows "update sensors"`);
    assert.ok(listed(ENABLE, '$ServiceFiles = @(').includes(`'${f}'`), `${f} installed`);
    assert.ok(listed(SERVICE, 'foreach ($f in @(').includes(`'${f}'`), `${f} in the heartbeat hash`);
  }
  assert.match(ENABLE, /New-AdminFolder \(Join-Path \$readings 'fan'\) \$Sid 'Write, Delete'/, 'the user adds and removes command names, never folders');
  assert.match(SERVICE, /\. \(Join-Path \$here 'fan-hands\.ps1'\)\s+\. \(Join-Path \$here 'fan-hands-lhm\.ps1'\)\s+Initialize-FanHands/);
  assert.ok(SERVICE.indexOf('. (Join-Path $here') > SERVICE.indexOf('$mutex.WaitOne(0)'), 'only the instance that holds the lock');
  const fin = SERVICE.slice(SERVICE.lastIndexOf('} finally {'));
  assert.ok(fin.indexOf('Stop-FanHands') > 0 && fin.indexOf('Stop-FanHands') < fin.indexOf('Close-Sessions'), 'fans handed back before the session closes');
  assert.match(SERVICE, /Start-Sleep -Milliseconds \$\(if \(\$fanActive\) \{ 1000 \}/);
});

test('the hands never open what the user can write', () => {
  assert.equal((HANDS.match(/ReadAll|Get-Content|OpenRead|\[IO\.File\]::Open/g) || []).length, 1, 'one read: the note, in the admin-only folder');
  assert.match(HANDS, /Read-FanMarker \(Join-Path \$OutDir \$FanMarkerLeaf\)/);
  assert.match(HANDS, /EnumerateFiles\('fan-\*'\)/);
  assert.match(HANDS, /ReparsePoint/);
  assert.match(HANDS, /Write-Snapshot 'fan\.json'/);
  assert.match(HANDS, /Write-Snapshot \$FanMarkerLeaf/);
  assert.match(HANDS, /\$top -eq 'GpuNvidia'/, 'cards other than NVIDIA keep their own fans');
});

// The task starts the service below normal, and below normal waits behind every busy normal
// thread: a test run on every core of a real PC kept these rules from running for minutes
// (23 Nov 2026). While the hands work the service runs above normal, then goes back.
const PRIORITY = `param([string]$Lhm)
$ErrorActionPreference = 'Stop'
. $Lhm
$p = [Diagnostics.Process]::GetCurrentProcess()
function Now { $p.Refresh(); return '' + $p.PriorityClass }
$r = [ordered]@{}
$p.PriorityClass = 'BelowNormal'
Set-FanHandsPriority $true; $r.active = Now
Set-FanHandsPriority $true; $r.again = Now
Set-FanHandsPriority $false; $r.rest = Now
Set-FanHandsPriority $false; $r.restAgain = Now
$p.PriorityClass = 'High'
Set-FanHandsPriority $true; $r.high = Now
Set-FanHandsPriority $false; $r.highRest = Now
$p.PriorityClass = 'BelowNormal'
Set-FanHandsPriority $true; $p.PriorityClass = 'Normal'; Set-FanHandsPriority $false; $r.chosen = Now
$r | ConvertTo-Json -Compress
`;

test('the service runs above normal while the hands work, then back to its own place', win, () => {
  const root = mkdtempSync(join(tmpdir(), 'xenon-fan-priority-'));
  try {
    const harness = join(root, 'priority.ps1');
    writeFileSync(harness, PRIORITY);
    const ps = join(process.env.SystemRoot || 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const lhm = fileURLToPath(new URL('fan-hands-lhm.ps1', SERVER));
    const r = JSON.parse(execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness, '-Lhm', lhm],
      { windowsHide: true, encoding: 'utf8', timeout: 60000 }));
    assert.deepEqual(r, {
      active: 'AboveNormal', again: 'AboveNormal', rest: 'BelowNormal', restAgain: 'BelowNormal',
      high: 'High', highRest: 'High', chosen: 'Normal',
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
  assert.match(SERVICE, /\$fanActive = Test-FanHandsActive \$fanName \$now\s+Set-FanHandsPriority \$fanActive/, 'the service loop follows the hands');
});
