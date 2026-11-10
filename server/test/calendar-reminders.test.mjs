// Calendar reminders decided once on the server (calendar-reminders.js): what is
// due, what a stale save may not undo, the feed reminders it remembers, and the
// wiring that makes every surface show the same one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const R = require('../calendar-reminders.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const T0 = Date.parse('2026-10-27T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

test('a reminder rings once, at its time, never early', () => {
  const events = [
    { id: 'a', title: 'Dentist', startsAt: iso(T0 + 3600e3), reminderAt: iso(T0 - 1000), notifiedAt: '' },
    { id: 'b', title: 'Later', startsAt: iso(T0 + 7200e3), reminderAt: iso(T0 + 60e3), notifiedAt: '' },
    { id: 'c', title: 'Done', startsAt: iso(T0), reminderAt: iso(T0 - 5000), notifiedAt: iso(T0 - 4000) },
    { id: 'd', title: 'No reminder', startsAt: iso(T0), reminderAt: '', notifiedAt: '' },
  ];
  assert.deepEqual(R.markDueEvents(events, T0).map(e => e.id), ['a']);
  assert.equal(events[0].notifiedAt, iso(T0));
  assert.deepEqual(R.markDueEvents(events, T0 + 1000), [], 'already rung');
  assert.deepEqual(R.markDueEvents(events, T0 + 60e3).map(e => e.id), ['b']);
});

test('a save from an older copy never un-rings a reminder; moving it rings again', () => {
  const prev = [{ id: 'a', reminderAt: '2026-10-27T09:00', notifiedAt: '2026-10-27T09:00:05Z' }];
  const stale = [{ id: 'a', reminderAt: '2026-10-27T09:00', notifiedAt: '' }, { id: 'n', reminderAt: '', notifiedAt: '' }];
  assert.equal(R.keepNotified(stale, prev)[0].notifiedAt, '2026-10-27T09:00:05Z');
  assert.equal(R.keepNotified(stale, prev)[1].notifiedAt, '');
  const moved = [{ id: 'a', reminderAt: '2026-10-27T11:00', notifiedAt: '' }];
  assert.equal(R.keepNotified(moved, prev)[0].notifiedAt, '', 'a new reminder time rings again');
  assert.deepEqual(R.keepNotified(stale, null).map(e => e.notifiedAt), ['', '']);
});

test('feed events ring 10 minutes before they start, only for feeds with reminders on', () => {
  const feeds = [{ id: 'work', reminders: true }, { id: 'muted', reminders: false }, { id: 'old' }];
  const events = [
    { id: 'w1', source: 'work', startsAt: iso(T0 + 9 * 60e3) },
    { id: 'w2', source: 'work', startsAt: iso(T0 + 11 * 60e3) },
    { id: 'w3', source: 'work', startsAt: iso(T0 - 60e3) },
    { id: 'm1', source: 'muted', startsAt: iso(T0 + 5 * 60e3) },
    { id: 'o1', source: 'old', startsAt: iso(T0 + 5 * 60e3) },
    { id: 'x1', source: 'gone', startsAt: iso(T0 + 5 * 60e3) },
  ];
  assert.deepEqual(R.dueFeedEvents(events, feeds, {}, T0).map(e => e.id), ['w1', 'o1']);
  assert.deepEqual(R.dueFeedEvents(events, feeds, { w1: T0 - 1, o1: T0 - 1 }, T0), []);
  assert.deepEqual(R.dueFeedEvents(events, [], {}, T0), [], 'no feeds, no reminders');
});

test('the remembered feed reminders stay small and well-formed', () => {
  const map = { keep: T0 - 3600e3, old: T0 - 3 * 86400e3, bad: 'x', ['y'.repeat(300)]: T0 };
  assert.deepEqual(R.pruneFired(map, T0), { keep: T0 - 3600e3 });
  assert.deepEqual(R.pruneFired(null, T0), {});
  const many = Object.fromEntries(Array.from({ length: 2100 }, (_, i) => ['e' + i, T0 - i]));
  assert.equal(Object.keys(R.pruneFired(many, T0)).length, 2000);
});

test('the wire carries the title and the start, nothing else of the event', () => {
  const p = R.reminderPayload({ id: 'a', title: 't'.repeat(200), startsAt: '2026-10-27T11:00', notes: 'private', reminderAt: 'x' }, false);
  assert.deepEqual(Object.keys(p).sort(), ['feed', 'id', 'startsAt', 'title']);
  assert.equal(p.title.length, 120);
  assert.equal(R.reminderPayload({ id: 'b', startsAt: 'nope' }, true).startsAt, '');
});

