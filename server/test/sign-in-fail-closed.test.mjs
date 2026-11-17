// What the engine does when a system cannot answer.
//
// A browser tab at sign-in is opened only when the engine knows the Xenon app does not open
// there by itself. "The task is not registered" and "the scheduler did not answer" used to
// read the same, and the second opened a tab beside the app. Here every reader is made to
// fail in the ways a real system fails (a time limit, no permission, a program that is not
// there) and the start is followed to its end: no tab. Also the clock of a PC set between
// sign-in and start, and the memory Windows hands out for the sign-in time. Every system is
// a stand-in: no task, no registry, no file and no session is read. All names are invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../install/sign-in-parse.js');
const win = require('../install/sign-in-windows.js');
const mac = require('../install/sign-in-darwin.js');
const linux = require('../install/sign-in-linux.js');
const { fileThere, textIfThere } = require('../install/sign-in-file.js');
const { openDashboardAtSignIn, signInOpenSupported } = require('../install/sign-in-open.js');
const { SIGN_IN_WINDOW_MS, signInOpenDecision } = require('../install/browser-auto-open.js');

const APP_EXE = 'C:\\Apps\\Xenon\\xenon-native.exe';
const yes = async () => true;
const coded = (code, message = code) => Object.assign(new Error(message), { code });
// What execFile hands back for a program that ran out of time, ended with 1, or is not there.
const timedOut = () => Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: null });
const endedWithOne = () => coded(1, 'Command failed');
const notInstalled = () => coded('ENOENT', 'spawn ENOENT');

const TASK_LIST = '"\\Some Other Task","N/A","Ready"\r\n"\\Xenon App","N/A","Ready"\r\n"\\Xenon App","N/A","Ready"\r\n';
const APP_TASK = `<Task><Settings><Enabled>true</Enabled></Settings><Actions><Exec><Command>"${APP_EXE}"</Command></Exec></Actions></Task>`;
const RUN_KEY_TEXT = `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    Xenon    REG_SZ    "${APP_EXE}" --autostart\r\n`;

/** One start of the installed engine on a system whose answers are `backend`; what it opened. */
async function start(backend) {
  const opened = [];
  const said = [];
  const verdict = await openDashboardAtSignIn({ port: 3030 }, {
    startedAtMs: 1_800_000_000_000,
    backend: { signIn: async () => ({ id: 'sign-in-1', ageMs: 60_000 }), canOpen: () => true, ...backend },
    readSettings: async () => ({ autoOpenArmed: true, autoOpenBrowser: true }),
    readSeen: async () => '',
    writeSeen: async () => {},
    open: async (url) => { opened.push(url); },
    log: (line) => said.push(line),
  });
  return { verdict, opened, said };
}

// ── Windows: the scheduler ───────────────────────────────────────────────────

test('the list of tasks names a task by its full name, in any language of Windows', () => {
  assert.equal(P.taskListed(TASK_LIST, 'Xenon App'), true);
  assert.equal(P.taskListed(TASK_LIST, 'xenon app'), true, 'the scheduler does not tell capitals apart');
  assert.equal(P.taskListed('"\\Xenon App","N/D","Pronta"\r\n', 'Xenon App'), true, 'the other columns are not read');
  assert.equal(P.taskListed('"\\Xenon App 2","N/A","Ready"\r\n', 'Xenon App'), false, 'a longer name');
  assert.equal(P.taskListed('"\\Vendor\\Xenon App","N/A","Ready"\r\n', 'Xenon App'), false, 'a task of that name in a folder');
  assert.equal(P.taskListed('"\\Not Xenon App","N/A","Ready"\r\n', 'Xenon App'), false);
  assert.equal(P.taskListed('INFO: There are no scheduled tasks presently available at your access level.\r\n', 'Xenon App'), false);
  assert.equal(P.taskListed('', 'Xenon App'), false);
  assert.equal(P.taskListed(undefined, 'Xenon App'), false);
});

test('Windows: a scheduler that does not answer is not "no task": the question fails', async () => {
  for (const failure of [timedOut, endedWithOne, notInstalled]) {
    const tasks = async () => { throw failure(); };
    await assert.rejects(win.appAtSignIn({ tasks, readTask: async () => APP_TASK, query: async () => '', exists: yes }));
  }
});

test('Windows: a task that is listed and cannot be read fails the question, with a time limit on the read', async () => {
  const asked = [];
  const readTask = async (name, opts) => { asked.push([name, opts]); throw timedOut(); };
  await assert.rejects(win.appAtSignIn({ tasks: async () => TASK_LIST, readTask, query: async () => '', exists: yes }), /timed out/);
  assert.deepEqual(asked, [['Xenon App', { timeout: 8000 }]]);
});

