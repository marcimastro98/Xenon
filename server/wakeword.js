'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Local "Hey Bit" wake word — zero extra dependencies, 100% offline.
//
// The same ffmpeg the STT recorder uses streams raw 16 kHz mono PCM from the
// default microphone; a Node-side energy VAD cuts out short utterances; each
// candidate is transcribed with the already-installed whisper.cpp and fuzzy-
// matched against "(hey) xenon". No audio ever leaves the PC and nothing is
// kept: candidate clips live only in memory (plus whisper's own temp file)
// and are dropped the moment they are checked.
//
// Lifecycle discipline matches winnotif.js: the capture child runs ONLY while
// the toggle is on AND a dashboard is open (server.js calls sync() from the
// SSE connect/close hooks and the settings save). It suspends itself while a
// voice-session recording owns the microphone (server.js calls suspend()/
// resumeSoon() around the STT recorder — required wherever two ffmpeg captures
// cannot share a microphone, which is the dshow fallback on Windows, avfoundation
// on macOS, and a raw alsa capture on Linux) and it self-gates on cost:
// whisper runs only on short speech bursts, so continuous talk or music never
// triggers a transcription loop.
// ─────────────────────────────────────────────────────────────────────────

const { spawn } = require('child_process');

const { SAMPLE_RATE, _wdbg, _wavFromPcm, _createSegmenter } = require('./ai/wakeword-segmenter.js');
const WAKE_COOLDOWN_MS = 8000;   // ignore everything right after a detection
// NOTE: there is deliberately NO time floor between whisper runs. `_transcribing`
// already makes transcription single-flight (one clip at a time), and MAX_SEGMENT_MS
// abandons anything longer than a wake phrase, so continuous talk/music never drives
// a transcription loop. An extra "min gap" floor was tried and removed: it could
// silently drop the real wake utterance when a background-noise segment had just
// consumed the budget — for a wake word, detection reliability beats a marginal CPU
// saving. Set XENON_WAKE_DEBUG=1 to log every transcription for tuning.
const RESTART_DELAY_MS = 5000;   // wait before relaunching after an exit
const FAIL_BACKOFF_MS = 60000;   // back off after repeated instant failures
const DEVICE_RETRY_MS = 5000;    // capture device not probed yet → retry
const RESUME_DELAY_MS = 8000;    // settle after the STT recorder releases the mic — long
                                 // enough to span a voice session's think/speak gaps, so
                                 // the listener doesn't flap between utterances
const SUSPEND_BACKSTOP_MS = 180000; // auto-resume if the STT stop call never arrives

// Wired once by server.js via init().
let _deps = {
  getFfmpegPath: () => null,   // → ffmpeg binary path
  getInputArgs: () => null,    // → ffmpeg mic input argv (null while device probe pending)
  transcribe: async () => '',  // wav Buffer → text (whisper.cpp)
  isBusy: () => false,         // an STT recording owns the mic right now
  onWake: () => {},            // wake phrase detected
};

let _proc = null;
let _segmenter = null;
let _wanted = false;
let _suspended = false;
let _stopped = false;
let _restartTimer = null;
let _resumeTimer = null;
let _consecutiveFastFails = 0;
let _transcribing = false;
let _lastWakeAt = 0;


function init(deps) {
  for (const key of Object.keys(_deps)) {
    if (deps && typeof deps[key] === 'function') _deps[key] = deps[key];
  }
}

const { matchesWakeWord } = require('./ai/wakeword-match.js');

async function _onSegment(pcm) {
  const durMs = Math.round(pcm.length / (SAMPLE_RATE * 2) * 1000);
  if (_stopped || !_wanted || _suspended) return;
  if (_transcribing) { _wdbg(`segment ${durMs}ms dropped: whisper busy`); return; }
  if (Date.now() - _lastWakeAt < WAKE_COOLDOWN_MS) { _wdbg(`segment ${durMs}ms dropped: post-wake cooldown`); return; }
  if (_deps.isBusy()) { _wdbg(`segment ${durMs}ms dropped: mic owned by voice session`); return; }
  _transcribing = true;
  try {
    const text = await _deps.transcribe(_wavFromPcm(pcm));
    const clean = String(text || '').trim();
    const hit = matchesWakeWord(clean);
    _wdbg(`heard ${durMs}ms -> "${clean.slice(0, 80)}"  match=${hit}`);
    if (hit) {
      _lastWakeAt = Date.now();
      process.stdout.write(`[WAKE] Detected ("${clean.slice(0, 60)}")\n`);
      try { _deps.onWake(); } catch { /* listener errors never kill the watch */ }
    }
  } catch (e) { _wdbg(`whisper error: ${(e && e.message) || e}`); }
  _transcribing = false;
}

