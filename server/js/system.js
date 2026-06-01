'use strict';

function cycleDisk() {
  if (!systemDisks || systemDisks.length < 2) return;
  diskIndex = (diskIndex + 1) % systemDisks.length;
  renderDisk(systemDisks[diskIndex]);
}

function renderDisk(disk) {
  if (!disk) {
    $('disk-label').textContent = t('disk_label');
    $('disk-value').textContent = '--%';
    $('disk-small').textContent = '';
    $('disk-sub').textContent = '--';
    $('disk-detail').textContent = '--';
    setFill($('disk-fill'), 0);
    return;
  }
  $('disk-label').textContent = `${t('disk_label')} ${disk.drive}`;
  $('disk-value').textContent = disk.percent + '%';
  $('disk-small').textContent = formatBytes(disk.free) + ' ' + t('gb_free');
  $('disk-sub').textContent = formatBytes(disk.used) + ' / ' + formatBytes(disk.total);
  const diskDetails = [disk.label, disk.fileSystem, disk.driveType]
    .map(part => String(part || '').trim())
    .filter(Boolean);
  $('disk-detail').textContent = diskDetails.length ? diskDetails.join(' - ') : t('disk_detail_unavailable');
  setFill($('disk-fill'), disk.percent);
}

function applySystem(data) {
  if ($('host-name')) $('host-name').textContent = data.hostname || 'Local cockpit';
  $('uptime-text').textContent = `${t('uptime_prefix')} ${formatUptime(data.uptime)}`;

  const cpu = Number.isFinite(data.cpu) ? data.cpu : 0;
  $('cpu-value').textContent = cpu + '%';
  setFill($('cpu-fill'), cpu);
  $('cpu-name').textContent = data.cpuName || '--';
  const cpuHT = $('cpu-head-temp');
  const cpuTemp = Number(data.cpuTemp);
  if (Number.isFinite(cpuTemp) && cpuTemp > 0) {
    cpuHT.textContent = Math.round(cpuTemp) + '°C';
  } else {
    cpuHT.textContent = '';
  }

  const ram = data.memory ? data.memory.percent : 0;
  $('ram-value').textContent = ram + '%';
  $('ram-small').textContent = data.memory ? formatBytes(data.memory.total) : '';
  setFill($('ram-fill'), ram);
  if (data.memory) {
    $('ram-sub').textContent = formatBytes(data.memory.used) + ' / ' + formatBytes(data.memory.total);
  } else {
    $('ram-sub').textContent = '--';
  }
  const ramDetail = data.ramDetail || {};
  $('ram-detail').textContent = ramDetail.detail || data.ramName || t('ram_detail_unavailable');
  $('ram-name').textContent = ramDetail.moduleName || '';

  if (data.gpu === null || data.gpu === undefined) {
    $('gpu-value').textContent = '--%';
    setFill($('gpu-fill'), 0);
  } else {
    $('gpu-value').textContent = data.gpu + '%';
    setFill($('gpu-fill'), data.gpu);
  }
  $('gpu-name').textContent = data.gpuName || t('gpu_loading');
  const gpuHT = $('gpu-head-temp');
  const gpuTemp = Number(data.gpuTemp);
  if (Number.isFinite(gpuTemp) && gpuTemp > 0) {
    gpuHT.textContent = Math.round(gpuTemp) + '°C';
  } else {
    gpuHT.textContent = '';
  }

  if (data.disks && data.disks.length > 0) {
    systemDisks = data.disks;
    if (diskIndex >= systemDisks.length) diskIndex = 0;
    renderDisk(systemDisks[diskIndex]);
    const cycleBtn = $('disk-cycle-btn');
    if (cycleBtn) cycleBtn.style.display = systemDisks.length > 1 ? '' : 'none';
  } else {
    systemDisks = null;
    renderDisk(null);
    const cycleBtn = $('disk-cycle-btn');
    if (cycleBtn) cycleBtn.style.display = 'none';
  }
}

function applyWeather(data) {
  weatherData = data || null;
  const pill = $('weather-pill');
  if (!pill) return;

  if (!data || !data.ok) {
    pill.classList.add('offline');
    $('weather-temp').textContent = '--°';
    $('weather-place').textContent = t('weather_unavailable');
    pill.title = t('weather_unavailable');
    applyWeatherPillState(null);
    renderWeatherDetails();
    return;
  }

  pill.classList.toggle('offline', !!data.stale);
  $('weather-temp').textContent = `${data.tempC}°`;
  $('weather-place').textContent = data.location || t('weather_local');
  applyWeatherPillState(data);
  const parts = [data.condition, data.location, data.feelsC != null ? `${t('weather_feels')} ${data.feelsC}°C` : '']
    .filter(Boolean);
  pill.title = parts.length ? parts.join(' · ') : t('weather_title');
  renderWeatherDetails();
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
  const m = str.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (m[3].toUpperCase() === 'AM') { if (h === 12) h = 0; }
  else { if (h !== 12) h += 12; }
  return h * 60 + min;
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
  temp.textContent = weatherDisplayValue(hour.tempC, '°');
  const rain = document.createElement('div');
  rain.className = 'weather-hour-rain';
  rain.textContent = `${t('weather_rain_short')} ${weatherDisplayValue(hour.rain, '%')}`;
  card.title = [hour.condition, hour.windKph != null ? `${hour.windKph} km/h` : ''].filter(Boolean).join(' · ');
  card.append(time, icon, temp, rain);
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
  range.textContent = `${weatherDisplayValue(day.minC, '°')} / ${weatherDisplayValue(day.maxC, '°')}`;
  top.append(date, range);
  const condition = document.createElement('div');
  condition.className = 'weather-day-condition';
  condition.textContent = day.condition || '--';
  const icon = document.createElement('span');
  icon.className = `weather-mini-icon weather-day-icon ${state}`;
  const sun = document.createElement('div');
  sun.className = 'weather-day-sun';
  sun.textContent = `${t('weather_sun')} ${day.sunrise || '--'} - ${day.sunset || '--'}`;
  card.append(top, icon, condition, sun);
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
  temp.textContent = `${data.tempC}°`;
  condition.textContent = data.condition || t('weather_title');
  updated.textContent = formatWeatherUpdated(data.updatedAt);
  if (heroFeels) heroFeels.textContent = weatherDisplayValue(data.feelsC, '°C');
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
