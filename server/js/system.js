'use strict';

// Scoped field lookup within one System instance root.
function sf(root, name) { return root.querySelector('[data-sf="' + name + '"]'); }

function cycleDisk() {
  if (!systemDisks || systemDisks.length < 2) return;
  diskIndex = (diskIndex + 1) % systemDisks.length;
  if (window.DashboardGrid && window.DashboardGrid.forEachInstance) {
    window.DashboardGrid.forEachInstance('system', root => renderDiskInto(root, systemDisks[diskIndex]));
  }
}

function renderDiskInto(root, disk) {
  const label = sf(root, 'disk-label'), value = sf(root, 'disk-value'),
        small = sf(root, 'disk-small'), sub = sf(root, 'disk-sub'),
        detail = sf(root, 'disk-detail'), fill = sf(root, 'disk-fill');
  if (!disk) {
    if (label) label.textContent = t('disk_label');
    if (value) value.textContent = '--%';
    if (small) small.textContent = '';
    if (sub) sub.textContent = '--';
    if (detail) detail.textContent = '--';
    if (fill) setFill(fill, 0);
    return;
  }
  if (label) label.textContent = `${t('disk_label')} ${disk.drive}`;
  if (value) value.textContent = disk.percent + '%';
  if (small) small.textContent = formatBytes(disk.free) + ' ' + t('gb_free');
  if (sub) sub.textContent = formatBytes(disk.used) + ' / ' + formatBytes(disk.total);
  if (detail) {
    const parts = [disk.label, disk.fileSystem, disk.driveType].map(p => String(p || '').trim()).filter(Boolean);
    detail.textContent = parts.length ? parts.join(' - ') : t('disk_detail_unavailable');
  }
  if (fill) setFill(fill, disk.percent);
}

// Back-compat: render the "current" disk into every instance.
function renderDisk(disk) {
  if (window.DashboardGrid && window.DashboardGrid.forEachInstance) {
    window.DashboardGrid.forEachInstance('system', root => renderDiskInto(root, disk));
  }
}

function applySystemInto(root, data) {
  const set = (name, text) => { const el = sf(root, name); if (el) el.textContent = text; };
  const fillEl = (name, pct) => { const el = sf(root, name); if (el) setFill(el, pct); };

  set('host-name', data.hostname || 'Local cockpit');
  set('uptime-text', `${t('uptime_prefix')} ${formatUptime(data.uptime)}`);

  const cpu = Number.isFinite(data.cpu) ? data.cpu : 0;
  set('cpu-value', cpu + '%'); fillEl('cpu-fill', cpu); set('cpu-name', data.cpuName || '--');
  const cpuTemp = Number(data.cpuTemp);
  set('cpu-head-temp', (Number.isFinite(cpuTemp) && cpuTemp > 0) ? Math.round(cpuTemp) + '°C' : '');

  const ram = data.memory ? data.memory.percent : 0;
  set('ram-value', ram + '%');
  set('ram-small', data.memory ? formatBytes(data.memory.total) : '');
  fillEl('ram-fill', ram);
  set('ram-sub', data.memory ? formatBytes(data.memory.used) + ' / ' + formatBytes(data.memory.total) : '--');
  const ramDetail = data.ramDetail || {};
  set('ram-detail', ramDetail.detail || data.ramName || t('ram_detail_unavailable'));
  set('ram-name', ramDetail.moduleName || '');

  if (data.gpu === null || data.gpu === undefined) {
    set('gpu-value', '--%'); fillEl('gpu-fill', 0);
  } else {
    set('gpu-value', data.gpu + '%'); fillEl('gpu-fill', data.gpu);
  }
  set('gpu-name', data.gpuName || t('gpu_loading'));
  const gpuTemp = Number(data.gpuTemp);
  set('gpu-head-temp', (Number.isFinite(gpuTemp) && gpuTemp > 0) ? Math.round(gpuTemp) + '°C' : '');

  if (data.disks && data.disks.length > 0) {
    systemDisks = data.disks;
    if (diskIndex >= systemDisks.length) diskIndex = 0;
    renderDiskInto(root, systemDisks[diskIndex]);
    const cycleBtn = sf(root, 'disk-cycle-btn');
    if (cycleBtn) cycleBtn.style.display = systemDisks.length > 1 ? '' : 'none';
  } else {
    systemDisks = null;
    renderDiskInto(root, null);
    const cycleBtn = sf(root, 'disk-cycle-btn');
    if (cycleBtn) cycleBtn.style.display = 'none';
  }
}

