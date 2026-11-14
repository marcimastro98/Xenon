'use strict';
// The open apps of a Mac for the app switcher: the list System Events or the helper gives,
// cleaned, and the osascript calls that ask and quit.

const { runSoft, splitLines } = require('./darwin-read.js');

// --- Open applications / app switcher: System Events -----------------------
// Xenon's /windows endpoint (list/focus/close) drives the "Open applications"
// widget through a Windows helper (windows.ps1, Win32 EnumWindows). The same
// JSON contract is reproduced here:
//   list  -> { windows: [ { id, title, app, path, active, minimized, icon } ] }
//   focus -> { ok }
//   close -> { ok, app, path }  (or { ok:false, error:'protected'|'not_found' })
// ids must satisfy server.js's /^\d{1,24}$/, so the process id is the id.
//
// This lists one entry per APPLICATION, not per window. macOS has no
// unprivileged per-window enumeration (AXUIElement needs Accessibility), and an
// app switcher that switches apps is the useful half of that anyway.
const MAX_WINDOWS = 24;

// Quitting these would log the user out or take the desktop down with it.
const PROTECTED_APPS = new Set([
  'Finder', 'System Events', 'loginwindow', 'Dock', 'SystemUIServer',
  'WindowManager', 'ControlCenter', 'NotificationCenter', 'Xenon',
]);

const LIST_APPS_SCRIPT = `
tell application "System Events"
  set out to ""
  repeat with p in (application processes whose background only is false)
    try
      set pnm to name of p
      set pid_ to unix id of p
      set isFront to frontmost of p
      set apath to ""
      try
        set apath to POSIX path of (file of p as alias)
      end try
      set wtitle to ""
      try
        set wtitle to name of first window of p
      end try
      set out to out & pid_ & tab & pnm & tab & apath & tab & isFront & tab & wtitle & linefeed
    end try
  end repeat
  return out
end tell`;

// `includeProtected` is for the close path only: a quit aimed at Finder has to
// be able to say so, and it cannot if the shell was already filtered out — the
// lookup would miss and report the window as gone instead.
function parseAppList(out, includeProtected) {
  const windows = [];
  for (const line of splitLines(out)) {
    if (!line.trim()) continue;
    const f = line.split('\t');
    if (f.length < 4) continue;
    const id = f[0].trim();
    if (!/^\d{1,24}$/.test(id)) continue;
    const app = (f[1] || '').trim();
    if (!app || (!includeProtected && PROTECTED_APPS.has(app))) continue;
    windows.push({
      id,
      title: (f[4] || '').trim() || app,
      app,
      path: (f[2] || '').trim(),
      active: (f[3] || '').trim() === 'true',
      minimized: false, // needs Accessibility; never guessed
      icon: null,
    });
    if (windows.length >= MAX_WINDOWS) break;
  }
  return windows;
}

// The helper reads the same list from NSWorkspace and the window server, which
// is worth preferring for two reasons the timings make obvious: the osascript
// path below costs 3-5 SECONDS per call (it scripts every process in turn),
// against about ten milliseconds here — and, more importantly, it needs the
// Automation grant. System Events prompts once per app and lists nothing the
// user has not approved, so a declined prompt leaves the widget permanently
// empty with no way back from inside Xenon. The helper needs no grant at all.
// Pure, so the shape check is testable without a Mac.
function parseHelperWindows(raw, includeProtected) {
  let doc;
  try { doc = JSON.parse(String(raw || '')); } catch { return null; }
  if (!doc || !Array.isArray(doc.windows)) return null;
  const windows = [];
  for (const w of doc.windows) {
    if (!w || typeof w !== 'object') continue;
    const id = String(w.id == null ? '' : w.id).trim();
    if (!/^\d{1,24}$/.test(id)) continue;                  // server.js's own id shape
    const app = String(w.app == null ? '' : w.app).trim();
    if (!app || (!includeProtected && PROTECTED_APPS.has(app))) continue;
    windows.push({
      id,
      title: String(w.title == null ? '' : w.title).trim() || app,
      app,
      path: String(w.path == null ? '' : w.path).trim(),
      active: w.active === true,
      minimized: w.minimized === true,
      icon: null,
    });
    if (windows.length >= MAX_WINDOWS) break;
  }
  return windows;
}

const osa = (script, timeoutMs) => runSoft('osascript', ['-e', script], timeoutMs);
// Writes use this one. A failed osascript resolves null through runSoft, and
// swallowing that would confirm a volume change that never reached Core Audio —
// the Deck key would flash success while nothing moved. The Linux twin lets
// every wpctl write reject for exactly this reason.
async function osaWrite(script, timeoutMs) {
  const out = await osa(script, timeoutMs);
  if (out === null) throw new Error(`osascript failed: ${script}`);
  return out;
}

// osascript argv for a graceful `quit` of the named app. The name comes from
// the window list, i.e. from whatever another program chose to call itself, so
// it travels as an argument (`item 1 of argv`) and is never spliced into the
// script text: backslash/quote escaping was the only thing standing between a
// crafted app name and arbitrary AppleScript (`do shell script …`). A name that
// starts with "-" is refused because osascript would read it as an option, and
// control characters never appear in a real app name.
function quitAppArgs(name) {
  const n = String(name == null ? '' : name);
  if (!n || n.startsWith('-') || /[\u0000-\u001f\u007f]/.test(n)) return null;
  return ['-e', 'on run argv', '-e', 'tell application (item 1 of argv) to quit', '-e', 'end run', n];
}

// A helper that ANSWERED is authoritative, including when it answers "no".
// Only a helper that could not run at all falls through to osascript: retrying
// a refused close down the second path would quit an app the first path had
// already decided to protect, and retrying a successful one is worse.
function helperVerdict(raw) {
  let doc;
  try { doc = JSON.parse(String(raw || '')); } catch { return null; }
  return doc && typeof doc === 'object' && typeof doc.ok === 'boolean' ? doc : null;
}

module.exports = {
  MAX_WINDOWS, PROTECTED_APPS, LIST_APPS_SCRIPT, parseAppList, parseHelperWindows, osa, osaWrite,
  quitAppArgs, helperVerdict,
};
