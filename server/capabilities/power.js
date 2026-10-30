'use strict';
// The PC's battery and the system power mode (server/power/index.js reads and
// changes them; this file only maps a Deck key or a Bit call onto it).
//
// deps.power (injected): { available(), read(), setMode(mode), lastKnown() }

const ORDER = Object.freeze(['saver', 'balanced', 'performance']);

function readable(power) {
  return !!(power && typeof power.available === 'function' && power.available());
}

// A Deck key that can only fail stays out of the editor: the last read says
// whether this machine can change its mode now (a plan switch shows it again).
function settable(power) {
  if (!readable(power)) return false;
  const known = power.lastKnown();
  return !!(known && known.canSet);
}

function nextMode(state) {
  const offered = ORDER.filter((m) => state.modes.includes(m));
  if (!offered.length) return null;
  const at = offered.indexOf(state.mode);
  return offered[(at + 1) % offered.length];
}

async function setMode(d, action) {
  const power = d && d.power;
  if (!readable(power)) return { ok: false, error: 'unavailable' };
  let mode = action && action.mode;
  if (mode === 'next' || mode == null) {
    const state = await power.read();
    if (!state) return { ok: false, error: 'unavailable' };
    if (!state.canSet) return { ok: false, error: state.why || 'unsupported' };
    mode = nextMode(state);
  }
  return power.setMode(mode);
}

async function status(d) {
  const power = d && d.power;
  if (!readable(power)) return { ok: false, error: 'unavailable' };
  const state = await power.read();
  return state ? { ok: true, ...state } : { ok: false, error: 'failed' };
}

module.exports = { readable, settable, nextMode, setMode, status };
