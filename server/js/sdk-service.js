'use strict';

// "Widgets only" has no dashboard, and the dashboard is where a Store widget's
// background frame runs (custom-widget.js syncServiceFrames): the hidden copy
// that answers its Deck keys, receives its webhooks and publishes its key
// states. Without it a widget's Deck key waited three seconds and failed with
// `no_frame`. This page runs those frames and nothing else; the driver page
// holds it only while a widget has a Deck action the user granted
// (js/driver-sdk-host.js), and drops it, with its memory, when none is left.
//
// Like a layer window it reads the settings and never writes them. Unlike one
// it answers hooks and Deck handlers: it is the only page doing so, because the
// driver exists only while there is no dashboard on this PC.

// The settings custom-widget.js reads, as on the dashboard. Never saved.
// eslint-disable-next-line no-unused-vars
let hubSettings = {};

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SdkService = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const SETTINGS_RETRY_MS = 5000;
  const SETTINGS_EVENT_DELAY_MS = 400;

  // The packages the grants name: a change means one was installed or removed
  // on another surface, so the list is read again.
  function grantedPackages(settings) {
    const g = settings && settings.sdkWidgets && settings.sdkWidgets.grants;
    return g && typeof g === 'object' ? Object.keys(g).sort().join('\n') : '';
  }

  function start() {
    let settingsTimer = null;
    let weatherTimer = null;
    let palette = null;
    const widgets = () => window.CustomWidget;
    window.getEffectiveThemePalette = () => palette;

    async function loadSettings() {
      try {
        const res = await fetch(SERVER + '/settings', { cache: 'no-store' });
        const data = res.ok ? await res.json() : null;
        if (data && data.settings && typeof data.settings === 'object') return data.settings;
      } catch (e) { /* server restarting: retried */ }
      return null;
    }

    async function fetchWeatherFeed() {
      try {
        const res = await fetchWithDeadline(SERVER + '/weather?' + WidgetFeed.weatherQuery(hubSettings, lang), 20000);
        if (!res.ok) return;
        const data = await res.json();
        if (data && widgets()) widgets().onData('weather', data);
      } catch (e) { /* the widget keeps its last reading */ }
    }

    function startWeather() {
      if (weatherTimer) clearTimeout(weatherTimer);
      const next = () => {
        weatherTimer = setTimeout(() => { fetchWeatherFeed(); next(); }, WidgetFeed.weatherDelay(hubSettings, Date.now()));
      };
      fetchWeatherFeed();
      next();
    }

    function apply(next) {
      const langBefore = lang;
      const packagesBefore = grantedPackages(hubSettings);
      const weatherChanged = JSON.stringify(next.weather || null) !== JSON.stringify(hubSettings.weather || null);
      hubSettings = next;
      lang = normalizeLangCode(hubSettings.language) || lang;
      if (lang !== langBefore && !i18n[lang]) { window.location.reload(); return; }
      // The palette a widget reads in its `init` and theme events.
      palette = ThemeTokens.derivePalette(hubSettings, {
        resolve: (mode) => (mode === 'light' || mode === 'dark' ? mode
          : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')),
      });
      const cw = widgets();
      if (cw) {
        if (grantedPackages(next) !== packagesBefore) cw.refreshPackages();
        cw.renderWidgets();   // starts and stops the background frames
        cw.refreshTheme();
        if (lang !== langBefore) cw.refreshLang();
      }
      if (!weatherTimer || weatherChanged || lang !== langBefore) startWeather();
    }

    async function refresh() {
      const next = await loadSettings();
      if (!next) { setTimeout(refresh, SETTINGS_RETRY_MS); return; }
      apply(next);
    }

    function onSettingsEvent() {
      if (settingsTimer) return;
      settingsTimer = setTimeout(() => { settingsTimer = null; refresh(); }, SETTINGS_EVENT_DELAY_MS);
    }

    function relay(method) {
      return (e) => {
        const cw = widgets();
        if (!cw) return;
        try { cw[method](JSON.parse(e.data)); } catch (err) { /* one bad event never stops the stream */ }
      };
    }

    function connect() {
      const es = new EventSource('/sse');
      WidgetFeed.listen(es, widgets);
      es.addEventListener('sdk_hook', relay('onHook'));
      es.addEventListener('sdk_handler', relay('onHandler'));
      es.addEventListener('settings', onSettingsEvent);
      // SSE has no replay: a save made while the stream was down is read on reconnect.
      es.addEventListener('open', onSettingsEvent);
    }

    (async function boot() {
      const first = await loadSettings();
      if (!first) { setTimeout(boot, SETTINGS_RETRY_MS); return; }
      apply(first);
      connect();
    })();
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.documentElement
      && document.documentElement.hasAttribute('data-sdk-service')) {
    start();
  }

  return Object.freeze({ grantedPackages });
});
