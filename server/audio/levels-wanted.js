// Whether anything on screen wants the live sound levels, and the reader that starts and stops
// with that answer.

const { sseClients } = require('../http/sse-clients.js');
const audioLevels = require('../audio-levels.js');
const { hub } = require('../settings/current.js');
const { sdkGrantsFor } = require('../widget-sdk/grants.js');

// ── Per-app audio peak meters ───────────────────────────────────────────────
// Demand-driven, with NO setting of its own. This is a ~12/s broadcast, so it
// must not run for everyone by default — but a second global switch was the
// wrong way to hold that line: approving the widget's `audioLevels` permission
// IS the consent, and every other stream starts working the moment you grant it.
// Asking twice, in two different places, only made the widget look broken until
// you found the second switch. So the cost follows the grant: the helper child
// starts when some installed package has actually been granted this stream and a
// dashboard is open, and stops otherwise. sdkGrantsFor() fails closed under safe
// mode and per-package suspend, so both of those turn it off for free.
function audioLevelsWanted() {
  if (!audioLevels.available()) return false;
  // The Media tile's waveform is the first FIRST-PARTY consumer. It gets a
  // switch of its own for the reason the comment above gives about widgets:
  // turning the feature on IS the consent, and there is exactly one place to do
  // it. A built-in has no grant to ride, so this is that one place.
  const viz = hub.settings && hub.settings.mediaVisualizer;
  if (viz && viz !== 'off') return true;
  const sw = hub.settings && hub.settings.sdkWidgets;
  const grants = sw && sw.grants && typeof sw.grants === 'object' ? sw.grants : null;
  if (!grants) return false;
  for (const pkgId of Object.keys(grants)) {
    if (sdkGrantsFor(pkgId).streams.includes('audioLevels')) return true;
  }
  return false;
}
function refreshAudioLevelsWatch() {
  if (audioLevelsWanted() && sseClients.size > 0) audioLevels.start();
  else audioLevels.stop();
}

module.exports = { audioLevelsWanted, refreshAudioLevelsWatch };
