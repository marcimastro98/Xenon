// Ends a live voice session: its timer, capture and connection are closed, the speaker volume
// and the wake word are put back.

const wakeWord = require('../wakeword.js');
const { liveVoice } = require('./live-voice-state.js');
const { liveNow } = require('./live-session-state.js');
const { _restoreSpeakerVolume } = require('../audio/speaker-duck.js');
const { refreshWakeWordWatch } = require('./wake-word-watch.js');

async function _teardownLiveSession(reason) {
  // No-op only when the session neither started arming (no liveVoice.active) nor
  // created any handles. Crucially, if liveVoice.active was set true — even before
  // liveNow.session was assigned, i.e. a stop that lands mid-await in the 'start'
  // path — we must STILL restore the duck and the wake word, or the mic stays
  // ducked and the wake word stays suspended forever.
  if (!liveVoice.active && !liveNow.session) return;
  const s = liveNow.session;
  const wasActive = liveVoice.active;
  liveNow.session = null;
  liveVoice.active = false;
  try { if (s && s.timer) clearTimeout(s.timer); } catch {}
  try { if (s && s.capture) s.capture.stop(); } catch {}
  try { if (s && s.session) s.session.close(); } catch {}
  try { _restoreSpeakerVolume(); } catch {}
  // Mic released: restore the wake word's desired state, then let it come back
  // after a settle delay (clears the suspend flag). Mirrors the STT stop path.
  if (wasActive) {
    try { refreshWakeWordWatch(); } catch {}
    try { wakeWord.resumeSoon(); } catch {}
  }
  process.stdout.write(`[Live] session ended (${reason || 'done'})\n`);
}

module.exports = { _teardownLiveSession };
