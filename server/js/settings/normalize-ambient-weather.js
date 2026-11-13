// Cleans the saved lock-screen, idle-screen and weather settings.
'use strict';

function normalizeLockWidgets(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.lockWidgets;
  return {
    clock: source.clock !== undefined ? !!source.clock : defaults.clock,
    weather: source.weather !== undefined ? !!source.weather : defaults.weather,
    media: source.media !== undefined ? !!source.media : defaults.media,
    calendar: source.calendar !== undefined ? !!source.calendar : defaults.calendar,
  };
}

function normalizeAmbientMode(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.ambientMode;
  const idle = Number(source.idleMinutes);
  // sceneId is 'builtin', an SDK package id, a "canvas:<id>" reference into
  // hubSettings.ambientScenes (a native canvas scene) or a "theme:<id>" one into
  // customThemes. Anything else resets to the default so a stale reference can't
  // strand the picker.
  const raw = typeof source.sceneId === 'string' ? source.sceneId : '';
  const isScene = (id) => id === 'builtin' || AMBIENT_SCENE_ID_RE.test(id) || (typeof AmbientScene !== 'undefined' ? AmbientScene.isCanvasRef(id) : /^canvas:[a-z0-9][a-z0-9-]{1,40}$/.test(id)) || AMBIENT_THEME_REF_RE.test(id);
  const sceneId = isScene(raw) ? raw : defaults.sceneId;
  // The animated wallpaper and the screensaver, per screen (js/screen-scene-model.js,
  // loaded before this file). Both off by default.
  const saverMinutes = (v) => ([0, 5, 10, 15, 30, 60].includes(Number(v)) ? Number(v) : 0);
  return {
    enabled: source.enabled !== undefined ? !!source.enabled : defaults.enabled,
    idleMinutes: AMBIENT_IDLE_MINUTES.includes(idle) ? idle : defaults.idleMinutes,
    sceneId,
    wallpaper: source.wallpaper === true,
    saverMinutes: saverMinutes(source.saverMinutes),
    screens: ScreenSceneModel.normalizeScreens(source.screens),
    byScreen: ScreenSceneModel.normalizeByScreen(source.byScreen, isScene),
    openOnStartup: source.openOnStartup === true,
  };
}

// Native canvas Ambient scenes — client-owned array (like customThemes),
// deep-normalized through the shared AmbientScene module (which also needs
// DashboardInstances for per-component style/image validation). Both load AFTER
// settings.js, so at the initial parse-time loadHubSettings() they aren't ready
// yet: fall back to the RAW array (same idiom as normalizeDashboardLayout's
// copies) so a scene's styles/images are never stripped on hydrate — the deep
// normalize runs on the next save/sync once the modules are up. The renderer
// (ambient-canvas.js) re-normalizes before building DOM, so unvalidated raw
// never reaches the screen.
function normalizeAmbientScenes(value) {
  if (typeof AmbientScene !== 'undefined' && AmbientScene.normalizeScenes
      && typeof DashboardInstances !== 'undefined') {
    return AmbientScene.normalizeScenes(value);
  }
  return Array.isArray(value) ? value : [];
}

function sanitizeWeatherCity(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>`"'\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normalizeWeatherTile(value) {
  const src = value && typeof value === 'object' ? value : {};
  const def = DEFAULT_HUB_SETTINGS.weather.tile;
  const out = { hero: WEATHER_TILE_HEROES.includes(src.hero) ? src.hero : def.hero, look: WEATHER_TILE_LOOKS.includes(src.look) ? src.look : def.look };
  WEATHER_TILE_SECTIONS.forEach(k => { out[k] = typeof src[k] === 'boolean' ? src[k] : def[k]; });
  const srcFields = src.fields && typeof src.fields === 'object' ? src.fields : {};
  const fields = {};
  WEATHER_FIELD_IDS.forEach(id => { fields[id] = typeof srcFields[id] === 'boolean' ? srcFields[id] : true; });
  out.fields = fields;
  return out;
}
function normalizeWeatherSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = source.mode === 'manual' ? 'manual' : DEFAULT_HUB_SETTINGS.weather.mode;
  const provider = WEATHER_PROVIDER_IDS.includes(source.provider) ? source.provider : DEFAULT_HUB_SETTINGS.weather.provider;
  const refreshMin = WEATHER_REFRESH_CHOICES.includes(Number(source.refreshMin))
    ? Number(source.refreshMin) : DEFAULT_HUB_SETTINGS.weather.refreshMin;
  const forecastDays = WEATHER_FORECAST_DAY_CHOICES.includes(Number(source.forecastDays))
    ? Number(source.forecastDays) : DEFAULT_HUB_SETTINGS.weather.forecastDays;
  return {
    mode,
    city: sanitizeWeatherCity(source.city),
    provider,
    refreshMin,
    forecastDays,
    tile: normalizeWeatherTile(source.tile),
  };
}
