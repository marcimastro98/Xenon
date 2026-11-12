'use strict';

// The Weather tile: now, what changes next, the coming hours as columns, the days, and the
// details that matter. It reads the shared weatherData (js/system.js) and opens the full
// view on a click; the rules it draws from live in js/weather-outlook.js.

function weatherEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function weatherArtEl(className, state, night) {
  const art = weatherEl('span', className);
  art.setAttribute('aria-hidden', 'true');
  // Static drawings from weather-art.js, never built from data.
  art.innerHTML = WeatherArt.svg(state, night);
  return art;
}

function weatherFullPlace(data) {
  return [data.location, data.region, data.country].filter(Boolean).join(', ') || t('weather_local');
}

function openWeatherDetails() {
  if (typeof toggleWeatherDetails === 'function') toggleWeatherDetails();
}

// Which sections the tile shows, from the (normalized) settings.
function weatherTileSections() {
  const w = (typeof hubSettings === 'object' && hubSettings && hubSettings.weather) || {};
  const src = w.tile && typeof w.tile === 'object' ? w.tile : {};
  return {
    compact: src.hero === 'compact',
    metrics: src.metrics !== false,
    hourly: src.hourly !== false,
    forecast: src.forecast !== false,
  };
}

// The forecast's hours as the tile reads them. The first one is the hour under way: it says
// "now" and carries the reading, so its column matches the big number above it.
function weatherHourRows(data) {
  const list = Array.isArray(data.hourly) ? data.hourly : [];
  const clock = new Date();
  const nowMin = clock.getHours() * 60 + clock.getMinutes();
  return list.map((hour, i) => {
    const min = parseSunTime(hour.time);
    const isNow = i === 0 && WeatherOutlook.isCurrentHour(min, nowMin);
    const at = min ?? undefined;
    return {
      min,
      now: isNow,
      rain: hour.rain,
      night: isWeatherNight(data.sunrise, data.sunset, at),
      state: isNow ? classifyWeatherState(data) : classifyWeatherState({ ...hour, sunrise: data.sunrise, sunset: data.sunset }, at),
      tempC: isNow && data.tempC != null ? data.tempC : hour.tempC,
      label: isNow ? t('weather_now') : weatherHourLabel(min),
    };
  });
}

// A bare hour for its column. 24h stays digits in every language ("15 Uhr" would not
// fit a column); 12h keeps the locale's own way of writing it.
function weatherHourLabel(min) {
  if (min == null) return '--';
  const hour = Math.floor(min / 60);
  if (!clockUses12h()) return String(hour);
  return new Date(2000, 0, 1, hour).toLocaleTimeString(i18n[lang].locale, plainHourParts({ minutes: false }));
}

function weatherClockText(min) {
  const date = new Date(2000, 0, 1, Math.floor(min / 60), min % 60);
  return date.toLocaleTimeString(i18n[lang].locale, plainHourParts());
}

// One plain sentence: when the rain starts or stops, or that it will stay dry.
function weatherNextLine(data, hours) {
  const change = WeatherOutlook.nextChange(hours, classifyWeatherState(data));
  if (!change) return null;
  if (change.mode === 'dry') return { text: t('weather_next_dry').replace('{n}', change.span), wet: false };
  const key = `weather_next_${change.kind}_${change.mode}`;
  if (change.mode === 'long') return { text: t(key).replace('{n}', change.span), wet: true };
  const min = hours[change.at].min;
  return min == null ? null : { text: t(key).replace('{time}', weatherClockText(min)), wet: true };
}

function buildWeatherNowFacts(data) {
  const line = weatherEl('span', 'weather-now-range');
  const today = Array.isArray(data.forecast) ? data.forecast[0] : null;
  if (today && today.maxC != null) line.append(weatherEl('span', '', t('weather_high').replace('{t}', `${toDisplayTemp(today.maxC)}°`)));
  if (today && today.minC != null) line.append(weatherEl('span', '', t('weather_low').replace('{t}', `${toDisplayTemp(today.minC)}°`)));
  if (data.feelsC != null && weatherFieldEnabled('feels')) {
    line.append(weatherEl('span', 'weather-now-feels', `${t('weather_metric_feels')} ${toDisplayTemp(data.feelsC)}°`));
  }
  return line;
}

