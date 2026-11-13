// Turns two readings of a counter into a speed per second, for network and disk activity.

// Bytes-per-second from two cumulative readings. Returns null rather than 0 for
// everything that is not a real measurement — no previous sample, no elapsed
// time, or a counter that went BACKWARDS (an interface that was reset, or a
// 32-bit counter wrapping), because a made-up 0 in a graph reads as "idle" when
// the truth is "unknown".
function bytesPerSec(now, prev, dtSec) {
  if (!prev || !(dtSec > 0)) return null;
  const d = now - prev;
  if (!(d >= 0)) return null;
  return Math.round(d / dtSec);
}

const DISK_SECTOR = 512;       // /proc/diskstats' documented unit, on every device

module.exports = { bytesPerSec, DISK_SECTOR };