function applySystem(data) {
  if (window.DashboardGrid && window.DashboardGrid.forEachInstance) {
    window.DashboardGrid.forEachInstance('system', root => applySystemInto(root, data));
  }
}

// Weather values arrive from the server in Celsius; the display unit is a
// client-side preference (hubSettings.tempUnit). Convert + round on render so
// switching the unit needs no re-fetch. Returns null/'' unchanged so callers'
// "--" placeholder still works.
function toDisplayTemp(celsius) {
  if (celsius === null || celsius === undefined || celsius === '') return celsius;
  const c = Number(celsius);
  if (!Number.isFinite(c)) return celsius;
  const fahrenheit = typeof hubSettings === 'object' && hubSettings && hubSettings.tempUnit === 'f';
  return Math.round(fahrenheit ? c * 9 / 5 + 32 : c);
}
function tempUnitSuffix() {
  return (typeof hubSettings === 'object' && hubSettings && hubSettings.tempUnit === 'f') ? 'F' : 'C';
}

function applyWeather(data) {
  weatherData = data || null;
  const pill = $('weather-pill');
  if (!pill) { renderWeatherTile(); return; }

  if (!data || !data.ok) {
    pill.classList.add('offline');
    $('weather-temp').textContent = '--°';
    $('weather-place').textContent = t('weather_unavailable');
    pill.title = t('weather_unavailable');
    applyWeatherPillState(null);
    renderWeatherDetails();
    renderWeatherTile();
    return;
  }

  pill.classList.toggle('offline', !!data.stale);
  $('weather-temp').textContent = `${toDisplayTemp(data.tempC)}°`;
  $('weather-place').textContent = data.location || t('weather_local');
  applyWeatherPillState(data);
  const parts = [data.condition, data.location, data.feelsC != null ? `${t('weather_feels')} ${toDisplayTemp(data.feelsC)}°${tempUnitSuffix()}` : '']
    .filter(Boolean);
  pill.title = parts.length ? parts.join(' · ') : t('weather_title');
  renderWeatherDetails();
  renderWeatherTile();
}

function weatherDisplayValue(value, suffix = '') {
  return value === null || value === undefined || value === '' ? '--' : `${value}${suffix}`;
}

function formatWeatherDate(dateValue) {
  const date = new Date(`${dateValue}T12:00:00`);
  if (!Number.isFinite(date.getTime())) return dateValue || '--';
  return date.toLocaleDateString(i18n[lang].locale, { weekday: 'short', day: 'numeric' });
}

function formatWeatherUpdated(timestamp) {
  const date = new Date(timestamp || Date.now());
  if (!Number.isFinite(date.getTime())) return '--';
  return `${t('weather_updated')} ${date.toLocaleTimeString(i18n[lang].locale, { hour: '2-digit', minute: '2-digit' })}`;
}

const WEATHER_CLEAR_CODES = new Set([113]);
const WEATHER_CLOUD_CODES = new Set([116, 119, 122]);
const WEATHER_FOG_CODES = new Set([143, 248, 260]);
const WEATHER_RAIN_CODES = new Set([176, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314, 353, 356, 359]);
const WEATHER_SNOW_CODES = new Set([179, 182, 185, 227, 230, 317, 320, 323, 326, 329, 332, 335, 338, 350, 362, 365, 368, 371, 374, 377]);
const WEATHER_STORM_CODES = new Set([200, 386, 389, 392, 395]);

function parseSunTime(str) {
  if (!str) return null;
  // 12h "h:mm AM/PM" (wttr.in) …
  const ampm = str.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const min = parseInt(ampm[2], 10);
    if (ampm[3].toUpperCase() === 'AM') { if (h === 12) h = 0; }
    else { if (h !== 12) h += 12; }
    return h * 60 + min;
  }
  // … or 24h "HH:MM" (Open-Meteo / MET Norway).
  const h24 = str.match(/^\s*(\d{1,2}):(\d{2})\s*$/);
  if (h24) {
    const h = parseInt(h24[1], 10);
    const min = parseInt(h24[2], 10);
    if (h >= 0 && h < 24 && min >= 0 && min < 60) return h * 60 + min;
  }
  return null;
}

