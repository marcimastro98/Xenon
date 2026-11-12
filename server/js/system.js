'use strict';

// The server's first answer after a start: its slow readings are still out, so a
// missing detail says nothing yet about the machine.
let systemAnswerPartial = false;

// Scoped field lookup within one System instance root.
function sf(root, name) { return root.querySelector('[data-sf="' + name + '"]'); }

function cycleDisk() {
  if (!systemDisks || systemDisks.length < 2) return;
  diskIndex = (diskIndex + 1) % systemDisks.length;
  if (window.DashboardGrid && window.DashboardGrid.forEachInstance) {
    window.DashboardGrid.forEachInstance('system', root => renderDiskInto(root, systemDisks[diskIndex]));
  }
}

// Flip the GPU card between load % and VRAM %. The two series are unrelated, so
// clear the sparkline history first — otherwise the graph would splice load and
// memory into one line. Re-renders from the cached payload for instant feedback.
function cycleGpuMetric() {
  gpuMetric = gpuMetric === 'vram' ? 'load' : 'vram';
  if (window.DashboardGrid && window.DashboardGrid.forEachInstance) {
    window.DashboardGrid.forEachInstance('system', root => resetStatSparkFor(sf(root, 'gpu-fill')));
  }
  if (lastSystemData) applySystem(lastSystemData);
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
    // Most Windows volumes carry no label at all, which left this line reading
    // "NTFS - Fixed". The disk's own name is the better answer when there is no
    // label, and it is what people expect to see under a drive.
    const parts = [disk.label || disk.model, disk.fileSystem, disk.driveType]
      .map(p => String(p || '').trim()).filter(Boolean);
    detail.textContent = parts.length ? parts.join(' - ') : (systemAnswerPartial ? '--' : t('disk_detail_unavailable'));
  }
  if (fill) setFill(fill, disk.percent);
}

// Back-compat: render the "current" disk into every instance.
function renderDisk(disk) {
  if (window.DashboardGrid && window.DashboardGrid.forEachInstance) {
    window.DashboardGrid.forEachInstance('system', root => renderDiskInto(root, disk));
  }
}

