'use strict';

// ── Low-level ICS text parsing (RFC 5545) ──────────────────────────────────

// A CRLF (or LF) followed by a space/tab is a line continuation ("folding").
function _unfold(text) {
  return String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

// Parse "NAME;PARAM=val:VALUE" → { name, params, value }.
function _parseLine(line) {
  const colon = line.indexOf(':');
  if (colon === -1) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = left.split(';');
  const name = parts[0].toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq === -1) continue;
    params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { name, params, value };
}

const _p2 = (n) => String(n).padStart(2, '0');
const _p4 = (n) => String(n).padStart(4, '0');

// Offset (ms) such that local-in-tzid = utc + offset, evaluated at `date`.
function _tzOffsetMs(tzid, date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - date.getTime();
}

// Note: DST fold ambiguity (clocks-fall-back, where a wall time occurs twice)
// is not resolved — the offset at the UTC guess is used as-is. For Google /
// Outlook DTSTART values this is almost always correct; RFC 5545 does not
// mandate disambiguation. Events at the exact fall-back hour may be off by 1h.
function _zonedWallToUtcMs(y, mo, d, h, mi, s, tzid) {
  try {
    const guess = Date.UTC(y, mo, d, h, mi, s);
    const offset = _tzOffsetMs(tzid, new Date(guess));
    return guess - offset;
  } catch { return null; }
}

