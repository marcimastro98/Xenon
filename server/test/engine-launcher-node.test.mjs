// How the Windows launcher finds node - and what it does when it cannot.
//
// start-hidden.vbs is the whole of the engine's start on Windows: the per-logon
// scheduled task runs it, install.ps1 runs it, and it runs with no window and
// no redirection. Everything it asks PATH for, it asks silently, and every
// answer of "not found" it gets, it used to swallow whole.
//
// It used to end with `cmd /c node "...\server.js"`, which is two PATH lookups
// in one line. Both have failed on real machines:
//
//   * cmd - a PATH edited past the 2047-character limit of the old System
//     Properties dialog is truncated in place, and "debloat" scripts rewrite it
//     wholesale; either can leave a healthy Windows with no System32 on PATH
//     (issue #127). xenon-bootstrap.ps1 was fixed the same way: nothing there
//     is looked up on PATH any more.
//   * node - the installer resolves node.exe with the machine and user PATH
//     freshly merged into its own process; the logon task's process gets
//     neither. Reported on Discord (Sep 2026) from a PC with node at F:\Nodejs:
//     every component [OK], task registered, npm install clean, and nothing
//     ever listening on 3030 - on a fresh install and on a full reinstall -
//     with not one line in server.log, because node never ran to write it.
//
// These tests hold the two halves of the fix together: the launcher resolves
// node to an absolute path without asking a shell to do it, and install.ps1
// writes down the node.exe it actually verified for the launcher to read. They
// are two files that nothing else connects, and drift between them is invisible
// until someone's dashboard never comes up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync as readFileSyncRaw, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// A Windows checkout (core.autocrlf) has CRLF; everything below matches on LF.
const readFileSync = (p, enc) => { const s = readFileSyncRaw(p, enc); return typeof s === 'string' ? s.replace(/\r\n/g, '\n') : s; };

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const VBS = read('../start-hidden.vbs');
const INSTALL = read('../install.ps1');
const UNINSTALL = read('../uninstall.ps1');
const UPDATE_APPLY = read('../update-apply.ps1');
const STARTUP_LOG = read('../startup-log.js');
const CHANGELOG = read('../../CHANGELOG.md');

