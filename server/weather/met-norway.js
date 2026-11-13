// Turns a met.no answer into the forecast shape the weather tile draws, with the feels-like
// temperature and the sun times met.no does not give.

const {
  WEATHER_FORECAST_MAX_DAYS, WEATHER_BUCKET_CODE, weatherBucketLabel, degToCompass, isoToClock,
  isoDatePart,
} = require('./forecast-shape.js');

// The met.no terms of service require an identifying User-Agent with contact.
// The version is the running app's, handed over by the caller (server.js reads
// it once from package.json): a fixed number here went stale at the next release.
const METNO_HEADERS = (appVersion) => ({ 'User-Agent': `XenonEdgeHub/${appVersion || '0'} (github.com/marcimastro98/Xenon)` });


// met.no symbol_code (e.g. "partlycloudy_night", "lightrainshowers_day") → bucket.
function metnoBucket(symbol) {
  const s = String(symbol || '').replace(/_(day|night|polartwilight)$/, '');
  if (!s) return 'cloud';
  if (s.includes('thunder')) return 'storm';
  if (s.includes('sleet')) return 'snow';
  if (s.includes('snow')) return 'snow';
  if (s.includes('showers')) return 'showers';
  if (s.includes('rain')) return 'rain';
  if (s.includes('drizzle')) return 'drizzle';
  if (s === 'fog') return 'fog';
  if (s === 'cloudy') return 'cloud';
  if (s === 'partlycloudy') return 'partly';
  if (s === 'fair') return 'partly';
  if (s === 'clearsky') return 'clear';
  return 'cloud';
}

// "Feels like" for providers that don't supply it (met.no). Wind chill when cold
// and windy, heat index when warm and humid, else the air temperature — the same
// bands weather services use. Inputs °C / km/h / %.
function computeFeelsLike(tempC, windKph, humidity) {
  if (!Number.isFinite(tempC)) return null;
  if (tempC <= 10 && Number.isFinite(windKph) && windKph >= 4.8) {
    const w = Math.pow(windKph, 0.16);
    return Math.round(13.12 + 0.6215 * tempC - 11.37 * w + 0.3965 * tempC * w);
  }
  if (tempC >= 27 && Number.isFinite(humidity) && humidity >= 40) {
    const T = tempC * 9 / 5 + 32, R = humidity;
    const hi = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R
      - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R
      + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
    return Math.round((hi - 32) * 5 / 9);
  }
  return Math.round(tempC);
}

