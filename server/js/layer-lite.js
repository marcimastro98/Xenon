'use strict';

// The light layer page (layer-lite.html): what a layer window loads while every
// widget on its surface is a Store widget (LayersModel.needsDashboard). The full
// dashboard costs ~130 MB more per window and runs every built-in tile's feed
// for tiles nobody sees; a Store widget needs only its frame, the theme and the
// live data the dashboard relays to widgets. This file supplies those, then
// leaves the placing to layer-host.js, exactly as on the full page.
//
// A viewer, like every layer surface: it reads the settings and never writes
// them, and it runs no background frames (the dashboard owns those).

// The settings this page shows, read from the server. custom-widget.js and
// layer-host.js read this global, as on the dashboard. Never saved.
let hubSettings = {};

// The tiles this page can build, like the dashboard's own atoms (index.html):
// a Store widget's, and each built-in tile whose code the server added
// (layer-page.js), known by its render function.
const LITE_ATOMS = Object.freeze({
  custom: { panel: 'custom-panel', mount: 'custom-widget-mount', ready: () => true },
  weather: { panel: 'weather-tile-panel', mount: 'weather-widget-mount', ready: () => typeof renderWeatherTile === 'function' },
});

// A copy of a tile whose markup the server cut from index.html: a clone of
// that markup as it came, before any code drew into it (LayerTiles COPIES rows
// hold no ids, so a clone never repeats one).
const LITE_TEMPLATES = new Map();
for (const name of LayerTiles.COPIES) {
  const own = Array.from(document.querySelectorAll('[data-dashboard-widget="' + name + '"]'))
    .find((n) => !n.hasAttribute('data-dashboard-instance'));
  if (own) LITE_TEMPLATES.set(name, own.cloneNode(true));
}

function createCopyAtom(widget, copyId) {
  const template = copyId ? LITE_TEMPLATES.get(widget) : null;
  if (template) {
    const tile = template.cloneNode(true);
    tile.dataset.dashboardInstance = copyId;
    tile.dataset.dashboardHidden = 'false';
    return tile;
  }
  const spec = Object.prototype.hasOwnProperty.call(LITE_ATOMS, widget) ? LITE_ATOMS[widget] : null;
  if (!spec || !spec.ready()) return null;
  const tile = document.createElement('section');
  tile.className = 'panel ' + spec.panel + ' dashboard-widget';
  tile.dataset.dashboardWidget = widget;
  tile.dataset.dashboardSize = 'normal';
  if (copyId) tile.dataset.dashboardInstance = copyId;
  tile.dataset.dashboardHidden = 'false';
  const mount = document.createElement('div');
  mount.className = spec.mount;
  tile.appendChild(mount);
  return tile;
}

