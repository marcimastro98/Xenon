// "dependency installation failed" — and nothing else.
//
// Reported on Discord with a screenshot of exactly that: "The update could not be
// applied and your previous version was restored. (dependency installation
// failed)". The reason code is correct and honest. It is also the same sentence
// whether the machine is offline, sitting behind a proxy, out of disk, or has an
// antivirus holding a file open inside node_modules — four causes with four
// different fixes. npm had just written which one it was, in full, to a console
// nobody sees: Invoke-Npm ran with no redirection at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PS1 = readFileSync(new URL('../update-apply.ps1', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const UPDATE = readFileSync(new URL('../js/update.js', import.meta.url), 'utf8');

const INVOKE = (() => {
  const start = PS1.indexOf('function Invoke-Npm {');
  assert.ok(start > 0, 'the npm step is still where this test looks');
  return PS1.slice(start, PS1.indexOf('\n}\n', start));
})();

test('npm output is captured instead of thrown away', () => {
  assert.match(INVOKE, /-RedirectStandardOutput \$npmOut -RedirectStandardError \$npmErr/,
    'both streams are kept');
  // Start-Process refuses to point both streams at one file, which is the trap
  // this would otherwise fall into on the first run.
  assert.notEqual(PS1.indexOf("$npmOut = Join-Path $updDir 'npm-install.log'"),
    PS1.indexOf("$npmErr = Join-Path $updDir 'npm-install.err.log'"),
    'two separate files');
});

test('the transcript reaches the update log, and its location is named', () => {
  assert.match(INVOKE, /Select-Object -Last 20/, 'a bounded tail, not the whole transcript');
  assert.match(INVOKE, /full output in ' \+ \$npmOut/, 'and the log says where the rest is');
});

// npm prints a lot of progress before it fails. The first ERR! line is its own
// summary; everything else is noise.
test('the one-line detail is npm\'s own summary, bounded', () => {
  assert.match(INVOKE, /Where-Object \{ \$_ -match 'npm ERR!' \} \| Select-Object -First 1/,
    'the first ERR! line is the summary');
  assert.match(INVOKE, /if \(-not \$first\) \{ \$first = \$lines \| Select-Object -Last 1 \}/,
    'a failure with no ERR! line still says something');
  assert.match(INVOKE, /if \(\$d\.Length -gt 200\)/, 'bounded before it is persisted');
});

// The rollback runs npm AGAIN to reconcile against the restored lockfile. If that
// also fails it would overwrite the detail, and the result would describe the
// recovery instead of the failure the user is looking at.
test('the reason is snapshotted before the rollback can overwrite it', () => {
  const catchAt = PS1.indexOf('$failDetail = $script:npmDetail');
  assert.ok(catchAt > 0, 'the detail is snapshotted');
  const reconcileAt = PS1.indexOf('node_modules reconciled against restored lockfile');
  assert.ok(catchAt < reconcileAt, 'and snapshotted BEFORE the rollback re-runs npm');
  assert.match(PS1, /detail = \$failDetail/, 'the result carries the snapshot, not the live value');
});

test('the detail survives the trip to the dashboard', () => {
  assert.match(SERVER, /detail: String\(m\.detail \|\| ''\)\.slice\(0, 200\)/,
    '/update/self-status passes it on, bounded');
  const fn = UPDATE.slice(UPDATE.indexOf('function applyFailureText(lastResult)'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /lastResult && lastResult\.detail/, 'and the failure message reads it');
  assert.match(body, /\(detail \? ' — ' \+ detail : ''\)/, 'appended after the reason code');
  // A tool's own words are not ours to translate, and a missing one must not
  // leave a dangling dash.
  assert.doesNotMatch(body, /tr\('update_detail|t\('update_detail/, 'never translated');
});
