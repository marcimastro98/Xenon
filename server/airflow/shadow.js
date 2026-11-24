'use strict';
// The shadow run: Xenon plans every second but writes nothing, and keeps score of
// what the fans did against what it would have asked, so the person sees the gain
// before handing the fans over ("about 6 dB quieter, 40 fewer changes you would
// hear"). Sound comes from brain-noise.js (the same laws the planner uses): the
// fans' real speeds against the speed each would turn at the planned duty, on the
// curve the fan check measured. A fan Xenon would not drive counts the same on
// both sides. Kept across restarts with what the brain learned.
const N = require('./brain-noise.js');
const { rpmAt } = require('./inventory.js');

// An audible change: the total level moving this much within CHANGE_SPAN_MS.
const CHANGE_DB = 1;
const CHANGE_SPAN_MS = 2000;
// One die over its target by this much, in the brain's 60 s prediction, is a
// second the plan would run warm.
const WARM_BY = 1;
// A tick longer than this (the PC slept) counts as one tick, not the gap.
const MAX_TICK_MS = 5000;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function side() {
  return { energy: 0, changes: 0, recent: [], changing: false };
}

function loadSide(raw) {
  const s = side();
  if (raw && finite(raw.energy) && raw.energy >= 0 && Number.isInteger(raw.changes) && raw.changes >= 0) {
    s.energy = raw.energy;
    s.changes = raw.changes;
  }
  return s;
}

/** @param {{ saved?: any }} [opts] */
function createShadow({ saved = {} } = {}) {
  const ok = saved && finite(saved.seconds) && saved.seconds >= 0;
  let seconds = ok ? saved.seconds : 0;
  let warmSeconds = ok && finite(saved.warmSeconds) && saved.warmSeconds >= 0 ? saved.warmSeconds : 0;
  const now = ok ? loadSide(saved.now) : side();
  const xenon = ok ? loadSide(saved.xenon) : side();
  let lastAt = null;

  // Energy is summed per second so a long run and a short one weigh by their length.
  function add(s, db, at, dt) {
    if (Number.isFinite(db)) s.energy += 10 ** (db / 10) * dt;
    s.recent.push({ at, db });
    while (s.recent.length && at - s.recent[0].at > CHANGE_SPAN_MS) s.recent.shift();
    const levels = s.recent.map((r) => (Number.isFinite(r.db) ? r.db : 0));
    const moved = Math.max(...levels) - Math.min(...levels) >= CHANGE_DB;
    if (moved && !s.changing) s.changes += 1;
    s.changing = moved;
  }

  /**
   * One planned second.
   * @param {{ at: number, channels: any[], rpm: Record<string, number|null>,
   *   duties: Record<string, number>, predicted?: Record<string, number>, targets?: Record<string, number> }} t
   */
  function observe({ at, channels, rpm, duties, predicted = {}, targets = {} }) {
    const dt = lastAt == null ? 1 : Math.min(MAX_TICK_MS, Math.max(0, at - lastAt)) / 1000;
    lastAt = at;
    if (dt <= 0) return;
    const real = [];
    const planned = [];
    for (const ch of channels) {
      const r = rpm[ch.id];
      const level = N.fanDb(ch, finite(r) ? r : 0);
      real.push(level);
      const d = duties[ch.id];
      planned.push(finite(d) && ch.curve?.length ? N.fanDb(ch, d > 0 ? rpmAt(ch.curve, d) : 0) : level);
    }
    add(now, N.totalDb(real), at, dt);
    add(xenon, N.totalDb(planned), at, dt);
    seconds += dt;
    if (Object.keys(predicted).some((n) => finite(targets[n]) && predicted[n] > targets[n] + WARM_BY)) warmSeconds += dt;
  }

  const meanDb = (s) => (s.energy > 0 && seconds > 0 ? Math.round(10 * Math.log10(s.energy / seconds) * 10) / 10 : null);

  return {
    observe,
    /** The score so far; dB values are null until a fan turned. */
    report() {
      const dbNow = meanDb(now);
      const dbXenon = meanDb(xenon);
      return {
        minutes: Math.floor(seconds / 60),
        dbNow, dbXenon,
        quieterDb: dbNow != null && dbXenon != null ? Math.round((dbNow - dbXenon) * 10) / 10 : null,
        changesNow: now.changes, changesXenon: xenon.changes,
        warmMinutes: Math.floor(warmSeconds / 60),
      };
    },
    save: () => ({ seconds, warmSeconds, now: { energy: now.energy, changes: now.changes }, xenon: { energy: xenon.energy, changes: xenon.changes } }),
  };
}

module.exports = { createShadow, CHANGE_DB, CHANGE_SPAN_MS, WARM_BY };