function isWeatherNight(sunrise, sunset) {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const riseMin = parseSunTime(sunrise);
  const setMin = parseSunTime(sunset);
  if (riseMin != null && setMin != null) return nowMin < riseMin || nowMin >= setMin;
  return now.getHours() < 6 || now.getHours() >= 20;
}

function weatherCodeState(code, sunrise, sunset) {
  const numeric = Number(code);
  if (!Number.isFinite(numeric)) return '';
  if (WEATHER_STORM_CODES.has(numeric)) return 'state-storm';
  if (WEATHER_SNOW_CODES.has(numeric)) return 'state-snow';
  if (WEATHER_RAIN_CODES.has(numeric)) return 'state-rain';
  if (WEATHER_FOG_CODES.has(numeric)) return 'state-fog';
  if (WEATHER_CLOUD_CODES.has(numeric)) return 'state-cloud';
  if (WEATHER_CLEAR_CODES.has(numeric)) return isWeatherNight(sunrise, sunset) ? 'state-moon' : 'state-sun';
  return '';
}

function classifyWeatherState(source) {
  const sunrise = source && typeof source === 'object' ? source.sunrise : null;
  const sunset = source && typeof source === 'object' ? source.sunset : null;
  const byCode = source && typeof source === 'object' ? weatherCodeState(source.code ?? source.weatherCode, sunrise, sunset) : '';
  if (byCode) return byCode;
  const text = String(source && typeof source === 'object' ? source.condition : source || '').toLowerCase();
  const night = isWeatherNight(sunrise, sunset);
  if (/thunder|storm|temporale|temporali/.test(text)) return 'state-storm';
  if (/snow|sleet|neve/.test(text)) return 'state-snow';
  if (/rain|drizzle|shower|piogg|rovesc/.test(text)) return 'state-rain';
  if (/fog|mist|nebbia/.test(text)) return 'state-fog';
  if (/cloud|overcast|nuvol|copert/.test(text)) return 'state-cloud';
  if (/clear|sun|sereno|sole/.test(text)) return night ? 'state-moon' : 'state-sun';
  return night ? 'state-moon' : 'state-cloud';
}

function weatherStateIcon(state) {
  if (state === 'state-sun') return 'sun';
  if (state === 'state-moon') return 'moon';
  if (state === 'state-rain') return 'rain';
  if (state === 'state-storm') return 'storm';
  if (state === 'state-snow') return 'snow';
  if (state === 'state-fog') return 'fog';
  return 'cloud';
}

const WEATHER_STATE_CLASSES = ['state-sun', 'state-moon', 'state-cloud', 'state-rain', 'state-storm', 'state-snow', 'state-fog', 'state-offline'];

function setWeatherStateClass(el, state) {
  if (!el) return;
  el.classList.remove(...WEATHER_STATE_CLASSES);
  el.classList.add(state);
}

// Drives the topbar pill's animated condition icon + tint. Called from
// applyWeather so it stays in sync even while the (modal-gated) details view
// is closed.
function applyWeatherPillState(data) {
  const state = data && data.ok ? classifyWeatherState(data) : 'state-offline';
  setWeatherStateClass($('weather-pill'), state);
  setWeatherStateClass($('weather-pill-icon'), state);
}

