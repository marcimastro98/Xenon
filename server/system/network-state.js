// The last network counters, whole and per interface, the reading under way and the last
// answer.

const netReadings = {
  // --- Network info: bandwidth requires a delta between two readings ---
  prev: null, // { rx, tx, t }
  // Per-interface previous counters, keyed by the collector's stable id. Its own
  // map rather than a field on netReadings.prev: an interface can appear (a VPN comes up)
  // or vanish (a dock is unplugged) between two polls, and the totals must not
  // care. A vanished id is dropped so the map cannot grow forever on a laptop
  // that sees a new virtual adapter per container.
  prevIfaces: new Map(),  // id -> { rx, tx, t }
  pending: null,
  last: null,
};

module.exports = { netReadings };
