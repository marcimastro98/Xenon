'use strict';
// Cuts the microphone's sound into stretches of speech for the wake word: how loud counts as
// speech, when a stretch ends, and the stretch as a WAV file.

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

// Opt-in diagnostics: XENON_WAKE_DEBUG=1 prints what the VAD and whisper actually
// produce, so a "doesn't activate" report can be pinned to VAD (no segment reaches
// whisper) vs. matcher (whisper transcribes but the fuzzy match misses). Off by
// default → zero cost and nothing printed in normal use.
const _wdbgOn = !!process.env.XENON_WAKE_DEBUG;
function _wdbg(msg) { if (_wdbgOn) process.stdout.write(`[WAKE?] ${msg}\n`); }

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
  let dbgFrames = 0, dbgPeak = 0; // debug-only: peak RMS over a ~2 s window

  function processFrame(frame) {
    const rms = _pcmRms(frame);
    const gate = Math.max(NOISE_FLOOR_MIN, noise) * THRESH_MULT;
    const loud = rms > gate;
    if (!loud) noise = noise * 0.95 + rms * 0.05;
    if (_wdbgOn) {
      if (rms > dbgPeak) dbgPeak = rms;
      if (++dbgFrames >= 66) { // ~2 s
        _wdbg(`level: peak RMS ${Math.round(dbgPeak)}, noise ${Math.round(noise)}, gate ${Math.round(gate)} (peak must exceed gate to trigger)`);
        dbgFrames = 0; dbgPeak = 0;
      }
    }

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

module.exports = {
  SAMPLE_RATE, FRAME_MS, FRAME_BYTES, PREROLL_FRAMES, TRIGGER_FRAMES, END_SILENCE_FRAMES,
  MIN_LOUD_MS, MAX_SEGMENT_MS, NOISE_FLOOR_MIN, THRESH_MULT, _wdbgOn, _wdbg, _pcmRms, _wavFromPcm,
  _createSegmenter,
};
