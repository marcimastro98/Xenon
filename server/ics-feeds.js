'use strict';

// ── Low-level ICS text parsing (RFC 5545) ──────────────────────────────────

const {
  _unfold, _parseLine, _p2, _p4, _tzOffsetMs, _zonedWallToUtcMs, _parseIcsDate, MAX_EVENTS_PER_FEED,
  parseIcs,
} = require('./time/ics-parse.js');




const { _instantOf, expandRecurrence } = require('./time/ics-recurrence.js');
const MAX_OCCURRENCES_PER_FEED = 5000;
const MAX_STEPS_PER_FEED = 200000; // candidate dates examined across a whole feed

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

const {
  normalizeCalendarFeeds, redactCalendarFeedUrls, preserveCalendarFeedUrls,
} = require('./time/ics-feed-settings.js');

module.exports = {
  _unfold, _parseLine, _parseIcsDate, _tzOffsetMs, _zonedWallToUtcMs,
  parseIcs, expandRecurrence, _occurrenceEnd, mapFeedEvents, fetchFeedText, fetchFeedConditional, loadFeed,
  MAX_EVENTS_PER_FEED, MAX_OCCURRENCES_PER_FEED,
  normalizeCalendarFeeds, redactCalendarFeedUrls, preserveCalendarFeedUrls,
};
