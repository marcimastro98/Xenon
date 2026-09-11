// Celsius or Fahrenheit, told to widgets.
//
// Asked by a widget author building a monitor tile: "does the SDK pass the
// temperature unit?" It did not. Xenon has had the setting since long before the
// SDK, and every temperature it reports is Celsius — so a widget printing °C on
// a dashboard where the clock, the weather and the lock screen all say °F was
// wrong in a way its author could not see from their own machine.
//
// Sent like `lang`, and for the same reason: it is a preference the host holds
// and the widget renders from, so the host has to say when it changes rather
// than leaving the widget on whatever was true when it mounted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BRIDGE = readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const DOC = readFileSync(new URL('../../docs/WIDGET_SDK.md', import.meta.url), 'utf8');

// The reader is pure, so what it does with a missing or junk setting can be run.
const tempUnit = (hubSettings) => {
  const at = BRIDGE.indexOf('function tempUnit() {');
  assert.notEqual(at, -1, 'js/custom-widget.js must still define tempUnit');
  const end = BRIDGE.indexOf('\n  }', at) + 4;
  // eslint-disable-next-line no-new-func
  return new Function('hubSettings', `${BRIDGE.slice(at, end)}; return tempUnit();`)(hubSettings);
};

test("the user's choice is what a widget is told", () => {
  assert.equal(tempUnit({ tempUnit: 'f' }), 'f');
  assert.equal(tempUnit({ tempUnit: 'c' }), 'c');
});

test('anything that is not Fahrenheit is Celsius', () => {
  // Celsius is what Xenon reports and what the setting defaults to, so an
  // unreadable value must not become a third state a widget has to handle.
  for (const hs of [{}, null, undefined, { tempUnit: '' }, { tempUnit: 'F' }, { tempUnit: 'kelvin' }, { tempUnit: 1 }]) {
    assert.equal(tempUnit(hs), 'c', JSON.stringify(hs));
  }
});

test('it arrives at mount, in init', () => {
  assert.match(BRIDGE, /lang: langCode\(\),\n        tempUnit: tempUnit\(\),/);
});

test('a change is pushed, not left to the next reload', () => {
  // The lesson from `lang`: a widget author reads the field at init, does the
  // right thing with it, and is still wrong the moment the user changes it.
  assert.match(BRIDGE, /function refreshTempUnit\(\)/);
  assert.match(BRIDGE, /post\(entry, \{ type: 'tempUnit', tempUnit: unit \}\)/);
  assert.match(BRIDGE, /refreshTheme, refreshLang, refreshTempUnit,/,
    'and it must be exported, or nothing can call it');
  assert.match(SETTINGS, /window\.CustomWidget\.refreshTempUnit\(\)/);
  const at = SETTINGS.indexOf('function updateTempUnit(');
  const body = SETTINGS.slice(at, SETTINGS.indexOf('\n}', at));
  assert.match(body, /refreshTempUnit/, 'pushed from the same place the dashboard repaints itself');
});

test('the values stay Celsius — this says how to show them, not what they are', () => {
  // The pair only works because one half never moves. If Xenon converted on the
  // way out, a widget could not tell 30 °C from 30 °F without reading the field
  // anyway, and every existing widget would silently start lying.
  assert.match(DOC, /\*\*The numbers are not converted, and will not be\.\*\*/);
  assert.ok(!/tempUnit/.test(BRIDGE.slice(BRIDGE.indexOf('function themePayload'), BRIDGE.indexOf('function themePayload') + 1200)),
    'the theme payload must not carry it either — it is not styling');
});

test('the guide documents the message and the conversion', () => {
  assert.match(DOC, /### 3d-bis\. `tempUnit` — Celsius or Fahrenheit/);
  assert.match(DOC, /\{ xenonSdk: 1, type: 'tempUnit', tempUnit: 'f' \}/);
  assert.match(DOC, /c \* 9 \/ 5 \+ 32/, 'a widget author should not have to look up the formula');
});
