// Making the top bar's clock bigger.
//
// Asked for on Discord: "is there a way to customise the top heading where the
// date is? Ideally I would like to make the date larger". There wasn't — the
// clock offered a time FORMAT and nothing else, .clock-date was a hard 12px, the
// per-widget theme overrides are colours only, and there is no UI scale
// anywhere.
//
// Two multipliers rather than one: the time is already large and the date is
// deliberately the quiet half, so "bigger date" and "bigger clock" are different
// wishes and the person asking wanted the first.
//
// The part that is easy to get wrong is WHERE the size comes from. Each
// breakpoint draws its own clock — 45px on a desktop, 38px on a short screen,
// 24px on a phone — so a multiplier applied to one hard-coded number would
// either undo those or be undone by them. The base is a custom property per
// rule; the multiplier is applied once, on top of whichever base is in force.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const TOPBAR = read('../components/Topbar/Topbar.css');
const BREAKPOINTS = read('../styles/breakpoints.css');
const PHONE = read('../components/PhoneView/PhoneView.css');
const SETTINGS = read('../js/settings.js');
const SERVER = read('../server.js');
const HTML = read('../index.html');
const I18N = read('../js/i18n.js');
const CLOCK = read('../js/clock.js');
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

test('every piece of the time scales together', () => {
  // Digits, colon and the AM/PM suffix, plus the offsets tuned against them —
  // scale one and not the others and the clock comes apart at any value but 1.
  for (const sel of ['.clock-h,\n.clock-m {', '.clock-sep {', '.clock-ampm {']) {
    const at = TOPBAR.indexOf(sel);
    assert.ok(at >= 0, `${sel} is gone`);
    const body = TOPBAR.slice(at, TOPBAR.indexOf('}', at));
    assert.match(body, /--clock-base:\s*[\d.]+px/, `${sel} has no base to scale`);
    assert.match(body, /font-size: calc\(var\(--clock-base\) \* var\(--clock-time-scale, 1\)\)/);
  }
  const ampm = TOPBAR.slice(TOPBAR.indexOf('.clock-ampm {'));
  assert.match(ampm.slice(0, ampm.indexOf('}')), /margin-top: calc\(7px \* var\(--clock-time-scale, 1\)\)/,
    'the AM/PM offset is tuned against the digits and has to travel with them');
});

test('the date has its own multiplier', () => {
  const at = TOPBAR.indexOf('.clock-date {');
  const body = TOPBAR.slice(at, TOPBAR.indexOf('}', at));
  assert.match(body, /font-size: calc\(var\(--clock-base\) \* var\(--clock-date-scale, 1\)\)/);
  assert.ok(!body.includes('--clock-time-scale'), 'the date must not follow the time');
});

