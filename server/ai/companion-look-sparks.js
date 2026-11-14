// What one look of Bit costs in Sparks: the last real cost, or the usual one before any look.

const { COMPANION_TYPICAL_SPARKS } = require('./limits.js');
const { companionState } = require('./companion-state.js');

function companionLookSparks() {
  return Number.isFinite(companionState.lastSparks) ? companionState.lastSparks : COMPANION_TYPICAL_SPARKS;
}

module.exports = { companionLookSparks };
