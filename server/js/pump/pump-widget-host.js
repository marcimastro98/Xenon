// One Store widget on a pump's screen (pump-widget.html, served at /pump-widget?id=&shape=),
// framed by the face page's Widget face (face-widget.js). It runs the dashboard's own
// sandbox and bridge (custom-widget.js): the same grants, streams and theme, scripts only,
// opaque origin. A viewer like the desktop scene: it reads the settings and never writes
// them, never asks for a permission (nobody can tap a pump) and runs no background frame
// (data-scene). What it can show is said on <html data-state>: 'on', or why not
// ('off', 'ungranted', 'missing'), and the face shows its clock then.
//
// window.hubSettings: the settings custom-widget.js reads, as on the dashboard. Never saved.
(() => {
  'use strict';

  const SETTINGS_RETRY_MS = 5000;
  const SETTINGS_EVENT_DELAY_MS = 400;
  // The bridge registers frames by instance; a pump page has one.
  const INSTANCE = 'pump';
  const SHAPES = ['round', 'square', 'wide'];

  const doc = document.documentElement;
  const query = new URLSearchParams(location.search);
  const id = query.get('id') || '';
  const host = document.getElementById('pump-widget-host');
  const widgets = () => window.CustomWidget;
  let palette = null;
  let shown = '';
  let settingsTimer = 0;
  let weatherTimer = 0;

  window.hubSettings = {};
  window.getEffectiveThemePalette = () => palette;
  doc.dataset.shape = SHAPES.includes(query.get('shape')) ? query.get('shape') : 'round';

  function say(state) {
    doc.dataset.state = state;
  }

  async function loadSettings() {
    try {
      const res = await fetch(SERVER + '/settings', { cache: 'no-store' });
      const data = res.ok ? await res.json() : null;
      if (data?.settings && typeof data.settings === 'object') return data.settings;
    } catch { /* the engine is restarting: tried again */ }
    return null;
  }

  // The weather a widget that asks for it gets, polled as on every surface (widget-feed.js).
  async function readWeather() {
    try {
      const res = await fetchWithDeadline(SERVER + '/weather?' + WidgetFeed.weatherQuery(window.hubSettings, lang), 20000);
      const data = res.ok ? await res.json() : null;
      if (data && widgets()) widgets().onData('weather', data);
    } catch { /* the widget keeps its last reading */ }
  }

  function watchWeather(on) {
    clearTimeout(weatherTimer);
    weatherTimer = 0;
    if (!on) return;
    const next = () => { weatherTimer = setTimeout(() => { readWeather(); next(); }, WidgetFeed.weatherDelay(window.hubSettings, Date.now())); };
    readWeather();
    next();
  }

  // The package, if this PC may show it here: installed, Store widgets on, not paused,
  // and approved on the dashboard. Never asked for here.
  async function packageToShow(settings) {
    const sdk = settings.sdkWidgets || {};
    if (!sdk.enabled || settings.safeMode === true || (Array.isArray(sdk.suspended) && sdk.suspended.includes(id))) return { why: 'off' };
    let list = [];
    try { list = (await widgets().getPackages(false)).packages || []; } catch { list = []; }
    const pkg = list.find((p) => p && p.id === id);
    if (!pkg) return { why: 'missing' };
    return widgets().packageGranted(pkg) ? { pkg } : { why: 'ungranted' };
  }

  function unmount() {
    if (!shown) return;
    shown = '';
    widgets().unregisterCanvasFrames();
    host.replaceChildren();
    watchWeather(false);
  }

  // The same sandbox as on the dashboard: scripts only, an opaque origin, never its own.
  function mount(pkg) {
    const sig = pkg.id + '@' + (pkg.version || '') + '/' + pkg.entry;
    if (sig === shown) return;
    unmount();
    const frame = document.createElement('iframe');
    frame.className = 'pump-widget-frame';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = pkg.name || '';
    frame.src = widgets().assetBase(pkg.id) + pkg.entry;
    widgets().registerCanvasFrame(INSTANCE, pkg.id, frame);
    host.replaceChildren(frame);
    shown = sig;
    watchWeather(Array.isArray(pkg.streams) && pkg.streams.includes('weather'));
  }

  async function apply(next) {
    const langBefore = lang;
    window.hubSettings = next;
    lang = normalizeLangCode(next.language) || lang;
    if (lang !== langBefore && !i18n[lang]) { location.reload(); return; }
    palette = ThemeTokens.derivePalette(next, {
      resolve: (mode) => (mode === 'light' || mode === 'dark' ? mode
        : (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')),
    });
    const { pkg, why } = await packageToShow(next);
    if (pkg) mount(pkg); else unmount();
    say(pkg ? 'on' : why);
    widgets().refreshTheme();
    if (lang !== langBefore) widgets().refreshLang();
  }

  async function refresh() {
    const next = await loadSettings();
    if (!next) { settingsTimer = setTimeout(refresh, SETTINGS_RETRY_MS); return; }
    await apply(next);
  }

  function onSettingsEvent() {
    if (settingsTimer) return;
    settingsTimer = setTimeout(() => { settingsTimer = 0; refresh(); }, SETTINGS_EVENT_DELAY_MS);
  }

  function connect() {
    const es = new EventSource('/sse');
    WidgetFeed.listen(es, widgets);
    es.addEventListener('settings', onSettingsEvent);
    // A save made while the stream was down is read on reconnect.
    es.addEventListener('open', onSettingsEvent);
    // A widget installed, updated or removed: its list is read again.
    window.addEventListener('xenon:sdk-packages', onSettingsEvent);
  }

  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id) || !widgets()) { say('missing'); return; }
  refresh().then(connect);
})();
