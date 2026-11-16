// What each system can say about a sign-in, read from what it prints.
//
// The engine opens the dashboard in the browser when its start is the user's sign-in, so on
// each system it has to learn two things without changing anything: which sign-in this start
// belongs to, and whether the Xenon app already opens at sign-in (it shows the dashboard
// itself then, and a browser tab beside it is the tab nobody asked for). Every answer comes
// through a stand-in here: no task is read, no registry, no /proc, and nothing is run. All
// names, folders and numbers below are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../install/sign-in-parse.js');
const win = require('../install/sign-in-windows.js');
const mac = require('../install/sign-in-darwin.js');
const linux = require('../install/sign-in-linux.js');
const { appSignInEntry } = require('../install/launcher-paths.js');
const { pickBackend } = require('../install/sign-in.js');

const APP_EXE = 'C:\\Apps\\Xenon\\xenon-native.exe';
const yes = async () => true;
const no = async () => false;

// ── Reading ──────────────────────────────────────────────────────────────────

test('a Windows time becomes the same moment on the JavaScript clock', () => {
  assert.equal(P.filetimeToMs(116444736000000000n), 0, '1 January 1970');
  assert.equal(P.filetimeToMs(116444736000000000n + 10000n * 1500n), 1500);
  assert.equal(P.filetimeToMs(133500000000000000n), Number(133500000000000000n / 10000n - 11644473600000n));
});

const RUN_LIST = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
  `    Xenon    REG_SZ    "${APP_EXE}" --autostart`,
  '',
  '',
].join('\r\n');

test('the Run list entry is read as written, and only under its own name', () => {
  assert.equal(P.runEntry(RUN_LIST, 'Xenon'), `"${APP_EXE}" --autostart`);
  assert.equal(P.runEntry(RUN_LIST.replace('REG_SZ', 'REG_EXPAND_SZ'), 'Xenon'), `"${APP_EXE}" --autostart`);
  assert.equal(P.runEntry(RUN_LIST.replace('    Xenon ', '    Xenon Helper '), 'Xenon'), '', 'another program with a longer name');
  assert.equal(P.runEntry('ERROR: The system was unable to find the specified registry key or value.', 'Xenon'), '');
  assert.equal(P.runEntry('', 'Xenon'), '');
  assert.equal(P.runEntry(undefined, 'Xenon'), '');
});

test('the program of a Run line is found quoted, bare, and with spaces in its folder', () => {
  assert.equal(P.commandProgram(`"${APP_EXE}" --autostart`), APP_EXE);
  assert.equal(P.commandProgram(APP_EXE), APP_EXE);
  assert.equal(P.commandProgram('C:\\Program Files\\Xenon\\xenon-native.exe --autostart'), 'C:\\Program Files\\Xenon\\xenon-native.exe');
  assert.equal(P.commandProgram('   '), '');
  assert.equal(P.commandProgram('notepad'), '');
  assert.equal(P.commandProgram(null), '');
});

test('a program counts as the app only by full path and exact file name', () => {
  assert.equal(P.isProgram(APP_EXE, 'xenon-native.exe'), true);
  assert.equal(P.isProgram(APP_EXE.toUpperCase(), 'xenon-native.exe'), true);
  assert.equal(P.isProgram('xenon-native.exe', 'xenon-native.exe'), false, 'no folder: anything on the PATH');
  assert.equal(P.isProgram('C:\\Apps\\Xenon\\not-xenon-native.exe', 'xenon-native.exe'), false);
  assert.equal(P.isProgram('', 'xenon-native.exe'), false);
});

