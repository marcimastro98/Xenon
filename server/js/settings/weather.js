// The weather settings: provider, refresh, forecast days, what the tile shows and the city.
'use strict';

let weatherSettingsFetchTimer = null;

function syncWeatherSettingsControls() {
  const weather = normalizeWeatherSettings(hubSettings.weather);
  document.querySelectorAll('.settings-weather-mode[data-weather-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.weatherMode === weather.mode);
    btn.setAttribute('aria-pressed', String(btn.dataset.weatherMode === weather.mode));
  });
  const cityInput = $('settings-weather-city');
  if (cityInput) {
    cityInput.value = weather.city;
    cityInput.closest('.settings-row').hidden = weather.mode !== 'manual';
  }
  const unit = hubSettings.tempUnit === 'f' ? 'f' : 'c';
  document.querySelectorAll('.settings-temp-unit[data-temp-unit]').forEach(btn => {
    const active = btn.dataset.tempUnit === unit;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  const hwUnit = ['c', 'f'].includes(hubSettings.hwTempUnit) ? hubSettings.hwTempUnit : 'auto';
  document.querySelectorAll('.settings-hw-temp-unit[data-hw-temp-unit]').forEach(btn => {
    const active = btn.dataset.hwTempUnit === hwUnit;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  const providerSelect = $('settings-weather-provider');
  if (providerSelect && providerSelect.value !== weather.provider) {
    providerSelect.value = weather.provider;
    // The custom-select overlay re-syncs its visible label on 'change'; the
    // guarded updateWeatherProvider makes this dispatch a no-op for persistence.
    providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const refreshSelect = $('settings-weather-refresh');
  if (refreshSelect && refreshSelect.value !== String(weather.refreshMin)) {
    refreshSelect.value = String(weather.refreshMin);
    // Guarded updateWeatherRefresh makes this label-sync dispatch a no-op for persistence.
    refreshSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const daysSelect = $('settings-weather-days');
  if (daysSelect && daysSelect.value !== String(weather.forecastDays)) {
    daysSelect.value = String(weather.forecastDays);
    // Guarded updateWeatherForecastDays neutralizes this label-sync 'change' dispatch.
    daysSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (window.WeatherLook) window.WeatherLook.sync();
  document.querySelectorAll('.settings-weather-hero[data-weather-hero]').forEach(btn => {
    const active = btn.dataset.weatherHero === weather.tile.hero;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  WEATHER_TILE_SECTIONS.forEach(key => {
    const cb = $('settings-weather-tile-' + key);
    if (cb) cb.checked = weather.tile[key] !== false;
  });
  WEATHER_FIELD_IDS.forEach(id => {
    const cb = $('settings-weather-field-' + id);
    if (cb) cb.checked = weather.tile.fields[id] !== false;
  });
}

function queueWeatherSettingsRefresh(delay = 0) {
  clearTimeout(weatherSettingsFetchTimer);
  weatherSettingsFetchTimer = setTimeout(() => {
    weatherSettingsFetchTimer = null;
    if (typeof fetchWeather === 'function') fetchWeather();
  }, delay);
}

// Signature of the weather settings the client's fetch/poll actually depends
// on: what to fetch (mode/city/provider — provider is applied server-side but
// still changes the data) and how often (refreshMin). The SSE-sync hydrate
// compares it before/after a merge so a change made on ANOTHER surface
// refetches here too, not only local control edits (GitHub #72).
function _weatherSyncSig(w) {
  const n = normalizeWeatherSettings(w);
  return {
    fetch: n.mode + '|' + String(n.city || '').toLowerCase() + '|' + n.provider,
    refreshMin: n.refreshMin,
  };
}

// Which widget instances sit on which page — the structural shape of the layout,
// NOT its geometry. Captures a primary being shown/hidden or moved to another page,
// a duplicated/custom copy being added/removed, and any tab-group change. An
// in-page move/resize does NOT change this (that's the light applyDashboardLayout
// path); a structural change routes to a full rebuild so a widget added on another
// screen materializes live instead of only after a reload (GitHub #72).
function _dashboardPlacementSig(layout) {
  if (!layout || typeof layout !== 'object') return '';
  const widgets = layout.widgets || {};
  const wids = Object.keys(widgets)
    .filter(id => widgets[id] && widgets[id].visible)
    .map(id => id + '@' + (widgets[id].page || ''))
    .sort();
  const copies = (Array.isArray(layout.copies) ? layout.copies : [])
    .map(c => c.id + '=' + c.widget + '@' + (c.page || ''))
    .sort();
  const groups = Object.keys(layout.groups || {})
    .map(gid => {
      const g = layout.groups[gid] || {};
      return gid + '@' + (g.page || '') + ':' + ((g.members || []).slice().sort().join(','));
    })
    .sort();
  return JSON.stringify({ wids, copies, groups });
}

function updateWeatherProvider(provider) {
  if (!WEATHER_PROVIDER_IDS.includes(provider)) return;
  // No-op when unchanged. This also makes the programmatic `change` dispatched by
  // syncWeatherSettingsControls (to refresh the custom-select label) harmless.
  if (normalizeWeatherSettings(hubSettings.weather).provider === provider) return;
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, provider },
  });
  commitWeatherChange();
  syncWeatherSettingsControls();
  queueWeatherSettingsRefresh();
  setSettingsStatus('settings_weather_saved', 'ok');
}

// Change how often the client re-fetches weather. Restarts the polling timer so
// the new cadence takes effect immediately (no reload needed).
function updateWeatherRefresh(value) {
  const min = Number(value);
  if (!WEATHER_REFRESH_CHOICES.includes(min)) return;
  // No-op when unchanged (also neutralizes the sync-triggered 'change' dispatch).
  if (normalizeWeatherSettings(hubSettings.weather).refreshMin === min) return;
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, refreshMin: min },
  });
  commitWeatherChange();
  syncWeatherSettingsControls();
  if (typeof startWeatherPolling === 'function') startWeatherPolling();
  setSettingsStatus('settings_weather_saved', 'ok');
}

// Change how many days the "next days" forecast shows (1–7). The server already
// returns up to 7 days, so this only re-renders — no re-fetch needed.
function updateWeatherForecastDays(value) {
  const days = Number(value);
  if (!WEATHER_FORECAST_DAY_CHOICES.includes(days)) return;
  // No-op when unchanged (also neutralizes the sync-triggered 'change' dispatch).
  if (normalizeWeatherSettings(hubSettings.weather).forecastDays === days) return;
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, forecastDays: days },
  });
  commitWeatherChange();
  syncWeatherSettingsControls();
  if (typeof renderWeatherTile === 'function') renderWeatherTile();
  if (typeof renderWeatherDetails === 'function') renderWeatherDetails();
  setSettingsStatus('settings_weather_saved', 'ok');
}

