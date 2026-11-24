// What the PC feeds the light effects that follow it (lights/pc-inputs.js): the load, the fans
// from Airflow or the sensors, sunrise and sunset and the weather from what Xenon holds, a timer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Pc = require('../lights/pc-inputs.js');
const { cpuRead } = require('../system/cpu-usage-state.js');
const { sensorCache } = require('../system/sensor-cache.js');
const { weatherCache } = require('../weather/cache.js');
const { timerState } = require('../time/timer-list.js');

const NOW = new Date(2026, 10, 23, 13, 0).getTime();
const asked = [];
Pc.sources.getWeather = (lang) => { asked.push(lang); return Promise.resolve(null); };
let airflow = null;
Pc.sources.airflow = () => airflow;
const sensors = (fans, age = 1000) => { sensorCache.reading = { ...sensorCache.reading, fans, updatedAt: NOW - age }; };
const weather = (data, age = 60_000) => { weatherCache.clear(); weatherCache.set('it|auto|auto|', { data, updatedAt: NOW - age }); };

test('the load is the processor as last read', () => {
  cpuRead.usage = 64;
  assert.deepEqual(Pc.inputs('load', NOW), { load: 0.64 });
  assert.deepEqual(Pc.inputs('level', NOW), {}, 'a level is the line\'s own, not read here');
});

test('the fans: Airflow while it reads them, else the sensors, pump and power supply left out', () => {
  sensors([{ name: 'CPU', rpm: 900, kind: 'mb' }, { name: 'PSU', rpm: 3000, kind: 'psu' }, { name: 'Off', rpm: 0, kind: 'mb' }]);
  airflow = { state: 'watching', at: NOW - 1000, fans: [{ rpm: 1000, kind: 'fan' }, { rpm: 1400, kind: 'fan' }, { rpm: 2800, kind: 'pump' }] };
  assert.deepEqual(Pc.inputs('fans', NOW), { fans: 1200 });
  airflow = { ...airflow, at: NOW - 6000 };
  assert.deepEqual(Pc.inputs('fans', NOW), { fans: 900 }, 'an old Airflow reading: the sensors');
  airflow = { ...airflow, state: 'unavailable', at: NOW };
  assert.deepEqual(Pc.inputs('fans', NOW), { fans: 900 });
  Pc.sources.airflow = () => { throw new Error('no Airflow'); };
  assert.deepEqual(Pc.inputs('fans', NOW), { fans: 900 });
  Pc.sources.airflow = () => airflow;
  sensors([{ name: 'CPU', rpm: 900, kind: 'mb' }], 20_000);
  assert.deepEqual(Pc.inputs('fans', NOW), { fans: null }, 'nothing fresh: no speed');
  assert.deepEqual(Pc.cannot(NOW), ['fans'], 'and the menu leaves the fans effect out');
  sensors([{ name: 'CPU', rpm: 900, kind: 'mb' }]);
  assert.deepEqual(Pc.cannot(NOW), []);
});

test('sun times as the weather services say them', () => {
  assert.equal(Pc.minutesOf('06:42'), 402);
  assert.equal(Pc.minutesOf('6:42 PM'), 1122);
  assert.equal(Pc.minutesOf('12:05 AM'), 5);
  assert.equal(Pc.minutesOf('12:30 pm'), 750);
  for (const bad of ['25:00', '7:61', 'dawn', '', null, undefined]) assert.equal(Pc.minutesOf(bad), null, String(bad));
});

test('the sky and the weather come from the newest answer Xenon holds', () => {
  weather({ code: 302, sunrise: '07:10', sunset: '4:50 PM' });
  assert.deepEqual(Pc.inputs('sky', NOW), { sky: { rise: 430, set: 1010 } });
  assert.deepEqual(Pc.inputs('weather', NOW), { weather: { kind: 'rain', night: false } });
  const evening = new Date(2026, 10, 23, 18, 0).getTime();
  weatherCache.set('it|auto|auto|', { data: { code: 338, sunrise: '07:10', sunset: '16:50' }, updatedAt: evening - 60_000 });
  assert.deepEqual(Pc.inputs('weather', evening), { weather: { kind: 'snow', night: true } }, 'after sunset: night');
  for (const [code, kind] of [[113, 'clear'], [116, 'clouds'], [248, 'fog'], [356, 'rain'], [200, 'storm'], ['389', 'storm']]) {
    weather({ code, sunrise: '07:10', sunset: '16:50' });
    assert.equal(Pc.inputs('weather', NOW).weather.kind, kind, String(code));
  }
  weather({ code: 999, sunrise: 'x', sunset: '16:50' });
  assert.deepEqual({ ...Pc.inputs('weather', NOW), ...Pc.inputs('sky', NOW) }, { weather: null, sky: null }, 'a code or time it does not know');
  weather({ code: 302, sunrise: '07:10', sunset: '16:50' }, 4 * 3600_000);
  assert.deepEqual(Pc.inputs('weather', NOW), { weather: null }, 'four hours old: the weather outside is not told');
  assert.deepEqual(Pc.inputs('sky', NOW), { sky: { rise: 430, set: 1010 } }, 'but sunrise still is');
});

test('the weather is asked for only when nothing fresh is held, at most every half hour', () => {
  asked.length = 0;
  weather({ code: 113, sunrise: '07:10', sunset: '16:50' }, 10 * 60_000);
  Pc.inputs('weather', NOW + 1);
  weatherCache.clear();
  const t0 = NOW + 10 * 3600_000;
  Pc.inputs('sky', t0);
  Pc.inputs('weather', t0 + 1000);
  Pc.inputs('weather', t0 + 29 * 60_000);
  Pc.inputs('weather', t0 + 31 * 60_000);
  return new Promise((done) => setImmediate(() => { assert.deepEqual(asked, ['en', 'en']); done(); }));
});

test('a timer: the countdown nearest its end, running ones first; a stopwatch never', () => {
  const t = (o) => ({ kind: 'countdown', durationSecs: 100, status: 'running', startedAt: Date.now(), pausedElapsed: 0, ...o });
  timerState.list = [t({ pausedElapsed: 50 }), t({ pausedElapsed: 75 }), t({ status: 'paused', pausedElapsed: 95 }), t({ kind: 'stopwatch', durationSecs: 0 })];
  const left = Pc.inputs('timer', NOW).timer.left;
  assert.ok(Math.abs(left - 0.25) < 0.01, `a quarter left (${left})`);
  timerState.list = [t({ status: 'paused', pausedElapsed: 60 }), t({ status: 'done' })];
  assert.deepEqual(Pc.inputs('timer', NOW), { timer: { left: 0.4 } }, 'none running: the paused one');
  timerState.list = [t({ kind: 'stopwatch', durationSecs: 0 })];
  assert.deepEqual(Pc.inputs('timer', NOW), { timer: null });
});
