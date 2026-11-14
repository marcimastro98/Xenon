// The connection to Razer Chroma, made when the engine starts and opened only when a light is
// asked for: it lets go again after a while with nothing to show.

const { createChroma } = require('../actions/chroma.js');

// Lazy Razer Chroma client — opens the local Chroma SDK session on demand, holds
// it with a heartbeat ONLY while lighting is active, and uninitializes after idle
// (Synapse then resumes the user's own lighting). One session serves both the
// direct Deck/SDK actions AND the ambient `chroma` lighting-provider. Enabled via
// Settings → chroma.enabled (opt-in, so it never probes localhost otherwise).
const deckChroma = createChroma();

module.exports = { deckChroma };