// The animated sky/celestial/cloud/rain span stack used by the modal hero, so
// the standalone tile shares its exact look and motion (see WeatherModal.css).
const WEATHER_VIZ_SPANS = Object.freeze([
  'weather-viz-sky', 'weather-viz-celestial',
  'weather-viz-ring weather-viz-ring-a', 'weather-viz-ring weather-viz-ring-b',
  'weather-viz-cloud weather-viz-cloud-a', 'weather-viz-cloud weather-viz-cloud-b',
  'weather-viz-rain weather-viz-rain-a', 'weather-viz-rain weather-viz-rain-b', 'weather-viz-rain weather-viz-rain-c',
  'weather-viz-bolt',
  'weather-viz-snow weather-viz-snow-a', 'weather-viz-snow weather-viz-snow-b',
  'weather-viz-fog',
]);
function buildWeatherHeroVisual(state, night) {
  const vis = document.createElement('div');
  vis.className = 'weather-hero-visual';
  vis.setAttribute('aria-hidden', 'true');
  setWeatherStateClass(vis, state);
  vis.classList.toggle('is-night', !!night);
  WEATHER_VIZ_SPANS.forEach(cls => {
    const s = document.createElement('span');
    s.className = cls;
    vis.appendChild(s);
  });
  return vis;
}

function createWeatherHeroChip(valueText, labelKey) {
  const span = document.createElement('span');
  const b = document.createElement('b');
  b.textContent = valueText;
  const em = document.createElement('em');
  em.setAttribute('data-i18n', labelKey);
  em.textContent = t(labelKey);
  span.append(b, em);
  return span;
}

// Which extra sections the tile should show, from the (normalized) settings.
function weatherTileSections() {
  const w = (typeof hubSettings === 'object' && hubSettings && hubSettings.weather) || {};
  const src = w.tile && typeof w.tile === 'object' ? w.tile : {};
  return {
    metrics: src.metrics !== false,
    hourly: src.hourly !== false,
    forecast: src.forecast !== false,
  };
}

// The hero card (current conditions) — the same markup/classes as the modal hero,
// so it looks and animates identically. Returns a <button> that opens the modal.
function buildWeatherHeroCard(data) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'weather-tile-card weather-hero-card';
  card.addEventListener('click', () => { if (typeof toggleWeatherDetails === 'function') toggleWeatherDetails(); });

  const ok = !!(data && data.ok);
  const state = ok ? classifyWeatherState(data) : 'state-offline';
  const night = ok && isWeatherNight(data.sunrise, data.sunset);
  setWeatherStateClass(card, state);
  card.classList.toggle('is-night', !!night);
  card.classList.toggle('weather-tile--stale', ok && !!data.stale);
  card.title = t('weather_open');

  card.appendChild(buildWeatherHeroVisual(state, night));

  const place = document.createElement('div');
  place.className = 'weather-hero-place';
  place.textContent = ok
    ? ([data.location, data.region, data.country].filter(Boolean).join(', ') || t('weather_local'))
    : t('weather_unavailable');
  const temp = document.createElement('div');
  temp.className = 'weather-hero-temp';
  temp.textContent = ok ? `${toDisplayTemp(data.tempC)}°` : '--°';
  const cond = document.createElement('div');
  cond.className = 'weather-hero-condition';
  cond.textContent = ok ? (data.condition || t('weather_title')) : t('weather_no_data');
  card.append(place, temp, cond);

  if (ok) {
    const meta = document.createElement('div');
    meta.className = 'weather-hero-meta';
    meta.textContent = formatWeatherUpdated(data.updatedAt);
    card.appendChild(meta);

    const chips = document.createElement('div');
    chips.className = 'weather-hero-chips';
    chips.append(
      createWeatherHeroChip(data.feelsC != null ? `${toDisplayTemp(data.feelsC)}°${tempUnitSuffix()}` : '--', 'weather_metric_feels'),
      createWeatherHeroChip(weatherDisplayValue(data.windKph, ' km/h'), 'weather_metric_wind'),
      createWeatherHeroChip(weatherDisplayValue(data.precipMM, ' mm'), 'weather_metric_rain'),
    );
    card.appendChild(chips);
  }
  return card;
}

