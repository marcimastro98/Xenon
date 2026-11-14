'use strict';
// The memory of a Linux machine: the text of /proc/meminfo read into used and free bytes, and
// the reading the dashboard gets.

const fsp = require('node:fs').promises;
const os = require('node:os');

// --- Memory: /proc/meminfo, because os.freemem() means something else here ---
// os.freemem() is MemFree, which excludes the page cache the kernel would hand
// straight back — so `total - free` counts every cached file as used and the
// RAM tile reads far higher than anything the user's own tools show. On Windows
// the same call is ullAvailPhys and already accounts for that, which is why the
// figure was right there and wrong the moment the port reached a second OS.
// MemAvailable is the kernel's own answer to "how much could a new workload
// get", which is exactly the Windows meaning, and it has been in /proc/meminfo
// since 3.14. Where it is missing the classic approximation stands in.
function parseMemInfo(out) {
  const kb = (label) => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\s*kB`, 'm').exec(String(out || ''));
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = kb('MemTotal');
  if (!total) return null;
  let available = kb('MemAvailable');
  if (available === null) {
    const free = kb('MemFree'), buffers = kb('Buffers'), cached = kb('Cached');
    if (free === null) return null;
    available = free + (buffers || 0) + (cached || 0);
  }
  return { used: Math.max(0, Math.min(total, total - available)), total };
}

async function memory() {
  let raw = null;
  try { raw = await fsp.readFile('/proc/meminfo', 'utf8'); } catch { /* not procfs */ }
  const parsed = raw === null ? null : parseMemInfo(raw);
  return parsed || { used: os.totalmem() - os.freemem(), total: os.totalmem() };
}

module.exports = { parseMemInfo, memory };
