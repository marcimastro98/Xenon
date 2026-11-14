// Asks each weather service for the weather of a place, and the list of them by name.

const { APP_VERSION } = require('../updates/app-version.js');
const { WEATHER_FORECAST_MAX_DAYS } = require('./forecast-shape.js');
const { fetchJson } = require('../http/fetch-json.js');
const { normalizeWeather } = require('./wttr.js');
const { METNO_HEADERS, normalizeMetno } = require('./met-norway.js');
const { normalizeOpenMeteo } = require('./open-meteo.js');

// Provider fetchers — each resolves to a normalized object or null (never throws),
// so getWeather() can fall through to the next source.
async function fetchWttrWeather(ctx) {
  try {
    const raw = await fetchJson(`https://wttr.in${ctx.placePath}?format=j1&lang=${ctx.lang}`, 3500);
    const data = normalizeWeather(raw, ctx.lang);
    if (!data.ok) return null;
    data.source = 'wttr';
    return data;
  } catch { return null; }
}
async function fetchOpenMeteoWeather(ctx) {
  if (!Number.isFinite(ctx.lat) || !Number.isFinite(ctx.lon)) return null;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${ctx.lat}&longitude=${ctx.lon}`
      + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,precipitation,visibility,uv_index'
      + '&hourly=temperature_2m,weather_code,precipitation_probability,wind_speed_10m'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max'
      + `&timezone=auto&forecast_days=${WEATHER_FORECAST_MAX_DAYS}`;
    const raw = await fetchJson(url, 3500);
    return normalizeOpenMeteo(raw, ctx);
  } catch { return null; }
}
async function fetchMetnoWeather(ctx) {
  if (!Number.isFinite(ctx.lat) || !Number.isFinite(ctx.lon)) return null;
  try {
    const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${ctx.lat.toFixed(4)}&lon=${ctx.lon.toFixed(4)}`;
    const raw = await fetchJson(url, 3500, METNO_HEADERS(APP_VERSION));
    return normalizeMetno(raw, ctx);
  } catch { return null; }
}

const WEATHER_FETCHERS = {
  'open-meteo': fetchOpenMeteoWeather,
  'metno': fetchMetnoWeather,
  'wttr': fetchWttrWeather,
};

module.exports = { fetchWttrWeather, fetchOpenMeteoWeather, fetchMetnoWeather, WEATHER_FETCHERS };
