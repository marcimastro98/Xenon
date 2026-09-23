import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Asked for on GitHub #130: "Is there a way to not waste that entire screen space
// (weather widget) on that blue background with a moon (I just want the next
// hours/days, with a summary of the current temp/feels like + stuff on the
// right)". And, once the wide side-by-side layout was offered instead: "don't
// really want to go sideways, need that space".
//
// So `weather.tile.hero` is 'full' (the big card, still the default) or
// 'compact' (one line). Weather settings are server-owned — POST
// /api/weather/config is their only writer — so the value has to survive BOTH
// normalizers, or the choice silently snaps back to the big card on the next
// hydrate.

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const SETTINGS = read('js', 'settings.js');
const SERVER = read('server.js');
const SYSTEM = read('js', 'system.js');
const CSS = read('components', 'WeatherModal', 'WeatherModal.css');
const I18N = read('js', 'i18n.js');
const INDEX = read('index.html');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  let depth = 0;
  const open = src.indexOf('{', start);
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

const DEF_TILE = { hero: 'full', metrics: true, hourly: true, forecast: true };

function clientTile() {
  const heroes = SETTINGS.match(/const WEATHER_TILE_HEROES = Object\.freeze\((\[[^\]]*\])\)/);
  assert.ok(heroes, 'WEATHER_TILE_HEROES is declared in settings.js');
  const body = [
    `const WEATHER_TILE_HEROES = ${heroes[1]};`,
    "const WEATHER_TILE_SECTIONS = ['metrics', 'hourly', 'forecast'];",
    "const WEATHER_FIELD_IDS = ['feels'];",
    `const DEFAULT_HUB_SETTINGS = { weather: { tile: ${JSON.stringify(DEF_TILE)} } };`,
    extractFunction(SETTINGS, 'normalizeWeatherTile'),
    'return normalizeWeatherTile;',
  ].join('\n');
  return new Function(body)();
}

function serverWeather() {
  const body = [
    "const WEATHER_PROVIDERS = new Set(['auto']);",
    "const WEATHER_FIELD_IDS = ['feels'];",
    'const sanitizeWeatherCity = (v) => String(v || "");',
    `const DEFAULT_HUB_SETTINGS = { weather: { mode: 'auto', provider: 'auto', refreshMin: 30, forecastDays: 3, tile: ${JSON.stringify(DEF_TILE)} } };`,
    extractFunction(SERVER, 'normalizeSettingsWeather'),
    'return normalizeSettingsWeather;',
  ].join('\n');
  return new Function(body)();
}

test('the big card stays the default on both sides', () => {
  assert.match(SETTINGS, /tile: Object\.freeze\(\{ hero: 'full',/);
  assert.match(SERVER, /tile: Object\.freeze\(\{ hero: 'full',/);
  assert.equal(clientTile()({}).hero, 'full');
  assert.equal(serverWeather()({}).tile.hero, 'full');
});

test('compact survives the client and the server normalizer', () => {
  assert.equal(clientTile()({ hero: 'compact' }).hero, 'compact');
  assert.equal(serverWeather()({ tile: { hero: 'compact' } }).tile.hero, 'compact');
});

test('anything else falls back to the big card rather than to a broken tile', () => {
  const c = clientTile();
  const s = serverWeather();
  for (const bad of ['tiny', '', null, 1, true, { hero: 'compact' }]) {
    assert.equal(c({ hero: bad }).hero, 'full');
    assert.equal(s({ tile: { hero: bad } }).tile.hero, 'full');
  }
});

test('the server accepts exactly the values the client offers', () => {
  const client = SETTINGS.match(/const WEATHER_TILE_HEROES = Object\.freeze\((\[[^\]]*\])\)/)[1];
  const server = SERVER.match(/const tile = \{ hero: (\[[^\]]*\])\.includes\(srcTile\.hero\)/);
  assert.ok(server, 'server.js normalizeSettingsWeather validates tile.hero');
  assert.deepEqual(new Function(`return ${server[1]}`)(), new Function(`return ${client}`)());
});

test('the compact bar is still the button that opens the full view', () => {
  const fn = extractFunction(SYSTEM, 'buildWeatherCompactBar');
  assert.match(fn, /document\.createElement\('button'\)/);
  assert.match(fn, /toggleWeatherDetails\(\)/);
  // Each stat honours the same per-field toggle as the big card's chips, and
  // feels-like sits with the temperature rather than among the extras.
  assert.match(fn, /weatherFieldEnabled\(id\)/);
  assert.match(fn, /weatherFieldEnabled\('feels'\)/);
  assert.match(fn, /weather-compact-chevron/);
  assert.match(extractFunction(SYSTEM, 'renderWeatherTile'),
    /sec\.compact \? buildWeatherCompactBar\(data\) : buildWeatherHeroCard\(data\)/);
});

test('narrow tiles never shed feels-like', () => {
  const compact = CSS.slice(CSS.indexOf('/* ── Compact hero: current conditions on one line'));
  for (const m of compact.matchAll(/@container \(max-width: \d+px\) \{([^}]*)\}/g)) {
    assert.doesNotMatch(m[1], /feels|weather-compact-text/, 'feels-like is the one value the request named');
  }
});

test('a compact tile never goes side by side', () => {
  // "don't really want to go sideways" — the landscape layout must not claim it.
  const landscape = CSS.slice(CSS.indexOf('@container (min-width: 560px) and (min-aspect-ratio: 13/10) {'));
  const block = landscape.slice(0, landscape.indexOf('\n}'));
  assert.match(block, /\.weather-tile-root\.has-body:not\(\.weather-tile-root--compact\) \{ flex-direction: row;/);
  assert.doesNotMatch(block, /\.weather-tile-root\.has-body \{/);
});

test('the setting has a control and every language names it', () => {
  assert.match(INDEX, /onclick="updateWeatherTileHero\('full'\)"/);
  assert.match(INDEX, /onclick="updateWeatherTileHero\('compact'\)"/);
  for (const key of ['settings_weather_hero', 'settings_weather_hero_hint',
    'settings_weather_hero_full', 'settings_weather_hero_compact']) {
    const defs = I18N.match(new RegExp(`("?)${key}\\1\\s*:`, 'g')) || [];
    assert.equal(defs.length, 11, `${key} should be translated in all 11 languages`);
  }
});
