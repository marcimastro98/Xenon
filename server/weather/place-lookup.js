// Finds the place the weather is asked for: the city the person typed, or where the PC seems to
// be.

const { sanitizeWeatherCity, pickWeatherLocationResult } = require('./location.js');
const { writeFileAtomic } = require('../files/atomic-write.js');
const { weatherLocationCache } = require('./cache.js');
const { WEATHER_CACHE_MS, WEATHER_GEO_FAIL_COOLDOWN_MS } = require('./timings.js');
const { fetchJson } = require('../http/fetch-json.js');
const { GEO_IP_SOURCES, normalizeGeoIpValue } = require('./geo-ip.js');
const { WEATHER_GEO_FILE } = require('./geo-file.js');
const { weatherGeo } = require('./auto-place-state.js');
const { loadPersistedAutoLocation } = require('./auto-place-load.js');

// Recover real coordinates for a manual city that open-meteo's structured
// geocoder rejected — a full address or place name like
// "Bücherei Wien Hütteldorfer Straße 130d". The user must never have to know or
// type coordinates: wttr.in's geocoder is far more lenient (it resolves freeform
// strings the structured one won't) and its response carries the matched point's
// lat/lon. Reusing those coordinates lets the coordinate-only providers
// (MET Norway / Open-Meteo — the full 7-day forecast) run, instead of the widget
// silently degrading to wttr's own 3-day feed. Language-independent, unlike
// matching localized city names ("Wien" vs "Vienna"). Returns a place or null.
async function recoverWeatherPlaceViaWttr(requestedCity, lang) {
  let raw;
  // wttr answers plain text ("Unknown location…") for a real miss, so a JSON
  // parse failure here just means "not found" — fall through to null, never throw.
  try { raw = await fetchJson(`https://wttr.in/${encodeURIComponent(requestedCity)}?format=j1&lang=${lang}`, 3500); }
  catch { return null; }
  const area = raw && Array.isArray(raw.nearest_area) && raw.nearest_area[0] || null;
  const lat = Number(area && area.latitude);
  const lon = Number(area && area.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Keep the user's own text as the displayed name (what they typed) and just
  // attach the recovered coordinates so the richer providers can run.
  return { placePath: `/${lat.toFixed(4)},${lon.toFixed(4)}`, resolvedCity: requestedCity, lat, lon };
}

async function resolveManualWeatherPlace(city, lang) {
  const requestedCity = sanitizeWeatherCity(city);
  if (!requestedCity) return { placePath: '', resolvedCity: '' };

  const cacheKey = `${lang}|${requestedCity.toLowerCase()}`;
  const cached = weatherLocationCache.get(cacheKey);
  if (cached && (Date.now() - cached.updatedAt) < WEATHER_CACHE_MS) return cached.value;

  let value = {
    placePath: `/${encodeURIComponent(requestedCity)}`,
    resolvedCity: requestedCity,
    lat: NaN,
    lon: NaN,
  };

  try {
    const query = encodeURIComponent(requestedCity);
    const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${query}&count=10&language=${lang}&format=json`, 3000);
    const match = pickWeatherLocationResult(geo && geo.results, requestedCity);
    const latitude = Number(match && match.latitude);
    const longitude = Number(match && match.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      value = {
        placePath: `/${latitude.toFixed(4)},${longitude.toFixed(4)}`,
        resolvedCity: [match.name, match.admin1, match.country].filter(Boolean).join(', ') || requestedCity,
        lat: latitude,
        lon: longitude,
      };
    }
  } catch {
    // Fall back to the raw city name when geocoding is unavailable.
  }

  // The exact string didn't resolve to coordinates (a full address / place
  // name). Try to recover the intended city from its words so MET Norway /
  // Open-Meteo can still run (7-day forecast) instead of the widget quietly
  // dropping to wttr.in's 3 days — without asking the user for coordinates.
  if (!Number.isFinite(value.lat) || !Number.isFinite(value.lon)) {
    try {
      const recovered = await recoverWeatherPlaceViaWttr(requestedCity, lang);
      if (recovered) value = recovered;
    } catch { /* keep the raw-name value; wttr can still self-geolocate */ }
  }

  // Keyed on the city a request names, so it is bounded: the oldest goes first.
  if (weatherLocationCache.size >= 200) weatherLocationCache.delete(weatherLocationCache.keys().next().value);
  weatherLocationCache.set(cacheKey, { value, updatedAt: Date.now() });
  return value;
}

async function resolveAutoLocation() {
  if (!weatherGeo.load) weatherGeo.load = loadPersistedAutoLocation();
  await weatherGeo.load;
  if (weatherGeo.place.value && (Date.now() - weatherGeo.place.updatedAt) < WEATHER_CACHE_MS) {
    return weatherGeo.place.value;
  }
  // After a failed lookup, don't pay the fetch timeout again on every forecast
  // refresh — serve the last known place immediately and retry after a cooldown.
  if (Date.now() - weatherGeo.failAt < WEATHER_GEO_FAIL_COOLDOWN_MS) {
    return weatherGeo.place.value || null;
  }
  // Concurrent misses (several surfaces/languages refreshing at the same tick)
  // share one lookup: these are free, rate-limited services, and a burst of
  // parallel requests is exactly what gets throttled. The sources are tried in
  // order and the FIRST usable answer wins — a later one is never consulted, so
  // the normal case still costs exactly one request, as it did before.
  if (!weatherGeo.refresh) {
    weatherGeo.refresh = (async () => {
      const attempts = [];
      for (const source of GEO_IP_SOURCES) {
        let value = null;
        try {
          value = normalizeGeoIpValue(source.parse(await fetchJson(source.url, 3000)));
          attempts.push(`${source.name}:${value ? 'ok' : 'no_data'}`);
        } catch (e) {
          // A blocked hostname fails here (NXDOMAIN / refused connection / a
          // filter's HTML interstitial that won't parse as JSON) — try the next.
          attempts.push(`${source.name}:${String((e && e.code) || 'error').slice(0, 24)}`);
        }
        if (!value) continue;
        weatherGeo.place = { value, updatedAt: Date.now() };
        weatherGeo.source = source.name;
        weatherGeo.attempts = attempts.join(', ');
        writeFileAtomic(WEATHER_GEO_FILE, JSON.stringify({ ...value, updatedAt: weatherGeo.place.updatedAt }))
          .catch(() => { /* best-effort — memory copy still serves this run */ });
        return value;
      }
      weatherGeo.attempts = attempts.join(', ');
      weatherGeo.failAt = Date.now();
      return null;
    })().finally(() => { weatherGeo.refresh = null; });
  }
  const fresh = await weatherGeo.refresh;
  // Lookup failed: reuse the last known coordinates even past their TTL, so the
  // forecast stays pinned to one place instead of drifting to wttr's IP guess.
  return fresh || weatherGeo.place.value || null;
}

module.exports = { recoverWeatherPlaceViaWttr, resolveManualWeatherPlace, resolveAutoLocation };
