// The classic Weather look: the 4.11.13 tile (painted, animated sky card, then the Details
// cards, the next hours and the next days), kept as a choice because people asked to have it
// back next to the current tile. It reads the same weatherData and helpers (js/system.js) and
// draws into one .weather-widget-mount; the looks live in components/WeatherTile/WeatherClassic.css.
(function () {
  'use strict';

  // The animated sky/sun/cloud/rain stack behind the temperature.
  const VIZ_SPANS = Object.freeze([
    'weather-viz-sky', 'weather-viz-celestial',
    'weather-viz-ring weather-viz-ring-a', 'weather-viz-ring weather-viz-ring-b',
    'weather-viz-cloud weather-viz-cloud-a', 'weather-viz-cloud weather-viz-cloud-b',
    'weather-viz-rain weather-viz-rain-a', 'weather-viz-rain weather-viz-rain-b', 'weather-viz-rain weather-viz-rain-c',
    'weather-viz-bolt',
    'weather-viz-snow weather-viz-snow-a', 'weather-viz-snow weather-viz-snow-b',
    'weather-viz-fog',
  ]);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function placeText(data) {
    return [data.location, data.region, data.country].filter(Boolean).join(', ') || t('weather_local');
  }

  function feelsText(data) {
    return data.feelsC != null ? `${toDisplayTemp(data.feelsC)}°` : '--';
  }

  function formatDate(dateValue) {
    const date = new Date(`${dateValue}T12:00:00`);
    if (!Number.isFinite(date.getTime())) return dateValue || '--';
    return date.toLocaleDateString(i18n[lang].locale, { weekday: 'short', day: 'numeric' });
  }

  function openDetails() {
    if (typeof toggleWeatherDetails === 'function') toggleWeatherDetails();
  }

  function buildHeroVisual(state, night) {
    const vis = el('div', 'weather-hero-visual');
    vis.setAttribute('aria-hidden', 'true');
    setWeatherStateClass(vis, state);
    vis.classList.toggle('is-night', night);
    VIZ_SPANS.forEach((cls) => vis.appendChild(el('span', cls)));
    return vis;
  }

  function createChip(valueText, labelKey) {
    const span = el('span');
    const label = el('em', '', t(labelKey));
    label.setAttribute('data-i18n', labelKey);
    span.append(el('b', '', valueText), label);
    return span;
  }

  // The hero and the one-line bar are both the button that opens the full view, painted with
  // the sky of the current condition.
  function cardButton(className, data, ok, state, night) {
    const card = el('button', `weather-tile-card ${className}`);
    card.type = 'button';
    card.addEventListener('click', openDetails);
    setWeatherStateClass(card, state);
    card.classList.toggle('is-night', night);
    card.classList.toggle('weather-tile--stale', ok && !!data.stale);
    return card;
  }

  function buildHeroChips(data) {
    const chips = el('div', 'weather-hero-chips');
    [
      ['feels', data.feelsC != null ? `${toDisplayTemp(data.feelsC)}°${tempUnitSuffix()}` : '--', 'weather_metric_feels'],
      ['wind', displayWind(data.windKph), 'weather_metric_wind'],
      ['rain', displayPrecip(data.precipMM), 'weather_metric_rain'],
    ].forEach(([id, value, key]) => {
      if (weatherFieldEnabled(id)) chips.appendChild(createChip(value, key));
    });
    return chips.children.length ? chips : null;
  }

  function buildHeroCard(data, ok, state, night) {
    const card = cardButton('weather-hero-card', data, ok, state, night);
    card.title = t('weather_open');
    card.appendChild(buildHeroVisual(state, night));
    card.append(
      el('div', 'weather-hero-place', ok ? placeText(data) : t('weather_unavailable')),
      el('div', 'weather-hero-temp', ok ? `${toDisplayTemp(data.tempC)}°` : '--°'),
      el('div', 'weather-hero-condition', ok ? (data.condition || t('weather_title')) : weatherErrorLabel(data)),
      // Offline, the line under the condition says what to do instead of when it was read.
      el('div', 'weather-hero-meta', ok ? formatWeatherUpdated(data.updatedAt) : weatherErrorHint(data)),
    );
    const chips = ok ? buildHeroChips(data) : null;
    if (chips) card.appendChild(chips);
    return card;
  }

  function buildCompactStats(data) {
    const stats = el('span', 'weather-compact-stats');
    [
      ['wind', displayWind(data.windKph), 'weather_metric_wind'],
      ['rain', displayPrecip(data.precipMM), 'weather_metric_rain'],
    ].forEach(([id, value, key]) => {
      if (!weatherFieldEnabled(id)) return;
      const chip = createChip(value, key);
      chip.className = `weather-compact-stat weather-compact-stat--${id}`;
      stats.appendChild(chip);
    });
    return stats.children.length ? stats : null;
  }

  function buildChevron() {
    const chevron = document.createElementNS(SVG_NS, 'svg');
    chevron.setAttribute('class', 'weather-compact-chevron');
    chevron.setAttribute('viewBox', '0 0 16 16');
    chevron.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M6 3.5 10.5 8 6 12.5');
    chevron.appendChild(path);
    return chevron;
  }

  // One line instead of the big card (GitHub #130): icon, temperature, condition with
  // feels-like under it, wind and rain quieter on the right, a chevron that says it opens.
  function buildCompactBar(data, ok, state, night) {
    const bar = cardButton('weather-tile-compact', data, ok, state, night);
    bar.title = ok ? `${t('weather_open')} (${placeText(data)})` : t('weather_open');
    const icon = el('span', 'weather-compact-icon');
    icon.setAttribute('aria-hidden', 'true');
    icon.appendChild(el('span', `weather-mini-icon ${state}`));
    const text = el('span', 'weather-compact-text');
    text.appendChild(el('span', 'weather-compact-condition', ok ? (data.condition || t('weather_title')) : weatherErrorLabel(data)));
    if (ok && weatherFieldEnabled('feels')) {
      text.appendChild(el('span', 'weather-compact-feels', `${t('weather_metric_feels')} ${feelsText(data)}`));
    }
    bar.append(icon, el('span', 'weather-compact-temp', ok ? `${toDisplayTemp(data.tempC)}°` : '--°'), text);
    const stats = ok ? buildCompactStats(data) : null;
    if (stats) bar.appendChild(stats);
    bar.appendChild(buildChevron());
    return bar;
  }

  function createMetric(label, value, sub, metric, level) {
    const card = el('div', 'weather-metric' + (level ? ` weather-metric--${level}` : ''));
    if (metric) card.dataset.metric = metric;
    card.append(
      el('div', 'weather-metric-label', label),
      el('div', 'weather-metric-value', value),
      el('div', 'weather-metric-sub', sub || ''),
    );
    return card;
  }

  // The detail cards, in the 4.11.13 order, each behind its field toggle.
  function metricCards(data) {
    const ugm3 = ' μg/m³';
    return [
      ['aqi', 'weather_metric_aqi', weatherDisplayValue(data.aqi), aqiLabel(data.aqi), data.aqi],
      ['humidity', 'weather_metric_humidity', weatherDisplayValue(data.humidity, '%'), t('weather_metric_humidity_sub'), data.humidity],
      ['pm25', 'weather_metric_pm25', weatherDisplayValue(data.pm25, ugm3), 'PM2.5', data.pm25],
      ['pm10', 'weather_metric_pm10', weatherDisplayValue(data.pm10, ugm3), 'PM10', data.pm10],
      ['no2', 'weather_metric_no2', weatherDisplayValue(data.no2, ugm3), 'NO₂', data.no2],
      ['pollen', 'weather_metric_pollen', weatherDisplayValue(data.pollen, '/m³'), t('weather_metric_pollen'), data.pollen],
      ['pressure', 'weather_metric_pressure', weatherDisplayValue(data.pressure, ' hPa'), t('weather_metric_pressure_sub'), null],
      ['visibility', 'weather_metric_visibility', displayVisibility(data.visibility), t('weather_metric_visibility_sub'), data.visibility],
      ['uv', 'weather_metric_uv', weatherDisplayValue(data.uv), t('weather_metric_uv_sub'), data.uv],
      ['clouds', 'weather_metric_clouds', weatherDisplayValue(data.cloudCover, '%'), t('weather_metric_clouds_sub'), null],
    ].filter(([id]) => weatherFieldEnabled(id))
      .map(([id, key, value, sub, raw]) => createMetric(t(key), value, sub, id, raw == null ? '' : weatherMetricLevel(id, raw)));
  }

  function buildSection(titleKey, content) {
    const sec = el('div', 'weather-tile-section');
    const title = el('div', 'weather-section-title', t(titleKey));
    title.setAttribute('data-i18n', titleKey);
    sec.append(title, content);
    return sec;
  }

  function createHour(hour, data) {
    const card = el('div', 'weather-hour');
    // Night is read at the hour's own time, so a 22:00 clear sky is a moon.
    const at = parseSunTime(hour.time) ?? undefined;
    const state = classifyWeatherState({ ...hour, sunrise: data.sunrise, sunset: data.sunset }, at);
    card.dataset.weather = weatherStateIcon(state);
    card.title = [hour.condition, hour.windKph != null ? displayWind(hour.windKph) : ''].filter(Boolean).join(' · ');
    card.append(
      el('div', 'weather-hour-time', hour.time || '--'),
      el('span', `weather-mini-icon ${state}`),
      el('div', 'weather-hour-temp', weatherDisplayValue(toDisplayTemp(hour.tempC), '°')),
    );
    // Not every provider sends a rain chance: no bare "Rain --".
    if (hour.rain != null) {
      card.appendChild(el('div', 'weather-hour-rain', `${t('weather_rain_short')} ${weatherDisplayValue(hour.rain, '%')}`));
    }
    return card;
  }

  // [day] [icon] [low] [range bar] [high]; the bar is scaled to the span of all shown days.
  function buildForecast(data) {
    const days = data.forecast.slice(0, weatherForecastDays());
    const wrap = el('div', 'weather-forecast weather-forecast--rows');
    const mins = days.map((d) => Number(d.minC)).filter(Number.isFinite);
    const maxs = days.map((d) => Number(d.maxC)).filter(Number.isFinite);
    const lo = mins.length ? Math.min(...mins) : 0;
    const span = Math.max(1, (maxs.length ? Math.max(...maxs) : 1) - lo);
    const pct = (v) => Math.max(0, Math.min(100, ((Number(v) - lo) / span) * 100));
    days.forEach((day, i) => {
      const state = classifyWeatherState(day);
      const row = el('div', 'weather-fc-row');
      row.dataset.weather = weatherStateIcon(state);
      const bar = el('span', 'weather-fc-bar');
      const fill = el('span', 'weather-fc-fill');
      if (Number.isFinite(Number(day.minC)) && Number.isFinite(Number(day.maxC))) {
        fill.style.left = `${pct(day.minC)}%`;
        fill.style.right = `${100 - pct(day.maxC)}%`;
      }
      bar.appendChild(fill);
      row.append(
        el('span', 'weather-fc-day', i === 0 ? t('weather_today') : formatDate(day.date)),
        el('span', `weather-mini-icon ${state}`),
        el('span', 'weather-fc-min', weatherDisplayValue(toDisplayTemp(day.minC), '°')),
        bar,
        el('span', 'weather-fc-max', weatherDisplayValue(toDisplayTemp(day.maxC), '°')),
      );
      wrap.appendChild(row);
    });
    return wrap;
  }

  function buildBody(data, sec) {
    const body = el('div', 'weather-tile-body');
    if (sec.metrics) {
      const grid = el('div', 'weather-metrics');
      grid.append(...metricCards(data));
      // Every metric hidden: no section, rather than a bare title.
      if (grid.children.length) body.appendChild(buildSection('weather_section_details', grid));
    }
    if (sec.hourly && Array.isArray(data.hourly) && data.hourly.length) {
      const hours = el('div', 'weather-hourly');
      data.hourly.forEach((hour) => hours.appendChild(createHour(hour, data)));
      body.appendChild(buildSection('weather_hourly', hours));
    }
    if (sec.forecast && Array.isArray(data.forecast) && data.forecast.length) {
      body.appendChild(buildSection('weather_forecast', buildForecast(data)));
    }
    return body;
  }

  // sec = { compact, metrics, hourly, forecast }, the per-widget choices from Settings → Weather.
  function render(mount, data, sec) {
    if (!mount) return;
    const opts = sec || {};
    const ok = !!(data && data.ok);
    const state = ok ? classifyWeatherState(data) : 'state-offline';
    const night = ok && isWeatherNight(data.sunrise, data.sunset);
    const root = el('div', 'weather-tile-root weather-tile-root--classic');
    // The state on the root tints the body with the hero's sky: one scene, not two parts.
    setWeatherStateClass(root, state);
    root.classList.toggle('is-night', night);
    root.classList.toggle('weather-tile-root--compact', !!opts.compact);
    root.appendChild(opts.compact ? buildCompactBar(data, ok, state, night) : buildHeroCard(data, ok, state, night));
    if (ok) {
      const body = buildBody(data, opts);
      if (body.children.length) {
        root.classList.add('has-body');
        root.appendChild(body);
      }
    }
    mount.replaceChildren(root);
  }

  // parts: the pieces js/weather-classic-window.js builds the classic Weather window from.
  window.WeatherClassic = Object.freeze({
    render,
    parts: Object.freeze({ buildHeroVisual, buildHeroChips, metricCards, createMetric, createHour, formatDate, placeText }),
  });
})();
