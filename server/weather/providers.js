// The weather sources and the order they are tried in.

// ── Weather providers ───────────────────────────────────────────────
// The dashboard can draw weather from more than one free, no-key source, so an
// outage or a bad reading from one never leaves the widget blank or wrong.
// Every provider maps its native payload onto the SAME normalized shape as
// normalizeWeather() (wttr.in), so the client renders any of them identically.
//   • open-meteo — api.open-meteo.com (WMO codes, very reliable, complete)
//   • metno      — api.met.no / yr.no (needs an identifying User-Agent)
//   • wttr       — wttr.in (self-geolocates by IP; the original source)
// 'auto' tries them in that order and returns the first that answers.
const WEATHER_PROVIDERS = new Set(['auto', 'open-meteo', 'metno', 'wttr']);

// Provider attempt order for a given preference. A specific choice is tried
// first, then the others as fallbacks, so a single source's outage never blanks
// the widget. wttr sits last in 'auto' (least reliable) but is the only one that
// works without coordinates, covering the case where IP geolocation fails.
function weatherProviderOrder(pref) {
  const base = ['open-meteo', 'metno', 'wttr'];
  if (pref && pref !== 'auto' && base.includes(pref)) {
    return [pref, ...base.filter(p => p !== pref)];
  }
  return base;
}

module.exports = { WEATHER_PROVIDERS, weatherProviderOrder };
