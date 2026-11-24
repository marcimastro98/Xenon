'use strict';
// Airflow's live event: the engine publishes a status every tick it runs (loop.js),
// the dashboards hear 'airflow' only when something they show changed: the state, the
// mode, the headline reason, the check's step, who drives a fan or why not. Speeds
// move every second and are not a reason to redraw a menu; the Fans section reads
// them itself while it is open (GET /airflow). A reason that flips every second
// (a short peak let pass, then idle) is told at most every MIN_GAP_MS, the latest one
// last, so every open menu does not read the fans again each second.

// The check's progress is told in steps this wide (percent), not every tick.
const PROGRESS_STEP = 10;
const MIN_GAP_MS = 2000;

/** The part of a status a dashboard draws differently when it changes. */
function signature(s) {
  if (!s) return '';
  return JSON.stringify([
    s.state, s.drive, s.mode, s.why, s.safety,
    s.check ? [s.check.phase, Math.floor((s.check.progress || 0) * 100 / PROGRESS_STEP)] : null,
    s.lastCheck?.at ?? null, s.checkEnded?.at ?? null,
    (s.fans || []).map((f) => [f.id, f.xenon, f.why]),
    s.unavailable,
  ]);
}

/**
 * @param {{ broadcast: (event: string, data: any) => void, now?: () => number,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} deps
 */
function createAirflowLive({ broadcast, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let last = '';
  let sentAt = -Infinity;
  let pending = null;
  let timer = null;
  const send = (status) => {
    sentAt = now();
    broadcast('airflow', { state: status.state, why: status.why, check: status.check });
  };
  const flush = () => {
    timer = null;
    const status = pending;
    pending = null;
    if (status) send(status);
  };
  return {
    /** Called with every status the engine publishes. */
    push(status) {
      const sig = signature(status);
      if (sig === last) return;
      last = sig;
      const wait = sentAt + MIN_GAP_MS - now();
      if (wait <= 0 && !timer) { send(status); return; }
      pending = status;
      if (!timer) {
        timer = setTimer(flush, Math.max(0, wait));
        if (timer && typeof timer.unref === 'function') timer.unref();
      }
    },
    /** Shutdown: a change still waiting is dropped, nobody is listening any more. */
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
      pending = null;
    },
  };
}

module.exports = { createAirflowLive, signature, PROGRESS_STEP, MIN_GAP_MS };
