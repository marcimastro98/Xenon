// One time format, everywhere.
//
// Settings → Clock → Time format has existed for a long time and reached
// exactly two places: the dashboard clock and the lock-screen clock. Every
// OTHER hour the app prints — the calendar, the upcoming list, the agenda, the
// Ambient scenes, the lock screen's event list, the football fixtures, the
// stock ticker, the Discord widget, the weather timestamp — built its own
// Intl.DateTimeFormat and let the LOCALE decide. So an English-speaking user
// who explicitly chose 24-hour still read "09:30 PM" in the calendar.
//
// Reported on Discord as "add a 12h/24h option to the Calendar widget". The
// option was already there; eleven places were not listening.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const JS_DIR = new URL('../js/', import.meta.url);
const read = (f) => readFileSync(new URL(f, JS_DIR), 'utf8');
const UTILS = read('utils.js');

test('the shared options carry the user choice, not the locale default', () => {
  const fn = UTILS.slice(UTILS.indexOf('function timeParts('));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /hour12: clockUses12h\(\)/, 'timeParts must resolve the setting, not omit it');
  // The date parts a caller wants have to survive, or every call site that
  // wanted a weekday or a month silently loses it.
  assert.match(body, /extra/, 'timeParts composes with the caller shape');
});

test('nothing formats an hour behind the setting back', () => {
  // A literal `hour:` option anywhere else is a formatter that decides for
  // itself — which is exactly the bug. utils.js holds the only one.
  const offenders = [];
  for (const f of readdirSync(JS_DIR).filter((n) => n.endsWith('.js'))) {
    if (f === 'utils.js') continue;
    const src = read(f);
    for (const [i, line] of src.split('\n').entries()) {
      if (/\bhour:\s*'(2-digit|numeric)'/.test(line)) offenders.push(f + ':' + (i + 1));
    }
  }
  assert.deepEqual(offenders, [],
    'these format an hour without timeParts(), so they ignore Settings → Time format');
});

test('every file that formats a time is loaded after the helper that defines it', () => {
  // timeParts lives in utils.js and is called from a dozen plain scripts. A
  // script tag ordered before it would throw on first paint rather than fall
  // back, so the order is part of the contract.
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const at = (f) => html.indexOf('js/' + f + '"');
  const utils = at('utils.js');
  assert.ok(utils > 0, 'utils.js is not loaded at all');
  for (const f of readdirSync(JS_DIR).filter((n) => n.endsWith('.js'))) {
    if (f === 'utils.js' || !read(f).includes('timeParts(')) continue;
    const pos = at(f);
    if (pos < 0) continue;             // not a dashboard script (worker, module, …)
    assert.ok(pos > utils, f + ' is loaded before utils.js, which defines timeParts');
  }
});

test('12 and 24 both come out of the same call', () => {
  // Run the real helper against a stubbed settings object — the one thing worth
  // proving is that the flag actually reaches Intl, in both directions.
  const src = UTILS.slice(UTILS.indexOf('function clockUses12h()'));
  const code = src.slice(0, src.indexOf('function toDateInputValue'));
  const make = (clockFormat, locale) => {
    const ctx = { hubSettings: { clockFormat }, t: (k) => (k === 'locale' ? locale : k) };
    const fn = new Function('hubSettings', 't', code + '; return timeParts;')(ctx.hubSettings, ctx.t);
    return fn();
  };
  const when = new Date(Date.UTC(2026, 0, 2, 21, 30));
  const fmt = (parts) => new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: 'UTC' }, parts)).format(when);
  assert.match(fmt(make('24', 'en-GB')), /21[:.]30/, 'an explicit 24 must beat an English locale');
  assert.match(fmt(make('12', 'it-IT')), /09[:.]30/, 'and an explicit 12 must beat an Italian one');
  assert.match(fmt(make('auto', 'en-GB')), /09[:.]30/, 'auto follows the language: English is 12h');
  assert.match(fmt(make('auto', 'it-IT')), /21[:.]30/, 'and every other language is 24h');
});
