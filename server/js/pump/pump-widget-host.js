// One Store widget on a pump's screen (pump-widget.html, served at /pump-widget?id=&shape=),
// framed by the face page's Widget face (face-widget.js). It runs the dashboard's own
// sandbox and bridge (custom-widget.js): the same grants, streams and theme, scripts only,
// opaque origin. A viewer like the desktop scene: it reads the settings and never writes
// them, never asks for a permission (nobody can tap a pump) and runs no background frame
// (data-scene). What it can show is said on <html data-state>: 'on', or why not
// ('off', 'ungranted', 'missing'), and the face shows its clock then. Drawing a line for
// the screen's style, it is told which (placement.line) and may ask the ring of lights to
// move (the pumpRing message, window.pumpRingAsk), handed to the face page around it.
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
  // Where the widget is, for its placement (custom-widget.js): the screen's shape and the look
  // of its line (face-widget.js), checked here as any query is.
  const HEX = /^#[0-9a-f]{6}$/i;
  const colors = String(query.get('colors') || '').split(',').filter((c) => HEX.test(c)).map((c) => c.toLowerCase());
  const hex = (name, fallback) => (HEX.test(query.get(name) || '') ? query.get(name).toLowerCase() : fallback);
  const Faces = window.PumpFaces;
  const lineFace = query.get('line');
  window.pumpPlacement = Object.freeze({
    shape: doc.dataset.shape,
    look: Object.freeze({
      colors: Object.freeze(colors.length === 4 ? colors : ['#6ee787', '#8ab4f8', '#ffd75e', '#b4a0ff']),
      warn: hex('warn', '#ff5a5f'),
      background: hex('background', '#000000'),
      size: query.get('size') === 'big' ? 'big' : 'normal',
      // Only a unit chosen for this line: "as in Settings" leaves init's tempUnit/hwTempUnit.
      ...(['c', 'f'].includes(query.get('units')) ? { units: query.get('units') } : {}),
      // The line's colours left to follow it ('live'): the way they go, from a calm reading to a hot one.
      ...(query.get('live') === '1' && Faces?.LIVE_RAMP ? { live: Object.freeze([...Faces.LIVE_RAMP]) } : {}),
    }),
    // The line it draws when it is the screen's style: its face, the moment showing it, and the
    // readings picked for it (none for music or the clock).
    ...(Faces?.GAUGED.includes(lineFace) ? { line: Object.freeze({
      face: lineFace, moment: Faces.momentOf(query.get('moment')),
      readings: Object.freeze([...new Set(String(query.get('readings') || '').split(','))].filter((r) => Faces.READINGS.includes(r)).slice(0, Faces.MAX_READINGS)),
    }) } : {}),
  });

  // The widget asks the ring: { effect, colors?, level? }. Checked here, then said by the face
  // page (same origin) on its own tick, so a widget can never post faster than once a second.
  window.pumpRingAsk = (d) => {
    const effect = Faces?.WIDGET_RING.includes(d?.effect) ? d.effect : null;
    const list = Array.isArray(d?.colors) ? d.colors.filter((c) => typeof c === 'string' && HEX.test(c)).slice(0, 3).map((c) => c.toLowerCase()) : [];
    const level = typeof d?.level === 'number' && Number.isFinite(d.level) ? Math.min(1, Math.max(0, d.level)) : null;
    if (!effect && !list.length && level == null) return;
    try { window.parent.PumpFace?.widgetRing?.({ effect, colors: list.length ? list : null, level }); } catch { /* not framed by the face page */ }
  };

  // A style that takes the pump's alerts (manifest pumpAlerts): how Xenon writes their words in
  // the band below (face-alerts.js), and the kind it is told, never a word; kind null when it ends.
  let alertsLook = null;
  window.pumpAlertsLook = () => alertsLook;
  window.pumpAlertTell = (a) => {
    const frame = alertsLook ? host.querySelector('iframe') : null;
    if (!frame?.contentWindow) return;
    const kind = Faces.STYLE_ALERTS.includes(a?.kind) ? a.kind : null;
    const seconds = kind && Number.isFinite(a.seconds) ? Math.max(0, Math.round(a.seconds)) : 0;
    // An opaque origin: '*' is the only target it has, as for every bridge message.
    frame.contentWindow.postMessage({ xenonSdk: 1, type: 'pumpAlert', kind, band: kind ? Faces.ALERT_BAND : 0, seconds }, '*');
  };

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
    alertsLook = null;
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
    alertsLook = window.pumpPlacement.line && (pkg.pumpAlerts === 'dots' || pkg.pumpAlerts === 'plain') ? pkg.pumpAlerts : null;
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
    if (!next) { settingsTimer = setTimeout(() => { settingsTimer = 0; refresh(); }, SETTINGS_RETRY_MS); return; }
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
