'use strict';
// Ambient / Screensaver mode — the evolution of the Focus Lock Screen.
//
// One overlay, two kinds of scene:
//   'builtin'      → the native lock-screen renderer (lockscreen.js), exactly
//                    the old Focus look, honoring the lockWidgets toggles.
//   <package id>   → an installed SDK widget package whose manifest declares
//                    surface: 'ambient' — rendered fullscreen in the SAME
//                    sandboxed iframe + CSP kill-switch as tile widgets, joined
//                    to the same postMessage bridge (custom-widget.js), so it
//                    receives only the data streams the user granted.
//
// Activation: the topbar button (replaces the old Focus button), the AI
// actions start/stop_ambient_mode, and — new — an optional idle auto-start
// after hubSettings.ambientMode.idleMinutes of no interaction (a real
// screensaver). The idle timer here is deliberately SEPARATE from
// ambient-idle.js (whose fixed 60s animation-pause is load-bearing for GPU
// cost) — same activity events, independent lifecycle.
//
// Pure helpers (resolveScene, idleStartSuppressed, normalizeIdleMinutes) are
// exported for node:test (server/test/ambient-logic.test.mjs), same pattern as
// preset-share.js.

// Pick the scene to show for the current settings + installed packages + saved
// canvas scenes. Returns one of:
//   { builtin:true, fallback? }         — the native lockscreen scene
//   { builtin:false, pkg }              — an installed SDK surface:'ambient' pkg
//   { builtin:false, canvas:true, scene } — a native canvas scene (JSON layout)
// Falls back to builtin when the configured scene is missing, isn't an ambient
// scene, or the SDK subsystem is off — the user must never hit a dead button
// because a package/scene was deleted.
function resolveAmbientScene(cfg, packages, sdkEnabled, scenes) {
  const sceneId = (cfg && typeof cfg.sceneId === 'string') ? cfg.sceneId : 'builtin';
  if (sceneId === 'builtin') return { builtin: true };
  // Native canvas scene ("canvas:<id>") — first-party, no SDK subsystem needed.
  if (typeof sceneId === 'string' && sceneId.indexOf('canvas:') === 0) {
    const id = sceneId.slice('canvas:'.length);
    const scene = (Array.isArray(scenes) ? scenes : []).find(s => s && s.id === id);
    if (!scene) return { builtin: true, fallback: 'missing' };
    return { builtin: false, canvas: true, scene };
  }
  if (!sdkEnabled) return { builtin: true, fallback: 'sdk_off' };
  const pkg = (Array.isArray(packages) ? packages : [])
    .find(p => p && p.id === sceneId && p.surface === 'ambient');
  if (!pkg) return { builtin: true, fallback: 'missing' };
  return { builtin: false, pkg };
}

// Should the IDLE auto-start be suppressed right now? Pure — the caller
// gathers the flags from the DOM so this stays unit-testable.
// state: { enabled, idleMinutes, open, hidden, fullscreen, busyBodyClass, overlayOpen }
function ambientIdleSuppressed(state) {
  const s = state || {};
  if (!s.enabled) return true;
  if (!(Number(s.idleMinutes) > 0)) return true;
  if (s.open) return true;            // already showing
  if (s.hidden) return true;          // nobody is looking at this tab
  if (s.fullscreen) return true;      // fullscreen video/game in the browser
  if (s.busyBodyClass) return true;   // game/perf mode, editing, AI session…
  if (s.overlayOpen) return true;     // settings, dialogs, pickers…
  return false;
}

