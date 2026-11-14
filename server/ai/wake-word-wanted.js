// Whether the wake word should be listened for: it is switched on, something would answer it,
// and speech-to-text is on this computer.

const UsageMode = require('../js/usage-mode.js');
const { hub } = require('../settings/current.js');
const { _whisperReady } = require('./whisper-ready.js');

function wakeWordWanted() {
  const w = hub.settings && hub.settings.wakeWord;
  // "Widgets only" has no dashboard: the on-screen alerts window answers it
  // (js/screen-bit.js). With that window turned off nobody would, so the mic
  // stays closed.
  if (UsageMode.widgetsOnly(hub.settings && hub.settings.usageMode)) {
    const n = hub.settings.notifications;
    if (n && n.onScreen === false) return false;
  }
  return !!(w && w.enabled) && _whisperReady();
}

module.exports = { wakeWordWanted };
