// Plays a spoken answer on this PC's speakers and stops it.

const fs = require('node:fs');
const { broadcastSSE } = require('../http/sse-clients.js');
const { speakState } = require('./speak-state.js');
const { _duckSpeakerVolume, _restoreSpeakerVolume } = require('../audio/speaker-duck.js');
const { _spawnWavPlayer } = require('../wav/player.js');

function stopServerSpeak() {
  speakState.genToken++;
  if (speakState.proc) { try { speakState.proc.kill(); } catch {} speakState.proc = null; }
  _restoreSpeakerVolume(); // restore if ducked during interrupted TTS
}

// Play a WAV file (synchronous playback, focus-independent).
// Resolves when playback finishes or is cancelled. Honours the cancel token.
// `duck`/`broadcast`/`restore` let the chunked path duck the media volume and
// announce speak_start ONCE (first chunk) and restore ONCE (after the last),
// instead of flapping the volume on every sentence.
function _playWavFile(wavPath, myToken, { duck = true, broadcast = true, restore = true } = {}) {
  return new Promise((resolve) => {
    if (speakState.genToken !== myToken) { fs.promises.unlink(wavPath).catch(() => {}); return resolve(); }
    if (duck) _duckSpeakerVolume(); // lower music/media volume while Xenon speaks
    if (broadcast) broadcastSSE('speak_start', {}); // tell the UI the voice is actually starting now
    const psProc = _spawnWavPlayer(wavPath);
    speakState.proc = psProc;
    let _settled = false;
    const done = () => {
      if (_settled) return;
      _settled = true;
      clearTimeout(_guard);
      if (speakState.proc === psProc) speakState.proc = null;
      // The PowerShell one-liner only deletes the wav on a CLEAN PlaySync() exit;
      // a barge-in / guard kill terminates it first, so always unlink here too
      // (a no-op if the script already removed it) — otherwise every tap-to-
      // interrupt leaks one temp wav.
      fs.promises.unlink(wavPath).catch(() => {});
      if (restore) _restoreSpeakerVolume(); // bring music back when Xenon finishes speaking
      resolve();
    };
    // Playback cap (safety net against a stuck SoundPlayer). Kept below the
    // client's _aiSpeak guard so the client never races ahead and re-opens the
    // mic before this resolves. Raise both together if you change one.
    const _guard = setTimeout(() => { try { psProc.kill(); } catch {} done(); }, 40000);
    psProc.on('exit', done);
    psProc.on('error', done);
  });
}

module.exports = { stopServerSpeak, _playWavFile };
