// Starts or stops listening for the wake word, to match who is connected and whether a live
// voice session holds the microphone.

const { sseClients } = require('../http/sse-clients.js');
const wakeWord = require('../wakeword.js');
const { liveVoice } = require('./live-voice-state.js');
const { wakeWordWanted } = require('./wake-word-wanted.js');

function refreshWakeWordWatch() {
  // Listener count first: it short-circuits the (cached) whisper probe away
  // whenever nobody is connected. A live voice session owns the mic (dshow can't
  // share it), so the wake word stays down for its whole duration.
  wakeWord.sync(!liveVoice.active && sseClients.size > 0 && wakeWordWanted());
}

module.exports = { refreshWakeWordWatch };