// Approximate local sunrise/sunset ("HH:MM") for a date, to fill providers that
// omit them (met.no compact). NOAA low-precision algorithm (~1-2 min accuracy —
// ample for the day/night visual and the forecast sun line). Uses the server's
// local timezone, which is the user's own location in auto mode.
function computeSunTimes(lat, lon, dateStr) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { sunrise: '', sunset: '' };
  const d = dateStr ? new Date(`${dateStr}T12:00:00`) : new Date();
  if (!Number.isFinite(d.getTime())) return { sunrise: '', sunset: '' };
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const start = new Date(d.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((d - start) / 86400000);
  const zenith = 90.833;
  const calc = (isSunrise) => {
    const lngHour = lon / 15;
    const tApprox = dayOfYear + ((isSunrise ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * tApprox - 3.289;
    let L = M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634;
    L = ((L % 360) + 360) % 360;
    let RA = deg * Math.atan(0.91764 * Math.tan(L * rad));
    RA = ((RA % 360) + 360) % 360;
    RA += (Math.floor(L / 90) - Math.floor(RA / 90)) * 90;
    RA /= 15;
    const sinDec = 0.39782 * Math.sin(L * rad);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(zenith * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
    if (cosH > 1 || cosH < -1) return '';
    let H = isSunrise ? 360 - deg * Math.acos(cosH) : deg * Math.acos(cosH);
    H /= 15;
    const T = H + RA - 0.06571 * tApprox - 6.622;
    const UT = ((T - lngHour) % 24 + 24) % 24;
    const local = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) + UT * 3600000);
    return `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
  };
  return { sunrise: calc(true), sunset: calc(false) };
}

// Map a met.no locationforecast/2.0/compact payload onto the shared shape.
// The compact product has no sunrise/sunset, UV or feels-like; those stay null
// (the UI already shows "--" for missing metrics). Daily min/max are aggregated
// from the time series; wind is m/s → km/h.
function normalizeMetno(raw, ctx) {
  const series = raw && raw.properties && Array.isArray(raw.properties.timeseries) ? raw.properties.timeseries : [];
  if (!series.length) return null;
  const first = series[0];
  const inst = first.data && first.data.instant && first.data.instant.details;
  if (!inst || !Number.isFinite(Number(inst.air_temperature))) return null;
  const round = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const symbolOf = (entry) => {
    const d = entry && entry.data;
    return (d && ((d.next_1_hours && d.next_1_hours.summary && d.next_1_hours.summary.symbol_code)
      || (d.next_6_hours && d.next_6_hours.summary && d.next_6_hours.summary.symbol_code))) || '';
  };
  const precipOf = (entry) => {
    const d = entry && entry.data;
    const p = d && ((d.next_1_hours && d.next_1_hours.details) || (d.next_6_hours && d.next_6_hours.details));
    return p && Number.isFinite(Number(p.precipitation_amount)) ? Number(p.precipitation_amount) : null;
  };
  const curBucket = metnoBucket(symbolOf(first));

  // Next 8 hourly points.
  const hourly = series.slice(0, 8).map(entry => {
    const det = entry.data && entry.data.instant && entry.data.instant.details || {};
    const b = metnoBucket(symbolOf(entry));
    return {
      date: isoDatePart(entry.time),
      time: isoToClock(entry.time),
      code: WEATHER_BUCKET_CODE[b],
      tempC: round(det.air_temperature),
      feelsC: null,
      rain: null,
      windKph: Number.isFinite(Number(det.wind_speed)) ? Math.round(Number(det.wind_speed) * 3.6) : null,
      condition: weatherBucketLabel(b, ctx.lang),
    };
  });

  // Daily aggregation: group instants by local date, take min/max; the day's
  // symbol is the entry nearest local noon.
  const byDate = new Map();
  series.forEach(entry => {
    const date = isoDatePart(entry.time);
    if (!date) return;
    const temp = Number(entry.data && entry.data.instant && entry.data.instant.details && entry.data.instant.details.air_temperature);
    if (!byDate.has(date)) byDate.set(date, { min: Infinity, max: -Infinity, noon: null, noonDiff: Infinity });
    const rec = byDate.get(date);
    if (Number.isFinite(temp)) { rec.min = Math.min(rec.min, temp); rec.max = Math.max(rec.max, temp); }
    const hour = Number((isoToClock(entry.time) || '00:00').slice(0, 2));
    const diff = Math.abs(hour - 12);
    if (diff < rec.noonDiff) { rec.noonDiff = diff; rec.noon = symbolOf(entry); }
  });
  const forecast = [...byDate.entries()].slice(0, WEATHER_FORECAST_MAX_DAYS).map(([date, rec]) => {
    const b = metnoBucket(rec.noon);
    const sun = computeSunTimes(ctx.lat, ctx.lon, date);
    return {
      date,
      code: WEATHER_BUCKET_CODE[b],
      minC: Number.isFinite(rec.min) ? Math.round(rec.min) : null,
      maxC: Number.isFinite(rec.max) ? Math.round(rec.max) : null,
      avgC: null, uv: null, sunHour: null, sunrise: sun.sunrise, sunset: sun.sunset, moonPhase: '',
      condition: weatherBucketLabel(b, ctx.lang),
    };
  });

  const windKph = Number.isFinite(Number(inst.wind_speed)) ? Math.round(Number(inst.wind_speed) * 3.6) : null;
  const humidity = round(inst.relative_humidity);
  const tempC = round(inst.air_temperature);
  const todaySun = computeSunTimes(ctx.lat, ctx.lon, isoDatePart(first.time));
  return {
    ok: true,
    code: WEATHER_BUCKET_CODE[curBucket],
    tempC,
    feelsC: computeFeelsLike(tempC, windKph, humidity),
    humidity,
    windKph,
    windDir: degToCompass(inst.wind_from_direction),
    pressure: round(inst.air_pressure_at_sea_level),
    visibility: null,
    uv: null,
    cloudCover: round(inst.cloud_area_fraction),
    precipMM: precipOf(first),
    condition: weatherBucketLabel(curBucket, ctx.lang),
    location: ctx.location || '',
    region: ctx.region || '',
    country: ctx.country || '',
    lat: ctx.lat, lon: ctx.lon,
    sunrise: todaySun.sunrise, sunset: todaySun.sunset,
    hourly,
    forecast,
    updatedAt: Date.now(),
    aqi: null, pm25: null, pm10: null, no2: null, pollen: null,
    source: 'metno',
  };
}

module.exports = { METNO_HEADERS, metnoBucket, computeFeelsLike, computeSunTimes, normalizeMetno };
