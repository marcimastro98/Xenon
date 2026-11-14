// Records the microphone as raw sound for a live voice session.

const { spawn } = require('node:child_process');
const aiLive = require('../ai-live.js');
const { getFfmpegPath } = require('../ffmpeg-install/ffmpeg-path.js');
const { _sttGain } = require('./mic-gain.js');
const { _sttInputArgs } = require('./stt-input.js');

// ── Voce Live (Gemini Live realtime) — server pieces ─────────────────────────
// Continuous mic → 16 kHz mono PCM frames, built on the SAME device selection
// (WASAPI/dshow), gain and ffmpeg the one-shot STT recorder uses — but piping
// raw PCM to stdout so it streams to Gemini in ~100 ms frames with no WAV
// round-trip. Returns a stop handle.
function _startLivePcmCapture(onPcm, onError) {
  const inputArgs = _sttInputArgs();
  if (!inputArgs) throw new Error('No audio device available for the live session');
  const ffmpeg = getFfmpegPath();
  const gain = _sttGain();
  const proc = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    ...inputArgs,
    '-af', `volume=${gain}`,
    '-ar', String(aiLive.INPUT_SAMPLE_RATE), '-ac', '1', '-f', 's16le', 'pipe:1',
  ], { windowsHide: true });
  let carry = Buffer.alloc(0);
  proc.stdout.on('data', (buf) => {
    // chunkPcm keeps a trailing partial frame as its last element; carry it to
    // the next tick so no audio is dropped at buffer boundaries.
    const frames = aiLive.chunkPcm(carry.length ? Buffer.concat([carry, buf]) : buf, aiLive.INPUT_CHUNK_BYTES);
    carry = Buffer.alloc(0);
    for (const f of frames) {
      if (f.length === aiLive.INPUT_CHUNK_BYTES) { try { onPcm(f); } catch (e) { /* ignore */ } }
      else carry = f;
    }
  });
  proc.stderr.on('data', () => {}); // drain
  proc.on('error', (e) => { try { onError && onError(e); } catch (_) { /* ignore */ } });
  proc.on('exit', () => { try { onError && onError(new Error('capture ended')); } catch (_) { /* ignore */ } });
  return { stop() { try { proc.stdin.end(); } catch {} try { proc.kill(); } catch {} } };
}

module.exports = { _startLivePcmCapture };
