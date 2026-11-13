// applyHubSettings(): puts the current settings on the page.
'use strict';

let _osThemeChecked = false;   // one fresh /system/theme read per page load

function applyHubSettings() {
  hubSettings = normalizeSettings(hubSettings);
  // The native shell's interface scale, applied on every hydrate rather than only
  // when this surface's settings panel is built.
  //
  // nativeZoom is a hubSettings field, so it already travelled to every surface —
  // but the only thing that ever handed it to the shell was syncNativeZoomControl,
  // which runs when the Settings panel is (re)rendered HERE. A change made on
  // another surface therefore sat in the app's settings, correct and ignored,
  // until someone opened Settings on the app itself or reloaded it. That is also
  // why the control was hidden everywhere else: it would not have worked. Now it
  // does, so it is shown. A no-op off the native app — setNativeZoom returns early
  // when the shell is not there.
  if (window.XenonNative && typeof window.XenonNative.setNativeZoom === 'function') {
    window.XenonNative.setNativeZoom(hubSettings.nativeZoom);
  }
  // Restore the persisted language from server settings (covers browser-storage resets on PC restart)
  if (hubSettings.language && typeof setLang === 'function') setLang(hubSettings.language);
  // Restore app-switcher favorites from server settings (same reason: a starred app
  // must survive a browser-storage reset). One-time migration: if the server has
  // none yet but a local copy exists (favorites used to live only in localStorage),
  // seed the server from it so existing stars aren't lost.
  if (typeof appFavorites !== 'undefined' && Array.isArray(hubSettings.appFavorites)) {
    let migrated = false;
    try { migrated = localStorage.getItem('appFavoritesMigrated') === '1'; } catch { /* ignore */ }
    if (hubSettings.appFavorites.length) {
      // Server is authoritative once it holds anything.
      appFavorites = hubSettings.appFavorites.slice();
      try { localStorage.setItem('appFavorites', JSON.stringify(appFavorites)); } catch { /* ignore */ }
    } else if (!migrated && appFavorites.length) {
      // ONE-TIME seed of pre-server favorites. Guarded by the flag so that a user
      // who deliberately cleared all favorites on another dashboard (server → [])
      // never has them resurrected here from this profile's stale localStorage.
      hubSettings.appFavorites = appFavorites.slice();
      if (typeof saveHubSettings === 'function') saveHubSettings({ server: true });
    }
    try { localStorage.setItem('appFavoritesMigrated', '1'); } catch { /* ignore */ }
    if (typeof renderAppFavorites === 'function') renderAppFavorites();
  }
  // Reflect the swipe-navigation preference on the pager (native scroll + drag)
  // and keep its settings control in sync.
  if (window.DashboardPager && DashboardPager.refreshSwipe) DashboardPager.refreshSwipe();
  syncSwipeNavigationControl();
  syncMediaVisualizerControl();
  syncMediaLyricsControl();
  syncSwipeHomeControl();
  syncHideRdpControl();
  syncSeeThroughControl();
  const root = document.documentElement;
  // The top bar's clock. Stamped as plain multipliers and applied in Topbar.css,
  // where each breakpoint owns the BASE size it scales — the Edge and the phone
  // draw a smaller clock than a desktop, and a single hard-coded size here would
  // undo that.
  const clockScale = clampNumber(hubSettings.clockScale, 0.8, 2, 1);
  const clockDateScale = clampNumber(hubSettings.clockDateScale, 0.8, 2, 1);
  const bgSafeDim = Math.max(hubSettings.bgDim, 0.18);
  const bgSafeDimStrong = Math.min(0.9, bgSafeDim + 0.11);
  const bgBlur = Math.round(hubSettings.bgBlur);
  const bgScale = bgBlur > 0 ? Math.min(1.06, 1 + (bgBlur / 600)) : 1;

  // Dashboard style language (Retro, Comic or glass): js/theme-tokens.js, which
  // the light layer page shares so a layer tile wears the same skin.
  const styleBefore = root.dataset.style;
  const skin = ThemeTokens.applySkin(root, hubSettings);
  const { safe, retro } = skin;
  // Liquid Glass lives on the tiles themselves (applyTileEffects), so they follow a change.
  if (root.dataset.style !== styleBefore && typeof applyAllTileStyles === 'function') applyAllTileStyles(null, { colorsOnly: true });
  document.body.classList.toggle('retro-scanlines', retro && hubSettings.retroScanlines);

  // Idle animation auto-pause (ambient-idle.js runs independently; push the
  // current preference so toggling it takes effect at once).
  if (window.AmbientIdle) window.AmbientIdle.setEnabled(hubSettings.idleAnimationPause !== false);
  // The next load's splash takes the colours applied now.
  if (window.BootSplash) window.BootSplash.remember();

  // Hybrid-GPU session freeze (js/native-bridge.js owns body.low-power-gpu; a
  // no-op on every other machine and on the browser surface).
  if (window.NativeGpuPause) window.NativeGpuPause.setEnabled(hubSettings.hybridGpuAnimationPause !== false);

  // Top-bar clock alignment + meta-field visibility (Settings → Dynamic Island).
  applyTopbarClockSettings();

  // 'auto' resolves from the cached OS scheme above (no white flash); still do one
  // fresh registry read per page load so a scheme change while the dashboard was
  // closed is picked up promptly instead of only on the next 30s poll.
  if (hubSettings.appearance === 'auto' && !_osThemeChecked && !document.hidden) {
    _osThemeChecked = true;
    refreshOsTheme();
  }

  // One application point for every colour role. This also selects the actual
  // light/dark compatibility layer from the derived PANEL luminance, so a custom
  // light surface cannot accidentally keep dark component literals (or vice versa).
  const palette = applyAccentColor();
  const light = palette.tone === 'light';

  // Custom global typeface (independent of the colour palette, js/theme-tokens.js).
  ThemeTokens.applyFont(document, hubSettings.uiFont);

  // Panel opacity, border, shadow, corners and glass (js/theme-tokens.js).
  ThemeTokens.applyMaterial(root, hubSettings, palette, skin);
  root.style.setProperty('--clock-time-scale', String(clockScale));
  root.style.setProperty('--clock-date-scale', String(clockDateScale));
  TopbarLook.apply(hubSettings.topbarLook);

  root.style.setProperty('--bg-dim', hubSettings.bgDim.toFixed(2));
  root.style.setProperty('--bg-safe-dim', bgSafeDim.toFixed(2));
  root.style.setProperty('--bg-safe-dim-strong', bgSafeDimStrong.toFixed(2));
  root.style.setProperty('--bg-blur', `${bgBlur}px`);
  root.style.setProperty('--bg-scale', bgScale.toFixed(3));

  // ── Background FX (static bg + aurora + perspective grid) ───────
  const aurora = normalizeBgAurora(hubSettings.bgAurora);
  const grid = normalizeBgGrid(hubSettings.bgGrid);
  const bgStatic = normalizeBgStatic(hubSettings.bgStatic);
  const bgCustom = normalizeBgCustom(hubSettings.bgCustom);
  // Safe mode hides user-imported backdrops (code background + image/video
  // wallpaper) but keeps the factory FX (aurora/grid/static) as the user set
  // them. The stored keys are untouched — everything returns on toggle-off.
  // The see-through window (native app, Windows): the desktop under the window IS
  // the backdrop, so none of Xenon's own is drawn, nor kept decoding out of sight.
  // Every choice stays stored and comes back when the window is opaque again.
  const seeThrough = seeThroughWindowOn();
  const media = (safe || seeThrough) ? null : hubSettings.backgroundMedia;
  // Code-defined animated background: when enabled (and no image/video wallpaper),
  // it owns the backdrop and suppresses the built-in FX below, exactly like a
  // static premium bg does. Mounted/cleared through the sandboxed CustomBg module.
  const customOn = !safe && !seeThrough && bgCustom.enabled && !!bgCustom.code && !media;
  if (window.CustomBg && typeof window.CustomBg.apply === 'function') {
    window.CustomBg.apply(customOn ? bgCustom.code : null, customOn ? bgCustom.assets : null, bgCustom.fps, hubSettings.bgGuard !== false);
  }

  // Static premium background — mutually exclusive with the animated aurora
  // (turning one on switches the other off: "zero animation" is the point) and,
  // like the aurora/grid, hidden when a custom image/video background is set or a
  // code-defined background owns the backdrop.
  const staticOn = !seeThrough && bgStatic.style !== 'none' && !media && !customOn;
  if (staticOn) document.body.dataset.bgStatic = bgStatic.style;
  else delete document.body.dataset.bgStatic;
  root.style.setProperty('--static-opacity', (0.30 + (bgStatic.intensity / 100) * 0.70).toFixed(3));

  // Aurora only shows when there's no custom background and no static/code bg is active.
  const auroraOn = !seeThrough && aurora.enabled && !media && !staticOn && !customOn;
  document.body.classList.toggle('aurora-on', auroraOn);
  root.style.setProperty('--aurora-opacity', (0.12 + (aurora.intensity / 100) * 0.5).toFixed(3));
  root.style.setProperty('--aurora-duration', `${(72 - (aurora.speed / 100) * 54).toFixed(1)}s`);

  // Like the aurora, the neon grid only shows when there's no custom image/video
  // background — it shouldn't compete with (or visibly flicker over) a user
  // wallpaper. A static premium OR code-defined background also owns the backdrop
  // on its own, so the animated grid is suppressed while one is active.
  document.body.classList.toggle('grid-on', !seeThrough && grid.enabled && !media && !staticOn && !customOn);
  root.style.setProperty('--grid-color', grid.color);
  root.style.setProperty('--grid-rgb', hexToRgb(grid.color).join(', '));
  // The grid reads stronger on a light background, so keep it gentler there.
  const gridOpacity = light
    ? 0.05 + (grid.intensity / 100) * 0.20
    : 0.10 + (grid.intensity / 100) * 0.45;
  root.style.setProperty('--grid-opacity', gridOpacity.toFixed(3));
  root.style.setProperty('--grid-duration', `${(28 - (grid.speed / 100) * 20).toFixed(1)}s`);

  // Re-evaluate game-mode so toggling the setting (or a reset) takes effect now.
  _evalGameModeClass();

  // Sandboxed SDK widgets can't read CSS variables from the host — push the
  // fresh theme tokens over their postMessage bridge. (Before the background-
  // media early-returns below, so it runs on every apply.)
  if (window.CustomWidget && typeof window.CustomWidget.refreshTheme === 'function') window.CustomWidget.refreshTheme();
  // Ambient mode reads enabled/idleMinutes live — re-arm (or cancel) its idle
  // timer whenever settings change, from any source (UI, AI, another surface).
  if (window.AmbientMode) window.AmbientMode.onSettingsChanged();
  // Same reason: the Claude widget's approval cards and topbar marker are
  // settings-gated, and the switch can be flipped on another surface.
  if (window.ClaudeWidget && typeof ClaudeWidget.onSettingsChanged === 'function') ClaudeWidget.onSettingsChanged();
  // The screen choice can arrive from a surface that CANNOT act on it: a paired
  // phone has no channel to the native shell (the only one is a custom-scheme
  // navigation, which exists solely inside the shell's own webview). So the
  // shell's dashboard page watches for the change and relays it — which is the
  // whole reason the choice is stored server-side as well as in display.json.
  if (window.SurfacePicker && typeof window.SurfacePicker.reconcileShell === 'function') {
    window.SurfacePicker.reconcileShell();
  }
  // Same reason again: the System tile's Storico tab is revealed by the sensor-
  // history opt-in or the AI Guardian, and until now only the local toggle
  // (sensor-history-changed) and a Settings render re-evaluated it. A surface that
  // adopted the change over SSE kept the tab hidden until the next reload.
  if (typeof window.syncSystemHistoryTab === 'function') window.syncSystemHistoryTab();

  const bgLayer = $('user-bg-layer');
  let image = $('user-bg-image');
  let video = $('user-bg-video');
  document.body.classList.toggle('has-user-bg', !!media);
  document.body.classList.toggle('no-user-bg', !media);

  // The "Sfondo app" colour paints the canvas behind the panels, but a wallpaper,
  // static or code background sits opaquely on top of it — so the colour has no
  // visible effect while one is active. Warn right on that control when that's the
  // case (aurora/grid are semi-transparent and let the canvas tint through, so
  // they don't count). Runs before the early-return below so it always updates.
  const bgCoveredNote = $('settings-bg-covered-note');
  if (bgCoveredNote) bgCoveredNote.hidden = !(staticOn || customOn || !!media);
  syncAccentOverrideNote();

  if (!bgLayer || !image || !video) return;
  if (!media) {
    image.hidden = true;
    image.removeAttribute('src');
    delete image.dataset.source;
    video.hidden = true;
    video.pause();
    video.removeAttribute('src');
    delete video.dataset.source;
    document.body.removeAttribute('data-bg-type');
    return;
  }

  const source = getBackgroundSource(media);

  if (isVideoBackground(media)) {
    image.hidden = true;
    image.removeAttribute('src');
    delete image.dataset.source;
    if (!video || video.dataset.source !== source) {
      if (video) video.pause();
      video = replaceBackgroundNode(video, createBackgroundVideo(source), bgLayer);
    } else {
      video.hidden = false;
      ensureBackgroundVideoPlayback(video);
    }
    video.hidden = false;
    ensureBackgroundVideoPlayback(video);
    document.body.dataset.bgType = 'video';
  } else {
    video.hidden = true;
    video.pause();
    video.removeAttribute('src');
    delete video.dataset.source;
    if (!image || image.dataset.source !== source) {
      image = replaceBackgroundNode(image, createBackgroundImage(source), bgLayer);
    } else {
      image.hidden = false;
    }
    image.hidden = false;
    document.body.dataset.bgType = media.type === 'image/gif' ? 'gif' : 'image';
  }

  // Keep the System-tile History tab's visibility in step with settings. This
  // runs at boot and after every server hydration, so a persisted sensor-history
  // opt-in reveals its tab without the user opening Settings first.
  if (typeof window.syncSystemHistoryTab === 'function') window.syncSystemHistoryTab();

  // Let Smart context profiles pick up a persisted config at boot / after
  // hydration (it borrows Performance Mode's activity classification).
  if (window.ContextProfiles && typeof window.ContextProfiles.refresh === 'function') window.ContextProfiles.refresh();
}

function formatPercent(value) {
  return `${Math.round(Number(value) * 100)}%`;
}
