// Protocol 2 of the version ping: cohorts without an identifier.
//
// The fields are coarse buckets and booleans, and the hub counts each in its own
// table. The tests worth having are about PROVENANCE — a birth is only ever a
// birth that was observed — and about what a failed request may consume, because
// the day throttle and the period flags look alike and must not behave alike.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const versionPing = require('../version-ping.js');

let calls;
let responder;
beforeEach(() => {
  calls = [];
  responder = () => ({ ok: true });
  versionPing._setTransport(async (url, body) => { calls.push({ url, body }); return responder(url, body); });
});

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-vping-c-'));
}
const readState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'version-ping.json'), 'utf8'));
const send = (dataDir, day, over = {}) =>
  versionPing.maybePing({ dataDir, version: '4.12.0', enabled: true, day, ...over });

// ── Provenance ──────────────────────────────────────────────────────────────

test('a fresh install reports its cohort; a late opt-in reports unknown', async () => {
  // fresh:true means settings.json was absent when the process started, which is
  // the only evidence that this install was created rather than merely enabled.
  const born = tmpDataDir();
  await send(born, '2026-08-03', { fresh: true });
  assert.equal(calls[0].body.cohort, '2026-08');
  assert.equal(calls[0].body.age, 'd0');

  // Same missing state file, but the process found a settings.json: this install
  // has existed for who knows how long. Calling it born today is the one error
  // that would corrupt the retention curve silently and permanently.
  calls = [];
  const old = tmpDataDir();
  await send(old, '2026-08-03', { fresh: false });
  assert.equal(calls[0].body.cohort, 'unknown');
  assert.equal(calls[0].body.age, 'unknown');
});

test('a v1 state file never becomes a birth', async () => {
  const dir = tmpDataDir();
  fs.writeFileSync(path.join(dir, 'version-ping.json'), JSON.stringify({ day: '2026-05-02' }), 'utf8');
  await send(dir, '2026-08-03');
  assert.equal(calls[0].body.cohort, 'unknown');
  assert.equal(calls[0].body.age, 'unknown');
  // It IS the first ping of that week and month, though — those need no history.
  assert.equal(calls[0].body.newWeek, true);
  assert.equal(calls[0].body.newMonth, true);
});

test('a corrupt state file reports unknown rather than guessing', async () => {
  const dir = tmpDataDir();
  fs.writeFileSync(path.join(dir, 'version-ping.json'), '{not json', 'utf8');
  await send(dir, '2026-08-03', { fresh: false });
  assert.equal(calls[0].body.cohort, 'unknown');
  assert.equal(calls[0].body.age, 'unknown');
});

test('the boot signal outranks the state file, in both directions', async () => {
  // fresh comes from settings.json being absent when the PROCESS started, which
  // is independent evidence and the stronger of the two. An unreadable state file
  // next to a genuinely new install is still a new install…
  const fresh = tmpDataDir();
  fs.writeFileSync(path.join(fresh, 'version-ping.json'), '{not json', 'utf8');
  await send(fresh, '2026-08-03', { fresh: true });
  assert.equal(calls[0].body.cohort, '2026-08');

  // …and a readable one carrying no birth stays unknown however new it looks.
  calls = [];
  const old = tmpDataDir();
  fs.writeFileSync(path.join(old, 'version-ping.json'),
    JSON.stringify({ v: 2, day: '2026-08-02', first: '2026-08-02', born: 'unknown' }), 'utf8');
  await send(old, '2026-08-03', { fresh: true });
  assert.equal(calls[0].body.cohort, 'unknown', 'born is never promoted after the fact');
});

test('the birth date never moves once recorded', async () => {
  const dir = tmpDataDir();
  for (const day of ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']) {
    await send(dir, day, { fresh: true });
  }
  assert.equal(readState(dir).first, '2026-08-03');
  const last = calls[calls.length - 1].body;
  assert.equal(last.cohort, '2026-08');
  assert.equal(last.age, 'd1_7');
});