// Big card or one line for the tile's current conditions. Tile only: the
// modal always has the room for the full hero.
function updateWeatherTileHero(hero) {
  if (!WEATHER_TILE_HEROES.includes(hero)) return;
  const tile = normalizeWeatherTile(hubSettings.weather && hubSettings.weather.tile);
  if (tile.hero === hero) return;
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, tile: { ...tile, hero } },
  });
  commitWeatherChange();
  syncWeatherSettingsControls();
  if (typeof renderWeatherTile === 'function') renderWeatherTile();
  setSettingsStatus('settings_weather_saved', 'ok');
}

function updateWeatherTileSection(key, checked) {
  if (!WEATHER_TILE_SECTIONS.includes(key)) return;
  const tile = { ...normalizeWeatherTile(hubSettings.weather && hubSettings.weather.tile), [key]: !!checked };
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, tile },
  });
  commitWeatherChange();
  syncWeatherSettingsControls();
  if (typeof renderWeatherTile === 'function') renderWeatherTile();
  setSettingsStatus('settings_weather_saved', 'ok');
}

// Toggle a single detail chip/metric (visibility, PM2.5, feels-like, …). Unlike
// the section toggles above, this applies to both the tile and the modal.
function updateWeatherTileField(id, checked) {
  if (!WEATHER_FIELD_IDS.includes(id)) return;
  const tile = normalizeWeatherTile(hubSettings.weather && hubSettings.weather.tile);
  tile.fields = { ...tile.fields, [id]: !!checked };
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, tile },
  });
  commitWeatherChange();
  syncWeatherSettingsControls();
  if (typeof renderWeatherTile === 'function') renderWeatherTile();
  if (typeof renderWeatherDetails === 'function') renderWeatherDetails();
  setSettingsStatus('settings_weather_saved', 'ok');
}

function updateWeatherMode(mode) {
  if (!['auto', 'manual'].includes(mode)) return;
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, mode },
  });
  commitWeatherChange();
  syncWeatherSettingsControls();
  queueWeatherSettingsRefresh();
  setSettingsStatus('settings_weather_saved', 'ok');
}

function updateWeatherCity(value, commit = false) {
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, city: value },
  });
  commitWeatherChange();
  if (commit) syncWeatherSettingsControls();
  if (hubSettings.weather.mode === 'manual' && hubSettings.weather.city) queueWeatherSettingsRefresh(450);
  setSettingsStatus('settings_weather_saved', 'ok');
}