// The 8 detail metrics, identical to the modal's — reuses createWeatherMetric.
function buildWeatherMetricsGrid(data) {
  const grid = document.createElement('div');
  grid.className = 'weather-metrics';
  grid.append(
    createWeatherMetric(t('weather_metric_aqi'), weatherDisplayValue(data.aqi), aqiLabel(data.aqi), 'aqi', weatherMetricLevel('aqi', data.aqi)),
    createWeatherMetric(t('weather_metric_humidity'), weatherDisplayValue(data.humidity, '%'), t('weather_metric_humidity_sub'), 'humidity', weatherMetricLevel('humidity', data.humidity)),
    createWeatherMetric(t('weather_metric_pm25'), weatherDisplayValue(data.pm25, ' μg/m³'), 'PM2.5', 'pm25', weatherMetricLevel('pm25', data.pm25)),
    createWeatherMetric(t('weather_metric_pm10'), weatherDisplayValue(data.pm10, ' μg/m³'), 'PM10', 'pm10', weatherMetricLevel('pm10', data.pm10)),
    createWeatherMetric(t('weather_metric_pressure'), weatherDisplayValue(data.pressure, ' hPa'), t('weather_metric_pressure_sub'), 'pressure'),
    createWeatherMetric(t('weather_metric_visibility'), weatherDisplayValue(data.visibility, ' km'), t('weather_metric_visibility_sub'), 'visibility', weatherMetricLevel('visibility', data.visibility)),
    createWeatherMetric(t('weather_metric_uv'), weatherDisplayValue(data.uv), t('weather_metric_uv_sub'), 'uv', weatherMetricLevel('uv', data.uv)),
    createWeatherMetric(t('weather_metric_clouds'), weatherDisplayValue(data.cloudCover, '%'), t('weather_metric_clouds_sub'), 'clouds'),
  );
  return grid;
}

// A titled section (title + content) for the tile body, matching the modal.
function buildWeatherTileSection(titleKey, contentEl) {
  const sec = document.createElement('div');
  sec.className = 'weather-tile-section';
  const title = document.createElement('div');
  title.className = 'weather-section-title';
  title.setAttribute('data-i18n', titleKey);
  title.textContent = t(titleKey);
  sec.append(title, contentEl);
  return sec;
}

// Forecast as elegant full-width rows with an iOS-style temperature range bar:
// [day] [icon] [low°] [=== gradient range ===] [high°]. The bar is scaled to the
// span across all shown days, so warmer/colder days read at a glance.
function buildWeatherTileForecast(data) {
  const days = (Array.isArray(data.forecast) ? data.forecast : []).slice(0, 3);
  const wrap = document.createElement('div');
  wrap.className = 'weather-forecast weather-forecast--rows';
  const mins = days.map(d => Number(d.minC)).filter(Number.isFinite);
  const maxs = days.map(d => Number(d.maxC)).filter(Number.isFinite);
  const lo = mins.length ? Math.min(...mins) : 0;
  const hi = maxs.length ? Math.max(...maxs) : 1;
  const span = Math.max(1, hi - lo);
  const pct = (v) => Math.max(0, Math.min(100, ((Number(v) - lo) / span) * 100));
  days.forEach((day, i) => {
    const row = document.createElement('div');
    row.className = 'weather-fc-row';
    const state = classifyWeatherState(day);
    row.dataset.weather = weatherStateIcon(state);

    const name = document.createElement('span');
    name.className = 'weather-fc-day';
    name.textContent = i === 0 ? t('weather_today') : formatWeatherDate(day.date);
    const icon = document.createElement('span');
    icon.className = `weather-mini-icon ${state}`;
    const minEl = document.createElement('span');
    minEl.className = 'weather-fc-min';
    minEl.textContent = weatherDisplayValue(toDisplayTemp(day.minC), '°');
    const bar = document.createElement('span');
    bar.className = 'weather-fc-bar';
    const fill = document.createElement('span');
    fill.className = 'weather-fc-fill';
    if (Number.isFinite(Number(day.minC)) && Number.isFinite(Number(day.maxC))) {
      fill.style.left = pct(day.minC) + '%';
      fill.style.right = (100 - pct(day.maxC)) + '%';
    }
    bar.appendChild(fill);
    const maxEl = document.createElement('span');
    maxEl.className = 'weather-fc-max';
    maxEl.textContent = weatherDisplayValue(toDisplayTemp(day.maxC), '°');
    row.append(name, icon, minEl, bar, maxEl);
    wrap.appendChild(row);
  });
  return wrap;
}

