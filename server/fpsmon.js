'use strict';

// ─────────────────────────────────────────────────────────────────────────
// In-game FPS via PresentMon (Intel, open source).
//
// PresentMon captures present events through ETW, so it reports the *real*
// frame rate of any application — including exclusive-fullscreen games that
// bypass the desktop compositor (where the DWM fallback in network.ps1 reads
// nothing). It needs administrator rights (ETW tracing).
//
// We stream PresentMon's CSV to stdout, parse it by *header name* (so it keeps
// working across CLI versions), keep a short rolling window of frame times per
// process, and expose the busiest recent process's FPS. If PresentMon is not
// present (or fails to start, e.g. no admin), getCurrentFps() returns null and
// the server falls back to the existing methods.
//
// Place the classic single-binary PresentMon CLI at one of:
//   server/presentmon/PresentMon.exe   (recommended)
//   server/PresentMon.exe
// or anywhere on PATH as "PresentMon.exe".
// ─────────────────────────────────────────────────────────────────────────

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SAMPLE_WINDOW_MS = 2000;   // a process must have presented this recently
const MAX_SAMPLES = 240;         // rolling frame-time samples kept per process
const RESTART_DELAY_MS = 5000;   // wait before relaunching after an exit
const FAIL_BACKOFF_MS = 60000;   // back off hard after repeated instant failures
const GAMING_GRACE_MS = 10000;   // stay "gaming" briefly after frames stop (anti-flicker)
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
// browsers and are ignored.
function isGamingPresentMode(modeRaw) {
  const mode = normHeader(modeRaw);
  return mode.startsWith('hardware') || mode.includes('independentflip');
}

// Where the single-binary PresentMon CLI is expected to live.
const PRESENTMON_CANDIDATES = [
  path.join(__dirname, 'presentmon', 'PresentMon.exe'),
  path.join(__dirname, 'PresentMon.exe'),
];

// Dedicated ETW session name. PresentMon's default name ("PresentMon") is
// shared territory: other frame tools use the same collector, and our
// -stop_existing_session would steal the session from whoever owns it (the
// NVIDIA App's FPS overlay reads frames through the same mechanism). With our
// own name, -stop_existing_session only ever clears a stale session left by a
// previous unclean Xenon exit — never another tool's.
const ETW_SESSION_NAME = 'XenonFps';

let _proc = null;
let _cols = null;                // { frameTime, fps, app, pid }
let _consecutiveFastFails = 0;
let _stopped = false;            // terminal: server shutting down, never restart
// Paused starts TRUE: PresentMon runs an admin ETW tracing session, so it stays
// idle until a dashboard actually connects (resumeFpsMonitor) and is torn back
// down when the last one leaves (pauseFpsMonitor) — no system-wide cost while
// nobody is watching FPS / game-mode. Distinct from _stopped: pause is reversible.
let _paused = true;
let _buffer = '';
let _restartTimer = null;        // pending relaunch timer, so reload() can pre-empt it
let _lastGamingAt = 0;           // last time a real app was presenting (for grace window)
const _byPid = new Map();        // pid -> { name, samples:number[], usesFps:bool, lastSeen:number }

function presentMonPath() {
  for (const candidate of PRESENTMON_CANDIDATES) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return 'PresentMon.exe'; // last resort: rely on PATH (spawn errors → fallback)
}

// True when the PresentMon binary is present locally (vs. relying on PATH).
function isAvailable() {
  return PRESENTMON_CANDIDATES.some(c => { try { return fs.existsSync(c); } catch { return false; } });
}

// A killed PresentMon cannot clean up after itself: proc.kill() is
// TerminateProcess on Windows, and the ETW session it registered survives the
// process — until reboot — unless stopped explicitly. logman ships with
// Windows. Without the admin rights PresentMon needs, no session was ever
// created and the stop fails; every outcome is deliberately ignored.
function stopEtwSession() {
  if (process.platform !== 'win32') return;
  try {
    spawn('logman.exe', ['stop', ETW_SESSION_NAME, '-ets'], { windowsHide: true, stdio: 'ignore' })
      .on('error', () => { /* ignore */ })
      .unref(); // must never delay server shutdown
  } catch { /* ignore */ }
}

