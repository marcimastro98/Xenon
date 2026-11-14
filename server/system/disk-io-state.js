// The last counters of each disk, to work out a rate from two readings, and the reading under
// way.

const diskIo = {
  // --- Per-disk I/O ----------------------------------------------------------
  // Asked for on Discord for an SDK monitoring widget: throughput and IOPS per
  // physical disk, with a model and a volume so a person can tell which is which.
  //
  // Pulled, never polled. Every platform's counters are cumulative, so the rate
  // is the same inter-poll delta the network interfaces use — and the same rule
  // about what an unknown rate is: null, never 0.
  //
  // `diskIo.prev` is keyed by the collector's id. A disk that is unplugged is
  // forgotten on the next read, and one that appears reports null until it has
  // two readings of its own.
  prev: new Map(),     // id -> { rb, wb, ro, wo, t }
  pending: null,
};

module.exports = { diskIo };
