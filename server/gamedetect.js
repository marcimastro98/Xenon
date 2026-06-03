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
const path = require('path');

const PROBE_INTERVAL_MS = 2000;  // foreground.ps1 polling cadence
const STALE_MS = 6000;           // ignore probe data older than this
const GRACE_MS = 4000;           // stay "gaming" briefly across focus blips (Alt-Tab, alerts)
const RESTART_DELAY_MS = 5000;   // wait before relaunching after an exit
const FAIL_BACKOFF_MS = 60000;   // back off after repeated instant failures

// Foreground apps that are full-screen yet are never a game: the dashboard's
// own host browser/WebView, iCUE/Corsair, and the Windows shell. Matched
// against the bare process name (no ".exe") reported by the probe.
const IGNORE_PROC_RE = /msedge|chrome|firefox|brave|opera|vivaldi|webview|iexplore|icue|corsair|explorer|searchhost|shellexperiencehost/i;

const PROBE_SCRIPT = path.join(__dirname, 'foreground.ps1');

let _proc = null;
let _stopped = false;
let _buffer = '';
let _restartTimer = null;
let _consecutiveFastFails = 0;
let _last = null;            // { fullscreen, process, pid, at }
let _lastGamingAt = 0;       // last moment we considered a game active (grace window)

function isIgnoredProc(name) {
  if (!name) return false;
  return IGNORE_PROC_RE.test(name);
}

function handleLine(line) {
  let data;
  try { data = JSON.parse(line); } catch { return; }
  if (!data || typeof data !== 'object') return;
  _last = {
    fullscreen: data.fullscreen === true,
    process: String(data.process || '').toLowerCase(),
    pid: Number(data.pid) || 0,
    at: Date.now(),
  };
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
  if (_stopped || process.platform !== 'win32') return;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  _buffer = '';
  const startedAt = Date.now();
  try {
    _proc = spawn('powershell.exe', [
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
  const delay = _consecutiveFastFails >= 3 ? FAIL_BACKOFF_MS : RESTART_DELAY_MS;
  if (_restartTimer) clearTimeout(_restartTimer);
  _restartTimer = setTimeout(start, delay);
}

// True while a real full-screen game owns the foreground window. A short grace
// window keeps it stable across brief focus changes so game mode doesn't blink.
function isGaming() {
  const s = _last;
  if (s && (Date.now() - s.at) < STALE_MS && s.fullscreen && !isIgnoredProc(s.process)) {
    _lastGamingAt = Date.now();
    return true;
  }
  return _lastGamingAt > 0 && (Date.now() - _lastGamingAt) < GRACE_MS;
}

// Diagnostic: the foreground window state currently driving detection, or null.
function getGamingWindow() {
  const s = _last;
  if (!s || (Date.now() - s.at) >= STALE_MS) return null;
  return { process: s.process || '?', fullscreen: s.fullscreen, ignored: isIgnoredProc(s.process) };
}

function startGameDetect() {
  if (_proc) return;
  start();
}

function stopGameDetect() {
  _stopped = true;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  if (_proc) { try { _proc.kill(); } catch { /* ignore */ } _proc = null; }
}

module.exports = { startGameDetect, stopGameDetect, isGaming, getGamingWindow };
