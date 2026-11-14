'use strict';
// Reads PresentMon's output: the columns of its header, one row as values, which programs are
// not games, and how a game is presenting its frames.

const IGNORE_PROCS = new Set([
  'dwm.exe', 'explorer.exe', 'presentmon.exe', 'searchhost.exe', 'shellexperiencehost.exe',
  // Terminals render flip-model frames (DWM can promote them to Independent Flip)
  // but are never games — the WindowsTerminal false positive the user reported.
  'windowsterminal.exe', 'conhost.exe', 'openconsole.exe', 'cmd.exe', 'powershell.exe',
  'pwsh.exe', 'wt.exe', 'alacritty.exe', 'wezterm-gui.exe', 'mintty.exe', 'putty.exe',
  'tabby.exe', 'hyper.exe',
  // Always-on GPU chat/media apps.
  'discord.exe', 'slack.exe', 'spotify.exe',
]);
// Processes that present frames continuously but are never games, so PresentMon
// must not treat them as one:
//  - Browser / WebView engines: the dashboard itself runs inside one of these
//    and on the Xeneon Edge it is full-screen, so it would otherwise look like a
//    game and pin game-mode permanently on (cloud-gaming-in-browser is the rare,
//    accepted cost of this exclusion).
//  - iCUE / Corsair: always running on this hardware and renders the Xeneon Edge
//    and RGB previews at the display refresh rate — the actual false positive
//    observed on the device (icue.exe ~74 fps).
//  - Wallpaper Engine and similar animated-wallpaper apps: perpetual presenters.
const IGNORE_PROC_RE = /msedge|chrome|firefox|brave|opera|vivaldi|webview|iexplore|icue|corsair|wallpaper/;

function isIgnoredProc(name) {
  if (!name) return false;
  return IGNORE_PROCS.has(name) || IGNORE_PROC_RE.test(name);
}

// A PresentMode counts as a game only when it uses the flip model typical of
// full-screen / borderless games ("Hardware: …" exclusive, or any "Independent
// Flip"). Plain "Composed: …" presents come from windowed desktop apps and
// browsers and are ignored, except for the game already being tracked.
function isGamingPresentMode(modeRaw) {
  const mode = normHeader(modeRaw);
  return mode.startsWith('hardware') || mode.includes('independentflip');
}

const UNREADABLE_NAME = '<error>';

// The game gamedetect already found, whatever way it presents now: a window of
// ours above it, or the focus elsewhere, makes Windows compose it like a desktop
// app. By pid too, because a protected process reports its name as "<error>".
function isTrackedGame(game, pid, name) {
  if (!game) return false;
  if (game.pid && String(game.pid) === String(pid)) return true;
  return !!game.name && name.replace(/.exe$/, '') === game.name;
}

// "Hardware: Legacy Flip" / "Hardware: Legacy Copy to front buffer": exclusive
// full screen. Nothing outside the game can draw over it without injecting into
// it, which Xenon never does, so the overlay says so (exclusive-hint.js).
function isExclusivePresentMode(modeRaw) {
  return normHeader(modeRaw).startsWith('hardwarelegacy');
}

// "Composed: Flip" and the like. "Hardware Composed: Independent Flip" is not:
// that one is a flip mode, and display tracking reads it whole.
function isComposedPresentMode(modeRaw) {
  return normHeader(modeRaw).startsWith('composed');
}

