// The Deck windows the engine opened, so it can close them when it stops.

// Virtual Deck popup: Edge app-mode children we spawned (closed on shutdown)
// and the one-shot always-on-top helper script.
const _deckPopupPids = new Set();

module.exports = { _deckPopupPids };