// Current conditions, the button that opens the full view.
function buildWeatherHeroCard(data) {
  const ok = !!(data && data.ok);
  const state = ok ? classifyWeatherState(data) : 'state-offline';
  const night = ok && isWeatherNight(data.sunrise, data.sunset);
  const card = weatherEl('button', 'weather-tile-card weather-now');
  card.type = 'button';
  card.title = t('weather_open');
  card.addEventListener('click', openWeatherDetails);
  card.classList.toggle('weather-tile--stale', ok && !!data.stale);

  const place = ok ? (data.location || t('weather_local')) : t('weather_title');
  const lines = weatherEl('span', 'weather-now-lines');
  lines.append(weatherEl('span', 'weather-now-condition', ok ? (data.condition || t('weather_title')) : weatherErrorLabel(data)));
  if (ok) lines.append(buildWeatherNowFacts(data));
  else lines.append(weatherEl('span', 'weather-now-range', weatherErrorHint(data)));
  card.append(
    weatherEl('span', 'weather-now-place', place),
    weatherEl('span', 'weather-now-temp', ok ? `${toDisplayTemp(data.tempC)}°` : '--°'),
    lines,
    weatherArtEl('weather-now-art', state, night),
  );
  if (!ok) return card;

  const next = weatherNextLine(data, weatherHourRows(data));
  if (data.stale) card.append(weatherEl('span', 'weather-now-next', formatWeatherUpdated(data.updatedAt)));
  else if (next) {
    const el = weatherEl('span', 'weather-now-next', next.text);
    el.classList.toggle('is-wet', next.wet);
    card.append(el);
  }
  return card;
}

// The one-line alternative to the hero card (GitHub #130: "I just want the next
// hours/days, with a summary of the current temp/feels like"). Picture and
// temperature, then the condition with feels-like under it (the one number the
// request named, so it sits with the temperature rather than among the extras),
// wind and rain quieter on the right, each behind its field toggle. It is still
// the button that opens the full weather view, and the chevron says so: a
// one-line strip does not look tappable the way the big card did.
function buildWeatherCompactBar(data) {
  const ok = !!(data && data.ok);
  const state = ok ? classifyWeatherState(data) : 'state-offline';
  const night = ok && isWeatherNight(data.sunrise, data.sunset);
  const bar = weatherEl('button', 'weather-tile-card weather-tile-compact');
  bar.type = 'button';
  bar.addEventListener('click', () => { if (typeof toggleWeatherDetails === 'function') toggleWeatherDetails(); });
  bar.classList.toggle('weather-tile--stale', ok && !!data.stale);
  const place = ok ? weatherFullPlace(data) : '';
  bar.title = place ? `${t('weather_open')} (${place})` : t('weather_open');

  const text = weatherEl('span', 'weather-compact-text');
  text.append(weatherEl('span', 'weather-compact-condition', ok ? (data.condition || t('weather_title')) : weatherErrorLabel(data)));
  if (ok && weatherFieldEnabled('feels')) {
    text.append(weatherEl('span', 'weather-compact-feels', `${t('weather_metric_feels')} ${data.feelsC != null ? `${toDisplayTemp(data.feelsC)}°` : '--'}`));
  }
  bar.append(
    weatherArtEl('weather-compact-icon', state, night),
    weatherEl('span', 'weather-compact-temp', ok ? `${toDisplayTemp(data.tempC)}°` : '--°'),
    text,
  );

  if (ok) {
    const stats = weatherEl('span', 'weather-compact-stats');
    [
      ['wind', displayWind(data.windKph), 'weather_metric_wind'],
      ['rain', displayPrecip(data.precipMM), 'weather_metric_rain'],
    ].forEach(([id, value, key]) => {
      if (!weatherFieldEnabled(id)) return;
      const stat = weatherEl('span', `weather-compact-stat weather-compact-stat--${id}`);
      stat.append(weatherEl('b', '', value), weatherEl('em', '', t(key)));
      stats.appendChild(stat);
    });
    if (stats.children.length) bar.appendChild(stats);
  }

  const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  chevron.setAttribute('class', 'weather-compact-chevron');
  chevron.setAttribute('viewBox', '0 0 16 16');
  chevron.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M6 3.5 10.5 8 6 12.5');
  chevron.appendChild(path);
  bar.appendChild(chevron);
  return bar;
}

