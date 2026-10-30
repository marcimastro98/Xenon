'use strict';

// The hidden page of "widgets only" (js/usage-mode.js). The user chose no
// dashboard on this PC, so the app's main window loads this instead of it
// (route `/` redirects `?shell=main` here) and the shell keeps the window
// hidden (monitor::set_driver). It does only what the dashboard did for the
// shell and nobody else can: keep the widget windows in sync (layers-shell.js,
// whose signals only the main window may send), open the search on its
// shortcut, follow a newer server or a change of mode, keep the lights on
// the album cover's colours, run the Store widgets' Deck actions
// (js/driver-sdk-host.js) and Performance Mode (js/driver-perf.js).
//
// `hubSettings` is a script-level binding on purpose: layers-shell.js reads it
// the same way it reads the dashboard's (settings.js).
// eslint-disable-next-line no-unused-vars
let hubSettings = {};

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ShellDriver = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const SETTINGS_RETRY_MS = 3000;
  const SETTINGS_EVENT_DELAY_MS = 250;
  // The app's window without `full=1`: the server sends it back here while
  // the mode is still "widgets only", to the dashboard otherwise.
  const MAIN_URL = '/?shell=main';

  // Numeric dotted versions; only a strictly newer one reloads (a stale second
  // server answering with an older one must not make the page flip forever).
  function isNewer(next, cur) {
    const a = String(next || '').split('.').map((n) => parseInt(n, 10) || 0);
    const b = String(cur || '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return false;
  }

  // What a fresh copy of the settings asks of this page.
  function stepFor(settings) {
    const U = (typeof window !== 'undefined' && window.UsageMode) || require('./usage-mode.js');
    return U.widgetsOnly(settings && settings.usageMode) ? 'sync' : 'leave';
  }

  // Where the gallery asked for by Bit or a Deck key opens: "widgets only" has
  // no dashboard to show it in, so this page becomes the dashboard with it open
  // (js/dashboard-open.js), as the tray's "Open Xenon" does. '' = nowhere.
  function galleryUrl(d) {
    const D = (typeof window !== 'undefined' && window.DashboardOpen) || require('./dashboard-open.js');
    const extra = D.query({ ...(d && typeof d === 'object' ? d : {}), open: 'gallery' });
    return extra ? MAIN_URL + '&full=1' + extra : '';
  }

  // A Deck key's shortcut offers a step only a dashboard can do
  // (deck-shortcut-runner.js). The mixer and the written chat are dashboard
  // screens, so this page takes them and becomes the dashboard with one open;
  // the voice session stays with the alerts window (screen-bit.js), and sounds
  // the PC plays itself. null = not ours to take.
  function deckStepPlan(action) {
    if (!action || typeof action !== 'object') return null;
    if (action.type === 'appMixer') return { open: 'mixer', ask: '' };
    if (action.type !== 'ai') return null;
    const mode = action.mode || 'prompt';
    if (mode === 'open') return { open: 'chat', ask: '' };
    if (mode === 'prompt') return { open: 'chat', ask: String(action.prompt || '').trim() };
    return null;
  }

  function start() {
    let version = '';
    let reloading = false;
    let settingsTimer = null;

    const go = (url) => {
      if (reloading) return;
      reloading = true;
      window.location.replace(url);
    };

    const sdkHost = window.DriverSdkHost ? window.DriverSdkHost.create(document) : null;
    const perf = window.DriverPerf
      ? window.DriverPerf.create({
        win: window,
        doc: document,
        read: () => hubSettings,
        post: (path, body) => fetch(SERVER + path, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }).catch(() => { /* the server is restarting: the next change sends it again */ }),
      })
      : null;

    async function loadSettings() {
      try {
        const res = await fetch(SERVER + '/settings', { cache: 'no-store' });
        const data = res.ok ? await res.json() : null;
        if (data && data.settings && typeof data.settings === 'object') return data.settings;
      } catch (e) { /* server restarting: the stream's reconnect asks again */ }
      return null;
    }

    async function refresh() {
      const next = await loadSettings();
      if (!next) return false;
      hubSettings = perf ? perf.merge(next) : next;
      if (stepFor(next) === 'leave') { go(MAIN_URL); return true; }
      if (window.LayersShell) window.LayersShell.sync();
      if (sdkHost) sdkHost.sync(next);
      if (perf) perf.sync(hubSettings);
      return true;
    }

    function onSettingsEvent() {
      if (settingsTimer) return;
      settingsTimer = setTimeout(() => { settingsTimer = null; refresh(); }, SETTINGS_EVENT_DELAY_MS);
    }

    function onStatus(e) {
      try {
        const d = JSON.parse(e.data);
        if (window.LayersShell && typeof window.LayersShell.onStatus === 'function') window.LayersShell.onStatus(d);
        if (!d || typeof d.version !== 'string' || !d.version) return;
        if (!version) { version = d.version; return; }
        if (isNewer(d.version, version)) go(MAIN_URL);
      } catch (err) { /* keep the last version */ }
    }

    // The search shortcut: the main window is the only one the shell takes
    // `spotlight-open` from (lib.rs). Same claim as the dashboard (main.js).
    function onSpotlightHotkey() {
      try {
        fetch(SERVER + '/spotlight/claimed', { method: 'POST', keepalive: true }).catch(() => {});
        window.location.href = 'xenon-app:spotlight-open';
      } catch (err) { /* the server's own fallback window opens instead */ }
    }

    // Drawing on the screen opened or closed (macOS, Linux): the shell's sheet.
    function onScreenDraw(e) {
      try {
        if (window.LayersShell && typeof window.LayersShell.onDraw === 'function') window.LayersShell.onDraw(JSON.parse(e.data));
      } catch (err) { /* a broken event leaves the sheet as it was */ }
    }

    // The Xenon menu opened or closed over the screen: the shell's /menu window.
    function onScreenMenu(e) {
      try {
        if (window.LayersShell && typeof window.LayersShell.onMenu === 'function') window.LayersShell.onMenu(JSON.parse(e.data));
      } catch (err) { /* a broken event leaves the menu as it was */ }
    }

    // Bit's vitals popup on this PC (macOS, Linux): the on-screen alerts window.
    function onVitalsNag(e) {
      try {
        if (window.LayersShell && typeof window.LayersShell.onVitalsPopup === 'function') window.LayersShell.onVitalsPopup(JSON.parse(e.data));
      } catch (err) { /* a broken event shows no popup */ }
    }

    function onGalleryOpen(e) {
      try {
        const url = galleryUrl(JSON.parse(e.data));
        if (url) go(url);
      } catch (err) { /* a bad payload opens nothing */ }
    }

    function onDeckShortcut(e) {
      let data;
      try { data = JSON.parse(e.data); } catch (err) { return; }
      const plan = deckStepPlan(data && data.action);
      if (!plan || reloading) return;
      fetch(SERVER + '/deck/shortcut-claim', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: data.nonce }),
      }).then((r) => (r.ok ? r.json() : null)).then((r) => {
        if (!r || !r.ok) return;
        const D = window.DashboardOpen;
        if (plan.ask) D.storeAsk(plan.ask, window.sessionStorage);
        go(MAIN_URL + '&full=1' + D.query({ open: plan.open }));
      }).catch(() => { /* the server tells the key it failed */ });
    }

    // The lights follow the album cover (js/driver-album-lights.js).
    const albumLights = window.DriverAlbumLights && typeof window.extractAlbumAccent === 'function'
      ? window.DriverAlbumLights.create({
        extract: window.extractAlbumAccent,
        post: (body) => fetch(SERVER + '/api/lighting/album', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }).catch(() => { /* lighting is best-effort */ }),
      })
      : null;

    function onMedia(e) {
      let d;
      try { d = JSON.parse(e.data); } catch (err) { return; }
      albumLights.onMedia(d);
    }

    function connect() {
      const es = new EventSource(SERVER + '/sse');
      es.addEventListener('settings', onSettingsEvent);
      // SSE has no replay: a save made while the stream was down is read on reconnect.
      es.addEventListener('open', onSettingsEvent);
      es.addEventListener('status', onStatus);
      es.addEventListener('spotlight_hotkey', onSpotlightHotkey);
      es.addEventListener('gallery_open', onGalleryOpen);
      es.addEventListener('screen_draw', onScreenDraw);
      es.addEventListener('screen_menu', onScreenMenu);
      es.addEventListener('vitals_nag', onVitalsNag);
      es.addEventListener('deck_shortcut', onDeckShortcut);
      if (albumLights) es.addEventListener('media', onMedia);
      if (perf) perf.listen(es);
    }

    async function boot() {
      if (!(await refresh())) { setTimeout(boot, SETTINGS_RETRY_MS); return; }
      if (!reloading) connect();
    }

    boot();
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.documentElement
      && document.documentElement.hasAttribute('data-shell-driver')) {
    start();
  }

  return Object.freeze({ MAIN_URL, isNewer, stepFor, galleryUrl, deckStepPlan });
});
