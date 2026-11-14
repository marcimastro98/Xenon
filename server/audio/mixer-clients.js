// The connections to the Elgato Wave Link mixer and to Voicemeeter, made when the engine starts
// and opened only when a tile or a Deck key asks.

const { createWaveLink } = require('../actions/wavelink.js');
const { createClient: createVoicemeeter } = require('../actions/voicemeeter.js');
const { readHubSettings } = require('../settings/read.js');

// Lazy Elgato Wave Link client — scans ws://127.0.0.1:1824..1834 on demand, mirrors
// mixer state while a tile/Deck key is on screen (SSE `wavelink`), idle-closes
// otherwise. Reads enabled/port from live settings each connection (no restart).
const deckWaveLink = createWaveLink(async () => {
  const s = (await readHubSettings().catch(() => null)) || {};
  const wl = (s && s.wavelink) || {};
  return { enabled: wl.enabled === true, port: wl.port };
});

// Voicemeeter Remote API client. Nothing is loaded until a key is pressed or the
// Deck editor asks what the mixer has: the DLL is only present on a machine that
// installed Voicemeeter, and everywhere else this stays a few closures. No
// enabled flag — unlike Wave Link there is no port to probe and no process to
// wake, so the presence of the DLL is the whole opt-in.
const deckVoicemeeter = createVoicemeeter();

module.exports = { deckWaveLink, deckVoicemeeter };
