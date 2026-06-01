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
const IGNORE_PROCS = new Set(['dwm.exe', 'explorer.exe', 'presentmon.exe', 'searchhost.exe', 'shellexperiencehost.exe']);

let _proc = null;
let _cols = null;                // { frameTime, fps, app, pid }
let _consecutiveFastFails = 0;
let _stopped = false;
let _buffer = '';
const _byPid = new Map();        // pid -> { name, samples:number[], usesFps:bool, lastSeen:number }

function presentMonPath() {
  const candidates = [
    path.join(__dirname, 'presentmon', 'PresentMon.exe'),
    path.join(__dirname, 'PresentMon.exe'),
  ];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return 'PresentMon.exe'; // last resort: rely on PATH (spawn errors → fallback)
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
  if (frameTime < 0 && fps < 0) return null; // nothing usable
  return { frameTime, fps, app, pid };
}

function handleRow(fields) {
  if (!_cols) return;
  const pidRaw = _cols.pid >= 0 ? fields[_cols.pid] : '';
  const pid = String(pidRaw || '').trim() || (_cols.app >= 0 ? fields[_cols.app] : '?');
  const name = (_cols.app >= 0 ? String(fields[_cols.app] || '') : '').trim().toLowerCase();
  if (name && IGNORE_PROCS.has(name)) return;

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
  if (_stopped || process.platform !== 'win32') return;
  const exe = presentMonPath();
  _cols = null;
  _buffer = '';
  const startedAt = Date.now();
  try {
    _proc = spawn(exe, ['-output_stdout', '-stop_existing_session', '-no_top'], { windowsHide: true });
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
  if (_stopped) return;
  // If PresentMon dies almost immediately it usually means it's missing or we
  // lack admin rights — back off so we don't spin relaunching it.
  if (Date.now() - startedAt < 2500) _consecutiveFastFails++; else _consecutiveFastFails = 0;
  const delay = _consecutiveFastFails >= 3 ? FAIL_BACKOFF_MS : RESTART_DELAY_MS;
  setTimeout(start, delay);
}

function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// FPS of the busiest recently-presenting process (the active game), or null.
function getCurrentFps() {
  const now = Date.now();
  let best = null;
  for (const entry of _byPid.values()) {
    if (now - entry.lastSeen > SAMPLE_WINDOW_MS) continue;
    if (!entry.samples.length) continue;
    if (!best || entry.samples.length > best.samples.length) best = entry;
  }
  if (!best) return null;
  const m = median(best.samples);
  if (!Number.isFinite(m) || m <= 0) return null;
  const fps = best.usesFps ? m : 1000 / m;
  return Math.round(fps);
}

function startFpsMonitor() {
  if (_proc) return;
  start();
}

function stopFpsMonitor() {
  _stopped = true;
  if (_proc) { try { _proc.kill(); } catch { /* ignore */ } _proc = null; }
}

module.exports = { startFpsMonitor, stopFpsMonitor, getCurrentFps };
