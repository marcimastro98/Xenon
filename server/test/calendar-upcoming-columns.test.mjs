// How many columns the Calendar tile's "Upcoming events" list is laid out in.
//
// The list is a CSS grid with `auto-fit` on a minimum column width, and that
// minimum was the width of a whole ITEM rather than of the event name inside it.
// An item spends ~70px on its dot, its two gaps, its padding and the time on the
// right, so a 130px minimum left the title about eight characters and put a
// second column in as soon as the tile passed ~265px.
//
// On a Xeneon Edge — wide, short, every tile narrow — that read as two columns of
// one word each: "FC Barcel…" beside "Levante - FC…". Reported with a screenshot,
// asking for one column regardless of width, or a setting to choose.
//
// Both: the automatic answer now only splits where a title survives the split,
// and `upcomingColumns` is the user overriding the question entirely.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const CAL_JS = read('../js/calendar.js');
const CAL_CSS = read('../components/CalendarView/CalendarView.css');
const BREAKPOINTS = read('../styles/breakpoints.css');
const SETTINGS = read('../js/settings.js');
const SERVER = read('../server.js');
const HTML = read('../index.html');
const I18N = read('../js/i18n.js');
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

/** The minimum column width a grid rule asks for, in px. */
function minTrack(css, selector) {
  const rule = css.split('\n').find((l) => l.includes(selector) && l.includes('auto-fit'))
    || css.slice(css.indexOf(selector)).split('}')[0];
  const m = rule.match(/minmax\(\s*(?:min\(\s*)?(\d+)px/);
  assert.ok(m, `no auto-fit minimum found for ${selector}`);
  return Number(m[1]);
}

test('a second column has to be wide enough to hold an event name', () => {
  // The reported titles ("FC Barcelona - Feyenoord") need ~230px of name after
  // the ~70px of furniture. Anything under that reintroduces the bug.
  assert.ok(minTrack(CAL_CSS, '.upcoming-list') >= 280,
    'the minimum column is back below the width of a readable title');
});

test('the compact breakpoint moves with it', () => {
  // Smaller type there, so a smaller number — but raising one and not the other
  // just relocates the one-word columns to a different tile size.
  const base = minTrack(CAL_CSS, '.upcoming-list');
  const compact = minTrack(BREAKPOINTS, '.upcoming-list');
  assert.ok(compact >= 240, `the compact minimum (${compact}px) is too small to hold a title`);
  assert.ok(compact <= base, 'the compact breakpoint should not ask for MORE than the base');
});

test('the track is capped at the tile, or a narrow tile clips its own times', () => {
  // A grid track never shrinks below its minimum, and .upcoming-block hides its
  // overflow — so a bare 300px minimum on a 200px tile silently cuts the time off
  // the right of every row.
  assert.match(CAL_CSS, /minmax\(min\(\d+px, 100%\), 1fr\)/);
  assert.match(BREAKPOINTS, /minmax\(min\(\d+px, 100%\), 1fr\)/);
  assert.match(CAL_CSS, /\.upcoming-block\s*\{[^}]*overflow:\s*hidden/s,
    'the block no longer clips — the cap may no longer be needed, re-check this');
});

test('one and two are exact, and cannot be pushed wider by a long name', () => {
  // minmax(0, 1fr), not 1fr: a track's automatic minimum is its content, so a
  // long title would widen the column past the tile and take the row with it.
  assert.match(CAL_CSS, /\.upcoming-list\[data-cols="1"\]\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(CAL_CSS, /\.upcoming-list\[data-cols="2"\]\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
  // The compact breakpoint would otherwise win over them on width alone.
  assert.match(BREAKPOINTS, /\.upcoming-list\[data-cols="1"\]/);
  assert.match(BREAKPOINTS, /\.upcoming-list\[data-cols="2"\]/);
});

test('the choice is stamped on the list, not on the page', () => {
  // Two Calendar tiles can be on screen at once (a second dashboard instance,
  // the phone view); a body-level attribute could not tell them apart.
  assert.match(CAL_JS, /function upcomingColumns\(\)/);
  assert.match(CAL_JS, /\[0, 1, 2\]\.includes\(Number\(s\.upcomingColumns\)\)/);
  assert.match(CAL_JS, /if \(cols\) list\.dataset\.cols = String\(cols\);/);
  assert.match(CAL_JS, /else delete list\.dataset\.cols;/,
    'going back to Automatic has to REMOVE the attribute, not set it to 0');
});

test('the setting survives both normalizers and a bad value', () => {
  for (const [name, src] of [['client', SETTINGS], ['server', SERVER]]) {
    assert.match(src, /upcomingColumns: \[0, 1, 2\]\.includes\(Number\(\w+\.upcomingColumns\)\)/,
      `${name} does not validate upcomingColumns`);
  }
  assert.match(SETTINGS, /upcomingColumns: 0,/, 'the default is no longer Automatic');
  assert.match(SERVER, /upcomingColumns: 0,/);
});

test('the control is in Settings, wired, and repaints at once', () => {
  assert.match(HTML, /id="settings-upcoming-cols"[^>]*onchange="updateUpcomingColumns\(this\.value\)"/);
  for (const v of ['0', '1', '2']) {
    assert.ok(HTML.includes(`<option value="${v}"`), `the ${v} option is missing`);
  }
  assert.match(SETTINGS, /function updateUpcomingColumns\(value\)/);
  // Display-only, like its two neighbours: the list has to redraw now, not at
  // the next calendar refresh.
  const fn = SETTINGS.slice(SETTINGS.indexOf('function updateUpcomingColumns'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /renderUpcoming\(\)/);
  assert.match(SETTINGS, /\['settings-upcoming-cols', hubSettings\.upcomingColumns\]/,
    'the control is never synced back from the saved value');
});

test('every language has all five strings', () => {
  const keys = ['settings_upcoming_cols', 'settings_upcoming_cols_hint',
    'settings_upcoming_cols_auto', 'settings_upcoming_cols_1', 'settings_upcoming_cols_2'];
  for (const lang of LANGS) {
    const start = I18N.indexOf(`Object.assign(i18n.${lang}, {`, I18N.indexOf('settings_upcoming_days_30'));
    const block = I18N.slice(I18N.indexOf(`Object.assign(i18n.${lang}, {\n  settings_upcoming_count`));
    const body = block.slice(0, block.indexOf('});'));
    for (const k of keys) {
      const has = body.split('\n').some((l) => {
        const t = l.trimStart();
        return t.startsWith(`${k}:`) || t.startsWith(`'${k}':`);
      });
      assert.ok(has, `${lang} is missing ${k}`);
    }
    assert.ok(start >= 0);
  }
});
