'use strict';

// ── Greeting facts ───────────────────────────────────────────────────────────
// The line under the greeting says something true about the day instead of a
// pleasantry: how many events are left today, or when the next one is. No
// calendar events, no line. Pure: events and a clock in, an i18n key and its
// variables out (js/greeting.js turns them into words).
(function () {
  const NIGHT_UNTIL_HOUR = 5; // 00:00-04:59 still belongs to "today" for the calendar

  function startsOn(events, day, after) {
    const out = [];
    for (const ev of Array.isArray(events) ? events : []) {
      if (!ev || !ev.startsAt || !ev.title) continue;
      const starts = new Date(ev.startsAt);
      if (Number.isNaN(starts.getTime())) continue;
      if (starts.toDateString() !== day.toDateString()) continue;
      if (after && starts <= after) continue;
      out.push(starts);
    }
    return out.sort((a, b) => a - b);
  }

  function counted(list, one, many, fmt) {
    if (!list.length) return null;
    return { key: list.length === 1 ? one : many, vars: { n: list.length, time: fmt.format(list[0]) } };
  }

  /**
   * @param {'morning'|'afternoon'|'evening'|'night'} part
   * @param {Array<{startsAt: string, title: string}>} events  the dashboard's calendar events
   * @param {Date} now
   * @param {{ format(d: Date): string }} fmt  the clock-time formatter of the dashboard language
   * @returns {{ key: string, vars: { n: number, time: string } } | null}
   */
  function pick(part, events, now, fmt) {
    const today = () => startsOn(events, now, now);
    const tomorrow = () => startsOn(events, new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1), null);
    if (part === 'afternoon') {
      const next = today();
      return next.length ? { key: 'greet_fact_next', vars: { n: next.length, time: fmt.format(next[0]) } } : null;
    }
    if (part === 'morning' || (part === 'night' && now.getHours() < NIGHT_UNTIL_HOUR)) {
      return counted(today(), 'greet_fact_today_one', 'greet_fact_today_many', fmt);
    }
    return counted(tomorrow(), 'greet_fact_tomorrow_one', 'greet_fact_tomorrow_many', fmt);
  }

  window.GreetingFacts = { pick };
})();