// Only the code, so a program name quoted inside a comment explaining why it is
// no longer used cannot fail a test about the code.
const CODE = VBS.split(/\r?\n/).filter((l) => !/^\s*'/.test(l)).join('\n');

test('the launcher hands shell.Run no bare program name', () => {
  // cmd was the middleman for node and is gone entirely; node and powershell
  // are now started by absolute path. A bare name here is a silent failure on
  // any PC whose PATH is not what we assumed.
  assert.doesNotMatch(CODE, /cmd\s*\/c/i, 'start-hidden.vbs still goes through cmd');
  for (const run of CODE.matchAll(/shell\.Run\s+(Chr\(34\)|[A-Za-z_]\w*)/g)) {
    const head = run[1];
    // Either an inline quoted path, or a variable - and every variable used
    // this way must itself be built from a quoted absolute path.
    if (head === 'Chr(34)') continue;
    const built = new RegExp(`^\\s*${head}\\s*=\\s*Chr\\(34\\)`, 'm');
    assert.match(CODE, built, `shell.Run ${head} - ${head} is not built from a quoted absolute path`);
  }
});

test('powershell is taken from System32, never from PATH', () => {
  assert.match(CODE, /sys32\s*=\s*shell\.ExpandEnvironmentStrings\("%WINDIR%"\)\s*&\s*"\\System32"/);
  assert.match(CODE, /ps\s*=\s*sys32\s*&\s*"\\WindowsPowerShell\\v1\.0\\powershell\.exe"/);
  // Missing powershell must not take the start down with it: the port kill is a
  // precaution, starting the engine is the job.
  assert.match(CODE, /If Exists\(ps\) Then/);
});

test('no PowerShell is started when nothing listens on the port', () => {
  // About two seconds of every sign-in, before node, for an answer that is
  // nearly always no. The kill stays for the start that really replaces an engine.
  const guard = CODE.indexOf('If PortInUse() Then');
  assert.ok(guard >= 0, 'the launcher no longer asks before starting PowerShell');
  assert.ok(guard < CODE.indexOf('shell.Run psKill'), 'the kill has moved out from under the check');
  assert.ok(CODE.indexOf('End Function', CODE.indexOf('Function PortInUse()')) < guard);
  assert.ok(guard < CODE.indexOf('nodeExe = FindNode()'), 'the kill must come before the start');
});

// The function itself, run by the real script host against a real socket.
const portInUse = (port, namespace = 'root\\StandardCimv2') => {
  const at = CODE.indexOf('Function PortInUse()');
  const fn = CODE.slice(at, CODE.indexOf('End Function', at) + 'End Function'.length);
  const dir = mkdtempSync(join(tmpdir(), 'xenon-launcher-'));
  try {
    const script = join(dir, 'probe.vbs');
    const body = fn.replace('LocalPort=3030', 'LocalPort=' + port).replace('root\\StandardCimv2', () => namespace);
    writeFileSync(script, body + '\r\nWScript.Echo CInt(PortInUse())\r\n');
    const out = spawnSync('cscript.exe', ['//nologo', script], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('the port check sees a listener, and sees it gone', { skip: process.platform !== 'win32' }, async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const open = portInUse(port);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(open, '-1', 'a listening port was not seen');
  assert.equal(portInUse(port), '0', 'a free port read as taken');
  assert.equal(portInUse(port, 'root\\NoSuchNamespace'), '-1', 'a question WMI cannot answer must count as in use');
});

// A second launch while the engine is still starting (the logon task and the
// app's /Run on a slow cold boot) used to start a second node, which retried the
// port for 15 s and left a failure in server.log.
test('a launch while this engine is still starting leaves it be', () => {
  const guard = CODE.indexOf('If PortInUse() Then');
  const starting = CODE.indexOf('ElseIf EngineStarting() Then');
  assert.ok(starting > guard, 'the starting check is not the other branch of the port check');
  assert.ok(starting < CODE.indexOf('nodeExe = FindNode()'), 'the check must come before the start');
  assert.match(CODE.slice(starting, CODE.indexOf('End If', starting)), /WScript\.Quit 0/);
});

const engineStarting = (serverPath) => {
  const at = CODE.indexOf('Function EngineStarting()');
  const fn = CODE.slice(at, CODE.indexOf('End Function', at) + 'End Function'.length);
  const dir = mkdtempSync(join(tmpdir(), 'xenon-launcher-'));
  try {
    const script = join(dir, 'probe.vbs');
    writeFileSync(script, `Dim serverPath\r\nserverPath = "${serverPath}"\r\n${fn}\r\nWScript.Echo CInt(EngineStarting())\r\n`);
    const out = spawnSync('cscript.exe', ['//nologo', script], { encoding: 'utf8', timeout: 30000 });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('the starting check sees a fresh node of this engine and nothing else', { skip: process.platform !== 'win32' }, async () => {
  // A harmless node whose command line names a server.js that does not exist;
  // nothing on the real engine's path is looked at or touched.
  const fake = join(tmpdir(), 'xenon-starting-probe-' + process.pid, 'server', 'server.js');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', fake]);
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(engineStarting(fake), '-1', 'a node starting this server.js was not seen');
    assert.equal(engineStarting(fake.toUpperCase()), '-1', 'paths are compared as Windows does, ignoring case');
    assert.equal(engineStarting(join(tmpdir(), 'xenon-other-' + process.pid, 'server.js')), '0', 'another node read as this engine');
  } finally {
    child.kill();
  }
});

// The PowerShell line the launcher really runs, for any port.
const killCommand = (port) => {
  const from = CODE.indexOf('"try{"');
  const lines = CODE.slice(from, CODE.indexOf('"}catch{}"', from) + '"}catch{}"'.length);
  return [...lines.matchAll(/"([^"]*)"/g)].map((part) => part[1]).join('').replaceAll('3030', String(port));
};

// What that line would stop on a port. Dry on purpose: Stop-Process is shadowed,
// so no version of the line, a broken one included, can stop a real process. A
// real run once took every program connected to the real 3030 with it.
const wouldStop = (port) => {
  const line = killCommand(port);
  assert.doesNotMatch(line, /3030/, 'the line still names the real port');
  const dry = 'function Stop-Process { param([int[]]$Id, [switch]$Force, $ErrorAction) $Id | ForEach-Object { "stop $_" } }; ' + line;
  const out = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', dry], { encoding: 'utf8', timeout: 30000 });
  assert.equal(out.status, 0, out.stderr);
  return [...new Set((out.stdout.match(/\d+/g) || []).map(Number))].filter(Boolean);
};

const listener = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', "require('net').createServer().listen(0, '127.0.0.1', function () { console.log(this.address().port); });"]);
  child.once('error', reject);
  child.stdout.once('data', (text) => resolve({ child, port: Number(text) }));
});

test('the launcher and the updater find the engine without asking for its state', () => {
  // Windows 11 build 26300: the same listener read Listen, Closed, FinWait1 and
  // blank within two seconds, so a kill keyed on -State Listen was a coin toss.
  for (const [name, code] of [['start-hidden.vbs', killCommand(3030)], ['update-apply.ps1', UPDATE_APPLY.match(/function Stop-Server \{[\s\S]*?\n\}/)[0]]]) {
    assert.match(code, /Get-NetTCPConnection -LocalPort \S+ -RemotePort 0 /, name);
    assert.doesNotMatch(code, /Get-NetTCPConnection[^\n]*-State/, name);
  }
});

test('the kill names what listens on the port and nothing connected to it', { skip: process.platform !== 'win32' }, async () => {
  const { child, port } = await listener();
  const client = spawn(process.execPath, ['-e', `require('net').connect(${port}, '127.0.0.1', () => console.log('on')).on('error', () => {}); setInterval(() => {}, 1000);`]);
  try {
    await once(client.stdout, 'data');
    assert.deepEqual(wouldStop(port), [child.pid]);
  } finally {
    child.kill();
    client.kill();
  }
});

test('node is resolved to an absolute path and started directly', () => {
  assert.match(CODE, /nodeExe\s*=\s*FindNode\(\)/);
  assert.match(
    CODE,
    /shell\.Run Chr\(34\) & nodeExe & Chr\(34\) & " " & Chr\(34\) & serverPath & Chr\(34\), 0, False/,
    'the engine is no longer started as `node "<serverPath>"` by absolute path'
  );
});

// The order matters: the recorded path is the only one that knows about a node
// installed somewhere we would never think to look.
test('FindNode tries the recorded path, then the usual folders, then PATH', () => {
  const body = CODE.slice(CODE.indexOf('Function FindNode()'));
  const recorded = body.indexOf('recordedNodeFile');
  const folders = body.indexOf('\\nodejs\\node.exe');
  const path = body.indexOf('Split(EnvVar("PATH")');
  assert.ok(recorded >= 0 && folders >= 0 && path >= 0, 'FindNode lost one of its three sources');
  assert.ok(recorded < folders, 'the recorded node path must be tried first');
  assert.ok(folders < path, 'the known install folders must be tried before a PATH scan');
});

test('the PATH scan reads PATH itself rather than asking a shell to', () => {
  // This is what keeps a node at F:\Nodejs reachable without depending on
  // cmd.exe - and what keeps a truncated PATH from taking the start down.
  assert.match(CODE, /dirs\s*=\s*Split\(EnvVar\("PATH"\),\s*";"\)/);
  assert.match(CODE, /candidate\s*=\s*entry\s*&\s*"\\node\.exe"/);
  assert.match(CODE, /If Exists\(candidate\) Then/);
});

test('an unset environment variable contributes no candidate', () => {
  // ExpandEnvironmentStrings hands back the literal "%ProgramFiles(x86)%" when
  // the variable is not set, which would otherwise be tested as a path.
  assert.match(CODE, /If value = "%" & name & "%" Then value = ""/);
  assert.match(CODE, /If Left\(candidates\(i\), 1\) <> "\\" And Exists\(candidates\(i\)\) Then/);
});

test('no node found is written down, in the file everyone is already told to send', () => {
  const logDir = CODE.match(/logDir\s*=\s*localAppData\s*&\s*"\\(\w+)"/);
  assert.ok(logDir, 'the launcher no longer knows where the engine log lives');
  // The same folder startup-log.js writes to - one file holds the whole story.
  assert.match(STARTUP_LOG, new RegExp(`'${logDir[1]}'`));
  assert.match(CODE, /Set stream = fso\.OpenTextFile\(logDir & "\\server\.log", 8, True, 0\)/);
  assert.match(STARTUP_LOG, /'server\.log'/);

  const miss = CODE.slice(CODE.indexOf('If nodeExe = "" Then'));
  assert.match(miss, /LogFailure/);
  assert.match(miss, /WScript\.Quit/, 'the launcher must stop rather than fall through to a start it cannot make');
  assert.match(miss, /nodejs\.org/, 'the line must say what to do about it');
});

test('install.ps1 records the node.exe it verified, where the launcher looks', () => {
  const recorded = INSTALL.match(/\$script:nodePathFile\s*=.*'Xenon\\([\w.-]+)'/);
  assert.ok(recorded, 'install.ps1 no longer records a node path for the launcher');
  const file = recorded[1];
  assert.match(
    VBS,
    new RegExp(`recordedNodeFile = logDir & "\\\\${file.replace('.', '\\.')}"`),
    `the launcher does not read the file install.ps1 writes (${file})`
  );
  // UTF-16 on both ends: a profile name can hold characters the system codepage
  // cannot, and a path written in the wrong encoding points nowhere.
  assert.match(INSTALL, /Set-Content -LiteralPath \$script:nodePathFile[^\r\n]*-Encoding Unicode/);
  assert.match(VBS, /fso\.OpenTextFile\(path, 1, False, -1\)/);
});

test('the record is written immediately before every launch', () => {
  const start = INSTALL.slice(INSTALL.indexOf('function Start-WidgetServer'));
  const save = start.indexOf('Save-NodePath (Get-NodePath)');
  const launch = start.indexOf("System32\\wscript.exe') -ArgumentList ('\"' + $runner + '\"')");
  assert.ok(save >= 0, 'Start-WidgetServer does not record the node path');
  assert.ok(launch >= 0, 'Start-WidgetServer no longer launches the runner');
  assert.ok(save < launch, 'the node path must be recorded before the launcher is started');
});

test('a record that cannot be written never fails the install', () => {
  const fn = INSTALL.slice(INSTALL.indexOf('function Save-NodePath'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /try \{/);
  assert.match(body, /\} catch \{/);
  assert.match(body, /if \(-not \$NodePath -or -not \$script:nodePathFile\) \{ return \}/);
});

test('uninstall takes the record with the rest of the folder', () => {
  assert.match(UNINSTALL, /Remove-PathSafe \(Join-Path \$localAppData 'Xenon'\)/);
});

test('the fix is in the changelog', () => {
  // The whole file, not the [Unreleased] section: entries move into a version
  // section when a release is cut, and pinning the section turned this into a
  // test that broke on the release rather than on the thing it is guarding.
  // (It had already rotted silently — the headings gained a `v` and a date, so
  // the old slice matched nothing and read the entire file.)
  assert.match(CHANGELOG, /launcher starts that one/);
  assert.match(CHANGELOG, /F:\\Nodejs/);
});