function _start() {
  if (_stopped || _suspended || !_wanted || _proc) return;
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  const ffmpeg = _deps.getFfmpegPath();
  const inputArgs = _deps.getInputArgs();
  if (!ffmpeg || !inputArgs) {                      // device probe not done yet
    _restartTimer = setTimeout(_start, DEVICE_RETRY_MS);
    return;
  }
  const startedAt = Date.now();
  _segmenter = _createSegmenter(_onSegment);
  let child;
  try {
    child = spawn(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      ...inputArgs,
      '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', 'pipe:1',
    ], { windowsHide: true });
  } catch {
    _proc = null;
    _scheduleRestart(startedAt);
    return;
  }
  _proc = child;
  // Every handler checks identity against the child it was registered on: a
  // stop→start bounce (dashboard reload) leaves the old child's close event
  // queued, and without the check it would null out — and duplicate — the
  // replacement capture.
  child.stdout.on('data', chunk => {
    if (_proc !== child) return;                    // stale child after a bounce
    _consecutiveFastFails = 0;                      // receiving audio → healthy
    if (_segmenter) _segmenter.feed(chunk);
  });
  child.stderr.on('data', () => { /* device warnings; ignore */ });
  const onGone = () => {
    if (_proc === child) { _proc = null; _scheduleRestart(startedAt); }
  };
  child.on('error', onGone);
  child.on('close', onGone);
}

function _scheduleRestart(startedAt) {
  if (_stopped || _suspended || !_wanted) return;   // deliberate stop — not a crash
  if (Date.now() - startedAt < 2500) _consecutiveFastFails++; else _consecutiveFastFails = 0;
  const delay = _consecutiveFastFails >= 3 ? FAIL_BACKOFF_MS : RESTART_DELAY_MS;
  if (_restartTimer) clearTimeout(_restartTimer);
  _restartTimer = setTimeout(_start, delay);
}

// Stop the capture child. Returns a promise that resolves once the child has
// actually exited (bounded at 700 ms) so callers can wait for the microphone
// device to be truly released — dshow cannot open a device twice.
function _stopChild() {
  if (_restartTimer) { clearTimeout(_restartTimer); _restartTimer = null; }
  _segmenter = null;
  const p = _proc;
  if (!p) return Promise.resolve();
  _proc = null;                                     // detach first so 'close' won't restart
  if (p.exitCode !== null || p.signalCode) return Promise.resolve();
  try { p.kill(); } catch { return Promise.resolve(); }
  return new Promise(resolve => {
    const cap = setTimeout(resolve, 700);
    p.once('close', () => { clearTimeout(cap); resolve(); });
  });
}

// Reconcile with the desired state. server.js computes `want` as
// (toggle on && whisper installed && SSE clients > 0).
//
// There is deliberately no platform test here any more. This listener needs
// exactly one thing — an ffmpeg capture argv — and `getInputArgs()` is the
// single source of truth for whether the machine has one: WASAPI or dshow on
// Windows, avfoundation on macOS, pulse or alsa on Linux, and null where the
// probe found nothing. Asking the platform instead of the device is what kept
// this switched off on macOS long after the microphone worked there.
function sync(want) {
  _wanted = !!want;
  if (_wanted && !_suspended) _start();
  else _stopChild();
}

// The STT recorder is about to open the microphone: release it and return a
// promise that resolves when the device is actually free (immediately when no
// capture was running, so a disabled wake word adds zero latency). The
// backstop timer guards against a client that starts a recording and never
// stops it (crashed tab) — isBusy() still keeps detection correct if the mic
// is genuinely in use when it fires.
function suspend() {
  _suspended = true;
  const released = _stopChild();
  _armResume(SUSPEND_BACKSTOP_MS);
  return released;
}

// The capture device changed (mic rebind): restart the child so it re-reads
// the injected input args. No-op unless a capture is currently running.
function bounce() {
  if (!_proc) return;
  _stopChild().then(() => {
    if (_wanted && !_suspended && !_stopped) _start();
  });
}

// The STT recorder released the microphone: come back after a settle delay
// (also skips the tail of the assistant's own spoken reply).
function resumeSoon() {
  _armResume(RESUME_DELAY_MS);
}

function _armResume(delay) {
  if (_resumeTimer) clearTimeout(_resumeTimer);
  _resumeTimer = setTimeout(() => {
    _resumeTimer = null;
    _suspended = false;
    if (_wanted) _start();
  }, delay);
}

function isActive() { return !!_proc; }

function stop() {
  _stopped = true;
  _wanted = false;
  if (_resumeTimer) { clearTimeout(_resumeTimer); _resumeTimer = null; }
  _stopChild();
}

module.exports = {
  init, sync, suspend, resumeSoon, bounce, isActive, stop,
  // Test hooks: the pure pieces (matcher, VAD segmenter, WAV wrapper) are the
  // correctness core and are testable without a microphone or whisper.
  matchesWakeWord, _createSegmenter, _wavFromPcm,
};