function normHeader(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Build a column-index map from the CSV header, tolerant of version differences.
//
// TWO frame times are read, because with frame generation they stop agreeing.
//
//   present-side  how often the application (or the driver on its behalf) hands
//                 a frame over.  msBetweenPresents (PresentMon 1.x) / FrameTime (2.x)
//   display-side  how often the screen actually changes.
//                 msBetweenDisplayChange (1.x) / DisplayedTime (2.x)
//
// Without frame generation the two are within a frame of each other. With DLSS
// Frame Generation on they diverge hard — measured on one game at x2: presents
// 223/s, displayed 152/s, with RTSS and the NVIDIA overlay both reading ~155.
// Xenon read the present side and so showed ~220, a number nothing else agreed
// with. Reported by a widget author building an FPS monitor, with a PresentMon
// 2.3.1 capture attached.
//
// Display-side is the honest answer to "what frame rate am I seeing", so it is
// preferred wherever the CSV carries it — and it is the closer number even
// WITHOUT frame generation (69.2 displayed vs 65.6 presented, against an
// in-game counter reading 69.0 in the same capture).
//
// The measurements above came from a PresentMon 2.3.1 capture, which left one
// thing unproven: whether the 1.10 we actually ship tracks display timing
// correctly with frame generation on. It does — confirmed on the reporter's
// machine against the game and RTSS side by side, which is why there is no
// PresentMon upgrade here. What remains is a couple of frames between us and
// RTSS, from RTSS's own averaging rather than from the timing.
//
// Careful with the near-misses: PresentMon 1.x also has msUntilDisplayed, which
// is a LATENCY, not an interval, and matching it would turn the frame rate into
// nonsense. Hence the exact-ish tests below rather than a loose `displayed`.
function parseHeader(fields) {
  const norm = fields.map(normHeader);
  const find = pred => norm.findIndex(pred);
  const frameTime = find(n => n.includes('betweenpresents') || n === 'frametime');
  const displayTime = find(n => n.includes('betweendisplaychange') || n === 'displayedtime');
  const fps = find(n => n === 'fps' || n.endsWith('fps') || n.includes('displayedfps'));
  const app = find(n => n === 'application' || n.includes('processname'));
  const pid = find(n => n.includes('processid'));
  const presentMode = find(n => n.includes('presentmode'));
  if (frameTime < 0 && displayTime < 0 && fps < 0) return null; // nothing usable
  return { frameTime, displayTime, fps, app, pid, presentMode };
}

// One CSV row → what it says, or null when the row is not ours to count.
// Pure, so the whole of "which numbers does a PresentMon line yield" can be
// pinned without a Windows box and a game running on it.
function rowValues(cols, fields, game) {
  if (!cols) return null;
  const pidRaw = cols.pid >= 0 ? fields[cols.pid] : '';
  const pid = String(pidRaw || '').trim() || (cols.app >= 0 ? fields[cols.app] : '?');
  let name = (cols.app >= 0 ? String(fields[cols.app] || '') : '').trim().toLowerCase();
  if (isIgnoredProc(name)) return null;
  // No admin rights, or a protected process: PresentMon cannot read the name. The
  // window manager is one of those, and it presents as "Hardware: Legacy Flip".
  if (name === UNREADABLE_NAME) {
    if (!isTrackedGame(game, pid, name)) return null;
    name = game.name || '';
  }

  // When PresentMon reports the present mode, keep only flip-model (game) presents
  // so windowed desktop apps and the dashboard's own browser don't count.
  if (cols.presentMode >= 0 && !isGamingPresentMode(fields[cols.presentMode]) && !isTrackedGame(game, pid, name)) return null;

  let present = null, usesFps = false;
  if (cols.frameTime >= 0) {
    const ft = parseFloat(fields[cols.frameTime]);
    if (Number.isFinite(ft) && ft > 0 && ft <= 1000) present = ft;
  } else if (cols.fps >= 0) {
    const f = parseFloat(fields[cols.fps]);
    if (Number.isFinite(f) && f > 0 && f <= 1000) { present = f; usesFps = true; }
  }

  // A frame that was never displayed carries no display interval — blank, zero
  // or negative depending on the version. Those rows are dropped frames, and
  // counting one as an interval of zero would read as an infinite frame rate.
  let display = null;
  if (cols.displayTime >= 0) {
    const dt = parseFloat(fields[cols.displayTime]);
    if (Number.isFinite(dt) && dt > 0 && dt <= 1000) display = dt;
  }
  if (present == null && display == null) return null;
  const exclusive = cols.presentMode >= 0 && isExclusivePresentMode(fields[cols.presentMode]);
  const composed = cols.presentMode >= 0 && isComposedPresentMode(fields[cols.presentMode]);
  return { pid, name, present, display, usesFps, exclusive, composed };
}

module.exports = {
  IGNORE_PROCS, IGNORE_PROC_RE, isIgnoredProc, isGamingPresentMode, UNREADABLE_NAME, isTrackedGame,
  isExclusivePresentMode, isComposedPresentMode, normHeader, parseHeader, rowValues,
};
