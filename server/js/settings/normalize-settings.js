// normalizeSettings(): turns whatever was saved or received into a complete, valid settings object.
'use strict';

function normalizeSettings(source) {
  const value = source && typeof source === 'object' ? source : {};
  // One-time migration: if the saved layout predates the current version,
  // force the new default layout (overrides the user's old saved layout on
  // upgrade) while preserving all other settings.
  const layoutVersion = Number(value.dashboardLayoutVersion) || 0;
  const resetLayout = layoutVersion < DASHBOARD_LAYOUT_VERSION;
  return {
    appearance: ['light', 'dark', 'auto'].includes(value.appearance) ? value.appearance : DEFAULT_HUB_SETTINGS.appearance,
    autoPalette: value.autoPalette === true || (value.autoPalette == null && value.appearance === 'auto'),
    styleMode: value.styleMode == null ? DEFAULT_HUB_SETTINGS.styleMode : normStyleMode(value.styleMode),
    retroScanlines: value.retroScanlines !== false,
    topbarStyle: ['full', 'minimal'].includes(value.topbarStyle) ? value.topbarStyle : DEFAULT_HUB_SETTINGS.topbarStyle,
    topbarRails: normalizeTopbarRails(value.topbarRails),
    topbarRailsAutoHide: value.topbarRailsAutoHide !== false,
    topbarClock: normalizeTopbarClock(value.topbarClock, value),
    topbarLook: TopbarLook.normalize(value.topbarLook),
    layers: LayersModel.normalize(value.layers),
    clockFormat: ['auto', '12', '24'].includes(value.clockFormat) ? value.clockFormat : DEFAULT_HUB_SETTINGS.clockFormat,
    clockScale: clampNumber(value.clockScale, 0.8, 2, DEFAULT_HUB_SETTINGS.clockScale),
    clockDateScale: clampNumber(value.clockDateScale, 0.8, 2, DEFAULT_HUB_SETTINGS.clockDateScale),
    clockDateFormat: ['full', 'medium', 'short'].includes(value.clockDateFormat) ? value.clockDateFormat : DEFAULT_HUB_SETTINGS.clockDateFormat,
    weekStart: ['mon', 'sun'].includes(value.weekStart) ? value.weekStart : DEFAULT_HUB_SETTINGS.weekStart,
    upcomingCount: [3, 5, 8, 10].includes(Number(value.upcomingCount)) ? Number(value.upcomingCount) : DEFAULT_HUB_SETTINGS.upcomingCount,
    upcomingDays: [0, 7, 14, 30].includes(Number(value.upcomingDays)) ? Number(value.upcomingDays) : DEFAULT_HUB_SETTINGS.upcomingDays,
    upcomingColumns: [0, 1, 2].includes(Number(value.upcomingColumns)) ? Number(value.upcomingColumns) : DEFAULT_HUB_SETTINGS.upcomingColumns,
    swipeNavigation: value.swipeNavigation !== false,
    swipeHomeGesture: value.swipeHomeGesture !== false,
    hideOnRdp: value.hideOnRdp === true,
    audioSetCommunications: value.audioSetCommunications !== false,
    nativeZoom: clampNumber(value.nativeZoom, 0.6, 2.5, DEFAULT_HUB_SETTINGS.nativeZoom),
    accent: normalizeHex(value.accent, DEFAULT_HUB_SETTINGS.accent),
    dynamicAlbumTheme: value.dynamicAlbumTheme !== false,
    background: normalizeHex(value.background, DEFAULT_HUB_SETTINGS.background),
    surface: normalizeHex(value.surface, null),
    surfaceAlt: normalizeHex(value.surfaceAlt, null),
    controlColor: normalizeHex(value.controlColor, null),
    text: normalizeHex(value.text, DEFAULT_HUB_SETTINGS.text),
    accentText: normalizeHex(value.accentText, null),
    successColor: normalizeHex(value.successColor, null),
    warningColor: normalizeHex(value.warningColor, null),
    dangerColor: normalizeHex(value.dangerColor, null),
    infoColor: normalizeHex(value.infoColor, null),
    paletteVariants: normalizePaletteVariants(value.paletteVariants),
    contrastGuard: value.contrastGuard !== false,
    panelAlpha: clampNumber(value.panelAlpha, SETTINGS_MIN_PANEL_ALPHA, 1, DEFAULT_HUB_SETTINGS.panelAlpha),
    bgDim: clampNumber(value.bgDim, 0.05, 0.9, DEFAULT_HUB_SETTINGS.bgDim),
    bgBlur: clampNumber(value.bgBlur, 0, 24, DEFAULT_HUB_SETTINGS.bgBlur),
    idleAnimationPause: value.idleAnimationPause !== false,
    bootSplash: value.bootSplash !== false,
    // Sensor cadence (ms). Mirrors normalizeSensorRate in server.js: both sides
    // persist this key, so both have to rebuild it the same way or a save from
    // one would strip what the other wrote.
    sensorRateMs: SENSOR_RATE_MS.includes(Math.round(Number(value.sensorRateMs))) ? Math.round(Number(value.sensorRateMs)) : 5000,
    // Which sensor feeds CPU/GPU temperature and watts; {} = Automatic for all.
    // One rule with the server (js/sensor-sources.js, loaded before this file).
    sensorSources: window.SensorSources ? window.SensorSources.normalizeSensorSources(value.sensorSources) : {},
    gameIgnore: window.GameIgnore ? window.GameIgnore.normalizeGameIgnore(value.gameIgnore) : [],
    safeMode: value.safeMode === true,
    hybridGpuAnimationPause: value.hybridGpuAnimationPause !== false,
    uiRoundness: clampNumber(value.uiRoundness, 0, 2, DEFAULT_HUB_SETTINGS.uiRoundness),
    glassBlur: clampNumber(value.glassBlur, 0, 40, DEFAULT_HUB_SETTINGS.glassBlur),
    glassSaturate: clampNumber(value.glassSaturate, 100, 220, DEFAULT_HUB_SETTINGS.glassSaturate),
    panelBorderStrength: clampNumber(value.panelBorderStrength, 0, 2, DEFAULT_HUB_SETTINGS.panelBorderStrength),
    tileShadowStrength: clampNumber(value.tileShadowStrength, 0, 2, DEFAULT_HUB_SETTINGS.tileShadowStrength),
    mutedText: normalizeHex(value.mutedText, null),
    lineColor: normalizeHex(value.lineColor, null),
    backgroundMedia: sanitizeBackgroundMedia(value.backgroundMedia),
    uiFont: sanitizeUiFont(value.uiFont),
    lockWidgets: normalizeLockWidgets(value.lockWidgets),
    ambientMode: normalizeAmbientMode(value.ambientMode),
    ambientScenes: normalizeAmbientScenes(value.ambientScenes),
    weather: normalizeWeatherSettings(value.weather),
    tempUnit: value.tempUnit === 'f' ? 'f' : 'c',
    hwTempUnit: ['auto', 'c', 'f'].includes(value.hwTempUnit) ? value.hwTempUnit : 'auto',
    mediaVisualizer: ['off', 'minimal', 'wave'].includes(value.mediaVisualizer) ? value.mediaVisualizer : (value.mediaVisualizer === true ? 'wave' : 'off'),
    mediaLyrics: value.mediaLyrics !== false,
    lyricsOffsetMs: Math.round(clampNumber(value.lyricsOffsetMs, -3000, 3000, 0) / 100) * 100,
    lyricsTranslate: value.lyricsTranslate === true,
    lyricsReading: value.lyricsReading !== false,
    lyricsTranslateCap: [50, 200, 500].includes(Number(value.lyricsTranslateCap)) ? Number(value.lyricsTranslateCap) : 200,
    lyricsStage: value.lyricsStage === true,
    // The same choices as the server (sdk-ai.js DAILY_CAPS).
    sdkAiDailyCap: SDK_AI_DAILY_CAPS.includes(Number(value.sdkAiDailyCap)) ? Number(value.sdkAiDailyCap) : 50,
    spotifyStartMinimized: value.spotifyStartMinimized === true,
    autoOpenBrowser: value.autoOpenBrowser !== false,
    versionPing: value.versionPing === true,
    // Automatic updates: on unless the user switched them off (server/auto-update.js).
    autoUpdate: value.autoUpdate !== false,
    autoUpdateWidgets: value.autoUpdateWidgets !== false,
    hubMessages: value.hubMessages !== false,
    catalogDrops: value.catalogDrops !== false,
    monthlyDrops: value.monthlyDrops !== false,
    // Mirror of normalizeHubSettings in server.js — keep in step.
    whatsNewSeen: typeof value.whatsNewSeen === 'string' ? value.whatsNewSeen.trim().slice(0, 64) : '',
    releaseNotesSeen: typeof value.releaseNotesSeen === 'string' ? value.releaseNotesSeen.trim().slice(0, 32) : '',
    updateFailSeen: typeof value.updateFailSeen === 'string' ? value.updateFailSeen.trim().slice(0, 64) : '',
    discordInviteSeen: value.discordInviteSeen === true,
    // Usage history, server-owned (server.js counts the days; POST /settings
    // keeps its own values). Round-tripped here for the same reason as every
    // other mirrored key: the known-key rebuild would otherwise drop them from
    // the blob this client sends back.
    firstRunDay: typeof value.firstRunDay === 'string' ? value.firstRunDay.slice(0, 10) : '',
    lastUsageDay: typeof value.lastUsageDay === 'string' ? value.lastUsageDay.slice(0, 10) : '',
    usageDays: Math.max(0, Math.floor(Number(value.usageDays) || 0)),
    supportAskSeen: value.supportAskSeen === true,
    supportAskSeenDay: /^\d{4}-\d{2}-\d{2}$/.test(String(value.supportAskSeenDay || '')) ? String(value.supportAskSeenDay) : '',
    supportAppealYear: Math.min(9999, Math.max(0, Math.floor(Number(value.supportAppealYear) || 0))),
    shareNudgeSeen: value.shareNudgeSeen === true,
    discordFavChannels: normalizeSnowflakeList(value.discordFavChannels),
    discordCollapsedGuilds: normalizeSnowflakeList(value.discordCollapsedGuilds),
    catalogStats: value.catalogStats === true,
    ratingAsks: value.ratingAsks !== false,
    usageStats: value.usageStats === true,
    batteryAskDevices: value.batteryAskDevices !== false,
    browserAdblock: value.browserAdblock === true,
    dashboardLayout: resetLayout
      ? cloneDashboardLayout(DEFAULT_DASHBOARD_LAYOUT)
      : normalizeDashboardLayout(value.dashboardLayout),
    dashboardLayoutVersion: DASHBOARD_LAYOUT_VERSION,
    // Saved presets are validated by DashboardPresets when it's loaded; at the
    // very first (module-load) normalize it isn't yet, so fall back to a bounded
    // passthrough of the already-server-normalized array.
    dashboardPresets: (typeof DashboardPresets !== 'undefined' && DashboardPresets.normalizePresets)
      ? DashboardPresets.normalizePresets(value.dashboardPresets, DASHBOARD_WIDGET_IDS)
      : (Array.isArray(value.dashboardPresets) ? value.dashboardPresets.slice(0, 60) : []),
    customThemes: normalizeCustomThemes(value.customThemes),
    // Same load-order hazard as dashboardLayout.copies: ContentInstalls loads
    // after settings.js, so fail-closed here would drop every install receipt at
    // the parse-time normalize and a pre-hydrate save would persist the loss.
    contentInstalls: (typeof ContentInstalls !== 'undefined' && ContentInstalls.normalizeContentInstalls)
      ? ContentInstalls.normalizeContentInstalls(value.contentInstalls)
      : (Array.isArray(value.contentInstalls) ? value.contentInstalls.slice(0, 200) : []),
    // Server-only since v4.11.0, same shape as the OpenAI/Anthropic keys below:
    // the browser holds one only while the user is typing it, and `*Set` is what
    // every readiness check reads (see `geminiKeyReady`).
    geminiApiKey: String(value.geminiApiKey || '').trim().slice(0, 200),
    geminiApiKeySet: value.geminiApiKeySet === true || !!String(value.geminiApiKey || '').trim(),
    aiProvider: AI_PROVIDER_IDS.includes(value.aiProvider) ? value.aiProvider : 'gemini',
    ollamaModel: (typeof value.ollamaModel === 'string'
      && /^[a-z0-9._:-]+$/.test(value.ollamaModel)
      && value.ollamaModel.length <= 60)
      ? value.ollamaModel : 'auto',
    // ChatGPT (OpenAI) + Claude (Anthropic). The keys are redacted to '' on the
    // wire (server-only) and re-supplied only while the user is typing one; the
    // *Set booleans carry "a key is saved" so the UI and the ready-gate know.
    openaiApiKey: String(value.openaiApiKey || '').trim().slice(0, 200),
    openaiApiKeySet: value.openaiApiKeySet === true || !!String(value.openaiApiKey || '').trim(),
    openaiModel: normalizeModelChoice(value.openaiModel),
    openaiSttModel: normalizeModelChoice(value.openaiSttModel),
    openaiTtsModel: normalizeModelChoice(value.openaiTtsModel),
    anthropicApiKey: String(value.anthropicApiKey || '').trim().slice(0, 200),
    anthropicApiKeySet: value.anthropicApiKeySet === true || !!String(value.anthropicApiKey || '').trim(),
    anthropicModel: normalizeModelChoice(value.anthropicModel),
    xenonModel: ['haiku', 'sonnet', 'opus'].includes(value.xenonModel) ? value.xenonModel : 'sonnet',
    xenonEffort: ['low', 'medium', 'high'].includes(value.xenonEffort) ? value.xenonEffort : 'medium',
    claudeCodeModel: normalizeCliModel(value.claudeCodeModel),
    codexModel: normalizeCliModel(value.codexModel),
    // Gemini, one per role. Same shape as the two above: `auto` / `auto:<family>`
    // follows the provider's releases, a concrete id is a pin. The server
    // resolves them (ai-models.js); the client only stores the choice.
    geminiModel: normalizeModelChoice(value.geminiModel),
    geminiModelPro: normalizeModelChoice(value.geminiModelPro),
    geminiModelTts: normalizeModelChoice(value.geminiModelTts),
    geminiModelLive: normalizeModelChoice(value.geminiModelLive),
    localApiUrl: LocalServerFields.sanitizeUrl(value.localApiUrl),
    localApiModel: LocalServerFields.sanitizeModel(value.localApiModel),
    localApiKey: String(value.localApiKey || '').trim().slice(0, 200),
    localApiKeySet: value.localApiKeySet === true || !!String(value.localApiKey || '').trim(),
    localApiVision: value.localApiVision === true,
    ollamaUrl: (typeof value.ollamaUrl === 'string'
      && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(value.ollamaUrl))
      ? value.ollamaUrl.replace(/\/+$/, '') : 'http://localhost:11434',
    hardwareScan: (value.hardwareScan && typeof value.hardwareScan === 'object')
      ? value.hardwareScan : null,
    aiTtsEnabled: value.aiTtsEnabled !== false,
    aiMicSensitivity: clampNumber(value.aiMicSensitivity, 0, 100, DEFAULT_HUB_SETTINGS.aiMicSensitivity),
    aiChatHidden: value.aiChatHidden === true,
    aiMemory: value.aiMemory !== false,
    aiProReasoning: value.aiProReasoning === true,
    aiLiveVoice: value.aiLiveVoice === true,
    aiVoiceAmbient: value.aiVoiceAmbient === true,
    aiEdgeGlow: ['auto', 'main', 'second', 'all', 'off'].includes(value.aiEdgeGlow) ? value.aiEdgeGlow : 'auto',
    usageMode: window.UsageMode ? window.UsageMode.normalize(value.usageMode) : '',
    aiFeatures: normalizeAiFeatures(value.aiFeatures),
    sensorHistory: window.SensorHistory ? window.SensorHistory.normalizeSensorHistory(value.sensorHistory)
      : { enabled: !!(value.sensorHistory && value.sensorHistory.enabled === true), everyMin: 5 },
    gameSessions: { enabled: !(value.gameSessions && value.gameSessions.enabled === false) },
    perfHud: window.PerfHud ? window.PerfHud.normalizePerfHud(value.perfHud) : {},
    fanLabels: normalizeFanLabels(value.fanLabels),
    proactive: normalizeProactive(value.proactive),
    notifications: normalizeNotifications(value.notifications),
    vitals: normalizeVitals(value.vitals),
    discordNotifications: normalizeDiscordNotifications(value.discordNotifications),
    windowsNotifications: normalizeWindowsNotifications(value.windowsNotifications),
    calls: normalizeCallsClient(value.calls),
    phone: normalizePhoneClient(value.phone),
    wakeWord: normalizeWakeWord(value.wakeWord),
    searchSettings: normalizeSearchSettings(value.searchSettings),
    pageHotkeys: normalizePageHotkeys(value.pageHotkeys),
    diskSettings: normalizeDiskSettings(value.diskSettings),
    sdkWidgets: normalizeSdkWidgets(value.sdkWidgets),
    bgAurora: normalizeBgAurora(value.bgAurora),
    bgGrid: normalizeBgGrid(value.bgGrid),
    bgStatic: normalizeBgStatic(value.bgStatic),
    bgCustom: normalizeBgCustom(value.bgCustom),
    slideshow: normalizeSlideshow(value.slideshow),
    claudeWidget: normalizeClaudeWidget(value.claudeWidget),
    codexWidget: normalizeCodexWidget(value.codexWidget),
    chatgptWidget: normalizeChatgptWidget(value.chatgptWidget),
    gameMode: value.gameMode !== false,
    bgGuard: value.bgGuard !== false,
    performance: normalizePerformance(value.performance),
    contextProfiles: normalizeContextProfiles(value.contextProfiles),
    lighting: normalizeLighting(value.lighting),
    calendarFeeds: Array.isArray(value.calendarFeeds) ? value.calendarFeeds : [],
    stocks: normalizeStocksClient(value.stocks),
    twelveDataKey: String(value.twelveDataKey || '').trim().slice(0, 120),
    twelveDataKeySet: value.twelveDataKeySet === true || (typeof value.twelveDataKey === 'string' && value.twelveDataKey.length > 0),
    finnhubKey: String(value.finnhubKey || '').trim().slice(0, 120),
    finnhubKeySet: value.finnhubKeySet === true || (typeof value.finnhubKey === 'string' && value.finnhubKey.length > 0),
    football: normalizeFootballClient(value.football),
    sportsDbKey: String(value.sportsDbKey || '').trim().slice(0, 60),
    sportsDbKeySet: value.sportsDbKeySet === true || (typeof value.sportsDbKey === 'string' && value.sportsDbKey.length > 0),
    news: normalizeNewsClient(value.news, value.language),
    newsDataKey: String(value.newsDataKey || '').trim().slice(0, 120),
    newsDataKeySet: value.newsDataKeySet === true || (typeof value.newsDataKey === 'string' && value.newsDataKey.length > 0),
    ticker: normalizeTickerClient(value.ticker),
    browserTiles: normalizeBrowserTiles(value.browserTiles),
    browserFavorites: normalizeBrowserFavorites(value.browserFavorites),
    // App-switcher favorites (client-owned): validated/deduped by parseAppFavorites,
    // round-tripped so a starred app survives a browser-storage reset.
    appFavorites: parseAppFavorites(value.appFavorites),
    secondScreen: normalizeSecondScreen(value.secondScreen),
    obsHost: String(value.obsHost || '').trim().slice(0, 200),
    obsAutoLaunch: typeof value.obsAutoLaunch === 'boolean' ? value.obsAutoLaunch : true,
    obsPort: Math.max(1, Math.min(65535, parseInt(value.obsPort, 10) || 4455)),
    obsPassword: String(value.obsPassword || '').slice(0, 200),
    // `*Set` is server-provided (redaction flag); a freshly-typed password also
    // counts as set until the save round-trips and blanks it back to ''.
    obsPasswordSet: value.obsPasswordSet === true || (typeof value.obsPassword === 'string' && value.obsPassword.length > 0),
    streamerbotHost: String(value.streamerbotHost || '').trim().slice(0, 200),
    streamerbotPort: Math.max(1, Math.min(65535, parseInt(value.streamerbotPort, 10) || 8080)),
    streamerbotPassword: String(value.streamerbotPassword || '').slice(0, 200),
    streamerbotPasswordSet: value.streamerbotPasswordSet === true || (typeof value.streamerbotPassword === 'string' && value.streamerbotPassword.length > 0),
    homeAssistant: normalizeHomeAssistant(value.homeAssistant),
    unifi: normalizeUnifi(value.unifi),
    chroma: { enabled: !!(value.chroma && value.chroma.enabled === true) },
    wavelink: (() => {
      const w = (value.wavelink && typeof value.wavelink === 'object') ? value.wavelink : {};
      const port = parseInt(w.port, 10);
      return { enabled: w.enabled === true, port: (port >= 1 && port <= 65535) ? port : 0 };
    })(),
    // Monotonic save revision: bumped on every real (server-bound) save so the
    // boot-time merge can tell which copy is newer and a stale server copy can
    // never clobber a more recent local one (see hydrateHubSettingsFromServer).
    rev: Number.isFinite(value.rev) && value.rev > 0 ? Math.floor(value.rev) : 0,
    onboarding: normalizeOnboarding(value.onboarding),
    surfaceChoice: normalizeSurface(surfaceChoiceFrom(value)),
    language: SUPPORTED_LANGS.includes(value.language) ? value.language : '',
  };
}