test('Windows: a task that is not listed is not read at all, and the Run list decides', async () => {
  const readTask = async () => { throw new Error('read a task that is not there'); };
  const tasks = async () => '"\\Some Other Task","N/A","Ready"\r\n';
  assert.equal(await win.appAtSignIn({ tasks, readTask, query: async () => '', exists: yes }), false);
  assert.equal(await win.appAtSignIn({ tasks, readTask, query: async (key) => (key === win.RUN_KEY ? RUN_KEY_TEXT : ''), exists: yes }), true);
});

// ── Windows: the registry ────────────────────────────────────────────────────

test('Windows: a registry that cannot be read fails the question', async () => {
  const tasks = async () => '';
  const broken = async () => { throw timedOut(); };
  await assert.rejects(win.appAtSignIn({ tasks, query: broken, exists: yes }), /timed out/);
  // The Run entry names the app and its program is there: a switch that cannot be read is no "on".
  const noSwitch = async (key) => { if (key === win.RUN_KEY) return RUN_KEY_TEXT; throw endedWithOne(); };
  await assert.rejects(win.appAtSignIn({ tasks, query: noSwitch, exists: yes }), /Command failed/);
  // With the program gone the switch is not even read.
  assert.equal(await win.appAtSignIn({ tasks, query: noSwitch, exists: async () => false }), false);
});

test('Windows: a program that cannot be looked at fails the question; only "not there" is a no', async () => {
  const tasks = async () => TASK_LIST;
  const denied = async () => { throw coded('EPERM'); };
  await assert.rejects(win.appAtSignIn({ tasks, readTask: async () => APP_TASK, query: async () => '', exists: denied }), /EPERM/);
});

test('a key that is not there is told from one that cannot be read by the list of its parent', async () => {
  const parent = '\r\nHKEY_CURRENT_USER\\Software\\Example\r\n\r\nHKEY_CURRENT_USER\\Software\\Example\\Other\r\nHKEY_CURRENT_USER\\Software\\Example\\RunOnce\r\n';
  assert.equal(P.subkeyListed(parent, 'HKCU\\Software\\Example\\Other'), true);
  assert.equal(P.subkeyListed(parent, 'hkcu\\software\\example\\other'), true);
  assert.equal(P.subkeyListed(parent, 'HKCU\\Software\\Example\\Run'), false, 'RunOnce is another key');
  assert.equal(P.subkeyListed(parent, 'HKCU\\Software\\Example\\Example'), false, 'the parent itself is not its own child');
  assert.equal(P.subkeyListed(parent, 'HKCU\\Software\\Elsewhere\\Other'), false, 'a key of that name under another parent');
  assert.equal(P.subkeyListed('    Run    REG_SZ    x\r\n', 'HKCU\\Software\\Example\\Run'), false, 'a value of that name is no key');

  const asked = [];
  const reg = (answers) => async (args) => {
    asked.push(args);
    const answer = answers[args[1]];
    if (typeof answer !== 'string') throw answer();
    return answer;
  };
  const key = 'HKCU\\Software\\Example\\Run';
  // There: one read of the whole key, by an argument list.
  assert.equal(await win.regQuery(key, 'Xenon', reg({ [key]: RUN_KEY_TEXT })), RUN_KEY_TEXT);
  assert.deepEqual(asked, [['query', key]]);
  // Not there: reg ends with 1, and the parent does not list it.
  assert.equal(await win.regQuery(key, 'Xenon', reg({ [key]: endedWithOne, 'HKCU\\Software\\Example': parent })), '');
  // There and unreadable: reg ends with 1 the same way, and the parent lists it.
  const listsIt = parent + 'HKEY_CURRENT_USER\\Software\\Example\\Run\r\n';
  await assert.rejects(win.regQuery(key, 'Xenon', reg({ [key]: endedWithOne, 'HKCU\\Software\\Example': listsIt })), /Command failed/);
  await assert.rejects(win.regQuery(key, 'Xenon', reg({ [key]: timedOut, 'HKCU\\Software\\Example': listsIt })), /timed out/);
  // The parent cannot be read either: nothing is known.
  await assert.rejects(win.regQuery(key, 'Xenon', reg({ [key]: endedWithOne, 'HKCU\\Software\\Example': timedOut })), /timed out/);
});

// ── macOS and Linux: the app's own entry ─────────────────────────────────────

