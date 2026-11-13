// Paints the weather in the units chosen, with what the tile shows when the weather cannot be read.
'use strict';

// A forecast that failed now says WHICH link broke. The server answers ok:false
// with an `error` (server.js getWeather) instead of a 500, because "unavailable"
// alone is indistinguishable from a bug in Xenon: the same blank tile means the
// PC never got its coordinates, or the city was not found, or the weather
// services were down — three different things to do about it, and the user was
// shown none of them. Unknown/absent error (a fetch that never reached the
// server) keeps the old generic wording.
const WEATHER_ERROR_KEYS = {
  no_location: 'weather_err_no_location',
  city_not_found: 'weather_err_city',
  providers_down: 'weather_err_providers',
};
function weatherErrorLabel(data) {
  const key = WEATHER_ERROR_KEYS[data && data.error];
  return key ? t(key) : t('weather_no_data');
}
function weatherErrorHint(data) {
  const key = WEATHER_ERROR_KEYS[data && data.error];
  return key ? t(`${key}_hint`) : t('weather_retry_hint');
}

// The last reading that actually arrived, kept so a failed poll degrades to
// "this is a bit old" instead of to nothing. A forecast is hours-scale data: the
// one from 15 minutes ago is still worth reading, and throwing it away turns a
// single missed request into a tile that looks broken. Bounded, because a
// forecast from this morning shown as if it were current is worse than an empty
// card — past the cap the failure is reported honestly.
let lastGoodWeather = null;
const WEATHER_STALE_MAX_MS = 3 * 60 * 60 * 1000;
// Well under the shortest refresh interval (10 min), so a hung request is
// abandoned long before the next poll is due rather than blocking it.
const WEATHER_FETCH_TIMEOUT_MS = 20 * 1000;
function weatherStaleFallback() {
  if (!lastGoodWeather) return null;
  const age = Date.now() - Number(lastGoodWeather.updatedAt || 0);
  if (!(age >= 0) || age > WEATHER_STALE_MAX_MS) return null;
  return { ...lastGoodWeather, stale: true };
}

// Pages that load this file for the System tile have no Weather tile or window to feed.
function refreshWeatherTile() {
  if (typeof renderWeatherTile === 'function') renderWeatherTile();
  if (typeof renderWeatherDetails === 'function') renderWeatherDetails();
}

function applyWeather(data) {
  if (data && data.ok && !data.stale) lastGoodWeather = data;
  weatherData = data || null;
  // Relay to granted SDK widgets/scenes. Weather is client-polled (no SSE
  // event); CustomWidget caches lastData so late-joining frames seed on hello.
  // Never relay a failure `null` — it would be cached and replayed to every
  // later frame; widgets only ever see server-built objects (ok:false included).
  if (window.CustomWidget && weatherData) CustomWidget.onData('weather', weatherData);
  const pill = $('weather-pill');
  if (!pill) { refreshWeatherTile(); return; }

  if (!data || !data.ok) {
    pill.classList.add('offline');
    $('weather-temp').textContent = '--°';
    $('weather-place').textContent = t('weather_unavailable');
    pill.title = [t('weather_unavailable'), weatherErrorLabel(data)].join(' · ');
    applyWeatherPillState(null);
    refreshWeatherTile();
    return;
  }

  pill.classList.toggle('offline', !!data.stale);
  $('weather-temp').textContent = `${toDisplayTemp(data.tempC)}°`;
  $('weather-place').textContent = data.location || t('weather_local');
  applyWeatherPillState(data);
  const parts = [data.condition, data.location, data.feelsC != null ? `${t('weather_feels')} ${toDisplayTemp(data.feelsC)}°${tempUnitSuffix()}` : '']
    .filter(Boolean);
  pill.title = parts.length ? parts.join(' · ') : t('weather_title');
  refreshWeatherTile();
}

function weatherDisplayValue(value, suffix = '') {
  return value === null || value === undefined || value === '' ? '--' : `${value}${suffix}`;
}

// Wind / precipitation / visibility follow the SAME unit choice as temperature
// (hubSettings.tempUnit): metric by default, imperial when the user picked °F —
// so choosing Fahrenheit gives mph / inches / miles too, instead of leaving
// these three stuck in metric (the reported "F but wind is in km/h" bug). The
// server always sends metric (km/h, mm, km); convert + suffix on render, so
// flipping the unit needs no re-fetch. Level thresholds still read the raw
// metric value — only the displayed number is converted.
function weatherIsImperial() {
  return weatherTempIsF();
}
function displayWind(kph) {
  if (kph === null || kph === undefined || kph === '') return '--';
  const v = Number(kph);
  if (!Number.isFinite(v)) return '--';
  return weatherIsImperial() ? `${Math.round(v * 0.621371)} mph` : `${kph} km/h`;
}
function displayPrecip(mm) {
  if (mm === null || mm === undefined || mm === '') return '--';
  const v = Number(mm);
  if (!Number.isFinite(v)) return '--';
  return weatherIsImperial() ? `${(v / 25.4).toFixed(2)} in` : `${mm} mm`;
}
function displayVisibility(km) {
  if (km === null || km === undefined || km === '') return '--';
  const v = Number(km);
  if (!Number.isFinite(v)) return '--';
  return weatherIsImperial() ? `${(v * 0.621371).toFixed(1)} mi` : `${km} km`;
}

function formatWeatherUpdated(timestamp) {
  const date = new Date(timestamp || Date.now());
  if (!Number.isFinite(date.getTime())) return '--';
  return `${t('weather_updated')} ${date.toLocaleTimeString(i18n[lang].locale, timeParts())}`;
}
