// Timers and stopwatches: how many there may be, the two kinds, a new id, and the seconds
// counted or left.

const TIMERS_MAX = 20;

// A timer is one of two things, and everything about running it is the same.
// A countdown has a duration and ends; a STOPWATCH counts up and does not.
// They share startedAt/pausedElapsed/status, so pause, resume, reset and stop
// are one implementation — the only places that branch are the two that ask
// "how long is left", which for a stopwatch is not a question.
//
// Asked for on Discord: "count the time up and monitor the length of time spent
// on a task". Modelled here rather than as a second feature because a stopwatch
// IS a timer whose duration nobody set.
const TIMER_KINDS = Object.freeze(['countdown', 'stopwatch']);

function _timerId() {
  return `t${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Seconds counted so far, for either kind. The stopwatch's whole reading. */
function _getTimerElapsed(t) {
  if (t.status === 'running') return t.pausedElapsed + (Date.now() - t.startedAt) / 1000;
  return t.pausedElapsed;
}

function _getTimerRemaining(t) {
  // A stopwatch has nothing remaining, and answering 0 would make _checkTimers
  // ring it the instant it starts.
  if (t.kind === 'stopwatch') return Infinity;
  if (t.status === 'done')   return 0;
  if (t.status === 'paused') return Math.max(0, t.durationSecs - t.pausedElapsed);
  const elapsed = t.pausedElapsed + (Date.now() - t.startedAt) / 1000;
  return Math.max(0, t.durationSecs - elapsed);
}

module.exports = { TIMERS_MAX, TIMER_KINDS, _timerId, _getTimerElapsed, _getTimerRemaining };
