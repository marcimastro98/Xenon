// syncSettingsControls(): shows the current settings in every control of the settings window.
'use strict';

function syncSettingsControls() {
  // Sync appearance (light/dark/auto) segmented control
  document.querySelectorAll('.settings-appearance-btn').forEach(btn => {
    const active = btn.dataset.appearance === hubSettings.appearance;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  // On a dual-palette theme the stored colours describe the base tone, but the
  // overlay is painting the other half. Read the fields from the variant that's
  // actually on screen, or every hex would contradict the swatch beside it (which
  // reads the computed value) and editing one would appear to do nothing.
  const shown = activePaletteVariant(hubSettings) || {};

  // Required author colours are always stored explicitly.
  [['accent', '--accent'], ['background', '--bg'], ['text', '--text']].forEach(([key, cssVar]) => {
    const hex = shown[key] || hubSettings[key];
    const preview = $(`settings-${key}-swatch`);
    const hexInput = $(`settings-${key}`);
    if (preview) preview.style.background = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim() || hex;
    if (hexInput) { hexInput.value = hex.toUpperCase(); hexInput.classList.remove('invalid'); }
  });

  // Optional semantic roles (null = auto): swatches show the EFFECTIVE derived
  // value while fields stay blank, making the automatic result inspectable.
  [
    ['surface', '--surface'], ['surfaceAlt', '--surface-alt'], ['controlColor', '--control-bg'],
    ['mutedText', '--muted-text'], ['lineColor', '--line'], ['accentText', '--on-accent'],
    ['successColor', '--color-success'], ['warningColor', '--color-warn'],
    ['dangerColor', '--color-danger'], ['infoColor', '--color-info'],
  ].forEach(([key, cssVar]) => {
    // A role the active variant omits is derived under that tone, so it reads as
    // Auto (blank) here even when the base tone pins it.
    const val = hubSettings.paletteVariants ? (shown[key] || null) : hubSettings[key];
    const preview = $(`settings-${key}-swatch`);
    const hexInput = $(`settings-${key}`);
    if (preview) {
      const eff = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim() || val;
      preview.style.background = eff || 'transparent';
    }
    if (hexInput) { hexInput.value = val ? val.toUpperCase() : ''; hexInput.classList.remove('invalid'); }
  });
  const contrastGuard = $('settings-contrast-guard');
  if (contrastGuard) contrastGuard.checked = hubSettings.contrastGuard !== false;
  const idleAnimPause = $('settings-idle-anim-pause');
  if (idleAnimPause) idleAnimPause.checked = hubSettings.idleAnimationPause !== false;
  const bootSplash = $('settings-boot-splash');
  if (bootSplash) bootSplash.checked = hubSettings.bootSplash !== false;
  // The hybrid-GPU freeze only exists on an iGPU+dGPU machine running the native
  // shell, so the row is hidden everywhere else rather than offering a switch
  // that provably does nothing.
  const claudeCfg = hubSettings.claudeWidget || {};
  const claudeAppr = $('settings-claude-approvals');
  if (claudeAppr) claudeAppr.checked = claudeCfg.approvals !== false;
  const claudeQ = $('settings-claude-questions');
  if (claudeQ) claudeQ.checked = claudeCfg.questions !== false;
  const codexCfg = normalizeCodexWidget(hubSettings.codexWidget);
  const codexAppr = $('settings-codex-approvals');
  if (codexAppr) codexAppr.checked = codexCfg.approvals;
  const codexWait = $('settings-codex-wait');
  if (codexWait) {
    codexWait.value = String(codexCfg.waitSec);
    codexWait._csSync?.();
  }

  const hybridGpuPause = $('settings-hybrid-gpu-pause');
  if (hybridGpuPause) hybridGpuPause.checked = hubSettings.hybridGpuAnimationPause !== false;
  const hybridGpuRow = $('settings-hybrid-gpu-pause-row');
  if (hybridGpuRow) {
    hybridGpuRow.hidden = !(window.NativeGpuPause && window.NativeGpuPause.isLowPowerGpu());
  }
  const versionPing = $('settings-version-ping');
  if (versionPing) versionPing.checked = hubSettings.versionPing === true;
  const autoUpdateChk = $('settings-auto-update');
  if (autoUpdateChk) autoUpdateChk.checked = hubSettings.autoUpdate !== false;
  const autoUpdateWidgetsChk = $('settings-auto-update-widgets');
  if (autoUpdateWidgetsChk) autoUpdateWidgetsChk.checked = hubSettings.autoUpdateWidgets !== false;
  refreshWidgetAutoUpdateLine();
  const hubMsg = $('settings-hub-messages');
  if (hubMsg) hubMsg.checked = hubSettings.hubMessages !== false;
  const catDrops = $('settings-monthly-drops');
  if (catDrops) catDrops.checked = hubSettings.monthlyDrops !== false;
  const catStats = $('settings-catalog-stats');
  if (catStats) catStats.checked = hubSettings.catalogStats === true;
  const ratingAsks = $('settings-rating-asks');
  if (ratingAsks) ratingAsks.checked = hubSettings.ratingAsks !== false;
  const usageStatsChk = $('settings-usage-stats');
  if (usageStatsChk) usageStatsChk.checked = hubSettings.usageStats === true;
  const batteryAskChk = $('settings-battery-ask');
  if (batteryAskChk) batteryAskChk.checked = hubSettings.batteryAskDevices !== false;
  // The PC owner's choice: a paired device does not show it (the server keeps
  // the stored value on a save from one anyway).
  for (const id of ['settings-usage-stats-row', 'settings-usage-stats-link', 'settings-battery-ask-row']) {
    const el = $(id);
    if (el) el.hidden = !!window.__xenonRemote;
  }

  const rangeMap = [
    ['settings-panel-alpha', String(hubSettings.panelAlpha)],
    ['settings-panel-border', String(hubSettings.panelBorderStrength)],
    ['settings-clock-scale', String(hubSettings.clockScale)],
    ['settings-clock-date-scale', String(hubSettings.clockDateScale)],
    ['settings-panel-shadow', String(hubSettings.tileShadowStrength)],
    ['settings-roundness', String(hubSettings.uiRoundness)],
    ['settings-glass-blur', String(hubSettings.glassBlur)],
    ['settings-glass-saturate', String(hubSettings.glassSaturate)],
    ['settings-bg-dim', String(hubSettings.bgDim)],
    ['settings-bg-blur', String(hubSettings.bgBlur)],
  ];
  rangeMap.forEach(([id, value]) => { const el = $(id); if (el) el.value = value; });

  const panelValue = $('settings-panel-alpha-value');
  if (panelValue) panelValue.textContent = formatPercent(hubSettings.panelAlpha);
  const dimValue = $('settings-bg-dim-value');
  if (dimValue) dimValue.textContent = formatPercent(hubSettings.bgDim);
  const blurValue = $('settings-bg-blur-value');
  if (blurValue) blurValue.textContent = `${Math.round(hubSettings.bgBlur)}px`;
  const roundVal = $('settings-roundness-value');
  if (roundVal) roundVal.textContent = formatPercent(hubSettings.uiRoundness);
  const borderVal = $('settings-panel-border-value');
  if (borderVal) borderVal.textContent = formatPercent(hubSettings.panelBorderStrength);
  const shadowVal = $('settings-panel-shadow-value');
  if (shadowVal) shadowVal.textContent = formatPercent(hubSettings.tileShadowStrength);
  const clockVal = $('settings-clock-scale-value');
  if (clockVal) clockVal.textContent = formatPercent(hubSettings.clockScale);
  const clockDateVal = $('settings-clock-date-scale-value');
  if (clockDateVal) clockDateVal.textContent = formatPercent(hubSettings.clockDateScale);
  const glassBlurVal = $('settings-glass-blur-value');
  if (glassBlurVal) glassBlurVal.textContent = `${Math.round(hubSettings.glassBlur)}px`;
  const glassSatVal = $('settings-glass-saturate-value');
  if (glassSatVal) glassSatVal.textContent = `${Math.round(hubSettings.glassSaturate)}%`;

  const media = hubSettings.backgroundMedia;
  const title = $('settings-bg-title');
  const sub = $('settings-bg-sub');
  if (title) title.textContent = media ? media.name : t('settings_bg_upload');
  if (sub) sub.textContent = media ? t(isVideoBackground(media) ? 'settings_bg_video_loaded' : 'settings_bg_image_loaded') : t('settings_bg_upload_hint');
  const blurNote = $('settings-bg-blur-note');
  if (blurNote) blurNote.textContent = media ? t('settings_bg_blur_note_active') : t('settings_bg_blur_note_empty');

  const uiFont = hubSettings.uiFont;
  const fontTitle = $('settings-font-title');
  if (fontTitle) fontTitle.textContent = uiFont ? uiFont.name : t('settings_font_upload');
  const fontSub = $('settings-font-sub');
  if (fontSub) fontSub.textContent = uiFont ? t('settings_font_loaded') : t('settings_font_upload_hint');

  // Sync active language button
  syncLangButtons();
  syncStyleModeControls();
  syncTopbarStyleControls();
  syncTopbarClockControls();
  // Swap the topbar chrome (full bar ⇄ edge rails + island pill) to match.
  if (window.TopbarMinimal) window.TopbarMinimal.apply();
  if (window.SdkIsland) window.SdkIsland.apply();
  syncClockFormatControls();
  syncWeekStartControls();
  syncUpcomingControls();
  syncLockWidgetSettings();
  syncAutoOpenBrowserControl();
  syncSwipeHomeControl();
  syncHideRdpControl();
  syncSeeThroughControl();
  syncAudioCommsControl();
  syncNativeZoomControl();
  syncUsageModeControl();
  syncStackModeControls();
  syncBrowserAdblockControl();
  syncWeatherSettingsControls();
  syncStocksTickerControls();
  syncAiSettingsControls();
  syncBgFxControls();
  syncGameModeControls();
  syncSensorHistoryControls();
  syncGameSessionsControls();
  syncPerfHudControls();
  syncProactiveControls();
  syncNotificationsControls();
  syncVitalsControls();
  renderSlideshowSettings();
  // Bit only mounts/unmounts via sync(): the DOMContentLoaded pass sees the
  // localStorage copy, which a PC restart can reset — without this, a pet
  // enabled in the server settings never appeared until a manual toggle.
  if (window.VitalsPet && typeof window.VitalsPet.sync === 'function') window.VitalsPet.sync();
  syncSdkWidgetsControls();
  syncPerformanceControls();
  syncContextProfileControls();
  renderPageHotkeyRows();
  syncSecondScreenControls();
  syncDynamicAlbumControls();
  refreshGameModeStatus();
  // The whole RGB hub renders dynamically into Settings → Illuminazione.
  if (window.LightingPage) window.LightingPage.init();
  // Settings → Telefono, in order: the door, then what comes through it.
  if (window.RemoteAccessPage) window.RemoteAccessPage.init();
  if (window.TransferWidget && window.TransferWidget.initSettings) window.TransferWidget.initSettings();
  // Remote Control wizard renders dynamically into Settings → Controllo Remoto,
  // which is now that wizard alone: streaming and driving the DESKTOP.
  if (window.RemoteControl) window.RemoteControl.init();
  // Streaming (Twitch) connect panel renders into Settings → Streaming.
  if (window.StreamingPage) window.StreamingPage.init();
  // Spotify connect card renders into its own Settings → Spotify section.
  if (window.SpotifySettings) window.SpotifySettings.init();
  // Home Assistant connect + device picker renders into Settings → Smart Home.
  if (window.SmartHome && typeof window.SmartHome.initSettings === 'function') window.SmartHome.initSettings();
  // UniFi Protect connect + camera picker renders into Settings → Cameras.
  if (window.UnifiProtect && typeof window.UnifiProtect.initSettings === 'function') window.UnifiProtect.initSettings();
  if (window.SensorAccess && typeof window.SensorAccess.initSettings === 'function') window.SensorAccess.initSettings(); // Performance cards, only when needed
  if (window.FfmpegOffer) window.FfmpegOffer.initSettings();
  // "Sensor sources" lists render into Settings → Performance (polls only while shown).
  for (const p of [window.SensorSourcesPage, window.GameIgnorePage]) if (p) p.show();
  // External calendars section — injected dynamically (no HTML change required).
  _initCalendarFeedsSection();
}
