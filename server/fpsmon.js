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
const { createFrameRing } = require('./frame-stats');
const { createGameSession } = require('./fps-game-session');
const { createReaderLog, createStderrTail } = require('./fps-reader-log');

const {
  pickEntry, entryFps, entryStats, entryWindow, entryFramesSince, entryForGame,
} = require('./performance/fps-reading.js');
const MAX_SAMPLES = 240;         // rolling frame-time samples kept per process
// Frames kept per process for the readers by mark (game sessions on the 3 s
// status tick, benchmarks every second): 6000 = nothing lost below 2000 FPS
// between two looks. The live stats still read the newest STATS_SAMPLES.
const RING_FRAMES = 6000;
const RESTART_DELAY_MS = 5000;   // wait before relaunching after an exit
const FAIL_BACKOFF_MS = 60000;   // back off hard after repeated instant failures
const GAMING_GRACE_MS = 10000;   // stay "gaming" briefly after frames stop (anti-flicker)
const { isTrackedGame, parseHeader, rowValues } = require('./performance/presentmon-rows.js');

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
const GAME_SESSION_NAME = `${ETW_SESSION_NAME}Game`;

let _proc = null;
const _csv = { buffer: '', cols: null };  // what the main process has sent: unfinished line, header
let _consecutiveFastFails = 0;
let _stopped = false;            // terminal: server shutting down, never restart
// Paused starts TRUE: PresentMon runs an admin ETW tracing session, so it stays
// idle until a dashboard actually connects (resumeFpsMonitor) and is torn back
// down when the last one leaves (pauseFpsMonitor) — no system-wide cost while
// nobody is watching FPS / game-mode. Distinct from _stopped: pause is reversible.
let _paused = true;
let _restartTimer = null;        // pending relaunch timer, so reload() can pre-empt it
let _lastGamingAt = 0;           // last time a real app was presenting (for grace window)
const _byPid = new Map();        // pid -> { name, samples:number[], usesFps:bool, lastSeen:number }
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

// A killed PresentMon cannot clean up after itself: proc.kill() is
// TerminateProcess on Windows, and the ETW session it registered survives the
// process — until reboot — unless stopped explicitly. logman ships with
// Windows. Without the admin rights PresentMon needs, no session was ever
// created and the stop fails; every outcome is deliberately ignored.
function stopEtwSession(name = ETW_SESSION_NAME) {
  if (process.platform !== 'win32') return;
  try {
    spawn('logman.exe', ['stop', name, '-ets'], { windowsHide: true, stdio: 'ignore' })
      .on('error', () => { /* ignore */ })
      .unref(); // must never delay server shutdown
  } catch { /* ignore */ }
}

function entryFor(r) {
  let entry = _byPid.get(r.pid);
  if (!entry) {
    entry = { name: r.name, samples: [], display: [], usesFps: r.usesFps, lastSeen: 0, presentRing: createFrameRing(RING_FRAMES), displayRing: createFrameRing(RING_FRAMES) };
    _byPid.set(r.pid, entry);
  }
  return entry;
}

function record(entry, r) {
  entry.name = r.name || entry.name;
  entry.usesFps = r.usesFps;
  if (r.present != null) { push(entry.samples, r.present); entry.presentRing.push(r.present); }
  if (r.display != null) { push(entry.display, r.display); entry.displayRing.push(r.display); }
  entry.lastSeen = Date.now();
}

function handleRow(fields, game) {
  const r = rowValues(_csv.cols, fields, game);
  if (!r) return;
  if (r.composed && isTrackedGame(game, r.pid, r.name)) _gameFrames.want(r.pid);
  const entry = entryFor(r);
  entry.exclusive = r.exclusive;
  if (!_gameFrames.owns(r.pid)) record(entry, r);
}

// A row of the second session (fps-game-session.js): every frame, present side
// only. The rows the main session left behind go, or their gaps of seconds would
// read as stutter and their display side would win over the complete one.
function handleGameRow(fields, game) {
  const r = rowValues(_gameCsv.cols, fields, game);
  if (!r) return;
  const entry = entryFor(r);
  if (entry.displayRing.size()) {
    entry.samples.length = 0;
    entry.display.length = 0;
    entry.presentRing.clear();
    entry.displayRing.clear();
  }
  record(entry, r);
}

function push(arr, v) {
  arr.push(v);
  if (arr.length > MAX_SAMPLES) arr.shift();
}

// Splits a PresentMon stream into rows. `csv` holds what one process has sent so
// far: the unfinished line and its header.
function readRows(csv, chunk, onRow) {
  csv.buffer += chunk;
  let nl;
  while ((nl = csv.buffer.indexOf('\n')) >= 0) {
    const line = csv.buffer.slice(0, nl).replace(/\r$/, '').trim();
    csv.buffer = csv.buffer.slice(nl + 1);
    if (!line) continue;
    const fields = line.split(',');
    if (!csv.cols) {
      // The header is the first line containing recognisable column names.
      if (/application|processid|presents/i.test(line)) csv.cols = parseHeader(fields);
      continue;
    }
    try { onRow(fields); } catch { /* ignore a malformed row */ }
  }
}

function onData(chunk) {
  const game = trackedGame();
  readRows(_csv, chunk, (fields) => {
    _consecutiveFastFails = 0; // we're getting real data → healthy
    _readerLog.rows();
    handleRow(fields, game);
  });
  _gameFrames.tick();
}

const _gameCsv = { buffer: '', cols: null };
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
  if (_stopped || _paused || process.platform !== 'win32') return;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  const exe = presentMonPath();
  _csv.cols = null;
  _csv.buffer = '';
  _byPid.clear(); // fresh PresentMon session → PIDs from the old one are meaningless
  const startedAt = Date.now();
  try {
    _proc = spawn(exe, ['-output_stdout', '-stop_existing_session', '-no_top', '-session_name', ETW_SESSION_NAME], { windowsHide: true });
  } catch (e) {
    _proc = null;
    _readerLog.ended(startedAt, e && e.message);
    scheduleRestart(startedAt);
    return;
  }
  // A process killed by pause can close after resume started its successor:
  // only the current one may feed the parser, clear _proc or schedule a restart.
  const proc = _proc;
  const ended = (why) => {
    if (_proc !== proc) return;
    _proc = null;
    _readerLog.ended(startedAt, why);
    scheduleRestart(startedAt);
  };
  proc.stdout.on('data', d => { if (_proc === proc) onData(d.toString('utf8')); });
  const stderr = createStderrTail();
  proc.stderr.on('data', (d) => stderr.add(d.toString('utf8')));
  proc.on('error', (e) => ended((e && e.code) || 'error'));
  proc.on('close', (code, signal) => ended(stderr.explain(signal || 'code ' + code)));
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
  _readerLog.reading(false);
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  if (_proc) { try { _proc.kill(); } catch { /* ignore */ } _proc = null; stopEtwSession(); }
  _gameFrames.stop();
  _byPid.clear(); // a future session's PIDs are unrelated to this one
}

function resumeFpsMonitor() {
  if (_stopped) return;
  _paused = false;
  _readerLog.reading(true);
  _consecutiveFastFails = 0;
  if (!_proc) start();
}

function stopFpsMonitor() {
  _stopped = true;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  if (_proc) { try { _proc.kill(); } catch { /* ignore */ } _proc = null; stopEtwSession(); }
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
