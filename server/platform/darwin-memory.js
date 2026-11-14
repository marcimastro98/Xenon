'use strict';
// The memory of a Mac: the text of vm_stat read into used and free bytes, and the reading the
// dashboard gets.

const os = require('node:os');
const { runSoft, isFiniteNum } = require('./darwin-read.js');

// --- Memory: vm_stat, because os.freemem() does not mean the same thing here --
// On Windows os.freemem() is ullAvailPhys, which already counts the standby
// pages the OS would hand back on demand. On macOS it is the Mach free_count
// and nothing else, and this OS deliberately keeps that near zero: measured on
// an idle 8 GB M2, os.freemem() answered 0.06 GB, so `total - free` reported
// 99% used and the RAM tile sat there permanently. It is the same figure on
// every Mac, which makes it useless rather than merely wrong.
//
// The replacement is Activity Monitor's own "Memory Used" — App Memory + Wired
// + Compressed — so the number on the dashboard is the number the user can
// check against Apple's own tool. Compressed memory is REAL occupancy (this
// machine had 698k pages compressed into 154k) and counting it as free would
// understate the pressure exactly when it matters.
function parseVmStat(out, totalBytes) {
  const text = String(out || '');
  const pageSize = Number((/page size of (\d+) bytes/.exec(text) || [])[1]) || 4096;
  const pages = (label) => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(text);
    return m ? Number(m[1]) : null;
  };
  const anonymous = pages('Anonymous pages');
  const wired = pages('Pages wired down');
  const compressor = pages('Pages occupied by compressor');
  const purgeable = pages('Pages purgeable');
  const total = isFiniteNum(totalBytes) && totalBytes > 0 ? totalBytes : null;
  if (anonymous === null || wired === null || total === null) return null;
  // Purgeable pages are anonymous but reclaimable on demand — Apple excludes
  // them from App Memory, and so do we. `compressor` is absent on older vm_stat
  // builds; treating it as zero understates by that much rather than refusing
  // to report at all.
  const used = (Math.max(0, anonymous - (purgeable || 0)) + wired + (compressor || 0)) * pageSize;
  return { used: Math.min(total, used), total };
}

async function memory() {
  const out = await runSoft('vm_stat', [], 4000);
  const parsed = out === null ? null : parseVmStat(out, os.totalmem());
  // A machine whose vm_stat we cannot read still gets a reading, just the old
  // pessimistic one — never a blank tile.
  return parsed || { used: os.totalmem() - os.freemem(), total: os.totalmem() };
}

module.exports = { parseVmStat, memory };
