// Watching Voicemeeter while a dashboard shows a key or a tile bound to it, and stopping when
// none does.

const { sseClients, broadcastSSE } = require('../http/sse-clients.js');
const { deckVoicemeeter } = require('./mixer-clients.js');
const { VM_POLL_MS } = require('./voicemeeter-timing.js');
const { vmWatch } = require('./voicemeeter-watch-state.js');

function refreshVoicemeeterWatch() {
  const want = sseClients.size > 0 && deckVoicemeeter.state().available === true;
  if (want && !vmWatch.pollTimer) {
    vmWatch.pollTimer = setInterval(() => {
      try {
        if (!deckVoicemeeter.dirty()) return;
        const v = deckVoicemeeter.values();
        if (!v) return;
        // The dirty flag also fires for things this frame does not carry (a
        // level meter, a window move), so the payload is compared before it is
        // sent: a widget re-rendering 4x a second for nothing is the cost this
        // avoids.
        const json = JSON.stringify(v);
        if (json === vmWatch.lastJson) return;
        vmWatch.lastJson = json;
        broadcastSSE('voicemeeter', v);
      } catch { /* a mixer that went away is not worth a log line per tick */ }
    }, VM_POLL_MS);
    if (vmWatch.pollTimer.unref) vmWatch.pollTimer.unref();
  } else if (!want && vmWatch.pollTimer) {
    clearInterval(vmWatch.pollTimer); vmWatch.pollTimer = null; vmWatch.lastJson = '';
  }
}

module.exports = { refreshVoicemeeterWatch };