if (typeof window !== 'undefined') (function () {
  const REARM_THROTTLE_MS = 1000;
  const IDLE_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
  // Body classes that mean "the user is in the middle of something" — never
  // steal the screen from a game, an edit session or a live AI conversation.
  const BUSY_BODY_CLASSES = ['game-mode', 'perf-mode', 'layout-editing', 'ai-open', 'ai-active', 'ai-voice-mode', 'ai-listening', 'ai-picker-open'];
  // Visible overlays/dialogs that suppress the idle auto-start.
  const OVERLAY_IDS = ['ai-overlay', 'settings-overlay', 'weather-overlay', 'app-switcher', 'tab-switcher', 'day-modal'];
  const OVERLAY_SELECTOR = '.preset-modal-overlay, .cw-perm-backdrop, .deck-mix-backdrop, .wc-overlay, dialog[open]';

  let idleTimer = null;
  let lastRearm = 0;
  let sysIdleSec = null;   // whole-PC idle seconds (GetLastInputInfo) via status SSE; null = signal unavailable
  let sysIdleDropped = false; // last sample JUMPED BACKWARDS → real input happened between samples
  // Last input seen by THIS window — clamps stale probe samples. Starts at 0,
  // not Date.now(): a page load is not user input, and a kiosk reload while the
  // user is away (version-fence reload after a self-update, crash restart)
  // must not delay the screensaver's return by a full idle period.
  let lastLocalInputAt = 0;
  let idleStarted = false; // the CURRENT open was the idle auto-start (screensaver), not a manual open
  const ACTIVE_IDLE_SEC = 30; // whole-PC idle below this = the user is active on SOME screen → dismiss
  const warnedFallback = new Set();   // fallback reasons already explained this session

  function cfg() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.ambientMode : null;
    return (hs && typeof hs === 'object') ? hs : { enabled: true, idleMinutes: 0, sceneId: 'builtin' };
  }
  function sdkEnabled() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.sdkWidgets : null;
    // Safe mode pauses SDK ambient scenes with the rest of the third-party
    // widgets (the builtin scene keeps working — it's first-party).
    if (typeof hubSettings === 'object' && hubSettings && hubSettings.safeMode === true) return false;
    return !!(hs && hs.enabled);
  }
  // A per-package pause (Store → Installed → Sospendi) covers the package's
  // ambient scene too. Only consulted for the CONFIGURED scene id, so it slots
  // into the same sdkEnabled gate resolveAmbientScene already falls back on.
  function sceneSuspended(id) {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.sdkWidgets : null;
    const s = (hs && Array.isArray(hs.suspended)) ? hs.suspended : [];
    return typeof id === 'string' && s.includes(id);
  }
  function savedScenes() {
    const arr = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.ambientScenes : null;
    return Array.isArray(arr) ? arr : [];
  }
  function tt(key, fb) {
    const v = (typeof window.t === 'function') ? window.t(key) : key;
    return (v === key && fb != null) ? fb : v;
  }

  // ── Scene overlay (SDK package scenes) ───────────────────────────
  function sceneOverlay() { return document.getElementById('ambient-scene-overlay'); }

  function mountScene(pkg) {
    const overlay = sceneOverlay();
    const host = document.getElementById('ambient-scene-frame-host');
    if (!overlay || !host || !window.CustomWidget) return false;
    const frame = document.createElement('iframe');
    frame.className = 'ambient-scene-frame';
    // Same sandbox contract as tile widgets — scripts only, opaque origin; the
    // served CSP (connect-src 'none' + re-sandbox) is the network kill-switch.
    // Never add allow-same-origin here.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = pkg.name;
    frame.src = '/sdk/widget/' + encodeURIComponent(pkg.id) + '/' + pkg.entry;
    CustomWidget.registerAmbientFrame(pkg.id, frame);
    host.replaceChildren(frame);
    overlay.hidden = false;
    document.body.classList.add('ambient-scene-open');
    // Entering game mode must close the scene (a screensaver never sits over a
    // game). Body-class watch covers every setter — armed only while a scene is
    // actually open, torn down with it ("stop what you start").
    gameWatch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return true;
  }

  function unmountScene() {
    gameWatch.disconnect();
    const overlay = sceneOverlay();
    if (window.CustomWidget) CustomWidget.unregisterAmbientFrame();
    const host = document.getElementById('ambient-scene-frame-host');
    if (host) host.replaceChildren();
    if (overlay) overlay.hidden = true;
    document.body.classList.remove('ambient-scene-open');
  }

  function sceneOpen() {
    const overlay = sceneOverlay();
    return !!(overlay && !overlay.hidden);
  }
  function builtinOpen() {
    const overlay = document.getElementById('lockscreen-overlay');
    return !!(overlay && !overlay.hidden);
  }
  // Native canvas scene overlay is owned by js/ambient-canvas.js (Phase 2). Until
  // that module is present, these degrade to "not open"/"can't mount", so a
  // canvas scene id transparently falls back to the builtin scene.
  function canvasOpen() {
    return !!(window.AmbientCanvas && AmbientCanvas.isOpen && AmbientCanvas.isOpen());
  }
  function mountCanvas(scene) {
    if (!(window.AmbientCanvas && AmbientCanvas.mount)) return false;
    const ok = AmbientCanvas.mount(scene, { onClose: close });
    // Same game-mode guard as an SDK scene: a screensaver never sits over a game.
    if (ok) gameWatch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return ok;
  }
  function unmountCanvas() {
    gameWatch.disconnect();
    if (window.AmbientCanvas && AmbientCanvas.unmount) AmbientCanvas.unmount();
  }
  function isOpen() { return sceneOpen() || builtinOpen() || canvasOpen(); }

  function openBuiltin(fallback) {
    if (typeof openWidgetLockScreen === 'function') openWidgetLockScreen();
    // Tell the user (once per reason per session) why their chosen scene
    // didn't come up — a silent switcheroo reads like a broken setting.
    if (!fallback || warnedFallback.has(fallback) || !window.XenonToast) return;
    warnedFallback.add(fallback);
    const title = tt('ambient_scene_missing', 'Ambient scene not available');
    const message = fallback === 'sdk_off'
      ? tt('preset_bundle_widgets_note', 'Enable the Community widgets switch and approve each one\'s permissions to use them.')
      : fallback === 'ungranted'
        ? tt('cw_review_hint', 'It was updated (or predates a Xenon feature) and now requests capabilities you haven\'t approved.')
        : tt('ambient_scene_missing_hint', 'The selected scene was removed — showing the built-in one.');
    window.XenonToast.show({ type: 'info', title, message });
  }

  // manual = a user tap (may show the permission dialog); idle auto-start
  // never prompts — an ungranted scene silently falls back to the builtin.
  async function open(opts) {
    if (isOpen()) return;
    const manual = !opts || opts.manual !== false;
    // Reset the idle-started flag on every fresh open; autoStart() re-sets it to
    // true after a successful auto-open. This is the single choke point, so a
    // stale "true" left by a previous episode (builtin closed via its own X, or a
    // scene unmounted by game mode) can never make a MANUAL open dismiss itself
    // when the PC is used.
    idleStarted = false;
    const c = cfg();
    // The master toggle governs the mode's own surfaces (idle auto-start,
    // topbar button visibility) — an EXPLICIT request (AI command, external
    // caller) still opens, matching the old always-works lock screen.
    if (!manual && !c.enabled) return;
    // A cold package cache must not read as "scene removed" — fetch on both
    // manual and idle opens (a dashboard with no custom tiles never fetches
    // otherwise, and the idle path would falsely fall back every session).
    let packages = window.CustomWidget ? CustomWidget.cachedPackages() : [];
    let listUnavailable = false;
    if (window.CustomWidget && c.sceneId !== 'builtin' && !packages.length) {
      try { packages = (await CustomWidget.getPackages(false)).packages || []; } catch { packages = []; }
      if (isOpen()) return;   // something else opened while we awaited
      // The fetch took time — if the user came back meanwhile (a fresh whole-PC
      // sample below the dismiss threshold, or input on this very window), an
      // IDLE open must abort instead of flashing a screensaver at a present user.
      if (!manual && ((sysIdleSec != null && sysIdleSec < ACTIVE_IDLE_SEC) || Date.now() - lastLocalInputAt < 5000)) return;
      listUnavailable = !packages.length;   // fetch failed/empty ≠ scene removed
    }
    // Flag a successful AUTO open as the screensaver and arm dismiss-on-input,
    // atomically inside the very call that opened — so a manual open that
    // interleaved during the package await above (which already made this call
    // return at the isOpen() guard) can never be mis-flagged as an idle scene.
    const markAuto = () => { if (!manual && isOpen()) { idleStarted = true; armDismiss(); } };
    const scene = resolveAmbientScene(c, packages, sdkEnabled() && !sceneSuspended(c.sceneId), savedScenes());
    if (scene.builtin) {
      // Don't claim "removed" when we simply couldn't list packages right now.
      openBuiltin(scene.fallback === 'missing' && listUnavailable ? '' : scene.fallback);
      markAuto();
      return;
    }
    // Native canvas scene — first-party, host-rendered. Falls back to the builtin
    // scene when the renderer module isn't present (never a dead button).
    if (scene.canvas) {
      if (!mountCanvas(scene.scene)) openBuiltin();
      markAuto();
      return;
    }
    if (!CustomWidget.packageGranted(scene.pkg)) {
      if (manual) CustomWidget.requestGrant(scene.pkg, () => { if (!isOpen()) mountScene(scene.pkg); });
      else { openBuiltin('ungranted'); markAuto(); }
      return;
    }
    if (!mountScene(scene.pkg)) openBuiltin();
    markAuto();
  }

  function close() {
    disarmDismiss();
    idleStarted = false;
    if (sceneOpen()) unmountScene();
    if (canvasOpen()) unmountCanvas();
    if (builtinOpen() && typeof closeWidgetLockScreen === 'function') closeWidgetLockScreen();
    armIdleTimer();
  }

  // ── Dismiss-on-input (real screensaver behaviour) ─────────────────────
  // A scene the user opened DELIBERATELY (topbar button / AI command) stays up
  // until they close it — its widgets are meant to be tapped. But a scene the
  // IDLE auto-start put up is a screensaver: the first genuine interaction on
  // their return must make it disappear, not actuate a widget beneath it. We arm
  // these listeners only after an idle open, on the next frame so the very
  // timer/state that opened the scene can't instantly close it.
  // While armed, an SDK scene's iframe gets pointer-events:none (the
  // .dismiss-armed shield in LockScreen.css) — a sandboxed iframe would
  // otherwise swallow the wake gesture over itself and the screensaver would
  // never react to mouse/touch. A MANUALLY opened scene is never armed, so it
  // stays fully interactive. Keyboard wake is best-effort for SDK scenes (a
  // scene that programmatically re-grabs focus keeps its own key events);
  // whole-PC idle dismiss and the exit ✕ always cover it.
  let dismissArmed = false;
  function setSceneShield(on) {
    // Shield whichever scene surface is open — the SDK-scene overlay OR the
    // native canvas overlay (its embedded SDK iframes would otherwise swallow the
    // wake gesture; the .dismiss-armed CSS sets pointer-events:none on them).
    const overlays = [sceneOverlay(), document.getElementById('ambient-canvas-overlay')];
    for (const overlay of overlays) {
      if (!overlay) continue;
      overlay.classList.toggle('dismiss-armed', on);
      if (on) {
        // If a frame grabbed focus on load, key events would go to its document
        // instead of this window — push focus back so keydown wakes us too.
        const frame = overlay.querySelector('.ambient-scene-frame, .ac-sdk-frame');
        if (frame && document.activeElement === frame) { try { frame.blur(); } catch { /* detached */ } }
      }
    }
  }
  function dismissOnInput(e) {
    lastLocalInputAt = Date.now();   // stopPropagation below skips onActivity
    disarmDismiss();
    // Swallow this first "wake" gesture so it only dismisses the screensaver.
    try { e.preventDefault(); } catch { /* passive/uncancelable */ }
    e.stopPropagation();
    close();
  }
  function armDismiss() {
    if (dismissArmed || !isOpen()) return;
    dismissArmed = true;
    setSceneShield(true);
    requestAnimationFrame(() => {
      if (!dismissArmed) return;
      for (const ev of IDLE_EVENTS) window.addEventListener(ev, dismissOnInput, { capture: true });
    });
  }
  function disarmDismiss() {
    if (!dismissArmed) return;
    dismissArmed = false;
    setSceneShield(false);
    for (const ev of IDLE_EVENTS) window.removeEventListener(ev, dismissOnInput, { capture: true });
  }

  function toggle() {
    if (isOpen()) close();
    else open({ manual: true });
  }

  // ── Idle auto-start ───────────────────────────────────────────────
  // An overlay suppresses the idle auto-start only while it is actually
  // rendered. Most overlays toggle the `hidden` attribute, but some (e.g.
  // #day-modal) hide via a display:none class and live in the DOM permanently —
  // reading `.hidden` on those is ALWAYS false and would suppress the
  // screensaver forever. checkVisibility() reflects real render state for both.
  const overlayVisible = (el) => !!el && el.checkVisibility();

  function collectSuppressionState() {
    const c = cfg();
    return {
      enabled: c.enabled !== false,
      idleMinutes: c.idleMinutes,
      open: isOpen(),
      hidden: document.hidden,
      fullscreen: !!document.fullscreenElement,
      busyBodyClass: BUSY_BODY_CLASSES.some(cl => document.body.classList.contains(cl)),
      overlayOpen: OVERLAY_IDS.some(id => overlayVisible(document.getElementById(id)))
        || Array.prototype.some.call(document.querySelectorAll(OVERLAY_SELECTOR), overlayVisible),
    };
  }

  // Fire the screensaver auto-start once, unless something is suppressing it right
  // now. Marks the open as idle-started (so both dismiss-on-input and whole-PC
  // idle dismiss apply) — a manual open never routes through here. Returns false
  // when it couldn't start (already open, or suppressed) so the caller can retry.
  function autoStart() {
    if (isOpen() || ambientIdleSuppressed(collectSuppressionState())) return false;
    open({ manual: false });   // open() self-flags idleStarted + arms dismiss on a real open
    return true;
  }

  function armIdleTimer() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    // cfg() comes out of normalizeAmbientMode (settings.js) — idleMinutes is
    // already clamped to the allowed set, so a plain numeric read suffices.
    const minutes = Number(cfg().idleMinutes) || 0;
    if (!cfg().enabled || minutes <= 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      // When the whole-PC idle signal is available (status SSE), evaluateSystemIdle()
      // is the SOLE authority for auto-start — this dashboard-window timer must not
      // open, because it only sees interaction with the dashboard itself and would
      // fire while the user is busy on another screen. It stays a pure fallback for
      // machines where system-idle detection is unavailable (idleSec never arrives).
      // Re-arm instead of a bare return: if the signal later DIES (probe/worker
      // breaks → onStatus sets null), a consumed timer would otherwise leave a
      // kiosk nobody touches with no authority at all — screensaver dead forever.
      if (sysIdleSec != null) { armIdleTimer(); return; }
      if (!autoStart()) armIdleTimer();   // suppressed → try again after another full period
    }, minutes * 60 * 1000);
  }

  function onActivity() {
    const now = Date.now();
    lastLocalInputAt = now;   // before the throttle — the clamp needs every event
    if (now - lastRearm < REARM_THROTTLE_MS) return;
    lastRearm = now;
    armIdleTimer();
  }
  for (const ev of IDLE_EVENTS) window.addEventListener(ev, onActivity, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } }
    else { lastRearm = 0; onActivity(); }
  });

  // ── Whole-PC idle (the smart part) ────────────────────────────────────
  // The dashboard usually lives on a second screen the user rarely touches, so a
  // window-local idle timer would start the screensaver while they're busy on
  // another monitor. idleSec (GetLastInputInfo, computed server-side and carried
  // on the status SSE) measures input across the WHOLE system — every screen and
  // app — so the screensaver starts only when the PC is genuinely unattended, and
  // drops the moment the PC is used anywhere. Dashboard-local dismiss (armDismiss)
  // still gives an instant response when the user touches the dashboard itself.
  function evaluateSystemIdle() {
    if (sysIdleSec == null) return;   // no whole-PC signal → the local timer is the fallback
    const c = cfg();
    const minutes = Number(c.idleMinutes) || 0;
    // A screensaver WE auto-started + the PC is active again on ANY screen → dismiss.
    // Two triggers: the absolute threshold, and ANY backwards jump in idleSec —
    // the counter only ever resets on real input, so a drop proves the user is
    // back even when probe hiccups made the sample skip the sub-30s window.
    if (idleStarted && isOpen() && (sysIdleSec < ACTIVE_IDLE_SEC || sysIdleDropped)) { close(); return; }
    // Auto-start only once the whole PC has been idle for the chosen time.
    // sysIdleSec is a SAMPLE taken on a cadence: right after a local dismiss
    // (touching the dashboard) it can still read minutes-stale "away" — and the
    // next status event (foreground change, heartbeat) would instantly re-open
    // the scene the user just dismissed. Clamp with the freshest signal we own:
    // input seen by this window. On a dashboard the user never touches,
    // lastLocalInputAt is ancient, so sysIdleSec alone decides — unchanged.
    const localIdleSec = (Date.now() - lastLocalInputAt) / 1000;
    if (c.enabled !== false && minutes > 0 && Math.min(sysIdleSec, localIdleSec) >= minutes * 60) autoStart();
  }

  // Fed by the status SSE (main.js). idleSec is null when the probe is off or
  // unsupported → we fall back to the dashboard-local timer, unchanged.
  function onStatus(data) {
    if (!data || typeof data !== 'object') return;
    const raw = Number(data.idleSec);
    const prev = sysIdleSec;
    sysIdleSec = (Number.isFinite(raw) && raw >= 0) ? raw : null;
    // 2s tolerance absorbs rounding jitter between samples of a still-growing counter.
    sysIdleDropped = typeof prev === 'number' && sysIdleSec != null && sysIdleSec + 2 < prev;
    evaluateSystemIdle();
  }

  // Observer armed by mountScene()/disarmed by unmountScene() — it only exists
  // while a scene overlay is on screen (see mountScene for why).
  const gameWatch = new MutationObserver(() => {
    if (!document.body.classList.contains('game-mode')) return;
    if (sceneOpen()) {
      disarmDismiss();
      idleStarted = false;
      unmountScene();
      // The idle timer fired to open this scene and is now null — re-arm it or
      // the screensaver never auto-starts again after the game ends unattended.
      // (While the game runs, each firing is suppressed and simply re-arms.)
      armIdleTimer();
    } else if (canvasOpen()) {
      disarmDismiss();
      idleStarted = false;
      unmountCanvas();
      armIdleTimer();
    }
  });

  // Called from settings.js after EVERY applyHubSettings — which runs on any
  // settings save from any surface. Only react when ambientMode itself changed:
  // blindly re-arming here would restart the idle countdown on every incidental
  // save (vitals state, theme tweaks, SSE re-hydrates), so the screensaver
  // could never fire on a busy multi-surface setup.
  let lastCfgKey = '';
  let lastSuspendedKey = '';
  function onSettingsChanged() {
    const c = cfg();
    const sdkOn = sdkEnabled() && !sceneSuspended(c.sceneId);
    // The suspended list itself is part of the key: a canvas scene's sceneId is
    // 'canvas:<id>' (never a package id), so a per-package pause only becomes
    // visible through the list — without it no refresh fires and a suspended
    // package's frame embedded in an open canvas scene kept running.
    const hsSdk = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.sdkWidgets : null;
    const suspendedKey = (hsSdk && Array.isArray(hsSdk.suspended)) ? hsSdk.suspended.join(',') : '';
    const key = (c.enabled !== false) + '|' + c.idleMinutes + '|' + c.sceneId + '|' + sdkOn + '|' + suspendedKey;
    if (key === lastCfgKey) return;
    lastCfgKey = key;
    // Button visibility must follow the setting on EVERY apply path (boot,
    // local save, cross-surface sync) — not only when the Settings panel is
    // open (index.html ships it visible).
    const topBtn = document.getElementById('ambient-topbtn');
    if (topBtn) topBtn.hidden = c.enabled === false;
    if (!c.enabled && isOpen()) { close(); return; }
    // The SDK master switch is the kill-switch for third-party code — an open
    // fullscreen scene must die with it, exactly like the tile frames do. Tear it
    // down through the same path as game mode: drop the dismiss listeners (or an
    // auto-started scene would leak them and swallow the user's next input) and
    // clear the idle-started flag.
    if (!sdkOn && sceneOpen()) { disarmDismiss(); idleStarted = false; unmountScene(); }
    // A native canvas scene is first-party, so it stays open when SDK widgets are
    // turned off — but any SDK components it embeds must die with the master
    // switch OR a per-package pause. Rebuild in place: ambient-canvas re-runs its
    // own safe-mode/suspend gates and the frames come back as quiet placeholders.
    if ((!sdkOn || suspendedKey !== lastSuspendedKey) && canvasOpen()
        && window.AmbientCanvas && AmbientCanvas.refresh) AmbientCanvas.refresh();
    lastSuspendedKey = suspendedKey;
    armIdleTimer();
  }

  armIdleTimer();

  window.AmbientMode = { toggle, open, close, isOpen, onSettingsChanged, onStatus };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    resolveAmbientScene,
    ambientIdleSuppressed,
  };
}
