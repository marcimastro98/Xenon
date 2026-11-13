// The facts row of the weather tile, and putting the tile together.
'use strict';

const WEATHER_WARNING_FACTS = new Set(['aqi', 'pm25', 'pm10', 'no2', 'pollen', 'uv']);

// The details as plain lines. A reading the provider does not send is left out rather than
// shown as "--", and only a value worth a warning is coloured.
// No rain now, no UV at night, no pollen in November: a row that tells nothing.
const WEATHER_ZERO_SAYS_NOTHING = new Set(['rain', 'uv', 'pollen']);

function weatherFacts(data) {
  const fact = (id, key, raw, value) => ({ id, key, raw, value, warn: WEATHER_WARNING_FACTS.has(id) && weatherMetricLevel(id, raw) === 'bad' });
  return WeatherOutlook.orderFacts([
    fact('wind', 'weather_metric_wind', data.windKph, displayWind(data.windKph)),
    fact('humidity', 'weather_metric_humidity', data.humidity, weatherDisplayValue(data.humidity, '%')),
    fact('uv', 'weather_metric_uv', data.uv, weatherDisplayValue(data.uv)),
    fact('aqi', 'weather_metric_aqi', data.aqi, aqiLabel(data.aqi)),
    fact('rain', 'weather_metric_rain', data.precipMM, displayPrecip(data.precipMM)),
    fact('visibility', 'weather_metric_visibility', data.visibility, displayVisibility(data.visibility)),
    fact('pressure', 'weather_metric_pressure', data.pressure, weatherDisplayValue(data.pressure, ' hPa')),
    fact('clouds', 'weather_metric_clouds', data.cloudCover, weatherDisplayValue(data.cloudCover, '%')),
    fact('pm25', 'weather_metric_pm25', data.pm25, weatherDisplayValue(data.pm25, ' μg/m³')),
    fact('pm10', 'weather_metric_pm10', data.pm10, weatherDisplayValue(data.pm10, ' μg/m³')),
    fact('no2', 'weather_metric_no2', data.no2, weatherDisplayValue(data.no2, ' μg/m³')),
    fact('pollen', 'weather_metric_pollen', data.pollen, weatherDisplayValue(data.pollen, '/m³')),
  ].filter(({ id, raw }) => raw !== null && raw !== undefined && raw !== ''
    && !(WEATHER_ZERO_SAYS_NOTHING.has(id) && Number(raw) === 0)
    && weatherFieldEnabled(id)));
}

function buildWeatherFacts(data, lead = []) {
  const facts = [...lead, ...weatherFacts(data)];
  if (!facts.length) return null;
  const list = weatherEl('dl', 'weather-facts');
  facts.forEach(({ key, value, warn }) => {
    const row = weatherEl('div', 'weather-fact');
    row.classList.toggle('is-warning', warn);
    row.append(weatherEl('dt', '', t(key)), weatherEl('dd', '', value));
    list.appendChild(row);
  });
  return list;
}

function buildWeatherTileBody(data, sec) {
  const body = weatherEl('div', 'weather-tile-body');
  const hours = sec.hourly ? buildWeatherHours(data) : null;
  if (hours) body.appendChild(hours);
  if (sec.forecast && Array.isArray(data.forecast) && data.forecast.length) body.appendChild(buildWeatherDays(data));
  const facts = sec.metrics ? buildWeatherFacts(data) : null;
  if (facts) body.appendChild(facts);
  body.addEventListener('click', openWeatherDetails);
  return body;
}

// Fed from the shared weatherData by applyWeather and the layout pass. What shows is a
// per-widget choice (Settings → Weather); what fits is the tile's size, in WeatherTile.css.
function renderWeatherTile() {
  const mounts = document.querySelectorAll('.weather-widget-mount');
  if (!mounts.length) return;
  const data = weatherData;
  const ok = !!(data && data.ok);
  const sec = weatherTileSections();
  if (window.WeatherLook && window.WeatherLook.render(mounts, data, sec)) return;
  mounts.forEach((mount) => {
    const root = weatherEl('div', 'weather-tile-root');
    root.classList.toggle('weather-tile-root--compact', sec.compact);
    root.appendChild(sec.compact ? buildWeatherCompactBar(data) : buildWeatherHeroCard(data));
    if (ok) {
      const body = buildWeatherTileBody(data, sec);
      if (body.children.length) {
        root.classList.add('has-body');
        root.appendChild(body);
      }
    }
    mount.replaceChildren(root);
  });
}
