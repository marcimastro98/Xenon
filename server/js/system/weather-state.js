// The state of the sky by day and by night, which weather facts are shown, and opening the weather
// window.
'use strict';

const WEATHER_CLEAR_CODES = new Set([113]);
const WEATHER_CLOUD_CODES = new Set([116, 119, 122]);
const WEATHER_FOG_CODES = new Set([143, 248, 260]);
const WEATHER_RAIN_CODES = new Set([176, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314, 353, 356, 359]);
const WEATHER_SNOW_CODES = new Set([179, 182, 185, 227, 230, 317, 320, 323, 326, 329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377]);
const WEATHER_STORM_CODES = new Set([200, 386, 389, 392, 395]);

function parseSunTime(str) {
  if (!str) return null;
  // 12h "h:mm AM/PM" (wttr.in) …
  const ampm = str.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const min = parseInt(ampm[2], 10);
    if (ampm[3].toUpperCase() === 'AM') { if (h === 12) h = 0; }
    else { if (h !== 12) h += 12; }
    return h * 60 + min;
  }
  // … or 24h "HH:MM" (Open-Meteo / MET Norway).
  const h24 = str.match(/^\s*(\d{1,2}):(\d{2})\s*$/);
  if (h24) {
    const h = parseInt(h24[1], 10);
    const min = parseInt(h24[2], 10);
    if (h >= 0 && h < 24 && min >= 0 && min < 60) return h * 60 + min;
  }
  return null;
}

// `atMin`: minutes since midnight of the moment asked about (an hour of the
// forecast); without it, now.
const WEATHER_DAY_NOON_MIN = 12 * 60;

function isWeatherNight(sunrise, sunset, atMin) {
  const now = new Date();
  const nowMin = Number.isFinite(atMin) ? atMin : now.getHours() * 60 + now.getMinutes();
  const riseMin = parseSunTime(sunrise);
  const setMin = parseSunTime(sunset);
  if (riseMin != null && setMin != null) return nowMin < riseMin || nowMin >= setMin;
  return nowMin < 6 * 60 || nowMin >= 20 * 60;
}

function weatherCodeState(code, sunrise, sunset, atMin) {
  const numeric = Number(code);
  if (!Number.isFinite(numeric)) return '';
  if (WEATHER_STORM_CODES.has(numeric)) return 'state-storm';
  if (WEATHER_SNOW_CODES.has(numeric)) return 'state-snow';
  if (WEATHER_RAIN_CODES.has(numeric)) return 'state-rain';
  if (WEATHER_FOG_CODES.has(numeric)) return 'state-fog';
  if (WEATHER_CLOUD_CODES.has(numeric)) return 'state-cloud';
  if (WEATHER_CLEAR_CODES.has(numeric)) return isWeatherNight(sunrise, sunset, atMin) ? 'state-moon' : 'state-sun';
  return '';
}

function classifyWeatherState(source, atMin) {
  const sunrise = source && typeof source === 'object' ? source.sunrise : null;
  const sunset = source && typeof source === 'object' ? source.sunset : null;
  const byCode = source && typeof source === 'object' ? weatherCodeState(source.code ?? source.weatherCode, sunrise, sunset, atMin) : '';
  if (byCode) return byCode;
  const text = String(source && typeof source === 'object' ? source.condition : source || '').toLowerCase();
  const night = isWeatherNight(sunrise, sunset, atMin);
  if (/thunder|storm|temporale|temporali/.test(text)) return 'state-storm';
  if (/snow|sleet|neve/.test(text)) return 'state-snow';
  if (/rain|drizzle|shower|piogg|rovesc/.test(text)) return 'state-rain';
  if (/fog|mist|nebbia/.test(text)) return 'state-fog';
  if (/cloud|overcast|nuvol|copert/.test(text)) return 'state-cloud';
  if (/clear|sun|sereno|sole/.test(text)) return night ? 'state-moon' : 'state-sun';
  return night ? 'state-moon' : 'state-cloud';
}

function weatherStateIcon(state) {
  if (state === 'state-sun') return 'sun';
  if (state === 'state-moon') return 'moon';
  if (state === 'state-rain') return 'rain';
  if (state === 'state-storm') return 'storm';
  if (state === 'state-snow') return 'snow';
  if (state === 'state-fog') return 'fog';
  return 'cloud';
}

const WEATHER_STATE_CLASSES = ['state-sun', 'state-moon', 'state-cloud', 'state-rain', 'state-storm', 'state-snow', 'state-fog', 'state-offline'];

