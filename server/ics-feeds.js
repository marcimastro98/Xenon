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

// Building an Intl.DateTimeFormat is far more expensive than using one, and a
// feed can carry thousands of TZID-qualified DTSTART/EXDATE values, so they
// are cached per zone (bounded: zone names come from the feed).
const _dtfCache = new Map();
function _dtfFor(tzid) {
  let dtf = _dtfCache.get(tzid);
  if (dtf) return dtf;
  dtf = new Intl.DateTimeFormat('en-US', {   // throws RangeError on an unknown zone
    timeZone: tzid, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  if (_dtfCache.size >= 64) _dtfCache.clear();
  _dtfCache.set(tzid, dtf);
  return dtf;
}

// Offset (ms) such that local-in-tzid = utc + offset, evaluated at `date`.
function _tzOffsetMs(tzid, date) {
  const dtf = _dtfFor(tzid);
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

// A feed is untrusted input parsed on the event loop. Real calendars stay far
// below these; a hostile one is cut off instead of stalling the server.
const MAX_EVENTS_PER_FEED = 2000;
const MAX_EXDATES_PER_EVENT = 500;

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
      if (events.length >= MAX_EVENTS_PER_FEED) break;
      continue;
    }
    if (!cur) continue;
    if (line.name === 'EXDATE') {
      for (const v of String(line.value).split(',')) {
        if (cur.exdate.length >= MAX_EXDATES_PER_EVENT) break;
        const d = _parseIcsDate(v, line.params);
        if (d && d.iso) cur.exdate.push(d.iso);
      }
    } else if (!cur.props[line.name]) {
      cur.props[line.name] = { value: line.value, params: line.params };
    }
  }
  return events;
}

const _WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const _MAX_OCCURRENCES = 750;  // hard cap on stepping iterations per event
const _MAX_EVENT_RESULTS = 500; // occurrences one event may contribute
const MAX_OCCURRENCES_PER_FEED = 5000;
const MAX_STEPS_PER_FEED = 200000; // candidate dates examined across a whole feed
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

const https = require('https');

// A feed the user set up may live on the home network (a Nextcloud, a
// FreshRSS): the LAN is allowed, this machine and link-local never are.
const { assertPublicOrLanUrl: assertPublicUrl, publicOrLanLookup: publicLookup, armDeadline } = require('./net-guard');

const FETCH_TIMEOUT_MS = 8000;    // idle socket timeout
const FETCH_DEADLINE_MS = 20000;  // whole request; a trickling server can't hold it open
// 1 MB is years of a busy personal calendar; parsing is synchronous, so the
// cap is also what bounds the event-loop time one feed can take.
const MAX_BODY_BYTES = 1024 * 1024;
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
  const budget = { steps: MAX_STEPS_PER_FEED };
  for (const ev of events) {
    if (out.length >= MAX_OCCURRENCES_PER_FEED || budget.steps <= 0) break;
    const occurrences = expandRecurrence(ev, windowStart, windowEnd, budget);
    // Preserve DTSTART→DTEND duration so multi-day events span every day they
    // cover, not just their start day. Recurring occurrences keep that span.
    const allDay = !!(ev.start && ev.start.allDay);
    const startInstant = _instantOf(ev.start);
    const endInstant = ev.end ? _instantOf(ev.end) : null;
    const durMs = (startInstant != null && endInstant != null && endInstant > startInstant)
      ? endInstant - startInstant : 0;
    for (const startsAt of occurrences) {
      if (out.length >= MAX_OCCURRENCES_PER_FEED) break;
      // `allDay` travels with the event. The parser has always known (VALUE=DATE
      // / a bare YYYYMMDD), then dropped the flag here — and a whole-day event is
      // indistinguishable from a midnight one once it is gone, because a one-day
      // all-day event's exclusive DTEND resolves to the SAME day as its start, so
      // endsAt equals startsAt. Without the flag the Upcoming list read "starts
      // 00:00" and retired today's events one minute after midnight.
      out.push({
        id: `ext:${feed.id}:${ev.uid || ev.summary || 'evt'}:${startsAt}`,
        title: ev.summary || '(untitled)',
        notes: ev.description || '',
        startsAt,
        endsAt: _occurrenceEnd(startsAt, allDay, durMs),
        ...(allDay ? { allDay: true } : {}),
        source: feed.id,
        color: feed.color,
        readOnly: true,
      });
    }
  }
  return out;
}

// Fetch one feed over HTTPS with a timeout and a body-size cap. Thin wrapper
// over the conditional fetch with no validators.
function fetchFeedText(url) {
  return fetchFeedConditional(url, null).then(r => (r && r.text) || '');
}

