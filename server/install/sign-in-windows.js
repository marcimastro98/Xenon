'use strict';
// Windows: when this session signed in, and whether the Xenon app starts with it.
//
// The engine's start task ("Xenon Edge Widget") runs the same hidden launcher at sign-in, after
// an update and when the app wakes the engine, and passes nothing along, so the start itself
// cannot say who made it. What Windows does keep is the moment the session signed in: an
// engine that started a few minutes after it is the start of that sign-in, a later one is not
// (browser-auto-open.js holds the limit). Read through wtsapi32 (koffi) on its worker thread:
// no PowerShell, no window.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const P = require('./sign-in-parse.js');
const startupTask = require('./startup-task.js');

const WTS_CURRENT_SESSION = 0xFFFFFFFF;
const WTS_SESSION_INFO = 24;            // WTSSessionInfo: answered with a WTSINFOW
const WTSINFO_BYTES = 216;
const LOGON_TIME_AT = 200;              // WTSINFOW.LogonTime, a FILETIME
const CALL_TIMEOUT_MS = 2000;
const REG_TIMEOUT_MS = 4000;

// The app's fallback entry in the Run list, and Task Manager's switch for it.
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const RUN_NAME = 'Xenon';

let api = null;
function load() {
  if (api) return api;
  const koffi = require('koffi');
  const wts = koffi.load('wtsapi32.dll');
  api = {
    koffi,
    query: wts.func('bool __stdcall WTSQuerySessionInformationW(void *, uint32, int, _Out_ void **, _Out_ uint32 *)'),
    free: wts.func('void __stdcall WTSFreeMemory(void *)'),
  };
  return api;
}

function call(fn, ...args) {
  let timer = null;
  const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('session call timed out')), CALL_TIMEOUT_MS); });
  const run = new Promise((resolve, reject) => fn.async(...args, (err, res) => (err ? reject(err) : resolve(res))));
  return Promise.race([run.finally(() => clearTimeout(timer)), guard]);
}

/** @returns {Promise<bigint | null>} the moment this session signed in, as Windows keeps it */
async function logonFiletime() {
  const a = load();
  const out = [null];
  const bytes = [0];
  if (!(await call(a.query, null, WTS_CURRENT_SESSION, WTS_SESSION_INFO, out, bytes)) || !out[0]) return null;
  try {
    if (bytes[0] < WTSINFO_BYTES) return null;
    return Buffer.from(a.koffi.view(out[0], WTSINFO_BYTES)).readBigInt64LE(LOGON_TIME_AT);
  } finally {
    a.free(out[0]);
  }
}

/**
 * @param {{ startedAtMs: number, logon?: () => Promise<bigint | null> }} deps when this engine started
 * @returns {Promise<{ id: string, ageMs: number } | null>} null when Windows gives no sign-in time
 */
async function signIn({ startedAtMs, logon = logonFiletime }) {
  let filetime = null;
  try { filetime = await logon(); } catch { return null; }
  if (typeof filetime !== 'bigint' || filetime <= 0n) return null;
  return { id: String(filetime), ageMs: startedAtMs - P.filetimeToMs(filetime) };
}

const fileExists = (file) => fs.promises.access(file).then(() => true, () => false);

// What `reg query` prints for one value; '' when the value is not there or reg cannot run.
function regQuery(key, name) {
  return new Promise((resolve) => {
    try {
      execFile('reg', ['query', key, '/v', name], { windowsHide: true, timeout: REG_TIMEOUT_MS },
        (err, stdout) => resolve(err ? '' : String(stdout)));
    } catch { resolve(''); }
  });
}

// The app's own sign-in task ("Xenon App"): there, switched on, and its program still on disk.
async function taskStartsApp(readTask, exists) {
  let xml = '';
  try { xml = await readTask(startupTask.APP_TASK_NAME); } catch { return false; }   // no such task
  const state = startupTask.parseTaskXml(xml);
  const program = startupTask.taskCommand(xml);
  return !!state?.enabled && P.isProgram(program, startupTask.APP_EXE) && exists(program);
}

// The Run entry the app keeps for an account that may not register tasks.
async function runListStartsApp(query, exists) {
  const program = P.commandProgram(P.runEntry(await query(RUN_KEY, RUN_NAME), RUN_NAME));
  if (!P.isProgram(program, startupTask.APP_EXE)) return false;
  if (P.runEntryOff(await query(APPROVED_KEY, RUN_NAME), RUN_NAME)) return false;
  return exists(program);
}

/**
 * Whether the Xenon app opens by itself at sign-in: it shows the dashboard then, and a
 * browser tab beside it is the tab nobody asked for.
 * @param {{ readTask?: (name: string) => Promise<string>, query?: (key: string, name: string) => Promise<string>,
 *   exists?: (file: string) => Promise<boolean> }} [deps] for tests
 * @returns {Promise<boolean>}
 */
async function appAtSignIn({ readTask = startupTask.readTaskXml, query = regQuery, exists = fileExists } = {}) {
  return (await taskStartsApp(readTask, exists)) || runListStartsApp(query, exists);
}

// The browser is opened through deck/open-external-path.js, which is PowerShell here.
const canOpen = () => true;

module.exports = { signIn, appAtSignIn, canOpen, RUN_KEY, APPROVED_KEY, RUN_NAME };
