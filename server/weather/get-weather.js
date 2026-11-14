// The weather for the place asked for: the place is found, the services are tried in order, and
// the answer is kept for a while.

const { resolveWeatherLocation, splitWeatherDisplayLocation } = require('./location.js');
const { WEATHER_PROVIDERS, weatherProviderOrder } = require('./providers.js');
const { WEATHER_LANGS } = require('./setting-values.js');
const { readHubSettings } = require('../settings/read.js');
const {
  WEATHER_CACHE_MAX_ENTRIES, weatherCache, weatherPending, newestWeatherForLocation,
} = require('./cache.js');
const { WEATHER_FORECAST_CACHE_MS } = require('./timings.js');
const { fetchJson } = require('../http/fetch-json.js');
const { weatherGeo } = require('./auto-place-state.js');
const { resolveManualWeatherPlace, resolveAutoLocation } = require('./place-lookup.js');
const { WEATHER_FETCHERS } = require('./fetchers.js');

async function getWeather(lang = 'en', requestedLocation = null) {
  // Unsupported/missing language falls back to English (neutral), never to a
  // specific locale — a client on a language the server doesn't know must not
  // get Italian conditions on an otherwise-translated UI (#72).
  const safeLang = WEATHER_LANGS.has(lang) ? lang : 'en';
  const settings = await readHubSettings().catch(() => null);
  const hasRequestLocation = requestedLocation && (requestedLocation.mode !== undefined || requestedLocation.city !== undefined);
  const location = resolveWeatherLocation(hasRequestLocation ? requestedLocation : settings && settings.weather);
  const provider = settings && settings.weather && WEATHER_PROVIDERS.has(settings.weather.provider)
    ? settings.weather.provider : 'auto';
  const cacheKey = `${safeLang}|${provider}|${location.mode}|${location.city.toLowerCase()}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && (Date.now() - cached.updatedAt) < WEATHER_FORECAST_CACHE_MS) return cached.data;
  const pending = weatherPending.get(cacheKey);
  if (pending) return pending;

  const promise = (async () => {
    // Build the location context. Coordinate-based providers (open-meteo, metno)
    // need lat/lon: from geocoding in manual mode, from IP geolocation in auto.
    const ctx = { lang: safeLang, mode: location.mode, city: location.city, lat: NaN, lon: NaN, placePath: '', location: '', region: '', country: '' };
    if (location.mode === 'manual') {
      const manualPlace = await resolveManualWeatherPlace(location.city, safeLang);
      ctx.placePath = manualPlace.placePath;
      if (Number.isFinite(manualPlace.lat) && Number.isFinite(manualPlace.lon)) { ctx.lat = manualPlace.lat; ctx.lon = manualPlace.lon; }
      if (manualPlace.resolvedCity) {
        const d = splitWeatherDisplayLocation(manualPlace.resolvedCity);
        ctx.location = d.location || ''; ctx.region = d.region || ''; ctx.country = d.country || '';
      }
    } else {
      const auto = await resolveAutoLocation();
      if (auto) { ctx.lat = auto.lat; ctx.lon = auto.lon; ctx.location = auto.location; ctx.region = auto.region; ctx.country = auto.country; }
    }

    // Try providers in order; the first that answers wins. A single source being
    // down or coordinate-less never blanks the widget. The outcome of each is
    // recorded: when they ALL fail, the difference between "we never got
    // coordinates" and "the services didn't answer" is the whole diagnosis, and
    // until now neither the user nor a support reply could tell them apart.
    const hasCoords = Number.isFinite(ctx.lat) && Number.isFinite(ctx.lon);
    const tried = {};
    let data = null;
    for (const name of weatherProviderOrder(provider)) {
      // open-meteo and met.no return null on their first line without
      // coordinates; naming that as skipped rather than failed keeps the report
      // honest about which link in the chain actually broke.
      if (!hasCoords && name !== 'wttr') { tried[name] = 'no_coordinates'; continue; }
      data = await WEATHER_FETCHERS[name](ctx);
      tried[name] = data && data.ok ? 'ok' : 'failed';
      if (data && data.ok) break;
    }
    if (!data || !data.ok) {
      // Prefer the exact-language snapshot; otherwise bridge to the newest
      // cached forecast for this place in any language, so a language change
      // never blanks the tile while the providers recover (#88).
      const bridge = cached ? cached.data : newestWeatherForLocation(provider, location.mode, location.city);
      if (bridge) return { ...bridge, stale: true };
      // Answered rather than thrown: a 500 with a stack message tells the tile
      // nothing it can show, and the tile is where the user is. The failure is
      // NOT cached — the next poll retries in full.
      return {
        ok: false,
        error: hasCoords ? 'providers_down' : (location.mode === 'manual' ? 'city_not_found' : 'no_location'),
        providers: tried,
        geo: location.mode === 'manual' ? '' : (weatherGeo.source || weatherGeo.attempts || 'none'),
        locationMode: location.mode,
        requestedCity: location.city,
        updatedAt: Date.now(),
      };
    }

    data.locationMode = location.mode;
    data.requestedCity = location.city;
    // A resolved display name (geocode in manual, IP-geo in auto) wins over a
    // provider's own — and is the only name coordinate providers have.
    if (ctx.location) data.location = ctx.location;
    if (ctx.region) data.region = ctx.region;
    if (ctx.country) data.country = ctx.country;

    // Air quality is a shared post-step for every provider (needs coordinates).
    if (Number.isFinite(Number(data.lat)) && Number.isFinite(Number(data.lon))) {
      try {
        const aqiRaw = await fetchJson(
          `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${data.lat}&longitude=${data.lon}&current=european_aqi,pm2_5,pm10,nitrogen_dioxide,grass_pollen,birch_pollen,alder_pollen,ragweed_pollen,mugwort_pollen,olive_pollen`,
          4000
        );
        const cur = aqiRaw && aqiRaw.current || {};
        data.aqi  = Number.isFinite(Number(cur.european_aqi))     ? Math.round(Number(cur.european_aqi))           : null;
        data.pm25 = Number.isFinite(Number(cur.pm2_5))            ? Math.round(Number(cur.pm2_5) * 10) / 10        : null;
        data.pm10 = Number.isFinite(Number(cur.pm10))             ? Math.round(Number(cur.pm10))                   : null;
        data.no2  = Number.isFinite(Number(cur.nitrogen_dioxide)) ? Math.round(Number(cur.nitrogen_dioxide) * 10) / 10 : null;
        // Pollen (grains/m³) is Europe-only; surface the highest active type as a
        // single glanceable value (null outside coverage → the tile hides it).
        const pollenTypes = ['grass_pollen', 'birch_pollen', 'alder_pollen', 'ragweed_pollen', 'mugwort_pollen', 'olive_pollen'];
        const pollenVals = pollenTypes.map((k) => Number(cur[k])).filter((n) => Number.isFinite(n));
        data.pollen = pollenVals.length ? Math.round(Math.max(...pollenVals)) : null;
      } catch { }
    }
    weatherCache.set(cacheKey, { data, updatedAt: Date.now() });
    if (weatherCache.size > WEATHER_CACHE_MAX_ENTRIES) {
      weatherCache.delete(weatherCache.keys().next().value); // oldest insert
    }
    return data;
  })()
    .finally(() => { weatherPending.delete(cacheKey); });

  weatherPending.set(cacheKey, promise);
  return promise;
}

module.exports = { getWeather };
