import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ics = require('../ics-feeds.js');

// A calendar feed is parsed synchronously on the server's event loop, so a
// hostile or broken feed must finish quickly whatever it contains.

const NOW = Date.UTC(2026, 10, 2);
const WIN_A = new Date(NOW - 90 * 86400000);
const WIN_B = new Date(NOW + 90 * 86400000);
const FEED = { id: 'f', color: '#fff' };

function vevent(i, extra) {
  return ['BEGIN:VEVENT', `UID:u${i}`, 'SUMMARY:x', ...extra, 'END:VEVENT'].join('\r\n');
}

function timed(fn) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  return { out, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

test('79k daily events from 1990: parse + expand stays bounded and fast', () => {
  const body = Array.from({ length: 79000 }, (_, i) =>
    vevent(i, ['DTSTART:19900101T080000Z', 'RRULE:FREQ=DAILY'])).join('\r\n');
  const { out, ms } = timed(() => ics.mapFeedEvents(ics.parseIcs(body), FEED, WIN_A, WIN_B));
  assert.ok(ms < 1000, `took ${ms} ms`);
  assert.ok(out.length <= ics.MAX_OCCURRENCES_PER_FEED);
  assert.ok(out.length > 0, 'a long-running daily series still reaches today');
  assert.equal(ics.parseIcs(body).length, ics.MAX_EVENTS_PER_FEED);
});

test('BYDAY repeated thousands of times is deduplicated', () => {
  const byday = Array(5000).fill('MO').join(',');
  const body = Array.from({ length: 2000 }, (_, i) =>
    vevent(i, ['DTSTART:20200106T080000Z', `RRULE:FREQ=WEEKLY;BYDAY=${byday}`])).join('\r\n');
  const { out, ms } = timed(() => ics.mapFeedEvents(ics.parseIcs(body), FEED, WIN_A, WIN_B));
  assert.ok(ms < 1000, `took ${ms} ms`);
  // One Monday per week per event, never one per repeated "MO".
  const perEvent = out.filter(e => e.id.startsWith('ext:f:u0:'));
  assert.ok(perEvent.length >= 25 && perEvent.length <= 27, String(perEvent.length));
});

test('huge COUNT on a day-31 monthly rule from the year 1000 is bounded', () => {
  const body = Array.from({ length: 2000 }, (_, i) =>
    vevent(i, ['DTSTART:10000131T080000Z', 'RRULE:FREQ=MONTHLY;COUNT=999999999'])).join('\r\n');
  const { ms } = timed(() => ics.mapFeedEvents(ics.parseIcs(body), FEED, WIN_A, WIN_B));
  assert.ok(ms < 1000, `took ${ms} ms`);
});

test('thousands of TZID EXDATEs parse quickly', () => {
  const ex = Array.from({ length: 60000 }, (_, i) => `2020${String(1 + (i % 12)).padStart(2, '0')}01T080000`).join(',');
  const body = vevent(0, ['DTSTART;TZID=Europe/Rome:20200101T080000', 'RRULE:FREQ=DAILY', `EXDATE;TZID=Europe/Rome:${ex}`]);
  const { out, ms } = timed(() => ics.parseIcs(body));
  assert.ok(ms < 1000, `took ${ms} ms`);
  assert.ok(out[0].exdate.length <= 500);
});

test('jumping to the window keeps COUNT exact for an old daily series', () => {
  // Started 1000 days before the window with COUNT=1005 → the last 5 days of
  // the series fall at the start of the window (one period of margin aside).
  const start = new Date(WIN_A.getTime() - 1000 * 86400000);
  const ymd = start.toISOString().slice(0, 10).replace(/-/g, '');
  const [e] = ics.parseIcs(vevent(0, [`DTSTART:${ymd}T000000Z`, 'RRULE:FREQ=DAILY;COUNT=1005']));
  const occ = ics.expandRecurrence(e, WIN_A, WIN_B);
  assert.equal(occ.length, 5);
  assert.equal(occ[0], new Date(start.getTime() + 1000 * 86400000).toISOString());
});

test('YEARLY repeats on the same date each year, Feb 29 only in leap years', () => {
  const [bday] = ics.parseIcs(vevent(0, ['DTSTART;VALUE=DATE:19800315', 'RRULE:FREQ=YEARLY']));
  const occ = ics.expandRecurrence(bday, new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2027, 11, 31)));
  assert.deepEqual(occ, ['2025-03-15T00:00', '2026-03-15T00:00', '2027-03-15T00:00']);
  const [leap] = ics.parseIcs(vevent(1, ['DTSTART;VALUE=DATE:20000229', 'RRULE:FREQ=YEARLY']));
  const occ2 = ics.expandRecurrence(leap, new Date(Date.UTC(2025, 0, 1)), new Date(Date.UTC(2029, 11, 31)));
  assert.deepEqual(occ2, ['2028-02-29T00:00']);
});

test('feed fetch refuses this machine, link-local and plain http before connecting', async () => {
  for (const url of [
    // This machine, link-local and plain http are refused. A calendar on the
    // home network (a Nextcloud at 192.168.x.x, a NAS over Tailscale, a .local
    // name) is the user's own and stays allowed: see net-guard.isLanAddress.
    'https://127.0.0.1/cal.ics', 'https://[::1]/cal.ics', 'https://[::ffff:7f00:1]/cal.ics',
    'https://localhost/cal.ics', 'https://169.254.169.254/cal.ics', 'https://0.0.0.0/cal.ics',
    'http://example.com/cal.ics',
  ]) {
    await assert.rejects(() => ics.fetchFeedText(url), (e) => e.code === 'EBLOCKED', url);
  }
});