test('a file is "not there" only when the system says so', async () => {
  assert.equal(await fileThere('/x', async () => {}), true);
  assert.equal(await fileThere('/x', async () => { throw coded('ENOENT'); }), false);
  assert.equal(await fileThere('/x', async () => { throw coded('ENOTDIR'); }), false, 'a folder on the way is missing');
  for (const code of ['EACCES', 'EPERM', 'EIO', 'ELOOP', undefined]) {
    await assert.rejects(fileThere('/x', async () => { throw coded(code, 'cannot look'); }), /cannot look/, String(code));
  }
  assert.equal(await textIfThere('/x', async () => 'text'), 'text');
  assert.equal(await textIfThere('/x', async () => { throw coded('ENOENT'); }), null);
  await assert.rejects(textIfThere('/x', async () => { throw coded('EACCES'); }), /EACCES/);
});

test("macOS: a LaunchAgents folder that cannot be looked into fails the question", async () => {
  const access = (code) => (file) => fileThere(file, async () => { throw coded(code); });
  assert.equal(await mac.appAtSignIn({ home: '/Users/someone', exists: access('ENOENT') }), false);
  await assert.rejects(mac.appAtSignIn({ home: '/Users/someone', exists: access('EACCES') }), /EACCES/);
});

test('Linux: an autostart entry that is there and cannot be read fails the question', async () => {
  const read = (code) => async () => { throw coded(code); };
  assert.equal(await linux.appAtSignIn({ env: {}, home: '/home/someone', readFile: read('ENOENT') }), false);
  assert.equal(await linux.appAtSignIn({ env: {}, home: '/home/someone', readFile: read('ENOTDIR') }), false, 'no autostart folder');
  await assert.rejects(linux.appAtSignIn({ env: {}, home: '/home/someone', readFile: read('EACCES') }), /EACCES/);
  await assert.rejects(linux.appAtSignIn({ env: {}, home: '/home/someone', readFile: read('EIO') }), /EIO/);
});

// ── From the failed question to the tab ──────────────────────────────────────

