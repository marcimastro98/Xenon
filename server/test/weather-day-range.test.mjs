import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// The Weather days: a day's low and high sit over the two ends of its own coloured stretch of
// the bar, not at the ends of the whole track, so they read as that day's range. Both the
// stretch and the numbers are placed by --s and --e on the row's range, on the current tile,
// the classic look and the full Weather window.

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');
const PARTS = read('js', 'weather-tile', 'parts.js');
const CLASSIC = read('js', 'weather', 'weather-classic.js');
const TILE_CSS = read('components', 'WeatherTile', 'WeatherTile.css');
const CLASSIC_CSS = read('components', 'WeatherTile', 'WeatherClassic.css');
const MODAL_CSS = read('components', 'WeatherModal', 'WeatherModalBlocks.css');

// Just enough of an element for the day rows to be built and read back.
function fakeEl(tag) {
  const props = new Map();
  return {
    tag, className: '', textContent: '', title: '', dataset: {}, children: [],
    style: { setProperty: (k, v) => props.set(k, v), getPropertyValue: (k) => props.get(k) || '' },
    setAttribute() {},
    append(...kids) { this.children.push(...kids); },
    appendChild(kid) { this.children.push(kid); return kid; },
  };
}
const byClass = (node, cls) => node.children.find((c) => c.className.split(' ').includes(cls));

function buildDays(forecast) {
  const ctx = {
    document: { createElement: fakeEl },
    weatherForecastDays: () => 7,
    classifyWeatherState: () => 'sunny',
    WEATHER_DAY_NOON_MIN: 720,
    weatherStateIcon: (s) => s,
    WeatherArt: { svg: () => '' },
    WeatherOutlook: { tempColor: (c) => `t${c}` },
    weatherDisplayValue: (v, unit) => (v == null ? '--' : `${v}${unit}`),
    toDisplayTemp: (c) => (Number.isFinite(Number(c)) ? Math.round(Number(c)) : null),
    t: (k) => k,
    formatDate: (d) => d,
  };
  vm.createContext(ctx);
  vm.runInContext(PARTS, ctx);
  ctx.weatherDayName = (day, i) => (i === 0 ? 'Today' : day.date);
  return vm.runInContext('buildWeatherDays', ctx)({ forecast });
}

test('each day row puts its low and high over the ends of its own stretch of the bar', () => {
  const list = buildDays([
    { date: 'd1', minC: 0, maxC: 20 },
    { date: 'd2', minC: 5, maxC: 10 },
  ]);
  const [first, second] = list.children;
  for (const row of [first, second]) {
    assert.equal(byClass(row, 'weather-fc-min'), undefined, 'the low is no longer its own column');
    assert.equal(byClass(row, 'weather-fc-max'), undefined, 'the high is no longer its own column');
    const range = byClass(row, 'weather-fc-range');
    assert.ok(range, 'one range cell holds the numbers and the bar');
    const nums = byClass(range, 'weather-fc-nums');
    assert.deepEqual(nums.children.map((n) => n.className), ['weather-fc-min', 'weather-fc-max']);
    assert.ok(byClass(byClass(range, 'weather-fc-bar'), 'weather-fc-fill'));
  }
  const range = byClass(second, 'weather-fc-range');
  assert.equal(range.style.getPropertyValue('--s'), '25%');
  assert.equal(range.style.getPropertyValue('--e'), '50%');
  assert.deepEqual(byClass(range, 'weather-fc-nums').children.map((n) => n.textContent), ['5°', '10°']);
  const fill = byClass(byClass(range, 'weather-fc-bar'), 'weather-fc-fill');
  assert.equal(fill.style.getPropertyValue('--cold'), 't5');
  assert.equal(fill.style.getPropertyValue('--warm'), 't10');
});

test('a day without both temperatures leaves the stretch unplaced instead of guessing', () => {
  const [row] = buildDays([{ date: 'd1', maxC: 12 }]).children;
  const range = byClass(row, 'weather-fc-range');
  assert.equal(range.style.getPropertyValue('--s'), '');
  assert.deepEqual(byClass(range, 'weather-fc-nums').children.map((n) => n.textContent), ['--', '12°']);
});

test('no new global: the range is built inside the day builders', () => {
  assert.doesNotMatch(PARTS, /^function buildWeatherRange/m);
  assert.match(CLASSIC, /const rangeOf = \(day\) =>[\s\S]*'weather-fc-nums'/);
  assert.match(CLASSIC, /setProperty\('--s'/);
});

test('the stretch and the numbers both follow --s and --e, and the numbers stay inside the track', () => {
  for (const css of [TILE_CSS, CLASSIC_CSS]) {
    assert.match(css, /\.weather-fc-fill \{[^}]*left: var\(--s, 0%\);[^}]*right: calc\(100% - var\(--e, 100%\)\)/);
  }
  const nums = TILE_CSS.match(/\n\.weather-fc-nums \{([^}]*)\}/);
  assert.ok(nums, 'the numbers have their own lane');
  assert.match(nums[1], /--w: max\(calc\(var\(--e, 100%\) - var\(--s, 0%\)\), 9ch\)/, 'wide enough for both numbers');
  assert.match(nums[1], /margin-left: clamp\(0px, [^;]*, calc\(100% - var\(--w\)\)\)/, 'never past either end of the track');
});

test('every row grid is day, icon, range: no separate low and high columns left', () => {
  const grids = [TILE_CSS, CLASSIC_CSS, MODAL_CSS].flatMap((css) => [...css.matchAll(/\.weather-fc-row[^{]*\{[^}]*grid-template-columns:\s*([^;]+);/g)].map((m) => m[1]));
  assert.ok(grids.length >= 3);
  for (const g of grids) assert.doesNotMatch(g, /2\.\d+em\s*$/, `old trailing high column in: ${g}`);
  assert.match(MODAL_CSS, /\.weather-win-days :is\(\.weather-fc-day, \.weather-fc-nums\) \{ font-size: 15px; \}/);
});
