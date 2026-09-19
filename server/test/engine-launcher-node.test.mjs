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
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const VBS = read('../start-hidden.vbs');
const INSTALL = read('../install.ps1');
const UNINSTALL = read('../uninstall.ps1');
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
  const unreleased = CHANGELOG.slice(0, CHANGELOG.indexOf('\n## [4.11.8]'));
  assert.match(unreleased, /launcher starts that one/);
  assert.match(unreleased, /F:\\Nodejs/);
});
