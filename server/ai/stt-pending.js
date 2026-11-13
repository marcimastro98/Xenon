// The voice recordings under way, who waits for the microphone to be found, and the sweep that
// ends a recording left open too long.

const fs = require('node:fs');
const wakeWord = require('../wakeword.js');
const { STT_MAX_AGE_MS } = require('./stt-gate.js');

const _sttDeviceWaiters = [];
const _sttPending = new Map(); // id → { ffmpegProc, wavPath, recordingStarted, resolveRecording, recordingSaved, resolveSaved }

function _sweepStaleStt() {
  if (_sttPending.size === 0) return;
  const now = Date.now();
  for (const [id, rec] of _sttPending) {
    if (now - (rec.startedAt || 0) < STT_MAX_AGE_MS) continue;
    _sttPending.delete(id);
    try { rec.ffmpegProc.kill(); } catch { /* already gone */ }
    if (rec.wavPath) fs.promises.unlink(rec.wavPath).catch(() => {});
    process.stdout.write(`[STT] Reaped stale recording id=${id}\n`);
  }
  if (_sttPending.size === 0) wakeWord.resumeSoon();
}

module.exports = { _sttDeviceWaiters, _sttPending, _sweepStaleStt };
