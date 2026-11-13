// In a short tile the month used to collapse: the events took their full height and
// six week rows shared what was left, a few pixels each, with the numbers drawn through
// one another. Reported from a desktop widget about 400px tall.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';

const css = readFileSync(new URL('../components/CalendarView/CalendarView.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('a week row keeps room for its number', () => {
  const rule = css.slice(css.indexOf('.calendar-days {\n  min-height'), css.indexOf('.day-cell {'));
  assert.match(rule, /grid-template-rows: repeat\(var\(--calendar-weeks, 5\), minmax\(24px, 1fr\)\)/);
  assert.match(rule, /grid-auto-rows: minmax\(24px, 1fr\)/);
});

test('the dots have their own lane under the number, on every day', () => {
  const cell = css.slice(css.indexOf('.day-cell {'), css.indexOf('}', css.indexOf('.day-cell {')));
  assert.match(cell, /padding: 0 0 4px;/);
  const dots = css.slice(css.indexOf('.day-dots {'), css.indexOf('}', css.indexOf('.day-dots {')));
  assert.match(dots, /bottom: 2px;/);
});

test('the month does not give way to the events, and nothing is lost: the pane scrolls', () => {
  assert.match(css, /\.cal-pane \.calendar-card \{ flex: 1 0 auto; \}/);
  assert.match(css, /\.cal-pane\[data-calpane="calendar"\] \{ overflow-y: auto; \}/);
  assert.match(css, /\.cal-pane\[data-calpane="calendar"\] \.upcoming-block \{ flex: 0 0 auto; \}/);
});

test('in a narrow tile the month buttons wrap instead of running off the card', () => {
  assert.match(css, /.calendar-nav {[^}]*flex-wrap: wrap;/);
});

test('the Calendar tile on its own does the same', () => {
  const panel = css.slice(css.indexOf('.calendar-panel {'), css.indexOf('}', css.indexOf('.calendar-panel {')));
  assert.match(panel, /overflow: hidden auto;/);
  assert.match(css, /\.calendar-panel > \.calendar-card \{ flex: 1 0 auto; \}/);
});

// The app's Zoom scales the whole window, so at 200% a tile has half its CSS width and
// the header was the first thing to give: the month broke in two lines, then the buttons
// took a line of their own and pushed the events out of the tile.
test('a narrow month keeps its header on one line with the short month name', () => {
  assert.match(css, /\.calendar-card \{[^}]*container-type: inline-size;/);
  assert.match(css, /\.calendar-month \{[^}]*white-space: nowrap;/);
  assert.match(css, /\.calendar-month-short \{ display: none; \}/);
  assert.match(css, /@container \(max-width: 280px\) \{\s*\.calendar-month-long \{ display: none; \}\s*\.calendar-month-short \{ display: inline; \}/);
});

test('the calendar writes the month both ways', () => {
  const js = readFileSync(new URL('../js/calendar.js', import.meta.url), 'utf8');
  assert.match(js, /_monthLabelSpan\(locale, \{ month: 'long', year: 'numeric' \}, 'calendar-month-long'\)/);
  assert.match(js, /thisYear \? \{ month: 'short' \} : \{ month: 'short', year: 'numeric' \}, 'calendar-month-short'/);
});
