import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// All-day events used to vanish from the Upcoming list one minute after
// midnight. Reported from macOS with Google Calendar: "they are not visible,
// for example, when you start your computer in the morning at 9.00."
//
// Two halves of the same omission. The ICS parser has always known an event is
// whole-day (VALUE=DATE / a bare YYYYMMDD) and then dropped the flag on the way
// out, and the list treated every event's 00:00 START as the moment it expires.
// Neither half alone is enough, because a single-day all-day event's exclusive
// DTEND resolves to its own start day — endsAt equals startsAt — so with the
// flag gone there is nothing left to tell it from a midnight appointment.

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const SRC = readFileSync(join(__dirname, '..', 'js', 'calendar.js'), 'utf8').replace(/\r\n/g, '\n');
const ics = require('../ics-feeds.js');

// calendar.js is a browser global script; lift the rule out of the source the
// app actually serves (the state-server-origin idiom used by its sibling tests).
function loadActiveUntil() {
  const start = SRC.indexOf('function eventActiveUntil(');
  assert.ok(start >= 0, 'eventActiveUntil declaration not found');
  const end = SRC.indexOf('\n}\n', start);
  assert.ok(end > start, 'could not find the end of eventActiveUntil');
  return new Function(SRC.slice(start, end + 2) + '; return eventActiveUntil;')();
}
const activeUntil = loadActiveUntil();
const at = (s) => new Date(s).getTime();

test('a whole-day event is still current at 9am', () => {
  // The exact complaint. Its start is 00:00 and its end resolves to the same
  // day, so only the flag can save it.
  const e = { startsAt: '2026-09-14T00:00', endsAt: '2026-09-14T00:00', allDay: true };
  assert.ok(activeUntil(e) > at('2026-09-14T09:00:00'), 'gone by breakfast');
  assert.ok(activeUntil(e) > at('2026-09-14T23:59:00'), 'must last the whole day');
  // ...and gone once the day is actually over.
  assert.ok(activeUntil(e) < at('2026-09-15T00:00:00'), 'must not outlive its day');
});

test('a multi-day event lasts to the end of its LAST day', () => {
  const e = { startsAt: '2026-09-14T00:00', endsAt: '2026-09-16T00:00', allDay: true };
  assert.ok(activeUntil(e) > at('2026-09-16T23:00:00'));
  assert.ok(activeUntil(e) < at('2026-09-17T00:00:00'));
});

test('a timed event is unchanged: it expires at its start', () => {
  // The whole point is that nothing else moves. A 15:00 meeting stops being
  // upcoming at 15:00, exactly as before.
  const e = { startsAt: '2026-09-14T15:00:00', endsAt: '2026-09-14T16:00:00' };
  assert.equal(activeUntil(e), at('2026-09-14T15:00:00'));
  // An event carrying no flag is a timed event, whatever its hour.
  assert.equal(activeUntil({ startsAt: '2026-09-14T00:00' }), at('2026-09-14T00:00'));
});

test('the parser marks whole-day events and the mapper passes the flag on', () => {
  const iso = (d) => d.replace(/[-:]/g, '').slice(0, 8);
  const feed = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:allday-1',
    'SUMMARY:Piotr birthday',
    'DTSTART;VALUE=DATE:' + iso('2026-09-14'),
    'DTEND;VALUE=DATE:' + iso('2026-09-15'),   // exclusive, per RFC 5545
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:timed-1',
    'SUMMARY:Standup',
    'DTSTART:20260914T090000Z',
    'DTEND:20260914T093000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const parsed = ics.parseIcs(feed);
  const mapped = ics.mapFeedEvents(parsed, { id: 'f1', color: '#fff' },
    new Date('2026-09-01T00:00:00'), new Date('2026-09-30T00:00:00'));
  const allDay = mapped.find(e => e.title === 'Piotr birthday');
  const timed = mapped.find(e => e.title === 'Standup');
  assert.ok(allDay, 'the all-day event was not mapped');
  assert.equal(allDay.allDay, true, 'the flag must reach the client');
  // The trap this exists for: a one-day event's inclusive end IS its start, so
  // the flag is the only thing carrying "whole day".
  assert.equal(allDay.endsAt, allDay.startsAt);
  assert.ok(activeUntil(allDay) > at('2026-09-14T09:00:00'), 'still current at 9am');
  // A timed event must not be marked, and the key is absent rather than false.
  assert.ok(!('allDay' in timed), 'timed events carry no flag at all');
});

test('the Upcoming list keeps an event while it is current, not while it starts', () => {
  const fn = SRC.slice(SRC.indexOf('function _buildUpcomingInto('), SRC.indexOf('function renderUpcoming('));
  assert.match(fn, /eventActiveUntil\(e\) >= now - 60000/);
  assert.match(fn, /at < until/, 'the horizon still measures from the START');
  // The lock screen answers the same question and must answer it the same way.
  const lock = readFileSync(join(__dirname, '..', 'js', 'lockscreen.js'), 'utf8');
  assert.match(lock, /eventActiveUntil\(event\) >= now - 60000/);
});

test('a whole-day event says so instead of showing 00:00', () => {
  // Printing its midnight would state the one thing that is not true about it.
  const start = SRC.indexOf('function upcomingWhenLabel(');
  const body = SRC.slice(start, SRC.indexOf('\n}\n', start) + 2);
  const timeParts = (extra) => Object.assign({}, extra || {}, { hour: '2-digit', minute: '2-digit', hour12: false });
  const label = new Function('timeParts', body + '; return upcomingWhenLabel;')(timeParts);
  const NOW = at('2026-09-14T09:00:00');
  assert.equal(label('2026-09-14T00:00', NOW, 'en-GB', 'All day'), 'All day');
  // Unchanged without the label — which is what keeps every timed event as it was.
  assert.equal(label('2026-09-14T18:30:00', NOW, 'en-GB', ''), '18:30');
  // Tomorrow still reads as a distance, all-day or not.
  assert.equal(label('2026-09-16T00:00', NOW, 'en-GB', 'All day'), '2d');
});

test('the label ships in every language, and stays as short as a time', () => {
  const i18n = readFileSync(join(__dirname, '..', 'js', 'i18n.js'), 'utf8');
  const vals = [...i18n.matchAll(/["']?event_all_day["']?\s*:\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
  assert.equal(vals.length, 11, `event_all_day is defined ${vals.length} times, expected 11`);
  // The chip is a grid whose only flexible cell is the NAME, so whatever this
  // label costs is width the title does not get — the very reason the sibling
  // test for this column exists. A time string is about 8 characters; nothing
  // here may be dramatically longer.
  for (const v of vals) {
    assert.ok(v.length <= 12, `"${v}" is ${v.length} chars — it will eat the event title`);
  }
});
