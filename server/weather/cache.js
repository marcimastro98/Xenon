// Weather answers kept in memory, by place, and the newest one for a place.

// Weather responses cached per (lang|provider|mode|city). Different surfaces —
// and the server's own AI calls — can ask with different languages; a single
// shared slot would let them evict each other on every request, hammering the
// providers and handing two surfaces two different snapshots of the same place
// for up to a refresh cycle (#72). Bounded: oldest entry evicted past the cap.
const WEATHER_CACHE_MAX_ENTRIES = 16;
const weatherCache = new Map();   // cacheKey → { data, updatedAt }
const weatherPending = new Map(); // cacheKey → in-flight promise

const weatherLocationCache = new Map();

// Newest cached forecast for a location regardless of UI language. The cache key
// is `lang|provider|mode|city`, so a language change misses the per-lang slot and,
// if the providers are momentarily unavailable (e.g. rate-limited by rapid
// switching), the widget would blank to "no data" (#88). Bridging to the last
// known conditions for the same place — served stale, no extra provider request —
// keeps the tile populated until the correct-language fetch succeeds.
function newestWeatherForLocation(provider, mode, city) {
  const suffix = `|${provider}|${mode}|${String(city).toLowerCase()}`;
  let best = null;
  for (const [key, entry] of weatherCache) {
    if (!key.endsWith(suffix)) continue;
    if (!best || entry.updatedAt > best.updatedAt) best = entry;
  }
  return best ? best.data : null;
}

module.exports = {
  WEATHER_CACHE_MAX_ENTRIES, weatherCache, weatherPending, weatherLocationCache,
  newestWeatherForLocation,
};