// Returns { allDay, iso }. iso is either a UTC ISO string (timed) or a
// local naive "YYYY-MM-DDTHH:mm" (all-day / floating) — matching how the
// rest of calendar.js stores startsAt.
function _parseIcsDate(value, params) {
  const v = String(value).trim();
  if ((params && params.VALUE === 'DATE') || /^\d{8}$/.test(v)) {
    return { allDay: true, iso: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00` };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], s = +m[6];
  if (m[7] === 'Z') {
    return { allDay: false, iso: new Date(Date.UTC(y, mo - 1, d, h, mi, s)).toISOString() };
  }
  const tzid = params && params.TZID;
  if (tzid) {
    const ms = _zonedWallToUtcMs(y, mo - 1, d, h, mi, s, tzid);
    if (ms != null) return { allDay: false, iso: new Date(ms).toISOString() };
  }
  return { allDay: false, iso: `${_p4(y)}-${_p2(mo)}-${_p2(d)}T${_p2(h)}:${_p2(mi)}` };
}

// Unescape ICS TEXT values (\\n \, \; \\).
function _unescapeText(v) {
  return String(v)
    .replace(/\\n/gi, '\n').replace(/\\,/g, ',')
    .replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function _finalizeVEvent(raw) {
  const props = raw.props;
  const dtstart = props.DTSTART ? _parseIcsDate(props.DTSTART.value, props.DTSTART.params) : null;
  if (!dtstart || !dtstart.iso) return null; // an event with no usable start is unusable
  const dtend = props.DTEND ? _parseIcsDate(props.DTEND.value, props.DTEND.params) : null;
  return {
    uid: props.UID ? String(props.UID.value).slice(0, 200) : '',
    summary: props.SUMMARY ? _unescapeText(props.SUMMARY.value).slice(0, 200) : '',
    description: props.DESCRIPTION ? _unescapeText(props.DESCRIPTION.value).slice(0, 600) : '',
    start: dtstart,
    end: dtend,
    rrule: props.RRULE ? String(props.RRULE.value) : '',
    exdate: raw.exdate,
  };
}

function parseIcs(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = _unfold(text).split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const raw of lines) {
    if (!raw) continue;
    const line = _parseLine(raw);
    if (!line) continue;
    if (line.name === 'BEGIN' && line.value === 'VEVENT') { cur = { props: {}, exdate: [] }; continue; }
    if (line.name === 'END' && line.value === 'VEVENT') {
      if (cur) { const e = _finalizeVEvent(cur); if (e) events.push(e); }
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (line.name === 'EXDATE') {
      String(line.value).split(',').forEach(v => {
        const d = _parseIcsDate(v, line.params);
        if (d && d.iso) cur.exdate.push(d.iso);
      });
    } else if (!cur.props[line.name]) {
      cur.props[line.name] = { value: line.value, params: line.params };
    }
  }
  return events;
}

const _WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const _MAX_OCCURRENCES = 750; // hard safety cap regardless of window

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
function expandRecurrence(event, windowStart, windowEnd) {
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
  // an empty candidate list until the guard cap.
  const byDaysParsed = rule.BYDAY ? rule.BYDAY.split(',').map(d => _WEEKDAY[d.slice(-2)]).filter(n => n != null) : null;
  const byDays = byDaysParsed && byDaysParsed.length ? byDaysParsed : null;
  const exset = new Set(event.exdate || []);

  const base = new Date(baseMs);
  const baseDay = base.getUTCDate();
  const results = [];
  let produced = 0;
  let cursor = new Date(base.getTime());
  let monthStep = 0; // months added past base, for drift-free MONTHLY stepping

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
    } else if (freq === 'MONTHLY') {
      const dim = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
      candidates = baseDay <= dim ? [new Date(cursor.getTime())] : []; // skip e.g. Feb for a day-31 series
    } else {
      candidates = [new Date(cursor.getTime())];
    }

    for (const c of candidates) {
      const t = c.getTime();
      if (t < base.getTime()) continue;
      if (until != null && t > until) return results;
      if (count != null && produced >= count) return results;
      produced++;
      const iso = emit(t);
      if (t >= winA && t <= winB && !exset.has(iso)) results.push(iso);
      if (count != null && produced >= count) return results;
    }

    // Advance the cursor by one interval of FREQ.
    if (freq === 'DAILY') cursor.setUTCDate(cursor.getUTCDate() + interval);
    else if (freq === 'WEEKLY') cursor.setUTCDate(cursor.getUTCDate() + 7 * interval);
    else if (freq === 'MONTHLY') {
      // Recompute from base by month index so an overflowing month never drags
      // the day forward (Date.setUTCMonth overflows Jan 31 + 1mo → Mar 3).
      monthStep += interval;
      const idx = base.getUTCFullYear() * 12 + base.getUTCMonth() + monthStep;
      const ty = Math.floor(idx / 12);
      const tm = idx % 12;
      const dim = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
      cursor = new Date(Date.UTC(ty, tm, Math.min(baseDay, dim),
        base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds()));
    } else return results; // unsupported FREQ → best-effort: only the base candidates above

    if (cursor.getTime() > winB && (until == null || cursor.getTime() > until)) break;
  }
  return results;
}

const https = require('https');

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB cap per feed
const WINDOW_DAYS = 90;

// Inclusive end for a single occurrence, in the same string flavour as its
// start. `durMs` is the event's span (DTEND − DTSTART); 0 for instant or
// end-less events. All-day DTEND is exclusive per RFC 5545, so the last visible
// day is DTEND − 1 day. Returns startsAt unchanged when there's no real span.
function _occurrenceEnd(startsAt, allDay, durMs) {
  if (!(durMs > 0)) return startsAt;
  if (allDay) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(startsAt);
    if (!m) return startsAt;
    const days = Math.max(1, Math.round(durMs / 86400000)); // exclusive span in days
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]) + (days - 1) * 86400000;
    const d = new Date(t);
    return `${_p4(d.getUTCFullYear())}-${_p2(d.getUTCMonth() + 1)}-${_p2(d.getUTCDate())}T00:00`;
  }
  const startMs = Date.parse(startsAt);
  if (!Number.isFinite(startMs)) return startsAt;
  return new Date(startMs + durMs).toISOString();
}

function mapFeedEvents(events, feed, windowStart, windowEnd) {
  const out = [];
  for (const ev of events) {
    const occurrences = expandRecurrence(ev, windowStart, windowEnd);
    // Preserve DTSTART→DTEND duration so multi-day events span every day they
    // cover, not just their start day. Recurring occurrences keep that span.
    const allDay = !!(ev.start && ev.start.allDay);
    const startInstant = _instantOf(ev.start);
    const endInstant = ev.end ? _instantOf(ev.end) : null;
    const durMs = (startInstant != null && endInstant != null && endInstant > startInstant)
      ? endInstant - startInstant : 0;
    for (const startsAt of occurrences) {
      out.push({
        id: `ext:${feed.id}:${ev.uid || ev.summary || 'evt'}:${startsAt}`,
        title: ev.summary || '(untitled)',
        notes: ev.description || '',
        startsAt,
        endsAt: _occurrenceEnd(startsAt, allDay, durMs),
        source: feed.id,
        color: feed.color,
        readOnly: true,
      });
    }
  }
  return out;
}

// Fetch one feed over HTTPS with a timeout and a body-size cap. `_hops` guards
// against redirect loops (each hop opens a socket and restarts the timeout).
function fetchFeedText(url, _hops = 0) {
  return new Promise((resolve, reject) => {
    if (_hops > 5) return reject(new Error('too many redirects'));
    let req;
    try { req = https.get(url, { timeout: FETCH_TIMEOUT_MS }, onResponse); }
    catch (e) { return reject(e); }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);

    function onResponse(res) {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchFeedText(new URL(res.headers.location, url).toString(), _hops + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { req.destroy(new Error('feed too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }
  });
}

// Fetch + parse + map a single feed. Never throws; returns a status record.
async function loadFeed(feed) {
  if (!feed || !feed.enabled) return { id: feed && feed.id, status: 'disabled', error: '', events: [], count: 0 };
  const now = Date.now();
  const windowStart = new Date(now - WINDOW_DAYS * 86400000);
  const windowEnd = new Date(now + WINDOW_DAYS * 86400000);
  try {
    const text = await fetchFeedText(feed.url);
    const parsed = parseIcs(text);
    const events = mapFeedEvents(parsed, feed, windowStart, windowEnd);
    return { id: feed.id, status: 'ok', error: '', events, count: events.length };
  } catch (e) {
    return { id: feed.id, status: 'error', error: String(e && e.message || e).slice(0, 200), events: [], count: 0 };
  }
}

const MAX_FEEDS = 10;

function _safeHostname(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// Validate and normalize an array of feed config objects coming from settings.
// Enforces https-only URLs, caps at MAX_FEEDS entries, assigns palette colours,
// and provides sensible defaults for optional fields.
function normalizeCalendarFeeds(value, palette) {
  if (!Array.isArray(value)) return [];
  const pal = Array.isArray(palette) && palette.length ? palette : ['#1ed760'];
  const out = [];
  for (const item of value) {
    if (out.length >= MAX_FEEDS) break;
    const src = item && typeof item === 'object' ? item : {};
    const url = String(src.url || '').trim().slice(0, 2048);
    if (!/^https:\/\//i.test(url)) continue; // https only — blocks plain http feeds
    const id = String(src.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 80);
    const name = (String(src.name || '').trim().slice(0, 60)) || _safeHostname(url) || 'Calendar';
    const color = pal.includes(src.color) ? src.color : pal[0];
    out.push({
      id, name, url, color,
      reminders: src.reminders !== false,
      enabled: src.enabled !== false,
    });
  }
  return out;
}

module.exports = {
  _unfold, _parseLine, _parseIcsDate, _tzOffsetMs, _zonedWallToUtcMs,
  parseIcs, expandRecurrence, _occurrenceEnd, mapFeedEvents, fetchFeedText, loadFeed,
  normalizeCalendarFeeds,
};
