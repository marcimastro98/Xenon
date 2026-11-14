// The last processor reading: the counters it was worked out from, the load and the busiest
// core.

const cpuRead = {
  last: undefined, // given its first value where the engine loads
  usage: 0,
  // The busiest logical core over the same 1.5 s: a game held back by one thread
  // shows a pegged core while the total stays low ("why does it stutter?").
  maxCore: 0,
};

module.exports = { cpuRead };
