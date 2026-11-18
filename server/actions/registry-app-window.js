'use strict';
// What the Deck's window keys may do, decided here and nowhere else: windowMove moves the window
// in front by a fixed verb, closeApp closes or minimizes every window of the app a key names.
// app-windows/ only carries the act out.
//
// closeApp asks, never forces: "close" is what the app's own X does, so an app with unsaved work
// can still ask about it. There is no force-quit mode: a key or a sentence Bit read could then
// throw away someone's work with no question asked.
//
// Never Xenon itself (it would take down the key that pressed it) and never the system's own
// processes (the desktop, the session, the window server): closing one logs the user out or
// leaves a black screen. The name typed on the key is checked, and so is every window it matches,
// by its listed name and by the file it runs from.

const MODES = Object.freeze(['close', 'minimize']);
// A program name as a window list or a person writes it: no path, no quotes, no wildcards.
const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._+&()'_-]{0,63}$/u;
// One press acts on at most this many windows.
const MAX_TARGETS = 16;

const PROTECTED = new Set([
  // Windows: the session, the desktop and the shell's own windows.
  'system', 'idle', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso',
  'svchost', 'dwm', 'explorer', 'fontdrvhost', 'sihost', 'ctfmon', 'taskhostw', 'runtimebroker',
  'searchhost', 'searchapp', 'startmenuexperiencehost', 'shellexperiencehost', 'textinputhost',
  'applicationframehost', 'lockapp', 'logonui', 'audiodg', 'spoolsv', 'conhost', 'dllhost', 'wudfhost',
  'securityhealthservice', 'securityhealthsystray', 'msmpeng', 'nissrv',
  // macOS: the desktop, the Dock, the menu bar and the window server.
  'finder', 'dock', 'windowserver', 'loginwindow', 'launchd', 'systemuiserver', 'controlcenter',
  'notificationcenter', 'system events', 'windowmanager', 'spotlight', 'coreservicesuiagent',
  // Linux: init, the display server, the desktop shells and the sound server.
  'systemd', 'init', 'xorg', 'xwayland', 'gnome-shell', 'plasmashell', 'kwin', 'kwin_x11', 'kwin_wayland',
  'mutter', 'xfdesktop', 'xfce4-panel', 'xfwm4', 'cinnamon', 'marco', 'gdm', 'gdm3', 'sddm', 'lightdm',
  'pipewire', 'wireplumber', 'pulseaudio', 'dbus-daemon',
  // Xenon's engine, its window and its sensor workers (every "xenon…" name is refused below).
  'node', 'msedgewebview2', 'powershell', 'pwsh',
]);

// "Chrome.exe", "/usr/bin/firefox", "Safari.app" -> "chrome", "firefox", "safari".
function appKey(raw) {
  const base = String(raw == null ? '' : raw).trim().split(/[\\/]/).filter(Boolean).pop() || '';
  return base.replace(/\.(exe|app)$/i, '').trim().toLowerCase();
}

function isProtectedApp(raw) {
  const key = appKey(raw);
  return !!key && (PROTECTED.has(key) || key.startsWith('xenon'));
}

// The names a listed window answers to: what the list calls it and the file it runs from.
const rowKeys = (row) => [appKey(row?.app), appKey(row?.path)].filter(Boolean);

// The windows a press acts on: one per process for a close (the app closes, not each window
// in turn), each window for a minimize; ones already minimized stay as they are.
function pickTargets(rows, mode) {
  if (mode === 'minimize') return rows.filter((r) => r.minimized !== true).slice(0, MAX_TARGETS);
  const seen = new Set();
  return rows.filter((r) => {
    const pid = Number.isSafeInteger(r.processId) ? 'p' + r.processId : 'w' + r.id;
    if (seen.has(pid)) return false;
    seen.add(pid);
    return true;
  }).slice(0, MAX_TARGETS);
}

// What the person reads when nothing worked: the one reason they can act on, if there is one.
function failure(results, mode) {
  const errors = results.map((r) => r?.error || '');
  if (errors.includes('no_window_tool')) return 'no_window_tool';
  if (errors.includes('protected')) return 'app_protected';
  return mode === 'close' ? 'app_close_refused' : 'window_failed';
}

async function closeApp(action, d) {
  const name = String(action.app == null ? '' : action.app).trim();
  if (!name) return { ok: false, error: 'empty_app' };
  if (!APP_NAME.test(name) || name.includes('..')) return { ok: false, error: 'bad_app_name' };
  if (!MODES.includes(action.mode)) return { ok: false, error: 'bad_mode' };
  if (isProtectedApp(name)) return { ok: false, error: 'app_protected' };
  const w = d.appWindows;
  if (!w || typeof w.list !== 'function' || !(await w.available())) return { ok: false, error: 'unavailable' };
  const key = appKey(name);
  const matched = (await w.list()).filter((row) => row && /^\d{1,24}$/.test(String(row.id)) && rowKeys(row).includes(key));
  if (!matched.length) return { ok: false, error: 'app_not_open' };
  const allowed = matched.filter((row) => !rowKeys(row).some(isProtectedApp));
  if (!allowed.length) return { ok: false, error: 'app_protected' };
  const targets = pickTargets(allowed, action.mode);
  if (!targets.length) return { ok: true };
  const results = [];
  // One at a time: a close may open a "save changes?" dialog that the next one must not race.
  for (const row of targets) {
    results.push(await (action.mode === 'close' ? w.close(row) : w.minimize(row)).catch(() => null));
  }
  return results.some((r) => r && r.ok === true) ? { ok: true } : { ok: false, error: failure(results, action.mode) };
}

// The window in front. `dir` is constrained to the catalog's option list, so the verb
// handed to the window script is always one of a fixed allowlist.
async function windowMove(action, d) {
  if (typeof d.windowAction !== 'function') return { ok: false, error: 'window_unavailable' };
  const r = await d.windowAction(action.dir);
  return r && r.ok === false ? { ok: false, error: r.error || 'window_failed' } : { ok: true };
}

function runWindowAction(action, d) {
  return action.type === 'closeApp' ? closeApp(action, d) : windowMove(action, d);
}

module.exports = { runWindowAction, closeApp, appKey, isProtectedApp, pickTargets, PROTECTED, MODES, MAX_TARGETS };
