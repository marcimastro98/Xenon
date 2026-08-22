import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The "Xenon Edge Dashboard" logon task runs wscript.exe against
// server\open-dashboard.vbs. The task and the file are registered and shipped by
// two different mechanisms, so they can drift apart — the install root moved, or
// an antivirus quarantined the .vbs — and Windows then shows "Can not find script
// file ..." in a modal at every single sign-in while Xenon itself starts fine.
// autoOpenTaskFix is the rule that gets them back in step at boot; it is pure so
// it can be checked here without a Windows scheduler. server.js boots a server on
// require, so the function is sliced out of its source, as in
// calendar-upcoming.test.mjs.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');

function loadFix() {
  const start = SRC.indexOf('function autoOpenTaskFix(');
  assert.ok(start >= 0, 'autoOpenTaskFix declaration not found');
  const end = SRC.indexOf('\n}\n', start);
  assert.ok(end > start, 'could not find the end of autoOpenTaskFix');
  return new Function(SRC.slice(start, end + 2) + '; return autoOpenTaskFix;')();
}

const fix = loadFix();
const HERE = 'C:\\Users\\stimo\\AppData\\Local\\Programs\\Xenon\\server\\open-dashboard.vbs';

test('a task pointing at the launcher we ship is left alone', () => {
  assert.equal(fix({ taskScript: `"${HERE}"`, scriptPath: HERE, launcherPresent: true }), 'none');
});

test('no task means nothing to fix — a repair pass never registers one', () => {
  // The task is only ever created by an explicit choice in the dashboard. If a
  // boot-time pass could create it, a pure-Edge install would grow a browser tab
  // it never asked for.
  assert.equal(fix({ taskScript: '', scriptPath: HERE, launcherPresent: true }), 'none');
  assert.equal(fix({ taskScript: '   ', scriptPath: HERE, launcherPresent: true }), 'none');
  assert.equal(fix({ taskScript: null, scriptPath: HERE, launcherPresent: false }), 'none');
  assert.equal(fix({}), 'none');
});

test('a task left behind by an install that moved is repointed, not removed', () => {
  // The engine used to live directly under %LOCALAPPDATA%\Xenon; it is under
  // Programs\Xenon now, and a task registered before the move still carries the
  // old path — which is exactly the "can not find script file" report.
  const old = 'C:\\Users\\stimo\\AppData\\Local\\Xenon\\server\\open-dashboard.vbs';
  assert.equal(fix({ taskScript: `"${old}"`, scriptPath: HERE, launcherPresent: true }), 'repair');
});

test('a task whose launcher is gone is removed rather than left firing', () => {
  assert.equal(fix({ taskScript: `"${HERE}"`, scriptPath: HERE, launcherPresent: false }), 'remove');
  // Even a stale path goes the same way: with no launcher anywhere there is
  // nothing to repoint it at.
  const old = 'C:\\Xenon\\server\\open-dashboard.vbs';
  assert.equal(fix({ taskScript: old, scriptPath: HERE, launcherPresent: false }), 'remove');
});

test('the same path written differently is still the same path', () => {
  // Windows is case-insensitive and takes either slash; the stored argument also
  // carries the quotes wscript needs. None of that is a reason to re-register.
  assert.equal(fix({ taskScript: `"${HERE.toUpperCase()}"`, scriptPath: HERE, launcherPresent: true }), 'none');
  assert.equal(fix({ taskScript: HERE.replace(/\\/g, '/'), scriptPath: HERE, launcherPresent: true }), 'none');
  assert.equal(fix({ taskScript: `  "${HERE}"  `, scriptPath: HERE, launcherPresent: true }), 'none');
});

test('a missing launcher is refused at registration, not discovered at logon', () => {
  const from = SRC.indexOf('async function setBrowserAutoOpen(');
  assert.ok(from > 0, 'setBrowserAutoOpen not found');
  const body = SRC.slice(from, SRC.indexOf('\n}\n', from));
  assert.match(body, /if \(enabled === true && !openDashboardLauncherPresent\(\)\)/,
    'registering the task must be refused when the script it runs is not there');
  assert.match(body, /reason: 'launcher_missing'/,
    'the refusal must name its reason so the dashboard can stop asking');
});

test('the reconcile runs at boot, so a broken task cannot survive a restart', () => {
  assert.match(SRC, /setTimeout\(\(\) => \{ reconcileBrowserAutoOpenTask\(\)\.catch\(\(\) => \{\}\); \}, \d+\);/,
    'reconcileBrowserAutoOpenTask must be scheduled from the listen callback');
});
