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

// Chrome opened at every logon beside the Xenon app (3 Nov 2026): the app's own
// page took itself for a browser and registered this task with the default "on",
// and the launcher opened the tab at the first refused connection: VBScript
// evaluates both sides of an And, and On Error Resume Next resumed inside the If.
test('the Xenon app never registers or removes the browser-at-logon task', () => {
  const js = readFileSync(join(__dirname, '..', 'js', 'settings.js'), 'utf8').replace(/\r\n/g, '\n');
  const fn = js.slice(js.indexOf('function autoOpenNotOurs()'), js.indexOf('function syncAutoOpenBrowserControl()'));
  assert.match(fn, /isEmbeddedView\(\) \|\| window\.__XENON_NATIVE__ === true \|\| window\.isTauri === true/);
  const rec = js.slice(js.indexOf('async function reconcileAutoOpenBrowser()'));
  assert.match(rec.slice(0, 200), /if \(autoOpenNotOurs\(\)\) \{ syncAutoOpenBrowserControl\(\); return; \}/);
});

// The launcher itself, run for real with its keys and URL pointed at test values.
// Opening the browser is swapped for "exit 7", so no tab ever opens here: exit 7
// means it would have opened one, 1 that it waited and gave up, 0 that it left
// the dashboard to the app.
const VBS = readFileSync(join(__dirname, '..', 'open-dashboard.vbs'), 'utf8');
const TEST_KEY = 'HKCU\\Software\\XenonTestAutoOpen';

async function runLauncher(t, url = 'http://127.0.0.1:1/') {
  const { execFileSync, spawn } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'xenon-open-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    try { execFileSync('reg', ['delete', TEST_KEY, '/f'], { stdio: 'ignore' }); } catch { /* not there */ }
  });
  const src = VBS
    .replace('Const WAIT_TRIES = 360', 'Const WAIT_TRIES = 2')
    .replace('"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Xenon"', `"${TEST_KEY}\\Run\\Xenon"`)
    .replace('"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run\\Xenon"', `"${TEST_KEY}\\Approved\\Xenon"`)
    .replace('url = "http://127.0.0.1:3030/"', 'url = "' + url + '"')
    .replace(/^shell\.Run "cmd \/c start .*$/m, 'WScript.Quit 7');
  assert.ok(src.includes('WAIT_TRIES = 2') && src.includes(TEST_KEY) && src.includes(url) && src.includes('WScript.Quit 7'),
    'every test value applied');
  assert.ok(!/shell\.Run/.test(src), 'nothing left that could open a browser');
  const file = join(dir, 'open.vbs');
  writeFileSync(file, src);
  const reg = (...args) => execFileSync('reg', args, { stdio: 'ignore' });
  return {
    reg,
    // Async: the test's own server must keep answering while the launcher polls.
    run: () => new Promise((resolve) => {
      const child = spawn('cscript.exe', ['//nologo', file], { windowsHide: true, stdio: 'ignore' });
      child.on('exit', (code) => resolve(code));
    }),
  };
}

const onWindows = { skip: process.platform !== 'win32' };

test('launcher: with the Xenon app starting at logon, no tab and no wait', onWindows, async (t) => {
  const l = await runLauncher(t);
  l.reg('add', TEST_KEY + '\\Run', '/v', 'Xenon', '/t', 'REG_SZ', '/d', '"C:\\X\\xenon-native.exe" --autostart', '/f');
  assert.equal(await l.run(), 0);
  l.reg('add', TEST_KEY + '\\Approved', '/v', 'Xenon', '/t', 'REG_BINARY', '/d', '020000000000000000000000', '/f');
  assert.equal(await l.run(), 0, 'enabled in Task Manager');
});

test('launcher: the app switched off in Task Manager, or absent, waits for the server', onWindows, async (t) => {
  const l = await runLauncher(t);
  assert.equal(await l.run(), 1, 'no app entry: waited, no server, no tab');
  l.reg('add', TEST_KEY + '\\Run', '/v', 'Xenon', '/t', 'REG_SZ', '/d', '"C:\\X\\xenon-native.exe" --autostart', '/f');
  l.reg('add', TEST_KEY + '\\Approved', '/v', 'Xenon', '/t', 'REG_BINARY', '/d', '030000000000000000000000', '/f');
  assert.equal(await l.run(), 1, 'disabled in Task Manager');
  l.reg('add', TEST_KEY + '\\Run', '/v', 'Xenon', '/t', 'REG_SZ', '/d', 'C:\\Other\\thing.exe', '/f');
  l.reg('delete', TEST_KEY + '\\Approved', '/f');
  assert.equal(await l.run(), 1, 'some other program under that name');
});

test('launcher: waits for a server that is not ready yet, then opens', onWindows, async (t) => {
  const { createServer } = await import('node:http');
  let hits = 0;
  const srv = createServer((_req, res) => { hits += 1; res.writeHead(hits < 2 ? 503 : 200); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const l = await runLauncher(t, 'http://127.0.0.1:' + srv.address().port + '/');
  assert.equal(await l.run(), 7, 'opened once the server said 200');
  assert.equal(hits, 2, 'and not before');
});