// ── Buckets and period keys ─────────────────────────────────────────────────

test('ageBucket is a table, and a clock that went backwards is unknown', () => {
  const b = (n) => versionPing.ageBucket('2026-01-01', versionPing.utcDay(Date.UTC(2026, 0, 1) + n * 86400000));
  assert.equal(b(0), 'd0');
  assert.equal(b(1), 'd1_7');
  assert.equal(b(7), 'd1_7');
  assert.equal(b(8), 'd8_30');
  assert.equal(b(30), 'd8_30');
  assert.equal(b(31), 'd31_90');
  assert.equal(b(90), 'd31_90');
  assert.equal(b(91), 'd90p');
  assert.equal(versionPing.ageBucket('2026-01-02', '2026-01-01'), '');
  assert.equal(versionPing.ageBucket('nonsense', '2026-01-01'), '');
});

test('isoWeek: the Thursday decides the year', () => {
  assert.equal(versionPing.isoWeek('2026-08-03'), '2026-W32');
  assert.equal(versionPing.isoWeek('2025-12-29'), '2026-W01');
  assert.equal(versionPing.isoWeek('2026-01-01'), '2026-W01');
  assert.equal(versionPing.isoWeek('2027-01-01'), '2026-W53');
  assert.equal(versionPing.isoWeek('nonsense'), '');
});

test('newWeek fires once a week, newMonth once a month', async () => {
  const dir = tmpDataDir();

  await send(dir, '2026-08-03', { fresh: true });     // Monday, W32
  assert.equal(calls[0].body.newWeek, true);
  assert.equal(calls[0].body.newMonth, true);

  await send(dir, '2026-08-04');                      // still W32, still August
  assert.equal(calls[1].body.newWeek, undefined);
  assert.equal(calls[1].body.newMonth, undefined);

  await send(dir, '2026-08-10');                      // W33
  assert.equal(calls[2].body.newWeek, true);
  assert.equal(calls[2].body.newMonth, undefined);

  await send(dir, '2026-09-01');                      // new month and new week
  assert.equal(calls[3].body.newWeek, true);
  assert.equal(calls[3].body.newMonth, true);
});

test('a PC that was off for a month reports once, without back-filling', async () => {
  const dir = tmpDataDir();
  await send(dir, '2026-07-06', { fresh: true });
  calls = [];
  await send(dir, '2026-08-12');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.newWeek, true);
  assert.equal(calls[0].body.newMonth, true);
});

test('a clock that went backwards never re-claims a period', async () => {
  const dir = tmpDataDir();
  await send(dir, '2026-08-12', { fresh: true });
  calls = [];
  // Earlier than the week already reported. Strictly forward: a missed count is
  // acceptable in a counter of distinct things, a duplicated one is not.
  await send(dir, '2026-08-05');
  assert.equal(calls[0].body.newWeek, undefined);
  assert.equal(calls[0].body.newMonth, undefined);
});

// ── What a failed request may consume ───────────────────────────────────────

test('a failed POST consumes the DAY but never the weekly flag', async () => {
  const dir = tmpDataDir();
  responder = () => ({ ok: false, error: 'network' });
  await send(dir, '2026-08-03', { fresh: true });
  assert.equal(calls[0].body.newWeek, true);

  // Same week, next day: the count was never taken, so it must still be offered.
  // Burning it on a failed request would lose a weekly active for seven days and
  // no retry could recover it — the day throttle and the period flags look alike
  // and are deliberately not the same thing.
  responder = () => ({ ok: true });
  await send(dir, '2026-08-04');
  assert.equal(calls[1].body.newWeek, true);
  assert.equal(calls[1].body.newMonth, true);

  // The day throttle still held, though: no second attempt inside one day.
  const same = await send(dir, '2026-08-04');
  assert.equal(same.skipped, 'already_sent');
  assert.equal(calls.length, 2);
});

