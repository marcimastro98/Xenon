// Checks one timer before it is kept: id, label, countdown or stopwatch, duration, chimes and
// where it stands.

const { SAFE_ITEM_ID_RE } = require('./item-id.js');
const { TIMER_KINDS, _timerId } = require('./timer-values.js');
const { SCOPED_LABEL_MAX } = require('../actions/widget-timers.js');

function _normalizeTimer(item) {
  const given       = String(item && item.id || '').slice(0, 80);
  // SAFE_ITEM_ID_RE: see _noteId. A malformed id is replaced, not escaped.
  const id          = SAFE_ITEM_ID_RE.test(given) ? given : _timerId();
  const label       = String(item && item.label || 'Timer').trim().slice(0, SCOPED_LABEL_MAX);
  const kind        = TIMER_KINDS.includes(item && item.kind) ? item.kind : 'countdown';
  // A stopwatch has no duration. Storing 0 rather than a fake 60 keeps every
  // "is this a countdown" test honest, including in a settings file somebody
  // has edited by hand.
  const durationSecs = kind === 'stopwatch' ? 0 : Math.max(1, Math.round(Number(item && item.durationSecs) || 60));
  // A stopwatch may CHIME every N seconds. Zero is off, which is what every
  // stopwatch was until somebody said what they actually use one for: "it goes
  // up and sounds an alert at specified intervals, I use it for stretching".
  // Meaningless on a countdown, which already has one alert at the end.
  const intervalSecs = kind === 'stopwatch'
    ? Math.max(0, Math.min(86400, Math.round(Number(item && item.intervalSecs) || 0)))
    : 0;
  // How many have already sounded. Persisted rather than derived, so a restart
  // mid-run does not replay every chime the stopwatch has ever made.
  const chimes = Math.max(0, Math.round(Number(item && item.chimes) || 0));
  const status      = ['running', 'paused', 'done'].includes(item && item.status) ? item.status : 'running';
  const startedAt   = Number.isFinite(Number(item && item.startedAt)) ? Number(item.startedAt) : Date.now();
  const pausedElapsed = Math.max(0, Number(item && item.pausedElapsed) || 0);
  const createdAt   = item && item.createdAt ? String(item.createdAt).slice(0, 40) : new Date().toISOString();
  return { id, label, kind, durationSecs, intervalSecs, chimes, status, startedAt, pausedElapsed, createdAt };
}

module.exports = { _normalizeTimer };
