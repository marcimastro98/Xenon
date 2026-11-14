'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Game detection for the dashboard's "game mode" (auto-pause ambient effects).
//
// We drive game mode off the FOREGROUND FULL-SCREEN window, not off raw GPU
// frame rates. A long-lived foreground.ps1 loop reports, every couple of
// seconds, whether the focused window covers its whole monitor with no title
// bar — the shape of an exclusive/borderless full-screen game. This avoids the
// whack-a-mole of PresentMon frame-rate detection, which flagged any perpetual
// presenter (iCUE rendering the Xeneon Edge, the dashboard's own full-screen
// browser, GPU-accelerated apps like VS Code) as a "game".
//
// Process names that should never count as a game even when full-screen
// (the dashboard host browser, iCUE, etc.) are filtered out by name as a
// second guard. If the probe can't run (non-Windows, spawn failure) isGaming()
// simply stays false and the dashboard keeps its effects on.
// ─────────────────────────────────────────────────────────────────────────

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROBE_INTERVAL_MS = 2000;  // foreground.ps1 polling cadence
const STALE_MS = 6000;           // ignore probe data older than this
const GRACE_MS = 4000;           // stay "gaming" briefly across focus blips (Alt-Tab, alerts)
const RESTART_DELAY_MS = 5000;   // wait before relaunching after an exit
const FAIL_BACKOFF_MS = 60000;   // back off after repeated instant failures

const { IGNORE_PROC_RE, WINDOWED_IGNORE_RE } = require('./performance/game-ignore-lists.js');

const WINDOWED_MIN_FPS = 24;

const PROBE_SCRIPT = path.join(__dirname, 'foreground.ps1');
// Native helper (optional): same probe, same output lines, but also pushes an
// extra line the instant the foreground window changes — game mode reacts
// immediately. When the exe is missing or keeps dying, the PS probe is used.
const HELPER_PROBE_EXE = path.join(__dirname, 'helper',
  process.platform === 'win32' ? 'xenon-helper.exe' : 'xenon-helper');

let _proc = null;
let _stopped = false;
let _buffer = '';
let _restartTimer = null;
let _consecutiveFastFails = 0;
let _helperDisabled = false;     // helper exe died young repeatedly → pin the PS probe
let _linuxProbe = null;          // in-process foreground probe (Linux; see start())
let _lastSpawnWasHelper = false; // what the most recent start() actually launched
let _last = null;            // { fullscreen, process, pid, at }
let _lastGamingAt = 0;       // last moment we considered a game active (grace window)
let _gameHint = null;        // injected: () => { name, fps } | null (PresentMon's busiest presenter)

// Inject a frame-presentation hint provider (server.js wires PresentMon here).
// Optional: without it, detection is fullscreen-only as before.
function setGameHint(fn) {
  _gameHint = typeof fn === 'function' ? fn : null;
}

// Windowed/borderless game: the focused (non-fullscreen) window belongs to the
// same process PresentMon sees presenting flip-model frames at game-like rates.
// Focus + flip-model + rate together avoid the old false positives (browsers,
// the dashboard host, background video) that raw frame-rate detection had.
function _windowedGameActive(s) {
  if (!_gameHint || !s || s.fullscreen) return false;
  if (!s.process || isIgnoredProc(s.process) || WINDOWED_IGNORE_RE.test(s.process)) return false;
  let hint = null;
  try { hint = _gameHint(); } catch { return false; }
  if (!hint || !hint.name || !Number.isFinite(hint.fps) || hint.fps < WINDOWED_MIN_FPS) return false;
  const hintName = String(hint.name).toLowerCase().replace(/\.exe$/, '');
  return hintName !== '' && hintName === s.process.replace(/\.exe$/, '');
}

// The user's own "not a game" list (the gameIgnore setting, js/game-ignore.js
// shape). Read through a getter server.js injects, so every path that replaces
// the settings is covered without a push on each one; the Set is rebuilt only
// when the array itself changes.
let _ignoreSource = null;
let _ignoreRef = null;
let _userIgnore = new Set();

function bareName(name) {
  return String(name || '').trim().toLowerCase().replace(/\.exe$/, '');
}

