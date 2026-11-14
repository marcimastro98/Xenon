'use strict';
// The open windows of an X11 session on Linux, read with wmctrl, xdotool and xprop, and how one
// is brought forward or closed.

const { execFile } = require('node:child_process');
const fsp = require('node:fs').promises;
const { splitLines, mapLimit } = require('./linux-read.js');

// --- Open windows / app switcher: wmctrl + xdotool (X11) --------------------
// Xenon's /windows endpoint (list/focus/close) drives its "Open applications"
// widget through a Windows helper (windows.ps1, Win32 EnumWindows). We reproduce
// the same JSON contract the PowerShell path emits:
//   list  -> { windows: [ { id, title, app, path, active, minimized, icon } ] }
//   focus -> { ok }
//   close -> { ok, app, path }  (or { ok:false, error:'protected'|'not_found' })
// ids are DECIMAL strings (server.js validates /^\d{1,24}$/), matching the HWND
// contract; here they are the X11 window id in decimal.
//
// KNOWN LIMIT: X11 only. Wayland has no equivalent unprivileged window-listing
// protocol, so this returns an empty list under a Wayland session. (Under a
// Wayland session with Xwayland, the X11 clients running through it — which
// includes most games — are still listed; native Wayland windows are not.)
//
// LISTING needs nothing but xprop: _NET_CLIENT_LIST and a property read per
// window are the same data wmctrl prints, and asking the user to install
// wmctrl for a read-only list was a dependency the widget did not need. wmctrl
// and xdotool are still used to ACT on a window (focus, close), because that
// means sending a client message rather than reading a property, and neither
// is worth hand-rolling. So: the list appears with x11-utils alone, and the
// buttons that need more say so.
const MAX_WINDOWS = 24;
// At most this many xprop processes in flight at once.
const XPROP_CONCURRENCY = 8;

// Ensure X access even when the server was launched without a session env.
function xEnv() {
  const env = { ...process.env };
  if (!env.DISPLAY) env.DISPLAY = ':0';
  if (!env.XAUTHORITY) {
    try { env.XAUTHORITY = `/run/user/${process.getuid()}/gdm/Xauthority`; } catch { /* no getuid */ }
  }
  return env;
}
function runX(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, env: xEnv(), windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || ''));
    });
  });
}

// WM_CLASS classes we never surface/close: the desktop shell itself.
const PROTECTED_CLASSES = new Set(['gnome-shell', 'Gnome-shell', 'xfdesktop', 'plasmashell']);

async function appFromExe(pid) {
  try {
    const exe = await fsp.readlink(`/proc/${pid}/exe`);
    return { path: exe, name: exe.split('/').filter(Boolean).pop() || '' };
  } catch {
    return { path: '', name: '' };
  }
}

// wmctrl -lp: "<id> <desktop> <pid> <host> <title...>". host is one token, so
// the first four fields are unambiguous and the remainder is the title.
function parseWmctrl(raw) {
  const rows = [];
  for (const line of splitLines(raw)) {
    const m = line.match(/^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) continue;
    const title = (m[5] || '').trim();
    if (!title) continue; // untitled utility/override-redirect windows
    rows.push({ hexId: m[1], pid: m[3], title, dec: parseInt(m[1], 16) });
  }
  return rows;
}

// WM_CLASS(STRING) = "instance", "Class" -> take the Class (2nd) string.
function parseWindowProps(out) {
  const minimized = !!(out && out.includes('_NET_WM_STATE_HIDDEN'));
  let cls = '';
  if (out) {
    const m = out.match(/WM_CLASS\(STRING\)\s*=\s*"(?:[^"]*)",\s*"([^"]*)"/) ||
              out.match(/WM_CLASS\(STRING\)\s*=\s*"([^"]*)"/);
    if (m) cls = m[1];
  }
  return { minimized, cls };
}
async function windowProps(hexId) {
  return parseWindowProps(await runX('xprop', ['-id', hexId, 'WM_CLASS', '_NET_WM_STATE'], 3000));
}

