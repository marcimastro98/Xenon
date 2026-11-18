'use strict';
// What minimizing and politely closing an app takes on Windows: user32 through koffi to
// minimize a window, taskkill WITHOUT /F to ask a process to close when its main window would
// not take the request. Never a forced end: the app keeps its chance to ask about saving.

const { execFile } = require('node:child_process');

const SW_MINIMIZE = 6;
const CALL_TIMEOUT_MS = 2000;
const TASKKILL_TIMEOUT_MS = 8000;

let api = null;

// Win32 BOOL is a 4-byte int: declared as int, never koffi's one-byte bool.
function load() {
  if (api) return api;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  api = {
    isWindow: user32.func('int __stdcall IsWindow(intptr_t hWnd)'),
    show: user32.func('int __stdcall ShowWindowAsync(intptr_t hWnd, int nCmdShow)'),
  };
  return api;
}

// A koffi call on its worker thread, with a ceiling so a hung window cannot hold the key.
function call(fn, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('user32 call timed out')), CALL_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    fn.async(...args, (err, res) => { clearTimeout(timer); if (err) reject(err); else resolve(res); });
  });
}

// The HWND the window list gave, as a number koffi can pass; null for anything else.
function hwndOf(id) {
  if (!/^\d{1,24}$/.test(String(id || ''))) return null;
  const n = Number(id);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function minimizeWindow(id, user32 = load) {
  const hwnd = hwndOf(id);
  if (hwnd === null) return { ok: false, error: 'not_found' };
  try {
    const f = user32();
    if (!(await call(f.isWindow, hwnd))) return { ok: false, error: 'not_found' };
    // The return value says whether the window was visible before, not whether it worked.
    await call(f.show, hwnd, SW_MINIMIZE);
    return { ok: true };
  } catch { return { ok: false, error: 'window_failed' }; }
}

// taskkill without /F posts WM_CLOSE to the process's windows, as clicking X does.
function taskkillArgs(pid) {
  const n = Number(pid);
  return Number.isSafeInteger(n) && n > 4 ? ['/PID', String(n)] : null;
}

function closeProcess(pid, run = execFile) {
  const args = taskkillArgs(pid);
  if (!args) return Promise.resolve({ ok: false, error: 'not_found' });
  return new Promise((resolve) => {
    run('taskkill.exe', args, { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS }, (err) => {
      resolve(err ? { ok: false, error: 'close_refused' } : { ok: true });
    });
  });
}

module.exports = { minimizeWindow, closeProcess, taskkillArgs, hwndOf, SW_MINIMIZE };
