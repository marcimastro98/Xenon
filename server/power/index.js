'use strict';
// The PC's own battery and the system power mode, the same shape on every OS:
//   read()  → { battery: {percent, plugged, charging, minutesLeft} | null,
//               saver, mode: 'saver'|'balanced'|'performance'|null,
//               modes: the ones setMode() can pick here, canSet,
//               why?: 'plan'|'custom'|'needs_admin'|'no_daemon' }
//   setMode(mode) → { ok } | { ok:false, error }
// The backend is picked once here, never by the callers. Reads are cached for a
// few seconds and shared, so the Deck, Bit and a screen asking together cost one.

const P = require('./parse.js');

const READ_TTL_MS = 3000;

function pickBackend(platform) {
  if (platform === 'win32') return require('./windows.js');
  if (platform === 'darwin') return require('./darwin.js');
  if (platform === 'linux') return require('./linux.js');
  return null;
}

function createPower(backend, now = Date.now) {
  let cached = null;
  let at = 0;
  let pending = null;

  const available = () => {
    try { return !!(backend && backend.available()); } catch { return false; }
  };

  async function read() {
    if (!available()) return null;
    if (cached && now() - at < READ_TTL_MS) return cached;
    if (pending) return pending;
    pending = backend.read()
      .then((r) => { cached = r; at = now(); return r; })
      .catch(() => null)
      .finally(() => { pending = null; });
    return pending;
  }

  async function setMode(mode) {
    if (!P.MODES.includes(mode)) return { ok: false, error: 'bad_mode' };
    const state = await read();
    if (!state) return { ok: false, error: 'unavailable' };
    if (!state.canSet) return { ok: false, error: state.why || 'unsupported' };
    if (!state.modes.includes(mode)) return { ok: false, error: 'mode_missing' };
    if (state.mode === mode) return { ok: true, mode, changed: false };
    let res;
    try { res = await backend.setMode(mode); } catch { res = { ok: false, error: 'failed' }; }
    cached = null;
    return res && res.ok ? { ok: true, mode, changed: true } : { ok: false, error: (res && res.error) || 'failed' };
  }

  // For the synchronous capability probes: the last answer, however old, and a
  // fresh read started behind it when it is stale (or there was none yet).
  function lastKnown() {
    if (available() && (!cached || now() - at >= READ_TTL_MS)) read();
    return cached;
  }

  return { available, read, setMode, lastKnown };
}

const power = createPower(pickBackend(process.platform));

module.exports = { ...power, createPower, MODES: P.MODES };
