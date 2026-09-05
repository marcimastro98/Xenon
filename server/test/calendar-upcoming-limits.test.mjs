// What the Upcoming list shows.
//
// The report that started this asked for "a custom date range", saying the
// widget shows the next two weeks. There was no two-week rule: the list took
// the next FIVE events and their dates fell where they fell, so a quiet
// fortnight put an eleven-day chip on screen and that looked like a window.
// The count was the only limit and it was not adjustable either.
//
// So the fix is both knobs, and the thing worth pinning is that the DEFAULT is
// byte-for-byte the old behaviour: five events, no horizon.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../js/calendar.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// upcomingLimits() is pure and reads the settings object; evaluate it out of the
// source the app serves, like the label tests beside it.
function loadLimits(hubSettings) {
  const start = SRC.indexOf('function upcomingLimits(');
  assert.ok(start >= 0, 'upcomingLimits not found');
  const end = SRC.indexOf('\n}\n', start);
  return new Function('hubSettings', SRC.slice(start, end + 2) + '; return upcomingLimits;')(hubSettings)();
}

test('an install that never touches the setting behaves exactly as before', () => {
  assert.deepEqual(loadLimits(undefined), { count: 5, days: 0 });
  assert.deepEqual(loadLimits({}), { count: 5, days: 0 }, 'five events, no horizon');
});

test('only the offered values are taken, and junk falls back', () => {
  assert.deepEqual(loadLimits({ upcomingCount: 3, upcomingDays: 7 }), { count: 3, days: 7 });
  assert.deepEqual(loadLimits({ upcomingCount: 10, upcomingDays: 30 }), { count: 10, days: 30 });
  // A stored value from a hand-edited settings file, or a future build, must not
  // produce a list of 900 chips or a negative horizon.
  assert.deepEqual(loadLimits({ upcomingCount: 900, upcomingDays: -1 }), { count: 5, days: 0 });
  assert.deepEqual(loadLimits({ upcomingCount: '5', upcomingDays: '14' }), { count: 5, days: 14 },
    'settings arrive as strings from a form');
});

test('the horizon is counted in calendar days, not 24h chunks', () => {
  // The filter's own arithmetic, extracted: with a 7-day horizon at 23:00, an
  // event at 08:00 seven sleeps away is INSIDE it. Counting 7×24h would drop it,
  // which is the one way a person would notice the difference.
  const now = new Date('2026-08-16T23:00:00').getTime();
  const horizon = (days) => {
    const end = new Date(now);
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + days + 1);
    return end.getTime();
  };
  const at = (iso) => new Date(iso).getTime();
  assert.ok(at('2026-08-23T08:00:00') < horizon(7), 'seven sleeps away is inside a 7-day horizon');
  assert.ok(at('2026-08-17T23:30:00') < horizon(7), 'and so is tomorrow night');
  assert.ok(at('2026-08-24T08:00:00') > horizon(7), 'the eighth day is outside it');
  assert.ok(at('2026-08-17T00:30:00') < horizon(1), 'just after midnight is tomorrow, not "1.04 days"');
});

test('the widget actually applies both, and the settings carry them', () => {
  const build = SRC.slice(SRC.indexOf('function _buildUpcomingInto('));
  const body = build.slice(0, build.indexOf('\n}\n'));
  assert.match(body, /upcomingLimits\(\)/, 'the list reads the limits');
  assert.match(body, /slice\(0, count\)/, 'the count is the cap, not a literal 5');
  assert.match(body, /at < until/, 'and the horizon actually filters');

  for (const file of ['../js/settings.js', '../server.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.match(src, /upcomingCount/, file + ' does not normalize upcomingCount');
    assert.match(src, /upcomingDays/, file + ' does not normalize upcomingDays');
  }
});

test('both settings are offered in every language', () => {
  const i18n = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
  for (const key of ['settings_upcoming_count', 'settings_upcoming_count_hint',
    'settings_upcoming_days', 'settings_upcoming_days_hint', 'settings_upcoming_days_any',
    'settings_upcoming_days_7', 'settings_upcoming_days_14', 'settings_upcoming_days_30']) {
    const n = i18n.split('\n').filter((l) => l.trimStart().startsWith(key + ':')).length;
    assert.equal(n, 11, key + ' is in ' + n + ' languages, expected 11');
  }
});
