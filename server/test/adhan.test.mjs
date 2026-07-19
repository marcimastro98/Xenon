'use strict';
// adhan.js — prayer-time computation and config normalization.
//
// The reference fixture is real data from api.aladhan.com (the widely used
// implementation of these same authorities' rules) for 19 Jul 2026: nine
// calculation methods across six cities, both Asr schools, 108 rows. It is
// checked in rather than fetched so the suite stays offline and deterministic.
//
// Tolerance is two minutes. The reference publishes minute-resolution times, so
// half a minute of that gap is pure quantization, and the two implementations
// use slightly different solar-position series. Measured worst case across all
// 648 comparisons is 1.5 min (Tehran/London/maghrib); the rest sit well under
// one. Asserting tighter would be asserting on rounding noise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const adhan = require('../adhan.js');

const here = dirname(fileURLToPath(import.meta.url));
const referenceDoc = JSON.parse(
  readFileSync(join(here, 'fixtures', 'adhan-reference.json'), 'utf8'),
);
const reference = referenceDoc.rows;

const TOLERANCE_MIN = 2;

// The fixture's times are local wall clock, so the offset has to be the one that
// was in force on that date in that zone, not the runner's current offset.
function tzOffsetHours(tz, y, m, d) {
  const at = Date.UTC(y, m - 1, d, 12);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hour12: false, minute: 'numeric',
  }).formatToParts(new Date(at));
  const hh = Number(parts.find((p) => p.type === 'hour').value);
  const mm = Number(parts.find((p) => p.type === 'minute').value);
  return (hh + mm / 60) - 12;
}

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// Wrap the difference onto [-720, 720] so a time landing either side of
// midnight (Isha in the far north) compares as a small delta, not ~1440.
const deltaMinutes = (a, b) => {
  let d = a - b;
  while (d > 720) d -= 1440;
  while (d < -720) d += 1440;
  return d;
};

// --- reference cross-check --------------------------------------------------

test('computeDayTimes matches published reference times for every method, city and Asr school', () => {
  const worst = [];
  for (const row of reference) {
    const [dd, mm, yyyy] = row.date.split('-').map(Number);
    const tz = tzOffsetHours(row.tz, yyyy, mm, dd);
    const times = adhan.computeDayTimes(
      new Date(yyyy, mm - 1, dd),
      row.lat, row.lon, tz,
      adhan.CALC_METHODS[row.method],
      row.asr === 'hanafi' ? 2 : 1,
      row.highLat,
    );
    for (const key of adhan.PRAYER_KEYS) {
      const got = times[key];
      assert.ok(
        Number.isFinite(got),
        `${row.method}/${row.city}/${row.asr}: ${key} did not resolve`,
      );
      const diff = Math.abs(deltaMinutes(got * 60, toMinutes(row.expect[key])));
      worst.push({ diff, label: `${row.method}/${row.city}/${row.asr}/${key}` });
      assert.ok(
        diff <= TOLERANCE_MIN,
        `${row.method}/${row.city}/${row.asr}: ${key} off by ${diff.toFixed(1)} min ` +
        `(expected ${row.expect[key]})`,
      );
    }
  }
  assert.equal(worst.length, reference.length * adhan.PRAYER_KEYS.length);
});

test('the reference fixture actually covers every shipped method', () => {
  const covered = new Set(reference.map((r) => r.method));
  for (const key of adhan.METHOD_KEYS) {
    assert.ok(covered.has(key), `method "${key}" has no reference rows`);
  }
});

// --- ordering and invariants ------------------------------------------------

test('times run in order across the day, including the southern hemisphere', () => {
  for (const [lat, lon, tz] of [[30.0444, 31.2357, 2], [-33.8688, 151.2093, 10], [1.3521, 103.8198, 8]]) {
    const t = adhan.computeDayTimes(
      new Date(2026, 6, 19), lat, lon, tz,
      adhan.CALC_METHODS.mwl, 1, 'nightMiddle',
    );
    assert.ok(t.fajr < t.sunrise, `fajr before sunrise at ${lat}`);
    assert.ok(t.sunrise < t.dhuhr, `sunrise before dhuhr at ${lat}`);
    assert.ok(t.dhuhr < t.asr, `dhuhr before asr at ${lat}`);
    assert.ok(t.asr < t.maghrib, `asr before maghrib at ${lat}`);
    assert.ok(t.maghrib < t.isha, `maghrib before isha at ${lat}`);
  }
});

