'use strict';
// Game-session capabilities: the log of games played (server/game-sessions.js)
// read and compared by Xenon AI, and switched on, off or cleared.
//
// deps (injected):
//   fps       the fps-monitor.js facade: a session needs a frame-rate source
//   sessions  { store() → the game-sessions store, enabled() → bool,
//               setEnabled(on) → Promise<bool> (writes under the settings lock) }

const MODES = Object.freeze(['on', 'off', 'clear']);

// PresentMon on Windows, MangoHud on Linux (average only); macOS has no frame
// rate, so there is no session to log.
function available(fps) {
  return !!(fps && (fps.backend === 'presentmon' || fps.backend === 'mangohud')
    && typeof fps.isAvailable === 'function' && fps.isAvailable());
}

function store(d) {
  const s = d && d.sessions && typeof d.sessions.store === 'function' ? d.sessions.store() : null;
  return s && typeof s.list === 'function' ? s : null;
}

const isOn = d => !(d.sessions && typeof d.sessions.enabled === 'function' && d.sessions.enabled() === false);

function listSessions(d, action) {
  const s = store(d);
  if (!s) return { ok: false, error: 'unavailable' };
  const sessions = s.list({ game: action.game || '', limit: 10 });
  if (!sessions.length) return { ok: false, error: isOn(d) ? 'no_sessions' : 'off' };
  return { ok: true, enabled: isOn(d), sessions };
}

function compare(d, action) {
  const s = store(d);
  if (!s) return { ok: false, error: 'unavailable' };
  const c = s.compare(action.game || '');
  if (!c) return { ok: false, error: isOn(d) ? 'no_sessions' : 'off' };
  if (!c.previous) return { ok: false, error: 'first_session', latest: c.latest };
  return { ok: true, ...c };
}

async function manage(d, action) {
  const mode = MODES.includes(action.mode) ? action.mode : null;
  if (!mode) return { ok: false, error: 'bad_mode', choices: MODES.slice() };
  if (mode === 'clear') {
    const s = store(d);
    if (!s) return { ok: false, error: 'unavailable' };
    await s.clear();
    return { ok: true, cleared: true };
  }
  if (!d.sessions || typeof d.sessions.setEnabled !== 'function') return { ok: false, error: 'unavailable' };
  const on = await d.sessions.setEnabled(mode === 'on');
  return { ok: true, enabled: !!on };
}

module.exports = { MODES, available, listSessions, compare, manage };
