// A forecast hour is a moon or a sun by ITS time, not by the time now: at 19:28
// every clear hour up to 02:00 used to show a sun while the hero showed the moon.
// A forecast day is its daytime, never a moon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../js/system.js', import.meta.url), 'utf8');
const from = SRC.indexOf('const WEATHER_CLEAR_CODES');
const to = SRC.indexOf('function weatherStateIcon');
const ctx = vm.createContext({});
vm.runInContext(`${SRC.slice(from, to)}\nglobalThis.api = { classifyWeatherState, isWeatherNight, WEATHER_DAY_NOON_MIN };`, ctx);
const { classifyWeatherState, isWeatherNight, WEATHER_DAY_NOON_MIN } = ctx.api;
const at = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

test('a clear hour follows its own time against the sun times', () => {
  const sun = { sunrise: '06:52', sunset: '17:08', code: 113 };
  assert.equal(classifyWeatherState(sun, at('22:00')), 'state-moon');
  assert.equal(classifyWeatherState(sun, at('02:00')), 'state-moon');
  assert.equal(classifyWeatherState(sun, at('12:00')), 'state-sun');
  assert.equal(classifyWeatherState(sun, at('17:08')), 'state-moon');
  assert.equal(classifyWeatherState(sun, at('06:52')), 'state-sun');
});

test('12h sun times from wttr.in work the same', () => {
  const sun = { sunrise: '06:52 AM', sunset: '05:08 PM', condition: 'Clear' };
  assert.equal(classifyWeatherState(sun, at('21:00')), 'state-moon');
  assert.equal(classifyWeatherState(sun, at('09:00')), 'state-sun');
});

test('without sun times the 6-20 fallback uses the asked time', () => {
  assert.equal(isWeatherNight(null, null, at('20:00')), true);
  assert.equal(isWeatherNight(null, null, at('05:59')), true);
  assert.equal(isWeatherNight(null, null, at('06:00')), false);
  assert.equal(isWeatherNight(null, null, at('19:59')), false);
});

test('a forecast day is its daytime', () => {
  assert.equal(classifyWeatherState({ code: 113, sunrise: '06:52', sunset: '17:08' }, WEATHER_DAY_NOON_MIN), 'state-sun');
  assert.equal(classifyWeatherState({ condition: 'Sunny' }, WEATHER_DAY_NOON_MIN), 'state-sun');
});

test('clouds and rain do not care about the time', () => {
  assert.equal(classifyWeatherState({ code: 116 }, at('23:00')), 'state-cloud');
  assert.equal(classifyWeatherState({ code: 296 }, at('03:00')), 'state-rain');
});

test('callers pass their own moment', () => {
  const hour = SRC.slice(SRC.indexOf('function createWeatherHour'));
  assert.match(hour.slice(0, 700), /parseSunTime\(hour\.time\)/);
  const day = SRC.slice(SRC.indexOf('function createWeatherDay'));
  assert.match(day.slice(0, 400), /classifyWeatherState\(day, WEATHER_DAY_NOON_MIN\)/);
  assert.match(SRC, /const state = classifyWeatherState\(day, WEATHER_DAY_NOON_MIN\);\n    row\.dataset\.weather/);
});