// `_NET_CLIENT_LIST(WINDOW): window id # 0x1, 0x2, …` — every managed window,
// which is the same set wmctrl -l prints because that is where wmctrl reads it.
function parseClientList(raw) {
  const m = String(raw || '').match(/window id # (.*)$/m);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim())
    .filter((s) => /^0x[0-9a-fA-F]+$/.test(s));
}

// A window's title and owning pid, from the properties wmctrl would have read.
// _NET_WM_NAME (UTF-8) is preferred over WM_NAME (latin-1): a window titled
// with anything non-ASCII comes out mangled from the older property, which is
// most of them on a non-English desktop.
function parseWindowIdentity(raw) {
  const s = String(raw || '');
  const pidM = s.match(/_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)/);
  const nameM = s.match(/_NET_WM_NAME\(UTF8_STRING\)\s*=\s*"((?:[^"\\]|\\.)*)"/) ||
                s.match(/WM_NAME\(STRING\)\s*=\s*"((?:[^"\\]|\\.)*)"/);
  const title = nameM ? nameM[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim() : '';
  return { pid: pidM ? pidM[1] : '', title };
}

// The window ids, titles and pids, without wmctrl. One xprop for the list, one
// per window — capped the same way the wmctrl path is.
async function listRowsViaXprop() {
  const ids = parseClientList(await runX('xprop', ['-root', '_NET_CLIENT_LIST'], 5000));
  if (!ids.length) return [];
  const infos = await mapLimit(ids.slice(0, MAX_WINDOWS * 2), XPROP_CONCURRENCY, (hexId) =>
    runX('xprop', ['-id', hexId, '_NET_WM_NAME', 'WM_NAME', '_NET_WM_PID'], 3000));
  const rows = [];
  ids.slice(0, MAX_WINDOWS * 2).forEach((hexId, i) => {
    const { pid, title } = parseWindowIdentity(infos[i]);
    // Untitled windows are utility/override-redirect surfaces, dropped here for
    // the same reason the wmctrl path drops them.
    if (!title) return;
    rows.push({ hexId, pid, title, dec: parseInt(hexId, 16) });
  });
  return rows;
}

// Raising a window means sending _NET_ACTIVE_WINDOW to the WM, which needs a
// real X client. Either tool can; wmctrl is tried second because xdotool takes
// the decimal id this API already carries.
async function focusWindow(decId) {
  if (await runX('xdotool', ['windowactivate', String(decId)], 5000) !== null) return { ok: true };
  const hex = '0x' + Number(decId).toString(16);
  if (await runX('wmctrl', ['-i', '-a', hex], 5000) !== null) return { ok: true };
  return { ok: false, error: 'no_window_tool' };
}

// The owning pid, without needing xdotool: it is a property on the window.
async function windowPid(hexId) {
  const raw = await runX('xprop', ['-id', hexId, '_NET_WM_PID'], 3000);
  const m = String(raw || '').match(/_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)/);
  return m ? m[1] : '';
}

async function closeWindow(decId) {
  const hex = '0x' + Number(decId).toString(16);
  const pid = await windowPid(hex);
  const exe = pid ? await appFromExe(pid) : { path: '', name: '' };
  const props = await windowProps(hex);
  if (PROTECTED_CLASSES.has(props.cls)) {
    return { ok: false, error: 'protected', app: props.cls };
  }
  // wmctrl -c sends the EWMH _NET_CLOSE_WINDOW request: a graceful close the app
  // can still veto (save prompt), mirroring the Windows CloseMainWindow path.
  // Deliberately never falls back to killing the pid: the contract here is
  // "ask the app to close", and a SIGTERM would discard unsaved work.
  const out = await runX('wmctrl', ['-i', '-c', hex], 5000);
  if (out === null) return { ok: false, error: 'no_window_tool', app: props.cls || exe.name || '', path: exe.path };
  return { ok: true, app: props.cls || exe.name || '', path: exe.path };
}

module.exports = {
  MAX_WINDOWS, XPROP_CONCURRENCY, xEnv, runX, PROTECTED_CLASSES, appFromExe, parseWmctrl,
  parseWindowProps, windowProps, parseClientList, parseWindowIdentity, listRowsViaXprop,
  focusWindow, windowPid, closeWindow,
};
