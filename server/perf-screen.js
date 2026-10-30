'use strict';

// Performance Mode with no dashboard ("widgets only", js/driver-perf.js).
//
// The hidden driver page runs Performance Mode but cannot draw; the on-screen
// alerts window draws but does not run it. They talk through the server, as
// SSE `perf_screen` events, in three shapes:
//   prompt  driver -> alerts   the suggestion card ('' activity closes it)
//   toast   driver -> alerts   what an optimize or restore did
//   answer  alerts/Bit -> driver   the user's choice
// Each one is rebuilt from known fields here, so neither page trusts the other.
//
// The driver also keeps its own `performance` block (active session, saved
// power plan, closed apps) through normalizePerformance, the same normalizer
// the dashboard saves with (js/perf-settings.js).

const { PERF_ACTIVITIES, normalizePerformance } = require('./js/perf-settings.js');

const CHOICES = Object.freeze(['optimize', 'ignore', 'never', 'restore']);
const NOTE_KEYS = Object.freeze(['perf_status_optimized', 'perf_status_failed', 'perf_status_restored', 'perf_auto_on', 'perf_auto_off']);
const FREED_MAX = 16;   // "1.5 GB", "800 MB"

// A `perf_screen` event as it may go out, or null when the body is not one.
function screenEvent(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.kind === 'prompt') {
    const activity = b.activity === '' ? '' : (PERF_ACTIVITIES.includes(b.activity) ? b.activity : null);
    return activity === null ? null : { kind: 'prompt', activity };
  }
  if (b.kind === 'toast') {
    const n = b.note && typeof b.note === 'object' ? b.note : {};
    if (!NOTE_KEYS.includes(n.key)) return null;
    const activity = PERF_ACTIVITIES.includes(n.activity) ? n.activity : '';
    const freed = typeof n.freed === 'string' && /^~?[\d.,]+ (MB|GB)$/.test(n.freed) && n.freed.length <= FREED_MAX ? n.freed : '';
    return { kind: 'toast', tone: b.tone === 'error' ? 'error' : 'ok', note: { key: n.key, activity, freed } };
  }
  if (b.kind === 'answer') {
    return CHOICES.includes(b.choice) ? { kind: 'answer', choice: b.choice } : null;
  }
  return null;
}

// The driver's save: only the `performance` block, normalized.
function stateFrom(body) {
  const p = body && typeof body === 'object' ? body.performance : null;
  return p && typeof p === 'object' && !Array.isArray(p) ? normalizePerformance(p) : null;
}

module.exports = { screenEvent, stateFrom, CHOICES };
