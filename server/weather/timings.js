// How long weather answers are reused, and how long to wait after the place could not be found.

const WEATHER_CACHE_MS = 10 * 60 * 1000;
// The forecast cache must stay STRICTLY below the shortest client refresh the user
// can pick (Settings → Meteo → 10 min). If it equals the poll interval, the small
// server-side fetch latency means every other client poll lands just inside the
// cache window and returns stale data — halving the effective refresh (a 10-min
// setting behaved like ~20 min). Kept separate from WEATHER_CACHE_MS so geocoding /
// IP-location caches (which change rarely) still coalesce for the full 10 min.
const WEATHER_FORECAST_CACHE_MS = 5 * 60 * 1000;

const WEATHER_GEO_FAIL_COOLDOWN_MS = 60 * 1000;

module.exports = { WEATHER_CACHE_MS, WEATHER_FORECAST_CACHE_MS, WEATHER_GEO_FAIL_COOLDOWN_MS };