function userIgnore() {
  let list = null;
  try { list = _ignoreSource ? _ignoreSource() : null; } catch { list = null; }
  if (list === _ignoreRef) return _userIgnore;
  _ignoreRef = list;
  _userIgnore = new Set((Array.isArray(list) ? list : []).map(bareName).filter(Boolean));
  // The game tracked right now was just ruled out: stop tracking it here, or
  // the PID check would hold "a game is running" (and game mode) until it closed.
  if (_gameProc && _userIgnore.has(_gameProc)) {
    _gamePid = 0; _gameProc = ''; _pidFirstDeadAt = 0; _lastGamingAt = 0;
  }
  return _userIgnore;
}

function isIgnoredProc(name) {
  if (!name) return false;
  return IGNORE_PROC_RE.test(name) || userIgnore().has(bareName(name));
}

function setIgnoreSource(fn) {
  _ignoreSource = typeof fn === 'function' ? fn : null;
  _ignoreRef = undefined;
}

// Fires right after the gaming state flips (entered/left a game). Wired by
// server.js to broadcast the status immediately: with the native probe pushing
// a line the instant the foreground changes, state flips no longer wait for
// the next 3s status tick in either direction.
let _onGamingChange = null;
let _notifiedGaming = false;

function onGamingChange(fn) {
  _onGamingChange = typeof fn === 'function' ? fn : null;
}

function handleLine(line) {
  let data;
  try { data = JSON.parse(line); } catch { return; }
  applySample(data);
}

// One probe reading, whatever produced it. Split out of handleLine because the
// Linux probe is an in-process module rather than a child emitting JSON lines —
// there is no script to spawn there, only three xprop reads — and both sources
// must land in exactly the same state and fire the same change notification.
function applySample(data) {
  if (!data || typeof data !== 'object') return;
  _last = {
    fullscreen: data.fullscreen === true,
    process: String(data.process || '').toLowerCase(),
    pid: Number(data.pid) || 0,
    at: Date.now(),
  };
  // Re-evaluate on every probe line so flips ride the instant push lines.
  // (Grace expiry without a flip-causing line is still caught here: the probe
  // emits at least every PROBE_INTERVAL_MS.)
  const gaming = isGaming();
  if (gaming !== _notifiedGaming) {
    _notifiedGaming = gaming;
    if (_onGamingChange) { try { _onGamingChange(gaming); } catch { } }
  }
}

function onData(chunk) {
  _buffer += chunk;
  let nl;
  while ((nl = _buffer.indexOf('\n')) >= 0) {
    const line = _buffer.slice(0, nl).replace(/\r$/, '').trim();
    _buffer = _buffer.slice(nl + 1);
    if (!line) continue;
    _consecutiveFastFails = 0; // receiving data → healthy
    handleLine(line);
  }
}

function start() {
  if (_stopped) return;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  _buffer = '';
  const startedAt = Date.now();
  let useHelper = false;
  if (!_helperDisabled) {
    try { useHelper = fs.existsSync(HELPER_PROBE_EXE); } catch { useHelper = false; }
  }
  // Linux has neither the PowerShell script nor a helper build, but it does have
  // the window manager's own properties: an in-process probe reads the focused
  // window through xprop (X11 and Xwayland alike) or the compositor's IPC on
  // wlroots. Without it every consumer of this module — game mode, Performance
  // Mode's activity, the Game Companion, screen time — is permanently inert on
  // Linux, which is what it was.
  if (!useHelper && process.platform === 'linux') {
    if (!_linuxProbe) {
      const { createLinuxForeground } = require('./linux-foreground');
      _linuxProbe = createLinuxForeground({ intervalMs: PROBE_INTERVAL_MS, onSample: applySample });
    }
    _linuxProbe.start();
    return;
  }
  // The PowerShell fallback only exists on Windows. Elsewhere the helper is the
  // only probe there is, so no helper means no game mode — and starting a
  // doomed powershell.exe every few seconds would be worse than not having it.
  if (!useHelper && process.platform !== 'win32') return;
  _lastSpawnWasHelper = useHelper;
  try {
    _proc = useHelper
      ? spawn(HELPER_PROBE_EXE, ['foreground-serve', String(PROBE_INTERVAL_MS)], { windowsHide: true })
      : spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', PROBE_SCRIPT, '-IntervalMs', String(PROBE_INTERVAL_MS),
        ], { windowsHide: true });
  } catch {
    _proc = null;
    scheduleRestart(startedAt);
    return;
  }
  _proc.stdout.on('data', d => onData(d.toString('utf8')));
  _proc.stderr.on('data', () => { /* probe warnings; ignore */ });
  _proc.on('error', () => { _proc = null; scheduleRestart(startedAt); });
  _proc.on('close', () => { _proc = null; scheduleRestart(startedAt); });
}

