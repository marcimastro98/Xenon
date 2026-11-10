import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

// The Weather window: the tile's parts at full size, on the sheet every dialog uses. It has
// to say what happened when there is nothing to show, and it must not stay on "loading".

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const TILE = read('js', 'weather-tile.js');
const WINDOW = read('js', 'weather-window.js');
const SYSTEM = read('js', 'system.js');
const DOORS = SYSTEM.slice(SYSTEM.indexOf('let weatherWindowLetGo'), SYSTEM.indexOf('async function fetchWeather'));

const FINE = {
  ok: true, location: 'Lisbon', region: 'Lisboa', country: 'Portugal', condition: 'Partly cloudy', state: 'state-cloud',
  tempC: 21, feelsLikeC: 20, updatedAt: 1, sunrise: '06:58', sunset: '19:12', humidity: 60, windKmph: 12,
  forecast: [{ date: '2026-11-07', minC: 12, maxC: 22, condition: 'Sunny' }, { date: '2026-11-08', minC: 11, maxC: 19, condition: 'Rain' }],
};

function rig({ data = FINE, fetching = false, hidden = false, settings = true, focus = true } = {}) {
  const dom = makeDom();
  const el = (id) => { const node = dom.mkEl('div'); node.id = id; return node; };
  const overlay = el('weather-overlay');
  const panel = dom.mkEl('section');
  panel.className = 'weather-panel';
  overlay.appendChild(panel);
  overlay.hidden = hidden;
  const ids = {
    'weather-overlay': overlay,
    'weather-modal-title': el('weather-modal-title'),
    'weather-modal-updated': el('weather-modal-updated'),
    'weather-content': el('weather-content'),
  };
  const calls = { freeze: [], held: [], letGo: 0, fetched: 0, opened: [], order: [] };
  const window = {
    ambientFreeze: (token, on) => calls.freeze.push([token, on]),
    DialogFocus: focus ? { hold: (root, options) => { calls.held.push({ root, options }); return () => { calls.letGo += 1; }; } } : undefined,
  };
  const ctx = {
    document: dom.document,
    window,
    $: (id) => ids[id] || null,
    t: (key) => key,
    i18n: { en: { locale: 'en-GB' } },
    lang: 'en',
    weatherData: data,
    fetchingWeather: fetching,
    WeatherArt: { svg: () => '' },
    WeatherOutlook: require('../js/weather-outlook.js'),
    parseSunTime: (text) => { const m = /^(\d+):(\d+)/.exec(text || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; },
    isWeatherNight: () => false,
    classifyWeatherState: (source) => source.state || 'state-cloud',
    weatherStateIcon: () => 'cloud',
    WEATHER_DAY_NOON_MIN: 720,
    clockUses12h: () => false,
    plainHourParts: ({ minutes = true } = {}) => ({ hour: 'numeric', ...(minutes ? { minute: '2-digit' } : {}), hourCycle: 'h23' }),
    toDisplayTemp: (c) => c,
    weatherDisplayValue: (value, suffix = '') => (value === null || value === undefined || value === '' ? '--' : `${value}${suffix}`),
    weatherMetricLevel: () => 'good',
    weatherFieldEnabled: () => true,
    weatherForecastDays: () => 3,
    displayWind: (v) => `${v} km/h`,
    displayPrecip: (v) => `${v} mm`,
    displayVisibility: (v) => `${v} km`,
    aqiLabel: () => 'Fair',
    formatWeatherUpdated: () => 'Updated 10:00',
    weatherErrorLabel: (d) => (d ? `label:${d.error}` : 'label:none'),
    weatherErrorHint: (d) => (d ? `hint:${d.error}` : 'hint:none'),
    fetchWeather: async () => { calls.fetched += 1; calls.order.push('fetch'); },
    ...(settings ? { openSettings: (category) => calls.opened.push(category) } : {}),
  };
  vm.createContext(ctx);
  vm.runInContext(`${TILE}\n${WINDOW}\n${DOORS}`, ctx);
  const content = ids['weather-content'];
  const all = (cls) => dom.descendants(content).filter((node) => node.classList.contains(cls));
  return { ctx, ids, overlay, panel, content, all, calls };
}

test('now, the hours, the days, the details, in that order', () => {
  const r = rig();
  r.ctx.renderWeatherDetails();
  assert.equal(r.ids['weather-modal-title'].textContent, 'Lisbon, Lisboa, Portugal');
  assert.equal(r.ids['weather-modal-updated'].textContent, 'Updated 10:00');
  assert.deepEqual(r.content.children.map((node) => node.className), ['weather-win-main', 'weather-win-side']);
  assert.equal(r.all('weather-win-temp')[0].textContent, '21°');
  assert.deepEqual(r.content.children[1].children.map((node) => node.className), ['weather-win-block weather-win-days', 'weather-win-block weather-win-facts']);
});

test('the window takes the tile\'s parts, so the two cannot disagree', () => {
  const r = rig();
  r.ctx.renderWeatherDetails();
  assert.equal(r.all('weather-fc-row').length, 2);
  assert.equal(r.all('weather-now-range').length, 1);
  assert.ok(r.all('weather-fact').length > 2);
});

test('a day name opens with a capital, whatever the language writes', () => {
  const r = rig();
  r.ctx.i18n.en.locale = 'it-IT';
  assert.equal(r.ctx.weatherDayName({ date: '2026-11-08' }, 1), 'Dom');
  r.ctx.i18n.en.locale = 'ru-RU';
  assert.equal(r.ctx.weatherDayName({ date: '2026-11-08' }, 1), 'Вс');
  assert.equal(r.ctx.weatherDayName({ date: 'soon' }, 1), 'soon', 'a date nobody can read stays as it came');
});

test('the day column takes the longest name, and stops at a third of the row', () => {
  const r = rig();
  r.ctx.renderWeatherDetails();
  assert.equal(r.all('weather-forecast--rows')[0].style.getPropertyValue('--wx-name'), `${r.ctx.weatherDayName(FINE.forecast[0], 0).length}ch`);
  for (const css of [read('components', 'WeatherTile', 'WeatherTile.css'), read('components', 'WeatherModal', 'WeatherModal.css')]) {
    assert.match(css, /grid-template-columns: minmax\(max\([\d.]+em, min\(var\(--wx-name, 0px\), 34%\)\), 0\.9fr\)/);
  }
});

test('the word for now is not cut on the hour axis', () => {
  const css = read('components', 'WeatherTile', 'WeatherTile.css');
  assert.ok(css.includes('.weather-hours-axis span:first-child { overflow: visible;'));
  assert.ok(css.includes('.weather-hours-axis span:nth-child(even) { visibility: hidden; }'), 'the room it takes is the hidden label beside it');
});

test('a day keeps its condition readable on its row', () => {
  const r = rig();
  r.ctx.renderWeatherDetails();
  assert.deepEqual(r.all('weather-fc-row').map((row) => row.title), ['Sunny', 'Rain']);
});

test('sunrise and sunset open the details, side by side on one row', () => {
  const r = rig();
  r.ctx.renderWeatherDetails();
  const facts = r.all('weather-fact').map((node) => node.textContent);
  assert.match(facts[0], /^weather_sunrise/);
  assert.match(facts[1], /^weather_sunset/);
});

test('a sun time nobody can read is left out, not shown as nonsense', () => {
  const r = rig({ data: { ...FINE, sunrise: 'n/a', sunset: '' } });
  r.ctx.renderWeatherDetails();
  assert.doesNotMatch(r.all('weather-facts')[0].textContent, /weather_sun/);
});

test('a forecast with no days and no hours leaves no empty block', () => {
  const r = rig({ data: { ...FINE, forecast: [], hourly: [] } });
  r.ctx.renderWeatherDetails();
  assert.equal(r.all('weather-win-days').length, 0);
  assert.equal(r.all('weather-win-hours').length, 0);
});

test('an old reading says so in the line under the place', () => {
  const r = rig({ data: { ...FINE, stale: true } });
  r.ctx.renderWeatherDetails();
  assert.equal(r.ids['weather-modal-updated'].classList.contains('is-stale'), true);
  const fresh = rig();
  fresh.ctx.renderWeatherDetails();
  assert.equal(fresh.ids['weather-modal-updated'].classList.contains('is-stale'), false);
});

test('with no reading yet it says it is loading, and only then', () => {
  const r = rig({ data: null, fetching: true });
  r.ctx.renderWeatherDetails();
  assert.equal(r.content.textContent, 'weather_loading');
  assert.equal(r.ids['weather-modal-title'].textContent, 'weather_title');
  assert.equal(r.ids['weather-modal-updated'].textContent, '');
  const failed = rig({ data: null, fetching: false });
  failed.ctx.renderWeatherDetails();
  assert.match(failed.content.textContent, /label:none/);
});

test('a failed request stops counting as loading before the window is drawn', () => {
  const body = SYSTEM.slice(SYSTEM.indexOf('async function fetchWeather'));
  const caught = body.slice(body.indexOf('} catch {'));
  assert.ok(caught.indexOf('fetchingWeather = false') < caught.indexOf('applyWeather('));
});

test('a wrong city leads to Settings and to the Weather page', () => {
  for (const error of ['no_location', 'city_not_found']) {
    const r = rig({ data: { ok: false, error } });
    r.ctx.renderWeatherDetails();
    assert.equal(r.all('weather-win-trouble-title')[0].textContent, `label:${error}`);
    assert.equal(r.all('weather-win-trouble-hint')[0].textContent, `hint:${error}`);
    r.all('weather-win-key')[0].click();
    assert.deepEqual(r.calls.opened, ['weather']);
    assert.equal(r.overlay.hidden, true);
  }
});

test('a service that is down offers no key: Settings would not fix it', () => {
  const r = rig({ data: { ok: false, error: 'providers_down' } });
  r.ctx.renderWeatherDetails();
  assert.equal(r.all('weather-win-key').length, 0);
});

test('a page with no Settings offers no key to a door that is not there', () => {
  const r = rig({ data: { ok: false, error: 'no_location' }, settings: false });
  r.ctx.renderWeatherDetails();
  assert.equal(r.all('weather-win-key').length, 0);
});

test('a closed window draws nothing', () => {
  const r = rig({ hidden: true });
  r.ctx.renderWeatherDetails();
  assert.equal(r.content.children.length, 0);
});

test('the refresh key shows it is working and is never disabled', async () => {
  const r = rig();
  const key = { busy: [], setAttribute(k, v) { this.busy.push([k, v]); }, removeAttribute(k) { this.busy.push([k]); } };
  await r.ctx.refreshWeatherWindow(key);
  assert.deepEqual(key.busy, [['aria-busy', 'true'], ['aria-busy']]);
  assert.equal(r.calls.fetched, 1);
});

test('opening holds the focus and freezes what paints under it, closing gives both back', () => {
  const r = rig({ hidden: true });
  r.ctx.toggleWeatherDetails();
  assert.equal(r.overlay.hidden, false);
  assert.deepEqual(r.calls.freeze, [['weather', true]]);
  assert.equal(r.calls.held[0].root, r.panel);
  r.calls.held[0].options.onEsc();
  assert.equal(r.overlay.hidden, true);
  assert.deepEqual(r.calls.freeze, [['weather', true], ['weather', false]]);
  assert.equal(r.calls.letGo, 1);
});

test('the second tap on the same door closes it', () => {
  const r = rig({ hidden: true });
  r.ctx.toggleWeatherDetails();
  r.ctx.toggleWeatherDetails();
  assert.equal(r.overlay.hidden, true);
  assert.equal(r.calls.letGo, 1);
});

test('closing what is already closed releases nothing twice', () => {
  const r = rig({ hidden: true });
  r.ctx.closeWeatherDetails();
  assert.deepEqual(r.calls.freeze, []);
  r.ctx.toggleWeatherDetails();
  r.ctx.closeWeatherDetails();
  r.ctx.closeWeatherDetails();
  assert.equal(r.calls.letGo, 1);
  assert.equal(r.calls.freeze.length, 2);
});

test('with no reading the first request starts before the window is drawn', () => {
  const r = rig({ data: null, hidden: true });
  const render = r.ctx.renderWeatherDetails;
  r.ctx.renderWeatherDetails = () => { r.calls.order.push('render'); render(); };
  r.ctx.toggleWeatherDetails();
  assert.deepEqual(r.calls.order, ['fetch', 'render']);
});

test('a page with no DialogFocus still opens and closes', () => {
  const r = rig({ hidden: true, focus: false });
  r.ctx.toggleWeatherDetails();
  assert.equal(r.overlay.hidden, false);
  r.ctx.closeWeatherDetails();
  assert.equal(r.overlay.hidden, true);
});

test('pages that have the doors but no window answer them', () => {
  const dom = makeDom();
  const ctx = { $: () => null, window: {}, document: dom.document, weatherData: null };
  vm.createContext(ctx);
  vm.runInContext(DOORS, ctx);
  ctx.toggleWeatherDetails();
  ctx.closeWeatherDetails();
});

test('a reading reaches the window through the same guard as the tile', () => {
  assert.match(SYSTEM, /function refreshWeatherTile\(\) \{[^}]*renderWeatherTile\(\);\s*if \(typeof renderWeatherDetails === 'function'\) renderWeatherDetails\(\);/);
  const calls = SYSTEM.match(/\brenderWeatherDetails\(\)/g) || [];
  assert.equal(calls.length, 2, 'the guard and the door, nothing a page without the window would trip on');
});

test('Esc belongs to the window: the page has no branch of its own', () => {
  assert.doesNotMatch(read('js', 'main.js'), /weather-overlay/);
});

test('a layer page gets the window with its frame and its focus', () => {
  const entry = read('js', 'layer-tiles.js').split('\n').find((line) => line.includes('weather:'));
  assert.ok(entry.indexOf('js/weather-tile.js') < entry.indexOf('js/weather-window.js'));
  assert.ok(entry.includes('js/dialog-focus.js'));
  assert.ok(entry.includes('styles/liquid-sheets.css'));
});

test('nothing data-driven reaches innerHTML', () => {
  assert.doesNotMatch(WINDOW, /innerHTML/);
});

test('every new word is there in all eleven languages', () => {
  const i18n = read('js', 'i18n.js');
  for (const key of ['weather_sunrise', 'weather_sunset', 'weather_open_settings', 'weather_loading']) {
    const hits = i18n.match(new RegExp(`(?:^|[\\s,{"])${key}"?\\s*:`, 'gm')) || [];
    assert.equal(hits.length, 11, key);
  }
});
