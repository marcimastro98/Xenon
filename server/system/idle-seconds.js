// How long ago the keyboard or mouse was last used on this PC, and the last reading kept for
// those who ask often.

const { nativeCollectors } = require('./native-collectors.js');
const { POWERSHELL_SUPPORTED } = require('../powershell/supported.js');
const { IDLE_SCRIPT } = require('./script-paths.js');
const { runCollector } = require('./pwsh-worker.js');

// Seconds since the last keyboard or mouse input on this PC, or null when it
// cannot be read: idle.ps1 on Windows, the collector seam elsewhere.
async function readIdleSeconds() {
  try {
    if (POWERSHELL_SUPPORTED) {
      const r = await runCollector(IDLE_SCRIPT, [], 5000);
      return r && r.ok === true && Number.isFinite(Number(r.idleSec)) ? Math.max(0, Number(r.idleSec)) : null;
    }
    if (nativeCollectors && typeof nativeCollectors.idleSeconds === 'function') {
      const sec = await nativeCollectors.idleSeconds();
      return Number.isFinite(sec) ? Math.max(0, sec) : null;
    }
  } catch { /* unknown */ }
  return null;
}

// ── System-idle probe (presence for Bit, the vitals pet) ─────────────────────
// The Xeneon touchscreen alone can't prove the user is at the PC (they may
// never tap that monitor), so the pet's PC-invading actions key off REAL input
// recency via GetLastInputInfo (idle.ps1, hosted in the persistent worker —
// Add-Type compiles once per worker lifetime, repeat reads are instant).
// Four consumers: the pet's PC-invading actions (/api/vitals/nag), the meters'
// away-pause (vitals.js freezes decay once idleSec crosses its threshold), the
// Ambient screensaver auto-start (ambient-mode.js starts/dismisses on whole-PC
// idle so it never fires while the user is busy on another screen), and the
// greeting splash's presence gate (ambient.js holds a day-part until someone is
// there), so the probe runs when ANY of them wants it. Polled only while an SSE client is
// connected: zero cost at idle. Consumed by statusPayload() and /api/vitals/nag.
const _idleProbe = { sec: null, at: 0 };

module.exports = { readIdleSeconds, _idleProbe };