function scheduleRestart(startedAt) {
  if (_stopped) return;
  if (Date.now() - startedAt < 2500) _consecutiveFastFails++; else _consecutiveFastFails = 0;
  // A helper exe that keeps dying young is likely broken (corrupt download,
  // AV block): pin the PS probe instead of backing off forever on the exe.
  if (_consecutiveFastFails >= 3 && _lastSpawnWasHelper && !_helperDisabled) {
    _helperDisabled = true;
    _consecutiveFastFails = 0;
  }
  const delay = _consecutiveFastFails >= 3 ? FAIL_BACKOFF_MS : RESTART_DELAY_MS;
  if (_restartTimer) clearTimeout(_restartTimer);
  _restartTimer = setTimeout(start, delay);
}

// The bare name + PID of the game we last saw in the foreground. Kept even after
// it loses focus (the user tapping the dashboard, or the game minimising) so the
// Game Companion can tell "still running, just not focused" from "closed".
let _gameProc = '';
let _gamePid = 0;
let _gameSeenAt = 0;            // last time the game was CONFIRMED alive (foreground or PID-alive)
let _pidFirstDeadAt = 0;        // first liveness probe that reported the PID gone (0 = alive)
const PID_DEAD_CONFIRM_MS = 2500; // a second negative this much later confirms the game exited

// True while a real game owns the FOREGROUND window — full-screen, or windowed when
// the PresentMon hint confirms it is the active presenter. A short grace window
// keeps it stable across brief focus changes so game mode doesn't blink. Drives
// game-mode/performance (which should follow focus — effects resume when you tab
// out). The Companion pill uses isGameRunning() instead.
function isGaming() {
  const s = _last;
  if (s && (Date.now() - s.at) < STALE_MS && !isIgnoredProc(s.process)
      && (s.fullscreen || _windowedGameActive(s))) {
    _lastGamingAt = Date.now();
    _gameSeenAt = _lastGamingAt;
    _gameProc = String(s.process || '').toLowerCase().replace(/\.exe$/, '');  // remember the real game
    _gamePid = Number(s.pid) || 0;
    _pidFirstDeadAt = 0;
    return true;
  }
  if (_lastGamingAt > 0 && (Date.now() - _lastGamingAt) < GRACE_MS) {
    // The grace window exists to ride out focus blips while the game is still
    // alive (Alt-Tab, notification popups). If the remembered game process is
    // gone, the user actually closed it — drop game mode right away instead of
    // sitting out the rest of the grace.
    if (_gamePid && !_pidAlive(_gamePid)) { _lastGamingAt = 0; return false; }
    return true;
  }
  return false;
}

// PID liveness probe: signal 0 doesn't signal, it only checks existence.
// EPERM means the process exists but is elevated → alive.
function _pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

