// "All the dots in the monthly view are green, both under the days and next to the
// events in Upcoming. When I click on the day, the events have the correct dots."
//
// Each external calendar has a colour (Settings → External calendars) and every
// external event carries it. Only the list of a single day drew with it; the month
// grid and the Upcoming list painted every dot in the accent colour. All three
// places now ask one helper, and a day with events from several calendars shows
// one dot per colour, at most three.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// LF only, so slices find their ends on a CRLF (Windows) checkout too.
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('../js/calendar.js');
const CSS = read('../components/CalendarView/CalendarView.css');

const fn = (name, deps = '') => {
  const a = SRC.indexOf(`function ${name}(`);
  assert.ok(a >= 0, `${name} not found`);
  const b = SRC.indexOf('\n}\n', a);
  return SRC.slice(a, b + 2);
};
const { eventDotColor, dayDotColors } = new Function(
  fn('eventDotColor') + '\n' + fn('dayDotColors') + '\nreturn { eventDotColor, dayDotColors };')();

const FEEDS = [
  { id: 'f-green', color: '#1ed760' },
  { id: 'f-purple', color: '#a855f7' },
  { id: 'f-orange', color: '#f59e0b' },
];
const ev = (source, color) => ({ id: 'e', title: 'x', source, color });

test('an event wears the colour of its calendar, as it is now in Settings', () => {
  assert.equal(eventDotColor(ev('f-purple', '#a855f7'), FEEDS), '#a855f7');
  // The colour was just changed in Settings and the events have not been fetched
  // again (that takes up to 5 minutes): the dot follows the setting.
  assert.equal(eventDotColor(ev('f-purple', '#1ed760'), FEEDS), '#a855f7');
});

test('a calendar that is gone falls back to the colour the event carries; a local event has none', () => {
  assert.equal(eventDotColor(ev('f-deleted', '#14b8a6'), FEEDS), '#14b8a6');
  assert.equal(eventDotColor({ id: 'l', title: 'mine' }, FEEDS), '', 'a local event keeps the accent dot');
  assert.equal(eventDotColor(ev('f-green'), null), '', 'no feed list, no colour on the event');
  assert.equal(eventDotColor(null, FEEDS), '');
  assert.equal(eventDotColor(ev('f-green'), [{ id: 'f-green', color: '' }]), '', 'a feed without a colour gives nothing');
});

test('a day shows one dot per calendar colour, in the order of the events, at most three', () => {
  assert.deepEqual(dayDotColors([ev('f-purple'), ev('f-orange'), ev('f-green')], FEEDS), ['#a855f7', '#f59e0b', '#1ed760']);
  assert.deepEqual(dayDotColors([ev('f-green'), ev('f-green'), ev('f-green')], FEEDS), ['#1ed760'], 'the same calendar three times is one dot');
  assert.deepEqual(dayDotColors([ev('f-purple'), ev('f-green'), ev('f-purple'), ev('f-orange')], FEEDS), ['#a855f7', '#1ed760', '#f59e0b']);
  const six = [...FEEDS.map((f) => ev(f.id)), ev('x1', '#111111'), ev('x2', '#222222'), ev('x3', '#333333')];
  assert.equal(dayDotColors(six, FEEDS).length, 3, 'capped');
  assert.equal(dayDotColors(six, FEEDS, 2).length, 2, 'the cap can be given');
});

test('local events and calendar events on one day are told apart; a day with none has no dots', () => {
  assert.deepEqual(dayDotColors([{ id: 'l' }, ev('f-purple')], FEEDS), ['', '#a855f7'], 'accent for the local one, purple for the other');
  assert.deepEqual(dayDotColors([{ id: 'l' }, { id: 'm' }], FEEDS), [''], 'two local events are one accent dot');
  assert.deepEqual(dayDotColors([], FEEDS), []);
  assert.deepEqual(dayDotColors(null, FEEDS), []);
});

// ── The three places use it ────────────────────────────────────────────────

test('the month grid draws one dot per colour, the Upcoming dot and the day list use the same helper', () => {
  const grid = SRC.slice(SRC.indexOf('function _buildCalendarInto('), SRC.indexOf('function renderCalendar('));
  assert.match(grid, /dots\.className = 'day-dots';/);
  assert.match(grid, /dots\.setAttribute\('aria-hidden', 'true'\);/, 'decoration, not content');
  assert.match(grid, /for \(const color of dayDotColors\(dayEvents, _calendarFeedsNow\(\), 3\)\)/);
  assert.match(grid, /if \(color\) dot\.style\.setProperty\('--dot', color\);/);
  assert.doesNotMatch(grid, /eventsForDate\(dateValue\)\.length/, 'the day is looked up once, not twice');
  const upcoming = SRC.slice(SRC.indexOf('function _buildUpcomingInto('), SRC.indexOf('\n}\n', SRC.indexOf('function _buildUpcomingInto(')));
  assert.match(upcoming, /const dotColor = eventDotColor\(e, _calendarFeedsNow\(\)\);\n\s+if \(dotColor\) dot\.style\.setProperty\('--dot', dotColor\);/);
  const modal = SRC.slice(SRC.indexOf('function renderDayModalEvents('), SRC.indexOf('\n}\n', SRC.indexOf('function renderDayModalEvents(')));
  assert.match(modal, /const badgeColor = eventDotColor\(event, _calendarFeedsNow\(\)\);/);
  assert.doesNotMatch(modal, /badge\.style\.background = event\.color/);
});

test('the dots take the colour from --dot, glow included, and keep the accent when there is none', () => {
  assert.doesNotMatch(CSS, /\.day-cell\.has-events::after/, 'the single pseudo-element dot is gone');
  assert.match(CSS, /\.day-dots \{\n  position: absolute;\n  left: 50%;\n  bottom: 3px;\n  display: flex;\n  gap: 3px;/);
  assert.match(CSS, /\.day-dot \{[^}]*background: var\(--dot, var\(--green\)\);[^}]*box-shadow: 0 0 10px color-mix\(in srgb, var\(--dot, var\(--accent\)\) 55%, transparent\);/s);
  const up = CSS.slice(CSS.indexOf('.upcoming-dot {'), CSS.indexOf('}', CSS.indexOf('.upcoming-dot {')));
  assert.match(up, /background: var\(--dot, var\(--green\)\);/);
  assert.match(up, /color-mix\(in srgb, var\(--dot, var\(--accent\)\) 50%, transparent\)/);
  assert.match(read('../styles/breakpoints.css'), /body\[data-panel="media"\] \.day-dot \{ width: 3px; height: 3px; \}/);
});
