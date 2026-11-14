'use strict';
// What the anonymous version ping says and what is remembered of it: the day and week in UTC,
// the install's age as a bucket, the body sent, and the state kept after a ping.

const PROTOCOL = 2;
// Mirrors VERSION_RE in the hub: refuse to send anything that is not plainly a
// version string, so a malformed package.json can never fragment the counters.
const VERSION_RE = /^\d{1,3}(?:\.\d{1,4}){0,3}(?:-[0-9a-z][0-9a-z.]{0,19})?$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
// Same reasoning as VERSION_RE, for the same kind of accident: a hand-edited
// settings blob must not fragment a hub counter with a locale we do not ship.
const LANG_SET = new Set(['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']);

function utcDay(at = Date.now()) {
  return new Date(at).toISOString().slice(0, 10);
}

// ISO week-numbering key, 'YYYY-Www'. The Thursday of the week decides the year,
// so 2025-12-29 is 2026-W01 and 2027-01-01 is 2026-W53. Zero-padded, which makes
// the keys sort lexicographically — the monotonic rule below depends on it.
function isoWeek(day) {
  const d = new Date(day + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return year + '-W' + String(week).padStart(2, '0');
}

// Five buckets, because the question is "do people stay past the first week",
// not "exactly how old is this install". A clock that went backwards returns ''
// and the caller reports 'unknown' rather than a wrong bucket.
function ageBucket(firstDay, day) {
  if (!DAY_RE.test(firstDay || '') || !DAY_RE.test(day || '')) return '';
  const days = Math.round(
    (Date.parse(day + 'T00:00:00Z') - Date.parse(firstDay + 'T00:00:00Z')) / 86400000
  );
  if (!Number.isFinite(days) || days < 0) return '';
  if (days === 0) return 'd0';
  if (days <= 7) return 'd1_7';
  if (days <= 30) return 'd8_30';
  if (days <= 90) return 'd31_90';
  return 'd90p';
}

// Pure: state + facts → the exact object that goes on the wire. No disk, no
// clock, no network, so the DECISION is testable on its own — the same shape
// remote-access.js uses for its gate.
function buildPingBody({ state, version, os, day, lang }) {
  const st = state || {};
  const body = {
    pv: PROTOCOL,
    version: String(version),
    os: String(os),
    cohort: 'unknown',
    age: 'unknown',
  };

  // Only an OBSERVED birth produces a cohort. See note 2 in the header.
  if (st.born === 'known' && DAY_RE.test(st.first || '')) {
    body.cohort = st.first.slice(0, 7);
    body.age = ageBucket(st.first, day) || 'unknown';
  }

  // Strictly forward ('>' and not '!=='): a clock that went backwards costs one
  // missed count, never a duplicated one, which is the only direction an error
  // may take in a counter of distinct things.
  const week = isoWeek(day);
  if (week && week > String(st.week || '')) body.newWeek = true;
  const month = day.slice(0, 7);
  if (MONTH_RE.test(month) && month > String(st.month || '')) body.newMonth = true;

  // Sent once, on the first ping after the version changed. Never on the very
  // first ping of a fresh install: there is no previous version to report.
  if (st.version && st.version !== body.version && VERSION_RE.test(st.version)) {
    body.from = st.version;
  }
  if (LANG_SET.has(String(lang || ''))) body.lang = String(lang);

  return body;
}

// Pure: what the state file should look like once a ping was CONFIRMED.
function nextState({ state, body, version, day, first }) {
  const st = state || {};
  return {
    // Unknown keys survive: a downgrade after an upgrade must not destroy the
    // one field that cannot be recovered, and forward compatibility is free.
    ...st,
    v: PROTOCOL,
    day,
    first,
    born: st.born === 'known' ? 'known' : 'unknown',
    // Only advance a period once the hub actually took the count.
    week: body.newWeek ? isoWeek(day) : (st.week || ''),
    month: body.newMonth ? day.slice(0, 7) : (st.month || ''),
    version: String(version),
  };
}

module.exports = {
  PROTOCOL, VERSION_RE, DAY_RE, WEEK_RE, MONTH_RE, LANG_SET, utcDay, isoWeek, ageBucket,
  buildPingBody, nextState,
};