test('a short screen keeps its smaller base and still obeys the setting', () => {
  // This is the screen the request came from. A plain font-size here would win
  // over the formula and pin the Edge to one size.
  const block = BREAKPOINTS.slice(BREAKPOINTS.indexOf('@media (max-height: 720px)'));
  const body = block.slice(0, block.indexOf('\n}'));
  assert.match(body, /\.clock-m \{ --clock-base: 38px; \}/);
  assert.match(body, /\.clock-date \{ --clock-base: 11px; \}/);
  assert.ok(!/\.clock-(h|m|date|sep)[^{]*\{[^}]*font-size:/.test(body),
    'a hard font-size here overrides the user multiplier');
});

test('the phone is deliberately left out of it', () => {
  // A blown-up clock in a phone topbar pushes everything else off the row. The
  // phone sets font-size outright, which outranks the formula — on purpose.
  assert.match(PHONE, /\.is-phone \.topbar \.clock-m \{ font-size: 24px; \}/);
});

test('both values are clamped, on the client and on the server', () => {
  for (const [name, src] of [['client', SETTINGS], ['server', SERVER]]) {
    for (const key of ['clockScale', 'clockDateScale']) {
      assert.match(src, new RegExp(`${key}: clampNumber\\([\\w.]+\\.${key}, 0\\.8, 2,`),
        `${name} does not clamp ${key}`);
    }
  }
  assert.match(SETTINGS, /clockScale: 1,\n\s*clockDateScale: 1,/, 'the default is no longer the stock look');
});

test('the sliders are wired and reflected back', () => {
  for (const [id, key] of [['settings-clock-scale', 'clockScale'], ['settings-clock-date-scale', 'clockDateScale']]) {
    assert.ok(HTML.includes(`id="${id}"`), `${id} is missing`);
    assert.ok(HTML.includes(`updateSettingsRange('${key}', this.value)`), `${id} is not wired`);
    assert.ok(SETTINGS.includes(`['${id}', String(hubSettings.${key})]`), `${id} is never synced back`);
  }
  // updateSettingsRange refuses anything not on its allowlist.
  const fn = SETTINGS.slice(SETTINGS.indexOf('function updateSettingsRange'));
  const guard = fn.slice(0, fn.indexOf('includes(key)) return;'));
  for (const key of ['clockScale', 'clockDateScale']) {
    assert.ok(guard.includes(`'${key}'`), `${key} would be rejected by the allowlist`);
  }
});

test('it lives with the top bar, not in a second place to look', () => {
  // The clock group is in the Dynamic Island category, whose own hint is
  // "contenuti e stile della barra superiore" — the section that already owns
  // this bar. Somewhere else would be one more place to hunt through.
  const at = HTML.indexOf('id="settings-clock-scale"');
  // '<div class="settings-group ' with the trailing space: without it this finds
  // the nearer '<div class="settings-group-head">' instead.
  const group = HTML.lastIndexOf('<div class="settings-group ', at);
  assert.match(HTML.slice(group, at), /data-settings-cat="island"/);
  assert.ok(HTML.slice(group, at).includes('data-i18n="settings_clock_format"'),
    'size has drifted away from the format it belongs beside');
});

test('every language names both sliders', () => {
  for (const key of ['settings_clock_scale', 'settings_clock_date_scale', 'settings_clock_hint']) {
    const n = I18N.split('\n').filter((l) => {
      const t = l.trimStart();
      return t.startsWith(`${key}:`) || t.startsWith(`'${key}':`) || t.startsWith(`"${key}":`);
    }).length;
    assert.equal(n, LANGS.length, `${key} is defined ${n} times, expected ${LANGS.length}`);
  }
  // The group's hint promised only a format before there was a size.
  assert.ok(!/settings_clock_hint: 'time format'/.test(I18N));
});

// ── How much of the date the bar spells out ─────────────────────────────────
// The size sliders answered "I want to read the date across the room". The next
// thing that happens is the date at 200% eating half the bar, and wanting
// "11 Set" instead of "Venerdì, 11 Settembre".

test('the shorter forms are asked of Intl, never cut out of the long one', () => {
  // Every locale writes a date its own way - weekday first, month first, dots,
  // no comma - so slicing the formatted string produces nonsense in ten of the
  // eleven languages. en-US even swaps the halves: its short form is 09/11.
  assert.match(CLOCK, /const CLOCK_DATE_SHAPES = Object\.freeze\(\{/);
  for (const shape of ['full', 'medium', 'short']) {
    assert.ok(CLOCK.includes(`${shape}:`), `the ${shape} shape is gone`);
  }
  const block = CLOCK.slice(CLOCK.indexOf('CLOCK_DATE_SHAPES'), CLOCK.indexOf('});', CLOCK.indexOf('CLOCK_DATE_SHAPES')));
  assert.ok(!/slice\(|split\(|substring\(/.test(block), 'the date is being cut up rather than re-asked for');
  // full is what the bar has always shown, so it has to stay the default.
  assert.match(block, /full:\s*\{\s*weekday: 'long',\s*day: '2-digit',\s*month: 'long'\s*\}/);
  assert.match(SETTINGS, /clockDateFormat: 'full'/);
});

test('the formatter cache knows about the shape, not only the locale', () => {
  // Leaving the shape out of the key is how a setting change keeps drawing the
  // old date until the language happens to change.
  assert.match(CLOCK, /let _dateFmt = null, _dateFmtLocale = null, _dateFmtShape = null;/);
  assert.match(CLOCK, /if \(locale !== _dateFmtLocale \|\| shape !== _dateFmtShape\)/);
  assert.match(CLOCK, /_lastDate = null;/, 'without this the cached string survives the change');
});

test('an unknown shape falls back instead of throwing', () => {
  // hubSettings arrives from disk and from other surfaces; a name we do not have
  // must not index undefined into Intl.
  const fn = CLOCK.slice(CLOCK.indexOf('function clockDateShape'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /Object\.hasOwn\(CLOCK_DATE_SHAPES, name\) \? name : 'full'/);
});

test('the choice is validated on both sides and wired to the control', () => {
  for (const [name, src] of [['client', SETTINGS], ['server', SERVER]]) {
    assert.match(src, /clockDateFormat: \['full', 'medium', 'short'\]\.includes\(/, `${name} does not validate it`);
  }
  assert.match(SETTINGS, /function updateClockDateFormat\(fmt\)/);
  // Display-only, like the time format beside it: it has to redraw now, not at
  // the next tick, or the buttons move and the bar does not.
  const fn = SETTINGS.slice(SETTINGS.indexOf('function updateClockDateFormat'));
  assert.match(fn.slice(0, fn.indexOf('\n}')), /tickClock\(\)/);
  assert.match(SETTINGS, /\.settings-clock-date-format\[data-clock-date-format\]/, 'the control is never synced back');
  for (const v of ['full', 'medium', 'short']) {
    assert.ok(HTML.includes(`data-clock-date-format="${v}"`), `the ${v} button is missing`);
  }
});

test('it sits in the same group as the rest of the clock', () => {
  const at = HTML.indexOf('data-clock-date-format="full"');
  const group = HTML.lastIndexOf('<div class="settings-group ', at);
  assert.match(HTML.slice(group, at), /data-settings-cat="island"/);
});

test('every language names the date format and its three choices', () => {
  for (const key of ['settings_clock_date_format', 'settings_clock_date_full',
    'settings_clock_date_medium', 'settings_clock_date_short']) {
    const n = I18N.split('\n').filter((l) => {
      const t = l.trimStart();
      return t.startsWith(`${key}:`) || t.startsWith(`'${key}':`) || t.startsWith(`"${key}":`);
    }).length;
    assert.equal(n, LANGS.length, `${key} is defined ${n} times, expected ${LANGS.length}`);
  }
});
