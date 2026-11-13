// The chime sounds already built, kept so each is made once.

const chimeCache = {
  // Build a short two-note chime WAV in memory (sine + decay envelope).
  sounds: {},
};

module.exports = { chimeCache };