test("Task Manager's switch for a Run entry is read from its first byte", () => {
  const approved = (bytes) => `\r\nHKEY_CURRENT_USER\\...\\StartupApproved\\Run\r\n    Xenon    REG_BINARY    ${bytes}\r\n`;
  assert.equal(P.runEntryOff(approved('030000000000000000000000'), 'Xenon'), true, 'switched off');
  assert.equal(P.runEntryOff(approved('0700000012AB34CD56EF7801'), 'Xenon'), true, 'switched off, with the time it happened');
  assert.equal(P.runEntryOff(approved('020000000000000000000000'), 'Xenon'), false, 'on');
  assert.equal(P.runEntryOff(approved('060000000000000000000000'), 'Xenon'), false, 'on');
  assert.equal(P.runEntryOff('', 'Xenon'), false, 'no value: nobody touched the switch');
});

test('the id of a Mac boot is read from what sysctl prints, and nothing else passes for one', () => {
  assert.equal(P.bootSession('5D2C2B0A-1111-4222-8333-123456789ABC\n'), '5d2c2b0a-1111-4222-8333-123456789abc');
  assert.equal(P.bootSession(''), '');
  assert.equal(P.bootSession('sysctl: unknown oid'), '');
  assert.equal(P.bootSession('{ sec = 1700000000, usec = 123456 } Tue Nov 14 22:13:20 2023\n'), '', 'the time of the boot is not its id');
  assert.equal(P.bootSession('5D2C2B0A-1111-4222-8333-123456789ABC\nmore\n'), '');
});

const IN_UNIT = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/xenon-backend.service\n';

