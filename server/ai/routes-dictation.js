// What starting to listen to the microphone does: it picks the device and starts the recording
// the answer is read from.

const { readBody } = require('../http/read-body.js');
const { liveVoice } = require('./live-voice-state.js');
const { _sttPending } = require('./stt-pending.js');
const { privateTmpFile } = require('../private-tmp.js');
const wakeWord = require('../wakeword.js');
const {
  _sttSilenceDb, STT_AFTER_SPEECH_SILENCE_GRACE_MS, STT_START_SILENCE_GRACE_MS,
} = require('./stt-gate.js');
const { _sttGain } = require('./mic-gain.js');
const { spawn } = require('node:child_process');
const { broadcastSSE } = require('../http/sse-clients.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /api/stt/start': async (req, res, _context, { _sttDeviceWhenReady, _sttInputArgs, _sttVia, getFfmpegPath }) => {
    try {
      await readBody(req);
      await Promise.race([
        _sttDeviceWhenReady(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('STT device timeout')), 10000)),
      ]);
      if (!_sttInputArgs()) throw new Error('No audio device available for recording');
      // A full-duplex Voce Live session already owns the mic (dshow can't share
      // the device) — refuse a one-shot recorder so it can't starve the live
      // capture's ffmpeg and tear the session down under the user.
      if (liveVoice.active) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'live_active' })); return;
      }
      // Prevent two concurrent STT sessions (e.g. two browser tabs receiving the same wake event)
      if (_sttPending.size > 0) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'already_recording' })); return;
      }
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const wavPath = privateTmpFile('xenon-stt-', '.wav');

      let resolveRecording, resolveSaved;
      const recordingStarted = new Promise(r => { resolveRecording = r; });
      const recordingSaved   = new Promise(r => { resolveSaved   = r; });

      // Release the wake-word listener before opening the mic (dshow cannot
      // share a device). Resolves when its capture child has actually exited —
      // immediately when the feature is off, so this adds no latency then.
      await wakeWord.suspend();
      const ffmpeg = getFfmpegPath();
      const inputArgs = _sttInputArgs();
      const silenceDb = _sttSilenceDb();
      const gain = _sttGain();
      // silencedetect runs on the RAW signal (so end-of-speech is judged before
      // the boost lifts the noise floor); volume then boosts the saved WAV so
      // the transcription clip is audible for a quiet hands-free mic.
      const ffmpegProc = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'info',
        ...inputArgs,
        '-af', `silencedetect=noise=${silenceDb.toFixed(1)}dB:d=0.55,volume=${gain}`,
        '-ar', '16000', '-ac', '1', '-acodec', 'pcm_s16le',
        '-y', wavPath,
      ], { windowsHide: true });

      ffmpegProc.stdin.setDefaultEncoding('utf8');
      // Stopping a recording writes 'q' to this pipe. If ffmpeg already died
      // (mic unplugged, device taken by another app) that write races its exit
      // and reports EPIPE as an 'error' event on the stream, not as a throw —
      // unhandled, it would take the server down at the end of a dictation.
      ffmpegProc.stdin.on('error', () => {}); // the exit handler already settles it

      ffmpegProc.stderr.setEncoding('utf8');

      let stderrAccum = '';
      let didStart = false;
      let silenceNotified = false;
      let sawSpeech = false;
      let _silenceDebounce = null; // fires stt_silence after a short wait when no speech yet
      ffmpegProc.stderr.on('data', d => {
        stderrAccum += d;
        if (!didStart && /Press \[q\] to stop/i.test(stderrAccum)) {
          didStart = true;
          resolveRecording();
        }
        // End-of-speech detection: stop the recorder as soon as the user goes quiet.
        // • silence_end  → audio resumed; the user is actively speaking (sawSpeech).
        // • silence_start → user paused. We ALWAYS wait a bit before deciding end-of-
        //   speech, otherwise a natural mid-sentence pause (e.g. between words or a
        //   breath) would cut the user off. silence_end during the wait cancels it.
        if (!silenceNotified) {
          if (/silence_end:/.test(d)) {
            sawSpeech = true;
            if (_silenceDebounce) { clearTimeout(_silenceDebounce); _silenceDebounce = null; }
          }
          if (/silence_start:/.test(d) && !_silenceDebounce) {
            const startMatch = d.match(/silence_start:\s*([\d.]+)/);
            const silenceStartAt = startMatch ? Number(startMatch[1]) : 0;
            if (Number.isFinite(silenceStartAt) && silenceStartAt > 0.35) sawSpeech = true;
            // Long grace after real speech: people pause mid-sentence to think,
            // and we MUST NOT cut them off. Short grace when no speech happened
            // yet (the user is just slow to start, no need to wait as long).
            const grace = sawSpeech ? STT_AFTER_SPEECH_SILENCE_GRACE_MS : STT_START_SILENCE_GRACE_MS;
            _silenceDebounce = setTimeout(() => {
              if (!silenceNotified) { silenceNotified = true; broadcastSSE('stt_silence', { id }); }
            }, grace);
          }
        }
      });
      ffmpegProc.on('exit', () => resolveSaved());
      ffmpegProc.on('error', e => {
        process.stdout.write('[STT] ffmpeg error: ' + e.message + '\n');
        if (!didStart) { didStart = true; resolveRecording(); }
        resolveSaved();
      });

      _sttPending.set(id, { ffmpegProc, wavPath, recordingStarted, resolveRecording, recordingSaved, resolveSaved, silenceDb, startedAt: Date.now() });

      try {
        await Promise.race([
          recordingStarted,
          new Promise((_, rej) => setTimeout(() => rej(new Error('ffmpeg did not start recording')), 6000)),
        ]);
      } catch (startErr) {
        // A failed start must not leak the pending slot: a stale entry keeps
        // every later start answering 409, keeps the wake word's isBusy() true
        // and leaves its listener suspended. Clean up, then rethrow for the 500.
        _sttPending.delete(id);
        try { ffmpegProc.kill(); } catch { /* never spawned / already gone */ }
        if (_sttPending.size === 0) wakeWord.resumeSoon();
        throw startErr;
      }
      process.stdout.write(`[STT] Recording id=${id} via=${_sttVia()} silence=${silenceDb.toFixed(1)}dB gain=${gain}x\n`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  },
};

module.exports = { branches };