test('Hanafi Asr is always later than standard Asr', () => {
  for (const [lat, lon, tz] of [[30.0444, 31.2357, 2], [51.5074, -0.1278, 1], [-6.2088, 106.8456, 7]]) {
    const day = new Date(2026, 6, 19);
    const std = adhan.computeDayTimes(day, lat, lon, tz, adhan.CALC_METHODS.mwl, 1, 'nightMiddle');
    const hanafi = adhan.computeDayTimes(day, lat, lon, tz, adhan.CALC_METHODS.mwl, 2, 'nightMiddle');
    assert.ok(hanafi.asr > std.asr, `hanafi asr later at ${lat}`);
    assert.equal(hanafi.dhuhr, std.dhuhr, 'the school only moves Asr');
  }
});

test('Umm al-Qura puts Isha a fixed 90 minutes after Maghrib', () => {
  const t = adhan.computeDayTimes(
    new Date(2026, 6, 19), 21.3891, 39.8579, 3,
    adhan.CALC_METHODS.makkah, 1, 'nightMiddle',
  );
  assert.ok(Math.abs((t.isha - t.maghrib) - 1.5) < 1e-9, 'isha is maghrib + 90 min');
});

test('methods carrying published corrections apply them', () => {
  // Dubai and Diyanet publish fixed per-prayer offsets on top of the angles;
  // without them both drift several minutes from the official tables.
  assert.deepEqual(adhan.CALC_METHODS.dubai.offsets, { dhuhr: 3, maghrib: 3 });
  assert.equal(adhan.CALC_METHODS.turkey.offsets.maghrib, 7);

  const base = { ...adhan.CALC_METHODS.dubai };
  delete base.offsets;
  const day = new Date(2026, 6, 19);
  const withOff = adhan.computeDayTimes(day, 25.2048, 55.2708, 4, adhan.CALC_METHODS.dubai, 1, 'nightMiddle');
  const without = adhan.computeDayTimes(day, 25.2048, 55.2708, 4, base, 1, 'nightMiddle');
  assert.ok(Math.abs((withOff.dhuhr - without.dhuhr) - 3 / 60) < 1e-9, 'dhuhr shifted 3 min');
  assert.ok(Math.abs((withOff.asr - without.asr)) < 1e-9, 'asr left alone');
});

// --- high latitude ----------------------------------------------------------

test('high-latitude rules resolve Fajr and Isha where only the angle fails', () => {
  // Stockholm in July: the sun still rises and sets, but never dips to 18
  // degrees, so the raw angles yield nothing and the night-portion fallback
  // has to fill both in. This is the case the rules are actually for.
  for (const rule of ['nightMiddle', 'oneSeventh', 'angleBased']) {
    const t = adhan.computeDayTimes(
      new Date(2026, 6, 19), 59.3293, 18.0686, 2,
      adhan.CALC_METHODS.mwl, 1, rule,
    );
    for (const key of adhan.PRAYER_KEYS) {
      assert.ok(Number.isFinite(t[key]), `${rule}: ${key} unresolved at 59.3N`);
    }
  }
});

test('under a midnight sun the night-based prayers stay null rather than guessing', () => {
  // Tromso in July: the sun does not set at all, so there is no night to take a
  // portion of and the high-latitude rules have nothing to work from. Which
  // times apply here is a scholarly question, not an arithmetic one, so the
  // computation declines to answer and the widget renders "--:--". Dhuhr and
  // Asr are solar-angle based and remain well defined.
  for (const rule of ['nightMiddle', 'oneSeventh', 'angleBased']) {
    const t = adhan.computeDayTimes(
      new Date(2026, 6, 19), 69.6492, 18.9553, 2,
      adhan.CALC_METHODS.mwl, 1, rule,
    );
    assert.equal(t.fajr, null, `${rule}: fajr not invented`);
    assert.equal(t.maghrib, null, `${rule}: maghrib not invented`);
    assert.equal(t.isha, null, `${rule}: isha not invented`);
    assert.ok(Number.isFinite(t.dhuhr), `${rule}: dhuhr still resolves`);
    assert.ok(Number.isFinite(t.asr), `${rule}: asr still resolves`);
  }
});

test('the payload survives a midnight-sun location without emitting NaN', () => {
  const cfg = adhan.normalizeAdhan({ mode: 'manual', lat: 69.6492, lon: 18.9553, city: 'Tromso' });
  const out = adhan.buildAdhanPayload(cfg, null, new Date(2026, 6, 19, 12, 0, 0), 'en');
  assert.equal(out.times.length, adhan.PRAYER_KEYS.length, 'every prayer still listed');
  for (const t of out.times) {
    assert.ok(t.at === null || Number.isFinite(t.at), `${t.key} is null or a real timestamp, never NaN`);
  }
  assert.ok(out.next && Number.isFinite(out.next.at), 'next still points at a resolvable prayer');
});