function normHeader(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Build a column-index map from the CSV header, tolerant of version differences.
function parseHeader(fields) {
  const norm = fields.map(normHeader);
  const find = pred => norm.findIndex(pred);
  const frameTime = find(n => n.includes('betweenpresents')); // msBetweenPresents
  const fps = find(n => n === 'fps' || n.endsWith('fps') || n.includes('displayedfps'));
  const app = find(n => n === 'application' || n.includes('processname'));
  const pid = find(n => n.includes('processid'));
  const presentMode = find(n => n.includes('presentmode'));
  if (frameTime < 0 && fps < 0) return null; // nothing usable
  return { frameTime, fps, app, pid, presentMode };
}

function handleRow(fields) {
  if (!_cols) return;
  const pidRaw = _cols.pid >= 0 ? fields[_cols.pid] : '';
  const pid = String(pidRaw || '').trim() || (_cols.app >= 0 ? fields[_cols.app] : '?');
  const name = (_cols.app >= 0 ? String(fields[_cols.app] || '') : '').trim().toLowerCase();
  if (isIgnoredProc(name)) return;

  // When PresentMon reports the present mode, keep only flip-model (game) presents
  // so windowed desktop apps and the dashboard's own browser don't count.
  if (_cols.presentMode >= 0 && !isGamingPresentMode(fields[_cols.presentMode])) return;

  let value, usesFps;
  if (_cols.frameTime >= 0) {
    const ft = parseFloat(fields[_cols.frameTime]);
    if (!Number.isFinite(ft) || ft <= 0 || ft > 1000) return;
    value = ft; usesFps = false;
  } else {
    const f = parseFloat(fields[_cols.fps]);
    if (!Number.isFinite(f) || f <= 0 || f > 1000) return;
    value = f; usesFps = true;
  }

  let entry = _byPid.get(pid);
  if (!entry) { entry = { name, samples: [], usesFps, lastSeen: 0 }; _byPid.set(pid, entry); }
  entry.name = name || entry.name;
  entry.usesFps = usesFps;
  entry.samples.push(value);
  if (entry.samples.length > MAX_SAMPLES) entry.samples.shift();
  entry.lastSeen = Date.now();
}

function onData(chunk) {
  _buffer += chunk;
  let nl;
  while ((nl = _buffer.indexOf('\n')) >= 0) {
    const line = _buffer.slice(0, nl).replace(/\r$/, '').trim();
    _buffer = _buffer.slice(nl + 1);
    if (!line) continue;
    const fields = line.split(',');
    if (!_cols) {
      // The header is the first line containing recognisable column names.
      if (/application|processid|presents/i.test(line)) _cols = parseHeader(fields);
      continue;
    }
    _consecutiveFastFails = 0; // we're getting real data → healthy
    try { handleRow(fields); } catch { /* ignore a malformed row */ }
  }
}

function start() {
  if (_stopped || _paused || process.platform !== 'win32') return;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  const exe = presentMonPath();
  _cols = null;
  _buffer = '';
  _byPid.clear(); // fresh PresentMon session → PIDs from the old one are meaningless
  const startedAt = Date.now();
  try {
    _proc = spawn(exe, ['-output_stdout', '-stop_existing_session', '-no_top', '-session_name', ETW_SESSION_NAME], { windowsHide: true });
  } catch {
    _proc = null;
    scheduleRestart(startedAt);
    return;
  }
  _proc.stdout.on('data', d => onData(d.toString('utf8')));
  _proc.stderr.on('data', () => { /* PresentMon logs warnings here; ignore */ });
  _proc.on('error', () => { _proc = null; scheduleRestart(startedAt); });
  _proc.on('close', () => { _proc = null; scheduleRestart(startedAt); });
}

function scheduleRestart(startedAt) {
  if (_stopped || _paused) return;
  // If PresentMon dies almost immediately it usually means it's missing or we
  // lack admin rights — back off so we don't spin relaunching it.
  if (Date.now() - startedAt < 2500) _consecutiveFastFails++; else _consecutiveFastFails = 0;
  const delay = _consecutiveFastFails >= 3 ? FAIL_BACKOFF_MS : RESTART_DELAY_MS;
  if (_restartTimer) clearTimeout(_restartTimer);
  _restartTimer = setTimeout(start, delay);
}

function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// How long a silent process keeps its slot before being dropped. Long enough
// to survive loading screens, short enough that _byPid never accumulates every
// PID seen over a 24/7 uptime.
const STALE_ENTRY_MS = 60000;

// The busiest recently-presenting process (i.e. our best "active game" guess).
// Doubles as the pruning pass: stale PIDs are evicted while we scan, keeping
// the map bounded to processes that presented in the last minute.
function _bestEntry() {
  const now = Date.now();
  let best = null;
  for (const [pid, entry] of _byPid) {
    if (now - entry.lastSeen > STALE_ENTRY_MS) { _byPid.delete(pid); continue; }
    if (now - entry.lastSeen > SAMPLE_WINDOW_MS) continue;
    if (!entry.samples.length) continue;
    if (!best || entry.samples.length > best.samples.length) best = entry;
  }
  return best;
}

function _entryFps(entry) {
  const m = median(entry.samples);
  if (!Number.isFinite(m) || m <= 0) return null;
  return Math.round(entry.usesFps ? m : 1000 / m);
}

// FPS of the busiest recently-presenting process (the active game), or null.
function getCurrentFps() {
  const best = _bestEntry();
  return best ? _entryFps(best) : null;
}

// Diagnostic: name + fps of the process currently driving game detection, or
// null. Used to identify false positives (e.g. the dashboard's own host).
function getGamingProcess() {
  const best = _bestEntry();
  if (!best) return null;
  const fps = _entryFps(best);
  return fps == null ? null : { name: best.name || '?', fps };
}

// True while a real foreground app is presenting frames (a game or other
// GPU-intensive app). A short grace window keeps it stable between samples so
// the dashboard's game-mode doesn't flicker on momentary FPS dropouts.
function isGaming() {
  if (getCurrentFps() != null) { _lastGamingAt = Date.now(); return true; }
  return _lastGamingAt > 0 && (Date.now() - _lastGamingAt) < GAMING_GRACE_MS;
}

function startFpsMonitor() {
  if (_stopped || _paused || _proc) return;
  start();
}

// Re-attempt right away (e.g. just after PresentMon was installed), pre-empting
// any pending back-off timer instead of waiting it out.
function reload() {
  if (_stopped || _paused) return;
  _consecutiveFastFails = 0;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  if (!_proc) start();
}

// Pause/resume tie PresentMon's admin ETW session to whether a dashboard is
// actually connected (see server.js SSE lifecycle). Unlike stopFpsMonitor these
// are reversible: pause tears the process down but leaves the module runnable.
function pauseFpsMonitor() {
  if (_paused) return;
  _paused = true;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  if (_proc) { try { _proc.kill(); } catch { /* ignore */ } _proc = null; stopEtwSession(); }
  _byPid.clear(); // a future session's PIDs are unrelated to this one
}

function resumeFpsMonitor() {
  if (_stopped) return;
  _paused = false;
  _consecutiveFastFails = 0;
  if (!_proc) start();
}

function stopFpsMonitor() {
  _stopped = true;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  if (_proc) { try { _proc.kill(); } catch { /* ignore */ } _proc = null; stopEtwSession(); }
  _byPid.clear();
}

module.exports = { startFpsMonitor, stopFpsMonitor, pauseFpsMonitor, resumeFpsMonitor, getCurrentFps, getGamingProcess, isGaming, isAvailable, reload };
