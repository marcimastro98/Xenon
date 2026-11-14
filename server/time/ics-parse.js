'use strict';
// Reads the text of an iCalendar file (RFC 5545) into events: folded lines, dates with their
// time zone, escaped text.

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

module.exports = {
  _unfold, _parseLine, _p2, _p4, _dtfCache, _dtfFor, _tzOffsetMs, _zonedWallToUtcMs, _parseIcsDate,
  _unescapeText, _finalizeVEvent, MAX_EVENTS_PER_FEED, MAX_EXDATES_PER_EVENT, parseIcs,
};
