'use strict';
// Windows: when this session signed in, whether the Xenon app starts with it, and whether the
// task older versions opened the browser with is still registered.
//
// The engine's start task ("Xenon Edge Widget") runs the same hidden launcher at sign-in, after
// an update and when the app wakes the engine, and passes nothing along, so the start itself
// cannot say who made it. What Windows does keep is the moment the session signed in: an
// engine that started a few minutes after it is the start of that sign-in, a later one is not
// (browser-auto-open.js holds the limit). Read through wtsapi32 (koffi) on its worker thread:
// no PowerShell, no window.
// Known limit: an engine started by hand in the first ten minutes of a session no start has met
// yet is taken for the start of that sign-in, because nothing here tells it from the task's.
//
// Every question about the app is answered "yes", "no" or with an error, never with a guess:
// schtasks and reg end the same way for "not there" and for "could not look", and say which
// only in the language of Windows. So the scheduler is asked for its list and the registry
// for the parent key, where a missing entry is simply not listed, and anything that fails is
// thrown: the engine then opens no tab (sign-in-open.js).

const { execFile } = require('node:child_process');
const os = require('node:os');
const P = require('./sign-in-parse.js');
const startupTask = require('../startup-task.js');
const { fileThere } = require('./sign-in-file.js');
const { SIGN_IN_WINDOW_MS } = require('./browser-auto-open.js');
const { BROWSER_TASK_NAME } = require('./browser-auto-open-task.js');

const WTS_CURRENT_SESSION = 0xFFFFFFFF;
const WTS_SESSION_INFO = 24;            // WTSSessionInfo: answered with a WTSINFOW
const WTSINFO_BYTES = 216;
const LOGON_TIME_AT = 200;              // WTSINFOW.LogonTime, a FILETIME
const CALL_TIMEOUT_MS = 2000;
const REG_TIMEOUT_MS = 4000;
const TASK_TIMEOUT_MS = 8000;
// One read of the scheduler's list answers both questions a start asks of it.
const LIST_KEEP_MS = 5000;

// The app's fallback entry in the Run list, and Task Manager's switch for it.
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const RUN_NAME = 'Xenon';

// A Windows BOOL is four bytes. Declared as `bool` only the lowest byte would be read.
const QUERY_PROTOTYPE = 'int __stdcall WTSQuerySessionInformationW(void *, uint32, int, _Out_ void **, _Out_ uint32 *)';

let api = null;
function load() {
  if (api) return api;
  const koffi = require('koffi');
  const wts = koffi.load('wtsapi32.dll');
  api = {
    koffi,
    query: wts.func(QUERY_PROTOTYPE),
    free: wts.func('void __stdcall WTSFreeMemory(void *)'),
  };
  return api;
}

/**
 * @param {any} [a] the two calls, for tests
 * @param {number} [timeoutMs]
 * @returns {Promise<bigint | null>} the moment this session signed in, as Windows keeps it
 */
async function logonFiletime(a = load(), timeoutMs = CALL_TIMEOUT_MS) {
  const out = [null];
  const bytes = [0];
  let gaveUp = false;
  let timer = null;
  const answered = new Promise((resolve, reject) => {
    a.query.async(null, WTS_CURRENT_SESSION, WTS_SESSION_INFO, out, bytes, (err, ok) => {
      // Nobody waits any more, and Windows still allocated the answer: it is given back.
      if (gaveUp) { if (!err && ok && out[0]) a.free(out[0]); return; }
      if (err) reject(err); else resolve(ok);
    });
  });
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => { gaveUp = true; reject(new Error('session call timed out')); }, timeoutMs);
  });
  let ok = 0;
  try { ok = await Promise.race([answered, limit]); } finally { clearTimeout(timer); }
  if (!ok || !out[0]) return null;
  try {
    if (bytes[0] < WTSINFO_BYTES) return null;
    return Buffer.from(a.koffi.view(out[0], WTSINFO_BYTES)).readBigInt64LE(LOGON_TIME_AT);
  } finally {
    a.free(out[0]);
  }
}

// How long after the PC booted this engine started, on a clock nobody can set.
const startedSinceBootMs = () => Math.round((os.uptime() - process.uptime()) * 1000);
const inWindow = (ms) => typeof ms === 'number' && ms >= 0 && ms <= SIGN_IN_WINDOW_MS;

/**
 * @param {{ startedAtMs: number, logon?: () => Promise<bigint | null>, sinceBootMs?: number }} deps when this engine started
 * @returns {Promise<{ id: string, ageMs: number } | null>} null when Windows gives no sign-in time
 */