// One hour as a column, read like a timetable: the hour, its sky, its temperature, and the
// chance of rain under it. The rain line is there for every column or none, so the
// temperatures stay level; an hour under 10% leaves its slot empty rather than say 0%.
function buildWeatherHourCell(hour, withRain) {
  const cell = weatherEl('li', 'weather-hour');
  cell.classList.toggle('is-now', hour.now);
  cell.append(
    weatherEl('span', 'weather-hour-time', hour.label),
    weatherArtEl('weather-hour-art', hour.state, hour.night),
    weatherEl('span', 'weather-hour-temp', weatherDisplayValue(toDisplayTemp(hour.tempC), '°')),
  );
  if (withRain) {
    const chance = Number(hour.rain);
    cell.appendChild(weatherEl('span', 'weather-hour-rain', chance >= 10 ? `${Math.round(Math.min(100, chance))}%` : ''));
  }
  return cell;
}

// The coming hours side by side. As many as the width holds stay whole; the rest leave from
// the right (WeatherTile.css), so a narrow tile shows fewer hours, never smaller ones.
function buildWeatherHours(data) {
  const hours = weatherHourRows(data);
  if (hours.length < 2) return null;
  const list = weatherEl('ol', 'weather-hours');
  list.setAttribute('aria-label', t('weather_hourly'));
  const withRain = hours.some((hour) => Number(hour.rain) >= 10);
  list.classList.toggle('has-rain', withRain);
  hours.forEach((hour) => list.appendChild(buildWeatherHourCell(hour, withRain)));
  return list;
}

function weatherDayName(day, i) {
  if (i === 0) return t('weather_today');
  const date = new Date(`${day.date}T12:00:00`);
  if (!Number.isFinite(date.getTime())) return day.date || '--';
  const { locale } = i18n[lang];
  const name = date.toLocaleDateString(locale, { weekday: 'short' });
  // Here and not in the CSS: Liquid Glass turns every text-transform off.
  return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
}

// Days as rows with a range bar. The bar is scaled to the span across all shown days, so
// warmer and colder days read at a glance, and its colours are the real temperatures.
function buildWeatherDays(data) {
  const days = (Array.isArray(data.forecast) ? data.forecast : []).slice(0, weatherForecastDays());
  const list = weatherEl('div', 'weather-forecast--rows');
  const mins = days.map((day) => Number(day.minC)).filter(Number.isFinite);
  const maxs = days.map((day) => Number(day.maxC)).filter(Number.isFinite);
  const low = mins.length ? Math.min(...mins) : 0;
  const span = Math.max(1, (maxs.length ? Math.max(...maxs) : 1) - low);
  const share = (value) => Math.max(0, Math.min(100, ((Number(value) - low) / span) * 100));
  // Every row is its own grid, so the longest name sets the column for all of them: "Aujourd'hui" is not "Lun".
  list.style.setProperty('--wx-name', `${Math.max(0, ...days.map((day, i) => weatherDayName(day, i).length))}ch`);
  days.forEach((day, i) => {
    const state = classifyWeatherState(day, WEATHER_DAY_NOON_MIN);   // a day is its daytime, never a moon
    const row = weatherEl('div', 'weather-fc-row');
    row.dataset.weather = weatherStateIcon(state);
    row.title = day.condition || '';
    const bar = weatherEl('span', 'weather-fc-bar');
    const fill = weatherEl('span', 'weather-fc-fill');
    if (Number.isFinite(Number(day.minC)) && Number.isFinite(Number(day.maxC))) {
      fill.style.left = `${share(day.minC)}%`;
      fill.style.right = `${100 - share(day.maxC)}%`;
      fill.style.setProperty('--cold', WeatherOutlook.tempColor(day.minC));
      fill.style.setProperty('--warm', WeatherOutlook.tempColor(day.maxC));
    }
    bar.appendChild(fill);
    row.append(
      weatherEl('span', 'weather-fc-day', weatherDayName(day, i)),
      weatherArtEl('weather-fc-art', state, false),
      weatherEl('span', 'weather-fc-min', weatherDisplayValue(toDisplayTemp(day.minC), '°')),
      bar,
      weatherEl('span', 'weather-fc-max', weatherDisplayValue(toDisplayTemp(day.maxC), '°')),
    );
    list.appendChild(row);
  });
  return list;
}

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
