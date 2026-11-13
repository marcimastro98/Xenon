// Limits of Bit: the size of a message, the length of a live voice session, and what a look at
// the screen usually costs.

const BIT_MESSAGE_BODY_MAX = 256 * 1024;

// What one Game Companion look costs on Sparks, for the line under "Analyze
// screen": the hub's charge for the last look, or a measured typical one until
// then (30 Oct 2026: one 1920px screenshot on Haiku was charged 0.3; the price
// table alone said 0.05, it misses what the hub adds). Display only.
const COMPANION_TYPICAL_SPARKS = 0.3;

const LIVE_MAX_SESSION_MS = 5 * 60 * 1000;

module.exports = { BIT_MESSAGE_BODY_MAX, COMPANION_TYPICAL_SPARKS, LIVE_MAX_SESSION_MS };