// Populate the standalone Weather tile: the modal hero card, plus the chosen extra
// sections (details / hourly / forecast) below it — each reusing the modal's own
// builders and classes, so the whole thing looks identical, only resizable and
// scrollable. Section visibility is a per-widget setting (Settings → Weather).
// Fed from the shared weatherData by applyWeather + the layout pass.
function renderWeatherTile() {
  const mounts = document.querySelectorAll('.weather-widget-mount');
  if (!mounts.length) return;
  const data = weatherData;
  const ok = !!(data && data.ok);
  const sec = weatherTileSections();
  const state = ok ? classifyWeatherState(data) : 'state-offline';
  const night = ok && isWeatherNight(data.sunrise, data.sunset);
  mounts.forEach(mount => {
    const root = document.createElement('div');
    root.className = 'weather-tile-root';
    // Mirror the weather state onto the root so the body carries a faint ambient
    // tint matching the hero's sky — the whole widget reads as one scene.
    setWeatherStateClass(root, state);
    root.classList.toggle('is-night', !!night);
    root.appendChild(buildWeatherHeroCard(data));

    if (ok) {
      const body = document.createElement('div');
      body.className = 'weather-tile-body';
      if (sec.metrics) {
        body.appendChild(buildWeatherTileSection('weather_section_details', buildWeatherMetricsGrid(data)));
      }
      if (sec.hourly && Array.isArray(data.hourly) && data.hourly.length) {
        const h = document.createElement('div');
        h.className = 'weather-hourly';
        data.hourly.forEach(hour => h.appendChild(createWeatherHour(hour)));
        body.appendChild(buildWeatherTileSection('weather_hourly', h));
      }
      if (sec.forecast && Array.isArray(data.forecast) && data.forecast.length) {
        body.appendChild(buildWeatherTileSection('weather_forecast', buildWeatherTileForecast(data)));
      }
      if (body.children.length) {
        root.classList.add('has-body');
        root.appendChild(body);
      }
    }
    mount.replaceChildren(root);
  });
}

function setWeatherModalState(data) {
  const state = data && data.ok ? classifyWeatherState(data) : 'state-offline';
  setWeatherStateClass(document.querySelector('.weather-panel'), state);
  setWeatherStateClass($('weather-hero-visual'), state);
  setWeatherStateClass($('weather-pill'), state);
  setWeatherStateClass($('weather-pill-icon'), state);
  // At night the light source behind clouds/rain/etc. must be the moon, not the
  // sun (the precipitation states don't have their own night variant).
  const hero = $('weather-hero-visual');
  if (hero) {
    const night = !!(data && data.ok && isWeatherNight(data.sunrise, data.sunset));
    hero.classList.toggle('is-night', night);
  }
}

function aqiLabel(aqi) {
  const n = Number(aqi);
  if (!Number.isFinite(n)) return '--';
  if (n <= 20) return t('weather_aqi_good');
  if (n <= 40) return t('weather_aqi_fair');
  if (n <= 60) return t('weather_aqi_moderate');
  if (n <= 80) return t('weather_aqi_poor');
  if (n <= 100) return t('weather_aqi_very_poor');
  return t('weather_aqi_hazardous');
}

// Semantic severity per metric value → 'good' | 'moderate' | 'bad' (or '').
function weatherMetricLevel(metric, v) {
  if (v == null || v === '' || !Number.isFinite(Number(v))) return '';
  const n = Number(v);
  switch (metric) {
    case 'aqi':        return n <= 50 ? 'good' : n <= 100 ? 'moderate' : 'bad';
    case 'pm25':       return n <= 12 ? 'good' : n <= 35 ? 'moderate' : 'bad';
    case 'pm10':       return n <= 54 ? 'good' : n <= 154 ? 'moderate' : 'bad';
    case 'uv':         return n <= 2 ? 'good' : n <= 5 ? 'moderate' : 'bad';
    case 'humidity':   return (n >= 40 && n <= 60) ? 'good' : (n >= 30 && n <= 70) ? 'moderate' : 'bad';
    case 'visibility': return n >= 10 ? 'good' : n >= 4 ? 'moderate' : 'bad';
    default:           return '';
  }
}

