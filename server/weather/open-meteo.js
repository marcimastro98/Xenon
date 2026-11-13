// Turns an Open-Meteo answer into the forecast shape the weather tile draws.

const {
  WEATHER_FORECAST_MAX_DAYS, WEATHER_BUCKET_CODE, weatherBucketLabel, degToCompass, isoToClock,
  isoDatePart,
} = require('./forecast-shape.js');

// WMO weather interpretation code (open-meteo) → canonical bucket.
function wmoBucket(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return 'cloud';
  if (c === 0) return 'clear';
  if (c === 1 || c === 2) return 'partly';
  if (c === 3) return 'cloud';
  if (c === 45 || c === 48) return 'fog';
  if (c >= 51 && c <= 57) return 'drizzle';
  if (c >= 61 && c <= 67) return 'rain';
  if (c >= 71 && c <= 77) return 'snow';
  if (c >= 80 && c <= 82) return 'showers';
  if (c === 85 || c === 86) return 'snow';
  if (c >= 95) return 'storm';
  return 'cloud';
}

// Map an open-meteo /v1/forecast payload onto the shared normalized shape.
function normalizeOpenMeteo(raw, ctx) {
  const cur = raw && raw.current;
  if (!cur || !Number.isFinite(Number(cur.temperature_2m))) return null;
  const bucket = wmoBucket(cur.weather_code);
  const daily = raw.daily || {};
  const dDates = Array.isArray(daily.time) ? daily.time : [];
  const sunrise = isoToClock(Array.isArray(daily.sunrise) ? daily.sunrise[0] : '');
  const sunset = isoToClock(Array.isArray(daily.sunset) ? daily.sunset[0] : '');
  const round = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

  const forecast = dDates.slice(0, WEATHER_FORECAST_MAX_DAYS).map((date, i) => {
    const b = wmoBucket(daily.weather_code && daily.weather_code[i]);
    return {
      date: String(date || ''),
      code: WEATHER_BUCKET_CODE[b],
      minC: round(daily.temperature_2m_min && daily.temperature_2m_min[i]),
      maxC: round(daily.temperature_2m_max && daily.temperature_2m_max[i]),
      avgC: null,
      uv: Number.isFinite(Number(daily.uv_index_max && daily.uv_index_max[i])) ? Number(daily.uv_index_max[i]) : null,
      sunHour: null,
      sunrise: isoToClock(daily.sunrise && daily.sunrise[i]),
      sunset: isoToClock(daily.sunset && daily.sunset[i]),
      moonPhase: '',
      condition: weatherBucketLabel(b, ctx.lang),
    };
  });

  const h = raw.hourly || {};
  const hTimes = Array.isArray(h.time) ? h.time : [];
  const nowMs = Date.now();
  const hourly = [];
  for (let i = 0; i < hTimes.length && hourly.length < 8; i++) {
    if (new Date(hTimes[i]).getTime() < nowMs - 60 * 60 * 1000) continue;
    const b = wmoBucket(h.weather_code && h.weather_code[i]);
    hourly.push({
      date: isoDatePart(hTimes[i]),
      time: isoToClock(hTimes[i]),
      code: WEATHER_BUCKET_CODE[b],
      tempC: round(h.temperature_2m && h.temperature_2m[i]),
      feelsC: null,
      rain: round(h.precipitation_probability && h.precipitation_probability[i]),
      windKph: round(h.wind_speed_10m && h.wind_speed_10m[i]),
      condition: weatherBucketLabel(b, ctx.lang),
    });
  }

  const visM = Number(cur.visibility);
  return {
    ok: true,
    code: WEATHER_BUCKET_CODE[bucket],
    tempC: round(cur.temperature_2m),
    feelsC: round(cur.apparent_temperature),
    humidity: round(cur.relative_humidity_2m),
    windKph: round(cur.wind_speed_10m),
    windDir: degToCompass(cur.wind_direction_10m),
    pressure: round(cur.pressure_msl),
    visibility: Number.isFinite(visM) ? Math.round(visM / 1000) : null,
    uv: Number.isFinite(Number(cur.uv_index)) ? Math.round(Number(cur.uv_index)) : null,
    cloudCover: round(cur.cloud_cover),
    precipMM: Number.isFinite(Number(cur.precipitation)) ? Math.round(Number(cur.precipitation) * 10) / 10 : null,
    condition: weatherBucketLabel(bucket, ctx.lang),
    location: ctx.location || '',
    region: ctx.region || '',
    country: ctx.country || '',
    lat: ctx.lat, lon: ctx.lon,
    sunrise, sunset,
    hourly,
    forecast,
    updatedAt: Date.now(),
    aqi: null, pm25: null, pm10: null, no2: null, pollen: null,
    source: 'open-meteo',
  };
}

module.exports = { wmoBucket, normalizeOpenMeteo };