test('the three high-latitude rules disagree, in the documented direction', () => {
  const args = [new Date(2026, 6, 19), 59.3293, 18.0686, 2, adhan.CALC_METHODS.mwl, 1];
  const mid = adhan.computeDayTimes(...args, 'nightMiddle');
  const seventh = adhan.computeDayTimes(...args, 'oneSeventh');
  // A seventh of the night is a shorter portion than half of it, so Fajr lands
  // later and Isha earlier than the night-middle rule.
  assert.ok(seventh.fajr > mid.fajr, 'oneSeventh fajr is later');
  assert.ok(seventh.isha < mid.isha, 'oneSeventh isha is earlier');
});

test('rule "none" leaves the polar case unresolved rather than inventing a time', () => {
  const t = adhan.computeDayTimes(
    new Date(2026, 6, 19), 78.2232, 15.6469, 2,
    adhan.CALC_METHODS.mwl, 1, 'none',
  );
  assert.equal(t.fajr, null, 'fajr stays null under the midnight sun');
  assert.equal(t.isha, null, 'isha stays null under the midnight sun');
});

// --- config normalization ---------------------------------------------------

test('normalizeAdhan fills defaults from an empty or absent config', () => {
  for (const input of [undefined, null, {}, 'nonsense', 42]) {
    const cfg = adhan.normalizeAdhan(input);
    assert.equal(cfg.method, adhan.DEFAULT_ADHAN.method);
    assert.equal(cfg.asr, 'standard');
    assert.equal(cfg.mode, 'auto');
    assert.deepEqual(Object.keys(cfg.tune).sort(), [...adhan.PRAYER_KEYS].sort());
  }
});

test('normalizeAdhan rejects unknown enum values and keeps known ones', () => {
  assert.equal(adhan.normalizeAdhan({ method: 'not-a-method' }).method, adhan.DEFAULT_ADHAN.method);
  assert.equal(adhan.normalizeAdhan({ method: 'karachi' }).method, 'karachi');
  assert.equal(adhan.normalizeAdhan({ asr: 'maliki' }).asr, 'standard');
  assert.equal(adhan.normalizeAdhan({ asr: 'hanafi' }).asr, 'hanafi');
  assert.equal(adhan.normalizeAdhan({ highLat: 'wishful' }).highLat, 'nightMiddle');
  assert.equal(adhan.normalizeAdhan({ highLat: 'oneSeventh' }).highLat, 'oneSeventh');
});

test('normalizeAdhan clamps coordinates and drops unusable ones', () => {
  const ok = adhan.normalizeAdhan({ mode: 'manual', lat: 30.0444, lon: 31.2357 });
  assert.equal(ok.lat, 30.0444);
  assert.equal(ok.lon, 31.2357);

  for (const bad of [{ lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: 'x', lon: 'y' }, { lat: NaN, lon: 1 }]) {
    const cfg = adhan.normalizeAdhan({ mode: 'manual', ...bad });
    const usable = Number.isFinite(cfg.lat) && Number.isFinite(cfg.lon)
      && Math.abs(cfg.lat) <= 90 && Math.abs(cfg.lon) <= 180;
    assert.ok(!usable, `coordinates ${JSON.stringify(bad)} should not survive as usable`);
  }
});

test('normalizeAdhan bounds the alert lead time', () => {
  assert.equal(adhan.normalizeAdhan({ alertMinutes: -5 }).alertMinutes >= 0, true);
  assert.equal(adhan.normalizeAdhan({ alertMinutes: 99999 }).alertMinutes <= 120, true);
  assert.equal(adhan.normalizeAdhan({ alertMinutes: 20 }).alertMinutes, 20);
});

test('an absent location stays absent instead of becoming 0,0', () => {
  // Number(null) and Number('') are 0, which is a valid-looking coordinate off
  // the coast of West Africa. Re-normalizing a saved config must not quietly
  // pin the user to Null Island.
  for (const empty of [null, '', undefined]) {
    const cfg = adhan.normalizeAdhan({ mode: 'manual', lat: empty, lon: empty });
    assert.equal(cfg.lat, null, `lat: ${JSON.stringify(empty)} stays null`);
    assert.equal(cfg.lon, null, `lon: ${JSON.stringify(empty)} stays null`);
  }
  // A real 0 that the user actually typed is still a legitimate coordinate.
  const zero = adhan.normalizeAdhan({ mode: 'manual', lat: 0, lon: 0 });
  assert.equal(zero.lat, 0);
  assert.equal(zero.lon, 0);
});