test('on every system, a question about the app that fails ends in no tab, and the switch is not offered', async () => {
  const failing = {
    'Windows, scheduler out of time': () => win.appAtSignIn({ tasks: async () => { throw timedOut(); }, query: async () => '', exists: yes }),
    'Windows, registry out of time': () => win.appAtSignIn({ tasks: async () => '', query: async () => { throw timedOut(); }, exists: yes }),
    'macOS, no permission': () => mac.appAtSignIn({ home: '/Users/someone', exists: async () => { throw coded('EACCES'); } }),
    'Linux, no permission': () => linux.appAtSignIn({ env: {}, home: '/home/someone', readFile: async () => { throw coded('EACCES'); } }),
  };
  for (const [name, appAtSignIn] of Object.entries(failing)) {
    const { verdict, opened, said } = await start({ appAtSignIn });
    assert.equal(verdict.open, false, name);
    assert.equal(verdict.why, 'failed', name);
    assert.deepEqual(opened, [], name);
    assert.match(said[0], /at sign-in: failed \(/, name);
    const backend = { signIn: async () => ({ id: 'sign-in-1', ageMs: 0 }), canOpen: () => true, appAtSignIn };
    assert.equal(await signInOpenSupported({ port: 3030 }, { backend }), false, name);
  }
  // The same start with an answer of "no app" does open: the failures above are what stops it.
  const fine = await start({ appAtSignIn: () => win.appAtSignIn({ tasks: async () => '', query: async () => '', exists: yes }) });
  assert.deepEqual(fine.opened, ['http://127.0.0.1:3030/']);
});

// ── Windows: a clock set between sign-in and start ───────────────────────────

const LOGON_AT = 116444736000000000n + 10000n * 1_800_000_000_000n;
const LOGON_MS = P.filetimeToMs(LOGON_AT);
const logon = async () => LOGON_AT;
const opens = (signIn) => signInOpenDecision({ signIn, seenId: '', armed: true, wanted: true, canOpen: true }).open;

test('Windows: the clock jumped after the sign-in, and the PC booted two minutes ago: still the sign-in', async () => {
  // Signed in with the clock a day behind; Windows set it before the engine started.
  const ahead = await win.signIn({ startedAtMs: LOGON_MS + 24 * 3600_000 + 90_000, logon, sinceBootMs: 120_000 });
  assert.deepEqual(ahead, { id: String(LOGON_AT), ageMs: 120_000 });
  assert.equal(opens(ahead), true);
  // Signed in with the clock ahead; set back, the engine seems to start before the sign-in.
  const behind = await win.signIn({ startedAtMs: LOGON_MS - 3600_000, logon, sinceBootMs: 120_000 });
  assert.deepEqual(behind, { id: String(LOGON_AT), ageMs: 120_000 });
  assert.equal(opens(behind), true);
});

test('Windows: the time since boot is used only when the clock gives no sign-in, and only inside the limit', async () => {
  // A sign-in the clock places inside the limit is measured by the clock.
  assert.equal((await win.signIn({ startedAtMs: LOGON_MS + 90_000, logon, sinceBootMs: 30_000 })).ageMs, 90_000);
  // The engine restarted hours into a session on a PC that has been on for days: not a sign-in.
  const restart = await win.signIn({ startedAtMs: LOGON_MS + 5 * 3600_000, logon, sinceBootMs: 3 * 24 * 3600_000 });
  assert.equal(restart.ageMs, 5 * 3600_000);
  assert.equal(opens(restart), false);
  // A clock set back on a PC that has been on for hours: nothing says sign-in, so no tab.
  const unknown = await win.signIn({ startedAtMs: LOGON_MS - 3600_000, logon, sinceBootMs: 2 * 3600_000 });
  assert.equal(unknown.ageMs, -3600_000);
  assert.equal(opens(unknown), false);
  // The edge of the limit, and a time since boot that is no number.
  assert.equal((await win.signIn({ startedAtMs: LOGON_MS - 1, logon, sinceBootMs: SIGN_IN_WINDOW_MS })).ageMs, SIGN_IN_WINDOW_MS);
  assert.equal((await win.signIn({ startedAtMs: LOGON_MS - 1, logon, sinceBootMs: SIGN_IN_WINDOW_MS + 1 })).ageMs, -1);
  for (const sinceBootMs of [Number.NaN, -5, null, '120000']) {
    assert.equal(opens(await win.signIn({ startedAtMs: LOGON_MS - 1, logon, sinceBootMs })), false, String(sinceBootMs));
  }
});

// ── Windows: the call that reads the sign-in time ────────────────────────────

/** Stand-ins for the two calls into wtsapi32, with a record of what was given back. */
function session({ answerAfterMs = 0, ok = 1, filled = 216, error = null } = {}) {
  const freed = [];
  const info = Buffer.alloc(216);
  info.writeBigInt64LE(LOGON_AT, 200);
  const pointer = { name: 'the answer Windows allocated' };
  const api = {
    koffi: { view: (ptr, size) => { assert.equal(ptr, pointer); assert.equal(size, 216); return info; } },
    query: {
      async: (_server, _session, _kind, out, bytes, done) => {
        setTimeout(() => {
          if (error) return done(error);
          if (ok) { out[0] = pointer; bytes[0] = filled; }
          return done(null, ok);
        }, answerAfterMs);
      },
    },
    free: (ptr) => freed.push(ptr),
  };
  return { api, freed, pointer };
}

test('the sign-in time is read from the answer, and the answer is given back to Windows', async () => {
  const { api, freed, pointer } = session();
  assert.equal(await win.logonFiletime(api, 500), LOGON_AT);
  assert.deepEqual(freed, [pointer]);
});

test('Windows answers TRUE as any number that is not 0, and the call is declared to return a whole one', async () => {
  // A BOOL is four bytes; 256 is TRUE with an empty lowest byte.
  assert.equal(await win.logonFiletime(session({ ok: 256 }).api, 500), LOGON_AT);
  assert.match(win.QUERY_PROTOTYPE, /^int __stdcall WTSQuerySessionInformationW\(/);
  assert.doesNotMatch(win.QUERY_PROTOTYPE, /^bool\b/);
});

test('a call that fails, or answers too little, gives no time and leaks nothing', async () => {
  const refused = session({ ok: 0 });
  assert.equal(await win.logonFiletime(refused.api, 500), null);
  assert.deepEqual(refused.freed, [], 'nothing was allocated');
  const short = session({ filled: 100 });
  assert.equal(await win.logonFiletime(short.api, 500), null);
  assert.deepEqual(short.freed, [short.pointer]);
  await assert.rejects(win.logonFiletime(session({ error: new Error('no such library') }).api, 500), /no such library/);
});

test('a call that answers after the time limit still has its answer given back', async () => {
  const late = session({ answerAfterMs: 60 });
  await assert.rejects(win.logonFiletime(late.api, 10), /timed out/);
  assert.deepEqual(late.freed, [], 'not answered yet');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(late.freed, [late.pointer], 'given back when the answer came');
  // A late answer of "failed" allocated nothing.
  const lateNo = session({ answerAfterMs: 40, ok: 0 });
  await assert.rejects(win.logonFiletime(lateNo.api, 10), /timed out/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(lateNo.freed, []);
  // signIn turns the time limit into "no answer": no tab.
  const slow = session({ answerAfterMs: 60 });
  assert.equal(await win.signIn({ startedAtMs: LOGON_MS, logon: () => win.logonFiletime(slow.api, 10), sinceBootMs: 0 }), null);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(slow.freed, [slow.pointer]);
});