function harness(over = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'xen-rem-'));
  const sent = [];
  const writes = [];
  let clock = T0;
  let listeners = true;
  let local = [];
  const cache = { feeds: [{ id: 'work', reminders: true }], events: [{ id: 'w1', source: 'work', title: 'Standup', startsAt: iso(T0 + 5 * 60e3) }] };
  const rings = [];
  const r = R.createCalendarReminders({
    markLocal: async (now) => R.markDueEvents(local, now),
    feedCache: () => cache,
    firedFile: path.join(dir, 'calendar-reminders.json'),
    writeFileAtomic: async (file, data) => { writes.push(JSON.parse(data)); writeFileSync(file, data); },
    hasListeners: () => listeners,
    broadcast: (ev, d) => sent.push([ev, d]),
    onRing: (d) => rings.push(d.id),
    now: () => clock,
    ...over,
  });
  return {
    r, sent, writes, rings, cache, dir,
    set local(v) { local = v; },
    set listeners(v) { listeners = v; },
    tick(ms) { clock += ms; },
  };
}

test('nothing is checked with nobody connected; the first surface gets what came due', async () => {
  const h = harness();
  h.local = [{ id: 'a', title: 'Call mum', startsAt: iso(T0), reminderAt: iso(T0 - 1), notifiedAt: '' }];
  h.listeners = false;
  await h.r.check();
  assert.deepEqual(h.sent, []);
  h.listeners = true;
  await h.r.check();
  assert.deepEqual(h.sent.map(([ev, d]) => [ev, d.id, d.feed]), [['calendar_reminder', 'a', false], ['calendar_reminder', 'w1', true]]);
  assert.deepEqual(h.rings, ['a', 'w1'], 'the lights flash once per reminder');
  assert.deepEqual(Object.keys(h.writes.at(-1)), ['w1'], 'the feed reminder is remembered before it rings');
  await h.r.check();
  assert.equal(h.sent.length, 2, 'each rings once');
});

test('a restart remembers the feed reminders that already rang', async () => {
  const a = harness();
  await a.r.check();
  assert.equal(a.sent.length, 1);
  const b = harness({ firedFile: path.join(a.dir, 'calendar-reminders.json') });
  await b.r.check();
  assert.deepEqual(b.sent, []);
});

test('a broken file or a failing save never stops the check, and never rings twice by itself', async () => {
  const h = harness();
  writeFileSync(path.join(h.dir, 'calendar-reminders.json'), '{not json');
  await h.r.check();
  assert.equal(h.sent.length, 1);
  const f = harness({ writeFileAtomic: async () => { throw new Error('disk full'); } });
  const out = process.stdout.write;
  process.stdout.write = () => true;
  try { await f.r.check(); } finally { process.stdout.write = out; }
  assert.deepEqual(f.sent, [], 'not remembered, not rung');
});

test('server: every events write is queued and keeps the rung marks; the check is stopped at shutdown', () => {
  const s = read('../server.js');
  const w = s.slice(s.indexOf('function writeEvents(events)'), s.indexOf('function markEventReminders'));
  assert.match(w, /withEventsWrite\(/);
  assert.match(w, /calendarReminders\.keepNotified\(normalizeEvents\(events\), prev\)/);
  assert.match(s, /function markEventReminders\(now\) \{\n\s*return withEventsWrite\(/);
  assert.match(s, /hasListeners: \(\) => sseClients\.size > 0/);
  assert.match(s, /onRing: \(\) => lighting\.onEvent\('reminder'\)/);
  const stop = s.slice(s.indexOf('function _gracefulShutdown()'));
  assert.match(stop.slice(0, 600), /_calendarReminders\.stop\(\);/);
});

test('the dashboard and the alerts window show the reminder; neither decides it', () => {
  const cal = read('../js/calendar.js');
  assert.doesNotMatch(cal, /function checkReminders|lightingNotify\('reminder'\)/);
  assert.match(cal, /AlertToasts\.reminder\(d, \{ t \}/);
  const alerts = read('../js/screen-alerts.js');
  assert.match(alerts, /calendar_reminder: reminder,/);
  assert.match(alerts, /if \(notifSoundsOn\(\)\) postChime\('reminder'\);/);
});

test('the reminder card says the same on both', () => {
  const AlertToasts = require('../js/alert-toasts.js');
  const t = (k) => ({ reminder: 'Promemoria', ph_title: 'Titolo evento' })[k] || k;
  const card = AlertToasts.reminder({ title: 'Dentista', startsAt: '2026-10-27T11:00:00Z' }, { t }, (d) => 'mar ' + d.getUTCHours());
  assert.deepEqual(card, { type: 'reminder', kicker: 'Promemoria', title: 'Dentista', message: 'mar 11' });
  assert.equal(AlertToasts.reminder({ title: '', startsAt: 'x' }, { t }).title, 'Titolo evento');
  assert.equal(AlertToasts.reminder({ title: 'a', startsAt: 'x' }, { t }, () => 'never').message, '');
  assert.equal(AlertToasts.reminder(null, { t }), null);
});
