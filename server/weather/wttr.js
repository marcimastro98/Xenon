// Turns a wttr.in answer into the forecast shape the weather tile draws.

const { WEATHER_FORECAST_MAX_DAYS } = require('./forecast-shape.js');

function firstWeatherValue(value) {
  if (Array.isArray(value) && value[0] && typeof value[0].value === 'string') return value[0].value;
  return '';
}

function normalizeWeatherCode(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function weatherDescription(item, lang) {
  if (!item) return '';
  return firstWeatherValue(item[`lang_${lang}`]) || firstWeatherValue(item.weatherDesc) || '';
}

function normalizeWeatherHour(hour, lang, date) {
  const rawTime = String(hour && hour.time || '0').padStart(4, '0');
  const time = `${rawTime.slice(0, -2).padStart(2, '0')}:${rawTime.slice(-2)}`;
  const tempC = Number(hour && hour.tempC);
  const feelsC = Number(hour && hour.FeelsLikeC);
  const rain = Number(hour && hour.chanceofrain);
  const windKph = Number(hour && hour.windspeedKmph);
  return {
    date,
    time,
    code: normalizeWeatherCode(hour && hour.weatherCode),
    tempC: Number.isFinite(tempC) ? Math.round(tempC) : null,
    feelsC: Number.isFinite(feelsC) ? Math.round(feelsC) : null,
    rain: Number.isFinite(rain) ? Math.round(rain) : null,
    windKph: Number.isFinite(windKph) ? Math.round(windKph) : null,
    condition: weatherDescription(hour, lang),
  };
}

function normalizeWeatherDay(day, lang) {
  const astronomy = day && day.astronomy && day.astronomy[0] || {};
  const noon = day && Array.isArray(day.hourly) ? (day.hourly.find(h => String(h.time) === '1200') || day.hourly[0]) : null;
  return {
    date: String(day && day.date || ''),
    code: normalizeWeatherCode(noon && noon.weatherCode),
    minC: Number.isFinite(Number(day && day.mintempC)) ? Math.round(Number(day.mintempC)) : null,
    maxC: Number.isFinite(Number(day && day.maxtempC)) ? Math.round(Number(day.maxtempC)) : null,
    avgC: Number.isFinite(Number(day && day.avgtempC)) ? Math.round(Number(day.avgtempC)) : null,
    uv: Number.isFinite(Number(day && day.uvIndex)) ? Number(day.uvIndex) : null,
    sunHour: Number.isFinite(Number(day && day.sunHour)) ? Number(day.sunHour) : null,
    sunrise: String(astronomy.sunrise || ''),
    sunset: String(astronomy.sunset || ''),
    moonPhase: String(astronomy.moon_phase || ''),
    condition: weatherDescription(noon, lang),
  };
}

function normalizeWeather(raw, lang) {
  const current = raw && raw.current_condition && raw.current_condition[0] || {};
  const area = raw && raw.nearest_area && raw.nearest_area[0] || {};
  const tempC = Number(current.temp_C);
  const feelsC = Number(current.FeelsLikeC);
  const humidity = Number(current.humidity);
  const windKph = Number(current.windspeedKmph);
  const pressure = Number(current.pressure);
  const visibility = Number(current.visibility);
  const uv = Number(current.uvIndex);
  const cloudCover = Number(current.cloudcover);
  const precipMM = Number(current.precipMM);
  const lat = Number(area.latitude);
  const lon = Number(area.longitude);
  const condition = weatherDescription(current, lang);
  const location = firstWeatherValue(area.areaName) || firstWeatherValue(area.region) || firstWeatherValue(area.country) || '';
  const region = firstWeatherValue(area.region);
  const country = firstWeatherValue(area.country);
  const days = Array.isArray(raw && raw.weather) ? raw.weather : [];
  const nowHour = new Date().getHours();
  const hourly = days.flatMap(day => (Array.isArray(day.hourly) ? day.hourly : [])
    .map(hour => normalizeWeatherHour(hour, lang, String(day.date || ''))))
    .filter(hour => !hour.date || hour.date !== days[0]?.date || Number(hour.time.slice(0, 2)) >= nowHour)
    .slice(0, 8);
  const todayAstro = days[0] && days[0].astronomy && days[0].astronomy[0] || {};

  return {
    ok: Number.isFinite(tempC),
    code: normalizeWeatherCode(current.weatherCode),
    tempC: Number.isFinite(tempC) ? Math.round(tempC) : null,
    feelsC: Number.isFinite(feelsC) ? Math.round(feelsC) : null,
    humidity: Number.isFinite(humidity) ? humidity : null,
    windKph: Number.isFinite(windKph) ? Math.round(windKph) : null,
    windDir: String(current.winddir16Point || ''),
    pressure: Number.isFinite(pressure) ? pressure : null,
    visibility: Number.isFinite(visibility) ? visibility : null,
    uv: Number.isFinite(uv) ? uv : null,
    cloudCover: Number.isFinite(cloudCover) ? cloudCover : null,
    precipMM: Number.isFinite(precipMM) ? precipMM : null,
    condition,
    location,
    region,
    country,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    sunrise: String(todayAstro.sunrise || ''),
    sunset: String(todayAstro.sunset || ''),
    hourly,
    forecast: days.slice(0, WEATHER_FORECAST_MAX_DAYS).map(day => normalizeWeatherDay(day, lang)),
    updatedAt: Date.now(),
    aqi: null, pm25: null, pm10: null, no2: null, pollen: null,
  };
}

module.exports = {
  firstWeatherValue, normalizeWeatherCode, weatherDescription, normalizeWeatherHour,
  normalizeWeatherDay, normalizeWeather,
};
