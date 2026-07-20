'use strict';
// Per-app audio peak levels — the reader side of the helper's `audio-serve` mode.
//
// This is the first real audio LEVEL source in the product. SoundVolumeView (the
// /audio path) reports volume and mute but exports no meter column, so until the
// helper grew IAudioMeterInformation nothing here knew how loud anything was.
//
// Deliberately NOT on the /audio stream: that one polls SoundVolumeView every 8
// seconds and is change-gated on a JSON diff. Meters move continuously, so
// folding them in would defeat that dedupe and turn an 8s tick into a firehose.
// They ride their own SSE event instead, and only while someone is listening.
//
// There is no PowerShell fallback and there cannot be one: peak metering does not
// exist outside the native helper. Without the exe this module simply reports
// unavailable, and every consumer degrades to whatever it did before.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const HELPER_EXE = path.join(__dirname, 'helper', 'xenon-helper.exe');

const TICK_MS = 80;              // ~12/s: enough for a meter, cheap to broadcast
const RESTART_DELAY_MS = 1500;
const FAIL_BACKOFF_MS = 15000;
const FAST_FAIL_MS = 2500;
const MAX_FAST_FAILS = 3;        // then back off hard instead of respawning tightly
const STALE_MS = 1000;           // no tick for this long → treat levels as unknown

let _proc = null;
let _stopped = true;
let _buffer = '';
let _restartTimer = null;
let _fastFails = 0;
let _disabled = false;           // exe kept dying young — stop trying until restart
let _last = { at: 0, peaks: {} };
let _onTick = null;
let _sawOutput = false;          // did THIS child ever produce a line?

// The mode this module needs landed in helper 0.7.0. An older exe answers
// `audio-serve` with a usage error and exits at once, which the fast-fail path
// would quietly turn into "levels never arrive" — the switch on, nothing
// happening, and no way for the user to know why. Recorded so the dashboard can
// say it out loud instead.
const HELPER_MIN_VERSION = '0.7.0';
let _lastFailure = '';   // '' | 'no-helper' | 'helper-too-old' | 'helper-failed'

/** True when the native helper is present. Metering is impossible without it. */
function available() {
  if (process.platform !== 'win32') return false;
  try { return fs.existsSync(HELPER_EXE); } catch { return false; }
}

/**
 * Why levels are not flowing, for the UI to explain. Empty string means either
 * "running fine" or "never asked to run".
 */
function failure() {
  if (process.platform !== 'win32') return 'no-helper';
  if (!available()) return 'no-helper';
  return _lastFailure;
}

const minVersion = () => HELPER_MIN_VERSION;

/** Fires on every tick with the peak map; server.js broadcasts from here. */
function onTick(fn) {
  _onTick = typeof fn === 'function' ? fn : null;
}

function handleLine(line) {
  let data;
  try { data = JSON.parse(line); } catch { return; }
  if (!data || typeof data !== 'object') return;
  // Rebuild explicitly rather than trusting the shape off the wire, same as every
  // other boundary here. The helper is ours, but this is still parsed input.
  const peaks = {};
  const s = data.s;
  if (s && typeof s === 'object') {
    for (const [proc, v] of Object.entries(s)) {
      const n = Number(v);
      if (proc && Number.isFinite(n) && n > 0) peaks[String(proc).toLowerCase()] = Math.min(1, n);
    }
  }
  _last = { at: Date.now(), peaks };
  if (_onTick) { try { _onTick(peaks); } catch { /* a bad consumer must not kill the reader */ } }
}

function onData(chunk) {
  _buffer += chunk;
  // A runaway producer must not grow this without bound.
  if (_buffer.length > 64 * 1024) _buffer = '';
  let nl;
  while ((nl = _buffer.indexOf('\n')) >= 0) {
    const line = _buffer.slice(0, nl).replace(/\r$/, '').trim();
    _buffer = _buffer.slice(nl + 1);
    if (!line) continue;
    _fastFails = 0;              // receiving data → healthy
    _sawOutput = true;
    _lastFailure = '';
    handleLine(line);
  }
}

function start() {
  if (!_stopped && _proc) return;
  if (_disabled || !available()) return;
  _stopped = false;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  _buffer = '';
  _sawOutput = false;
  const startedAt = Date.now();
  try {
    // argv array, never a shell string.
    _proc = spawn(HELPER_EXE, ['audio-serve', String(TICK_MS)], { windowsHide: true });
  } catch {
    _proc = null;
    scheduleRestart(startedAt);
    return;
  }
  _proc.stdout.on('data', (d) => onData(d.toString('utf8')));
  _proc.stderr.on('data', () => { /* diagnostics only */ });
  _proc.on('error', () => { _proc = null; scheduleRestart(startedAt); });
  _proc.on('close', () => { _proc = null; scheduleRestart(startedAt); });
}

function scheduleRestart(startedAt) {
  if (_stopped) return;
  const diedYoung = Date.now() - startedAt < FAST_FAIL_MS;
  if (diedYoung) _fastFails++; else _fastFails = 0;
  // Died immediately having printed nothing at all: that is what an older helper
  // does with an argument it does not recognise. Distinguish it from a broken exe
  // so the dashboard can say "update the helper" rather than nothing.
  if (diedYoung && !_sawOutput) _lastFailure = 'helper-too-old';
  else if (diedYoung) _lastFailure = 'helper-failed';
  if (_fastFails >= MAX_FAST_FAILS) {
    // A helper that keeps dying young is broken (corrupt download, AV block) or
    // predates audio-serve. Give up rather than respawn a process forever.
    _disabled = true;
    _stopped = true;
    return;
  }
  if (_restartTimer) clearTimeout(_restartTimer);
  _restartTimer = setTimeout(start, _fastFails > 0 ? FAIL_BACKOFF_MS : RESTART_DELAY_MS);
}

/** Stop the host. MUST be called from _gracefulShutdown: no job object here, so
 *  process.exit would orphan the child. */
function stop() {
  _stopped = true;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  const p = _proc;
  _proc = null;
  _last = { at: 0, peaks: {} };
  if (!p) return;
  // Closing stdin is the host's documented exit signal; kill only if it lingers.
  try { p.stdin.end(); } catch { /* already gone */ }
  try { p.kill(); } catch { /* already gone */ }
}

/** Latest peaks, or an empty map when the last tick is too old to trust. */
function latest() {
  if (!_last.at || Date.now() - _last.at > STALE_MS) return {};
  return _last.peaks;
}

const isRunning = () => !!_proc;

module.exports = { available, start, stop, latest, onTick, isRunning, failure, minVersion, TICK_MS };
