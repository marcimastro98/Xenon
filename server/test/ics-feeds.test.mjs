import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ics = require('../ics-feeds.js');

test('unfold joins RFC5545 folded lines', () => {
  assert.equal(ics._unfold('DESC:Hello\r\n  World'), 'DESC:Hello World');
});

test('parseLine splits name, params and value', () => {
  const l = ics._parseLine('DTSTART;TZID=Europe/Rome:20260603T090000');
  assert.equal(l.name, 'DTSTART');
  assert.equal(l.params.TZID, 'Europe/Rome');
  assert.equal(l.value, '20260603T090000');
});

test('parseIcsDate handles all-day, UTC and floating', () => {
  assert.deepEqual(ics._parseIcsDate('20260603', { VALUE: 'DATE' }),
    { allDay: true, iso: '2026-06-03T00:00' });
  assert.deepEqual(ics._parseIcsDate('20260603T090000Z', {}),
    { allDay: false, iso: new Date(Date.UTC(2026, 5, 3, 9, 0, 0)).toISOString() });
  assert.deepEqual(ics._parseIcsDate('20260603T090000', {}),
    { allDay: false, iso: '2026-06-03T09:00' });
});

test('parseIcsDate converts TZID wall time to a UTC instant', () => {
  // Europe/Rome is UTC+2 in June (DST) → 09:00 local == 07:00Z
  const r = ics._parseIcsDate('20260603T090000', { TZID: 'Europe/Rome' });
  assert.equal(r.allDay, false);
  assert.equal(r.iso, new Date(Date.UTC(2026, 5, 3, 7, 0, 0)).toISOString());
});

const SAMPLE = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:abc-123',
  'SUMMARY:Stand-up',
  'DESCRIPTION:Daily sync',
  'DTSTART:20260603T090000Z',
  'DTEND:20260603T093000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:no-start',
  'SUMMARY:Broken',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('parseIcs extracts VEVENTs and drops events without a start', () => {
  const events = ics.parseIcs(SAMPLE);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.uid, 'abc-123');
  assert.equal(e.summary, 'Stand-up');
  assert.equal(e.description, 'Daily sync');
  assert.equal(e.start.iso, new Date(Date.UTC(2026, 5, 3, 9, 0, 0)).toISOString());
});

test('parseIcs never throws on malformed input', () => {
  assert.deepEqual(ics.parseIcs('not a calendar'), []);
  assert.deepEqual(ics.parseIcs(''), []);
  assert.deepEqual(ics.parseIcs(null), []);
});

test('expandRecurrence: non-recurring event returns itself if in window', () => {
  const [e] = ics.parseIcs(SAMPLE);
  const start = new Date(Date.UTC(2026, 5, 1));
  const end = new Date(Date.UTC(2026, 5, 30));
  const occ = ics.expandRecurrence(e, start, end);
  assert.equal(occ.length, 1);
  assert.equal(occ[0], e.start.iso);
});

test('expandRecurrence: weekly with COUNT yields bounded occurrences', () => {
  const [e] = ics.parseIcs([
    'BEGIN:VEVENT', 'UID:w', 'SUMMARY:Weekly',
    'DTSTART:20260601T080000Z',
    'RRULE:FREQ=WEEKLY;COUNT=3',
    'END:VEVENT',
  ].join('\r\n'));
  const occ = ics.expandRecurrence(e, new Date(Date.UTC(2026, 4, 1)), new Date(Date.UTC(2026, 7, 1)));
  assert.equal(occ.length, 3);
  assert.equal(occ[0], new Date(Date.UTC(2026, 5, 1, 8, 0, 0)).toISOString());
  assert.equal(occ[1], new Date(Date.UTC(2026, 5, 8, 8, 0, 0)).toISOString());
  assert.equal(occ[2], new Date(Date.UTC(2026, 5, 15, 8, 0, 0)).toISOString());
});

test('expandRecurrence: daily honours UNTIL and window clamp', () => {
  const [e] = ics.parseIcs([
    'BEGIN:VEVENT', 'UID:d', 'SUMMARY:Daily',
    'DTSTART:20260601T080000Z',
    'RRULE:FREQ=DAILY;UNTIL=20260605T080000Z',
    'END:VEVENT',
  ].join('\r\n'));
  const occ = ics.expandRecurrence(e, new Date(Date.UTC(2026, 5, 3)), new Date(Date.UTC(2026, 5, 30)));
  // Window starts Jun 3, UNTIL is Jun 5 → Jun 3, 4, 5
  assert.equal(occ.length, 3);
});

test('expandRecurrence: EXDATE removes a matching occurrence', () => {
  const [e] = ics.parseIcs([
    'BEGIN:VEVENT', 'UID:x', 'SUMMARY:Daily',
    'DTSTART:20260601T080000Z',
    'RRULE:FREQ=DAILY;COUNT=3',
    'EXDATE:20260602T080000Z',
    'END:VEVENT',
  ].join('\r\n'));
  const occ = ics.expandRecurrence(e, new Date(Date.UTC(2026, 4, 1)), new Date(Date.UTC(2026, 7, 1)));
  assert.equal(occ.length, 2); // Jun 1 and Jun 3, Jun 2 excluded
});

