'use strict';
// How long nobody has touched a Mac, and the Mac's own id, both read from ioreg.

const { runSoft } = require('./darwin-read.js');

// --- Idle time: seconds since the last keyboard/mouse/trackpad input ---------
// The automatic updater installs only on a PC nobody is using. IOHIDSystem
// keeps HIDIdleTime in nanoseconds for the whole session, readable without any
// permission prompt (unlike an event tap). null = could not tell, which the
// caller treats as "unknown", never as "idle".
function parseHidIdleTime(text) {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(text || ''));
  if (!m) return null;
  const ns = Number(m[1]);
  return Number.isFinite(ns) && ns >= 0 ? Math.floor(ns / 1e9) : null;
}
async function idleSeconds() {
  const out = await runSoft('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], 4000);
  return out == null ? null : parseHidIdleTime(out);
}

// The machine's own id, for pc-id.js.
function parsePlatformUuid(text) {
  const m = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{16,64})"/.exec(String(text || ''));
  return m ? m[1].toLowerCase() : '';
}

async function machineId() {
  return parsePlatformUuid(await runSoft('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], 4000));
}

module.exports = { parseHidIdleTime, idleSeconds, parsePlatformUuid, machineId };
