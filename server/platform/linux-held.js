'use strict';
// What the Linux collectors remember between two reads: the last answers, and the tools looked
// for once.

const held = {
  nvidiaSmiMissingAt: 0,
  // id → where it was found in the last walk, so a read touches only the files
  // asked for. Some of these reads reach real hardware (drivetemp asks the disk),
  // which is why read mode never re-walks every chip on each tick.
  hwmonIndex: new Map(),
  hwmonIndexAt: 0,
  audioRowsCache: { rows: null, at: 0 },
  audioProbe: null,
  audioProbeAt: 0,
  keysProbe: null,
  hideProbe: null,
  // The page size is needed to turn stat's rss (in pages) into bytes, and Node
  // exposes no sysconf(_SC_PAGESIZE). Deriving it once from OUR OWN process — where
  // both spellings of the same number are readable — is exact on 4K x86 and on the
  // 16K/64K ARM kernels a hardcoded 4096 would under-report by 4x or 16x.
  pageBytes: 0,
  procPrev: null,
  procPrevAt: 0,
};

module.exports = { held };