async function signIn({ startedAtMs, logon = logonFiletime, sinceBootMs = startedSinceBootMs() }) {
  let filetime = null;
  try { filetime = await logon(); } catch { return null; }
  if (typeof filetime !== 'bigint' || filetime <= 0n) return null;
  const byClock = startedAtMs - P.filetimeToMs(filetime);
  // The sign-in time is on the wall clock, and Windows may set that clock between the sign-in
  // and this start (the first time sync after boot, a PC whose clock battery is flat): the
  // distance then reads as hours, or as negative. An engine that started within the limit of
  // the boot itself started within the limit of any sign-in of that boot.
  const ageMs = !inWindow(byClock) && inWindow(sinceBootMs) ? sinceBootMs : byClock;
  return { id: String(filetime), ageMs };
}

function reg(args) {
  return new Promise((resolve, reject) => {
    execFile('reg', args, { windowsHide: true, timeout: REG_TIMEOUT_MS }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/**
 * What `reg query` prints for a key and its values: '' only when the key is known not to be
 * there, which its parent's list says. Any other failure is thrown.
 * @param {string} key
 * @param {string} [_name] the value the caller is after; the whole key is read
 * @param {(args: string[]) => Promise<string>} [run] for tests
 * @returns {Promise<string>}
 */
async function regQuery(key, _name, run = reg) {
  try {
    return await run(['query', key]);
  } catch (error) {
    const cut = key.lastIndexOf('\\');
    if (P.subkeyListed(await run(['query', key.slice(0, cut)]), key)) throw error;
    return '';
  }
}

let lastList = null;
/** @returns {Promise<string>} the scheduler's tasks as `schtasks /Query /FO CSV /NH` prints them */
function listTasks() {
  if (lastList && performance.now() - lastList.at < LIST_KEEP_MS) return lastList.text;
  const text = startupTask.runSchtasks(['/Query', '/FO', 'CSV', '/NH'], { timeout: TASK_TIMEOUT_MS }).then(String);
  lastList = { at: performance.now(), text };
  text.catch(() => { if (lastList?.text === text) lastList = null; });
  return text;
}

// The app's own sign-in task ("Xenon App"): there, switched on, and its program still on disk.
async function taskStartsApp(tasks, readTask, exists) {
  if (!P.taskListed(await tasks(), startupTask.APP_TASK_NAME)) return false;   // no such task
  const xml = await readTask(startupTask.APP_TASK_NAME, { timeout: TASK_TIMEOUT_MS });
  const state = startupTask.parseTaskXml(xml);
  const program = startupTask.taskCommand(xml);
  return !!state?.enabled && P.isProgram(program, startupTask.APP_EXE) && exists(program);
}

// The Run entry the app keeps for an account that may not register tasks. The program is
// looked for before Task Manager's switch is read: with the program gone the switch does not
// matter, and with it there a switch that cannot be read ends in no tab, like "switched on".
async function runListStartsApp(query, exists) {
  const program = P.commandProgram(P.runEntry(await query(RUN_KEY, RUN_NAME), RUN_NAME));
  if (!P.isProgram(program, startupTask.APP_EXE) || !(await exists(program))) return false;
  return !P.runEntryOff(await query(APPROVED_KEY, RUN_NAME), RUN_NAME);
}

/**
 * Whether the Xenon app opens by itself at sign-in: it shows the dashboard then, and a
 * browser tab beside it is the tab nobody asked for. Rejects when Windows cannot say.
 * @param {{ tasks?: () => Promise<string>, readTask?: (name: string, opts?: object) => Promise<string>,
 *   query?: (key: string, name: string) => Promise<string>, exists?: (file: string) => Promise<boolean> }} [deps] for tests
 * @returns {Promise<boolean>}
 */
async function appAtSignIn({ tasks = listTasks, readTask = startupTask.readTaskXml, query = regQuery, exists = fileThere } = {}) {
  return (await taskStartsApp(tasks, readTask, exists)) || runListStartsApp(query, exists);
}

/**
 * Whether the task older versions registered to open the browser at sign-in is still there
 * (browser-auto-open-task.js removes it, a minute after every start, and may fail to). Where
 * its script is still on disk that task opens the browser, and a tab from the engine would be
 * a second one: while the task is there the engine opens none. Rejects when the scheduler
 * cannot say.
 * @param {{ tasks?: () => Promise<string> }} [deps] for tests
 * @returns {Promise<boolean>}
 */
async function oldLauncher({ tasks = listTasks } = {}) {
  return P.taskListed(await tasks(), BROWSER_TASK_NAME);
}

// The browser is opened by explorer.exe (sign-in-browser.js), which is part of Windows.
const canOpen = () => true;

module.exports = {
  signIn, appAtSignIn, oldLauncher, canOpen, logonFiletime, regQuery, RUN_KEY, APPROVED_KEY, RUN_NAME, QUERY_PROTOTYPE,
};
