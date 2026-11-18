'use strict';
// The windows the Deck acts on: the window in front (windowMove) and every window of an app the
// key names (closeApp). This only carries the act out; what a key may ask is decided in
// actions/registry-app-window.js.
//
// One seam, as everywhere: Windows lists and closes through the helper (windows.ps1 when the
// helper is missing) and minimizes through user32; macOS and Linux answer through their
// collectors' windows(), the same list/close contract plus 'minimize'.

const { runWindowsTool } = require('../windows-tiles/windows-tool.js');
const { nativeCollectors } = require('../system/native-collectors.js');
const { runPowerShellScript } = require('../powershell/run-command.js');
const { DECK_WINDOW_SCRIPT } = require('../deck/script-paths.js');
const win32 = require('./app-windows-win32.js');

const LIST_TIMEOUT_MS = 8000;
const CLOSE_TIMEOUT_MS = 8000;

function createAppWindows(deps = {}) {
  const tool = deps.runWindowsTool || runWindowsTool;
  const native = deps.nativeCollectors !== undefined ? deps.nativeCollectors : nativeCollectors;
  const windows = deps.win32 || win32;
  const runScript = deps.runPowerShellScript || runPowerShellScript;

  // Every listed window, or none: a list that cannot be read is an empty desk.
  async function list() {
    const r = await tool(['list'], LIST_TIMEOUT_MS).catch(() => null);
    return r && Array.isArray(r.windows) ? r.windows : [];
  }

  // Ask one app to close, as its X does. On Windows the helper closes the
  // process's main window; a process without one (tray apps, some launchers)
  // gets taskkill without /F instead. Elsewhere the collector's close is final.
  async function close(row) {
    const r = await tool(['close', String(row.id)], CLOSE_TIMEOUT_MS).catch(() => null);
    if (r && r.ok === true) return { ok: true };
    const error = r?.error || 'close_failed';
    if (error === 'protected' || native) return { ok: false, error };
    return windows.closeProcess(row.processId);
  }

  function minimize(row) {
    return native ? native.windows('minimize', String(row.id)) : windows.minimizeWindow(String(row.id));
  }

  async function available() {
    return native ? !!(await native.appWindowsAvailable().catch(() => false)) : true;
  }

  // Move, snap or minimise the window in front: a discrete allowlisted verb
  // passed as one argv element to the window script, never a shell string.
  async function windowAction(verb) {
    try {
      const r = await runScript(DECK_WINDOW_SCRIPT, [verb], 6000);
      return (r && r.ok === false) ? { ok: false, error: r.error || 'window_failed' } : { ok: true };
    } catch { return { ok: false, error: 'window_failed' }; }
  }

  return { list, close, minimize, available, windowAction };
}

const appWindows = createAppWindows();

module.exports = { createAppWindows, appWindows };