test('mapFeedEvents produces widget-shaped, read-only events with stable ids', () => {
  const events = ics.parseIcs(SAMPLE);
  const feed = { id: 'feed1', color: '#1ed760' };
  const start = new Date(Date.UTC(2026, 5, 1));
  const end = new Date(Date.UTC(2026, 5, 30));
  const mapped = ics.mapFeedEvents(events, feed, start, end);
  assert.equal(mapped.length, 1);
  const m = mapped[0];
  assert.equal(m.source, 'feed1');
  assert.equal(m.color, '#1ed760');
  assert.equal(m.readOnly, true);
  assert.equal(m.title, 'Stand-up');
  assert.ok(m.id.startsWith('ext:feed1:abc-123:'));
  // startsAt must be the exact UTC ISO of the source DTSTART, not just truthy.
  assert.equal(m.startsAt, new Date(Date.UTC(2026, 5, 3, 9, 0, 0)).toISOString());
});

test('expandRecurrence: weekly BYDAY expands to each named weekday', () => {
  const [e] = ics.parseIcs([
    'BEGIN:VEVENT', 'UID:by', 'SUMMARY:MWF',
    'DTSTART:20260601T080000Z', // 2026-06-01 is a Monday
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=3',
    'END:VEVENT',
  ].join('\r\n'));
  const occ = ics.expandRecurrence(e, new Date(Date.UTC(2026, 4, 1)), new Date(Date.UTC(2026, 7, 1)));
  assert.equal(occ.length, 3); // Mon Jun 1, Wed Jun 3, Fri Jun 5
  assert.equal(occ[0], new Date(Date.UTC(2026, 5, 1, 8, 0, 0)).toISOString());
  assert.equal(occ[1], new Date(Date.UTC(2026, 5, 3, 8, 0, 0)).toISOString());
  assert.equal(occ[2], new Date(Date.UTC(2026, 5, 5, 8, 0, 0)).toISOString());
});

test('expandRecurrence: all-day recurring events emit naive YYYY-MM-DDT00:00', () => {
  const [e] = ics.parseIcs([
    'BEGIN:VEVENT', 'UID:ad', 'SUMMARY:All day',
    'DTSTART;VALUE=DATE:20260601',
    'RRULE:FREQ=DAILY;COUNT=3',
    'END:VEVENT',
  ].join('\r\n'));
  const occ = ics.expandRecurrence(e, new Date(Date.UTC(2026, 4, 1)), new Date(Date.UTC(2026, 7, 1)));
  assert.deepEqual(occ, ['2026-06-01T00:00', '2026-06-02T00:00', '2026-06-03T00:00']);
});

test('expandRecurrence: all-day EXDATE removes the matching occurrence', () => {
  const [e] = ics.parseIcs([
    'BEGIN:VEVENT', 'UID:adx', 'SUMMARY:All day',
    'DTSTART;VALUE=DATE:20260601',
    'RRULE:FREQ=DAILY;COUNT=3',
    'EXDATE;VALUE=DATE:20260602',
    'END:VEVENT',
  ].join('\r\n'));
  const occ = ics.expandRecurrence(e, new Date(Date.UTC(2026, 4, 1)), new Date(Date.UTC(2026, 7, 1)));
  assert.deepEqual(occ, ['2026-06-01T00:00', '2026-06-03T00:00']);
});

test('expandRecurrence: MONTHLY skips months without the base day (no clamp)', () => {
  const [e] = ics.parseIcs([
    'BEGIN:VEVENT', 'UID:m31', 'SUMMARY:Day 31',
    'DTSTART:20260131T090000Z', // Jan 31
    'RRULE:FREQ=MONTHLY;COUNT=3',
    'END:VEVENT',
  ].join('\r\n'));
  const occ = ics.expandRecurrence(e, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 11, 31)));
  // Feb (28d), Apr, Jun... lack a 31st and are skipped; first three valid are
  // Jan 31, Mar 31, May 31. February must NOT appear as Mar 2/3.
  assert.equal(occ[0], new Date(Date.UTC(2026, 0, 31, 9, 0, 0)).toISOString());
  assert.equal(occ[1], new Date(Date.UTC(2026, 2, 31, 9, 0, 0)).toISOString());
  assert.equal(occ[2], new Date(Date.UTC(2026, 4, 31, 9, 0, 0)).toISOString());
});

// ── Task 5: normalizeCalendarFeeds ───────────────────────────────────────────

const PALETTE = ['#1ed760', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7'];

test('normalizeCalendarFeeds enforces https, palette, caps and defaults', () => {
  const input = [
    { id: 'a', name: 'Work', url: 'https://example.com/a.ics', color: '#3b82f6' },
    { id: 'b', name: '', url: 'http://insecure.com/b.ics', color: 'zzz' }, // dropped: not https
    { id: 'c', url: 'https://example.com/c.ics' }, // name + color defaulted, flags default true
  ];
  const out = ics.normalizeCalendarFeeds(input, PALETTE);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'a');
  assert.equal(out[0].reminders, true);
  assert.equal(out[0].enabled, true);
  assert.equal(out[1].id, 'c');
  assert.equal(out[1].color, PALETTE[0]); // invalid/missing colour → first palette entry
  assert.ok(out[1].name.length > 0);      // falls back to hostname
});

test('normalizeCalendarFeeds returns [] for non-array and caps at 10', () => {
  assert.deepEqual(ics.normalizeCalendarFeeds(null, PALETTE), []);
  const many = Array.from({ length: 25 }, (_, i) => ({ id: 'x' + i, url: 'https://e.com/' + i + '.ics' }));
  assert.equal(ics.normalizeCalendarFeeds(many, PALETTE).length, 10);
});
