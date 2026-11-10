'use strict';
// Pause, resume, restart and stop a timer or stopwatch: the one set of rules
// for the Timers tile (PATCH /api/timers/:id) and Bit (control_timer). Pure:
// the caller saves and broadcasts.
//   pause   a running one holds where it is
//   resume  a paused one counts on
//   reset   from zero (or its full time) and counting
//   stop    back to zero (or its full time) and held there

const ACTIONS = Object.freeze(['pause', 'resume', 'reset', 'stop']);

// → the changed copy, or null when the action does nothing in this state.
function applyTimerAction(timer, action, now) {
  const t = { ...timer };
  if (action === 'pause' && t.status === 'running') {
    t.pausedElapsed += (now - t.startedAt) / 1000;
    t.status = 'paused';
  } else if (action === 'resume' && t.status === 'paused') {
    t.startedAt = now;
    t.status = 'running';
  } else if (action === 'reset' || action === 'stop') {
    t.startedAt = now;
    t.pausedElapsed = 0;
    // The chimes already sounded belong to the run that just ended.
    t.chimes = 0;
    // `stop` keeps a timer for later at its full time; `reset` restarts it.
    t.status = action === 'stop' ? 'paused' : 'running';
  } else {
    return null;
  }
  return t;
}

const fold = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').trim();

// The timer Bit means: its id, its label (exact, then words in it), or, with
// nothing named, the only one there is or else the newest one that fits the
// action (pause → a running one, resume → a paused one).
function findTimer(timers, which, action) {
  const list = Array.isArray(timers) ? timers : [];
  const w = fold(which);
  if (w) {
    return list.find((t) => t.id === String(which).trim())
      || list.find((t) => fold(t.label) === w)
      || list.find((t) => fold(t.label).includes(w))
      || null;
  }
  if (list.length === 1) return list[0];
  const wanted = action === 'pause' ? 'running' : action === 'resume' ? 'paused' : null;
  const fits = wanted ? list.filter((t) => t.status === wanted) : [];
  return fits.length ? fits[fits.length - 1] : null;
}

module.exports = { ACTIONS, applyTimerAction, findTimer };
