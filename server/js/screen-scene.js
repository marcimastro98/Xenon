'use strict';

// The desktop scene page (scene.html): the Ambient scene drawn as the animated
// wallpaper behind the desktop icons (`wallpaper:<monitor>`) or as the PC's
// screensaver (`saver:<monitor>`). The shell opens one window per screen
// (apps/native/src-tauri/src/layers/scene.rs); which ones exist, and when, the
// dashboard decides (js/screen-scene-model.js). A viewer: it reads the
// settings and never writes them.
//
// The scene is the dashboard's own, picked the same way (js/ambient-resolve.js):
// the lock screen (lockscreen.js), a canvas scene (ambient-canvas.js) or a
// Store scene's sandboxed frame (custom-widget.js). Nothing here takes input:
// the wallpaper sits under the icons, and any input ends the screensaver.

// The settings the scene code reads, as on the dashboard. Never saved.
let hubSettings = {};

// Dashboard functions the lock screen calls that live in files this page does
// not load (media.js, settings.js).
function hasActiveMedia() {
  return !!(mediaData && mediaData.active && (mediaData.title || mediaData.artist || mediaData.app));
}
function normalizeLockWidgets(value) {
  const s = value && typeof value === 'object' ? value : {};
  return { clock: s.clock !== false, weather: s.weather !== false, media: s.media !== false, calendar: s.calendar !== false };
}
function closeSettings() { /* no settings panel here */ }