// Conditional GET variant: sends If-None-Match / If-Modified-Since so an unchanged
// feed returns 304 with no body, letting loadFeed skip the re-download AND re-parse.
// Resolves { notModified } on 304, else { notModified:false, text, etag, lastModified }.
// `_hops` guards against redirect loops (each hop opens a socket and restarts
// the timeout). The feed URL and every redirect target must be a public https
// URL, and publicLookup refuses a name that resolves to loopback/LAN space: the
// URL is user-supplied and the request leaves from the user's PC.
function fetchFeedConditional(url, validators, _hops = 0) {
  return new Promise((resolve, reject) => {
    if (_hops > 5) return reject(new Error('too many redirects'));
    try { assertPublicUrl(url); } catch (e) { return reject(e); }
    const headers = {};
    if (validators && validators.etag) headers['If-None-Match'] = validators.etag;
    if (validators && validators.lastModified) headers['If-Modified-Since'] = validators.lastModified;
    let req;
    try { req = https.get(url, { timeout: FETCH_TIMEOUT_MS, headers, lookup: publicLookup }, onResponse); }
    catch (e) { return reject(e); }
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    armDeadline(req, FETCH_DEADLINE_MS);

    function onResponse(res) {
      if (res.statusCode === 304) { res.resume(); return resolve({ notModified: true }); }
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch { return reject(new Error('bad redirect')); }
        return resolve(fetchFeedConditional(next, validators, _hops + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const etag = res.headers.etag || '';
      const lastModified = res.headers['last-modified'] || '';
      let size = 0;
      const chunks = [];
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) { req.destroy(new Error('feed too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ notModified: false, text: Buffer.concat(chunks).toString('utf8'), etag, lastModified }));
      res.on('error', reject);
    }
  });
}

// Per-URL validator + parsed-feed cache so a 304 reuses the last parse (re-mapped
// to the current window). Bounded so a user churning feed URLs can't grow it.
const _condCache = new Map(); // url → { etag, lastModified, parsed }

// Fetch + parse + map a single feed. Never throws; returns a status record.
async function loadFeed(feed) {
  if (!feed || !feed.enabled) return { id: feed && feed.id, status: 'disabled', error: '', events: [], count: 0 };
  const now = Date.now();
  const windowStart = new Date(now - WINDOW_DAYS * 86400000);
  const windowEnd = new Date(now + WINDOW_DAYS * 86400000);
  const parseAndCache = (r) => {
    const p = parseIcs(r.text || '');
    if (_condCache.size > 32) _condCache.clear();    // keep the cache bounded
    _condCache.set(feed.url, { etag: r.etag || '', lastModified: r.lastModified || '', parsed: p });
    return p;
  };
  try {
    const cached = _condCache.get(feed.url);
    const resp = await fetchFeedConditional(feed.url, cached);
    let parsed;
    if (resp.notModified && cached && cached.parsed) {
      parsed = cached.parsed;                        // unchanged upstream → reuse the parse
    } else if (resp.notModified) {
      // 304 without a usable cached parse (a misbehaving host that 304s an
      // unconditional request, or an evicted cache entry): re-fetch unconditionally
      // rather than parse an empty body and silently blank the feed.
      parsed = parseAndCache(await fetchFeedConditional(feed.url, null));
    } else {
      parsed = parseAndCache(resp);
    }
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

// A private iCal link ("secret address" in Google Calendar, a published Outlook
// .ics) IS the credential: anyone holding it reads the whole calendar. So it is
// handled like the API keys — kept on the server, never sent to the browser.
// The wire carries the feed's name, the link's host (so the user can still tell
// feeds apart) and a `urlSet` flag for the "saved" placeholder.
function redactCalendarFeedUrls(settings) {
  if (!settings || typeof settings !== 'object' || !Array.isArray(settings.calendarFeeds)) return settings;
  return {
    ...settings,
    calendarFeeds: settings.calendarFeeds.map((f) => {
      if (!f || typeof f !== 'object') return f;
      const url = String(f.url || '');
      return { ...f, url: '', urlSet: !!url, host: url ? _safeHostname(url) : (f.host || '') };
    }),
  };
}

// The other half: a client that only received the redacted list posts each feed
// back with a blank url. Refill it from the stored feed with the same id, so a
// routine save (renaming a feed, toggling reminders) never drops the link. A
// feed whose url the client did fill in keeps the new one. Mutates and returns
// `incoming`, like the other preserve helpers.
function preserveCalendarFeedUrls(incoming, prev) {
  if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.calendarFeeds)) return incoming;
  const prevFeeds = (prev && typeof prev === 'object' && Array.isArray(prev.calendarFeeds)) ? prev.calendarFeeds : [];
  const byId = new Map();
  for (const f of prevFeeds) if (f && f.id && f.url) byId.set(String(f.id), f.url);
  incoming.calendarFeeds = incoming.calendarFeeds.map((f) => {
    if (!f || typeof f !== 'object' || String(f.url || '').trim()) return f;
    const saved = byId.get(String(f.id || ''));
    return saved ? { ...f, url: saved } : f;
  });
  return incoming;
}

module.exports = {
  _unfold, _parseLine, _parseIcsDate, _tzOffsetMs, _zonedWallToUtcMs,
  parseIcs, expandRecurrence, _occurrenceEnd, mapFeedEvents, fetchFeedText, fetchFeedConditional, loadFeed,
  MAX_EVENTS_PER_FEED, MAX_OCCURRENCES_PER_FEED,
  normalizeCalendarFeeds, redactCalendarFeedUrls, preserveCalendarFeedUrls,
};