function createWeatherMetric(label, value, sub, metric, level) {
  const card = document.createElement('div');
  card.className = 'weather-metric' + (level ? ` weather-metric--${level}` : '');
  if (metric) card.dataset.metric = metric;
  const labelEl = document.createElement('div');
  labelEl.className = 'weather-metric-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('div');
  valueEl.className = 'weather-metric-value';
  valueEl.textContent = value;
  const subEl = document.createElement('div');
  subEl.className = 'weather-metric-sub';
  subEl.textContent = sub || '';
  card.append(labelEl, valueEl, subEl);
  return card;
}

function createWeatherHour(hour) {
  const card = document.createElement('div');
  card.className = 'weather-hour';
  const state = classifyWeatherState(hour);
  card.dataset.weather = weatherStateIcon(state);
  const time = document.createElement('div');
  time.className = 'weather-hour-time';
  time.textContent = hour.time || '--';
  const icon = document.createElement('span');
  icon.className = `weather-mini-icon ${state}`;
  const temp = document.createElement('div');
  temp.className = 'weather-hour-temp';
  temp.textContent = weatherDisplayValue(toDisplayTemp(hour.tempC), '°');
  card.title = [hour.condition, hour.windKph != null ? `${hour.windKph} km/h` : ''].filter(Boolean).join(' · ');
  card.append(time, icon, temp);
  // Rain chance isn't available from every provider — show it only when present
  // instead of a bare "Rain --".
  if (hour.rain != null) {
    const rain = document.createElement('div');
    rain.className = 'weather-hour-rain';
    rain.textContent = `${t('weather_rain_short')} ${weatherDisplayValue(hour.rain, '%')}`;
    card.append(rain);
  }
  return card;
}

function createWeatherDay(day) {
  const card = document.createElement('div');
  card.className = 'weather-day';
  const state = classifyWeatherState(day);
  card.dataset.weather = weatherStateIcon(state);
  const top = document.createElement('div');
  top.className = 'weather-day-top';
  const date = document.createElement('span');
  date.textContent = formatWeatherDate(day.date);
  const range = document.createElement('span');
  range.className = 'weather-day-range';
  range.textContent = `${weatherDisplayValue(toDisplayTemp(day.minC), '°')} / ${weatherDisplayValue(toDisplayTemp(day.maxC), '°')}`;
  top.append(date, range);
  const condition = document.createElement('div');
  condition.className = 'weather-day-condition';
  condition.textContent = day.condition || '--';
  const icon = document.createElement('span');
  icon.className = `weather-mini-icon weather-day-icon ${state}`;
  card.append(top, icon, condition);
  // Sunrise/sunset isn't available from every provider — show the row only when
  // there's at least one real time rather than a bare "Sun -- - --".
  if (day.sunrise || day.sunset) {
    const sun = document.createElement('div');
    sun.className = 'weather-day-sun';
    sun.textContent = `${t('weather_sun')} ${day.sunrise || '--'} - ${day.sunset || '--'}`;
    card.append(sun);
  }
  return card;
}

