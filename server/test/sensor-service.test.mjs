// The sensor service (server/sensor-service.ps1, run elevated from Program Files)
// and the engine's side of it (server/sensor-service/). The engine never runs
// elevated since 5.1.0: kernel sensors come from the service's readings, and
// anything missing falls back to the engine's own unelevated scripts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { createSensorService, SCRIPTS } = require('../sensor-service/reader.js');
const { migrateElevatedEngine, MARKER, HIGH_INTEGRITY } = require('../sensor-service/migrate.js');

const SERVER = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, SERVER), 'utf8');

function rig({ now = 1_000_000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'xenon-sensor-svc-'));
  const env = { ProgramData: join(root, 'pd'), LOCALAPPDATA: join(root, 'lad') };
  const readings = join(env.ProgramData, 'Xenon Sensors');
  mkdirSync(join(readings, 'want'), { recursive: true }); // enable-sensors.ps1 makes both
  const serverDir = join(root, 'server');
  mkdirSync(serverDir);
  for (const f of SCRIPTS) writeFileSync(join(serverDir, f), 'script ' + f);
  const clock = { t: now };
  const svc = createSensorService({ env, serverDir, platform: 'win32', now: () => clock.t });
  const put = (leaf, o) => writeFileSync(join(readings, leaf), JSON.stringify(o));
  return { root, env, readings, serverDir, clock, svc, put, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('no service: every answer is null and the engine reads on its own', async () => {
  const r = rig();
  try {
    assert.equal(await r.svc.cpu(5000), null);
    assert.equal(await r.svc.state(), null);
    const raw = { ok: true, lhm: true, sensors: [{ id: '/gpu/0/temperature/0' }] };
    assert.equal(await r.svc.mergeSensors(raw, null), raw);
    assert.equal(existsSync(r.svc.wantFile(5000)), false, 'nothing asked of a service that is not there');
  } finally { r.done(); }
});

test('a heartbeat older than a minute counts as no service', async () => {
  const r = rig();
  try {
    r.put('service.json', { v: 1, hash: 'x', pid: 1, at: r.clock.t - 61000 });
    r.put('cpu.json', { at: r.clock.t, data: { cpuTemp: 50, sensorAccess: 'ok' } });
    assert.equal(await r.svc.cpu(5000), null);
  } finally { r.done(); }
});

test('a running service answers the CPU reading and is asked for the next one', async () => {
  const r = rig();
  try {
    r.put('service.json', { v: 1, hash: 'x', pid: 1, at: r.clock.t });
    r.put('cpu.json', { at: r.clock.t - 1000, data: { cpuTemp: 51.5, fans: [], sensorAccess: 'ok' } });
    const data = await r.svc.cpu(2000);
    assert.equal(data.cpuTemp, 51.5);
    assert.ok(existsSync(join(r.readings, 'want', 'want-2000')), 'the refresh interval is the name of the entry');
  } finally { r.done(); }
});

test('the interval in the want file is clamped to what the service accepts', async () => {
  const r = rig();
  try {
    r.put('service.json', { v: 1, hash: 'x', pid: 1, at: r.clock.t });
    await r.svc.cpu(50);
    assert.ok(existsSync(join(r.readings, 'want', 'want-1000')));
    r.clock.t += 6000;
    r.put('service.json', { v: 1, hash: 'x', pid: 1, at: r.clock.t });
    await r.svc.cpu(999999);
    assert.ok(existsSync(join(r.readings, 'want', 'want-10000')));
    assert.equal(r.svc.wantFile(2499), join(r.readings, 'want', 'want-2000'), 'whole seconds: at most ten names');
  } finally { r.done(); }
});

test('the engine never makes the want folder: it is the service\'s, with its rules', async () => {
  const r = rig();
  try {
    rmSync(join(r.readings, 'want'), { recursive: true });
    r.put('service.json', { v: 1, hash: 'x', pid: 1, at: r.clock.t });
    await r.svc.cpu(5000);
    assert.equal(existsSync(join(r.readings, 'want')), false);
  } finally { r.done(); }
});

test('while the service wakes, the last reading bridges the gap, then a waking answer', async () => {
  const r = rig();
  try {
    r.put('service.json', { v: 1, hash: 'x', pid: 1, at: r.clock.t });
    // Nothing read yet: no temperature, but no reason to offer "Enable sensors".
    const waking = await r.svc.cpu(5000);
    assert.equal(waking.cpuTemp, null);
    assert.equal(waking.sensorAccess, 'ok');
    r.put('cpu.json', { at: r.clock.t, data: { cpuTemp: 44, sensorAccess: 'ok' } });
    assert.equal((await r.svc.cpu(5000)).cpuTemp, 44);
    // The reading goes stale (service busy): kept for up to a minute.
    r.clock.t += 20000;
    r.put('service.json', { v: 1, hash: 'x', pid: 1, at: r.clock.t });
    assert.equal((await r.svc.cpu(5000)).cpuTemp, 44);
    r.clock.t += 50000;
    r.put('service.json', { v: 1, hash: 'x', pid: 1, at: r.clock.t });
    assert.equal((await r.svc.cpu(5000)).cpuTemp, null);
  } finally { r.done(); }
});

test('service rows win on a shared id and the engine keeps its own GPU rows', async () => {
  const r = rig();
  try {
    r.put('service.json', { v: 1, hash: 'x', pid: 1, at: r.clock.t });
    r.put('sensors.json', { at: r.clock.t, data: { ok: true, lhm: true, sensors: [
      { id: '/amdcpu/0/temperature/2', value: 61 },
      { id: '/lpc/nct6799d/0/fan/1', value: 900 },
    ] } });
    const own = { ok: true, lhm: false, sensors: [{ id: '/amdcpu/0/temperature/2', value: null }, { id: '/gpu-nvidia/0/temperature/0', value: 40 }] };
    const all = await r.svc.mergeSensors(own, null);
    assert.equal(all.lhm, true);
    assert.deepEqual(all.sensors.map((s) => [s.id, s.value]), [
      ['/amdcpu/0/temperature/2', 61], ['/lpc/nct6799d/0/fan/1', 900], ['/gpu-nvidia/0/temperature/0', 40],
    ]);
    const some = await r.svc.mergeSensors(null, ['/lpc/nct6799d/0/fan/1']);
    assert.deepEqual(some.sensors.map((s) => s.id), ['/lpc/nct6799d/0/fan/1'], 'read mode keeps only the ids asked for');
  } finally { r.done(); }
});

test('a broken or oversized reading is ignored, never thrown', async () => {
  const r = rig();
  try {
    r.put('service.json', { v: 1, hash: 'x', pid: 1, at: r.clock.t });
    writeFileSync(join(r.readings, 'sensors.json'), '{not json');
    const own = { ok: true, lhm: true, sensors: [] };
    assert.equal(await r.svc.mergeSensors(own, null), own);
    writeFileSync(join(r.readings, 'cpu.json'), 'x'.repeat(2 * 1024 * 1024 + 1));
    assert.equal((await r.svc.cpu(5000)).cpuTemp, null);
  } finally { r.done(); }
});

test('the service is out of date when its scripts differ from the engine\'s', async () => {
  const r = rig();
  try {
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256');
    for (const f of SCRIPTS) sha.update(readFileSync(join(r.serverDir, f)));
    const mine = sha.digest('hex');
    r.put('service.json', { v: 1, hash: mine, pid: 1, at: r.clock.t });
    assert.deepEqual(await r.svc.state(), { running: true, outdated: false });
    const other = createSensorService({ env: r.env, serverDir: r.serverDir, platform: 'win32', now: () => r.clock.t });
    r.put('service.json', { v: 1, hash: 'f'.repeat(64), pid: 1, at: r.clock.t });
    assert.deepEqual(await other.state(), { running: true, outdated: true });
  } finally { r.done(); }
});

test('off Windows the reader is inert', async () => {
  const svc = createSensorService({ env: { LOCALAPPDATA: '/tmp' }, platform: 'linux' });
  assert.equal(await svc.cpu(5000), null);
  assert.equal(await svc.state(), null);
});

// -- migration of an engine raised before 5.1.0 --------------------------------

function fakeRun(answers) {
  const calls = [];
  const run = (file, args, _opts, cb) => {
    calls.push([file, args]);
    const key = Object.keys(answers).find((k) => file.toLowerCase().endsWith(k));
    const a = answers[key];
    setImmediate(() => (a === null ? cb(new Error('failed')) : cb(null, a || '')));
  };
  return { run, calls };
}

function fakeStart() {
  const started = [];
  const start = (file, args, opts) => {
    started.push({ file, args, opts });
    return { on() {}, unref() {} };
  };
  return { start, started };
}

test('an elevated engine with its task moves to the sensor service once per version', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'xenon-migrate-'));
  try {
    const { run } = fakeRun({ 'whoami.exe': `"Mandatory Label\\High Mandatory Level","Label","${HIGH_INTEGRITY}",""`, 'schtasks.exe': 'ok' });
    const s = fakeStart();
    const opts = { dataDir, version: '5.1.0', script: 'C:\\x\\server\\enable-sensors.ps1', env: { SystemRoot: 'C:\\Windows' }, platform: 'win32', run, start: s.start };
    assert.equal(await migrateElevatedEngine(opts), 'started');
    assert.equal(s.started.length, 1);
    assert.match(s.started[0].file, /System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
    assert.deepEqual(s.started[0].args.slice(-2), ['-File', 'C:\\x\\server\\enable-sensors.ps1']);
    // A console-less (detached) powershell exits without running anything: the
    // migration never happened on the VM (11 Nov 2026).
    assert.notEqual(s.started[0].opts.detached, true);
    assert.equal(JSON.parse(readFileSync(join(dataDir, MARKER), 'utf8')).version, '5.1.0');
    assert.equal(await migrateElevatedEngine(opts), 'done_before', 'never a restart loop');
    assert.equal(s.started.length, 1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('an unelevated engine, or one without its task, is left alone', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'xenon-migrate-'));
  try {
    const s = fakeStart();
    const base = { dataDir, version: '5.1.0', script: 'x.ps1', env: {}, platform: 'win32', start: s.start };
    const medium = fakeRun({ 'whoami.exe': '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""', 'schtasks.exe': 'ok' });
    assert.equal(await migrateElevatedEngine({ ...base, run: medium.run }), 'not_elevated');
    const noTask = fakeRun({ 'whoami.exe': HIGH_INTEGRITY, 'schtasks.exe': null });
    assert.equal(await migrateElevatedEngine({ ...base, run: noTask.run }), 'no_task');
    assert.equal(await migrateElevatedEngine({ ...base, platform: 'darwin', run: medium.run }), 'skip');
    assert.equal(s.started.length, 0);
    assert.equal(existsSync(join(dataDir, MARKER)), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

// -- the scripts ---------------------------------------------------------------

const SERVICE = read('sensor-service.ps1');
const ENABLE = read('enable-sensors.ps1');
const INSTALL = read('install.ps1');

test('the service runs elevated only from its Program Files folder, with a clean environment', () => {
  assert.match(SERVICE, /if \(\$elevated\) \{[\s\S]*?ProgramFiles\)\) 'Xenon Sensors'[\s\S]*?exit 2/);
  assert.match(SERVICE, /\$OutDir = \$null\s+\}/, 'an elevated run takes no folder from its arguments');
  assert.doesNotMatch(SERVICE, /LocalApplicationData|LOCALAPPDATA|WantFile/, 'nothing from the user\'s profile');
  assert.match(SERVICE, /\$env:PATH = \$sys/);
  assert.match(SERVICE, /\$env:PSModulePath = Join-Path \$sys/);
  assert.match(SERVICE, /\$global:XenonTrustedLhmOnly = \$true/);
  assert.match(SERVICE, /Global\\XenonSensorService/, 'one per machine');
  assert.doesNotMatch(SERVICE, /Invoke-Expression|iex |Start-Process|-EncodedCommand/);
});

test('the service takes only a listed name and its time from the user, never opening a file', () => {
  const want = SERVICE.slice(SERVICE.indexOf('function Get-WantedInterval'), SERVICE.indexOf('function Test-OutDir'));
  assert.match(want, /\.EnumerateFiles\('want-\*'\)/, 'from the directory listing');
  assert.match(want, /\^want-\(\\d\{4,5\}\)\$/);
  assert.match(want, /\[Math\]::Min\(10000, \[Math\]::Max\(1000,/);
  assert.match(want, /ReparsePoint/, 'a link is skipped');
  assert.doesNotMatch(SERVICE, /ReadAllText|Get-Content|\[IO\.File\]::Open|OpenRead/, 'no file but its own is read');
  const out = SERVICE.slice(SERVICE.indexOf('function Test-OutDir'));
  assert.match(out, /S-1-5-32-544/, 'writes only into an admin-owned folder');
  assert.match(out, /S-1-5-18/);
});

test('cpu-temp.ps1 never loads a user-writable LibreHardwareMonitor in the service', () => {
  const cpu = read('cpu-temp.ps1');
  assert.match(cpu, /if \(-not \$global:XenonTrustedLhmOnly\) \{/);
  assert.doesNotMatch(cpu, /if \(\$true\) \{/);
});

test('enable-sensors.ps1 never raises the engine task, and lowers it', () => {
  assert.doesNotMatch(ENABLE, /\/RL HIGHEST/);
  // Through the task object: `schtasks /Change` on a user's task waited for a
  // password on a hidden console and the prompt never came back (VM, 11 Nov 2026).
  assert.match(ENABLE, /\$task\.Principal\.RunLevel = 'Limited'\s+\[void\]\(Set-ScheduledTask -InputObject \$task\)/);
  assert.doesNotMatch(ENABLE, /&\s*\$schtasks\s+\/Change/);
  assert.match(ENABLE, /-UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest/, 'the service runs as SYSTEM, never with the user\'s environment');
  assert.doesNotMatch(ENABLE, /S4U/);
  assert.match(ENABLE, /\$PerfLogUsers = 'S-1-5-32-559'/, 'PresentMon without administrator rights');
  assert.match(ENABLE, /Add-LocalGroupMember -SID \$PerfLogUsers -Member \$Sid/);
});

test('joining Performance Log Users is checked, tried twice and written down', () => {
  const add = ENABLE.slice(ENABLE.indexOf('function Add-FpsReader'), ENABLE.indexOf('function Write-FpsAccess'));
  assert.ok(add.length > 0, 'Add-FpsReader exists');
  assert.match(add, /FullyQualifiedErrorId\] -like 'MemberExists\*'|FullyQualifiedErrorId -like 'MemberExists\*'/, 'already in counts as in');
  // The cmdlet trips over a member Windows can no longer resolve; net.exe does not.
  assert.match(add, /'net\.exe'\) localgroup \$group \$Account \/add/);
  assert.match(add, /\\b1378\\b/, 'net.exe: already a member');
  assert.match(add, /\$ErrorActionPreference = 'Continue'/, 'stderr from net.exe must not throw before its code is read');
  assert.match(add, /return \$false/);
  // No silent catch left around the group: the outcome is recorded for the engine.
  assert.doesNotMatch(ENABLE, /Add-LocalGroupMember[^\n]*\}\s*catch\s*\{\s*\}/);
  assert.match(ENABLE, /Write-FpsAccess \$readings \$Sid \(Add-FpsReader \$Sid \$account\)/);
  const write = ENABLE.slice(ENABLE.indexOf('function Write-FpsAccess'), ENABLE.indexOf('# The service, its folders and its task.'));
  assert.match(write, /'fps-access-' \+ \$Sid \+ '\.json'/);
  assert.match(write, /"v":1,"sid":"/);
});

test('the elevated step finds winget in its own package, never on the user\'s PATH', () => {
  const find = ENABLE.slice(ENABLE.indexOf('function Get-WingetPath'), ENABLE.indexOf('function Invoke-Winget'));
  assert.match(find, /Get-AppxPackage -Name 'Microsoft\.DesktopAppInstaller'/);
  assert.match(find, /StartsWith\(\$pf \+ '\\WindowsApps\\'/, 'only under Program Files\\WindowsApps');
  assert.doesNotMatch(ENABLE, /Get-Command winget/, 'the alias lives in a folder the user can write');
});

test('install.ps1 registers the engine task at normal rights only', () => {
  assert.doesNotMatch(INSTALL, /RunLevel \$runLevel[\s\S]{0,40}Highest|'Highest'|\/RL HIGHEST|\$schtasksRunLevel/);
  assert.match(INSTALL, /\$runLevel = 'Limited'/);
  assert.match(INSTALL, /\/RL LIMITED/);
});

test('the readings folders are made with their own rules and renamed into place', () => {
  const acl = ENABLE.slice(ENABLE.indexOf('function New-FolderAcl'), ENABLE.indexOf('function New-AdminFolder'));
  assert.match(acl, /SetAccessRuleProtection\(\$true, \$false\)/, 'nothing inherited from ProgramData');
  assert.match(acl, /'S-1-5-32-545', 'ReadAndExecute'/, 'Users read only');
  assert.match(acl, /'CreateFiles'/, 'the user adds files to want, never folders or junctions');
  assert.match(acl, /'InheritOnly'/);
  assert.doesNotMatch(acl, /CreateDirectories/);
  const m = ENABLE.slice(ENABLE.indexOf('function New-AdminFolder'), ENABLE.indexOf('function Register-SensorTask'));
  assert.match(m, /NewGuid\(\)/, 'made under a name nobody can guess');
  assert.match(m, /\[IO\.Directory\]::CreateDirectory\(\$tmp, \$acl\)/, 'with its ACL from the first instant');
  assert.match(m, /\[IO\.Directory\]::Move\(\$tmp, \$Path\)/, 'a rename never lands on something already there');
  assert.match(m, /Test-AdminOwned/);
  assert.match(m, /Remove-TreeNoFollow \$Path/, 'a folder someone else made first is removed');
  assert.match(ENABLE, /New-AdminFolder \(Join-Path \$readings 'want'\) \$Sid/);
});

test('the elevated PowerShell loads modules and programs from system folders only', () => {
  const cmd = ENABLE.slice(ENABLE.indexOf('function New-ElevatedCommand'));
  const first = cmd.indexOf('$env:PSModulePath=');
  assert.ok(first > 0 && first < cmd.indexOf('ReadAllBytes'), 'before anything else runs');
  assert.match(cmd, /\$env:PATH=/);
  const already = ENABLE.slice(ENABLE.indexOf('if (Test-Elevated) {'));
  assert.match(already.slice(0, 1500), /\$env:PSModulePath = /, 'the migration path too');
});

test('an engine already elevated hands the work to a PowerShell that outlives it', () => {
  const already = ENABLE.slice(ENABLE.indexOf('if (Test-Elevated) {'), ENABLE.indexOf('} else {', ENABLE.indexOf('if (Test-Elevated) {')));
  // Started from PowerShell, it leaves Node's kill-on-close job; it runs the
  // same checked command as the UAC path, plus the restart.
  assert.match(already, /New-ElevatedCommand \$PSScriptRoot \$hashes \$UserSid -Restart/);
  assert.match(already, /Start-Process -FilePath \$psExe -ArgumentList @\([^)]*'-EncodedCommand', \$encoded\)/);
  assert.doesNotMatch(already, /-Verb RunAs/, 'already elevated: no prompt');
  assert.match(already, /Out-Result \$true 'restarting'/);
  assert.match(ENABLE, /' -Elevated' \+ \$\(if \(\$Restart\) \{ ' -RestartEngine' \}/);
});

// An elevated run (a CI runner is administrator) refuses any folder but its own.
const elevatedHere = () => {
  const whoami = join(process.env.SystemRoot || 'C:\Windows', 'System32', 'whoami.exe');
  try { return execFileSync(whoami, ['/groups'], { windowsHide: true, encoding: 'utf8' }).includes(HIGH_INTEGRITY); } catch { return true; }
};

// The real service installed on this PC holds the global lock, which a normal
// account cannot open: the scratch run would be refused, not tested.
const realServiceHere = () => existsSync(join(process.env.ProgramFiles || 'C:\\Program Files', 'Xenon Sensors', 'sensor-service.ps1'));

test('a Windows box runs the service once into a scratch folder', { skip: process.platform !== 'win32' || elevatedHere() || realServiceHere() }, () => {
  const root = mkdtempSync(join(tmpdir(), 'xenon-sensor-run-'));
  try {
    const out = join(root, 'out');
    mkdirSync(out);
    mkdirSync(join(out, 'want'), { recursive: true });
    writeFileSync(join(out, 'want', 'want-2000'), '');
    const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = new URL('sensor-service.ps1', SERVER);
    const runOnce = () => execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script.pathname.replace(/^\/([A-Za-z]:)/, '$1'), '-OutDir', out, '-Once'], { windowsHide: true, timeout: 90000 });
    runOnce();
    const first = JSON.parse(readFileSync(join(out, 'service.json'), 'utf8'));
    // The second run replaces files that exist: a plain $null backup name became
    // "" in Windows PowerShell and every heartbeat after the first was lost (VM, 11 Nov 2026).
    runOnce();
    const beat = JSON.parse(readFileSync(join(out, 'service.json'), 'utf8'));
    assert.ok(beat.at > first.at, 'the heartbeat is replaced, not stuck at the first one');
    assert.equal(existsSync(join(out, 'service.json.tmp')), false, 'no .tmp left behind');
    assert.equal(beat.v, 1);
    assert.match(beat.hash, /^[0-9a-f]{64}$/);
    assert.equal(beat.wanted, true);
    for (const leaf of ['cpu.json', 'sensors.json']) {
      const o = JSON.parse(readFileSync(join(out, leaf), 'utf8'));
      assert.ok(Number.isFinite(o.at) && o.data && typeof o.data === 'object', leaf);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