// True while the game is still RUNNING — foreground OR backgrounded/minimised —
// verified by probing the remembered PID for liveness (signal 0). This is what the
// Game Companion pill follows: it stays available the whole time the game is alive
// (so tapping the touchscreen doesn't drop it) and disappears the moment the game
// exits — no arbitrary linger, and never pinned to a bystander like iCUE.
function isGameRunning() {
  if (isGaming()) { _gameSeenAt = Date.now(); return true; }   // foreground / grace
  if (!_gamePid) return false;
  if (_pidAlive(_gamePid)) { _pidFirstDeadAt = 0; _gameSeenAt = Date.now(); return true; }
  // The PID probe reported the game as gone (ESRCH). Don't end the session on a
  // single negative — it can be a transient quirk — but a second negative a
  // beat later confirms the exit for real. (Replaces the old flat 15s linger:
  // same protection, and the Companion pill / auto-restore react in ~3s.)
  const now = Date.now();
  if (!_pidFirstDeadAt) { _pidFirstDeadAt = now; return true; }
  if (now - _pidFirstDeadAt < PID_DEAD_CONFIRM_MS) return true;
  _gamePid = 0; _gameProc = ''; _pidFirstDeadAt = 0;
  return false;
}

// Diagnostic snapshot of the game-tracking state (for /api/gamemode/status).
function getGameDiag() {
  return { gamePid: _gamePid, gameProc: _gameProc, lastGamingAt: _lastGamingAt, gameSeenAt: _gameSeenAt };
}

// The running game's process name (foreground or background), or '' once it exits.
// Unlike getForegroundProcess() this never reports whatever briefly stole the
// foreground, so the Companion pill always reads the game. Reflects the last
// isGameRunning()/isGaming() call.
function getGameProcess() {
  return _gameProc;
}

// Foreground-process classification for Performance Mode. Deterministic and
// cheap (no extra probing — reuses the foreground window the game detector
// already tracks). Used to label suggestions and, later, to seed the AI's
// activity-based optimization plan. 'gaming' wins via the full-screen detector.
const CODING_RE = /^(code|code-insiders|cursor|devenv|idea64|pycharm64|webstorm64|rider64|clion64|goland64|rubymine64|phpstorm64|datagrip64|rustrover64|studio64|sublime_text|atom|nvim|vim)$/i;
const WRITING_RE = /^(winword|notepad|notepad\+\+|obsidian|onenote|wps|wpsoffice|soffice|swriter|typora|scrivener|joplin)$/i;

function classifyActivity(name) {
  const n = String(name || '').toLowerCase().replace(/\.exe$/, '');
  if (!n) return 'other';
  if (CODING_RE.test(n)) return 'coding';
  if (WRITING_RE.test(n)) return 'writing';
  return 'other';
}

// Current foreground activity: 'gaming' | 'coding' | 'writing' | 'other'.
function getActivity() {
  if (isGaming()) return 'gaming';
  const s = _last;
  if (s && (Date.now() - s.at) < STALE_MS) return classifyActivity(s.process);
  return 'other';
}

// Bare foreground process name (lowercase, no extension) for client-side custom
// activity classification, or '' when stale/unknown.
function getForegroundProcess() {
  const s = _last;
  if (s && (Date.now() - s.at) < STALE_MS) return String(s.process || '').toLowerCase().replace(/\.exe$/, '');
  return '';
}

// The PID of the window in front, or 0 when nothing recent is known. Read by
// fpsmon.js to choose WHICH presenting process to report the frame rate of:
// PresentMon captures them all, and "the busiest" picks a launcher or a second
// game as readily as the one being played.
function getForegroundPid() {
  const s = _last;
  if (s && (Date.now() - s.at) < STALE_MS) return Number(s.pid) || 0;
  return 0;
}

// Diagnostic: the foreground window state currently driving detection, or null.
function getGamingWindow() {
  const s = _last;
  if (!s || (Date.now() - s.at) >= STALE_MS) return null;
  return { process: s.process || '?', fullscreen: s.fullscreen, ignored: isIgnoredProc(s.process) };
}

function startGameDetect() {
  if (_proc || _linuxProbe) return;
  start();
}

function stopGameDetect() {
  _stopped = true;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  if (_proc) { try { _proc.kill(); } catch { /* ignore */ } _proc = null; }
  if (_linuxProbe) { try { _linuxProbe.stop(); } catch { /* ignore */ } _linuxProbe = null; }
}

module.exports = { startGameDetect, stopGameDetect, isGaming, isGameRunning, getActivity, getForegroundProcess, getForegroundPid, getGameProcess, getGameDiag, classifyActivity, getGamingWindow, setGameHint, onGamingChange, isIgnoredProc, setIgnoreSource };