test('the control group says whether systemd started the engine as its unit', () => {
  assert.equal(P.inUnit(IN_UNIT, 'xenon-backend.service'), true);
  assert.equal(P.inUnit('0::/user.slice/user-1000.slice/session-3.scope\n', 'xenon-backend.service'), false, 'a terminal');
  assert.equal(P.inUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/not-xenon-backend.service\n', 'xenon-backend.service'), false);
  assert.equal(P.inUnit('', 'xenon-backend.service'), false);
});

// Fields 3 to 22 of /proc/<pid>/stat; the last is when the process started.
const STAT_REST = 'S 1 1200 1200 0 -1 4194560 2500 0 3 0 12 7 0 0 20 0 1 0 4242';

test('the start of a process is read from its stat line, whatever its name holds', () => {
  assert.equal(P.procStartTicks(`1200 (systemd) ${STAT_REST} 0 0\n`), '4242');
  assert.equal(P.procStartTicks(`1200 (odd name) 9) ${STAT_REST} 0 0\n`), '4242', 'spaces and brackets in the name');
  assert.equal(P.procStartTicks('1200 (systemd) S 1'), '');
  assert.equal(P.procStartTicks('not a stat line'), '');
  assert.equal(P.procStartTicks(''), '');
});

test('a desktop entry switched off by the desktop is read as off', () => {
  assert.equal(P.desktopEntryOff('[Desktop Entry]\nType=Application\nExec=xenon\nHidden=true\n'), true);
  assert.equal(P.desktopEntryOff('[Desktop Entry]\nHidden = true\n'), true);
  assert.equal(P.desktopEntryOff('[Desktop Entry]\nType=Application\nExec=xenon\n'), false);
  assert.equal(P.desktopEntryOff('[Desktop Entry]\nHidden=false\n'), false);
  assert.equal(P.desktopEntryOff('[Desktop Entry]\nNoDisplay=true\n'), false, 'hidden from menus, still started');
});

// ── Windows ──────────────────────────────────────────────────────────────────

test('Windows: the sign-in is the moment the session began, and the start is measured from it', async () => {
  const logonAt = 116444736000000000n + 10000n * 1_800_000_000_000n;   // some moment in 2027
  const logonMs = P.filetimeToMs(logonAt);
  // The PC booted hours before, so only the sign-in time is measured against.
  const sinceBootMs = 6 * 3600_000;
  assert.deepEqual(await win.signIn({ startedAtMs: logonMs + 90_000, logon: async () => logonAt, sinceBootMs }),
    { id: String(logonAt), ageMs: 90_000 });
  // The same session, an engine restarted hours later: the same sign-in, a larger distance.
  const later = await win.signIn({ startedAtMs: logonMs + 5 * 3600_000, logon: async () => logonAt, sinceBootMs });
  assert.equal(later.id, String(logonAt));
  assert.equal(later.ageMs, 5 * 3600_000);
});

test('Windows: no sign-in time means no answer, never a guess', async () => {
  const boom = async () => { throw new Error('no such session'); };
  for (const logon of [async () => null, async () => 0n, async () => -5n, async () => 1700000000, async () => '133500000000000000', boom]) {
    assert.equal(await win.signIn({ startedAtMs: Date.now(), logon }), null);
  }
});

function appTask({ enabled = 'true', command = APP_EXE } = {}) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Settings><Enabled>${enabled}</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>"${command}"</Command></Exec></Actions>
</Task>`;
}
const noTask = async () => { throw new Error('ERROR: The system cannot find the file specified.'); };
const noRunEntry = async () => '';
// The scheduler's list as schtasks prints it, with the app's task and without it.
const listed = async () => '"\\Some Other Task","N/A","Ready"\r\n"\\Xenon App","N/A","Ready"\r\n';
const notListed = async () => '"\\Some Other Task","N/A","Ready"\r\n';

test('Windows: the app opens at sign-in when its own task is there, on, and its program on disk', async () => {
  const asked = [];
  const readTask = async (name) => { asked.push(name); return appTask(); };
  assert.equal(await win.appAtSignIn({ tasks: listed, readTask, query: noRunEntry, exists: yes }), true);
  assert.deepEqual(asked, ['Xenon App'], 'the one task the app registers, by name');
});

test('Windows: a task switched off, left behind, or of another program does not count', async () => {
  const task = (xml) => async () => xml;
  assert.equal(await win.appAtSignIn({ tasks: listed, readTask: task(appTask({ enabled: 'false' })), query: noRunEntry, exists: yes }), false, 'switched off in Task Manager');
  assert.equal(await win.appAtSignIn({ tasks: listed, readTask: task(appTask()), query: noRunEntry, exists: no }), false, 'the app was uninstalled');
  assert.equal(await win.appAtSignIn({ tasks: listed, readTask: task(appTask({ command: 'C:\\Apps\\Other\\other.exe' })), query: noRunEntry, exists: yes }), false);
  assert.equal(await win.appAtSignIn({ tasks: listed, readTask: task('not a task'), query: noRunEntry, exists: yes }), false);
  assert.equal(await win.appAtSignIn({ tasks: notListed, readTask: noTask, query: noRunEntry, exists: yes }), false, 'no task and no Run entry');
});

test('Windows: without a task, the Run entry counts unless Task Manager switched it off', async () => {
  const asked = [];
  const runList = (approved) => async (key, name) => {
    asked.push([key, name]);
    return key === win.RUN_KEY ? RUN_LIST : approved;
  };
  assert.equal(await win.appAtSignIn({ tasks: notListed, readTask: noTask, query: runList(''), exists: yes }), true);
  assert.deepEqual(asked, [[win.RUN_KEY, 'Xenon'], [win.APPROVED_KEY, 'Xenon']], 'two values of the user, read by name');
  assert.match(win.RUN_KEY, /^HKCU\\/, "the user's own list, never the machine's");
  assert.match(win.APPROVED_KEY, /^HKCU\\/);
  const off = '\r\n    Xenon    REG_BINARY    030000000000000000000000\r\n';
  assert.equal(await win.appAtSignIn({ tasks: notListed, readTask: noTask, query: runList(off), exists: yes }), false, 'switched off');
  assert.equal(await win.appAtSignIn({ tasks: notListed, readTask: noTask, query: runList(''), exists: no }), false, 'the program is gone');
  const other = async (key) => (key === win.RUN_KEY ? '\r\n    Xenon    REG_SZ    "C:\\Apps\\Other\\other.exe"\r\n' : '');
  assert.equal(await win.appAtSignIn({ tasks: notListed, readTask: noTask, query: other, exists: yes }), false, 'another program under the same name');
});

// ── macOS ────────────────────────────────────────────────────────────────────

const BOOT_SESSION = '5d2c2b0a-1111-4222-8333-123456789abc';
const BOOT = async () => BOOT_SESSION.toUpperCase() + '\n';

test('macOS: only an engine launchd started as the login agent belongs to a sign-in', async () => {
  assert.deepEqual(await mac.signIn({ env: { XPC_SERVICE_NAME: mac.AGENT_LABEL }, boot: BOOT }), { id: 'boot-' + BOOT_SESSION, ageMs: 0 });
  // Started by the app, from a terminal, or as some other agent: the app is on screen, or nobody signed in.
  for (const env of [{}, { XPC_SERVICE_NAME: '0' }, { XPC_SERVICE_NAME: 'application.com.example.terminal.1' }, { XPC_SERVICE_NAME: mac.AGENT_LABEL + '.other' }]) {
    assert.equal(await mac.signIn({ env, boot: BOOT }), null);
  }
});

test('macOS: an agent that cannot learn which boot this is gives no answer', async () => {
  assert.equal(await mac.signIn({ env: { XPC_SERVICE_NAME: mac.AGENT_LABEL }, boot: async () => '' }), null);
  const bootTime = async () => '{ sec = 1700000000, usec = 0 } Tue Nov 14 22:13:20 2023\n';
  assert.equal(await mac.signIn({ env: { XPC_SERVICE_NAME: mac.AGENT_LABEL }, boot: bootTime }), null, 'the time of the boot is not its id');
});

test('macOS: the app opens at sign-in when it has a login agent of its own', async () => {
  const asked = [];
  const exists = (found) => async (file) => { asked.push(file); return found; };
  assert.equal(await mac.appAtSignIn({ home: '/Users/someone', exists: exists(true) }), true);
  assert.equal(await mac.appAtSignIn({ home: '/Users/someone', exists: exists(false) }), false);
  assert.deepEqual([...new Set(asked)], ['/Users/someone/Library/LaunchAgents/Xenon.plist']);
  assert.equal(await mac.appAtSignIn({ home: '', exists: exists(true) }), false, 'no home folder: nothing to look at');
  assert.equal(mac.canOpen(), true);
});

// ── Linux ────────────────────────────────────────────────────────────────────

const BOOT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
function proc(files) {
  const asked = [];
  const readFile = async (file) => {
    asked.push(file);
    if (!(file in files)) throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    return files[file];
  };
  return { readFile, asked };
}
const UNIT_FILES = {
  '/proc/self/cgroup': IN_UNIT,
  '/proc/1200/stat': `1200 (systemd) ${STAT_REST} 0 0\n`,
  '/proc/sys/kernel/random/boot_id': BOOT_ID + '\n',
  // The engine itself, started 300 ticks (3 seconds) after its systemd.
  '/proc/self/stat': `1300 (node) ${STAT_REST.replace(/4242$/, '4542')} 0 0\n`,
};

test("Linux: an engine started as the user's unit belongs to the life of that user's systemd", async () => {
  const { readFile, asked } = proc(UNIT_FILES);
  assert.deepEqual(await linux.signIn({ env: { MANAGERPID: '1200' }, ppid: 77, readFile }), { id: BOOT_ID + ':4242', ageMs: 3000 });
  assert.ok(asked.every((file) => file.startsWith('/proc/')), 'four reads under /proc, nothing else');
  // An older systemd does not name itself: it is still the parent of its units.
  assert.deepEqual(await linux.signIn({ env: {}, ppid: 1200, readFile }), { id: BOOT_ID + ':4242', ageMs: 3000 });
  assert.deepEqual(await linux.signIn({ env: { MANAGERPID: 'abc' }, ppid: 1200, readFile }), { id: BOOT_ID + ':4242', ageMs: 3000 });
});

test('Linux: a start by hand or from the autostart list is not placed in a sign-in', async () => {
  const terminal = proc({ ...UNIT_FILES, '/proc/self/cgroup': '0::/user.slice/user-1000.slice/session-3.scope\n' });
  assert.equal(await linux.signIn({ env: { MANAGERPID: '1200' }, ppid: 1200, readFile: terminal.readFile }), null);
  assert.deepEqual(terminal.asked, ['/proc/self/cgroup'], 'nothing more is read once the unit is not the one');
  assert.equal(await linux.signIn({ env: {}, ppid: 1200, readFile: proc({}).readFile }), null, 'no /proc at all');
  const noManager = proc({ '/proc/self/cgroup': IN_UNIT, '/proc/sys/kernel/random/boot_id': BOOT_ID });
  assert.equal(await linux.signIn({ env: {}, ppid: 1200, readFile: noManager.readFile }), null);
  const noBoot = proc({ ...UNIT_FILES, '/proc/sys/kernel/random/boot_id': '\n' });
  assert.equal(await linux.signIn({ env: {}, ppid: 1200, readFile: noBoot.readFile }), null);
});

test('Linux: the app opens at sign-in when its autostart entry is there and not switched off', async () => {
  const entry = '/home/someone/.config/autostart/Xenon.desktop';
  const on = proc({ [entry]: '[Desktop Entry]\nType=Application\nExec=xenon\n' });
  assert.equal(await linux.appAtSignIn({ env: {}, home: '/home/someone', readFile: on.readFile }), true);
  assert.deepEqual(on.asked, [entry]);
  const off = proc({ [entry]: '[Desktop Entry]\nExec=xenon\nHidden=true\n' });
  assert.equal(await linux.appAtSignIn({ env: {}, home: '/home/someone', readFile: off.readFile }), false);
  assert.equal(await linux.appAtSignIn({ env: {}, home: '/home/someone', readFile: proc({}).readFile }), false, 'no entry');
  const moved = proc({ '/data/config/autostart/Xenon.desktop': '[Desktop Entry]\n' });
  assert.equal(await linux.appAtSignIn({ env: { XDG_CONFIG_HOME: '/data/config' }, home: '/home/someone', readFile: moved.readFile }), true);
});

test('Linux: a browser can be opened only where the engine was given a display', () => {
  assert.equal(linux.canOpen({ DISPLAY: ':0' }), true);
  assert.equal(linux.canOpen({ WAYLAND_DISPLAY: 'wayland-0' }), true);
  assert.equal(linux.canOpen({}), false, 'a unit started before the desktop, or with no session at all');
  assert.equal(linux.canOpen({ DISPLAY: '' }), false);
});

// ── Every system ─────────────────────────────────────────────────────────────

test("the app's own sign-in entry is a file on macOS and Linux, and not a file on Windows", () => {
  assert.equal(appSignInEntry('darwin', { home: '/Users/someone' }), '/Users/someone/Library/LaunchAgents/Xenon.plist');
  assert.equal(appSignInEntry('linux', { home: '/home/someone' }), '/home/someone/.config/autostart/Xenon.desktop');
  assert.equal(appSignInEntry('linux', { home: '/home/someone', env: { XDG_CONFIG_HOME: '/data/config' } }), '/data/config/autostart/Xenon.desktop');
  assert.equal(appSignInEntry('win32', { home: 'C:\\Users\\someone' }), '');
  assert.equal(appSignInEntry('darwin', { home: '' }), '');
});

test('every system answers the same three questions, and an unknown one answers none', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const backend = pickBackend(platform);
    for (const name of ['signIn', 'appAtSignIn', 'canOpen']) {
      assert.equal(typeof backend[name], 'function', `${platform} ${name}`);
    }
  }
  assert.equal(pickBackend('freebsd'), null);
  assert.equal(pickBackend(''), null);
});