function setWeatherStateClass(el, state) {
  if (!el) return;
  el.classList.remove(...WEATHER_STATE_CLASSES);
  el.classList.add(state);
}

// Drives the topbar pill's animated condition icon + tint. Called from
// applyWeather so it stays in sync even while the (modal-gated) details view
// is closed.
function applyWeatherPillState(data) {
  const state = data && data.ok ? classifyWeatherState(data) : 'state-offline';
  setWeatherStateClass($('weather-pill'), state);
  setWeatherStateClass($('weather-pill-icon'), state);
}

// How many days the "next days" forecast should render (1–7). The server returns
// up to 7 days; the client trims to the user's preference. Providers that expose
// fewer (wttr.in = 3) simply show what's available.
function weatherForecastDays() {
  const w = (typeof hubSettings === 'object' && hubSettings && hubSettings.weather) || {};
  const n = Math.round(Number(w.forecastDays));
  return Number.isFinite(n) ? Math.max(1, Math.min(7, n)) : 3;
}

// Whether a single detail chip/metric (feels, wind, visibility, pm25, …) is
// enabled. Missing keys default to shown, so pre-existing settings render all
// fields until the user hides one. Applies to both the tile and the modal.
function weatherFieldEnabled(id) {
  const w = (typeof hubSettings === 'object' && hubSettings && hubSettings.weather) || {};
  const tile = w.tile && typeof w.tile === 'object' ? w.tile : {};
  const fields = tile.fields && typeof tile.fields === 'object' ? tile.fields : {};
  return fields[id] !== false;
}

function aqiLabel(aqi) {
  const n = Number(aqi);
  if (!Number.isFinite(n)) return '--';
  if (n <= 20) return t('weather_aqi_good');
  if (n <= 40) return t('weather_aqi_fair');
  if (n <= 60) return t('weather_aqi_moderate');
  if (n <= 80) return t('weather_aqi_poor');
  if (n <= 100) return t('weather_aqi_very_poor');
  return t('weather_aqi_hazardous');
}

// Semantic severity per metric value → 'good' | 'moderate' | 'bad' (or '').
function weatherMetricLevel(metric, v) {
  if (v == null || v === '' || !Number.isFinite(Number(v))) return '';
  const n = Number(v);
  switch (metric) {
    case 'aqi':        return n <= 40 ? 'good' : n <= 60 ? 'moderate' : 'bad';   // the same steps as aqiLabel
    case 'pm25':       return n <= 12 ? 'good' : n <= 35 ? 'moderate' : 'bad';
    case 'pm10':       return n <= 54 ? 'good' : n <= 154 ? 'moderate' : 'bad';
    case 'no2':        return n <= 40 ? 'good' : n <= 100 ? 'moderate' : 'bad';
    case 'pollen':     return n <= 20 ? 'good' : n <= 50 ? 'moderate' : 'bad';
    case 'uv':         return n <= 2 ? 'good' : n <= 5 ? 'moderate' : 'bad';
    case 'humidity':   return (n >= 40 && n <= 60) ? 'good' : (n >= 30 && n <= 70) ? 'moderate' : 'bad';
    case 'visibility': return n >= 10 ? 'good' : n >= 4 ? 'moderate' : 'bad';
    default:           return '';
  }
}

// The window itself is js/weather-window.js. These two doors stay here because every page
// with this file answers them, also the ones that have no window to open.
let weatherWindowLetGo = null;

function toggleWeatherDetails() {
  const overlay = $('weather-overlay');
  if (!overlay) return;
  if (!overlay.hidden) { closeWeatherDetails(); return; }
  overlay.hidden = false;
  if (typeof window.ambientFreeze === 'function') window.ambientFreeze('weather', true);
  if (!weatherData) fetchWeather();
  renderWeatherDetails();
  if (window.DialogFocus) {
    weatherWindowLetGo = window.DialogFocus.hold(overlay.querySelector('.weather-panel'), { onEsc: closeWeatherDetails });
  }
}

function closeWeatherDetails() {
  const overlay = $('weather-overlay');
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  if (window.WeatherLook) window.WeatherLook.releaseWindow($('weather-content'));   // stop the user's widget
  if (typeof window.ambientFreeze === 'function') window.ambientFreeze('weather', false);
  if (weatherWindowLetGo) weatherWindowLetGo();
  weatherWindowLetGo = null;
}
