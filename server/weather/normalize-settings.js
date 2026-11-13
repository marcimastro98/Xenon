// The weather settings as saved: the place, the provider, how often to refresh, how many days,
// and what the tile shows.

const { sanitizeWeatherCity } = require('./location.js');
const { WEATHER_PROVIDERS } = require('./providers.js');
const { WEATHER_FIELD_IDS } = require('./setting-values.js');
const { DEFAULT_HUB_SETTINGS } = require('../settings/defaults.js');

function normalizeSettingsWeather(value) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = source.mode === 'manual' ? 'manual' : DEFAULT_HUB_SETTINGS.weather.mode;
  const provider = WEATHER_PROVIDERS.has(source.provider) ? source.provider : DEFAULT_HUB_SETTINGS.weather.provider;
  const refreshMin = [10, 15, 30, 60, 120, 180].includes(Number(source.refreshMin))
    ? Number(source.refreshMin) : DEFAULT_HUB_SETTINGS.weather.refreshMin;
  const forecastDays = [1, 2, 3, 4, 5, 6, 7].includes(Number(source.forecastDays))
    ? Number(source.forecastDays) : DEFAULT_HUB_SETTINGS.weather.forecastDays;
  const srcTile = source.tile && typeof source.tile === 'object' ? source.tile : {};
  const defTile = DEFAULT_HUB_SETTINGS.weather.tile;
  // Mirrors of WEATHER_TILE_HEROES and WEATHER_TILE_LOOKS in js/settings.js.
  const tile = { hero: ['full', 'compact'].includes(srcTile.hero) ? srcTile.hero : defTile.hero, look: ['new', 'classic', 'custom'].includes(srcTile.look) ? srcTile.look : defTile.look };
  ['metrics', 'hourly', 'forecast'].forEach(k => { tile[k] = typeof srcTile[k] === 'boolean' ? srcTile[k] : defTile[k]; });
  const srcFields = srcTile.fields && typeof srcTile.fields === 'object' ? srcTile.fields : {};
  const fields = {};
  WEATHER_FIELD_IDS.forEach(id => { fields[id] = typeof srcFields[id] === 'boolean' ? srcFields[id] : true; });
  tile.fields = fields;
  return {
    mode,
    city: sanitizeWeatherCity(source.city),
    provider,
    refreshMin,
    forecastDays,
    tile,
  };
}

module.exports = { normalizeSettingsWeather };
