'use strict';

// Opt-in anonymous version ping.
//
// The project's promise is that the app ships no telemetry, and that stays
// true: this is OFF unless the user turns it on in Settings → Generale →
// Aggiornamenti (`settings-version-ping` in index.html), and it
// exists to answer questions the maintainer otherwise cannot — how many installs
// are still running an old release, how many are active in a given week, and
// whether the people on an old version upgraded or simply stopped.
//
// Four constraints keep it honest, and each is deliberate:
//
//   1. NO new network call. The ping rides the update check the app already
//      performs (server.js, /update/check), so enabling the setting never makes
//      the app contact something it was not contacting already.
//   2. NO install id. `supporter-redeem.getInstallId` exists and would be
//      trivial to attach — that is exactly why it must not be. It is reserved
//      for ratings and supporter codes; sending it here would make usage
//      correlatable with purchases. Everything below is a coarse bucket or a
//      boolean, and the hub counts each in its own table so the combination is
//      never stored either.
//   3. AT MOST once per UTC day per install, remembered in DATA_DIR. The day is
//      recorded BEFORE the request goes out, so a network failure costs one
//      attempt rather than one attempt per dashboard load.
//   4. Fire-and-forget. It never delays, fails, or alters the update check.
//
// PROTOCOL 2 adds cohort fields. Two of them are worth explaining here because
// the reasoning is not obvious from the code:
//
//   * newWeek / newMonth replace the identifier. Counting DISTINCT installs over
//     a week normally needs an id, so the server can tell two pings from one PC
//     from two pings from two PCs. Instead this file remembers, on the user's own
//     disk, the last week and month it reported, and says "first time this week"
//     once. The hub adds 1 and decides WHICH week that was — a wrong clock here
//     can therefore never invent a period and split a counter.
//
//     * `born` is only ever 'known' when the install was observed being created:
//     settings.json absent as the PROCESS started (see server.js), which is
//     evidence independent of anything in this file. On its own, a missing or
//     unreadable state file never mints a birth — an install that has existed for
//     two years and enables the switch today must not be counted as born today,
//     because that is the one error that would corrupt the retention curve
//     silently and permanently. Under-counting births is the recoverable
//     direction, so that is the direction this errs in.
//
// If any of those change, docs/privacy.html must change in the same commit —
// that page describes this file's behaviour to users in plain language.

const https = require('https');
const path = require('path');
const fsp = require('fs').promises;
const { writeFileAtomic } = require('./atomic-write');
const { HUB_BASE } = require('./supporter-redeem');

const FETCH_TIMEOUT_MS = 6000;
const MAX_RESPONSE_BYTES = 4 * 1024;
const STATE_BASENAME = 'version-ping.json';
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

let _transport = postJson;   // swappable for tests
let _inflight = null;        // concurrent dashboard loads collapse to one attempt

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

function postJson(url, body) {
  return new Promise((resolve) => {
    if (!/^https:\/\//i.test(url)) return resolve({ ok: false, error: 'network' });
    const payload = JSON.stringify(body);
    let req;
    try {
      req = https.request(url, {
        method: 'POST',
        timeout: FETCH_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, onResponse);
    } catch {
      return resolve({ ok: false, error: 'network' });
    }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ ok: false, error: 'network' }));
    req.end(payload);

    function onResponse(res) {
      // A redirect on this POST would mean the hub URL moved under us; treat it
      // as a failure rather than re-sending the payload somewhere unverified.
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return resolve({ ok: false, error: 'network' });
      }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) { req.destroy(new Error('body too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve({ ok: false, error: 'network' }); }
      });
      res.on('error', () => resolve({ ok: false, error: 'network' }));
    }
  });
}

// Missing, corrupt, half-written or written by a newer build: every one of these
// resolves to a usable state and none of them throws. A field of the wrong shape
// costs that field alone, and it repairs itself on the next confirmed ping.
async function readState(dataDir, { fresh = false } = {}) {
  const blank = { v: PROTOCOL, day: '', first: '', born: 'unknown', week: '', month: '', version: '' };
  let parsed = null;
  try {
    parsed = JSON.parse(await fsp.readFile(path.join(dataDir, STATE_BASENAME), 'utf8'));
  } catch {
    // No file at all. This is a birth ONLY if the process also started without a
    // settings.json — otherwise it is an old install whose owner just switched
    // the setting on, or one whose state file was lost, and neither is new.
    return { ...blank, born: fresh ? 'known' : 'unknown' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...blank };

  const str = (v, re) => (typeof v === 'string' && (!re || re.test(v)) ? v : '');
  const day = str(parsed.day, DAY_RE);
  return {
    ...parsed,
    v: Number(parsed.v) || 1,
    day,
    // A v1 file ({"day": "…"}) carries no birth, so its cohort is unknown
    // forever. `first` is kept as information, never promoted to a birth.
    first: str(parsed.first, DAY_RE) || day,
    born: parsed.born === 'known' ? 'known' : 'unknown',
    week: str(parsed.week, WEEK_RE),
    month: str(parsed.month, MONTH_RE),
    version: str(parsed.version, VERSION_RE),
  };
}

async function writeState(dataDir, state) {
  await writeFileAtomic(path.join(dataDir, STATE_BASENAME), JSON.stringify(state));
}

// Returns a small result object describing what happened. Callers ignore it in
// production; the tests read it, which is why it is not just a boolean.
async function maybePing({
  dataDir, version, enabled,
  os = process.platform,
  day = utcDay(),
  fresh = false,
  lang = '',
}) {
  if (enabled !== true) return { ok: false, skipped: 'disabled' };
  if (!VERSION_RE.test(String(version || ''))) return { ok: false, skipped: 'bad_version' };
  if (_inflight) return _inflight;

  _inflight = (async () => {
    const state = await readState(dataDir, { fresh });
    if (state.day === day) return { ok: false, skipped: 'already_sent' };

    // Resolved BEFORE the body is built: on a fresh install the state file does
    // not exist yet, so `first` is today — and buildPingBody needs it to be set
    // or a genuinely new install would report cohort 'unknown' on its first day,
    // which is the one day it can be certain about.
    const first = state.first || day;
    const body = buildPingBody({ state: { ...state, first }, version, os, day, lang });

    // TWO WRITES, TWO MEANINGS, and the split is the point. `day` is the
    // THROTTLE, so it is recorded before the request goes out — constraint 3.
    // The period flags are a COUNT, so they are only consumed once the hub has
    // actually taken them: burning newMonth on a failed POST would lose a
    // monthly active for the whole month, and no retry could recover it.
    try {
      await writeState(dataDir, { ...state, v: PROTOCOL, day, first });
    } catch {
      return { ok: false, skipped: 'state_unwritable' };
    }

    const out = await _transport(HUB_BASE + '/version/ping', body);
    if (!out || out.ok !== true) return { ok: false, error: 'network' };

    try {
      await writeState(dataDir, nextState({ state, body, version, day, first }));
    } catch {
      // The ping landed. At worst a flag is sent twice tomorrow, which
      // over-counts by one — far cheaper than losing the count entirely.
    }
    return { ok: true };
  })();

  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

module.exports = {
  maybePing,
  utcDay,
  isoWeek,
  ageBucket,
  buildPingBody,
  _setTransport(fn) { _transport = fn || postJson; },
};
