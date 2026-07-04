'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Local "Hey Xenon" wake word — zero extra dependencies, 100% offline.
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
// resumeSoon() around the STT recorder — required for the dshow fallback,
// where two ffmpeg captures cannot share a device) and it self-gates on cost:
// whisper runs only on short speech bursts, so continuous talk or music never
// triggers a transcription loop.
// ─────────────────────────────────────────────────────────────────────────

const { spawn } = require('child_process');

const SAMPLE_RATE = 16000;
const FRAME_MS = 30;
const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS / 1000) * 2; // s16le mono
const PREROLL_FRAMES = 12;       // ~360 ms kept from before speech onset
const TRIGGER_FRAMES = 2;        // consecutive loud frames that open a segment
const END_SILENCE_FRAMES = 14;   // ~420 ms of quiet closes a segment
const MIN_LOUD_MS = 240;         // minimum voiced audio for a candidate
const MAX_SEGMENT_MS = 3000;     // longer than any wake phrase → not a wake, skip
const NOISE_FLOOR_MIN = 110;     // RMS floor so a dead-quiet room can't zero the gate
const THRESH_MULT = 3;           // speech gate = noise floor × this
const WAKE_COOLDOWN_MS = 8000;   // ignore everything right after a detection
const TRANSCRIBE_MIN_GAP_MS = 1500; // floor between whisper runs, so a stream of
                                 // conversational bursts (TV, a call on speakers)
                                 // can't drive near-continuous transcription CPU
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
let _lastTranscribeAt = 0;

function init(deps) {
  for (const key of Object.keys(_deps)) {
    if (deps && typeof deps[key] === 'function') _deps[key] = deps[key];
  }
}

function _pcmRms(frame) {
  const n = frame.length - (frame.length % 2);
  if (n < 2) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 2) sum += frame.readInt16LE(i) ** 2;
  return Math.sqrt(sum / (n / 2));
}

// Wrap raw s16le mono PCM in a minimal RIFF/WAVE header for whisper.
function _wavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);            // PCM chunk size
  header.writeUInt16LE(1, 20);             // format = PCM
  header.writeUInt16LE(1, 22);             // channels
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);             // block align
  header.writeUInt16LE(16, 34);            // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// Energy VAD segmenter over the raw PCM stream. Emits one Buffer per short
// speech burst (with pre-roll so the first syllable isn't clipped); anything
// longer than a wake phrase is abandoned and waited out, so sustained speech
// or music costs zero whisper runs.
function _createSegmenter(onSegment) {
  let residual = Buffer.alloc(0);
  let preroll = [];
  let seg = null;              // collected frames after trigger
  let loudRun = 0;             // consecutive loud frames while idle
  let loudCount = 0;           // loud frames inside the open segment
  let quietRun = 0;            // trailing quiet frames
  let skipping = false;        // too-long utterance → wait for silence
  let noise = 200;             // adaptive noise-floor RMS (EMA of quiet frames)

  function processFrame(frame) {
    const rms = _pcmRms(frame);
    const loud = rms > Math.max(NOISE_FLOOR_MIN, noise) * THRESH_MULT;
    if (!loud) noise = noise * 0.95 + rms * 0.05;

    if (skipping) {
      quietRun = loud ? 0 : quietRun + 1;
      if (quietRun >= END_SILENCE_FRAMES) { skipping = false; quietRun = 0; }
      return;
    }
    if (!seg) {
      preroll.push(frame);
      if (preroll.length > PREROLL_FRAMES) preroll.shift();
      loudRun = loud ? loudRun + 1 : 0;
      if (loudRun >= TRIGGER_FRAMES) {
        seg = preroll.slice();
        preroll = [];
        loudCount = loudRun;
        quietRun = 0;
      }
      return;
    }
    seg.push(frame);
    if (loud) { loudCount++; quietRun = 0; } else { quietRun++; }
    if (seg.length * FRAME_MS > MAX_SEGMENT_MS) {
      seg = null; loudRun = 0; skipping = true;
      return;
    }
    if (quietRun >= END_SILENCE_FRAMES) {
      const buf = Buffer.concat(seg);
      const voicedMs = loudCount * FRAME_MS;
      seg = null; loudRun = 0; quietRun = 0;
      if (voicedMs >= MIN_LOUD_MS) onSegment(buf);
    }
  }

  return {
    feed(chunk) {
      residual = residual.length ? Buffer.concat([residual, chunk]) : chunk;
      while (residual.length >= FRAME_BYTES) {
        processFrame(residual.subarray(0, FRAME_BYTES));
        residual = residual.subarray(FRAME_BYTES);
      }
    },
  };
}

// Does a transcript contain the wake phrase? Deliberately fuzzy: whisper
// renders an accented "hey xenon" as "ehi zenon", "hei senon", "zenone", …
// The leading "hey" is optional — the product name alone is distinctive
// enough, and requiring it would miss more wakes than it saves.
function matchesWakeWord(text) {
  if (typeof text !== 'string' || !text) return false;
  const plain = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const tokens = plain.split(/[^a-z]+/);
  // xenon / zenon / senon / zenone / xeneon … — one vowel-tolerant expression.
  return tokens.some(tok => /^[sxz]e+n+[eoa]+n+[eo]?$/.test(tok));
}

async function _onSegment(pcm) {
  if (_stopped || !_wanted || _suspended) return;
  if (_transcribing) return;                        // one whisper run at a time
  if (Date.now() - _lastTranscribeAt < TRANSCRIBE_MIN_GAP_MS) return; // duty-cycle floor
  if (Date.now() - _lastWakeAt < WAKE_COOLDOWN_MS) return;
  if (_deps.isBusy()) return;                       // mic owned by a voice session
  _transcribing = true;
  _lastTranscribeAt = Date.now();
  try {
    const text = await _deps.transcribe(_wavFromPcm(pcm));
    if (matchesWakeWord(text)) {
      _lastWakeAt = Date.now();
      process.stdout.write(`[WAKE] Detected ("${String(text).trim().slice(0, 60)}")\n`);
      try { _deps.onWake(); } catch { /* listener errors never kill the watch */ }
    }
  } catch { /* whisper hiccup → just wait for the next utterance */ }
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
function sync(want) {
  _wanted = !!want && process.platform === 'win32';
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