function renderWeatherDetails() {
  const overlay = $('weather-overlay');
  if (!overlay || overlay.hidden) return;
  const data = weatherData;
  const place = $('weather-modal-place');
  const temp = $('weather-modal-temp');
  const condition = $('weather-modal-condition');
  const updated = $('weather-modal-updated');
  const heroFeels = $('weather-hero-feels');
  const heroWind = $('weather-hero-wind');
  const heroRain = $('weather-hero-rain');
  const metrics = $('weather-metrics');
  const hourly = $('weather-hourly');
  const forecast = $('weather-forecast');
  if (!place || !temp || !condition || !updated || !metrics || !hourly || !forecast) return;

  if (!data || !data.ok) {
    setWeatherModalState(null);
    place.textContent = t('weather_unavailable');
    temp.textContent = '--°';
    condition.textContent = t('weather_no_data');
    updated.textContent = '';
    if (heroFeels) heroFeels.textContent = '--';
    if (heroWind) heroWind.textContent = '--';
    if (heroRain) heroRain.textContent = '--';
    metrics.replaceChildren(createWeatherMetric(t('weather_status'), t('offline'), t('weather_retry_hint')));
    hourly.replaceChildren();
    forecast.replaceChildren();
    return;
  }

  setWeatherModalState(data);
  const fullPlace = [data.location, data.region, data.country].filter(Boolean).join(', ');
  place.textContent = fullPlace || t('weather_local');
  temp.textContent = `${toDisplayTemp(data.tempC)}°`;
  condition.textContent = data.condition || t('weather_title');
  updated.textContent = formatWeatherUpdated(data.updatedAt);
  if (heroFeels) heroFeels.textContent = weatherDisplayValue(toDisplayTemp(data.feelsC), '°' + tempUnitSuffix());
  if (heroWind) heroWind.textContent = weatherDisplayValue(data.windKph, ' km/h');
  if (heroRain) heroRain.textContent = weatherDisplayValue(data.precipMM, ' mm');

  metrics.replaceChildren(
    createWeatherMetric(t('weather_metric_aqi'),  weatherDisplayValue(data.aqi),             aqiLabel(data.aqi),                   'aqi',        weatherMetricLevel('aqi', data.aqi)),
    createWeatherMetric(t('weather_metric_humidity'), weatherDisplayValue(data.humidity, '%'), t('weather_metric_humidity_sub'),     'humidity',   weatherMetricLevel('humidity', data.humidity)),
    createWeatherMetric(t('weather_metric_pm25'), weatherDisplayValue(data.pm25, ' μg/m³'),  'PM2.5',                              'pm25',       weatherMetricLevel('pm25', data.pm25)),
    createWeatherMetric(t('weather_metric_pm10'), weatherDisplayValue(data.pm10, ' μg/m³'),  'PM10',                               'pm10',       weatherMetricLevel('pm10', data.pm10)),
    createWeatherMetric(t('weather_metric_pressure'), weatherDisplayValue(data.pressure, ' hPa'), t('weather_metric_pressure_sub'), 'pressure'),
    createWeatherMetric(t('weather_metric_visibility'), weatherDisplayValue(data.visibility, ' km'), t('weather_metric_visibility_sub'), 'visibility', weatherMetricLevel('visibility', data.visibility)),
    createWeatherMetric(t('weather_metric_uv'),    weatherDisplayValue(data.uv),              t('weather_metric_uv_sub'),           'uv',         weatherMetricLevel('uv', data.uv)),
    createWeatherMetric(t('weather_metric_clouds'), weatherDisplayValue(data.cloudCover, '%'), t('weather_metric_clouds_sub'),      'clouds'),
  );

  hourly.replaceChildren(...(Array.isArray(data.hourly) ? data.hourly : []).map(createWeatherHour));
  forecast.replaceChildren(...(Array.isArray(data.forecast) ? data.forecast : []).map(createWeatherDay));
}

function toggleWeatherDetails() {
  const overlay = $('weather-overlay');
  if (!overlay) return;
  overlay.hidden = !overlay.hidden;
  if (!overlay.hidden) {
    renderWeatherDetails();
    if (!weatherData) fetchWeather();
  }
}

function closeWeatherDetails() {
  const overlay = $('weather-overlay');
  if (overlay) overlay.hidden = true;
}

async function fetchWeather() {
  if (fetchingWeather) return;
  fetchingWeather = true;
  try {
    const params = new URLSearchParams({ lang });
    const weatherSettings = typeof normalizeWeatherSettings === 'function'
      ? normalizeWeatherSettings(hubSettings && hubSettings.weather)
      : { mode: 'auto', city: '' };
    if (weatherSettings.mode === 'manual' && weatherSettings.city) {
      params.set('mode', 'manual');
      params.set('city', weatherSettings.city);
    } else {
      params.set('mode', 'auto');
    }
    const res = await fetch(`${SERVER}/weather?${params.toString()}`);
    if (!res.ok) throw new Error('Weather unavailable');
    applyWeather(await res.json());
  } catch {
    applyWeather(null);
  }
  fetchingWeather = false;
}

async function fetchSystem() {
  if (fetchingSystem) return;
  fetchingSystem = true;
  try {
    const res = await fetch(SERVER + '/system');
    if (!res.ok) throw new Error('System unavailable');
    const data = await res.json();
    applySystem(data);
  } catch { }
  fetchingSystem = false;
}
