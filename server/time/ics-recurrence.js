'use strict';
// Works out when a repeating calendar event happens inside a stretch of days, from its RRULE.

const { _p2, _p4, _parseIcsDate } = require('./ics-parse.js');

const _WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const _MAX_OCCURRENCES = 750;  // hard cap on stepping iterations per event
const _MAX_EVENT_RESULTS = 500; // occurrences one event may contribute

const _DAY_MS = 86400000;

function _parseRRule(text) {
  const out = {};
  String(text).split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq === -1) return;
    out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  });
  return out;
}

function _startEpoch(iso) {
  // Both UTC ISO and naive local strings are parseable by Date for stepping.
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

// Absolute instant (ms) for a parsed { allDay, iso } value. All-day values are
// anchored at UTC midnight so that UTC-based stepping and getUTC* readback
// round-trip to the same calendar date regardless of the server's timezone.
function _instantOf(parsed) {
  if (parsed.allDay) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(parsed.iso);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0);
  }
  return _startEpoch(parsed.iso);
}

// Returns an array of ISO start strings (same flavour as event.start.iso) for
// every occurrence that falls within [windowStart, windowEnd].
// `budget` ({ steps }) is optional and shared across one feed's events, so a
// feed full of recurring rules has a fixed total cost, not a per-event one.
function expandRecurrence(event, windowStart, windowEnd, budget) {
  const baseIso = event.start.iso;
  const isAllDay = !!(event.start && event.start.allDay);
  const winA = windowStart.getTime();
  const winB = windowEnd.getTime();

  // Emit an occurrence at instant `t` in the same string flavour as the source
  // event: naive "YYYY-MM-DDT00:00" for all-day, UTC ISO for timed.
  const emit = (t) => {
    if (!isAllDay) return new Date(t).toISOString();
    const d = new Date(t);
    return `${_p4(d.getUTCFullYear())}-${_p2(d.getUTCMonth() + 1)}-${_p2(d.getUTCDate())}T00:00`;
  };

  const baseMs = _instantOf(event.start);
  if (baseMs == null) return [];

  if (!event.rrule) {
    return (baseMs >= winA && baseMs <= winB) ? [baseIso] : [];
  }

  const rule = _parseRRule(event.rrule);
  const freq = rule.FREQ;
  const interval = Math.max(1, parseInt(rule.INTERVAL, 10) || 1);
  const count = rule.COUNT ? parseInt(rule.COUNT, 10) : null;
  const untilParsed = rule.UNTIL ? _parseIcsDate(rule.UNTIL, {}) : null;
  const until = untilParsed ? _instantOf(untilParsed) : null;
  // Unknown BYDAY codes are dropped; if none survive, treat BYDAY as absent so
  // WEEKLY falls back to the DTSTART weekday (RFC 5545) instead of looping over
  // an empty candidate list until the guard cap. Duplicates are dropped too
  // ("MO,MO,MO…" would otherwise multiply the work per step), leaving ≤ 7.
  const byDaysParsed = rule.BYDAY
    ? [...new Set(rule.BYDAY.split(',').slice(0, 64).map(d => _WEEKDAY[d.slice(-2)]).filter(n => n != null))]
    : null;
  const byDays = byDaysParsed && byDaysParsed.length ? byDaysParsed : null;
  const exset = new Set(event.exdate || []);

  // YEARLY is MONTHLY with a 12-month stride (same month, same day; a Feb 29
  // series skips non-leap years, as RFC 5545 requires).
  const monthly = freq === 'MONTHLY' || freq === 'YEARLY';
  const monthStride = freq === 'YEARLY' ? 12 * interval : interval;

  const base = new Date(baseMs);
  const baseDay = base.getUTCDate();
  const results = [];
  let produced = 0;
  let cursor = new Date(base.getTime());
  let monthStep = 0; // months added past base, for drift-free MONTHLY stepping

  const monthCursor = () => {
    const idx = base.getUTCFullYear() * 12 + base.getUTCMonth() + monthStep;
    const ty = Math.floor(idx / 12);
    const tm = idx % 12;
    const dim = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    return new Date(Date.UTC(ty, tm, Math.min(baseDay, dim),
      base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds()));
  };

  // Jump close to the window instead of walking from DTSTART: a daily rule
  // that began ten years ago would otherwise spend its whole step cap before
  // reaching today (and show nothing). Whole periods are skipped, so the
  // pattern stays aligned to DTSTART exactly as if we had stepped. One period
  // of margin is kept. With COUNT the skipped occurrences must still be
  // counted, which is only exact when every period yields the same number:
  // DAILY, WEEKLY, and MONTHLY/YEARLY on a day every month has (≤ 28).
  if (baseMs < winA && (freq === 'DAILY' || freq === 'WEEKLY' || monthly)) {
    const perPeriod = freq === 'WEEKLY' && byDays ? byDays.length : 1;
    const exactCount = count == null || !monthly || baseDay <= 28;
    if (exactCount) {
      let k;
      if (monthly) {
        const a = new Date(winA);
        const months = (a.getUTCFullYear() * 12 + a.getUTCMonth()) - (base.getUTCFullYear() * 12 + base.getUTCMonth());
        k = Math.max(0, Math.floor(months / monthStride) - 1);
      } else {
        const periodMs = (freq === 'DAILY' ? 1 : 7) * interval * _DAY_MS;
        k = Math.max(0, Math.floor((winA - baseMs) / periodMs) - 1);
      }
      if (count != null && k * perPeriod >= count) return results; // series ended before the window
      if (k > 0) {
        produced = k * perPeriod;
        if (monthly) { monthStep = k * monthStride; cursor = monthCursor(); }
        else cursor = new Date(baseMs + k * (freq === 'DAILY' ? 1 : 7) * interval * _DAY_MS);
      }
    }
  }

  for (let guard = 0; guard < _MAX_OCCURRENCES; guard++) {
    // Candidate instants for this step. BYDAY expands a weekly step to many
    // days; MONTHLY yields no candidate in months that lack the base day.
    let candidates;
    if (freq === 'WEEKLY' && byDays) {
      candidates = byDays.map(dow => {
        const c = new Date(cursor.getTime());
        const diff = (dow - c.getUTCDay() + 7) % 7;
        c.setUTCDate(c.getUTCDate() + diff);
        return c;
      }).sort((a, b) => a - b);
    } else if (monthly) {
      const dim = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
      candidates = baseDay <= dim ? [new Date(cursor.getTime())] : []; // skip e.g. Feb for a day-31 series
    } else {
      candidates = [new Date(cursor.getTime())];
    }

    if (budget) {
      budget.steps -= candidates.length + 1;
      if (budget.steps < 0) return results;
    }

    for (const c of candidates) {
      const t = c.getTime();
      if (t < base.getTime()) continue;
      if (until != null && t > until) return results;
      if (count != null && produced >= count) return results;
      produced++;
      const iso = emit(t);
      if (t >= winA && t <= winB && !exset.has(iso)) {
        results.push(iso);
        if (results.length >= _MAX_EVENT_RESULTS) return results;
      }
      if (count != null && produced >= count) return results;
    }

    // Advance the cursor by one interval of FREQ.
    if (freq === 'DAILY') cursor.setUTCDate(cursor.getUTCDate() + interval);
    else if (freq === 'WEEKLY') cursor.setUTCDate(cursor.getUTCDate() + 7 * interval);
    else if (monthly) {
      // Recompute from base by month index so an overflowing month never drags
      // the day forward (Date.setUTCMonth overflows Jan 31 + 1mo → Mar 3).
      monthStep += monthStride;
      cursor = monthCursor();
    } else return results; // unsupported FREQ → best-effort: only the base candidates above

    // Every later candidate is at or after the cursor, so once it passes the
    // window end nothing more can land in the window.
    if (cursor.getTime() > winB) break;
  }
  return results;
}

module.exports = {
  _WEEKDAY, _MAX_OCCURRENCES, _MAX_EVENT_RESULTS, _DAY_MS, _parseRRule, _startEpoch, _instantOf,
  expandRecurrence,
};