(function () {
  const KEY = new URLSearchParams(window.location.search).get('key') || '';
  if (!window.ScreenSceneModel || !ScreenSceneModel.isSceneKey(KEY)) return;
  const KIND = KEY.slice(0, KEY.indexOf(':'));
  const IN_SHELL = window.__XENON_LAYER_SHELL__ === true;

  const SETTINGS_RETRY_MS = 5000;
  const SETTINGS_EVENT_DELAY_MS = 400;
  const OS_THEME_POLL_MS = 5 * 60 * 1000;
  // The window appearing under a still mouse is not someone coming back.
  const WAKE_GRACE_MS = 1000;
  const WAKE_MOVE_PX = 24;

  const theme = ViewerTheme.create({
    server: SERVER, fetch: (url) => fetch(url), tokens: ThemeTokens, doc: document, matchMedia: window.matchMedia && window.matchMedia.bind(window),
  });
  window.getEffectiveThemePalette = () => theme.palette();
  let settingsTimer = null;
  let shown = '';     // what is on screen: see sceneSig
  let loaded = false;

  document.documentElement.dataset.scene = KIND;
  if (window.SceneFrameRate) SceneFrameRate.attach(document);

  function signal(name) {
    if (!IN_SHELL || !loaded) return false;
    try { window.location.href = 'xenon-app:' + name; } catch (e) { /* not native */ }
    return true;
  }

  // ── The scene ──────────────────────────────────────────────────
  const ambient = () => (hubSettings && hubSettings.ambientMode) || {};
  function sdkEnabled() {
    const sdk = hubSettings.sdkWidgets || {};
    return !!sdk.enabled && hubSettings.safeMode !== true;
  }
  function suspended(id) {
    const sdk = hubSettings.sdkWidgets || {};
    return Array.isArray(sdk.suspended) && sdk.suspended.includes(id);
  }

  async function pickScene() {
    const cfg = ambient();
    const id = typeof cfg.sceneId === 'string' ? cfg.sceneId : 'builtin';
    let packages = [];
    if (id !== 'builtin' && !id.startsWith('canvas:') && window.CustomWidget) {
      try { packages = (await CustomWidget.getPackages(false)).packages || []; } catch (e) { packages = []; }
    }
    const scene = resolveAmbientScene(cfg, packages, sdkEnabled() && !suspended(id), hubSettings.ambientScenes);
    // Never a permission prompt on a wallpaper or a screensaver: an ungranted
    // Store scene shows the built-in one, as the dashboard's idle start does.
    if (scene.pkg && !CustomWidget.packageGranted(scene.pkg)) return { builtin: true, fallback: 'ungranted' };
    return scene;
  }

  function sceneSig(scene) {
    if (scene.canvas) return 'canvas:' + JSON.stringify(scene.scene);
    if (scene.pkg) return 'pkg:' + scene.pkg.id + '@' + (scene.pkg.version || '') + '/' + scene.pkg.entry;
    return 'builtin';
  }

  function unmount() {
    if (typeof closeWidgetLockScreen === 'function') closeWidgetLockScreen();
    if (window.AmbientCanvas) AmbientCanvas.unmount();
    const host = document.getElementById('ambient-scene-frame-host');
    if (host && host.firstChild) {
      CustomWidget.unregisterAmbientFrame();
      host.replaceChildren();
    }
    const overlay = document.getElementById('ambient-scene-overlay');
    if (overlay) overlay.hidden = true;
  }

  // The same sandbox as on the dashboard (ambient-mode.js mountScene): scripts
  // only, opaque origin. Never allow-same-origin.
  function mountFrame(pkg) {
    const overlay = document.getElementById('ambient-scene-overlay');
    const host = document.getElementById('ambient-scene-frame-host');
    if (!overlay || !host || !window.CustomWidget) return false;
    const frame = document.createElement('iframe');
    frame.className = 'ambient-scene-frame';
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = pkg.name || '';
    frame.src = CustomWidget.assetBase(pkg.id) + pkg.entry;
    CustomWidget.registerAmbientFrame(pkg.id, frame);
    host.replaceChildren(frame);
    // The frame never swallows the input that ends a screensaver.
    overlay.classList.add('dismiss-armed');
    overlay.hidden = false;
    return true;
  }

  function mount(scene) {
    if (scene.canvas && AmbientCanvas.mount(scene.scene, {})) return;
    if (scene.pkg && mountFrame(scene.pkg)) return;
    openWidgetLockScreen();
  }

  async function show() {
    const scene = await pickScene();
    SceneFeed.want(ScreenSceneModel.readingsFor(scene, hubSettings.lockWidgets));
    const sig = sceneSig(scene);
    if (sig === shown) return;
    unmount();
    shown = sig;
    mount(scene);
    document.documentElement.dataset.sceneShown = sig.split(':')[0];
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
    const weatherBefore = JSON.stringify(hubSettings.weather || null);
    hubSettings = next;
    lang = normalizeLangCode(hubSettings.language) || lang;
    // This page holds the languages it was served with (/layer-i18n.js).
    if (lang !== langBefore && !i18n[lang]) { window.location.reload(); return; }
    document.documentElement.lang = lang;
    theme.apply(hubSettings);
    if (lang !== langBefore) translateStatic(document);
    // The lock screen redraws its date, greeting and weather words now, not at
    // its next tick (the clock and lock widget toggles too).
    if (typeof refreshLockScreen === 'function') refreshLockScreen();
    if (window.CustomWidget) {
      CustomWidget.refreshTheme();
      if (lang !== langBefore) CustomWidget.refreshLang();
    }
    show();
    if (lang !== langBefore || weatherBefore !== JSON.stringify(hubSettings.weather || null)) SceneFeed.refresh(['weather']);
  }

  async function refreshSettings() {
    const next = await loadSettings();
    if (!next) { setTimeout(refreshSettings, SETTINGS_RETRY_MS); return; }
    apply(next);
    if (await theme.readOs() && window.CustomWidget) CustomWidget.refreshTheme();
  }

  function onSettingsEvent() {
    if (settingsTimer) return;
    settingsTimer = setTimeout(() => { settingsTimer = null; refreshSettings(); }, SETTINGS_EVENT_DELAY_MS);
  }

  // ── The screensaver ends on any input ─────────────────────────
  function armSaver() {
    const armedAt = Date.now();
    let origin = null;
    let done = false;
    const end = () => {
      if (done || Date.now() - armedAt < WAKE_GRACE_MS) return;
      done = true;
      document.documentElement.dataset.sceneDone = '1';
      // The shell closes every screensaver and gives the focus back.
      signal('saver-done');
    };
    window.addEventListener('pointermove', (e) => {
      if (!origin) { origin = { x: e.screenX, y: e.screenY }; return; }
      if (Math.hypot(e.screenX - origin.x, e.screenY - origin.y) >= WAKE_MOVE_PX) end();
    }, true);
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(type, end, true);
  }

  // ── The wallpaper rests on battery ─────────────────────────────
  // Like every animated wallpaper: on battery the shell hides it, which stops
  // its page. Desktop PCs report "charging", so it never rests there.
  async function watchBattery() {
    if (!navigator.getBattery) return;
    let last = null;
    try {
      const battery = await navigator.getBattery();
      const report = () => {
        const rest = !battery.charging;
        if (rest === last) return;
        if (signal('scene-pause?on=' + (rest ? 1 : 0))) last = rest;
      };
      battery.addEventListener('chargingchange', report);
      XenonNative.afterLoad(report);
    } catch (e) { /* no battery reading: always on */ }
  }

  function connect() {
    const es = new EventSource('/sse');
    // The dashboard's relays to a Store scene's frame (js/widget-feed.js).
    WidgetFeed.listen(es, () => window.CustomWidget);
    SceneFeed.listen(es);
    es.addEventListener('settings', onSettingsEvent);
    // A save made while the stream was down is read on reconnect.
    es.addEventListener('open', onSettingsEvent);
  }

  async function boot() {
    const first = await loadSettings();
    if (!first) { setTimeout(boot, SETTINGS_RETRY_MS); return; }
    translateStatic(document);
    apply(first);
    if (await theme.readOs() && window.CustomWidget) CustomWidget.refreshTheme();
    setInterval(async () => {
      if (await theme.readOs() && window.CustomWidget) CustomWidget.refreshTheme();
    }, OS_THEME_POLL_MS);
    connect();
  }

  // Shell signals wait for the load event (a navigation sent before it cancels it).
  XenonNative.afterLoad(() => { loaded = true; });
  if (KIND === 'saver') armSaver();
  else watchBattery();
  boot();
})();
