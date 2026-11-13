import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { appStringsSource } from './i18n-source.mjs';

// The Weather tile: one thing that changes next, the hours as columns, the days with their
// real temperatures, and the details that matter. It sits on the tile's sheet with no sky of
// its own, because the painted card is what people called a waste of the space (GitHub #130).

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const Outlook = require('../js/weather-outlook.js');
const TILE = read('js', 'weather-tile.js');
const SYSTEM = read('js', 'system.js');
const CSS = read('components', 'WeatherTile', 'WeatherTile.css');
const MODAL_CSS = read('components', 'WeatherModal', 'WeatherModal.css');
const LIQUID = read('styles', 'liquid-tiles.css');
const INDEX = read('index.html');
const I18N = appStringsSource();

const hour = (min, state = 'state-cloud', rain = 0) => ({ min, state, rain });
const day = (...states) => states.map((state, i) => hour(600 + i * 60, state));

test('rain coming says when it starts, and the hour under way does not count', () => {
  assert.deepEqual(Outlook.nextChange(day('state-rain', 'state-cloud', 'state-rain'), 'state-cloud'), { kind: 'rain', mode: 'from', at: 2 });
});

test('rain falling says when it stops, or that it stays', () => {
  assert.deepEqual(Outlook.nextChange(day('state-rain', 'state-rain', 'state-cloud'), 'state-rain'), { kind: 'rain', mode: 'until', at: 2 });
  assert.deepEqual(Outlook.nextChange(day('state-storm', 'state-storm', 'state-storm'), 'state-storm'), { kind: 'storm', mode: 'long', span: 2 });
});

test('snow and storms keep their own word', () => {
  assert.equal(Outlook.nextChange(day('state-cloud', 'state-snow'), 'state-cloud').kind, 'snow');
  assert.equal(Outlook.nextChange(day('state-cloud', 'state-storm'), 'state-cloud').kind, 'storm');
});

test('a likely shower counts even when the picture is only a cloud', () => {
  const hours = [hour(600), hour(660, 'state-cloud', 49), hour(720, 'state-cloud', 50)];
  assert.deepEqual(Outlook.nextChange(hours, 'state-cloud'), { kind: 'rain', mode: 'from', at: 2 });
});

test('a dry stretch names the hours it really covers, across midnight and on three-hour steps', () => {
  assert.deepEqual(Outlook.nextChange([hour(1320), hour(1380), hour(0), hour(60)], 'state-sun'), { kind: 'rain', mode: 'dry', span: 3 });
  assert.equal(Outlook.nextChange([hour(540), hour(720), hour(900)], 'state-sun').span, 6);
  assert.equal(Outlook.nextChange([hour(null), hour(null), hour(null)], 'state-sun').span, 3);
});

test('without hours to read there is nothing to say', () => {
  assert.equal(Outlook.nextChange([], 'state-sun'), null);
  assert.equal(Outlook.nextChange([hour(600)], 'state-sun'), null);
  assert.equal(Outlook.nextChange(null, 'state-sun'), null);
});

test('the hour under way is known, also just after midnight', () => {
  assert.equal(Outlook.isCurrentHour(600, 630), true);
  assert.equal(Outlook.isCurrentHour(600, 660), false);
  assert.equal(Outlook.isCurrentHour(1380, 1439), true);
  assert.equal(Outlook.isCurrentHour(1380, 5), false);
  assert.equal(Outlook.isCurrentHour(null, 600), false);
});