// Shorten a raw CPU/GPU model string for the compact header line next to the
// CPU/GPU label — drop marketing noise (®/™, "Processor", "N-Core", "GeForce",
// "with Radeon Graphics") and collapse spaces so it reads like "Ryzen 7 7800X3D"
// or "NVIDIA RTX 5080". CSS ellipsis handles whatever still overflows.
function shortHwName(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s === '--') return '';
  return s
    .replace(/\((?:R|TM)\)/gi, '')
    .replace(/[®™]/g, '')
    .replace(/\b\d+\s*-?\s*Core\b/gi, '')
    .replace(/\bProcessor\b/gi, '')
    .replace(/\bGeForce\b/gi, '')
    .replace(/\bwith\s+Radeon\s+Graphics\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function applySystemInto(root, data) {
  const set = (name, text) => { const el = sf(root, name); if (el) el.textContent = text; };
  const fillEl = (name, pct) => { const el = sf(root, name); if (el) setFill(el, pct); };

  set('host-name', data.hostname || 'Local cockpit');
  set('uptime-text', `${t('uptime_prefix')} ${formatUptime(data.uptime)}`);

  const cpu = Number.isFinite(data.cpu) ? data.cpu : 0;
  set('cpu-value', cpu + '%'); fillEl('cpu-fill', cpu); set('cpu-name', data.cpuName || '--');
  set('cpu-name-head', shortHwName(data.cpuName));
  const cpuTemp = Number(data.cpuTemp);
  set('cpu-head-temp', (Number.isFinite(cpuTemp) && cpuTemp > 0) ? toDisplayHwTemp(cpuTemp) + '°' + hwTempUnitSuffix() : '');

  const ram = data.memory ? data.memory.percent : 0;
  set('ram-value', ram + '%');
  set('ram-small', data.memory ? formatBytes(data.memory.total) : '');
  fillEl('ram-fill', ram);
  set('ram-sub', data.memory ? formatBytes(data.memory.used) + ' / ' + formatBytes(data.memory.total) : '--');
  const ramDetail = data.ramDetail || {};
  set('ram-detail', ramDetail.detail || data.ramName || (systemAnswerPartial ? '--' : t('ram_detail_unavailable')));
  set('ram-name', ramDetail.moduleName || '');

  // The GPU card shows either load % or VRAM % (tap the ⇄ toggle). VRAM only
  // exists when the sensor reported it (nvidia-smi / LHM); otherwise the toggle
  // stays hidden and the card is pinned to load, so nothing regresses on GPUs
  // that don't expose dedicated memory.
  const vramUsed = Number(data.vramUsed), vramTotal = Number(data.vramTotal);
  const hasVram = Number.isFinite(vramTotal) && vramTotal > 0 && Number.isFinite(vramUsed) && vramUsed >= 0;
  const showVram = hasVram && gpuMetric === 'vram';
  set('gpu-metric-label', showVram ? 'VRAM' : 'GPU');

  if (showVram) {
    const vramPct = Math.round((vramUsed / vramTotal) * 100);
    set('gpu-value', vramPct + '%'); fillEl('gpu-fill', vramPct);
    set('gpu-vram-detail', `${formatBytes(vramUsed)} / ${formatBytes(vramTotal)}`);
  } else if (data.gpu === null || data.gpu === undefined) {
    set('gpu-value', '--%'); fillEl('gpu-fill', 0);
    set('gpu-vram-detail', '');
  } else {
    set('gpu-value', data.gpu + '%'); fillEl('gpu-fill', data.gpu);
    set('gpu-vram-detail', '');
  }
  const metricBtn = sf(root, 'gpu-metric-btn');
  if (metricBtn) metricBtn.style.display = hasVram ? '' : 'none';

  set('gpu-name', data.gpuName || t('gpu_loading'));
  set('gpu-name-head', shortHwName(data.gpuName));
  const gpuTemp = Number(data.gpuTemp);
  set('gpu-head-temp', (Number.isFinite(gpuTemp) && gpuTemp > 0) ? toDisplayHwTemp(gpuTemp) + '°' + hwTempUnitSuffix() : '');

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
  // The two answers can cross on the way in: a full one is never replaced by a partial.
  if (data.partial && lastSystemData && !lastSystemData.partial) return;
  systemAnswerPartial = !!data.partial;
  lastSystemData = data;
  if (window.DashboardGrid && window.DashboardGrid.forEachInstance) {
    window.DashboardGrid.forEachInstance('system', root => applySystemInto(root, data));
  }
}

// EVERY temperature inside Xenon is Celsius — the weather API, the hardware
// collectors, Guardian's alert thresholds, the briefing history. Only the
// display converts, against client-side preferences (hubSettings.tempUnit and
// hubSettings.hwTempUnit), so switching the unit needs no re-fetch and no stored
// value is ever ambiguous.
// Returns null/'' unchanged so callers' "--" placeholder still works.
function convertTemp(celsius, fahrenheit) {
  if (celsius === null || celsius === undefined || celsius === '') return celsius;
  const c = Number(celsius);
  if (!Number.isFinite(c)) return celsius;
  return Math.round(fahrenheit ? c * 9 / 5 + 32 : c);
}
function weatherTempIsF() {
  return typeof hubSettings === 'object' && hubSettings && hubSettings.tempUnit === 'f';
}
// Hardware readings (CPU/GPU headers, Guardian, the briefing) can have their own
// unit: some people read the forecast in °F and their CPU in °C. 'auto' follows
// the weather unit, so nobody who never touches it sees a change.
function hwTempIsF() {
  const hs = typeof hubSettings === 'object' && hubSettings ? hubSettings : {};
  return hs.hwTempUnit === 'f' || hs.hwTempUnit === 'c' ? hs.hwTempUnit === 'f' : hs.tempUnit === 'f';
}
function toDisplayTemp(celsius) { return convertTemp(celsius, weatherTempIsF()); }
function tempUnitSuffix() { return weatherTempIsF() ? 'F' : 'C'; }
function toDisplayHwTemp(celsius) { return convertTemp(celsius, hwTempIsF()); }
function hwTempUnitSuffix() { return hwTempIsF() ? 'F' : 'C'; }

// Fill the temperature placeholders of a translated string: each named token
// holds a Celsius number to convert, and every `{u}` becomes the unit letter.
// Every string that goes through here is a hardware reading, so it follows the
// hardware unit.
// The alternative was a .replace() chain at each call site, which is how the
// hardware headers and the Guardian/briefing toasts ended up printing a hard
// "°C" to someone who had picked °F — the preference is labelled "Temperature
// unit", not "Weather temperature unit", so it has to reach all of them.
// Every token is replaced globally: an anomaly line names two temperatures.
function fillTemps(text, values) {
  let out = String(text == null ? '' : text);
  for (const token of Object.keys(values || {})) {
    out = out.split('{' + token + '}').join(String(toDisplayHwTemp(values[token])));
  }
  return out.split('{u}').join(hwTempUnitSuffix());
}

// A forecast that failed now says WHICH link broke. The server answers ok:false
// with an `error` (server.js getWeather) instead of a 500, because "unavailable"
// alone is indistinguishable from a bug in Xenon: the same blank tile means the
// PC never got its coordinates, or the city was not found, or the weather
// services were down — three different things to do about it, and the user was
// shown none of them. Unknown/absent error (a fetch that never reached the
// server) keeps the old generic wording.
const WEATHER_ERROR_KEYS = {
  no_location: 'weather_err_no_location',
  city_not_found: 'weather_err_city',
  providers_down: 'weather_err_providers',
};
function weatherErrorLabel(data) {
  const key = WEATHER_ERROR_KEYS[data && data.error];
  return key ? t(key) : t('weather_no_data');
}
function weatherErrorHint(data) {
  const key = WEATHER_ERROR_KEYS[data && data.error];
  return key ? t(`${key}_hint`) : t('weather_retry_hint');
}

// The last reading that actually arrived, kept so a failed poll degrades to
// "this is a bit old" instead of to nothing. A forecast is hours-scale data: the
// one from 15 minutes ago is still worth reading, and throwing it away turns a
// single missed request into a tile that looks broken. Bounded, because a
// forecast from this morning shown as if it were current is worse than an empty
// card — past the cap the failure is reported honestly.
let lastGoodWeather = null;
const WEATHER_STALE_MAX_MS = 3 * 60 * 60 * 1000;
// Well under the shortest refresh interval (10 min), so a hung request is
// abandoned long before the next poll is due rather than blocking it.
const WEATHER_FETCH_TIMEOUT_MS = 20 * 1000;
function weatherStaleFallback() {
  if (!lastGoodWeather) return null;
  const age = Date.now() - Number(lastGoodWeather.updatedAt || 0);
  if (!(age >= 0) || age > WEATHER_STALE_MAX_MS) return null;
  return { ...lastGoodWeather, stale: true };
}

// Pages that load this file for the System tile have no Weather tile or window to feed.
function refreshWeatherTile() {
  if (typeof renderWeatherTile === 'function') renderWeatherTile();
  if (typeof renderWeatherDetails === 'function') renderWeatherDetails();
}

function applyWeather(data) {
  if (data && data.ok && !data.stale) lastGoodWeather = data;
  weatherData = data || null;
  // Relay to granted SDK widgets/scenes. Weather is client-polled (no SSE
  // event); CustomWidget caches lastData so late-joining frames seed on hello.
  // Never relay a failure `null` — it would be cached and replayed to every
  // later frame; widgets only ever see server-built objects (ok:false included).
  if (window.CustomWidget && weatherData) CustomWidget.onData('weather', weatherData);
  const pill = $('weather-pill');
  if (!pill) { refreshWeatherTile(); return; }

  if (!data || !data.ok) {
    pill.classList.add('offline');
    $('weather-temp').textContent = '--°';
    $('weather-place').textContent = t('weather_unavailable');
    pill.title = [t('weather_unavailable'), weatherErrorLabel(data)].join(' · ');
    applyWeatherPillState(null);
    refreshWeatherTile();
    return;
  }

  pill.classList.toggle('offline', !!data.stale);
  $('weather-temp').textContent = `${toDisplayTemp(data.tempC)}°`;
  $('weather-place').textContent = data.location || t('weather_local');
  applyWeatherPillState(data);
  const parts = [data.condition, data.location, data.feelsC != null ? `${t('weather_feels')} ${toDisplayTemp(data.feelsC)}°${tempUnitSuffix()}` : '']
    .filter(Boolean);
  pill.title = parts.length ? parts.join(' · ') : t('weather_title');
  refreshWeatherTile();
}

function weatherDisplayValue(value, suffix = '') {
  return value === null || value === undefined || value === '' ? '--' : `${value}${suffix}`;
}

// Wind / precipitation / visibility follow the SAME unit choice as temperature
// (hubSettings.tempUnit): metric by default, imperial when the user picked °F —
// so choosing Fahrenheit gives mph / inches / miles too, instead of leaving
// these three stuck in metric (the reported "F but wind is in km/h" bug). The
// server always sends metric (km/h, mm, km); convert + suffix on render, so
// flipping the unit needs no re-fetch. Level thresholds still read the raw
// metric value — only the displayed number is converted.
function weatherIsImperial() {
  return weatherTempIsF();
}
function displayWind(kph) {
  if (kph === null || kph === undefined || kph === '') return '--';
  const v = Number(kph);
  if (!Number.isFinite(v)) return '--';
  return weatherIsImperial() ? `${Math.round(v * 0.621371)} mph` : `${kph} km/h`;
}
function displayPrecip(mm) {
  if (mm === null || mm === undefined || mm === '') return '--';
  const v = Number(mm);
  if (!Number.isFinite(v)) return '--';
  return weatherIsImperial() ? `${(v / 25.4).toFixed(2)} in` : `${mm} mm`;
}
function displayVisibility(km) {
  if (km === null || km === undefined || km === '') return '--';
  const v = Number(km);
  if (!Number.isFinite(v)) return '--';
  return weatherIsImperial() ? `${(v * 0.621371).toFixed(1)} mi` : `${km} km`;
}

function formatWeatherUpdated(timestamp) {
  const date = new Date(timestamp || Date.now());
  if (!Number.isFinite(date.getTime())) return '--';
  return `${t('weather_updated')} ${date.toLocaleTimeString(i18n[lang].locale, timeParts())}`;
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

// `atMin`: minutes since midnight of the moment asked about (an hour of the
// forecast); without it, now.
const WEATHER_DAY_NOON_MIN = 12 * 60;

function isWeatherNight(sunrise, sunset, atMin) {
  const now = new Date();
  const nowMin = Number.isFinite(atMin) ? atMin : now.getHours() * 60 + now.getMinutes();
  const riseMin = parseSunTime(sunrise);
  const setMin = parseSunTime(sunset);
  if (riseMin != null && setMin != null) return nowMin < riseMin || nowMin >= setMin;
  return nowMin < 6 * 60 || nowMin >= 20 * 60;
}

function weatherCodeState(code, sunrise, sunset, atMin) {
  const numeric = Number(code);
  if (!Number.isFinite(numeric)) return '';
  if (WEATHER_STORM_CODES.has(numeric)) return 'state-storm';
  if (WEATHER_SNOW_CODES.has(numeric)) return 'state-snow';
  if (WEATHER_RAIN_CODES.has(numeric)) return 'state-rain';
  if (WEATHER_FOG_CODES.has(numeric)) return 'state-fog';
  if (WEATHER_CLOUD_CODES.has(numeric)) return 'state-cloud';
  if (WEATHER_CLEAR_CODES.has(numeric)) return isWeatherNight(sunrise, sunset, atMin) ? 'state-moon' : 'state-sun';
  return '';
}

function classifyWeatherState(source, atMin) {
  const sunrise = source && typeof source === 'object' ? source.sunrise : null;
  const sunset = source && typeof source === 'object' ? source.sunset : null;
  const byCode = source && typeof source === 'object' ? weatherCodeState(source.code ?? source.weatherCode, sunrise, sunset, atMin) : '';
  if (byCode) return byCode;
  const text = String(source && typeof source === 'object' ? source.condition : source || '').toLowerCase();
  const night = isWeatherNight(sunrise, sunset, atMin);
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

// How many days the "next days" forecast should render (1–7). The server returns
// up to 7 days; the client trims to the user's preference. Providers that expose
// fewer (wttr.in = 3) simply show what's available.
function weatherForecastDays() {
  const w = (typeof hubSettings === 'object' && hubSettings && hubSettings.weather) || {};
  const n = Math.round(Number(w.forecastDays));
  return Number.isFinite(n) ? Math.max(1, Math.min(7, n)) : 3;
}

// Whether a single detail chip/metric (feels, wind, visibility, pm25, …) is
// enabled. Missing keys default to shown, so pre-existing settings render all
// fields until the user hides one. Applies to both the tile and the modal.
function weatherFieldEnabled(id) {
  const w = (typeof hubSettings === 'object' && hubSettings && hubSettings.weather) || {};
  const tile = w.tile && typeof w.tile === 'object' ? w.tile : {};
  const fields = tile.fields && typeof tile.fields === 'object' ? tile.fields : {};
  return fields[id] !== false;
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
    case 'aqi':        return n <= 40 ? 'good' : n <= 60 ? 'moderate' : 'bad';   // the same steps as aqiLabel
    case 'pm25':       return n <= 12 ? 'good' : n <= 35 ? 'moderate' : 'bad';
    case 'pm10':       return n <= 54 ? 'good' : n <= 154 ? 'moderate' : 'bad';
    case 'no2':        return n <= 40 ? 'good' : n <= 100 ? 'moderate' : 'bad';
    case 'pollen':     return n <= 20 ? 'good' : n <= 50 ? 'moderate' : 'bad';
    case 'uv':         return n <= 2 ? 'good' : n <= 5 ? 'moderate' : 'bad';
    case 'humidity':   return (n >= 40 && n <= 60) ? 'good' : (n >= 30 && n <= 70) ? 'moderate' : 'bad';
    case 'visibility': return n >= 10 ? 'good' : n >= 4 ? 'moderate' : 'bad';
    default:           return '';
  }
}

// The window itself is js/weather-window.js. These two doors stay here because every page
// with this file answers them, also the ones that have no window to open.
let weatherWindowLetGo = null;

function toggleWeatherDetails() {
  const overlay = $('weather-overlay');
  if (!overlay) return;
  if (!overlay.hidden) { closeWeatherDetails(); return; }
  overlay.hidden = false;
  if (typeof window.ambientFreeze === 'function') window.ambientFreeze('weather', true);
  if (!weatherData) fetchWeather();
  renderWeatherDetails();
  if (window.DialogFocus) {
    weatherWindowLetGo = window.DialogFocus.hold(overlay.querySelector('.weather-panel'), { onEsc: closeWeatherDetails });
  }
}

function closeWeatherDetails() {
  const overlay = $('weather-overlay');
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  if (window.WeatherLook) window.WeatherLook.releaseWindow($('weather-content'));   // stop the user's widget
  if (typeof window.ambientFreeze === 'function') window.ambientFreeze('weather', false);
  if (weatherWindowLetGo) weatherWindowLetGo();
  weatherWindowLetGo = null;
}

async function fetchWeather() {
  if (fetchingWeather) return;
  fetchingWeather = true;
  try {
    const params = new URLSearchParams({ lang });
    // The light pages (layer-lite.html, scene.html) carry no settings.js: the
    // server already normalized the block they read, so its city still counts.
    const weatherSettings = typeof normalizeWeatherSettings === 'function'
      ? normalizeWeatherSettings(hubSettings && hubSettings.weather)
      : ((hubSettings && hubSettings.weather) || {});
    if (weatherSettings.mode === 'manual' && weatherSettings.city) {
      params.set('mode', 'manual');
      params.set('city', weatherSettings.city);
    } else {
      params.set('mode', 'auto');
    }
    // The deadline is load-bearing, not a nicety — see fetchWithDeadline in
    // utils.js for what a hung request does to a flag-guarded poller. This is
    // the tile it was reported on.
    const res = await fetchWithDeadline(`${SERVER}/weather?${params.toString()}`, WEATHER_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error('Weather unavailable');
    applyWeather(await res.json());
  } catch {
    fetchingWeather = false;   // the window reads it: a failed request is no longer "loading"
    // A request that did not arrive says nothing about the weather, so the last
    // reading is kept and marked stale rather than blanked — the tile stays
    // useful across a hiccup, and the modal shows how old it is. Only when there
    // is nothing recent to fall back on does the failure state render. A server
    // that ANSWERS ok:false is different and is not routed here: it has already
    // bridged to its own cache, so its reason is what the user needs to see.
    //
    // The failure path RENDERS, unlike the other fetchers' empty catches, so it
    // can throw in turn (a missing pill node, a widget relay). Left unguarded
    // that second throw escapes the function and `fetchingWeather` never clears,
    // with the same permanent effect as the hang above. Both halves matter —
    // the inner catch, and the finally.
    try { applyWeather(weatherStaleFallback()); } catch { /* nothing renderable on this surface */ }
  } finally {
    fetchingWeather = false;
  }
}

async function fetchSystem() {
  if (fetchingSystem) return;
  fetchingSystem = true;
  try {
    const res = await fetchWithDeadline(SERVER + '/system', POLL_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error('System unavailable');
    const data = await res.json();
    applySystem(data);
    // The answer at boot usually beats the feed's first event: the splash has its data.
    if (window.BootSplash) window.BootSplash.ready('data');
  } catch { } finally {
    // In a `finally`, and behind a deadline: this is the SSE fallback poller, so
    // one hung request would strand the dashboard on the path that exists
    // precisely because the live stream is already unavailable.
    fetchingSystem = false;
  }
}
