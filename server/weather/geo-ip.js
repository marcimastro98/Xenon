// The services asked where this PC is when no city is set, and the check of what they answer.

// Free, no-key IP geolocation (https). Coordinate-based providers need lat/lon
// for AUTO mode; wttr self-geolocates so it doesn't. Cached like the forecast,
// and the last good answer is persisted to DATA_DIR: the backend restarts at
// every boot (native-app nudge), so an in-memory-only value is gone exactly
// when it's needed most — if the lookup is then down or slow, one surface gets
// coordinates (open-meteo) and another gets none (wttr's own IP guess), i.e.
// two different forecasts for the same PC until the next refresh (#72). Stale
// coordinates beat no coordinates.
//
// Several sources are tried in order, because losing this step is far more
// expensive than it looks: with no coordinates open-meteo AND met.no are skipped
// outright (both return null on the first line), so the whole feature silently
// degrades to wttr — the least reliable of the three — and stays there until the
// day wttr is rate-limited too, at which point the tile blanks. That is exactly
// the Discord report against v4.11.3 ("Weather not working and still wrong next
// hours"): the wrong hours were the tell that the machine had been running on
// the wttr fallback for weeks. One hostname is one point of failure, and the
// realistic causes here (a DNS-level blocker on the PC or the router, a filtering
// antivirus, a corporate resolver) block SOME names and not others — so a second
// and third name is a far cheaper fix than asking a user to audit blocklists.
// Keep every source free, key-less and https, and keep the parsers pure: they are
// fixture-tested in test/weather-geo-sources.test.mjs against real payloads.
const GEO_IP_SOURCES = Object.freeze([
  { name: 'ipwho.is', url: 'https://ipwho.is/',
    parse: (g) => (g && g.success === false ? null : { lat: g && g.latitude, lon: g && g.longitude, location: g && g.city, region: g && g.region, country: g && g.country }) },
  { name: 'geojs', url: 'https://get.geojs.io/v1/ip/geo.json',
    parse: (g) => ({ lat: g && g.latitude, lon: g && g.longitude, location: g && g.city, region: g && g.region, country: g && g.country }) },
  { name: 'ipapi', url: 'https://ipapi.co/json/',
    parse: (g) => (g && g.error ? null : { lat: g && g.latitude, lon: g && g.longitude, location: g && g.city, region: g && g.region, country: g && g.country_name }) },
]);
// Shape-check one source's answer. Coordinates arrive as numbers from one
// service and as strings from another, so everything goes through Number();
// 0/0 is refused because it is what a service returns when it does NOT know
// (null island is in the Atlantic, and a forecast for it looks like real data).
function normalizeGeoIpValue(parsed) {
  const lat = Number(parsed && parsed.lat);
  const lon = Number(parsed && parsed.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  return {
    lat, lon,
    location: String((parsed && parsed.location) || ''),
    region: String((parsed && parsed.region) || ''),
    country: String((parsed && parsed.country) || ''),
  };
}

module.exports = { GEO_IP_SOURCES, normalizeGeoIpValue };
