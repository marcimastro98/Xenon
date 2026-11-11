// The classic Weather window: 4.11.13's full view (the painted sky with the place, the
// temperature and the feels/wind/rain chips, then the Details cards, the next hours and the
// next days), shown when Settings → Weather → Style is Classic. js/weather-look.js loads it with
// js/weather-classic.js, whose cards it reuses, and calls render() from renderWeatherDetails.
// The looks are in components/WeatherModal/WeatherClassicWindow.css.
(function () {
  'use strict';

  const ROOT = 'weather-classic-window';
  const PANEL = 'weather-panel--classic';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function heroCard(data, ok, state, night) {
    const parts = window.WeatherClassic.parts;
    const card = el('div', 'weather-hero-card');
    card.appendChild(parts.buildHeroVisual(state, night));
    card.append(
      el('div', 'weather-hero-place', ok ? parts.placeText(data) : t('weather_unavailable')),
      el('div', 'weather-hero-temp', ok ? `${toDisplayTemp(data.tempC)}°` : '--°'),
      el('div', 'weather-hero-condition', ok ? (data.condition || t('weather_title')) : weatherErrorLabel(data)),
      el('div', 'weather-hero-meta', ok ? formatWeatherUpdated(data.updatedAt) : ''),
    );
    const chips = ok ? parts.buildHeroChips(data) : null;
    if (chips) card.appendChild(chips);
    card.classList.toggle('is-stale', ok && !!data.stale);
    return card;
  }

  function block(name, titleKey, content) {
    const box = el('section', `weather-${name}-block`);
    const title = el('div', 'weather-section-title', t(titleKey));
    title.setAttribute('data-i18n', titleKey);
    box.append(title, content);
    return box;
  }

  function createDay(day) {
    const state = classifyWeatherState(day);
    const card = el('div', 'weather-day');
    card.dataset.weather = weatherStateIcon(state);
    const top = el('div', 'weather-day-top');
    top.append(
      el('span', '', window.WeatherClassic.parts.formatDate(day.date)),
      el('span', 'weather-day-range', `${weatherDisplayValue(toDisplayTemp(day.minC), '°')} / ${weatherDisplayValue(toDisplayTemp(day.maxC), '°')}`),
    );
    card.append(top, el('span', `weather-mini-icon weather-day-icon ${state}`), el('div', 'weather-day-condition', day.condition || '--'));
    return card;
  }

  // What went wrong, in a card as wide as the grid; a wrong city or no location gets the
  // same Settings key as the new window.
  function troubleCard(data) {
    const card = window.WeatherClassic.parts.createMetric(t('weather_unavailable'), weatherErrorLabel(data), weatherErrorHint(data));
    card.classList.add('weather-metric--explain');
    const fixable = typeof WEATHER_SETTINGS_ERRORS !== 'undefined' && data && WEATHER_SETTINGS_ERRORS.has(data.error);
    if (fixable && typeof buildWeatherWindowSettingsKey === 'function' && typeof openSettings === 'function') {
      card.appendChild(buildWeatherWindowSettingsKey());
    }
    return card;
  }

  function sections(data, ok) {
    const parts = window.WeatherClassic.parts;
    const metrics = el('div', 'weather-metrics');
    metrics.append(...(ok ? parts.metricCards(data) : [troubleCard(data)]));
    // The Details cards sit straight on the glass, with no title, as they did.
    const out = metrics.children.length ? [metrics] : [];
    if (!ok) return out;
    if (Array.isArray(data.hourly) && data.hourly.length) {
      const hours = el('div', 'weather-hourly');
      hours.append(...data.hourly.map((hour) => parts.createHour(hour, data)));
      out.push(block('hourly', 'weather_hourly', hours));
    }
    if (Array.isArray(data.forecast) && data.forecast.length) {
      const days = el('div', 'weather-forecast');
      days.append(...data.forecast.slice(0, weatherForecastDays()).map(createDay));
      out.push(block('forecast', 'weather_forecast', days));
    }
    return out;
  }

  // The head reads as it did: "Live conditions" over the sky card, which carries the place
  // and the time it was read. js/weather-window.js sets it back for the other styles.
  function setHead() {
    const title = document.getElementById('weather-modal-title');
    const updated = document.getElementById('weather-modal-updated');
    if (title) title.textContent = t('weather_details_title');
    if (updated) {
      updated.textContent = '';
      updated.classList.remove('is-stale');
    }
  }

  function render(content, data) {
    const ok = !!(data && data.ok);
    const state = ok ? classifyWeatherState(data) : 'state-offline';
    const night = ok && isWeatherNight(data.sunrise, data.sunset);
    const root = el('div', ROOT);
    setWeatherStateClass(root, state);
    root.classList.toggle('is-night', night);
    root.appendChild(heroCard(data, ok, state, night));
    const side = el('div', 'weather-classic-side');
    side.append(...sections(data, ok));
    root.appendChild(side);
    const panel = content.closest('.weather-panel');
    if (panel) {
      panel.classList.add(PANEL);
      panel.dataset.wxState = state;
    }
    setHead();
    content.replaceChildren(root);
  }

  // Back to another style: the panel loses the classic sky.
  function release(content) {
    const panel = content && content.closest('.weather-panel');
    if (!panel || !panel.classList.contains(PANEL)) return;
    panel.classList.remove(PANEL);
    delete panel.dataset.wxState;
    const root = content.querySelector(`:scope > .${ROOT}`);
    if (root) root.remove();
  }

  window.WeatherClassicWindow = Object.freeze({ render, release });
})();
