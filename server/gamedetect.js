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
const RESTART_DELAY_MS = 5000;   // wait before relaunching after an exit
const FAIL_BACKOFF_MS = 60000;   // back off after repeated instant failures

const PROBE_SCRIPT = path.join(__dirname, 'foreground.ps1');
// Native helper (optional): same probe, same output lines, but also pushes an
// extra line the instant the foreground window changes — game mode reacts
// immediately. When the exe is missing or keeps dying, the PS probe is used.
const HELPER_PROBE_EXE = path.join(__dirname, 'helper',
  process.platform === 'win32' ? 'xenon-helper.exe' : 'xenon-helper');

const { gameWatch } = require('./performance/game-watch-state.js');

const { STALE_MS, isIgnoredProc, isGaming, isGameRunning } = require('./performance/game-judge.js');

// Inject a frame-presentation hint provider (server.js wires PresentMon here).
// Optional: without it, detection is fullscreen-only as before.
function setGameHint(fn) {
  gameWatch.hint = typeof fn === 'function' ? fn : null;
}

function setIgnoreSource(fn) {
  gameWatch.ignoreSource = typeof fn === 'function' ? fn : null;
  gameWatch.ignoreRef = undefined;
}


function onGamingChange(fn) {
  gameWatch.onChange = typeof fn === 'function' ? fn : null;
}

const { applySample, onData } = require('./performance/game-readings.js');

function start() {
  if (gameWatch.stopped) return;
  if (gameWatch.restartTimer) { clearTimeout(gameWatch.restartTimer); gameWatch.restartTimer = null; }
  gameWatch.buffer = '';
  const startedAt = Date.now();
  let useHelper = false;
  if (!gameWatch.helperDisabled) {
    try { useHelper = fs.existsSync(HELPER_PROBE_EXE); } catch { useHelper = false; }
  }
  // Linux has neither the PowerShell script nor a helper build, but it does have
  // the window manager's own properties: an in-process probe reads the focused
  // window through xprop (X11 and Xwayland alike) or the compositor's IPC on
  // wlroots. Without it every consumer of this module — game mode, Performance
  // Mode's activity, the Game Companion, screen time — is permanently inert on
  // Linux, which is what it was.
  if (!useHelper && process.platform === 'linux') {
    if (!gameWatch.linuxProbe) {
      const { createLinuxForeground } = require('./linux-foreground');
      gameWatch.linuxProbe = createLinuxForeground({ intervalMs: PROBE_INTERVAL_MS, onSample: applySample });
    }
    gameWatch.linuxProbe.start();
    return;
  }
  // The PowerShell fallback only exists on Windows. Elsewhere the helper is the
  // only probe there is, so no helper means no game mode — and starting a
  // doomed powershell.exe every few seconds would be worse than not having it.
  if (!useHelper && process.platform !== 'win32') return;
  gameWatch.lastSpawnWasHelper = useHelper;
  try {
    gameWatch.proc = useHelper
      ? spawn(HELPER_PROBE_EXE, ['foreground-serve', String(PROBE_INTERVAL_MS)], { windowsHide: true })
      : spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', PROBE_SCRIPT, '-IntervalMs', String(PROBE_INTERVAL_MS),
        ], { windowsHide: true });
  } catch {
    gameWatch.proc = null;
    scheduleRestart(startedAt);
    return;
  }
  gameWatch.proc.stdout.on('data', d => onData(d.toString('utf8')));
  gameWatch.proc.stderr.on('data', () => { /* probe warnings; ignore */ });
  gameWatch.proc.on('error', () => { gameWatch.proc = null; scheduleRestart(startedAt); });
  gameWatch.proc.on('close', () => { gameWatch.proc = null; scheduleRestart(startedAt); });
}

function scheduleRestart(startedAt) {
  if (gameWatch.stopped) return;
  if (Date.now() - startedAt < 2500) gameWatch.fastFails++; else gameWatch.fastFails = 0;
  // A helper exe that keeps dying young is likely broken (corrupt download,
  // AV block): pin the PS probe instead of backing off forever on the exe.
  if (gameWatch.fastFails >= 3 && gameWatch.lastSpawnWasHelper && !gameWatch.helperDisabled) {
    gameWatch.helperDisabled = true;
    gameWatch.fastFails = 0;
  }
  const delay = gameWatch.fastFails >= 3 ? FAIL_BACKOFF_MS : RESTART_DELAY_MS;
  if (gameWatch.restartTimer) clearTimeout(gameWatch.restartTimer);
  gameWatch.restartTimer = setTimeout(start, delay);
}

// Diagnostic snapshot of the game-tracking state (for /api/gamemode/status).
function getGameDiag() {
  return { gamePid: gameWatch.gamePid, gameProc: gameWatch.gameProc, lastGamingAt: gameWatch.lastGamingAt, gameSeenAt: gameWatch.gameSeenAt };
}

// The running game's process name (foreground or background), or '' once it exits.
// Unlike getForegroundProcess() this never reports whatever briefly stole the
// foreground, so the Companion pill always reads the game. Reflects the last
// isGameRunning()/isGaming() call.
function getGameProcess() {
  return gameWatch.gameProc;
}

const { classifyActivity } = require('./performance/game-activity.js');

// Current foreground activity: 'gaming' | 'coding' | 'writing' | 'other'.
function getActivity() {
  if (isGaming()) return 'gaming';
  const s = gameWatch.last;
  if (s && (Date.now() - s.at) < STALE_MS) return classifyActivity(s.process);
  return 'other';
}

// Bare foreground process name (lowercase, no extension) for client-side custom
// activity classification, or '' when stale/unknown.
function getForegroundProcess() {
  const s = gameWatch.last;
  if (s && (Date.now() - s.at) < STALE_MS) return String(s.process || '').toLowerCase().replace(/\.exe$/, '');
  return '';
}

// The PID of the window in front, or 0 when nothing recent is known. Read by
// fpsmon.js to choose WHICH presenting process to report the frame rate of:
// PresentMon captures them all, and "the busiest" picks a launcher or a second
// game as readily as the one being played.
function getForegroundPid() {
  const s = gameWatch.last;
  if (s && (Date.now() - s.at) < STALE_MS) return Number(s.pid) || 0;
  return 0;
}

// Diagnostic: the foreground window state currently driving detection, or null.
function getGamingWindow() {
  const s = gameWatch.last;
  if (!s || (Date.now() - s.at) >= STALE_MS) return null;
  return { process: s.process || '?', fullscreen: s.fullscreen, ignored: isIgnoredProc(s.process) };
}

function startGameDetect() {
  if (gameWatch.proc || gameWatch.linuxProbe) return;
  start();
}

function stopGameDetect() {
  gameWatch.stopped = true;
  if (gameWatch.restartTimer) { clearTimeout(gameWatch.restartTimer); gameWatch.restartTimer = null; }
  if (gameWatch.proc) { try { gameWatch.proc.kill(); } catch { /* ignore */ } gameWatch.proc = null; }
  if (gameWatch.linuxProbe) { try { gameWatch.linuxProbe.stop(); } catch { /* ignore */ } gameWatch.linuxProbe = null; }
}

module.exports = { startGameDetect, stopGameDetect, isGaming, isGameRunning, getActivity, getForegroundProcess, getForegroundPid, getGameProcess, getGameDiag, classifyActivity, getGamingWindow, applySample, setGameHint, onGamingChange, isIgnoredProc, setIgnoreSource };
