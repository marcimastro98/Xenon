// Decides when a voice recording holds speech and when it has ended: the thresholds and the
// waits.

// A recorder is normally reaped within seconds — the silence detector ends it or
// the client POSTs /api/stt/stop. If the client dies mid-recording (a crashed tab,
// or the dashboard closing right after a hands-free wake), the entry would live
// forever: ffmpeg keeps writing to %TEMP%, every later /api/stt/start answers 409,
// and wakeWord.isBusy() stays true so the resumed listener drops every segment —
// wake word is dead until restart. This periodic sweep reaps any over-age entry,
// kills its ffmpeg, unlinks the wav and lets the wake word recover. Zero cost when
// there is nothing recording (the common case).
const STT_MAX_AGE_MS = 5 * 60 * 1000;

const STT_SPEECH_MIN         = 420;
const STT_START_SILENCE_GRACE_MS       = 3200;
// After real speech, ffmpeg needs 0.55 s of quiet to report silence_start and
// this grace runs on top: about 1.5 s from the last word to the answer, long
// enough for a breath between clauses, short enough to feel like a reply.
const STT_AFTER_SPEECH_SILENCE_GRACE_MS = 1000;

// End-of-speech silence threshold (raw input, BEFORE the gain boost is applied).
// Kept lenient so a quiet mic — e.g. a Bluetooth headset in hands-free mode,
// whose speech sits well below a normal mic's — is not mistaken for silence and
// cut off mid-sentence. Noisy mics whose idle hum exceeds this just fall back to
// the client-side auto-stop timer, which is the safe degradation.
function _sttSilenceDb() {
  return -42;
}

// Speech gate runs on the gain-boosted clip. The boost lifts real speech above
// the floor while idle noise — proportionally lower — stays beneath it, so this
// still rejects near-silent clips before they reach Gemini.
function _sttLooksLikeSpeech(stats) {
  if (!stats) return false;
  if (stats.rms >= STT_SPEECH_MIN) return true;
  return stats.rms >= 330 && stats.peak >= 620;
}


// Looking for the microphone costs a few ffmpeg runs and nothing needs it in the first
// seconds, so it waits for the start to settle. By then the default mic is known too,
// which saves the rebind round a look at the very start used to trigger.
const STT_DEVICE_DELAY_MS = 30 * 1000;

module.exports = {
  STT_MAX_AGE_MS, STT_SPEECH_MIN, STT_START_SILENCE_GRACE_MS, STT_AFTER_SPEECH_SILENCE_GRACE_MS,
  _sttSilenceDb, _sttLooksLikeSpeech, STT_DEVICE_DELAY_MS,
};