test('normalizeAdhan is idempotent', () => {
  const once = adhan.normalizeAdhan({ method: 'makkah', asr: 'hanafi', alertMinutes: 15 });
  assert.deepEqual(adhan.normalizeAdhan(once), once);
});

test('normalizeAdhan does not mutate the frozen defaults', () => {
  const before = JSON.stringify(adhan.DEFAULT_ADHAN);
  const cfg = adhan.normalizeAdhan({ method: 'tehran' });
  cfg.tune.fajr = 99;
  assert.equal(JSON.stringify(adhan.DEFAULT_ADHAN), before, 'defaults untouched');
  assert.equal(adhan.normalizeAdhan({}).tune.fajr, 0, 'later configs unaffected');
});

// --- payload ----------------------------------------------------------------

const place = { lat: 30.0444, lon: 31.2357, city: 'Cairo' };

test('buildAdhanPayload returns every prayer, flagged and ordered', () => {
  const out = adhan.buildAdhanPayload(
    adhan.normalizeAdhan({}), place, new Date(2026, 6, 19, 12, 0, 0), 'en',
  );
  assert.equal(out.ok, true);
  assert.deepEqual(out.times.map((t) => t.key), [...adhan.PRAYER_KEYS]);
  assert.equal(out.times.find((t) => t.key === 'sunrise').prayer, false,
    'sunrise is a marker, not a prayer');
  assert.equal(out.times.filter((t) => t.prayer).length, 5);
  for (let i = 1; i < out.times.length; i++) {
    assert.ok(out.times[i].at > out.times[i - 1].at, 'timestamps ascend');
  }
});

test('buildAdhanPayload picks the next prayer and rolls into tomorrow after Isha', () => {
  const cfg = adhan.normalizeAdhan({});
  const midday = adhan.buildAdhanPayload(cfg, place, new Date(2026, 6, 19, 12, 0, 0), 'en');
  assert.ok(midday.next.at > new Date(2026, 6, 19, 12, 0, 0).getTime(), 'next is in the future');
  assert.equal(midday.next.tomorrow, false);

  const lateNight = adhan.buildAdhanPayload(cfg, place, new Date(2026, 6, 19, 23, 59, 0), 'en');
  assert.equal(lateNight.next.key, 'fajr', 'after Isha the next prayer is tomorrow Fajr');
  assert.equal(lateNight.next.tomorrow, true);
  assert.ok(lateNight.next.at > new Date(2026, 6, 19, 23, 59, 0).getTime());
});

test('per-prayer tune offsets shift only the prayers they name', () => {
  const base = adhan.buildAdhanPayload(
    adhan.normalizeAdhan({}), place, new Date(2026, 6, 19, 3, 0, 0), 'en',
  );
  const tuned = adhan.buildAdhanPayload(
    adhan.normalizeAdhan({ tune: { fajr: 5 } }), place, new Date(2026, 6, 19, 3, 0, 0), 'en',
  );
  const at = (p, k) => p.times.find((t) => t.key === k).at;
  assert.equal(at(tuned, 'fajr') - at(base, 'fajr'), 5 * 60 * 1000, 'fajr moved 5 min');
  assert.equal(at(tuned, 'asr'), at(base, 'asr'), 'asr untouched');
});

test('buildAdhanPayload degrades cleanly when no location is known', () => {
  const out = adhan.buildAdhanPayload(
    adhan.normalizeAdhan({}), null, new Date(2026, 6, 19, 12, 0, 0), 'en',
  );
  assert.equal(out.ok, false, 'reports not-ok rather than throwing');
  assert.ok(!out.times || out.times.length === 0);
});

test('manual coordinates win over the supplied place', () => {
  const cfg = adhan.normalizeAdhan({ mode: 'manual', lat: 21.3891, lon: 39.8579, city: 'Makkah' });
  const out = adhan.buildAdhanPayload(cfg, place, new Date(2026, 6, 19, 12, 0, 0), 'en');
  const auto = adhan.buildAdhanPayload(adhan.normalizeAdhan({}), place, new Date(2026, 6, 19, 12, 0, 0), 'en');
  const dhuhr = (p) => p.times.find((t) => t.key === 'dhuhr').at;
  assert.notEqual(dhuhr(out), dhuhr(auto), 'pinned location produces different times');
});
