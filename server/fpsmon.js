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
const { createGameSession } = require('./fps-game-session');
const { createReaderLog, createStderrTail } = require('./fps-reader-log');

const {
  pickEntry, entryFps, entryStats, entryWindow, entryFramesSince, entryForGame,
} = require('./performance/fps-reading.js');
const RESTART_DELAY_MS = 5000;   // wait before relaunching after an exit
const FAIL_BACKOFF_MS = 60000;   // back off hard after repeated instant failures
const GAMING_GRACE_MS = 10000;   // stay "gaming" briefly after frames stop (anti-flicker)
const { isTrackedGame, parseHeader, rowValues } = require('./performance/presentmon-rows.js');

const {
  _csv, _byPid, entryFor, record, handleGameRow, readRows, _gameCsv,
} = require('./performance/fps-entries.js');

// Where the single-binary PresentMon CLI is expected to live.
const PRESENTMON_CANDIDATES = [
  path.join(__dirname, 'presentmon', 'PresentMon.exe'),
  path.join(__dirname, 'PresentMon.exe'),
];

const {
  ETW_SESSION_NAME, GAME_SESSION_NAME, stopEtwSession,
} = require('./performance/presentmon-session.js');

const { fpsWatch } = require('./performance/fpsmon-state.js');
// PresentMon runs on Windows only: elsewhere this module reads nothing to report.
const _readerLog = createReaderLog(process.platform === 'win32' ? (line) => console.warn(line) : () => {});

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

function handleRow(fields, game) {
  const r = rowValues(_csv.cols, fields, game);
  if (!r) return;
  if (r.composed && isTrackedGame(game, r.pid, r.name)) _gameFrames.want(r.pid);
  const entry = entryFor(r);
  entry.exclusive = r.exclusive;
  if (!_gameFrames.owns(r.pid)) record(entry, r);
}

function onData(chunk) {
  const game = trackedGame();
  readRows(_csv, chunk, (fields) => {
    fpsWatch.consecutiveFastFails = 0; // we're getting real data → healthy
    _readerLog.rows();
    handleRow(fields, game);
  });
  _gameFrames.tick();
}

const _gameFrames = createGameSession({
  launch: pid => spawn(presentMonPath(), [
    '-output_stdout', '-stop_existing_session', '-no_top', '-session_name', GAME_SESSION_NAME,
    '-process_id', pid, '-no_track_display', '-terminate_on_proc_exit',
  ], { windowsHide: true }),
  onChunk(text, fresh) {
    if (fresh) { _gameCsv.buffer = ''; _gameCsv.cols = null; }
    const game = trackedGame();
    readRows(_gameCsv, text, fields => handleGameRow(fields, game));
  },
  stopTrace: () => stopEtwSession(GAME_SESSION_NAME),
});

function start() {
  if (fpsWatch.stopped || fpsWatch.paused || process.platform !== 'win32') return;
  if (fpsWatch.restartTimer) { clearTimeout(fpsWatch.restartTimer); fpsWatch.restartTimer = null; }
  const exe = presentMonPath();
  _csv.cols = null;
  _csv.buffer = '';
  _byPid.clear(); // fresh PresentMon session → PIDs from the old one are meaningless
  const startedAt = Date.now();
  try {
    fpsWatch.proc = spawn(exe, ['-output_stdout', '-stop_existing_session', '-no_top', '-session_name', ETW_SESSION_NAME], { windowsHide: true });
  } catch (e) {
    fpsWatch.proc = null;
    _readerLog.ended(startedAt, e && e.message);
    scheduleRestart(startedAt);
    return;
  }
  // A process killed by pause can close after resume started its successor:
  // only the current one may feed the parser, clear fpsWatch.proc or schedule a restart.
  const proc = fpsWatch.proc;
  const ended = (why) => {
    if (fpsWatch.proc !== proc) return;
    fpsWatch.proc = null;
    _readerLog.ended(startedAt, why);
    scheduleRestart(startedAt);
  };
  proc.stdout.on('data', d => { if (fpsWatch.proc === proc) onData(d.toString('utf8')); });
  const stderr = createStderrTail();
  proc.stderr.on('data', (d) => stderr.add(d.toString('utf8')));
  proc.on('error', (e) => ended((e && e.code) || 'error'));
  proc.on('close', (code, signal) => ended(stderr.explain(signal || 'code ' + code)));
}

function scheduleRestart(startedAt) {
  if (fpsWatch.stopped || fpsWatch.paused) return;
  // If PresentMon dies almost immediately it usually means it's missing or we
  // lack admin rights — back off so we don't spin relaunching it.
  if (Date.now() - startedAt < 2500) fpsWatch.consecutiveFastFails++; else fpsWatch.consecutiveFastFails = 0;
  const delay = fpsWatch.consecutiveFastFails >= 3 ? FAIL_BACKOFF_MS : RESTART_DELAY_MS;
  if (fpsWatch.restartTimer) clearTimeout(fpsWatch.restartTimer);
  fpsWatch.restartTimer = setTimeout(start, delay);
}

// How long a silent process keeps its slot before being dropped. Long enough
// to survive loading screens, short enough that _byPid never accumulates every
// PID seen over a 24/7 uptime.
const STALE_ENTRY_MS = 60000;