(function () {
  if (!window.LayerHost || !window.LayerHost.active) return;   // no valid key: nothing to show

  const SETTINGS_RETRY_MS = 5000;
  const OS_THEME_POLL_MS = 5 * 60 * 1000;
  const SETTINGS_EVENT_DELAY_MS = 400;
  let osDark = null;        // the server's reading of the OS scheme, for 'auto'
  let palette = null;
  let weatherTimer = null;
  let settingsTimer = null;

  const widgets = () => window.CustomWidget;

  // ── Theme ──────────────────────────────────────────────────────
  function resolveAppearance(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    if (typeof osDark === 'boolean') return osDark ? 'dark' : 'light';
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // The dashboard's palette, skin and panel material, from the same code
  // (js/theme-tokens.js). The album tint is the one thing left out: it follows
  // the track playing, which only the dashboard watches.
  function applyTheme() {
    const root = document.documentElement;
    const skin = ThemeTokens.applySkin(root, hubSettings);
    palette = ThemeTokens.derivePalette(hubSettings, { resolve: resolveAppearance });
    ThemeTokens.applyPalette(root, palette);
    ThemeTokens.applyMaterial(root, hubSettings, palette, skin);
    ThemeTokens.applyFont(document, hubSettings.uiFont);
  }
  window.getEffectiveThemePalette = () => palette;

  async function readOsTheme() {
    if (hubSettings.appearance !== 'auto' || document.hidden) return;
    try {
      const res = await fetch(SERVER + '/system/theme');
      const data = res.ok ? await res.json() : null;
      if (!data || typeof data.osDark !== 'boolean' || data.osDark === osDark) return;
      osDark = data.osDark;
      applyTheme();
      if (widgets()) widgets().refreshTheme();
    } catch (e) { /* the media query stays the answer */ }
  }

  // ── Settings (read only) ───────────────────────────────────────
  async function loadSettings() {
    try {
      const res = await fetch(SERVER + '/settings', { cache: 'no-store' });
      const data = res.ok ? await res.json() : null;
      if (data && data.settings && typeof data.settings === 'object') return data.settings;
    } catch (e) { /* server restarting: retried below */ }
    return null;
  }

  function apply(next) {
    const langBefore = lang;
    const weatherBefore = JSON.stringify(next.weather || null) !== JSON.stringify(hubSettings.weather || null);
    hubSettings = next;
    lang = normalizeLangCode(hubSettings.language) || lang;
    // This page holds the strings of the languages it was served with
    // (/layer-i18n.js). A language picked since then: reload, the server now
    // sends it (no loop: it serves the saved language every time).
    if (lang !== langBefore && !i18n[lang]) { window.location.reload(); return; }
    document.documentElement.lang = lang;
    applyTheme();
    window.LayerHost.place();
    // Placed built-in tiles follow their settings and the language at once.
    LayerLiteTiles.refresh(hubSettings, lang !== langBefore);
    const cw = widgets();
    if (cw) {
      cw.renderWidgets();
      cw.refreshTheme();
      if (lang !== langBefore) cw.refreshLang();
    }
    // The first settings always start it: they may carry no weather block at all.
    if (!weatherTimer || weatherBefore || lang !== langBefore) startWeather();
  }

  async function refreshSettings() {
    const next = await loadSettings();
    if (!next) { setTimeout(refreshSettings, SETTINGS_RETRY_MS); return; }
    apply(next);
    readOsTheme();
  }

  // Another surface saved: the event carries only the rev, so read the whole
  // blob again. Coalesced, as the dashboard does, so a burst reads once.
  function onSettingsEvent() {
    if (settingsTimer) return;
    settingsTimer = setTimeout(() => { settingsTimer = null; refreshSettings(); }, SETTINGS_EVENT_DELAY_MS);
  }

  // ── Weather (client-polled on every surface, see main.js) ──────
  // With the weather tile's code on the page (system.js), its own fetch runs:
  // it draws the tile, keeps the last reading across a hiccup and relays to
  // widgets. Without it, only the relay.
  async function fetchWeatherLite() {
    if (typeof fetchWeather === 'function') return fetchWeather();
    try {
      const res = await fetchWithDeadline(SERVER + '/weather?' + WidgetFeed.weatherQuery(hubSettings, lang), 20000);
      if (!res.ok) return;
      const data = await res.json();
      // Never a failure null: it would be cached and replayed to later frames.
      if (data && widgets()) widgets().onData('weather', data);
    } catch (e) { /* the widget keeps its last reading */ }
  }

  function startWeather() {
    if (weatherTimer) clearTimeout(weatherTimer);
    const next = () => {
      weatherTimer = setTimeout(() => { fetchWeatherLite(); next(); }, WidgetFeed.weatherDelay(hubSettings, Date.now()));
    };
    fetchWeatherLite();
    next();
  }

  function onStatus(e) {
    try {
      const d = JSON.parse(e.data);
      // Only a full payload says whether a game runs (see main.js); a partial one
      // would read as "game ended" and flip every "show when" slot.
      if (d && (d.gaming != null || d.gameRunning != null)) document.body.classList.toggle('game-running', !!d.gaming);
    } catch (err) { /* keep the last state */ }
  }

  function connect() {
    const es = new EventSource('/sse');
    // The dashboard's relays to widgets (js/widget-feed.js). Hooks and Deck
    // handlers are left to the dashboard: two windows answering would run them twice.
    WidgetFeed.listen(es, widgets);
    LayerLiteTiles.listen(es);
    if (window.TilePlay) window.TilePlay.listen(es);
    window.LayerHost.listen(es);
    es.addEventListener('status', onStatus);
    es.addEventListener('settings', onSettingsEvent);
    // SSE has no replay: a save made while the stream was down is read on reconnect.
    es.addEventListener('open', onSettingsEvent);
  }

  async function boot() {
    const first = await loadSettings();
    if (!first) { setTimeout(boot, SETTINGS_RETRY_MS); return; }
    apply(first);
    readOsTheme();
    setInterval(readOsTheme, OS_THEME_POLL_MS);
    connect();
  }

  boot();
})();
