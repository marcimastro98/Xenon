'use strict';
// Vitals math shared by the dashboard (js/vitals.js) and the server (Bit's
// vitals tools in server.js): how full a meter is, what one refill writes, and
// what Bit is told about it. One formula, so Bit never reads a different bar
// than the one on the screen. Pure: the clock and the settings come in.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.VitalsCore = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const IDS = Object.freeze(['hydration', 'energy', 'stamina', 'focus', 'posture']);
  const XP_PER_FILL = 25;
  const XP_PER_LEVEL = 100;

  function dayKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  const span = (v, id) => Math.max(5, Number(v && v.items && v.items[id] && v.items[id].min) || 60) * 60000;
  const lastOf = (v, id) => Number(v && v.state && v.state.last && v.state.last[id]) || 0;

  // 1 = just refilled, 0 = empty. Never refilled reads as full.
  function level(v, id, now) {
    const last = lastOf(v, id);
    if (!last) return 1;
    return Math.min(1, Math.max(0, 1 - (now - last) / span(v, id)));
  }

  const xpLevel = (xp) => 1 + Math.floor((Number(xp) || 0) / XP_PER_LEVEL);

  // The days back a refill may land and still keep the streak going: yesterday,
  // or the day before. One missed day is forgiven; streaks that break on a
  // single slip make people give up rather than come back.
  const STREAK_GRACE_DAYS = 2;
  function streakContinues(lastFillDay, now) {
    for (let back = 1; back <= STREAK_GRACE_DAYS; back++) {
      const d = new Date(now);
      d.setDate(d.getDate() - back);
      if (lastFillDay === dayKey(d)) return true;
    }
    return false;
  }

  // The state fields one refill of `id` writes, plus what it unlocked. The
  // first refill of a new day extends the daily streak, or restarts it.
  function refillPatch(v, id, now) {
    const state = (v && v.state) || {};
    const date = new Date(now);
    const day = dayKey(date);
    const sameDay = state.day === day;
    const xp = (Number(state.xp) || 0) + XP_PER_FILL;
    const mem = state.mem && typeof state.mem === 'object' ? state.mem : {};
    const lastFillDay = typeof mem.lastFillDay === 'string' ? mem.lastFillDay : '';
    let streak = Number(mem.streak) || 0;
    let streakUp = 0;
    if (lastFillDay !== day) {
      streak = streakContinues(lastFillDay, now) ? streak + 1 : 1;
      if (streak >= 2) streakUp = streak;
    }
    const patch = {
      last: { ...(state.last || {}), [id]: now },
      xp,
      day,
      fills: (sameDay ? Number(state.fills) || 0 : 0) + 1,
      log: (sameDay && Array.isArray(state.log) ? state.log : []).concat(id),
      mem: { ...mem, streak, bestStreak: Math.max(Number(mem.bestStreak) || 0, streak), lastFillDay: day },
    };
    return { patch, streakUp, levelUp: xpLevel(xp) > xpLevel(state.xp) ? xpLevel(xp) : 0 };
  }

  // What Bit reads: each meter that is on, how full, and when it runs out.
  function snapshot(v, now) {
    const items = (v && v.items) || {};
    const state = (v && v.state) || {};
    const mem = state.mem || {};
    const meters = IDS.filter((id) => items[id] && items[id].on !== false).map((id) => {
      const lv = level(v, id, now);
      return { id, percent: Math.round(lv * 100), everyMinutes: span(v, id) / 60000, emptyInMinutes: Math.round(lv * span(v, id) / 60000) };
    });
    const today = dayKey(new Date(now));
    return {
      enabled: !!(v && v.enabled !== false),
      meters,
      level: xpLevel(state.xp),
      refillsToday: state.day === today ? Number(state.fills) || 0 : 0,
      streakDays: Number(mem.streak) || 0,
      bestStreakDays: Number(mem.bestStreak) || 0,
    };
  }

  // Bit's truce (state.pet): 'snooze' = 30 minutes of quiet, 'today' = quiet
  // until midnight, 'resume' = both lifted.
  const SNOOZE_MS = 30 * 60000;
  function truce(statePet, mode, now) {
    const cur = statePet && typeof statePet === 'object' ? statePet : {};
    if (mode === 'snooze') return { ...cur, snoozeUntil: now + SNOOZE_MS };
    if (mode === 'today') return { ...cur, muteDay: dayKey(new Date(now)) };
    if (mode === 'resume') return { ...cur, snoozeUntil: 0, muteDay: '' };
    return null;
  }

  // Time at the computer today: the span since the last step counts unless the
  // user was away (the meters' own freeze, `frozenAt`) or the gap is longer
  // than any live tick (the PC slept). A new day starts from zero.
  const ACTIVE_GAP_MS = 10 * 60000;
  function activeStep(prev, now, frozenAt) {
    const day = dayKey(new Date(now));
    const p = prev && prev.day === day ? prev : { day, ms: 0, at: now };
    const until = frozenAt > 0 && frozenAt < now ? frozenAt : now;
    const gap = until - (Number(p.at) || now);
    return { day, ms: (Number(p.ms) || 0) + (gap > 0 && gap <= ACTIVE_GAP_MS ? gap : 0), at: now };
  }

  return { IDS, XP_PER_FILL, XP_PER_LEVEL, SNOOZE_MS, dayKey, level, xpLevel, refillPatch, snapshot, truce, activeStep };
});