// Which process is the game. PresentMon captures EVERY presenter on the machine,
// so one of them has to be chosen — and "the busiest" is a guess that goes wrong
// in the obvious way: a launcher, an overlay or a second game left running can
// out-present the game the user is actually looking at.
//
// The foreground window is the better answer when we have it, so it wins when it
// is also presenting. Supplied by server.js rather than required here, because
// gamedetect.js already reads THIS module for its own hint and two modules
// requiring each other is how that ends badly.
let _foregroundPid = null;       // () => number|0
function setForegroundPid(fn) { _foregroundPid = typeof fn === 'function' ? fn : null; }

let _trackedGame = null;         // () => { pid, name }|null
function setTrackedGame(fn) { _trackedGame = typeof fn === 'function' ? fn : null; }
function trackedGame() {
  try { return _trackedGame ? _trackedGame() : null; } catch { return null; }
}

// The live table's pick. Doubles as the pruning pass: stale PIDs are evicted
// while we scan, keeping the map bounded to processes that presented recently.
function _bestEntry() {
  const now = Date.now();
  for (const [pid, entry] of _byPid) {
    if (now - entry.lastSeen > STALE_ENTRY_MS) _byPid.delete(pid);
  }
  let wanted = '';
  try { wanted = _foregroundPid ? String(_foregroundPid() || '') : ''; } catch { wanted = ''; }
  return pickEntry(_byPid, now, wanted);
}

// FPS of the active game, or null.
function getCurrentFps() {
  return entryFps(_bestEntry()).fps;
}

// Both sides, for a widget that wants to show what frame generation is doing.
// Either may be null on its own.
function getFpsDetail() {
  return entryFps(_bestEntry());
}

// Average, 1% and 0.1% lows and frame-time percentiles of the active game, or
// null. Computed on demand: nothing here runs per frame except the ring store.
function getFrameStats() {
  const best = _bestEntry();
  const stats = entryStats(best);
  return stats ? Object.assign({ process: best.name || '', exclusive: best.exclusive === true }, stats) : null;
}

// The same, for the active game.
function getFrameWindow(n) {
  return entryWindow(_bestEntry(), n);
}

function getFramesSince(mark, game) {
  _bestEntry();   // prunes stale entries
  return entryFramesSince(entryForGame(_byPid, game), mark);
}

// Diagnostic: name + fps of the process currently driving game detection, or
// null. Used to identify false positives (e.g. the dashboard's own host).
function getGamingProcess() {
  const best = _bestEntry();
  if (!best) return null;
  const { fps } = entryFps(best);
  return fps == null ? null : { name: best.name || '?', fps };
}

// True while a real foreground app is presenting frames (a game or other
// GPU-intensive app). A short grace window keeps it stable between samples so
// the dashboard's game-mode doesn't flicker on momentary FPS dropouts.
function isGaming() {
  if (getCurrentFps() != null) { fpsWatch.lastGamingAt = Date.now(); return true; }
  return fpsWatch.lastGamingAt > 0 && (Date.now() - fpsWatch.lastGamingAt) < GAMING_GRACE_MS;
}

function startFpsMonitor() {
  if (fpsWatch.stopped || fpsWatch.paused || fpsWatch.proc) return;
  start();
}

// Re-attempt right away (e.g. just after PresentMon was installed), pre-empting
// any pending back-off timer instead of waiting it out.
function reload() {
  if (fpsWatch.stopped || fpsWatch.paused) return;
  fpsWatch.consecutiveFastFails = 0;
  if (fpsWatch.restartTimer) { clearTimeout(fpsWatch.restartTimer); fpsWatch.restartTimer = null; }
  if (!fpsWatch.proc) start();
}

// Pause/resume tie PresentMon's admin ETW session to whether a dashboard is
// actually connected (see server.js SSE lifecycle). Unlike stopFpsMonitor these
// are reversible: pause tears the process down but leaves the module runnable.
function pauseFpsMonitor() {
  if (fpsWatch.paused) return;
  fpsWatch.paused = true;
  _readerLog.reading(false);
  if (fpsWatch.restartTimer) { clearTimeout(fpsWatch.restartTimer); fpsWatch.restartTimer = null; }
  if (fpsWatch.proc) { try { fpsWatch.proc.kill(); } catch { /* ignore */ } fpsWatch.proc = null; stopEtwSession(); }
  _gameFrames.stop();
  _byPid.clear(); // a future session's PIDs are unrelated to this one
}

function resumeFpsMonitor() {
  if (fpsWatch.stopped) return;
  fpsWatch.paused = false;
  _readerLog.reading(true);
  fpsWatch.consecutiveFastFails = 0;
  if (!fpsWatch.proc) start();
}

function stopFpsMonitor() {
  fpsWatch.stopped = true;
  if (fpsWatch.restartTimer) { clearTimeout(fpsWatch.restartTimer); fpsWatch.restartTimer = null; }
  if (fpsWatch.proc) { try { fpsWatch.proc.kill(); } catch { /* ignore */ } fpsWatch.proc = null; stopEtwSession(); }
  _gameFrames.stop();
  _byPid.clear();
}

module.exports = {
  startFpsMonitor, stopFpsMonitor, pauseFpsMonitor, resumeFpsMonitor,
  getCurrentFps, getFpsDetail, getFrameStats, getFrameWindow, getFramesSince, getGamingProcess, setForegroundPid, setTrackedGame,
  isGaming, isAvailable, reload,
  // Pure, and exported so every decision this module makes can be pinned
  // without a Windows box with a game running on it.
  parseHeader, rowValues, pickEntry, entryFps, entryStats, entryWindow, entryFramesSince, entryForGame,
};