test('a temperature always has a colour, and hot is not cold', () => {
  assert.match(Outlook.tempColor(20), /^rgb\(\d+ \d+ \d+\)$/);
  assert.equal(Outlook.tempColor(-40), Outlook.tempColor(-10));
  assert.equal(Outlook.tempColor(60), Outlook.tempColor(40));
  assert.notEqual(Outlook.tempColor(0), Outlook.tempColor(35));
  assert.match(Outlook.tempColor('nothing'), /^rgb\(/);
});

test('a warning comes first, the rest keep their order', () => {
  const facts = [{ id: 'a' }, { id: 'b', warn: true }, { id: 'c' }];
  assert.deepEqual(Outlook.orderFacts(facts).map((f) => f.id), ['b', 'a', 'c']);
});

// The tile's own reading of the data, with what it borrows from the page stubbed.
function tile(extra = {}) {
  const ctx = {
    WeatherOutlook: Outlook,
    i18n: { en: { locale: 'en-GB' } },
    lang: 'en',
    t: (key) => key,
    parseSunTime: (text) => { const m = /^(\d+):(\d+)/.exec(text || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; },
    isWeatherNight: () => false,
    classifyWeatherState: (source) => source.state || 'state-cloud',
    clockUses12h: () => false,
    plainHourParts: ({ minutes = true } = {}) => ({ hour: 'numeric', ...(minutes ? { minute: '2-digit' } : {}), hourCycle: 'h23' }),
    toDisplayTemp: (c) => c,
    weatherDisplayValue: (value, suffix = '') => (value === null || value === undefined || value === '' ? '--' : `${value}${suffix}`),
    weatherMetricLevel: (_metric, value) => (value > 100 ? 'bad' : 'good'),
    weatherFieldEnabled: () => true,
    displayWind: (v) => `${v} km/h`,
    displayPrecip: (v) => `${v} mm`,
    displayVisibility: (v) => `${v} km`,
    aqiLabel: () => 'Fair',
    ...extra,
  };
  vm.createContext(ctx);
  vm.runInContext(TILE, ctx);
  return ctx;
}

const clock = (offset) => {
  const at = new Date(Date.now() + offset * 3600e3);
  return `${String(at.getHours()).padStart(2, '0')}:00`;
};

test('the first hour says now and carries the reading, so the two numbers never disagree', () => {
  const { weatherHourRows } = tile();
  const rows = weatherHourRows({ tempC: 21, state: 'state-sun', hourly: [{ time: clock(0), tempC: 19 }, { time: clock(1), tempC: 18 }] });
  assert.equal(rows[0].label, 'weather_now');
  assert.equal(rows[0].tempC, 21);
  assert.equal(rows[0].state, 'state-sun');
  assert.equal(rows[1].tempC, 18);
});

test('a forecast that starts later than now does not call its first hour now', () => {
  const { weatherHourRows } = tile();
  const rows = weatherHourRows({ tempC: 21, hourly: [{ time: clock(3), tempC: 19 }, { time: clock(4), tempC: 18 }] });
  assert.notEqual(rows[0].label, 'weather_now');
  assert.equal(rows[0].tempC, 19);
});

test('the next line picks the string for the change and fills the time', () => {
  const { weatherNextLine } = tile({ t: (key) => `${key} {time}{n}` });
  const hours = [{ min: 600, state: 'state-cloud' }, { min: 660, state: 'state-rain' }];
  const line = weatherNextLine({ state: 'state-cloud' }, hours);
  assert.equal(line.wet, true);
  assert.match(line.text, /^weather_next_rain_from 11:00/);
  assert.equal(weatherNextLine({ state: 'state-sun' }, [hours[0], hours[0]]).wet, false);
  assert.equal(weatherNextLine({ state: 'state-sun' }, []), null);
});

test('a reading the provider did not send is left out, a bad one goes first', () => {
  const { weatherFacts } = tile();
  const ids = weatherFacts({ windKph: 12, humidity: 50, aqi: 150, uv: null, pressure: '', visibility: undefined }).map((f) => f.id);
  assert.deepEqual(ids, ['aqi', 'wind', 'humidity']);
});

test('a detail turned off in Settings stays off', () => {
  const { weatherFacts } = tile({ weatherFieldEnabled: (id) => id !== 'wind' });
  assert.deepEqual(weatherFacts({ windKph: 12, humidity: 50 }).map((f) => f.id), ['humidity']);
});

test('a zero that tells nothing leaves, a zero that means something stays', () => {
  const { weatherFacts } = tile();
  const ids = weatherFacts({ precipMM: 0, uv: 0, pollen: 0, windKph: 0, humidity: 0 }).map((f) => f.id);
  assert.deepEqual([...ids].sort(), ['humidity', 'wind']);
  assert.ok(weatherFacts({ precipMM: 1.2 }).some((f) => f.id === 'rain'));
});

test('only a warning can be a warning: wind and humidity never turn amber', () => {
  const { weatherFacts } = tile({ weatherMetricLevel: () => 'bad' });
  const facts = weatherFacts({ humidity: 95, pm25: 90 });
  assert.equal(facts.find((f) => f.id === 'humidity').warn, false);
  assert.equal(facts.find((f) => f.id === 'pm25').warn, true);
});

test('every change the line can name exists in all 11 languages', () => {
  const keys = ['weather_now', 'weather_high', 'weather_low', 'weather_next_dry'];
  for (const kind of ['rain', 'snow', 'storm']) for (const mode of ['from', 'until', 'long']) keys.push(`weather_next_${kind}_${mode}`);
  for (const key of keys) {
    assert.equal((I18N.match(new RegExp(`\\b${key}\\s*:`, 'g')) || []).length, 11, key);
  }
});

test('the dashboard and a widget window both load everything the tile needs', () => {
  for (const script of ['js/weather-art.js', 'js/weather-outlook.js', 'js/weather-tile.js']) {
    assert.ok(INDEX.includes(`<script src="${script}"></script>`), script);
  }
  assert.ok(INDEX.includes('href="components/WeatherTile/WeatherTile.css"'));
  const line = read('js', 'layer-tiles.js').split('\n').find((l) => /^\s*weather: \{/.test(l));
  for (const part of ['components/WeatherTile/WeatherTile.css', 'js/weather-art.js', 'js/weather-outlook.js', 'js/weather-tile.js']) {
    assert.ok(line.includes(part), part);
  }
});

test('pages with system.js but no Weather tile do not trip over it', () => {
  const calls = SYSTEM.match(/\brenderWeatherTile\(\)/g) || [];
  assert.equal(calls.length, 1, 'the one call sits behind the guard');
  assert.match(SYSTEM, /function refreshWeatherTile\(\) \{\s*if \(typeof renderWeatherTile === 'function'\) renderWeatherTile\(\);/);
});

test('the tile paints no sky and runs no loop', () => {
  assert.doesNotMatch(CSS, /animation|@keyframes/);
  assert.doesNotMatch(TILE, /weather-hero-visual|weather-viz/);
  assert.doesNotMatch(LIQUID, /weather-tile|weather-hero/, 'one look on every style, nothing to override');
  assert.doesNotMatch(MODAL_CSS, /animation|@keyframes/, 'the window paints no sky either');
  assert.doesNotMatch(MODAL_CSS, /^\.weather-tile|^\.weather-fc-|weather-widget-mount/m, 'the full view reaches the tile\'s parts only from inside its own blocks');
});

test('nothing data-driven reaches innerHTML', () => {
  const uses = TILE.match(/.*innerHTML.*/g) || [];
  assert.deepEqual(uses.map((line) => line.trim()), ['art.innerHTML = WeatherArt.svg(state, night);']);
});

test('days leave whole, never half a row', () => {
  for (const rule of ['.weather-forecast--rows']) {
    const body = CSS.slice(CSS.indexOf(`\n${rule} {`), CSS.indexOf('}', CSS.indexOf(`\n${rule} {`)));
    assert.match(body, /flex-flow: column wrap/, rule);
    assert.match(body, /overflow: hidden/, rule);
    assert.match(body, /min-height: var\(--wx-/, rule);
  }
});

// A grid one row high (hours) or as many rows as its height holds (details): what does not fit
// lands in rows of no height and is clipped, so an hour or a detail is whole or gone.
test('hours and details leave whole, never cut', () => {
  const body = (rule) => {
    const at = CSS.indexOf(`\n${rule} {`);
    return CSS.slice(at, CSS.indexOf('}', at));
  };
  const hours = body('.weather-hours');
  assert.ok(hours.includes('grid-template-columns: repeat(auto-fit, minmax(var(--wx-col), 1fr));'));
  assert.ok(hours.includes('grid-auto-rows: 0;'));
  assert.ok(hours.includes('overflow: hidden;'));
  const facts = body('.weather-facts');
  assert.ok(facts.includes('grid-template-rows: repeat(auto-fit, var(--wx-fact));'));
  assert.ok(facts.includes('grid-auto-rows: 0;'));
  assert.ok(facts.includes('overflow: hidden;'));
  assert.ok(facts.includes('min-height: var(--wx-fact);'), 'never shorter than one whole row');
});

test('a detail reads label over value, in columns wide enough for its label', () => {
  const fact = CSS.slice(CSS.indexOf('\n.weather-fact {'), CSS.indexOf('}', CSS.indexOf('\n.weather-fact {')));
  assert.ok(fact.includes('flex-direction: column;'));
  assert.ok(CSS.includes('grid-template-columns: repeat(auto-fill, minmax(min(118px, 100%), 1fr));'));
});

test('white pictures get a darker sky on a light sheet', () => {
  const light = CSS.slice(CSS.indexOf(':root[data-appearance="light"] :is(.weather-tile-panel, .weather-panel)'));
  for (const token of ['--sky-cloud-top', '--sky-cloud-low', '--sky-drop', '--sky-flake', '--sky-haze', '--sky-moon-top']) {
    assert.ok(light.includes(token), token);
    assert.ok(read('js', 'weather-art.js').includes(`var(${token}`), token);
  }
});
