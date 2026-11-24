// The usage pass sums tens of thousands of records every refresh while a session runs
// (server/claude-code/usage-aggregate.js): its days are counted on the calendar and its
// prices looked up once per model, with the same answer as one record at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const agg = require('../claude-code/usage-aggregate.js');
const { recordCost } = require('../claude-code/usage-pricing.js');

let seq = 0;
const record = (t, extra = {}) => ({
  k: `r${seq += 1}`, t, model: 'claude-opus-4-8', proj: 'alpha', projPath: 'C:/alpha', branch: 'main',
  in: 10, out: 5, cc: 0, cc1h: 0, cr: 100, ws: 0, wf: 0, ...extra,
});
const files = (...lists) => new Map(lists.map((records, i) => [`f${i}`, { records, meta: null }]));

// The local zone is read when a date is made: one with a clock change in the window.
function inZone(zone, fn) {
  const was = process.env.TZ;
  process.env.TZ = zone;
  try { return fn(); } finally { if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
}

test('the daily chart keeps every date across a clock change, and the window opens at midnight', () => {
  inZone('Europe/Rome', () => {
    // 29 Mar 2026 has 23 hours there; the window of 10 Apr starts on 12 Mar.
    const now = new Date(2026, 3, 10, 12).getTime();
    const out = agg.aggregate(files([
      record(new Date(2026, 2, 29, 12).getTime(), { in: 1000 }),
      // In the first hour after a short day, a count by whole days still says the day before.
      record(new Date(2026, 2, 30, 0, 30).getTime(), { in: 3000 }),
      record(new Date(2026, 2, 12, 0, 30).getTime(), { in: 2000 }),
      record(new Date(2026, 2, 11, 23, 30).getTime(), { in: 4000 }),
    ]), now);
    const days = out.daily.map((d) => d.day);
    assert.equal(days.length, 30);
    assert.equal(days[0], '2026-03-12');
    assert.equal(days[29], '2026-04-10');
    for (let i = 1; i < days.length; i += 1) {
      const next = new Date(`${days[i - 1]}T12:00:00`);
      next.setDate(next.getDate() + 1);
      assert.equal(days[i], agg.localDayKey(next.getTime()), `the day after ${days[i - 1]}`);
    }
    assert.equal(out.daily.find((d) => d.day === '2026-03-29').tokens, 1105);
    assert.equal(out.daily.find((d) => d.day === '2026-03-30').tokens, 3105);
    assert.equal(out.daily[0].tokens, 2105, 'half past midnight is the first day');
    assert.equal(out.window.startsAt, new Date(2026, 2, 12).getTime());
    assert.equal(out.window.reqs, 3, 'the evening before is outside');
  });
});

test('after a long day, a late evening stays on its own date', () => {
  inZone('Europe/Rome', () => {
    // 25 Oct 2026 has 25 hours there: from then on a count by whole days runs an hour ahead.
    const now = new Date(2026, 10, 10, 12).getTime();
    const out = agg.aggregate(files([record(new Date(2026, 9, 26, 23, 30).getTime(), { in: 3000 })]), now);
    assert.equal(out.daily.find((d) => d.day === '2026-10-26').tokens, 3105);
    assert.equal(out.daily.find((d) => d.day === '2026-10-27').tokens, 0);
  });
});

test('a record at a midnight is that day, one stamped after today is in no day', () => {
  const now = new Date(2026, 6, 8, 12).getTime();
  const { starts, end } = agg.dayStartsBack(agg.startOfLocalDay(now), 30);
  assert.equal(agg.dayIndex(starts, starts[5]), 5);
  assert.equal(agg.dayIndex(starts, starts[5] - 1), 4);
  assert.equal(agg.dayIndex(starts, end - 1), 29);
  const out = agg.aggregate(files([record(now), record(end + 3600_000, { in: 500 })]), now);
  assert.equal(out.daily.reduce((s, d) => s + d.tokens, 0), 115);
  assert.equal(out.window.reqs, 2, 'still counted in the window, as before');
});

test('each model of a pass is priced at its own rates', () => {
  const now = new Date(2026, 6, 8, 12).getTime();
  const opus = [record(now - 1000), record(now - 2000, { in: 70 })];
  const haiku = [record(now - 3000, { model: 'claude-haiku-4-5', out: 900 })];
  const out = agg.aggregate(files([...opus, ...haiku]), now);
  const priced = (rs) => rs.reduce((s, r) => s + recordCost(r), 0);
  const cost = (m) => out.models.find((x) => x.model === m).cost;
  assert.ok(Math.abs(cost('claude-opus-4-8') - priced(opus)) < 1e-12);
  assert.ok(Math.abs(cost('claude-haiku-4-5') - priced(haiku)) < 1e-12);
  assert.ok(Math.abs(out.total.cost - priced([...opus, ...haiku])) < 1e-12);
});

test('projects are grouped by folder whatever the letter case on Windows, and kept apart elsewhere', () => {
  const now = new Date(2026, 6, 8, 12).getTime();
  const out = agg.aggregate(files([record(now, { projPath: 'C:/Alpha' }), record(now - 1000, { projPath: 'C:/alpha' }), record(now - 2000, { projPath: 'C:/beta' })]), now);
  assert.equal(out.projectCount, process.platform === 'win32' ? 2 : 3);
});
