// Xenon AI's edge glow on the other screens. While a voice chat is on, the
// shell lights the border of the screens the user chose (Settings → Xenon AI),
// the way the dashboard lights its own in ambient voice mode. The shell draws
// it natively (apps/native/src-tauri/src/layers/glow.rs, one window per screen
// on Windows, macOS and Linux): click-through, gone the moment the chat ends,
// out of screenshots where the OS allows it (not on Linux). The shell offers
// it through `caps().aiGlow` only where it can draw it.
//
// The voice state is read from the body classes ai.js already sets
// (ai-voice-mode, voice-listening/thinking/speaking), so the voice code needs
// no hook. Signals are navigations, like every other shell signal: sent on a
// change, and again every 20 s while lit so the shell's own timeout (60 s)
// only fires when this page is gone.
(function () {
  'use strict';

  const MODES = Object.freeze(['auto', 'main', 'second', 'all', 'off']);
  const STATES = Object.freeze(['listening', 'thinking', 'speaking']);
  const KEEPALIVE_MS = 20 * 1000;
  const SIGNAL_DELAY_MS = 60;

  const caps = () => window.__XENON_NATIVE_CAPS__ || {};
  // Bit on the main screen with no dashboard (screen-bit.js): the alerts
  // window, whose shell gives it `aiGlow` alone (layers/mod.rs ALERTS_CAPS).
  const onScreen = () => window.AiSurface === 'screen';
  const supported = () => (window.__XENON_NATIVE__ === true || onScreen()) && caps().aiGlow === true
    && !(typeof isLayerPage === 'function' && isLayerPage());

  function normalizeMode(v) {
    return MODES.includes(v) ? v : 'auto';
  }

  // Which screens glow. `active` is the screen the dashboard window is on;
  // `selfLit` says the dashboard is drawing its own glow there (ambient voice
  // mode, window visible), so the shell must not light it twice.
  // auto = the screen Bit was called from: the dashboard's, or the main one
  // when where the dashboard sits is not known.
  function screensFor(mode, displays, active, selfLit) {
    const list = (Array.isArray(displays) ? displays : [])
      .map((d) => ({ id: String((d && d.id) || ''), primary: !!(d && d.primary === true) }))
      .filter((d) => d.id);
    let ids = [];
    if (mode === 'all') ids = list.map((d) => d.id);
    else if (mode === 'main') ids = list.filter((d) => d.primary).map((d) => d.id).slice(0, 1);
    else if (mode === 'second') ids = list.filter((d) => !d.primary).map((d) => d.id).slice(0, 1);
    else if (mode === 'auto') {
      const here = list.find((d) => d.id === active) || list.find((d) => d.primary) || list[0];
      ids = here ? [here.id] : [];
    }
    return selfLit ? ids.filter((id) => id !== active) : ids;
  }

  function voiceState(body) {
    const cl = body && body.classList;
    if (!cl || !cl.contains('ai-voice-mode')) return 'off';
    return STATES.find((s) => cl.contains('voice-' + s)) || 'listening';
  }

  // "r, g, b" -> [r, g, b], or null when it is not three channels.
  function parseRgb(raw) {
    const n = String(raw || '').split(',').map((v) => Math.round(Number(v)));
    return n.length === 3 && n.every((v) => Number.isFinite(v) && v >= 0 && v <= 255) ? n : null;
  }

  // The theme accent, as the dashboard's own edge glow (AIPanel.css); the
  // shell turns it lavender while Bit thinks, as that CSS does (glow::colour).
  function glowRgb() {
    return parseRgb(getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb'))
      || [0, 170, 255];
  }

  function specNow() {
    const s = typeof hubSettings === 'object' && hubSettings ? hubSettings : {};
    const mode = normalizeMode(s.aiEdgeGlow);
    const state = mode === 'off' ? 'off' : voiceState(document.body);
    if (state === 'off') return { state };
    const still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    // The alerts window has no display list: it names the setting and the
    // shell picks the screens (glow::pick), the main one for `auto` since Bit
    // stands there. Its own glow is cut away with the window.
    if (onScreen()) return { state, rgb: glowRgb(), still, screens: mode };
    const c = caps();
    const active = String((c.display && c.display.active) || '');
    const selfLit = document.body.classList.contains('ai-voice-ambient') && document.visibilityState === 'visible';
    const monitors = screensFor(mode, c.displays, active, selfLit);
    if (!monitors.length) return { state: 'off' };
    return { state, rgb: glowRgb(), still, monitors };
  }

  let sent = JSON.stringify({ state: 'off' });
  let timer = null;
  let keepalive = null;

  function send(force) {
    timer = null;
    const spec = specNow();
    const json = JSON.stringify(spec);
    if (json === sent && !force) return;
    sent = json;
    if (spec.state === 'off') {
      clearInterval(keepalive);
      keepalive = null;
    } else if (!keepalive) {
      keepalive = setInterval(() => send(true), KEEPALIVE_MS);
    }
    try { window.location.href = 'xenon-app:ai-glow?d=' + encodeURIComponent(json); } catch (e) { /* not native */ }
  }

  // Coalesce a burst of class changes (thinking → speaking in one tick) into
  // one signal.
  function schedule() {
    if (!timer) timer = setTimeout(() => send(false), SIGNAL_DELAY_MS);
  }

  function start() {
    if (!supported() || !document.body) return;
    new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    document.addEventListener('visibilitychange', schedule);
  }

  if (supported()) window.XenonNative.afterLoad(start);

  window.AiEdgeGlow = Object.freeze({
    MODES,
    normalizeMode,
    screensFor,
    voiceState,
    // Settings changed (the screens choice, the accent): re-send if lit.
    refresh: () => { if (supported()) schedule(); },
  });
})();