test('a failed POST does not consume "from" either', async () => {
  const dir = tmpDataDir();
  await versionPing.maybePing({ dataDir: dir, version: '4.11.0', enabled: true, day: '2026-08-03', fresh: true });
  responder = () => ({ ok: false, error: 'network' });
  await send(dir, '2026-08-04');
  responder = () => ({ ok: true });
  await send(dir, '2026-08-05');
  assert.equal(calls[2].body.from, '4.11.0', 'the move survives a failed attempt');
});

// ── Where an install came from ──────────────────────────────────────────────

test('"from" is sent once, on the first ping after the version changed', async () => {
  const dir = tmpDataDir();
  await versionPing.maybePing({ dataDir: dir, version: '4.11.0', enabled: true, day: '2026-08-03', fresh: true });
  assert.equal(calls[0].body.from, undefined, 'no previous version exists on a first ping');

  await send(dir, '2026-08-04');
  assert.equal(calls[1].body.from, '4.11.0');

  await send(dir, '2026-08-05');
  assert.equal(calls[2].body.from, undefined, 'reported once, not every day');
});

test('a downgrade is reported exactly like an upgrade', async () => {
  const dir = tmpDataDir();
  await send(dir, '2026-08-03', { fresh: true });
  await versionPing.maybePing({ dataDir: dir, version: '4.11.0', enabled: true, day: '2026-08-04' });
  assert.equal(calls[1].body.from, '4.12.0');
});

// ── Language, purity, and odd state files ───────────────────────────────────

test('lang is sent only when it is one of the eleven the app ships', async () => {
  const one = async (lang) => {
    calls = [];
    await versionPing.maybePing({ dataDir: tmpDataDir(), version: '4.12.0', enabled: true, lang });
    return calls[0].body.lang;
  };
  assert.equal(await one('it'), 'it');
  assert.equal(await one('ko'), 'ko');
  assert.equal(await one(''), undefined);
  assert.equal(await one('xx'), undefined);
  assert.equal(await one(undefined), undefined);
});

test('buildPingBody is pure: same input, same output, no disk', () => {
  const state = { born: 'known', first: '2026-07-01', week: '', month: '', version: '4.11.0' };
  const args = { state, version: '4.12.0', os: 'linux', day: '2026-08-03', lang: 'it' };
  assert.deepEqual(versionPing.buildPingBody(args), versionPing.buildPingBody(args));
  assert.deepEqual(versionPing.buildPingBody(args), {
    pv: 2, version: '4.12.0', os: 'linux', cohort: '2026-07', age: 'd31_90',
    newWeek: true, newMonth: true, from: '4.11.0', lang: 'it',
  });
});

test('a state file from a newer build keeps its unknown keys', async () => {
  const dir = tmpDataDir();
  fs.writeFileSync(path.join(dir, 'version-ping.json'), JSON.stringify({
    v: 3, day: '2026-08-02', first: '2026-07-01', born: 'known', somethingNew: 'keep me',
  }), 'utf8');
  await send(dir, '2026-08-03');
  // A downgrade after an upgrade must not destroy the one field that cannot be
  // recovered, so unknown keys survive the rewrite.
  assert.equal(readState(dir).somethingNew, 'keep me');
});

test('a field of the wrong shape costs that field alone', async () => {
  const dir = tmpDataDir();
  fs.writeFileSync(path.join(dir, 'version-ping.json'), JSON.stringify({
    v: 2, day: '2026-08-02', first: '2026-07-01', born: 'known', week: 42, month: {}, version: 'nope',
  }), 'utf8');
  await send(dir, '2026-08-03');
  assert.equal(calls[0].body.cohort, '2026-07', 'the cohort survived');
  assert.equal(calls[0].body.newWeek, true, 'a malformed week simply re-offers its flag');
  assert.equal(calls[0].body.from, undefined, 'an unusable previous version produces no move');
});
