/*
 * Xenon — Copyright (c) 2026 Marcello Mastroeni (marcimastro98).
 * Custom non-commercial license. Personal use only; no commercial use or
 * redistribution as your own. Attribution required. See LICENSE for terms.
 */
// FIRST, before every other require: this arms the handlers that write down why
// the engine did not start. The failure it most needs to catch is one of the
// requires below throwing — a dependency that never finished installing — and a
// handler armed after the throw would never see it. See startup-log.js for why
// this process was the last of the three that could still die without a word.
const startupLog = require('./startup-log');
const osTheme = require('./os-theme');
startupLog.install();
const http = require('http');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
// Files the server creates are the user's alone on Linux and macOS (settings
// with API keys, tokens, recordings, exports): a umask of 022 would make them
// readable by every other account on the machine.
if (process.platform !== 'win32') process.umask(0o077);
// Screenshots, recordings and speech go to a private temp folder (0700), not
// as predictable names in the shared /tmp.
const { privateTmpDir } = require('./private-tmp');
const { nativeCollectors } = require('./system/native-collectors.js');
const { POWERSHELL_SUPPORTED } = require('./powershell/supported.js');
const fpsMonitor = require('./fps-monitor'); // PresentMon on Windows, MangoHud on Linux
require('./fps-demand');
// Single-screen capabilities (js/capability-catalog.js): one declaration, run
// through deckRegistry, offered to the Deck editor and Xenon AI from there.
const capabilities = require('./capabilities');
const { createNotificationOpener, platformDeps: notificationOpenDeps } = require('./notification-open/index.js');
const layersHost = require('./layers-host').createLayersHost();
// Edit mode of the layer windows (layers-edit.js): runtime only, told to every
// open window over SSE `layers-edit`.
const DeckShortcuts = require('./js/deck-shortcuts.js');
const { _altGrKeys } = require('./deck/altgr-keys.js');
_altGrKeys();
const { createDeckShortcutRunner } = require('./deck/deck-shortcut-runner');
const { createDeckPress } = require('./deck/deck-press');
const LayerKey = require('./capabilities/layer-key');
const { createDeckSoundPlayer } = require('./deck/deck-sound-player');
const LayerPages = require('./layer-pages');
const { createSituations } = require('./capabilities/situations');
const { createWidgetKeys } = require('./widget-keys');
const { readFailed, heardMedia, reportedApps, afterPress, PRESS_HOLDS_MS, cacheLife } = require('./media-read');
const { pressMediaKey, tellApp, createMediaSender } = require('./media-key.js');
const micUse = require('./mic-use');
const { isOwnApp } = require('./capabilities/layer-anchor');
const { createPerfStream } = require('./perf-stream');
require('./system/packet-loss');
require('./perf-net');
const { createStutterWatch } = require('./stutter-why');
require('./exclusive-hint');
const { createGameSessions } = require('./game-sessions');
require('./time/calendar-reminders');
const listOps = require('./list-ops');
const sceneImages = require('./ambient/scene-images');
const { createBenchmark, resolveDocumentsDir } = require('./benchmark');
require('./capture-host');
const { createCaptures } = require('./captures');
const { createCaptureGallery } = require('./capture-gallery');
const { createCaptureSend } = require('./capture-send');
const { createCaptureCopy } = require('./capture-copy');
require('./js/page-target.js'); // which page "go to Streaming" means (shared with the pager); nothing is taken from it here, but it runs code when it loads
const TileMaterial = require('./js/tile-material.js'); // the materials style_tile may name (shared with the style window)
require('./tile-play'); // play_in_tile: a channel, video or page into its tile, claimed by one surface
require('./favorites-ai'); // edit_favorites: stocks, teams, news sources and topics by name
require('./settings-ai'); // change_setting: the allowlisted Settings switches
require('./grid/tile-settings'); // POST /settings/tile: a tile's own choices from a layer page
require('./vitals/vitals-state'); // vitals.state merge, shared by /settings and POST /api/vitals/state
const CaptureCovers = require('./capture-covers');
const { createCaptureTranscripts } = require('./capture-transcripts');
const { createCaptureExport } = require('./capture-export');
const TranscriptFormat = require('./transcript-format');
const { createRecorder } = require('./recorder');
const { createCaptureMarkers } = require('./capture-markers');
const { createAutoClips } = require('./capture-autoclips');
const { createStepsRecorder } = require('./steps-recorder');
require('./capture-last.js');
const StepsDoc = require('./steps-doc');
const { createReplay, estimateBitrate, ringByteRate } = require('./replay');
const { createBugReport } = require('./bug-report');
const { writeZip } = require('./zip-writer');
const CaptureSettings = require('./capture-settings');
const { createCaptureFolder } = require('./capture-folder');
const { resolveUserFolder, replayRingDir } = require('./platform/user-folders');
const { _captureHost } = require('./screens/capture-engine-host.js');

const {
  DASHBOARD_WIDGET_IDS, DASHBOARD_LAYOUT_VERSION,
} = require('./grid/layout-defaults.js');

const { normalizeMedia } = require('./media/normalize.js');

const { normalizeNotifications } = require('./settings/normalize-notifications.js');

const { readPwshJson, parseJsonOutput } = require('./powershell/read-json.js');

const { launchLinuxApp } = require('./programs/launch-linux-app.js');

const { revealInFileManager } = require('./files/reveal-in-file-manager.js');

const {
  BACKGROUND_MIME_BY_EXT, FONT_MAX_BYTES, FONT_MIME_BY_EXT, TILE_ASSET_MIME_BY_EXT,
} = require('./http/upload-limits.js');

const { SSE_MAX_PER_DEVICE } = require('./http/sse-limits.js');

const { TIMERS_MAX, _getTimerElapsed, _getTimerRemaining } = require('./time/timer-values.js');

const {
  MEDIA_HOST_RETRY_MS, MEDIA_HELPER_BAD_MS, MEDIA_CACHE_MS, MEDIA_READER_REST_MS,
} = require('./media/timings.js');

const { liveMediaSnapshot } = require('./media/snapshot.js');

const { svvEachApp } = require('./audio/app-each.js');

const { cpuSnapshot, getCpuName } = require('./system/cpu.js');

const {
  RAM_INFO_RETRY_MS, IDLE_POLL_MS, IDLE_POLL_FAST_MS, IDLE_AWAY_SEC, BATTERY_POLL_GAME_MS,
} = require('./system/timings.js');

const { DISK_LETTERS_TTL } = require('./disk/details-timings.js');

const { joinDiskDetails } = require('./disk/details-shape.js');

const { resolveExecInDir } = require('./deck/open-app-folder.js');

const layersEdit = require('./layers-edit').createLayersEdit({
  broadcast: (on) => broadcastSSE('layers-edit', { on }),
  // Editing showed the surfaces the user had hidden: hide them again, unless
  // the user chose what to show meanwhile.
  onEnd: (hidden) => {
    updateLayersSetting((cur) => {
      const now = LayersModel.normalize(cur);
      if (now.hidden.length) return { error: 'unchanged' };
      return { layers: { ...now, hidden } };
    }).catch(() => { /* the widgets stay shown: still usable */ });
  },
  onOff: (byHand) => screenMenu.holdEnded(byHand),
});
const { sseClients, broadcastSSE } = require('./http/sse-clients.js');

// The widget whose screen is open in the menu shows whatever its rule says (layers-peek.js).
const layersPeek = require('./layers-peek').createLayersPeek({
  broadcast: (id) => broadcastSSE('layers-peek', { id }),
});
// Drawing on the screen through the shell where the engine has no sheet (macOS,
// Linux): open or not, told to the pages over SSE `screen_draw`.
const drawShell = require('./alerts/screen-draw-shell').createScreenDrawShell({
  host: layersHost, broadcast: (state) => broadcastSSE('screen_draw', state),
});
// The Xenon menu over the main screen (screen-menu.js, plan §20): open or not,
// told over SSE `screen_menu`; with no shell to draw it, the dashboards open
// the same menu as a panel (SSE `xenon_menu_panel`).
const screenMenu = require('./screen-menu').createScreenMenu({
  host: layersHost,
  broadcast: (state) => {
    if (!state.open) layersPeek.set(null);
    broadcastSSE('screen_menu', state);
  },
  panel: (state) => broadcastSSE('xenon_menu_panel', state),
  run: (action) => deckRegistry.run(action),
  failed: (error) => broadcastSSE('xenon_menu_failed', { error }),
  capturing: () => _recorder.status().on === true || _replay.status().on === true,
  holding: () => layersEdit.get(),
});
const XenonMenu = require('./xenon-menu');
const MenuStore = require('./menu-store.js');
const { LAYER_TILE_EXCLUDED } = require('./widget-options/layer-tile-excluded.js');
async function _layerCatalog() {
  const all = ((await sdkPackagesCached().catch(() => null)) || { packages: [] }).packages
    .map(p => ({ id: p.id, name: p.name, description: p.description, surface: p.surface, category: p.category, fit: p.fit, options: p.options, optionValues: widgetOptionsStore.valuesFor(p) }));
  return {
    tiles: DASHBOARD_WIDGET_IDS.filter(id => !LAYER_TILE_EXCLUDED.has(id)),
    // A scene fills a whole screen: it is chosen as the wallpaper, never placed as a widget.
    packages: all.filter(p => p.surface !== 'ambient'),
    scenes: all.filter(p => p.surface === 'ambient'),
  };
}
// The functions installed Store widgets offer to keys (capabilities/widget-key.js),
// with whether the person allowed each one when the widget was installed, and the
// combinations their creators suggest (only offered in the menu, never set).
async function _sdkWidgetKeys() {
  if (!sdkFeatureEnabled()) return [];
  const scan = await sdkPackagesCached();
  return scan.packages.map((p) => {
    const granted = sdkGrantsFor(p.id).handlers;
    const list = (p.deck && Array.isArray(p.deck.handlers)) ? p.deck.handlers : [];
    return {
      id: p.id, name: p.name || p.id, ...(p.key ? { key: p.key } : {}),
      handlers: list.map((h) => ({ id: h.id, name: h.name, params: h.params || [], granted: granted.includes(h.id), ...(h.key ? { key: h.key } : {}) })),
    };
  });
}
const { getInstalledApps } = require('./search/installed-apps-list.js');

const capabilityRunner = capabilities.createCapabilities({
  fps: fpsMonitor,
  // What this machine can tell a widget's rule (the menu hides the rest and says why).
  situations: { call: () => micUse.available(), front: () => frontAppKnown() },
  // The PC's battery and the system power mode (power/index.js picks the OS backend).
  power: require('./power'),
  layersHost,
  layersEdit,
  drawShell,
  // Open windows, for attaching a widget to an app (capabilities/layer-anchor.js).
  windows: () => runWindowsTool(['list'], 8000),
  menu: screenMenu,
  settings: {
    setAiEdgeGlow: (mode) => updateAiEdgeGlowSetting(mode),
    setUsageMode: (mode) => updateUsageModeSetting(mode),
    setScreenAlerts: (on) => updateScreenAlertsSetting(on),
    setDesktopScene: (patch) => updateDesktopSceneSetting(patch),
    desktopScenes: async () => ({ packages: (await _layerCatalog()).scenes, canvases: (hub.settings || {}).ambientScenes, themes: (hub.settings || {}).customThemes }),
  },
  layers: {
    get: () => hub.settings && hub.settings.layers,
    update: (edit) => updateLayersSetting(edit),
    catalog: () => _layerCatalog(),
    shots: async () => (await _menuStore()).shots,
  },
  // The log of games played (game-sessions.js) and its on/off setting.
  sessions: {
    store: () => _gameSessions,
    enabled: () => gameSessionsEnabled(),
    setEnabled: (on) => updateGameSessionsSetting(on),
  },
  // Notifications and Do not disturb (capabilities/notifications.js).
  notifications: {
    get: () => normalizeNotifications(hub.settings && hub.settings.notifications),
    set: (change) => updateNotificationsSetting(change),
  },
  // A Store widget's own options, from the menu (capabilities/widget-option.js).
  widgetOptions: { set: (pkg, option, value) => widgetOptionsStore.set(pkg, option, value), list: () => widgetOptionsStore.list() },
  // kWh from the sensor history (capabilities/energy.js); guardian is defined later.
  energy: { summary: () => guardian.getEnergySummary() },
  // Tap a notification, get its app (notification-open/).
  notificationOpen: createNotificationOpener(notificationOpenDeps({
    platform: process.platform, execFile, getInstalledApps, launchLinuxApp, feed: () => winNotif.getFeed(),
    listWindows: () => runWindowsTool(['list'], 8000), focusWindow: (id) => runWindowsTool(['focus', String(id)], 5000),
  })),
  // What the Game performance tile shows (capabilities/perf-hud.js).
  perfHud: {
    get: () => PerfHud.normalizePerfHud(hub.settings && hub.settings.perfHud),
    set: (change) => updatePerfHudSetting(change),
  },
  // "Why does it stutter?" (capabilities/stutter-why.js): the answer goes to the
  // screens as ids and numbers; each client words it in its language.
  stutter: {
    explain: () => _stutterWatch.explain(),
    onAnswer: (shown) => broadcastSSE('stutter_why', shown),
  },
  // Frame-time benchmarks (benchmark.js): the path stays here, the caller gets a name.
  bench: {
    store: () => _benchmark,
    reveal: (file) => revealInFileManager(file),
  },
  // Screenshots and recordings (captures.js keeps the paths; callers get an id and a name).
  capture: {
    host: _captureHost,
    store: () => _captures,
    covers: () => _captureCovers,
    transcripts: () => _transcripts,
    exports: () => _captureExport,
    send: (id) => sendCaptureToPhone(id),
    copyTo: (id, to) => _captureCopy.copy(id, to),
    recorder: () => _recorder,
    steps: () => _stepsRecorder,
    replay: () => _replay,
    markers: () => _captureMarkers,
    clips: (id, which) => makeMarkClips(id, which),
    onMarker: (m) => broadcastSSE('capture_marker', m),
    bugReport: () => _bugReport,
    game: () => (gameDetect.isGameRunning() ? gameDetect.getGameProcess() : ''),
    mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
    reveal: (file) => revealInFileManager(file),
    onSaved: (e) => broadcastSSE('capture', {
      kind: e.kind, id: e.id, name: e.name, game: e.game, copied: e.copied === true,
      ...(e.folderMissing === true ? { folderMissing: true } : {}),
      // A copy with private data painted over (capabilities/screen-cover.js): how many.
      ...(Number.isInteger(e.covered) && e.covered > 0 ? { covered: e.covered } : {}),
      // The toast's "Pin": only where the shell can draw it on the screen.
      ...(e.kind === 'screenshot' && layersHost.available() ? { pinnable: true } : {}),
      ...(e.kind === 'screenshot' && e.width > 0 && e.height > 0 ? { width: e.width, height: e.height } : {}),
    }),
    onNothingCovered: () => broadcastSSE('capture', { kind: 'cover', covered: 0 }),
    // The line over the area picker, in the language the dashboard shows.
    hint: () => LayerI18n.text('shot_pick_hint', hub.settings && hub.settings.language),
    // Text from the screen (capabilities/screen-text.js): its own picker line,
    // and a toast that says how much was copied, never the text.
    textHint: () => LayerI18n.text('text_pick_hint', hub.settings && hub.settings.language),
    onText: (r) => broadcastSSE('capture', { kind: 'text', lines: r.lines, copied: r.copied === true }),
    // The colour picker and the ruler (capabilities/screen-inspect.js): the
    // toast shows the colour or the size that was copied (not screen content).
    inspectHint: (mode) => LayerI18n.text(mode === 'colour' ? 'color_pick_hint' : 'measure_pick_hint', hub.settings && hub.settings.language),
    onInspect: (r) => broadcastSSE('capture', { kind: r.mode === 'colour' ? 'color' : 'size', text: r.text, copied: r.copied === true }),
    // Drawing on the screen (capabilities/screen-draw.js): the line under its bar.
    drawHint: () => LayerI18n.text('draw_hint', hub.settings && hub.settings.language),
    // Recording options (capabilities/record-options.js).
    options: () => captureOptions(),
    setOptions: (change, folders) => updateCaptureSettings(change, folders),
    pickFolder: (kind) => chooseCaptureFolder(kind),
    // Where a screenshot goes: the folder the user chose, or Pictures/Xenon.
    shotFolder: () => _captureFolder.resolve(captureOptions().shotFolder),
    // The gallery on the dashboards (main.js `gallery_open`; a phone ignores it).
    openGallery: (o) => broadcastSSE('gallery_open', o),
  },
  // Bit's Game Companion card (capabilities/game-companion.js): the dashboards
  // and, with "widgets only", the on-screen alerts window open it (SSE).
  companion: {
    enabled: () => {
      const f = hub.settings && hub.settings.aiFeatures;
      return !!(f && f.enabled === true && f.gameCompanion === true);
    },
    // The session log knows when the game started; without it, the game alone.
    current: () => _gameSessions.current()
      || (gameDetect.isGameRunning() ? { game: gameDetect.getGameProcess() } : null),
    open: (o) => {
      const hs = hub.settings || {};
      if (UsageMode.widgetsOnly(hs.usageMode) && hs.notifications && hs.notifications.onScreen === false) return false;
      broadcastSSE('game_companion', o);
      return true;
    },
  },
  // The functions installed Store widgets offer to keys (capabilities/widget-key.js),
  // with whether the person allowed each one when the widget was installed.
  sdkHandlers: () => _sdkWidgetKeys(),
  // One key at a time for the capabilities that only flip a setting (game mode,
  // the not-a-game list, sensor history), and the Performance Mode key.
  settingKeys: {
    get: (key) => (hub.settings || {})[key],
    update: (key, change) => updateHubSettingKey(key, change),
  },
  game: () => (gameDetect.isGameRunning() ? gameDetect.getGameProcess() : ''),
  handToDashboard: (action) => deckShortcutRunner.handToDashboard(action),
  // Global shortcuts need the Helper (Windows/macOS) or GNOME's keybindings (Linux).
  shortcutsAvailable: () => process.platform === 'linux' || fs.existsSync(HELPER_EXE),
  deck: {
    update: (edit) => updateDeckConfigs(edit),
    status: () => _deckShortcutStatus(),
    configs: () => readDeckConfigs(),
    takenByOthers: () => (_hotkey.bindings || []).filter((b) => !b.keyId)
      .map((b) => DeckShortcuts.normalizeShortcut(b.combo) || String(b.combo || '').toLowerCase()),
    heldBy: (combo, except) => _comboHeldBy(combo, except),
  },
});
const gameDetect = require('./gamedetect');
const audioLevels = require('./audio-levels');
const winNotif = require('./winnotif');
const { lowerPriority } = require('./child-priority');
const { createMountedDisks } = require('./mounted-disks');
const calls = require('./calls');
const wakeWord = require('./wakeword');
const sdkWidgets = require('./sdk-widgets');
const signalrgb = require('./signalrgb');
// Windowed-game detection: the fullscreen heuristic misses borderless/windowed
// titles, so the game detector also gets PresentMon's busiest flip-model
// presenter as a hint — when it matches the focused window, that's a game.
gameDetect.setGameHint(() => fpsMonitor.getGamingProcess());
gameDetect.setIgnoreSource(() => hub.settings && hub.settings.gameIgnore);
// …and the other way: PresentMon sees every presenter on the machine, so it asks
// which window is in front before deciding which one is the game. Wired here
// rather than by requiring across, because these two modules already read each
// other and a require cycle is how that ends badly.
try { fpsMonitor.setForegroundPid(() => gameDetect.getForegroundPid()); } catch { /* platform without one */ }
// …and which game it found, whose frames count even when Windows composes them.
try {
  fpsMonitor.setTrackedGame(() => {
    const { gamePid, gameProc } = gameDetect.getGameDiag();
    return { pid: gamePid, name: gameProc };
  });
} catch { /* platform without one */ }
const lighting = require('./lighting');
require('./session-watch');
const deckStore = require('./js/deck-store'); // pure per-instance Deck merge helpers (shared with the client + tests)
const vitalsAiTools = require('./vitals/vitals-ai-tools'); // Bit reads, refills and pauses Vitals (get_vitals, refill_vital, set_vitals)
require('./js/custom-bg'); // single owner of the bg image-asset + frame-cap rules (shared with the client + sandbox); nothing is taken from it here, but it runs code when it loads
require('./js/slideshow-widget'); // single owner of the slideshow image rules (shared with the client); nothing is taken from it here, but it runs code when it loads
require('./slideshow-folder');          // the slideshow's "folder on this PC" source
require('./filesearch');           // local file search (Spotlight backend)
const { createDiskSpace } = require('./diskspace');
const { createDevClean } = require('./devclean');
const featureRoutes = require('./feature-routes.js');           // the routes added since this file stopped growing
const { createFeatureUnlock } = require('./feature-unlock');
const { createTrialPass } = require('./trial-pass');
const { createTrialVault } = require('./trial-vault');
require('./mdfind');                 // macOS catalog (Spotlight) for search             // disk usage scan + guarded recycle-bin cleanup (helper-gated)
const fileTransferLib = require('./file-transfer');             // phone ↔ PC file transfer: the store, the naming rules, the delivery copy
require('./living-index');       // the Living Index: helper-held in-RAM file index + watchers
require('./phone');                    // the paired phone: phonebook + call log over Bluetooth, call state, dial
require('./linux-index');         // the same surface in plain Node, for the platform with no helper
const { createLinuxTrash } = require('./linux-trash');         // the recycle-bin delete, via the freedesktop trash spec
require('./js/content-installs'); // validated import receipts shared with Settings
const { createFirstReading, createFactReader } = require('./system/first-reading');
const SensorSources = require('./js/sensor-sources.js'); // which sensor feeds each headline reading (shared with Settings + tests)
require('./js/game-ignore.js'); // the user's "not a game" list (shared with Settings + tests)
require('./js/sensor-history.js'); // the sensor-history setting (shared with Settings)
require('./sensor-source-ai.js'); // Bit picks one (sensor_source)
require('./js/ambient-scene.js'); // the Ambient scene store limits (shared with the import); nothing is taken from it here, but it runs code when it loads
require('./js/topbar-look.js'); // the top bar's look, one set of rules (shared with the client + tests)
const LayersModel = require('./js/layers-model.js'); // widgets on the desktop / overlay / anchored (shared with the client + tests)
const LayerI18n = require('./layer-strings.js'); // one language for the light layer page
require('./layer-page.js'); // the light layer page plus its tiles' files; nothing is taken from it here, but it loads js/layer-tiles.js, which runs code when it loads
const assetVersion = require('./asset-version.js'); // a version on every page's CSS/JS URLs
const { seedReadings } = require('./sse-seed.js'); // what a new feed client starts from
const UsageMode = require('./js/usage-mode.js'); // dashboard / widgets only / both (shared with the client)
const PerfHud = require('./js/perf-hud.js'); // what the Game performance tile shows (shared with the client)
const ScreenSceneModel = require('./js/screen-scene-model.js'); // wallpaper + saver settings (shared with the client)
require('./js/theme-palette.js'); // single owner of the semantic-palette rules (shared with the client + tests)
const SdkDiagnostics = require('./js/sdk-diagnostics.js'); // what the widget sandbox refuses, for a widget's author (shared with the client + tests)
const aiLocal = require('./ai-local');
const aiOpenai = require('./ai-openai');
const aiLocalServer = require('./ai-local-server');
const aiAnthropic = require('./ai-anthropic');
const aiXenon = require('./ai-xenon-credits');
const welcomeSparks = require('./welcome-sparks');
require('./ai-creation-labels'); // nothing is taken from it here, but deck/tools.js asks for it inside a function and would read it from disk then
const aiTurns = require('./ai-turns');
const aiMyWidgets = require('./ai-my-widgets');
const aiCli = require('./ai-cli');   // Claude Code / Codex: the user's own subscription
const aiGemini = require('./ai-gemini');
const { withThinking, applyThinking } = require('./ai-gemini-thinking');
const { aiLangName } = require('./ai/prompt-language.js');
const aiModels = require('./ai-models');
require('./ai-provider-creds'); // nothing is taken from it here, but it loads js/settings-secrets.js, which runs code when it loads
const { createGuardian } = require('./system/guardian');
require('./battery');
require('./ai-memory');
const { createAiActionLog } = require('./ai-action-log');
const aiLive = require('./ai-live');
require('./briefing');
require('./time/ics-feeds.js');
// isBlockedOpenPath is the Deck's openFile gate. It is re-applied by every
// surface that opens a file the user did not type the path of: the Spotlight
// results, and the transfer widget's received files.
const { createRegistry, resolveOutputDevice, pickToggleDevice, pickFirstConnected } = require('./actions/registry');
require('./actions/perf-registry');
require('./perf-session');
require('./perf-session/shield-wish');
require('./actions/streamerbot');
require('./actions/home-assistant');
require('./actions/home-assistant-query');
require('./actions/chroma');
require('./actions/wavelink');
require('./actions/voicemeeter');
require('./embedded-browser');
require('./embedded-browser-adblock');
const { createBrowserSurfaceSync } = require('./browser-surface-sync');
require('./second-screen');
require('./screen-capture');
require('./stream-creds'); // nothing is taken from it here, but it loads js/settings-secrets.js, which runs code when it loads
require('./actions/unifi');
require('./smart-home/unifi-events');
require('./stocks-creds'); // nothing is taken from it here, but it loads js/settings-secrets.js, which runs code when it loads
require('./football-creds'); // nothing is taken from it here, but it loads js/settings-secrets.js, which runs code when it loads
require('./news-creds'); // nothing is taken from it here, but it loads js/settings-secrets.js, which runs code when it loads
const claudeUsage = require('./claude-usage');
const claudeBridge = require('./claude-bridge');
const claudeInbox = require('./claude-inbox');
const claudeSessions = require('./claude-sessions');
const claudeLink = require('./claude-link');
const claudeRun = require('./claude-run');
const claudeTranscript = require('./claude-transcript');
require('./claude-subagent.js'); // nothing is taken from it here, but it runs code when it loads
const claudeHistory = require('./claude-history');
const claudeCommands = require('./claude-commands');
const claudeAttach = require('./claude-attach');
const codexAppServer = require('./codex-appserver');
const codexBridge = require('./codex/codex-bridge');
const codexLink = require('./codex-link');
const chatgptAsk = require('./codex/chatgpt-ask');
const communityCatalog = require('./community-catalog');
require('./community-messages'); // nothing is taken from it here, but it loads net-guard.js, which runs code when it loads
require('./community-installs'); // nothing is taken from it here, but it loads net-guard.js, which runs code when it loads
const supporterRedeem = require('./supporter-redeem');
const widgetAutoUpdateLib = require('./widget-auto-update');   // Store widgets that update themselves (see its header)
const presetCodec = require('./js/preset-share');   // decodePreset/peekLocked, shared with the client; the auto-updater reads a catalog code with them
const aiPresets = require('./ai-presets');          // the assistant's create_preset / preset_reference tools
const aiPictures = require('./ai-attached-pictures');  // pictures attached in the chat, placed inside creations
const aiSurface = require('./ai-surface');  // Bit on the main screen with no dashboard (widgets only)
const AiToolGroups = require('./ai-tool-groups'); // Bit's tools: a core + groups on demand (use_tools)
const aiTurnRecord = require('./ai-turn-record');  // what Bit really did in a reply, kept in the chat history
const aiDeckRun = require('./ai-deck-run');  // Bit presses a Deck action (run_deck_action)
const _deckConfirms = aiDeckRun.createConfirmStore();
const perfScreen = require('./perf-screen');  // Performance Mode with no dashboard (widgets only)
require('./alerts/screen-alerts-page'); // the alerts window, with Bit's voice panel; nothing is taken from it here, but it loads js/layer-tiles.js, which runs code when it loads
require('./ambient/scene-page'); // the desktop scene: wallpaper and screensaver; nothing is taken from it here, but it loads js/layer-tiles.js, which runs code when it loads
require('./version-ping'); // nothing is taken from it here, but it loads net-guard.js, which runs code when it loads
const usageStats = require('./usage-stats');  // anonymous feature counts, off unless usageStats is on
require('./icon-packs');
require('./sound-packs');
require('./community-ratings');
require('./community-limited'); // nothing is taken from it here, but it loads net-guard.js, which runs code when it loads
require('./remote-control');
// Paired-device access (R1.1). Named `remoteAccess` throughout to keep it apart
// from `remoteControl` above, which is the Sunshine/Moonlight streaming feature
// and shares nothing with it but a word.
const remoteAccessLib = require('./remote-access');
const webPushLib = require('./web-push');
const remoteHttpsLib = require('./remote-https');
const remoteHttpsSetupLib = require('./remote-https-setup');
const { runGuarded } = require('./http/request-boundary.js');
const remoteControlTailscale = require('./remote-control/tailscale');
const remoteControlInstaller = require('./remote-control/installer');
const { createSelfUpdate } = require('./self-update');
require('./install/startup-task');
const { normalizeMediaSeekResult } = require('./media-seek-result');
const lyrics = require('./lyrics');
const { createLyricsCache } = require('./lyrics-cache');
const { createLyricsOffsets } = require('./lyrics-offsets');
const { createLyricsTranslator } = require('./lyrics-translator');
const { createSdkAi } = require('./sdk-ai');
const { createRoastSparks } = require('./vitals-roast-sparks.js');
require('./bit-messages.js');
require('./rating-votes.js');
require('./pc-id.js');
require('./mcp/mcp-dev');        // Claude Code / Codex building widgets: pairing + dashboard questions
const mcpDevTools = require('./mcp/mcp-dev-tools');      // ...and what each of their tools does

const { APP_VERSION } = require('./updates/app-version.js');

const { PORT } = require('./engine/port.js');
aiCli.configure({ port: PORT });   // where the Claude Code / Codex MCP bridge reaches Xenon's tools

// Node.js without current security fixes (node-version.js): said once at
// startup, where the log and the bug report see it. The installer upgrades it.
try { const w = require('./node-version').nodeWarning(); if (w) console.warn(w); } catch { /* never block startup on this */ }

const { AUTO_UPDATE_ASSUME_IDLE } = require('./updates/check-values.js');
const autoUpdateLib = require('./auto-update');
const { nextSettingsRev } = require('./settings-rev');   // shared by every settings writer

const { checkLatestRelease } = require('./updates/latest-release.js');


const { loadWhatsNew } = require('./updates/whats-new-read.js');

const { audioCache } = require('./audio/device-cache.js');

require('./ai/gemini-model-for.js');

const { AI_MODELS } = require('./ai/models.js');

const { pcAiFunctions } = require('./ai/core-tools-pc.js');

const { lookupAiFunctions } = require('./ai/core-tools-lookup.js');

const { plannerAiFunctions } = require('./ai/core-tools-planner.js');

const { dashboardAiFunctions } = require('./ai/core-tools-dashboard.js');

const { lightingAiFunctions } = require('./ai/core-tools-lighting.js');

const { appearanceAiFunctions } = require('./ai/core-tools-appearance.js');

const { deckCreatorAiFunctions } = require('./ai/core-tools-deck-creator.js');

function knowledgeAiFunctions() {
  return [
        // ── App knowledge (grounding, read-only) ──
        { name: 'xenon_knowledge', description: 'Read-only: your OWN documentation about Xenon itself. Call this BEFORE answering any question about how Xenon works, its setup, features, requirements, or troubleshooting, e.g. why sensors/fans read empty, how updates or the marketplace work, what supporter codes are, how to publish content, privacy, integrations setup. Pass the user\'s question (or a topic id) as query; call with no query to list all topic ids. Base your answer on the returned card and answer in the user\'s language.', parameters: { type: 'OBJECT', properties: {
          query: { type: 'STRING', description: 'The user\'s question in a few words, or a topic id (e.g. "sensors", "marketplace", "troubleshooting"). Omit to list all topics.' },
        } } },
        { name: 'sdk_reference', description: 'Read-only: the Widget SDK reference, the EXACT data streams and action categories a widget may request (from the code, always current) plus the full SDK docs by section (bridge protocol, manifest fields, storage, secrets, fetch proxy, ambient scenes…). Call this BEFORE create_widget to ground the manifest and the postMessage protocol, and when the user asks how to develop a widget. No section → enums + section list; then call again with a section id for its full text.', parameters: { type: 'OBJECT', properties: {
          section: { type: 'STRING', description: 'Optional docs section id or title fragment, e.g. "manifest-json", "data", "persistent-storage", "secrets".' },
        } } },
        // ── Single-screen capabilities (js/capability-catalog.js), only those
        //    this machine can actually do ──
        ...capabilities.aiFunctions(capabilityRunner.probes()),
        // ── Vitals and Bit the pet (vitals-ai-tools.js) ──
        ...vitalsAiTools.FUNCTIONS,
  ];
}

// Core Xenon AI function declarations — the always-available tools (dashboard,
// media, audio, system, timers, notes/tasks/calendar, lighting, deck, memory,
// stocks/football/news, web/vision). Hoisted so BOTH the /api/ai turn-based
// handler (which appends integration-conditional tools) and the realtime Voce
// Live endpoint share one identical, drift-free source. Returns a fresh array
// each call so callers can push without mutating a shared const.
function buildCoreAiFunctions() {
  return [
    ...pcAiFunctions(),
    ...lookupAiFunctions(),
    ...plannerAiFunctions(),
    ...dashboardAiFunctions(),
    ...lightingAiFunctions(),
    ...appearanceAiFunctions(),
    ...deckCreatorAiFunctions(),
    ...knowledgeAiFunctions(),
  ];
}

const { buildMemoryFunctions } = require('./ai/memory-functions.js');

const { MEDIA_SCRIPT } = require('./media/script-paths.js');
const { HELPER_EXE } = require('./engine/paths.js');
const { MEDIAREMOTE_DIR } = require('./media/script-paths.js');
const { ENABLE_SENSORS_SCRIPT } = require('./system/script-paths.js');
require('./sensor-service/engine-reader.js');
const {
  DECK_ACTIONS_SCRIPT, DECK_HOTKEY_SCRIPT, DECK_WINDOW_SCRIPT,
} = require('./deck/script-paths.js');
const { PROCESSES_SCRIPT } = require('./performance/script-paths.js');
require('./performance/script-paths.js');
const { VITALS_NAG_SCRIPT } = require('./vitals/script-paths.js');
// How Bit's PC-side actions happen on this OS (vitals-nag.js): the Windows popup
// script, the Xenon app's alerts window (SSE `vitals_nag`) or a system banner.
const vitalsNag = require('./vitals/vitals-nag').createVitalsNag({
  collectors: nativeCollectors,
  spawnScript: process.platform === 'win32' ? (args) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', VITALS_NAG_SCRIPT, ...args], { windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } : null,
  host: layersHost,
  broadcast: (popup) => broadcastSSE('vitals_nag', popup),
});
const { DATA_DIR } = require('./engine/paths.js');
// Disk-back the community catalog cache so the Store opens instantly (and offline)
// right after a server restart, instead of re-blocking on the upstream fetch and
// erroring when the site is momentarily unreachable. Read is tolerant of an absent
// file; the writable dir is ensured by migrateLegacyData() before any fetch writes.
communityCatalog.initCache({ dataDir: DATA_DIR, appVersion: APP_VERSION });
// Last-known model lists, so the first AI turn after a restart resolves against
// what the providers actually offer instead of the built-in offline defaults.
aiModels.initCache({ dataDir: DATA_DIR });
// Song lyrics already fetched from LRCLIB (and the songs it has none for), so a
// replay is instant and offline. Loaded lazily on the first lookup.
const lyricsCache = createLyricsCache({ dataDir: DATA_DIR });
// Supporter Lyrics widget: per-song timing, and translations paid for once.
const lyricsOffsets = createLyricsOffsets({ dataDir: DATA_DIR });
const { hub } = require('./settings/current.js');

const lyricsTranslator = createLyricsTranslator({
  dataDir: DATA_DIR,
  complete: (req) => completeWithUserAi({ ...req, json: true, temperature: 0.2, use: 'lyrics' }),
  // The provider's own message (no lyrics, no key): enough to tell a bad key from a bad reply.
  onError: (e) => console.warn('[lyrics] translation failed:', String((e && e.message) || e).slice(0, 200)),
});
// Widget SDK `ai`: a granted widget's questions to the same AI, under the
// user's daily number per widget. Never logs a question or an answer.
const sdkAi = createSdkAi({
  dataDir: DATA_DIR,
  complete: (req) => completeWithUserAi({ ...req, use: 'widget' }),
  blocker: () => userAiBlocker(),
  onError: (e) => console.warn('[sdk-ai] question failed:', String((e && e.message) || e).slice(0, 200)),
});
// Bit's AI roasts on Sparks, under the daily Sparks the user allowed.
const roastSparks = createRoastSparks({ dataDir: DATA_DIR });
const { bitMessages } = require('./ai/engine-bit-messages.js');
const { BIT_MESSAGE_BODY_MAX, LIVE_MAX_SESSION_MS } = require('./ai/limits.js');

const { ratingVotes } = require('./store-catalog/engine-rating-votes.js');
supporterRedeem.useRatingVotes(ratingVotes);
const BIT_MESSAGE_ROUTES = {
  '/bit/messages/file': (body) => bitMessages.post(body),
  '/bit/messages/import': (body) => bitMessages.importLetters(body),
  '/bit/messages/shown': (body) => bitMessages.shown(body.id),
  '/bit/messages/read': (body) => bitMessages.read(body.id, body.answer),
};
const { mcpDev } = require('./mcp/engine-dev.js');
const { MCP_BRIDGE_PATH } = require('./engine/paths.js');
require('./deck/pack-places.js');
const { _spotlightPopupPids } = require('./search/spotlight-state.js');

const { livingIndex } = require('./search/living-index-engine.js');
const { runPowerShellScript } = require('./powershell/run-command.js');

const { openExternalPath } = require('./deck/open-external-path.js');

require('./search/launch-installed-app.js');

const { fileSearch } = require('./search/engine-file-search.js');
const {
  _hotkey, MAX_HOTKEY_BINDINGS, HOTKEY_RETRY_MS, HOTKEY_RETRY_MAX_MS, _stopHotkeyListener,
} = require('./deck/hotkey-state.js');

// The keys placed widgets show or hide with (widget-keys.js). What they hide
// leaves with the rules' answer in the status, pushed at once.
const _widgetKeys = createWidgetKeys({
  layers: () => hub.settings && hub.settings.layers,
  onChange: () => broadcastStatusNow(),
});
function _hotkeyBindings() {
  const cfg = (hub.settings && hub.settings.searchSettings) || {};
  const out = [];
  if (cfg.hotkeyEnabled === true) {
    out.push({ slot: 'spotlight', combo: String(cfg.hotkeyCombo || 'alt+space') });
  }
  const pages = Array.isArray(hub.settings && hub.settings.pageHotkeys)
    ? hub.settings.pageHotkeys : [];
  pages.forEach((b, i) => {
    if (out.length >= MAX_HOTKEY_BINDINGS) return;
    out.push({ slot: 'page-' + i, combo: String(b.combo || ''), target: String(b.target || '') });
  });
  // The Deck keys' shortcuts come last: they never push a search or page
  // shortcut out of the table, and one on the same combo is refused.
  const base = out.filter((b) => b.combo);
  const table = base.concat(DeckShortcuts.planBindings(base, shortcutState.found.list, MAX_HOTKEY_BINDINGS).bindings);
  // The widgets' keys next, by the same rule: never on a combo already taken.
  table.push(..._widgetKeys.bindings(table.map((b) => b.combo), MAX_HOTKEY_BINDINGS - table.length));
  // The overlay's ready-made shortcut goes last, so a combo the user chose
  // always wins over it, and only while a widget is in the overlay.
  const overlay = _overlayHotkey();
  if (overlay && table.length < MAX_HOTKEY_BINDINGS && !table.some((b) => b.combo === overlay)) {
    table.push({ slot: 'overlay', combo: overlay });
  }
  // Instant Replay's save shortcut, by the same rule: only while the replay is on.
  const replay = _replayHotkey();
  if (replay && table.length < MAX_HOTKEY_BINDINGS && !table.some((b) => b.combo === replay)) {
    table.push({ slot: 'replay', combo: replay });
  }
  // The Xenon menu's, by the same rule: only while a shell can draw the menu.
  const menu = _menuHotkey();
  if (menu && table.length < MAX_HOTKEY_BINDINGS && !table.some((b) => b.combo === menu)) {
    table.push({ slot: 'menu', combo: menu });
  }
  return table;
}

// The Xenon menu's combo, or '' while no native shell can draw the menu over
// the screen (screen-menu.js) or the user turned the shortcut off.
function _menuHotkey() {
  const layers = LayersModel.normalize(hub.settings && hub.settings.layers);
  if (layers.menuKey === 'off' || !screenMenu.available()) return '';
  return DeckShortcuts.normalizeShortcut(layers.menuKey);
}

// A press of the replay shortcut. A failure (no game in front, still starting,
// disk full) is said on screen like a Deck key's shortcut, never swallowed.
function _pressReplayHotkey() {
  capabilityRunner.run({ type: 'replay', mode: 'save' })
    .then((r) => { if (!r || !r.ok) broadcastSSE('deck_shortcut_failed', { title: 'Instant Replay', error: (r && r.error) || 'failed' }); })
    .catch(() => broadcastSSE('deck_shortcut_failed', { title: 'Instant Replay', error: 'failed' }));
}

const { shortcutState } = require('./deck/shortcut-state.js');
function _refreshDeckShortcuts(configs) {
  const next = DeckShortcuts.collectShortcuts(configs);
  const sig = (s) => s.list.map((x) => x.keyId + '=' + x.combo).join('|');
  const changed = sig(next) !== sig(shortcutState.found);
  shortcutState.found = next;
  if (changed && hub.settings) { try { refreshHotkeyListener(); } catch { /* the next save retries */ } }
}

const { routePageHotkey, saysOverExclusive } = require('./deck/hotkey-routes.js');

function routeHotkeyIndex(index) {
  const binding = _hotkey.bindings[index];
  if (!binding) return;
  if (binding.slot === 'spotlight') { if (!saysOverExclusive()) routeSpotlightHotkey(); }
  else if (binding.slot === 'overlay') capabilityRunner.run({ type: 'layersToggle', mode: 'toggle', surface: 'overlay' }).catch(() => {});
  else if (binding.slot === 'replay') _pressReplayHotkey();
  else if (binding.slot === 'menu') { if (screenMenu.get().open || !saysOverExclusive()) screenMenu.toggle(); }
  else if (binding.keyId) deckShortcutRunner.press(binding.keyId, binding.combo).catch(() => {});
  else if (binding.widgetId) _widgetKeys.press(binding.widgetId);
  else routePageHotkey(binding);
}

// The keys of a press let go (Xenon Helper's `release`): a widget held into view goes.
function routeHotkeyRelease(index) {
  const binding = _hotkey.bindings[index];
  if (binding && binding.widgetId) _widgetKeys.release(binding.widgetId);
}

function _scheduleHotkeyRetry(ms) {
  if (shortcutState.retryTimer) return;   // cancelled in _gracefulShutdown
  const pause = Math.min(HOTKEY_RETRY_MS * (2 ** _hotkey.failures), HOTKEY_RETRY_MAX_MS);
  shortcutState.retryTimer = setTimeout(() => {
    shortcutState.retryTimer = null;
    try { refreshHotkeyListener(); } catch { /* next save will retry */ }
  }, Math.max(1000, ms || pause));
  shortcutState.retryTimer.unref();
}
const { _cancelHotkeyRetry } = require('./deck/hotkey-retry-cancel.js');

const { _linuxHotkey } = require('./deck/engine-linux-hotkey.js');

const { refreshLinuxHotkey } = require('./deck/linux-hotkey-refresh.js');

function refreshHotkeyListener() {
  const cfg = (hub.settings && hub.settings.searchSettings) || {};
  const bindings = _hotkeyBindings();
  const combos = bindings.map((b) => b.combo);
  const want = bindings.length > 0;
  const spotlightWanted = cfg.hotkeyEnabled === true;
  const combo = String(cfg.hotkeyCombo || 'alt+space');
  // Set BEFORE dispatching: both paths read it to resolve a press, and the
  // Linux one derives each slot's route from the index into this table.
  const changed = combos.join('\u0000') !== _hotkey.combos;
  if (changed) _hotkey.failures = 0;
  _hotkey.bindings = bindings;
  _hotkey.combos = combos.join('\u0000');
  if (_linuxHotkey) {
    // A desktop shortcut runs a command on the press only: no release to wait for.
    _widgetKeys.setRelease(false);
    refreshLinuxHotkey(spotlightWanted, combo, bindings.filter((b) => b.slot !== 'spotlight'));
    return;
  }
  if (!want) { _cancelHotkeyRetry(); _stopHotkeyListener(); _hotkey.state = 'off'; _hotkey.slots = {}; return; }
  if (_hotkey.proc && !changed) return;   // already right
  _stopHotkeyListener();
  _widgetKeys.setRelease(false);
  let helperOk = false;
  try { helperOk = fs.existsSync(HELPER_EXE); } catch {}
  if (!helperOk) { _hotkey.state = 'helper_missing'; return; }
  // Fast-fail backoff. The state MUST be corrected here: this path can be
  // reached right after stopping a listener that was running (the user changed
  // the combo inside the window), and leaving 'listening' behind made Settings
  // claim the shortcut was active while nothing was registered.
  const sinceDeath = Date.now() - _hotkey.diedAt;
  if (sinceDeath < HOTKEY_RETRY_MS) {
    _hotkey.state = 'retrying';
    _scheduleHotkeyRetry(HOTKEY_RETRY_MS - sinceDeath);
    return;
  }
  let proc;
  try { proc = spawn(HELPER_EXE, ['hotkey-serve', ...combos], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch { _hotkey.state = 'error'; _hotkey.diedAt = Date.now(); _hotkey.failures++; _scheduleHotkeyRetry(); return; }
  _hotkey.proc = proc;
  _hotkey.combo = combo;
  _hotkey.state = 'starting';
  // Assume the worst per slot until the helper says otherwise: `ready` names
  // the indices it holds, and anything it did not name stays 'taken'. A helper
  // too old to name any of them reports a bare `ready`, which is exactly the
  // single-combo case — so only slot 0 is claimed and the rest read as taken,
  // which is what they in fact are on that binary.
  _hotkey.slots = {};
  for (const b of bindings) _hotkey.slots[b.slot] = 'starting';
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      // An older helper sends no index at all, for the one combo it took.
      const at = Number.isInteger(ev.index) ? ev.index : 0;
      const slot = bindings[at] && bindings[at].slot;
      if (ev.event === 'ready') {
        _hotkey.state = 'listening';
        _hotkey.failures = 0;
        // A helper that reports the keys let go says so here; an older one never will.
        _widgetKeys.setRelease(ev.release === true);
        const held = Array.isArray(ev.registered) ? ev.registered : [0];
        for (const b of bindings) _hotkey.slots[b.slot] = 'taken';
        for (const i of held) {
          if (bindings[i]) _hotkey.slots[bindings[i].slot] = 'listening';
        }
        // The old single-combo state field tracks the Spotlight slot, which is
        // what Settings' search row has always shown.
        if (_hotkey.slots.spotlight && _hotkey.slots.spotlight !== 'listening') {
          _hotkey.state = _hotkey.slots.spotlight;
        }
      } else if (ev.event === 'hotkey') {
        try { routeHotkeyIndex(at); } catch {}
      } else if (ev.event === 'release') {
        try { routeHotkeyRelease(at); } catch {}
      } else if (ev.event === 'error') {
        const state = ev.error === 'hotkey_taken' ? 'taken' : 'error';
        if (slot) _hotkey.slots[slot] = state;
        // Only the Spotlight combo moves the legacy field; a page shortcut
        // somebody else owns is not the search shortcut failing.
        if (!slot || slot === 'spotlight') _hotkey.state = state;
      }
    }
  });
  proc.on('error', () => {
    if (_hotkey.proc !== proc) return;
    _hotkey.proc = null; _hotkey.state = 'error'; _hotkey.diedAt = Date.now();
    _hotkey.failures++;
    _scheduleHotkeyRetry();
  });
  proc.on('exit', () => {
    if (_hotkey.proc !== proc) return;
    _hotkey.proc = null;
    _widgetKeys.setRelease(false);
    if (_hotkey.state === 'listening' || _hotkey.state === 'starting') _hotkey.state = 'error';
    _hotkey.diedAt = Date.now();
    _hotkey.failures++;
    // 'taken' means another app owns the combo: that app can close, so looking
    // again is right, but it can also stay for days and each look is a process.
    _scheduleHotkeyRetry();
  });
  proc.unref();
}

let _macFdaTimer = null;

const { usableIndexRoots } = require('./search/index-roots.js');

const { volumeDetailsProbe, diskModelsProbe, getDiskDetails } = require('./disk/drive-details.js');

const { SETTINGS_FILE } = require('./settings/settings-file.js');

const { DEFAULT_HUB_SETTINGS } = require('./settings/defaults.js');

const { normalizeLockWidgets } = require('./settings/normalize-lock-widgets.js');

const { readHubSettings, readHubSettingsForUpdate } = require('./settings/read.js');

const { cliOneShot } = require('./ai/cli-one-shot.js');

// Disk space (helper-gated, like the Second screen). Scans stream from the
// helper's disk-scan; deletion is recycle-bin-only through shell-delete after
// the guard re-checks every resolved path. Settings feed the category rules
// (dev folders, installer age); the scan child is stopped in _gracefulShutdown.
const diskSpace = createDiskSpace({
  dataDir: DATA_DIR,
  helperExe: HELPER_EXE,
  livingIndex,
  // The recycle-bin delete. Windows and macOS use the helper's `shell-delete`;
  // Linux has no helper, so cleanup was analysable but not actionable — the
  // widget could show 700 MB of installers and then refuse to remove one.
  // `gio trash` is the same promise (reversible, visible in the user's own
  // Trash) through the freedesktop spec.
  shellDelete: process.platform === 'linux' ? createLinuxTrash() : undefined,
  getIndexRoots: async () => {
    const s = await readHubSettings();
    // Through the same resolver the index uses. The widget picks a root by its
    // POSITION in this list, so handing it the raw saved array while the index
    // walked a different one meant the map was drawn for a disk nobody was
    // indexing — on this machine, the literal string "C:\".
    return usableIndexRoots(s && s.searchSettings && s.searchSettings.indexRoots);
  },
  // Reuse the system tile's ten-minute volume cache: the disk widget gets
  // friendly labels/models without adding another recurring PowerShell probe.
  getDriveDetails: () => getDiskDetails(),
  // Off Windows there are no drive letters to probe, so the volumes the widget
  // can offer as index roots come from the same collector the disks tile reads
  // (`/` plus /Volumes on macOS, real mounts on Linux). One enumeration, one
  // set of labels.
  getVolumes: nativeCollectors ? () => getAllDisksInfo() : null,
  appRoot: path.join(__dirname, '..'),
  getSettings: async () => {
    const s = await readHubSettings();
    const d = (s && s.diskSettings) || {};
    return { devFolders: d.devFolders, installerAgeDays: d.installerAgeDays };
  },
  // A cleanup runs as a background job; push its progress to the dashboard over
  // SSE so the widget shows real advancement and can re-attach after a reload.
  onCleanProgress: (snapshot) => { try { broadcastSSE('disk_clean', snapshot || {}); } catch {} },
  // A cached overview learned something after it was answered (the background
  // duplicate check finished): the widget refetches the drive it names.
  onDiskUpdate: (info) => { try { broadcastSSE('disk_update', info || {}); } catch {} },
  revealExternal: (p, dir) => revealInFileManager(p, dir),
});
const {
  SDK_WIDGETS_DIR, WIDGET_ORIGINS_FILE, SDK_ASSETS_DIR,
} = require('./widget-sdk/data-places.js');

const {
  WIDGET_AUTO_UPDATE_STATE_PATH, SDK_STAGING_DIR,
} = require('./widget-sdk/auto-update-places.js');

// Dev cleanup (supporter-only): Docker, Ollama models, stale editor workspace
// storage, WSL/Docker virtual disks. Every route checks featureUnlock first.
// Editor folders go through the Disk widget's guarded Recycle-Bin delete; the
// .vhdx compaction is compact-vhdx.ps1, which raises its own UAC prompt.
// The 7-day pass trial (trial-pass.js): the hub's word on it, kept in DATA_DIR.
// supporter-redeem uses it for an empty-code redeem and remembers an accepted XT.
const trialPass = createTrialPass({ dataDir: DATA_DIR, onCheck: () => { trialVault.sync().catch(() => {}); } });
supporterRedeem.useTrialPass(trialPass);
// Widgets and scenes opened with the trial: ciphertext on disk, packages in
// memory, served only while the trial runs (trial-vault.js).
const trialVault = createTrialVault({
  dataDir: DATA_DIR,
  trialPass,
  redeem: (opts) => supporterRedeem.redeem({ ...opts, dataDir: DATA_DIR }),
  installPayload: (payload, catalogVersion) => installWidgetPayload(payload, 'import', catalogVersion),
  onChange: () => { refreshSdkScan().catch(() => {}); },
});
const featureUnlock = createFeatureUnlock({ dataDir: DATA_DIR, trialPass });
const { execFilePromise } = require('./programs/exec-file-promise.js');

const devClean = createDevClean({
  run: execFilePromise,
  getSettings: () => readHubSettings(),
  trash: (root, paths) => diskSpace.trashUnder(root, paths),
  scriptPath: path.join(__dirname, 'compact-vhdx.ps1'),
  spawnDetached: (exe, args) => { spawn(exe, args, { windowsHide: true, stdio: 'ignore' }).unref(); },
  onProgress: (info) => { try { broadcastSSE('devclean', info || {}); } catch {} },
});
const { iconPackStore, soundPackStore } = require('./deck/pack-stores.js');
const { _deckPopupPids } = require('./deck/popup-pids.js');

const { routeSpotlightHotkey } = require('./search/spotlight-window.js');

const { openDeckPopupWindow } = require('./deck/popup-window.js');
const { NOTES_FILE, EVENTS_FILE, TASKS_FILE, TIMERS_FILE } = require('./time/store-files.js');
const { notesToText, textToNotesState } = require('./time/notes-state.js');
const { aiMemory } = require('./ai/memory-store.js');
// Recent AI state-mutating actions, so the user can undo a regrettable one (notes
// overwrite, bulk clear, a just-created item). In-memory only (short-term undo).
const aiActionLog = createAiActionLog();

const { liveVoice } = require('./ai/live-voice-state.js');
const { liveNow } = require('./ai/live-session-state.js');

// Apply the undo descriptor recorded for an AI action. Returns { ok, refresh }
// where `refresh` is the client action the caller should trigger to re-render.
async function performAiUndo(entry) {
  if (!entry || !entry.undo || entry.undone) return { ok: false, error: 'not_undoable' };
  const u = entry.undo;
  try {
    if (u.kind === 'restore_notes') {
      // prev is a full notes state (current) or a legacy text blob (older entry).
      await writeNotes(u.prev && typeof u.prev === 'object' ? u.prev : textToNotesState(String(u.prev || '')));
      return { ok: true, refresh: 'refresh_notes' };
    }
    if (u.kind === 'delete_task') {
      await updateTasks((tasks) => ({ next: tasks.filter((t) => t.id !== u.id) }));
      return { ok: true, refresh: 'refresh_tasks' };
    }
    if (u.kind === 'restore_tasks') {
      await writeTasks(Array.isArray(u.prev) ? u.prev : []);
      return { ok: true, refresh: 'refresh_tasks' };
    }
    if (u.kind === 'restore_events') {
      await writeEvents(Array.isArray(u.prev) ? u.prev : []);
      return { ok: true, refresh: 'refresh_calendar' };
    }
    return { ok: false, error: 'unknown_undo' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
const { DECK_FILE } = require('./deck/deck-file.js');
const {
  STREAM_CONFIG_FILE, STREAM_TOKENS_FILE, _readStreamTokensSnapshot,
} = require('./streaming/config-files.js');
const { UPLOADS_DIR } = require('./engine/uploads-dir.js');

const { sdkScan } = require('./widget-sdk/scan-state.js');
async function sdkPackagesCached() {
  // Long TTL on purpose: installs and Rescan both go through refreshSdkScan(),
  // and a widget's hot paths (fetch/hook/macro) only run for a package that was
  // already scanned to mount it — so this fallback re-read almost never fires,
  // and a busy hook source can't turn it into a per-event disk rescan.
  if (Date.now() - sdkScan.cache.at < 30000) return sdkScan.cache;
  return refreshSdkScan();
}
async function refreshSdkScan() {
  const scan = await sdkWidgets.listPackages(SDK_WIDGETS_DIR);
  // Trial packages join the list while the trial runs; an installed copy wins.
  const onDisk = new Set(scan.packages.map((p) => p.id));
  const trial = (await trialVault.packages().catch(() => []))
    .filter((m) => !onDisk.has(m.id)).map((m) => ({ ...m, trial: true }));
  sdkScan.cache = { at: Date.now(), packages: scan.packages.concat(trial), invalid: scan.invalid, skipped: scan.skipped || 0 };
  return sdkScan.cache;
}

const { _widgetOrigins } = require('./widget-sdk/widget-origins.js');
// No record → 'unknown': we can't prove it's the user's own work (it could be a
// dev folder OR an install from before this tracking existed), so it is treated
// as NOT exportable — fail-closed, never risk redistributing someone else's
// widget. A developer claims their own folder via POST /sdk/claim → 'local'.
function widgetOriginOf(id) {
  const rec = _widgetOrigins[id];
  if (!rec && trialVault.has(id)) return 'trial';   // never exportable, claimable or auto-updated
  return rec ? rec.origin : 'unknown';
}
const { widgetCatalogVersionOf } = require('./widget-sdk/widget-catalog-version.js');
function widgetExportable(id) {
  return sdkWidgets.originExportable(widgetOriginOf(id));
}
// origin: 'import' | 'creator' | 'builtin' | 'local' to set a record, or
// 'forget' to drop it (on package removal). Advisory store — a write failure
// never fails an install.
//
// `catalogVersion` is the version of the CATALOG ENTRY this install came from,
// which is NOT the same number as the package manifest's version: the entry is
// versioned by whoever publishes it, the manifest by whoever builds it. When
// they disagree, comparing them produces an update that can never be applied —
// a package whose manifest reads '0.1.2-sdk3e' against a catalog entry at
// '0.1.2' parses as a prerelease, so it counts as older, forever. Every open of
// the Store re-offered it, installing it changed nothing, and the badge came
// back. Recording what the catalog CALLED this install lets the check compare
// like with like; without a record it falls back to the manifest as before.
async function recordWidgetOrigin(id, origin, catalogVersion) {
  const prev = _widgetOrigins[id];
  const ver = (typeof catalogVersion === 'string' && /^[0-9A-Za-z._+-]{1,32}$/.test(catalogVersion)) ? catalogVersion : '';
  if (origin === 'forget') { if (!prev) return; delete _widgetOrigins[id]; }
  else {
    // Unchanged origin AND unchanged catalog version → nothing to persist.
    if (prev && prev.origin === origin && (prev.catalogVersion || '') === ver) return;
    _widgetOrigins[id] = {
      origin,
      at: new Date().toISOString(),
      // The stamp describes the LAST install. A stamp-less install REPLACED the
      // package files with a build the catalog didn't describe (pasted code,
      // bundle, local rebuild), so the old stamp must clear — keeping it made a
      // later catalog "update" silently downgrade a newer imported build (the
      // stale stamp compared below the new entry version while the manifest on
      // disk was actually ahead).
      catalogVersion: ver,
    };
  }
  try { await writeFileAtomic(WIDGET_ORIGINS_FILE, JSON.stringify(_widgetOrigins, null, 2)); }
  catch { /* origin records are advisory — never fail an install over them */ }
}

const { sdkHookGateOk } = require('./widget-sdk/request-gates.js');


const sdkAssetCache = require('./sdk-asset-cache');
const sdkAssets = sdkAssetCache.createAssetStore({ root: SDK_ASSETS_DIR });
// Hourly, and once shortly after boot: expiry, orphans and the total cap are
// all things no single request can see. Unref'd, so it never holds the process
// open, and it runs whether or not anyone is looking at a dashboard - a cache
// that only shrinks while in use is not bounded.
async function _sweepSdkAssets() {
  try {
    // An uninstalled widget must not leave its artwork on the disk. Done here
    // rather than in the uninstall path on purpose: a cache that is only
    // cleaned when the tidy path runs is not cleaned after a crash, a manual
    // folder delete, or a restore from a backup taken on another machine.
    const scan = await sdkPackagesCached().catch(() => null);
    if (scan && Array.isArray(scan.packages)) {
      await sdkAssets.dropPackages(scan.packages.map((p) => p.id)).catch(() => {});
    }
    await sdkAssets.sweep();
  } catch { /* a sweep that fails is retried on the next tick */ }
}
{ const t = setTimeout(_sweepSdkAssets, 60_000); t.unref && t.unref(); }
{ const t = setInterval(_sweepSdkAssets, 60 * 60 * 1000); t.unref && t.unref(); }


const { sdkHandlerDispatch, sdkHandlerShutdown } = require('./widget-sdk/handler-calls.js');


const { _sdkDeckStates } = require('./widget-sdk/deck-states.js');

const { _scriptStates, setScriptState } = require('./deck/script-states.js');


// THE single writer for widget-package installs: POST /sdk/install and the AI's
// create_widget tool both land here, so validateWidgetPayload stays the one
// trust boundary in front of the filesystem. Never grants, never assigns.
// `origin` ('import' | 'creator') feeds the redistribution-policy record above:
// imports default fail-closed, and mergeOrigin keeps ownership sticky BOTH ways —
// own work is never demoted, and an already-imported id can't be relabelled
// 'creator' by a replayed install (no laundering someone else's widget).
async function installWidgetPayload(payload, origin, catalogVersion) {
  const v = sdkWidgets.validateWidgetPayload(payload);
  if (!v.ok) return { ok: false, error: v.reason };
  try {
    const dest = path.join(SDK_WIDGETS_DIR, v.id);
    // Capture BEFORE writing: "no folder yet" means a brand-new id, so a plain
    // import records 'import' instead of inheriting the local-folder default.
    const existed = await fs.promises.access(dest).then(() => true, () => false);
    // The same swap the automatic update uses: the package is written beside the
    // live one and renamed into place, so a failure half way leaves the old version
    // whole, and a file the new version no longer ships does not linger from the
    // old one (a mixed tree is how an update ends up running the old script against
    // the new page). The widget's own data lives in widget-store, not in this folder.
    const swapped = await sdkWidgets.installPackageStaged(SDK_WIDGETS_DIR, SDK_STAGING_DIR, v, async () => {
      const scan = await refreshSdkScan();
      return scan.packages.some((p) => p.id === v.id && p.version === v.manifest.version);
    });
    if (!swapped.ok) return { ok: false, error: 'install_failed' };
    // A trial package counts as someone else's: installing its id is never "own work".
    const prev = existed ? widgetOriginOf(v.id) : (trialVault.has(v.id) ? 'import' : null);
    await recordWidgetOrigin(v.id, sdkWidgets.mergeOrigin(prev, origin), catalogVersion);
    await refreshSdkScan();
    return { ok: true, id: v.id, name: v.manifest.name, actions: v.manifest.actions, streams: v.manifest.streams, hosts: v.manifest.hosts };
  } catch {
    return { ok: false, error: 'install_failed' };
  }
}

// Is this install the Store bringing a widget it installed up to date? The
// package must have arrived from the catalog (an import stamped with a catalog
// version, or a pass-trial copy), the caller must say which catalog version it
// is installing, and the catalog must still list an entry for this very package
// id. The payload's word alone is never enough: a pasted share code carries no
// catalog version, and one that claimed one would still need the record.
async function isCatalogUpdateOf(id, catalogVersion) {
  if (!catalogVersion) return false;
  const from = widgetOriginOf(id);
  if (!((from === 'import' && widgetCatalogVersionOf(id)) || from === 'trial')) return false;
  try {
    const cat = await communityCatalog.fetchVisibleCatalog(false);
    return !!(cat && cat.ok && Array.isArray(cat.entries)
      && cat.entries.some((e) => e && (e.kind === 'widget' || e.kind === 'ambient') && e.pkgId === id));
  } catch { return false; }
}

// Record, once, the store group each existing grant was approved with (see
// sdkWidgets.migrateGrantStorageGroups): from now on a changed group asks again,
// and a grant from before this release is read as approval of the group its
// package has today, so nobody's working widget turns into a prompt.
async function migrateSdkGrantGroups() {
  const scan = await sdkPackagesCached();
  const saved = await withHubSettingsLock(async () => {
    const cur = await readHubSettings().catch(() => null);
    const sw = cur && cur.sdkWidgets;
    if (!sw || !sw.grants || typeof sw.grants !== 'object') return null;
    const m = sdkWidgets.migrateGrantStorageGroups(sw.grants, scan.packages);
    if (!m.changed) return null;
    const next = await writeHubSettings({ ...cur, sdkWidgets: { ...sw, grants: m.grants }, rev: nextSettingsRev(cur.rev) });
    hub.settings = next;
    return next;
  });
  if (saved) broadcastSSE('settings', { rev: saved.rev });
}

// ── Widget authors' MCP: what its ops may touch (mcp-dev-tools.js) ─────────
// The same code Bit's create_widget runs: one writer, one validator, the share-
// code dry run for the Store's rules. Nothing here grants a permission.
function mcpDevDeps() {
  return {
    appVersion: APP_VERSION,
    sdkApiVersion: sdkWidgets.SDK_API_VERSION,
    sdkEnabled: () => sdkFeatureEnabled(),
    dashboardOpen: () => sseClients.size > 0,
    getSdkReference: (section) => require('./ai-knowledge.js').getSdkReference(section),
    validateWidgetPayload: (payload) => sdkWidgets.validateWidgetPayload(payload),
    critiqueWidget: (id, files) => aiPresets.critiqueWidget(id, files, aiPresetDeps()),
    scanWidgetSource: (files) => SdkDiagnostics.scanWidgetSource(files),
    isInstalled: async (id) => trialVault.has(id) || !!(await sdkWidgets.readPackagePayload(SDK_WIDGETS_DIR, id)),
    isOwn: (id) => widgetExportable(id),
    install: (payload) => installWidgetPayload(payload, 'creator'),
    place: async (id) => !!(await mcpDev.ask('place', { id }, 4000)),
    ask: (kind, args) => mcpDev.ask(kind, args),
    captureRect: (where) => mcpDevCapture(where),
    listOwn: async () => aiMyWidgets.listOwn((await refreshSdkScan()).packages, widgetExportable),
    readPayload: (id) => sdkWidgets.readPackagePayload(SDK_WIDGETS_DIR, id),
  };
}

// /api/mcp/dev/*: the bridge pairs and calls; the dashboard answers pairings
// and questions; Settings lists, revokes and connects. All loopback-only.
async function handleMcpDevRoute(req, res, reqPath, json) {
  const sub = reqPath.slice('/api/mcp/dev/'.length);
  const body = async (max = 16 * 1024) => JSON.parse((await readBody(req, max)) || '{}');
  if (req.method === 'GET' && sub === 'clients') { json({ ok: true, clients: await mcpDev.listClients() }); return; }
  if (req.method === 'GET' && sub === 'pairs') { json({ ok: true, pairs: mcpDev.pendingPairs() }); return; }
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
  if (sub === 'pair') { json(mcpDev.startPair((await body()).name)); return; }
  if (sub === 'pair/poll') { json(mcpDev.pollPair((await body()).pairId)); return; }
  if (sub === 'pair/answer') { const b = await body(); json(await mcpDev.answerPair(b.id, b.allow === true)); return; }
  if (sub === 'report') { const b = await body(64 * 1024); json({ ok: true, accepted: mcpDev.report(b.reqId, b.data) }); return; }
  if (sub === 'revoke') { json({ ok: await mcpDev.revoke((await body()).id) }); return; }
  if (sub === 'connect') {
    json(await aiCli.addMcpServer(String((await body()).provider || ''), [process.execPath, MCP_BRIDGE_PATH]));
    return;
  }
  if (sub === 'call') {
    const client = await mcpDev.authenticate(req.headers['x-xenon-mcp-token']);
    if (!client) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'not_paired' })); return; }
    // A whole widget package rides in the body: 40 files, 3 MB, as base64.
    const b = await body(6 * 1024 * 1024);
    json(await mcpDevTools.runOp(String(b.op || ''), b.args, mcpDevDeps()));
    return;
  }
  res.writeHead(404); res.end();
}

// One-time migration: earlier versions stored runtime data loose in server/.
// Move any legacy files/dirs into DATA_DIR so existing installs keep their data.
// Runs synchronously at startup, before anything reads these paths. Skips a file
// when the new copy already exists, so it never clobbers current data.
(function migrateLegacyData() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  // SDK widget packages dir: created up-front so "drop a folder into
  // server/data/widgets" always has somewhere to drop into.
  try { fs.mkdirSync(SDK_WIDGETS_DIR, { recursive: true }); } catch {}
  const moves = [
    [path.join(__dirname, 'notes.txt'), NOTES_FILE],
    [path.join(__dirname, 'events.json'), EVENTS_FILE],
    [path.join(__dirname, 'tasks.json'), TASKS_FILE],
    [path.join(__dirname, 'timers.json'), TIMERS_FILE],
    [path.join(__dirname, 'settings.json'), SETTINGS_FILE],
    [path.join(__dirname, 'deck.json'), DECK_FILE],
    [path.join(__dirname, 'stream-config.json'), STREAM_CONFIG_FILE],
    [path.join(__dirname, 'stream-tokens.json'), STREAM_TOKENS_FILE],
    [path.join(__dirname, 'uploads'), UPLOADS_DIR],
  ];
  for (const [oldPath, newPath] of moves) {
    try {
      if (!fs.existsSync(oldPath) || fs.existsSync(newPath)) continue;
      fs.renameSync(oldPath, newPath);
    } catch {
      // Locked file or cross-device move: fall back to copy + best-effort remove.
      try {
        fs.cpSync(oldPath, newPath, { recursive: true });
        fs.rmSync(oldPath, { recursive: true, force: true });
      } catch (copyErr) {
        console.error(`[data-migration] could not move ${oldPath}:`, copyErr.message);
      }
    }
  }
})();

// A store that exists but cannot be read is put back from its newest daily
// copy before anything reads it, and the damaged file is kept aside
// (store-snapshots.js). Open dashboards are told, once, which copy came back.
const storeSnapshots = require('./store-snapshots');
const {
  DURABLE_STORES, _storeRecovery, startStoreSnapshots,
} = require('./engine/durable-stores.js');
(function recoverUnreadableStores() {
  for (const file of DURABLE_STORES) {
    let r;
    // Every store but settings starts again empty when there is no copy (see
    // store-snapshots.js); settings fail closed instead.
    const setAsideIfNoCopy = file !== SETTINGS_FILE;
    try { r = storeSnapshots.recoverIfUnreadable(DATA_DIR, file, { setAsideIfNoCopy }); } catch (e) { r = { state: 'unrecoverable', error: e.message }; }
    if (r.state !== 'restored' && r.state !== 'unrecoverable' && r.state !== 'set_aside') continue;
    const entry = { file: path.basename(file), state: r.state, from: r.from || '', aside: r.aside || '' };
    _storeRecovery.push(entry);
    startupLog.write(r.state === 'restored'
      ? `data: ${entry.file} could not be read; restored ${entry.from}, the damaged file is kept as snapshots/${entry.aside}`
      : r.state === 'set_aside'
        ? `data: ${entry.file} could not be read and there is no copy to restore; it is kept as snapshots/${entry.aside} and starts again empty`
        : `data: ${entry.file} could not be read and there is no copy to restore; it is left as it is${r.error ? ' (' + r.error + ')' : ''}`);
  }
})();
const _storeRecoveryAt = Date.now();
// Read here, after the legacy move and the recovery above and before anything
// can write settings: from the next line on, a new user and an old one look alike.
const FRESH_INSTALL = welcomeSparks.isFreshDataDir([...DURABLE_STORES, path.join(DATA_DIR, 'install-id.json')], storeSnapshots.snapshotsDir(DATA_DIR));

// Shared-code bridge: expose packages/core to the browser under server/shared so
// the existing static handler can serve /shared/* without reaching outside
// __dirname. Normally created by `npm run link:shared` (postinstall); we re-create
// it here best-effort so a fresh checkout or a self-update that skipped postinstall
// still serves the shared modules. The client also keeps inline fallbacks, so a
// failure here never breaks the dashboard.
(function ensureSharedLink() {
  const sharedDir = path.join(__dirname, 'shared');
  const coreDir = path.join(__dirname, '..', 'packages', 'core');
  try {
    if (fs.existsSync(sharedDir) || !fs.existsSync(coreDir)) return;
    fs.symlinkSync(coreDir, sharedDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    console.warn('[shared-link] could not create server/shared:', err.message);
  }
})();

// Durable stores (settings/deck/tasks/timers/events/notes/lighting) are written
// with a temp-file + fsync + atomic rename so a crash or power-loss mid-write
// can never leave a truncated file behind. The shared primitive lives in
// atomic-write.js so every module (stream-common, ai-memory, guardian) writes
// with the exact same discipline — one serialized queue per path, no ad-hoc
// temp+rename copies that can race each other.
const { writeFileAtomic } = require('./atomic-write');


// The single Range-aware file responder. /uploads/, /deck/sound and the
// transfer download all answer through it, so seeking cannot work in one place
// and quietly not in another.
const { serveFileRange } = require('./http-range');

const BACKGROUND_EXT_BY_MIME = new Map([...BACKGROUND_MIME_BY_EXT.entries()].map(([ext, mime]) => [mime, ext]));

const FONT_EXT_BY_MIME = new Map([...FONT_MIME_BY_EXT.entries()].map(([ext, mime]) => [mime, ext]));

const TILE_ASSET_EXT_BY_MIME = new Map([...TILE_ASSET_MIME_BY_EXT.entries()].map(([ext, mime]) => [mime, ext]));

const SLIDESHOW_ASSET_EXT_BY_MIME = TILE_ASSET_EXT_BY_MIME;


const { runWindowsTool } = require('./windows-tiles/windows-tool.js');

const { keySend } = require('./deck/key-send-state.js');
// ── Sending a key combination ───────────────────────────────────────────────
// One seam, three deliveries, and the SAME shape out — the pattern the
// collectors follow, for the same reason: the two callers (the Deck's `hotkey`
// action and answering an incoming Teams/Zoom call) should learn a path, never
// a platform branch.
//
//   Windows  deck-hotkey.ps1, unchanged since the Deck shipped.
//   macOS    the helper's `keys` mode (CGEvent). Gated by macOS behind the
//            Accessibility grant, which is checked rather than assumed.
//   Linux    xdotool on X11, ydotool on Wayland, neither guaranteed — so here
//            the capability genuinely may not exist, and says so.
//
// `keySendAvailable()` is what decides whether an Answer button is drawn at
// all. It is cached because it is read on a render path, and because none of
// the three answers changes while the server is up.
// Seeded synchronously on Windows, where the answer is known without asking
// anything: deck-hotkey.ps1 has shipped since the Deck did. Leaving it null
// until the async probe resolved would mean a /actions/catalog request in those
// first milliseconds reported `keys: false`, and the Deck editor would hide a
// key that has worked for years — a regression introduced by making the
// capability measurable.
keySend.probe = POWERSHELL_SUPPORTED ? { ok: true, reason: '' } : null;
const {
  refreshKeySendProbe, keySendAvailable, keySendProblem, sendHotkeyCombo,
} = require('./deck/key-send.js');
refreshKeySendProbe();

const remoteActions = require('./remote-actions');

const { _killWorker } = require('./powershell/worker-state.js');

const { runPowerShellWorker } = require('./system/pwsh-worker.js');

const { batteryMonitor } = require('./device-battery/engine-monitor.js');

const { _mediaHost, _mediaHostReject, _retireMediaHost } = require('./media/host-state.js');

function _ensureMediaHost() {
  // Both hosts read Windows' SMTC: the helper through WinRT, the fallback
  // through media.ps1. Neither can run elsewhere — macOS and Linux are served
  // by nativeMedia (see runMediaRequest), so off Windows there is no host here
  // at all and the caller falls through rather than respawning a doomed child
  // every few seconds.
  if (!POWERSHELL_SUPPORTED) return null;
  if (_mediaHost.proc) return _mediaHost.proc;
  if (Date.now() - _mediaHost.diedAt < MEDIA_HOST_RETRY_MS) return null;
  let useHelper = false;
  if (Date.now() >= _mediaHost.helperBadUntil) {
    try { useHelper = fs.existsSync(HELPER_EXE); } catch { useHelper = false; }
  }
  let proc;
  try {
    proc = useHelper
      ? spawn(HELPER_EXE, ['media-serve'], { windowsHide: true })
      : spawn('powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', MEDIA_SCRIPT, '-Serve'],
          { windowsHide: true });
  } catch { return null; }
  _mediaHost.proc = proc;
  lowerPriority(proc.pid);
  _mediaHost.isHelper = useHelper;
  _mediaHost.bornAt = Date.now();
  _mediaHost.buf = '';
  // Fresh host → fresh blind-detection state (a re-downloaded helper after an
  // update deserves a clean chance to prove it can see sessions).
  _mediaHost.emptyStreak = 0;
  _mediaHost.crossChecks = 0;
  _mediaHost.lastCrossCheck = 0;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    _mediaHost.buf += chunk;
    let nl;
    while ((nl = _mediaHost.buf.indexOf('\n')) !== -1) {
      const line = _mediaHost.buf.slice(0, nl).trim();
      _mediaHost.buf = _mediaHost.buf.slice(nl + 1);
      if (!line.startsWith('XEMED ')) continue; // ignore any stray output
      let env;
      try { env = JSON.parse(Buffer.from(line.slice(6), 'base64').toString('utf8')); }
      catch { continue; }
      const p = _mediaHost.pending.get(env.id);
      if (!p) {
        // Unsolicited frame: the native helper pushes {event:"media-changed"}
        // when the OS reports a track/playback change.
        if (env.event === 'media-changed') _onMediaChangedPush();
        continue;
      }
      clearTimeout(p.timer);
      _mediaHost.pending.delete(env.id);
      if (env.ok) p.resolve(env.out || '');
      else p.reject(new Error(env.err || 'media host error'));
    }
  });
  proc.stderr.on('data', () => {}); // the host traps its own errors; ignore
  // A write to a pipe whose child is already gone reports EPIPE/ECONNRESET
  // ASYNCHRONOUSLY, as an 'error' event on the stream — the try/catch around
  // stdin.write() never sees it, and an unhandled 'error' on a stream takes the
  // whole server down. Route it to the same retire path the exit handler uses:
  // the host is dead either way, and every caller already falls back.
  proc.stdin.on('error', () => _retireMediaHost('media host pipe error'));
  proc.on('error', () => _retireMediaHost('media host spawn error'));
  proc.on('exit', () => { if (_mediaHost.proc === proc) _retireMediaHost('media host exited'); });
  proc.unref(); // never keep the event loop alive on the host's account
  return proc;
}

function runMediaHostRequest(action, timeout = 8000, position) {
  return new Promise((resolve, reject) => {
    const proc = _ensureMediaHost();
    if (!proc) { reject(new Error('media host unavailable')); return; }
    const id = _mediaHost.nextId++;
    const timer = setTimeout(() => {
      _mediaHostReject(id, new Error('media host timeout'));
      _retireMediaHost('media host timeout');
    }, timeout);
    _mediaHost.pending.set(id, { resolve, reject, timer });
    try {
      const request = { id, action, preferredSource: mediaChoice.source || '' };
      if (position !== undefined) request.position = position;
      proc.stdin.write(JSON.stringify(request) + '\n');
    } catch (e) {
      clearTimeout(timer);
      _mediaHost.pending.delete(id);
      reject(e);
    }
  });
}

const { mediaNow } = require('./media/now-state.js');
function _onMediaChangedPush() {
  if (mediaNow.pushTimer) return;
  mediaNow.pushTimer = setTimeout(async () => {
    mediaNow.pushTimer = null;
    mediaNow.cache.updatedAt = 0;
    try { await broadcastMediaNow(); } catch {}
  }, 150);
  mediaNow.pushTimer.unref();
}

const { _normalizeTimer } = require('./time/timer-normalize.js');

const { readRamInfo } = require('./system/ram-info.js');

// Neither host above can run off Windows: there is no SMTC and no PowerShell.
// Both other platforms have their own now-playing source behind the SAME
// interface — available/start/stop/info/command — so this is one variable and
// one branch, the way `nativeCollectors` is. macOS reads mediaremote-adapter,
// Linux reads MPRIS over D-Bus through playerctl. Started lazily, so a run that
// never asks for media never spawns anything.
const nativeMedia =
  process.platform === 'darwin'
    ? require('./darwin-media').createDarwinMedia({
        dir: MEDIAREMOTE_DIR,
        onChange: () => _onMediaChangedPush(),
      })
    : process.platform === 'linux'
      ? require('./linux-media').createLinuxMedia({ onChange: () => _onMediaChangedPush() })
      : null;

// Run a media request through the persistent host, falling back to the original
// one-shot spawn on any host problem. Same parsed-JSON result either way.
async function runMediaRequest(action, timeout = 8000, position) {
  if (nativeMedia) {
    // Nothing installed to read the OS with → the empty "nothing playing"
    // shape, not an error. The tile shows its own empty state, and nothing is
    // spawned or retried.
    if (!nativeMedia.available()) {
      return action === 'seek'
        ? { ok: false, error: 'unavailable', seekProtocol: 1 }
        : nativeMedia.info();
    }
    nativeMedia.start();                       // idempotent
    return action === 'info' ? nativeMedia.info() : nativeMedia.command(action, position);
  }
  try {
    const out = parseJsonOutput(await runMediaHostRequest(action, timeout, position));
    // An in-app helper refresh cannot replace the executable while its old
    // media-serve process is still alive. A pre-0.11.4 helper therefore answers
    // an unknown seek with {ok:false} but no marker: retire it, pin it out, and
    // complete this request through the permanent PowerShell fallback.
    if (action === 'seek' && _mediaHost.isHelper && out?.seekProtocol !== 1) {
      _mediaHost.helperBadUntil = Date.now() + MEDIA_HELPER_BAD_MS;
      _retireMediaHost('media helper lacks seek protocol');
      return runPowerShellScript(MEDIA_SCRIPT, mediaScriptArgs(action, position), timeout);
    }
    // Only 'info' carries sessions, and the guard only applies to the helper.
    return (action === 'info' && _mediaHost.isHelper) ? _guardHelperMediaBlindSpot(out) : out;
  } catch {
    return runPowerShellScript(MEDIA_SCRIPT, mediaScriptArgs(action, position), timeout);
  }
}

const { cpuRead } = require('./system/cpu-usage-state.js');
cpuRead.last = cpuSnapshot();
// Continuous CPU sampler — avoids 0% sampling artifacts when /system is polled less often than CPU times update.
setInterval(() => {
  const now = cpuSnapshot();
  let idle = 0, total = 0, maxCore = 0;
  now.forEach((cpu, i) => {
    const prev = cpuRead.last[i];
    if (!prev) return;
    const di = cpu.idle - prev.idle;
    const dt = cpu.total - prev.total;
    idle  += di;
    total += dt;
    if (dt > 0) maxCore = Math.max(maxCore, 100 - (di / dt) * 100);
  });
  cpuRead.last = now;
  cpuRead.maxCore = Math.max(0, Math.min(100, Math.round(maxCore)));
  if (total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round(100 - (idle / total * 100))));
    cpuRead.usage = pct;
  }
}, 1500).unref();

const { sensorReads } = require('./system/sensor-reads-state.js');
const { sensorCache } = require('./system/sensor-cache.js');
const { sttDevice } = require('./ai/stt-device-state.js');

const { STT_DEVICE_DELAY_MS } = require('./ai/stt-gate.js');
const { _sttPending, _sweepStaleStt } = require('./ai/stt-pending.js');
setInterval(_sweepStaleStt, 60000).unref();


const { mediaChoice } = require('./media/preferred-source.js');
const { heardPlayer, musicNow } = require('./media/heard.js');

const { setMediaPreferredSource } = require('./media/preferred-source-set.js');

// ── What the media hosts hand us, made usable ───────────────────────────────
// Reported as issue #128, on Apple Music for Windows: the cover never rendered
// and the album title was mashed onto the artist line. Both hosts build the
// payload from Windows' own media session, and both faults are in what that
// session reports rather than in anything Xenon decided.
//
// This runs on the way in, in ONE place, for whichever host answered — and it
// is also what fixes the artwork for people who already have xenon-helper.exe
// installed: that is a compiled binary refreshed on release, so a fix made only
// inside it would reach nobody until they update.



const { hydrateArtwork } = require('./media/artwork-lookup.js');

const { getWeather } = require('./weather/get-weather.js');

const { getCpuUsage } = require('./system/cpu-usage.js');

const { diskLetters } = require('./disk/letters-state.js');

const mountedDisks = nativeCollectors ? createMountedDisks(() => nativeCollectors.disks()) : null;

async function getAllDisksInfo({ waitForDetails = true } = {}) {
  if (mountedDisks) return mountedDisks();
  const drives = [];
  const details = waitForDetails
    ? await getDiskDetails()
    : joinDiskDetails(volumeDetailsProbe.data || {}, diskModelsProbe.data || {});
  // Probing all 24 letters with statfs every cycle (~7s) is wasteful — valid
  // letters change rarely. Cache the set that resolved for 60s and probe only
  // those; a stale (or empty) cache triggers a full A–Z re-scan so a newly
  // mounted/removed drive still appears within a minute. Free-space is still
  // read live on each call — only the dead letters are skipped.
  const now = Date.now();
  const fresh = diskLetters.cache.letters && diskLetters.cache.letters.length &&
                (now - diskLetters.cache.at) < DISK_LETTERS_TTL;
  const letters = fresh ? diskLetters.cache.letters : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const valid = [];
  for (const letter of letters) {
    try {
      if (typeof fs.promises.statfs === 'function') {
        const s = await fs.promises.statfs(letter + ':\\');
        const total = Number(s.blocks) * Number(s.bsize);
        const free = Number(s.bfree) * Number(s.bsize);
        if (total > 0) {
          valid.push(letter);
          const drive = letter + ':';
          const detail = details[drive.toUpperCase()] || {};
          drives.push({
            drive,
            total,
            used: total - free,
            free,
            percent: Math.round(((total - free) / total) * 100),
            label: detail.label || '',
            // The name of the physical disk. The detail line falls back to it
            // when the volume has no label of its own, which is the default on
            // a Windows install: without it that line reads "NTFS - Fixed".
            model: detail.model || '',
            fileSystem: detail.fileSystem || '',
            driveType: detail.driveType || '',
          });
        }
      }
    } catch { }
  }
  // Only refresh the cache after a full scan, and never store an empty result
  // (a transient failure must not pin us to "no drives" for 60s).
  if (!fresh && valid.length) diskLetters.cache = { letters: valid, at: now };
  return drives.length ? drives : null;
}

const ramInfo = createFactReader(readRamInfo, { retryMs: RAM_INFO_RETRY_MS });

const firstSystemReading = createFirstReading();

// What getSystemInfo can say without waiting for a source that has not answered yet.
function knownSystemSources() {
  return Promise.all([
    sensorReads.gpuCache, getAllDisksInfo({ waitForDetails: false }), ramInfo.known(), sensorCache.reading.cpuTemp,
    nativeCollectors ? nativeCollectors.memory() : null,
  ]);
}

// `partialOk` is for a page that is painting: until the first full read lands it gets
// what is known now, marked `partial`, and the feed brings the rest. Everyone else
// waits, because a reading that is missing must not read as a sensor that is gone.
async function getSystemInfo({ partialOk = false } = {}) {
  const { value: [gpu, disks, ramDetail, cpuTemp, mem], partial } = await firstSystemReading(Promise.all([
    getGpuInfo(), getAllDisksInfo(), ramInfo.get(), getCpuTemp(),
    // os.freemem() is ullAvailPhys on Windows — already "what a new workload
    // could get" — but only the truly free pages on macOS and Linux, where the
    // OS keeps that near zero on purpose. Same call, different meaning, so the
    // seam answers it per platform (see each collector's `memory()`); Windows
    // keeps the os module it always used.
    nativeCollectors ? nativeCollectors.memory() : null,
  ]), partialOk ? knownSystemSources : null);
  const totalMem = (mem && mem.total) || os.totalmem();
  const usedMem = mem ? mem.used : totalMem - os.freemem();

  // Fans: motherboard/CPU headers from the cpu collector (RPM), plus the GPU's
  // own fans — LHM gives RPM, nvidia-smi only a percent, so a fan entry carries
  // either `rpm` or `pct` and the client renders unit-aware.
  // `kind` is the typed discriminator clients key on ('mb' = a motherboard fan
  // header, 'psu' = the power supply's own fan, 'gpu' = on the graphics card) —
  // `name` is pure presentation, so a motherboard header literally named "GPU"
  // must never match.
  //
  // Only fans wired to a motherboard header report a tachometer here: fans on an
  // AIO pump, a Corsair Commander or any fan hub are invisible to the board, and
  // fans daisy-chained onto one header report as a single reading. The list is
  // therefore "what the hardware exposes", never "every fan in the case".
  const fans = sensorCache.reading.fans.map(f => ({ ...f }));
  // Prefer each fan's real tachometer over nvidia-smi's fan.speed, which is the
  // curve's TARGET: an idle card in zero-RPM mode reports a percent while the
  // fans are stopped. The percent stays the fallback for cards LHM can't read.
  if (Array.isArray(gpu.gpuFans) && gpu.gpuFans.length) {
    gpu.gpuFans.forEach(f => fans.push({ name: f.name, kind: 'gpu', rpm: f.rpm }));
  } else if (gpu.gpuFanRpm !== null && gpu.gpuFanRpm !== undefined) fans.push({ name: 'GPU', kind: 'gpu', rpm: gpu.gpuFanRpm });
  else if (gpu.gpuFanPct !== null && gpu.gpuFanPct !== undefined) fans.push({ name: 'GPU', kind: 'gpu', pct: gpu.gpuFanPct });

  // Power draw in watts. `total` is strictly CPU+GPU (labelled as such client-
  // side — never a whole-system estimate); `psu` appears only when a digital
  // PSU (Corsair HXi/RMi & co.) is visible to LHM.
  const cpuWatts = sensorCache.reading.cpuWatts;
  const gpuWatts = gpu.gpuWatts === undefined ? null : gpu.gpuWatts;
  const power = {
    cpu: cpuWatts,
    gpu: gpuWatts,
    psu: sensorCache.reading.psuWatts,
    total: (cpuWatts !== null && gpuWatts !== null) ? Math.round((cpuWatts + gpuWatts) * 10) / 10 : null,
  };

  const info = {
    now: new Date().toISOString(),
    hostname: os.hostname(),
    uptime: Math.round(os.uptime()),
    cpu: getCpuUsage(),
    cpuTemp,
    cpuName: getCpuName(),
    // Live clock speeds in MHz, null where the platform exposes none. Added for
    // the SDK's `system` stream, which forwards this payload untouched — so a
    // monitoring widget reads them with the grant it already has.
    cpuClockMHz: sensorCache.reading.cpuClockMHz,
    // Why the LHM-backed readings (cpuTemp, `fans`, power.cpu/psu) may be empty:
    // 'ok' | 'needs_admin' (LHM installed but unelevated → no kernel driver) |
    // 'missing'. Lets the widgets name the actual fix instead of guessing.
    sensorAccess: sensorCache.reading.sensorAccess,
    memory: {
      used: usedMem,
      total: totalMem,
      percent: Math.round((usedMem / totalMem) * 100),
    },
    ramName: ramDetail && ramDetail.name ? ramDetail.name : null,
    ramDetail,
    gpu: gpu.gpu,
    gpuName: gpu.gpuName,
    gpuTemp: gpu.gpuTemp,
    vramUsed: gpu.vramUsed,
    vramTotal: gpu.vramTotal,
    gpuClockMHz: gpu.gpuClockMHz === undefined ? null : gpu.gpuClockMHz,
    vramClockMHz: gpu.vramClockMHz === undefined ? null : gpu.vramClockMHz,
    // In-game frame rate, or null when nothing is being measured.
    //
    // It rides `system` rather than `status`, which is where it was asked for.
    // `status` is broadcast ONLY when it changes, plus a 30s heartbeat, because
    // its payload is identical tick after tick on an idle PC and every SSE event
    // wakes each connected renderer. FPS changes constantly, so putting it there
    // would turn a mostly-silent stream into a permanent 3s broadcast on every
    // open dashboard — reinstating exactly the idle cost that dedup removed.
    // `system` already broadcasts unconditionally every 5s, so this rides along
    // for the price of an in-memory read: PresentMon (or MangoHud on Linux)
    // fills the table continuously, and getCurrentFps only looks at it.
    fps: (() => { try { return fpsMonitor.getCurrentFps(); } catch { return null; } })(),
    fans,
    power,
    disks,
    // Which OS is answering. Tiles that have to explain an absence need it:
    // "no fan sensors" is a different sentence on a PC (install the companion,
    // re-run the installer) than on a Linux box, where the kernel publishes
    // every tachometer it can see and there is nothing to install. Sent with
    // the readings so a tile never has to render its explanation before it
    // knows which one is true.
    platform: process.platform,
  };

  // The user's sensor choices (Settings → Sensor sources) go over the automatic
  // readings HERE and nowhere else, so every consumer of this payload (system
  // tile, Deck, AI, lighting, Guardian, the SDK `system` stream) follows the
  // choice without knowing it exists. `sensorSources` says per metric where
  // the number came from.
  const sources = SensorSources.normalizeSensorSources(hub.settings && hub.settings.sensorSources);
  if (partial) info.partial = true;
  const unread = partial ? null : [];
  const readings = !partial && Object.keys(sources).length ? await readChosenSensors(sources) : unread;
  return SensorSources.applySensorSources(info, sources, readings, { cpuTemp: sensorCache.reading.cpuTempSource });
}

require('./system/packet-loss-count.js');

const { getNetworkInfo } = require('./system/network-info.js');

const { getDiskIo } = require('./system/disk-io.js');

const { applyStickyThumb, mediaForBroadcast } = require('./media/cover-memory.js');

async function getMediaInfo(force = false) {
  if (!force && Date.now() < mediaNow.holdUntil) return mediaNow.cache.data;
  const age = Date.now() - mediaNow.cache.updatedAt;
  if (!force && mediaNow.cache.data && age < cacheLife(mediaNow.cache.data, MEDIA_CACHE_MS)) return liveMediaSnapshot(mediaNow.cache.data, age);
  if (mediaNow.pending) return mediaNow.pending;
  mediaNow.pending = (async () => {
  try {
    if (mediaListDown()) { probeMediaList(); return await mediaStandIn('media reader resting'); }
    const read = normalizeMedia(await runMediaRequest('info', 12000));
    if (readFailed(read)) throw new Error(read.error);
    const data = (await heardInsteadOf(read)) || read;
    // Aged from when the host answered: an online cover lookup can take seconds.
    const readAt = Date.now();
    const hydrated = applyStickyThumb(await hydrateArtwork(data));
    mediaNow.cache = { data: hydrated, updatedAt: readAt };
    return liveMediaSnapshot(hydrated, Date.now() - readAt);
  } catch (e) {
    mediaNow.readerRestUntil = Date.now() + MEDIA_READER_REST_MS;
    return mediaStandIn(e.message);
  }
  })().finally(() => { mediaNow.pending = null; });
  return mediaNow.pending;
}

const { mediaListDown } = require('./media/sounding-rows.js');

// A list that failed is asked again on the side: a wedged one answers after its whole
// timeout, and a song starting meanwhile must not wait for that to be seen.
function probeMediaList() {
  if (mediaNow.listProbe || Date.now() < mediaNow.readerRestUntil) return;
  mediaNow.listProbe = runMediaRequest('info', 12000)
    .then((read) => {
      if (readFailed(normalizeMedia(read))) throw new Error(read.error);
      mediaNow.readerRestUntil = 0;
      mediaNow.cache.updatedAt = 0;
    })
    .catch(() => { mediaNow.readerRestUntil = Date.now() + MEDIA_READER_REST_MS; })
    .finally(() => { mediaNow.listProbe = null; });
}

const { mediaStandIn, heardNow } = require('./media/stand-in.js');

// A read saying nothing plays may only mean the player never told the OS. Asked only while
// a rule needs the answer: nobody else should pay for a process every few seconds.
async function heardInsteadOf(read) {
  if (read.playbackStatus === 'Playing' || !_situations.needs('music')) return null;
  try { return await heardNow(reportedApps(read)); } catch { return null; }
}

const { runMediaKeyScript } = require('./media/key-script.js');
const sendMediaCommand = createMediaSender({
  request: (action) => runMediaRequest(action, 5000),
  tell: (action) => tellApp(action, heardPlayer.name(), runMediaKeyScript),
  press: (action) => pressMediaKey(action, runMediaKeyScript),
  // A read from the sound names a player the list does not know: it would reach another.
  listResting: () => mediaListDown() || (mediaNow.cache.data && mediaNow.cache.data.fallback === true),
});

async function mediaAction(action) {
  const data = await (nativeMedia ? runMediaRequest(action, 5000) : sendMediaCommand(action));
  const pressed = data && data.told && action === 'playpause' ? afterPress(mediaNow.cache.data) : null;
  mediaNow.cache = pressed ? { data: pressed, updatedAt: Date.now() } : { ...mediaNow.cache, updatedAt: 0 };
  if (pressed) mediaNow.holdUntil = Date.now() + PRESS_HOLDS_MS;
  mediaNow.soundRows.at = 0;
  return data;
}

async function mediaSeek(position) {
  const seconds = Number(position);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return { ok: false, error: 'bad_position' };
  }
  try {
    const data = await runMediaRequest('seek', 5000, seconds);
    mediaNow.cache.updatedAt = 0;
    return normalizeMediaSeekResult(data, seconds);
  } catch {
    mediaNow.cache.updatedAt = 0;
    return { ok: false, error: 'unavailable' };
  }
}

const { LYRICS_USER_AGENT, _lyricsPending } = require('./media/lyrics-lookup-values.js');
let _lyricsCooldownUntil = 0;

const { lyricsReply } = require('./media/lyrics-reply.js');

function lookupLyricsOnce(media, key) {
  if (_lyricsPending.has(key)) return _lyricsPending.get(key);
  const pending = (async () => {
    try {
      const out = await lyrics.lookup(media, { userAgent: LYRICS_USER_AGENT });
      if (out.state === 'busy') {
        _lyricsCooldownUntil = Date.now() + out.retryAfter * 1000;
        await lyricsCache.set(key, out, { until: _lyricsCooldownUntil });
      } else {
        await lyricsCache.set(key, out);
      }
      return out;
    } finally {
      _lyricsPending.delete(key);
    }
  })();
  _lyricsPending.set(key, pending);
  return pending;
}

async function getCurrentLyrics() {
  if (hub.settings.mediaLyrics === false) return { ok: true, state: 'off' };
  const media = await getMediaInfo();
  if (!media || !media.active || !String(media.title || '').trim()) return { ok: true, state: 'idle' };
  const key = lyrics.trackKey(media);
  if (!key) return { ok: true, state: 'idle' };
  // A read from the sound has no duration either, but it is a song, not a stream.
  if (!lyrics.validDuration(media) && media.fallback !== true) return lyricsReply(media, key, { state: 'live' });
  const cached = await lyricsCache.get(key);
  const result = cached
    || (Date.now() < _lyricsCooldownUntil ? { state: 'busy' } : await lookupLyricsOnce(media, key));
  const out = lyricsReply(media, key, result);
  // The song's own timing, set from the supporter widget; the free Media-tile
  // view applies it too, so the song is right on every screen.
  const songOffset = await lyricsOffsets.get(key);
  if (songOffset !== null) out.offsetMs = songOffset;
  return out;
}

// The lyrics of the song playing NOW, when `key` names it. Both supporter
// writes below act only on that song: a stale screen asking about the previous
// one gets a 409 instead of changing a song nobody is looking at.
async function lyricsForPlayingKey(key) {
  if (typeof key !== 'string' || !key) return { status: 400 };
  const media = await getMediaInfo();
  if (!media || !media.active || lyrics.trackKey(media) !== key) return { status: 409 };
  return { status: 200, entry: await lyricsCache.get(key) };
}

const { companionLookSparks } = require('./ai/companion-look-sparks.js');

const { svvExec } = require('./audio/svv-exec.js');

const { setMicMute } = require('./audio/mic-mute.js');

const { deckObs, deckSb } = require('./streaming/deck-clients.js');

const { deckHa, haQuery, deckUnifi, deckUnifiEvents } = require('./smart-home/deck-clients.js');

const { deckChroma } = require('./lights/chroma-client.js');
const { deckWaveLink, deckVoicemeeter } = require('./audio/mixer-clients.js');

const { embeddedBrowser } = require('./windows-tiles/engine-browser.js');
// Cross-surface Browser-widget coordination: keep two dashboard surfaces (desktop
// browser + XENON) in step after a login, since they drive independent headless
// pages over one shared cookie jar (see browser-surface-sync.js / GitHub #96).
const browserSync = createBrowserSurfaceSync();
const { secondScreen, screenCapture } = require('./screens/second-screen-hosts.js');

const { applySecondScreenMode } = require('./screens/second-screen-mode.js');

const { obsWatch } = require('./streaming/obs-watch-state.js');
const { obsWatching } = require('./streaming/obs-watching.js');
const { streamingLive } = require('./streaming/live.js');

const { applyObsPartial, captureScenePreview } = require('./streaming/obs-live-state.js');

const { frontAppKnown } = require('./system/front-app-known.js');
// The facts behind the rules on placed widgets and pages. Each closure runs on the
// status tick, long after every source below has been declared.
const _situations = createSituations({
  layers: () => hub.settings && hub.settings.layers,
  isOwnApp,
  read: {
    game: () => gameDetect.isGameRunning(),
    live: () => obsWatch.state.obsStreaming === true,
    recording: () => obsWatch.state.obsRecording === true || _recorder.status().on === true,
    timer: () => timerState.list.some((t) => t.status === 'running'),
    dnd: () => !!(hub.settings.notifications && hub.settings.notifications.quiet === 'always'),
    cpu: () => getCpuUsage(),
    idleSec: () => ((_idleProbe.at > 0 && Date.now() - _idleProbe.at < 60000) ? _idleProbe.sec : null),
    front: () => gameDetect.getForegroundProcess(),
    music: async () => musicNow((await getMediaInfo()).playbackStatus),
    call: async () => calls.current().length > 0 || (await micUse.read({ ownMic: wakeWordWanted() })) === true,
    open: async () => ((await runWindowsTool(['list'], 8000)).windows || []).map((w) => w.app),
    battery: async () => (await require('./power').read()).battery,
  },
  onChange: () => broadcastStatusNow(),
  onPlan: () => { refreshObsWatch().catch(() => {}); },
  onFacts: (facts) => _whenPageSync(facts),
  warn: (msg) => console.warn(msg),
});

async function refreshObsWatch() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const tile = !!s.obsHost || streamingLive.obsWanted;
  const want = (tile || _situations.needs('live') || _situations.needs('recording')) && sseClients.size > 0;
  if (want && !obsWatching.stop) obsWatching.stop = deckObs.watch(applyObsPartial);
  // A rule only asks whether OBS is live: no picture of the scene every 5 s for it.
  if (want && tile && !obsWatch.previewTimer) {
    obsWatch.previewTimer = setInterval(captureScenePreview, 5000);
    captureScenePreview();                    // one immediate capture so the thumbnail appears fast
  } else if (want && !tile && obsWatch.previewTimer) {
    clearInterval(obsWatch.previewTimer); obsWatch.previewTimer = null;
  }
  if (!want && obsWatching.stop) {
    const stopObs = obsWatching.stop; stopObs(); obsWatching.stop = null;
    if (obsWatch.previewTimer) { clearInterval(obsWatch.previewTimer); obsWatch.previewTimer = null; }
    obsWatch.state = { obsRecording: false, obsStreaming: false, obsScene: '', obsMutes: {}, obsVolumes: {}, obsInputs: [] };
    obsWatch.preview = { scene: '', image: '' };
    broadcastSSE('obs', obsWatch.state);            // clear stale record/stream/scene indicators
    broadcastSSE('obs_preview', obsWatch.preview);  // clear the client thumbnail
  }
}

const { haWatching } = require('./smart-home/ha-watching.js');
const { haWatch } = require('./smart-home/ha-watch-state.js');

const {
  buildHaState, broadcastHaDeckStates, scheduleHaBroadcast,
} = require('./smart-home/ha-live-state.js');

// Signature of the HA config the broadcasts depend on — refreshHaWatch runs on
// every SSE connect/close and every settings save, and must NOT rebroadcast a
// full snapshot when none of this changed.
let _haConfigSig = null;
async function refreshHaWatch() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const ha = (s && s.homeAssistant) || {};
  const want = !!(ha.url && ha.token) && sseClients.size > 0;
  const sig = want ? [ha.url, ha.token, JSON.stringify(ha.entities || []), JSON.stringify(ha.energyEntities || []), JSON.stringify(ha.areaOrder || []), ha.tileView || ''].join(' ') : '';
  if (want && !haWatching.stop) {
    haWatching.stop = deckHa.watch(scheduleHaBroadcast);
  } else if (!want && haWatching.stop) {
    const stopHa = haWatching.stop; stopHa(); haWatching.stop = null;
    if (haWatch.notifyTimer) { clearTimeout(haWatch.notifyTimer); haWatch.notifyTimer = null; }
    haWatch.deckStatesLast = '';   // a future watcher must get a fresh seed
    haWatch.stateLast = '';
    try { broadcastSSE('homeassistant', await buildHaState()); } catch (e) { /* ignore */ }
  } else if (want && haWatching.stop && sig !== _haConfigSig) {
    // Already watching AND the config/selection actually changed (the user picked
    // different devices) — push a fresh snapshot so the tile reflects the new
    // selection immediately instead of waiting for the next HA state change.
    scheduleHaBroadcast();
  }
  _haConfigSig = sig;
}

const { buildSbState, refreshSbWatch } = require('./streaming/streamerbot-watch.js');

const { wlWatching } = require('./audio/wavelink-watching.js');
const { wlWatch } = require('./audio/wavelink-watch-state.js');

const { buildWlState, refreshWlWatch } = require('./audio/wavelink-watch.js');

const { vmWatch } = require('./audio/voicemeeter-watch-state.js');

const { refreshVoicemeeterWatch } = require('./audio/voicemeeter-watch.js');

const { unifiWatching } = require('./smart-home/unifi-events-watching.js');

const { refreshUnifiEventsWatch } = require('./smart-home/unifi-events-watch.js');

const { ensureObsRun } = require('./streaming/obs-ensure-run.js');

const { lockWorkstation } = require('./system/lock-workstation.js');

const { runUserScript } = require('./deck/run-user-script.js');

// The Deck action dispatcher. Effects are injected here; security/validation
// lives inside the registry. This is the only place key actions execute.
// deckRegistryDeps is kept mutable so that deps created after this point
// (e.g. remoteControl, which is initialised below) can be injected lazily
// by assigning to the object — the registry closes over the same reference.
const deckRegistryDeps = {
  fileExists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
  // The deckState action shares /state/set's map, so a key and a script can
  // drive the same named state.
  setNamedState: (name, value) => setScriptState(name, value),
  getNamedState: (name) => (Object.hasOwn(_scriptStates.states, name) ? _scriptStates.states[name] : null),
  lockWorkstation: () => lockWorkstation().then(() => ({ ok: true }), (err) => ({ ok: false, error: String(err) })),
  pageTurn: (target) => routePageHotkey({ target }),
  // Apply a named SignalRGB scene (scene switcher, not a colour provider — see
  // signalrgb.js). Gated on the user enabling SignalRGB in Settings → Lighting,
  // so a stale Deck key can't drive it after the integration is turned off.
  signalRgbEffect: (effect) => {
    if (!(hub.settings && hub.settings.signalrgb && hub.settings.signalrgb.enabled === true)) {
      return Promise.resolve({ ok: false, error: 'disabled' });
    }
    return signalrgb.applyEffect(effect);
  },
  openExternal: (p, args) => openExternalPath(p, args),
  // Linux app launcher (.desktop via `gio launch`, binaries spawned directly)
  // — openExternal's xdg-open opens documents, it does not run programs. Left
  // undefined elsewhere; the registry only routes to it on linux.
  launchApp: process.platform === 'linux' ? (p, args) => launchLinuxApp(p, args) : undefined,
  // Run a user-configured script (the runScript action), in a visible or hidden
  // window where the platform has the concept. The path is validated to a real
  // script in the registry before it reaches here.
  runScript: (p, hidden) => runUserScript(p, hidden),
  // Resolve a folder target (the app's install dir) to its launch executable, so
  // a Deck "open app" key pointed at a folder (e.g. Discord's) still launches.
  resolveAppDir: (p) => resolveExecInDir(p),
  // Launch a Store/UWP app by AppUserModelID (shell:AppsFolder\<aumid>). The AUMID is
  // validated in the registry before reaching this dep. Left undefined off
  // Windows: there is no UWP anywhere else, and the registry turns a missing
  // dep into a clean 'unavailable' rather than a failed spawn.
  openStoreApp: POWERSHELL_SUPPORTED
    ? (aumid) => runPowerShellScript(DECK_ACTIONS_SCRIPT, ['openapp', aumid], 8000)
    : undefined,
  mediaAction: (cmd) => mediaAction(cmd),
  mediaSeek: (position) => mediaSeek(position),
  micMute: async (mode) => {
    if (mode === 'mute') audioCache.muted = true;
    else if (mode === 'unmute') audioCache.muted = false;
    else audioCache.muted = !audioCache.muted;          // 'toggle'
    setMicMute(audioCache.muted);
    // Push it now rather than on the next 3s status tick, so a Deck key's face
    // follows the press on every screen (issue #139).
    broadcastStatusNow();
    return { muted: audioCache.muted };
  },
  volume: async (mode, value) => {
    if (!audioCache.speakerId) throw new Error('Cache not ready');
    if (mode === 'mute') return svvExec(['/Switch', audioCache.speakerId]);
    if (mode === 'up') return svvExec(['/ChangeVolume', audioCache.speakerId, '5']);
    if (mode === 'down') return svvExec(['/ChangeVolume', audioCache.speakerId, '-5']);
    // 'set': absolute 0–100 (already clamped by the registry) — slider keys.
    if (mode === 'set') return svvExec(['/SetVolume', audioCache.speakerId, String(value)]);
  },
  appVolume: async (app, mode, value) => {
    if (mode === 'set') return svvEachApp(app, '', (t) => ['/SetVolume', t, String(value)]);
    return svvEachApp(app, '', (t) => ['/ChangeVolume', t, mode === 'down' ? '-5' : '5']);
  },
  appMute: async (app, mode) => {
    const verb = mode === 'mute' ? '/Mute' : mode === 'unmute' ? '/Unmute' : '/Switch';
    return svvEachApp(app, '', (t) => [verb, t]);
  },
  // Switch the default OUTPUT device. The id is matched against the live
  // enumeration before it is used, and only against `speakers` — this is the
  // load-bearing check, not a formality: SoundVolumeView's /SetDefault takes
  // render and capture ids from the SAME namespace (they differ only by a
  // trailing \Render or \Capture), so an unchecked string would let a caller
  // change which MICROPHONE is live. That is a different and much worse
  // capability than "where does sound come out", and it is not on offer here.
  audioDevice: async (id) => {
    const wanted = String(id || '').trim();
    if (!wanted) return { ok: false, error: 'no_device' };
    let info;
    try { info = await getAudioInfo(); } catch { return { ok: false, error: 'audio_unavailable' }; }
    const match = resolveOutputDevice(wanted, info && info.speakers);
    if (!match) return { ok: false, error: 'unknown_device' };
    await setDefaultAudioDevice(match.id);
    audioCache.speakerId = match.id;
    audioCache.speakerName = match.name || audioCache.speakerName;
    return { ok: true };
  },
  // Flip between two outputs. Which one is decided against the live list, so a
  // key pressed right after the output was changed from the OS still goes the
  // right way; the same resolveOutputDevice check guards both ids.
  audioDeviceToggle: async (a, b) => {
    let info;
    try { info = await getAudioInfo(); } catch { return { ok: false, error: 'audio_unavailable' }; }
    const match = pickToggleDevice(a, b, info && info.speakers);
    if (!match) return { ok: false, error: 'unknown_device' };
    await setDefaultAudioDevice(match.id);
    audioCache.speakerId = match.id;
    audioCache.speakerName = match.name || audioCache.speakerName;
    return { ok: true };
  },
  // The first output of an ordered list that is connected right now: headphones
  // when they are on, the speakers otherwise. Asked on Discord for a key that
  // ends a session on "my Bluetooth headphones if connected, else speakers".
  // Already the default: nothing is switched, so the sound does not drop out
  // for a change that changes nothing.
  audioDeviceFirst: async (ids) => {
    let info;
    try { info = await getAudioInfo(); } catch { return { ok: false, error: 'audio_unavailable' }; }
    const match = pickFirstConnected(ids, info && info.speakers);
    if (!match) return { ok: false, error: 'none_connected' };
    if (!match.isDefault) await setDefaultAudioDevice(match.id);
    audioCache.speakerId = match.id;
    audioCache.speakerName = match.name || audioCache.speakerName;
    return { ok: true };
  },
  // A Vitals meter marked done from a Deck key or a granted SDK widget: the
  // same locked write as a tap on the bar or telling Bit (vitals-ai-tools.js).
  vitalsRefill: (vital) => vitalsAiTools.run('refill_vital', { vital }, { read: () => hub.settings, update: updateVitalsSettings }),
  // Task-list mutations (the `tasks` action category). All go through writeTasks,
  // which normalises (assigns id/createdAt, caps text to 200, drops empties) and
  // broadcasts the updated `tasks` stream — so the Tasks tile and every granted
  // SDK widget (e.g. TTY // TODO) repaint together. Text/id are already trimmed +
  // length-capped by the registry's validateAction before we get here.
  taskAdd: async (text) => {
    // normalizeTask assigns a fresh id + createdAt
    await updateTasks((tasks) => ({ next: tasks.concat([{ text: String(text || '') }]) }));
    return { ok: true };
  },
  taskToggle: async (id) => {
    const r = await updateTasks((tasks) => {
      const task = tasks.find(t => t.id === id);
      if (!task) return { found: false };
      const completed = !task.completed;
      return { found: true, next: tasks.map(t => (t === task ? { ...t, completed, completedAt: completed ? new Date().toISOString() : null } : t)) };
    });
    return r.found ? { ok: true } : { ok: false, error: 'not_found' };
  },
  taskDelete: async (id) => {
    const r = await updateTasks((tasks) => {
      const next = tasks.filter(t => t.id !== id);
      return next.length === tasks.length ? { found: false } : { found: true, next };
    });
    return r.found ? { ok: true } : { ok: false, error: 'not_found' };
  },
  // Countdown timers from a Deck key — the SAME list the Timers tile and
  // /api/timers manage, addressed by label (case-insensitive). Each mutation
  // persists atomically and broadcasts `timer_update`, so tile, key faces and
  // other dashboards stay in sync. secs is already clamped by the registry.
  timers: {
    labels: () => timerState.list.map((t) => t.label),
    start: async (label, secs) => {
      const idx = timerState.list.findIndex((t) => t.label.toLowerCase() === label.toLowerCase());
      if (idx >= 0) {
        // Same label → restart it with the requested duration (a deck key is a
        // "start my 5-minute tea timer" button, not an endless duplicate mill).
        timerState.list[idx] = { ...timerState.list[idx], durationSecs: secs, startedAt: Date.now(), pausedElapsed: 0, status: 'running' };
      } else {
        if (timerState.list.length >= TIMERS_MAX) return { ok: false, error: 'max_timers' };
        timerState.list.push(_normalizeTimer({ label, durationSecs: secs, status: 'running', startedAt: Date.now(), pausedElapsed: 0 }));
      }
      await _saveTimers();
      broadcastSSE('timer_update', { timers: timerState.list });
      return { ok: true };
    },
    // Same contract as start(), minus the duration: a key pressed twice
    // restarts the stopwatch from zero rather than stacking a second one, which
    // is what "start my task clock" means when you press it again.
    stopwatch: async (label, intervalSecs = 0) => {
      const idx = timerState.list.findIndex((t) => t.label.toLowerCase() === label.toLowerCase());
      if (idx >= 0) {
        timerState.list[idx] = { ...timerState.list[idx], kind: 'stopwatch', durationSecs: 0, intervalSecs, chimes: 0, startedAt: Date.now(), pausedElapsed: 0, status: 'running' };
      } else {
        if (timerState.list.length >= TIMERS_MAX) return { ok: false, error: 'max_timers' };
        timerState.list.push(_normalizeTimer({ label, kind: 'stopwatch', intervalSecs, status: 'running', startedAt: Date.now(), pausedElapsed: 0 }));
      }
      await _saveTimers();
      broadcastSSE('timer_update', { timers: timerState.list });
      return { ok: true };
    },
    toggle: async (label) => {
      const t = timerState.list.find((x) => x.label.toLowerCase() === label.toLowerCase());
      if (!t) return { ok: false, error: 'not_found' };
      if (t.status === 'running') {
        t.pausedElapsed += (Date.now() - t.startedAt) / 1000;
        t.status = 'paused';
      } else {
        // paused → resume; done → restart from the top (a natural key re-tap).
        if (t.status === 'done') t.pausedElapsed = 0;
        t.startedAt = Date.now();
        t.status = 'running';
      }
      await _saveTimers();
      broadcastSSE('timer_update', { timers: timerState.list });
      return { ok: true };
    },
    cancel: async (label) => {
      const before = timerState.list.length;
      timerState.list = timerState.list.filter((t) => t.label.toLowerCase() !== label.toLowerCase());
      if (timerState.list.length === before) return { ok: false, error: 'not_found' };
      await _saveTimers();
      broadcastSSE('timer_update', { timers: timerState.list });
      return { ok: true };
    },
  },
  // Send a keyboard shortcut to the app the user was last using. Tapping the
  // touchscreen gives focus to the dashboard, so the runner finds the window
  // beneath it in the Z-order and targets that (covers Zoom, Meet, Slack, …).
  // `keys` is already normalised by the registry to a safe token set.
  // Cross-platform since v4.11.0 — see sendHotkeyCombo. The Deck key that used
  // to be Windows-only now works on macOS (helper `keys`) and on a Linux
  // session that has xdotool or ydotool; where it cannot, `requires: 'keys'`
  // hides it in the editor instead of offering a key that always fails.
  sendHotkey: (keys) => sendHotkeyCombo(keys),
  // Type a literal snippet into that same target app (KEYEVENTF_UNICODE). The
  // text travels BASE64-encoded in a discrete argv value: PowerShell -File
  // binding treats a value that starts with '-' as a new parameter name, so a
  // snippet like "--force" or "- item" would otherwise break binding. Base64
  // can never start with '-' and round-trips newlines/quotes exactly. Longer
  // timeout: typing is paced per character.
  typeText: async (text) => {
    try {
      const b64 = Buffer.from(String(text), 'utf8').toString('base64');
      const r = await runPowerShellScript(DECK_HOTKEY_SCRIPT, ['-TypeTextB64', b64], 15000);
      return (r && r.ok === false) ? { ok: false, error: r.error || 'type_failed' } : { ok: true };
    } catch { return { ok: false, error: 'type_failed' }; }
  },
  obs: (requestType, requestData) => ensureObsRun(() => deckObs.request(requestType, requestData)),
  obsNext: () => ensureObsRun(() => deckObs.nextScene()),
  // Fire a Streamer.bot request over its WebSocket (DoAction / SendMessage /
  // ExecuteCodeTrigger). The whole validated payload is forwarded — `request` names
  // the type, the rest are its fields (action/args, platform/message/bot,
  // triggerName/args). The connection is lazy/idle-closed; an unreachable
  // streamer.bot surfaces as a clean {ok:false} via run().
  streamerbot: (r) => { const { request, ...payload } = r; return deckSb.request(request, payload); },
  // Deck LED reaction: drive the lighting hub via a TRANSIENT overlay that never
  // touches the user's persisted manual colour or animation. 'restore' removes the
  // overlay so the LEDs return to the user's own configured lighting (not a blank
  // default). No-op-safe: if lighting is disabled nothing renders. color/style are
  // already validated by the catalog.
  lighting: async (action) => {
    if (action.mode === 'restore') { lighting.clearDeckReaction(); return true; }
    return lighting.setDeckReaction(action.color, action.style);
  },
  // Whole-system lighting control from a Deck key / SDK action: master on/off,
  // fixed colour, ambient effect, per-device mode — the exact primitives the
  // Illuminazione settings use. Unlike the transient deck-reaction above, these
  // PERSIST (debounced) so a key that sets the rig purple survives a restart,
  // exactly like changing it in Settings. Never throws — degrades to {ok:false}.
  lightingControl: async (action) => {
    try {
      switch (action.type) {
        // Off means dark: every light, the map and the music colour included,
        // until a key or Settings switches them back on.
        case 'lightPower': {
          const lit = lighting.getStatus().enabled && !lighting.isLightsOut();
          const on = action.state === 'on' ? true : action.state === 'off' ? false : !lit;
          lighting.setLightsOut(!on);
          lighting.setEnabled(on);
          try { await lighting.ensureConnected(); } catch {}
          break;
        }
        // What a key sets wins over the music and temperature colours until the
        // lights are switched off (or set back to automatic) from a key.
        case 'lightColor':  if (lighting.setManualColor(action.color) === false) return { ok: false, error: 'bad_color' }; lighting.holdKeyLook({ wholeRig: true }); break;
        case 'lightAuto':   lighting.releaseKeyLook(); lighting.clearManual(); break;
        case 'lightEffect': if (lighting.setAnimation({ style: action.style, color: action.color }) === false) return { ok: false, error: 'bad_effect' }; lighting.holdKeyLook({ wholeRig: true }); break;
        case 'lightDevice': {
          const patch = { mode: action.mode };
          if (action.color) patch.color = action.color;
          if (lighting.setDeviceMode(action.device, patch) === false) return { ok: false, error: 'bad_device' };
          lighting.holdKeyLook();
          break;
        }
        case 'lightPart': {
          // One part of a device's map (a fan, the pump, a strip): a colour, or
          // back to Xenon when no colour is given.
          const look = typeof action.color === 'string' && action.color ? action.color : null;
          if (lighting.setPartLook(String(action.device || ''), Number(action.part), look) === false) return { ok: false, error: 'bad_part' };
          break;
        }
        default: return { ok: false, error: 'bad_lighting' };
      }
      _persistLighting();
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  // Home Assistant device control (toggle/scene/call_service). The provider owns
  // the lazy WS socket and re-validates the entity/service; an unreachable or
  // unconfigured HA surfaces as a clean {ok:false} via run().
  homeAssistant: (action) => deckHa.runAction(action),
  // Razer Chroma per-device lighting. Gated on the opt-in flag so a disabled
  // integration never opens a Chroma session; the provider degrades to {ok:false}
  // when Synapse/Chroma isn't running.
  chroma: async (action) => {
    const s = (await readHubSettings().catch(() => null)) || {};
    if (!(s.chroma && s.chroma.enabled === true)) return { ok: false, error: 'chroma_disabled' };
    return deckChroma.runAction(action);
  },
  // Elgato Wave Link mixer control. The provider's connect() reads the enabled
  // flag from live settings and rejects when off, so a disabled integration
  // surfaces as a clean {ok:false} (no localhost probe) via run().
  waveLink: (action) => deckWaveLink.runAction(action),
  // Voicemeeter strips, buses and routing. The client owns the session and the
  // edition check; a machine without Voicemeeter answers a named error rather
  // than throwing.
  voicemeeter: (action) => deckVoicemeeter.runAction(action),
  // Move/snap/minimise the foreground window (a discrete allowlisted verb passed
  // as a single argv element to the window helper — never a shell string).
  windowAction: async (verb) => {
    try {
      const r = await runPowerShellScript(DECK_WINDOW_SCRIPT, [verb], 6000);
      return (r && r.ok === false) ? { ok: false, error: r.error || 'window_failed' } : { ok: true };
    } catch { return { ok: false, error: 'window_failed' }; }
  },
  // SDK widget macro resolver: "pkg/macroId" → the macro's validated steps, or
  // null. Steps come from the NORMALIZED manifest (rebuilt through the shared
  // catalog validator, restricted to the SDK's low-risk action types) and are
  // released only when the user granted the package every category the macro
  // touches — the same consent surface as the bridge actions.
  sdkMacro: async (pkgId, macroId) => {
    const scan = await sdkPackagesCached();
    const pkg = scan.packages.find(p => p.id === pkgId);
    const macro = pkg && pkg.deck && pkg.deck.actions.find(a => a.id === macroId);
    if (!macro) return null;
    const granted = sdkGrantsFor(pkgId).actions;
    if (!sdkWidgets.macroCategories(macro).every(cat => granted.includes(cat))) return null;
    // Defense in depth: re-filter to the SDK type allowlist even though the
    // manifest normalizer already enforced it.
    return macro.steps.filter(s => sdkWidgets.SDK_MACRO_ACTION_TYPES.includes(s.action.type));
  },
  // SDK handler action: "pkg/handlerId" pressed on a deck key → validate the
  // declaration + per-handler grant, coerce the key's stored args against the
  // handler's declared params, then broadcast to the package's live frames and
  // wait for the first ack (or time out with an honest no_frame error). Rate
  // gate shared with hooks: one dispatch per pkg/handler per 250ms. A release
  // has its own lane, so a quick press-and-let-go still reaches the widget.
  sdkHandler: async (pkgId, handlerId, argsJson, gesture) => {
    if (!sdkFeatureEnabled()) return { ok: false, error: 'sdk_disabled' };
    const scan = await sdkPackagesCached();
    const pkg = scan.packages.find(p => p.id === pkgId);
    const handler = pkg && pkg.deck && Array.isArray(pkg.deck.handlers) && pkg.deck.handlers.find(h => h.id === handlerId);
    if (!handler) return { ok: false, error: 'handler_unavailable' };
    if (!sdkGrantsFor(pkgId).handlers.includes(handlerId)) return { ok: false, error: 'not_granted' };
    const lane = gesture && gesture.type === 'release' ? ':release' : '';
    if (!sdkHookGateOk('handler:' + pkgId + '/' + handlerId + lane)) return { ok: false, error: 'rate_limited' };
    const args = sdkWidgets.validateHandlerArgs(handler, argsJson);
    if (args === null) return { ok: false, error: 'bad_args' };
    return sdkHandlerDispatch(pkgId, handlerId, args, gesture);
  },
  // Claude Code: start a run from a Deck key, or stop the one going. Both go
  // through the SAME runner as the touchscreen panel, so the project id is
  // re-checked against the server-built allowlist on every press and the run
  // uses normal permission mode — a key can start work, never authorise it.
  // Deliberately declared here rather than as a thin wrapper elsewhere: the
  // registry is the single execution boundary and these are its side effects.
  claudeRun: (opts) => _claudeRunner.start({
    projectId: String((opts && opts.projectId) || ''),
    prompt: String((opts && opts.prompt) || ''),
    model: String((opts && opts.model) || ''),
    resume: '',
  }),
  // Stops the newest run still going. "Newest" because a key press means "stop
  // what I just started"; with nothing running it reports false so the key can
  // say so rather than claiming it worked.
  claudeStop: () => {
    const running = _claudeRunner.snapshot().filter(r => r.state === 'running');
    if (!running.length) return false;
    return _claudeRunner.stop(running[running.length - 1].id);
  },
  // The paired phone. Both go through phone.js rather than the helper directly,
  // so a Deck key and the widget hit exactly the same validation, the same
  // number normalisation and the same refusal reasons.
  phoneDial: (number) => phone.dial(number),
  phoneSend: (number, text) => phone.sendMessage(number, text),
  runCapability: (action) => capabilityRunner.run(action),
  // Anonymous per-type counter; record() is a no-op while usageStats is off.
  countCapability: (action, result) => usageStats.recordCapability(action, result),
  // remote: injected below once remoteControl is created (see createRemoteControl call)
};
const deckRegistry = createRegistry(deckRegistryDeps);
usageStats.configure({
  dataDir: DATA_DIR,
  enabled: () => !!(hub.settings && hub.settings.usageStats === true),
});

const { tilePlay } = require('./windows-tiles/tile-play-offers.js');

const readDeckConfigs = async () => (await readDeckStore()).configs;
const { resolveDeckSoundFile } = require('./deck/sound-file.js');

const deckShortcutRunner = createDeckShortcutRunner({
  readConfigs: readDeckConfigs,
  steps: require('./js/deck-actions.js').triggerSteps,
  run: (action) => deckRegistry.run(action),
  broadcast: (event, data) => broadcastSSE(event, data),
  // With no dashboard the PC plays the key's clip itself (deck-sound-player.js).
  soundPlayer: createDeckSoundPlayer({
    platform: process.platform,
    resolveFile: resolveDeckSoundFile,
    ffplay: findFfplay,
    spawn,
  }),
  serverFirst: () => UsageMode.widgetsOnly(hub.settings && hub.settings.usageMode),
});

// The Deck keys placed on the screen (js/layer-key.js).
const deckPress = createDeckPress({
  layers: { get: () => hub.settings && hub.settings.layers, update: (edit) => updateLayersSetting(edit) },
  readConfigs: readDeckConfigs,
  runner: deckShortcutRunner,
});

// ffplay ships next to ffmpeg in the usual builds (winget, Homebrew, distros).
async function findFfplay() {
  const ff = getFfmpegPath();
  if (!path.isAbsolute(ff)) return process.platform === 'win32' ? 'ffplay.exe' : 'ffplay';
  const candidate = path.join(path.dirname(ff), path.basename(ff).replace(/ffmpeg/i, 'ffplay'));
  try { await fs.promises.access(candidate); return candidate; } catch { return ''; }
}

const { perfSession } = require('./perf-session/engine-session.js');
const widgetOptionsStore = require('./widget-options/index.js').createWidgetOptions({
  dataDir: DATA_DIR, packages: async () => (await sdkPackagesCached()).packages, announce: (pkg) => broadcastSSE('sdk_options', { pkg }),
});

const { perfStats } = require('./performance/perf-stats.js');

const { perfRegistry } = require('./performance/engine-registry.js');

const { readBody, readBodyBuffer } = require('./http/read-body.js');


const { listScreens } = require('./screens/list-screens.js');

const { _duckSpeakerVolume } = require('./audio/speaker-duck.js');

const { stopServerSpeak } = require('./ai/speak-play.js');

const { _sessionWatch } = require('./platform/session-watch-lights.js');
const { _syncSessionWatch } = require('./platform/session-watch-sync.js');

const { aiStoppedReply } = require('./ai/stopped-reply.js');

// Every tool the assistant runs, marked on the turn the chat is waiting for.
async function executeAiTool(fnName, fnArgs, deps) {
  aiTurns.checkpoint(); // the user pressed stop: nothing more runs
  aiTurns.toolStart(fnName);
  try {
    const out = await runAiTool(fnName, fnArgs, deps);
    aiTurns.record(out && out.clientActions);
    return out;
  } finally {
    aiTurns.toolEnd(fnName);
  }
}

const { branches: storeCatalogToolsBranches } = require('./store-catalog/tools.js');
const { branches: aiToolsBranches } = require('./ai/tools.js');
const { branches: widgetSdkToolsBranches } = require('./widget-sdk/tools.js');
const { branches: aiToolsPresetsBranches } = require('./ai/tools-presets.js');
const { branches: aiToolsMemoryBranches } = require('./ai/tools-memory.js');
const { branches: aiToolsPcBranches } = require('./ai/tools-pc.js');
const { branches: aiToolsWebBranches } = require('./ai/tools-web.js');
const { branches: deckToolsBranches } = require('./deck/tools.js');
const { branches: systemToolsBranches } = require('./system/tools.js');
const { branches: audioToolsBranches } = require('./audio/tools.js');
const { branches: mediaToolsBranches } = require('./media/tools.js');
const { branches: lightsToolsBranches } = require('./lights/tools.js');
const { branches: weatherToolsBranches } = require('./weather/tools.js');
const { branches: tickerToolsBranches } = require('./ticker/tools.js');
const { branches: settingsToolsBranches } = require('./settings/tools.js');
const { branches: timeToolsNotesBranches } = require('./time/tools-notes.js');
const { branches: timeToolsTasksBranches } = require('./time/tools-tasks.js');
const { branches: timeToolsCalendarBranches } = require('./time/tools-calendar.js');
const { branches: timeToolsTimersBranches } = require('./time/tools-timers.js');
const { branches: searchToolsBranches } = require('./search/tools.js');
const { branches: diskToolsBranches } = require('./disk/tools.js');
const { branches: streamingToolsBranches } = require('./streaming/tools.js');
const { branches: smartHomeToolsBranches } = require('./smart-home/tools.js');
const { branches: storeCatalogToolsRatingBranches } = require('./store-catalog/tools-rating.js');
const { branches: discordToolsBranches } = require('./discord/tools.js');
const { branches: aiToolsKnowledgeBranches } = require('./ai/tools-knowledge.js');

async function runAiTool(fnName, fnArgs, deps) {
  const {
    apiKey, uiLang, latestUserText,
    latestLooksLikeClothingWeather, latestExplicitlyWantsScreen,
    provider, pictures = [], surface = '', remote = false,
  } = deps;
  const clientActions = [];
  let pendingScreenImage = null;
  let fnResult;

  // Asked from a paired phone, Bit can do what the phone can (remote-actions.js):
  // no tool may hand the registry an action the phone could not run itself.
  const phoneRefusal = (error) => ({ ok: false, error, hint: 'A paired device cannot run this: say it has to be done at the PC, or from a Deck key the user set up there.' });
  const runAction = async (action) => {
    const verdict = remote ? remoteActions.remoteMayRun(action, await readDeckStore()) : null;
    return verdict && !verdict.ok ? phoneRefusal(verdict.error) : deckRegistry.run(action);
  };
  if (remote && remoteActions.PC_ONLY_TOOLS.has(fnName)) {
    return { fnResult: phoneRefusal('pc_only'), clientActions, pendingScreenImage };
  }

  // show_lock_screen is the pre-v4.4 name for start_ambient_mode — kept as an
  // alias so old AI memories/prompts keep working.
  const CLIENT_ACTIONS = new Set(['open_weather_panel', 'open_settings', 'open_app_switcher', 'open_sparks_shop', 'open_store_entry', 'open_whats_new', 'show_lock_screen', 'start_ambient_mode', 'stop_ambient_mode', 'change_theme', 'close_ai_panel', 'refresh_tasks', 'refresh_calendar', 'refresh_timers', 'go_to_page', 'switch_deck_profile', 'optimize_performance', 'restore_performance', 'customize_appearance', 'style_tile', 'create_dashboard_style', 'create_animated_background', 'configure_preferences', 'set_media_source', 'genesis_compose_page', 'genesis_add_widgets', 'genesis_duplicate_widget', 'genesis_remove_page', 'genesis_setup_deck', 'configure_deck']);

  if (CLIENT_ACTIONS.has(fnName)) {
    const widgetsOnly = UsageMode.widgetsOnly(hub.settings && hub.settings.usageMode);
    const refused = aiSurface.clientActionRefusal(fnName, surface, widgetsOnly);
    if (refused) {
      if (surface === 'screen') broadcastSSE('needs_dashboard', {});
      return { fnResult: refused, clientActions, pendingScreenImage };
    }
    const miss = fnName === 'go_to_page' ? goToPageMiss(fnArgs)
      : fnName === 'style_tile' ? TileMaterial.requestMiss(fnArgs) : null;
    if (miss) return { fnResult: miss, clientActions, pendingScreenImage };
    // No dashboard: the driver page's Performance Mode does it (js/driver-perf.js)
    // and its card on the screen says how it went.
    const perfChoice = aiSurface.screenPerfChoice(fnName, surface, widgetsOnly);
    if (perfChoice) {
      broadcastSSE('perf_screen', perfScreen.screenEvent({ kind: 'answer', choice: perfChoice }));
      return { fnResult: { ok: true }, clientActions, pendingScreenImage };
    }
    clientActions.push({ action: fnName, args: fnArgs });
    fnResult = { ok: true };
    return { fnResult, clientActions, pendingScreenImage };
  }

  try {
    if (fnName === 'create_widget') {
      fnResult = await widgetSdkToolsBranches['create_widget']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { aiPresetDeps, installWidgetPayload, sdkFeatureEnabled, trialVault, widgetExportable });
    } else if (fnName === 'my_widgets') {
      fnResult = await widgetSdkToolsBranches['my_widgets']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { refreshSdkScan, widgetExportable });
    } else if (fnName === 'preset_reference') {
      fnResult = await aiToolsPresetsBranches['preset_reference']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { aiPresetDeps });
    } else if (fnName === 'create_preset') {
      fnResult = await aiToolsPresetsBranches['create_preset']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { aiPresetDeps });
    } else if (capabilities.aiAction(fnName, fnArgs)) {
      // A catalog capability: the call becomes its Deck action and runs through
      // the same allowlisted registry as a key press.
      fnResult = await runAction(capabilities.aiAction(fnName, fnArgs));
      // The text read off the screen reaches the AI only: screen-text.js keeps
      // it out of the action's result, which a paired phone can receive.
      // "picking": a picker is already open, so any text kept is an older read's.
      if (fnName === 'read_screen_text' && fnResult && fnResult.ok === true && !fnResult.cancelled && !fnResult.picking) {
        const read = require('./capabilities/screen-text.js').takeText();
        if (read) fnResult = { ...fnResult, text: read.text, ...(read.cut ? { cut: true } : {}) };
      }
      // The steps recorder's sentences, likewise (capabilities/steps.js).
      if (fnName === 'record_steps' && fnResult && fnResult.ok === true && fnResult.saved === true) {
        const steps = require('./capabilities/steps.js').takeSteps();
        if (steps) fnResult = { ...fnResult, steps };
      }
      // A recording's words, likewise: the action's result carries counts and
      // chapters, the lines with their times reach this turn only.
      if (fnName === 'transcribe_recording' && fnResult && fnResult.ok === true && !fnResult.working) {
        const t = await _transcripts.read(String(fnResult.id || ''));
        if (t) {
          const said = TranscriptFormat.aiText(t.lines);
          fnResult = { ...fnResult, text: said.text, ...(said.cut ? { cut: true } : {}) };
        }
      }
      // A copy for sharing: the key answers at once, Bit's turn waits for the
      // copy so it can say how big it came out.
      if (fnName === 'export_capture' && fnResult && fnResult.ok === true && fnResult.working) {
        const end = await require('./capabilities/export.js').waitFor(fnResult.id);
        if (end && end.ok === false) fnResult = end;
        else if (end && end.ok) fnResult = { ok: true, id: fnResult.id, name: fnResult.name, kind: fnResult.kind, ...end };
      }
    } else if (fnName === 'deck_action_catalog') {
      fnResult = await deckToolsBranches['deck_action_catalog']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText });
    } else if (fnName === 'xenon_knowledge') {
      fnResult = await aiToolsKnowledgeBranches['xenon_knowledge']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText });
    } else if (fnName === 'sdk_reference') {
      fnResult = await widgetSdkToolsBranches['sdk_reference']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText });
    } else if (fnName === 'marketplace_search') {
      fnResult = await storeCatalogToolsBranches['marketplace_search']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText });
    } else if (fnName === 'marketplace_install') {
      fnResult = await storeCatalogToolsBranches['marketplace_install']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText });
    } else if (fnName === 'open_virtual_deck') {
      fnResult = await deckToolsBranches['open_virtual_deck']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { openDeckPopupWindow });
    } else if (fnName === 'guardian_report') {
      fnResult = await systemToolsBranches['guardian_report']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { guardian });
    } else if (fnName === 'query_sensor_history') {
      fnResult = await systemToolsBranches['query_sensor_history']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { guardian });
    } else if (fnName === 'remember_fact') {
      fnResult = await aiToolsMemoryBranches['remember_fact']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { aiMemory });
    } else if (fnName === 'forget_fact') {
      fnResult = await aiToolsMemoryBranches['forget_fact']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { aiMemory });
    } else if (fnName === 'toggle_mic') {
      fnResult = await audioToolsBranches['toggle_mic']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { setMicMute });
    } else if (fnName === 'mute_mic') {
      fnResult = await audioToolsBranches['mute_mic']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { setMicMute });
    } else if (fnName === 'unmute_mic') {
      fnResult = await audioToolsBranches['unmute_mic']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { setMicMute });
    } else if (fnName === 'media_playpause') {
      fnResult = await mediaToolsBranches['media_playpause']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { mediaAction });
    } else if (fnName === 'media_next') {
      fnResult = await mediaToolsBranches['media_next']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { mediaAction });
    } else if (fnName === 'media_previous') {
      fnResult = await mediaToolsBranches['media_previous']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { mediaAction });
    } else if (fnName === 'set_volume') {
      fnResult = await audioToolsBranches['set_volume']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { svvExec });
    } else if (fnName === 'toggle_speaker_mute') {
      fnResult = await audioToolsBranches['toggle_speaker_mute']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { svvExec });
    } else if (fnName === 'set_mic_volume') {
      fnResult = await audioToolsBranches['set_mic_volume']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { svvExec });
    } else if (fnName === 'lock_pc') {
      fnResult = await aiToolsPcBranches['lock_pc']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText });
    } else if (vitalsAiTools.NAMES.includes(fnName)) {
      fnResult = await vitalsAiTools.run(fnName, fnArgs, { read: () => hub.settings, update: updateVitalsSettings });
    } else if (fnName === 'capture_screen') {
      if (latestLooksLikeClothingWeather && !latestExplicitlyWantsScreen) {
        const weatherForAdvice = await getWeather(uiLang, null).catch(e => ({ error: e.message }));
        fnResult = {
          error: 'screen_capture_not_requested',
          instruction: 'The latest request is about weather/clothing, not screen vision. Do not ask which monitor. Use the included weather data and answer what the user should wear.',
          weather: weatherForAdvice,
          latest_user_text: latestUserText,
        };
      } else {
        const screens = await listScreens();
        const reqMon = fnArgs.monitor != null ? parseInt(fnArgs.monitor) - 1 : -1;
        if (screens.length > 1 && (reqMon < 0 || reqMon >= screens.length)) {
          // Ambiguous on a multi-monitor setup — show a clickable picker in the UI
          // and let Gemini inform the user verbally at the same time.
          clientActions.push({
            action: 'show_monitor_picker',
            args: {
              screens: screens.map((s, i) => ({
                index: i + 1, primary: s.primary,
                width: s.width, height: s.height,
                x: s.x, y: s.y,
              })),
            },
          });
          fnResult = {
            needs_monitor_choice: true,
            monitor_count: screens.length,
            monitors: screens.map((s, i) => ({ number: i + 1, primary: s.primary, resolution: `${s.width}x${s.height}` })),
          };
        } else {
          const target = screens.length === 1 ? screens[0]
            : (reqMon >= 0 ? screens[reqMon] : (screens.find(s => s.primary) || screens[0]));
          try {
            pendingScreenImage = await captureScreenshot(target);
            fnResult = { ok: true, captured: true, monitor: screens.indexOf(target) + 1, resolution: `${target.width}x${target.height}` };
          } catch (capErr) {
            fnResult = { error: 'capture failed: ' + capErr.message };
          }
        }
      }
    } else if (fnName === 'get_system_info') {
      fnResult = await systemToolsBranches['get_system_info']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { getSystemInfo });
    } else if (fnName === 'set_lights') {
      fnResult = await lightsToolsBranches['set_lights']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText });
    } else if (fnName === 'clear_lights') {
      fnResult = await lightsToolsBranches['clear_lights']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText });
    } else if (fnName === 'set_effect') {
      fnResult = await lightsToolsBranches['set_effect']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { _persistLighting });
    } else if (fnName === 'set_event_effect') {
      fnResult = await lightsToolsBranches['set_event_effect']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { _persistLighting });
    } else if (fnName === 'set_animation') {
      fnResult = await lightsToolsBranches['set_animation']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { _persistLighting });
    } else if (fnName === 'set_lighting_bridge') {
      fnResult = await lightsToolsBranches['set_lighting_bridge']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { _persistLighting });
    } else if (fnName === 'show_sensor') {
      fnResult = await systemToolsBranches['show_sensor']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { getSystemInfo });
    } else if (fnName === 'get_battery_status') {
      fnResult = await systemToolsBranches['get_battery_status']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { batteryMonitor });
    } else if (fnName === 'get_energy_status') {
      fnResult = await systemToolsBranches['get_energy_status']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { buildHaState, getSystemInfo });
    } else if (fnName === 'get_weather') {
      fnResult = await weatherToolsBranches['get_weather']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { getWeather });
    } else if (fnName === 'get_stock_quote') {
      fnResult = await tickerToolsBranches['get_stock_quote']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { _stocksProviderOpts });
    } else if (fnName === 'get_stock_watchlist') {
      fnResult = await tickerToolsBranches['get_stock_watchlist']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { refreshStocks });
    } else if (fnName === 'add_stock_favorite') {
      fnResult = await tickerToolsBranches['add_stock_favorite']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { hub, readHubSettingsForUpdate, refreshStocks, withHubSettingsLock, writeHubSettings });
    } else if (fnName === 'edit_favorites') {
      fnResult = await tickerToolsBranches['edit_favorites']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { editFavorites });
    } else if (fnName === 'change_setting') {
      fnResult = await settingsToolsBranches['change_setting']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { changeSetting });
    } else if (fnName === 'sensor_source') {
      fnResult = await systemToolsBranches['sensor_source']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { chooseSensorSource });
    } else if (fnName === 'set_creation_model') {
      fnResult = await settingsToolsBranches['set_creation_model']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { hub, readHubSettingsForUpdate, withHubSettingsLock, writeHubSettings });
    } else if (fnName === 'get_football_scores') {
      fnResult = await tickerToolsBranches['get_football_scores']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { refreshFootball });
    } else if (fnName === 'get_league_standings') {
      fnResult = await tickerToolsBranches['get_league_standings']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { _footballOpts, refreshFootball });
    } else if (fnName === 'get_news_headlines') {
      fnResult = await tickerToolsBranches['get_news_headlines']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { _newsOpts, refreshNews });
    } else if (fnName === 'web_search') {
      fnResult = await aiToolsWebBranches['web_search']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { _geminiWebSearch });
    } else if (fnName === 'read_notes') {
      fnResult = await timeToolsNotesBranches['read_notes']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { readNotes });
    } else if (fnName === 'edit_note') {
      fnResult = await timeToolsNotesBranches['edit_note']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { aiActionLog, readNotes, writeNotes });
    } else if (fnName === 'write_notes') {
      fnResult = await timeToolsNotesBranches['write_notes']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { aiActionLog, readNotes, writeNotes });
    } else if (fnName === 'list_tasks') {
      fnResult = await timeToolsTasksBranches['list_tasks']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { readTasks });
    } else if (fnName === 'create_task') {
      fnResult = await timeToolsTasksBranches['create_task']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { aiActionLog, updateTasks });
    } else if (fnName === 'delete_task') {
      fnResult = await timeToolsTasksBranches['delete_task']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { updateTasks });
    } else if (fnName === 'clear_all_tasks') {
      fnResult = await timeToolsTasksBranches['clear_all_tasks']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { aiActionLog, updateTasks });
    } else if (fnName === 'edit_task') {
      fnResult = await timeToolsTasksBranches['edit_task']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { aiActionLog, updateTasks });
    } else if (fnName === 'complete_task') {
      fnResult = await timeToolsTasksBranches['complete_task']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { updateTasks });
    } else if (fnName === 'list_calendar_events') {
      fnResult = await timeToolsCalendarBranches['list_calendar_events']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { readEvents });
    } else if (fnName === 'create_calendar_event') {
      fnResult = await timeToolsCalendarBranches['create_calendar_event']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { updateEvents });
    } else if (fnName === 'play_in_tile') {
      fnResult = await mediaToolsBranches['play_in_tile']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { playInTile });
    } else if (fnName === 'edit_calendar_event') {
      fnResult = await timeToolsCalendarBranches['edit_calendar_event']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { aiActionLog, updateEvents });
    } else if (fnName === 'delete_calendar_event') {
      fnResult = await timeToolsCalendarBranches['delete_calendar_event']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { updateEvents });
    } else if (fnName === 'clear_all_calendar_events') {
      fnResult = await timeToolsCalendarBranches['clear_all_calendar_events']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { aiActionLog, updateEvents });
    } else if (fnName === 'open_application') {
      fnResult = await aiToolsPcBranches['open_application']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { hub, readDeckStore });
    } else if (fnName === 'close_application') {
      fnResult = await aiToolsBranches['close_application']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText });
    } else if (fnName === 'search_files') {
      fnResult = await searchToolsBranches['search_files']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { fileSearch });
    } else if (fnName === 'open_search_result') {
      fnResult = await searchToolsBranches['open_search_result']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { fileSearch });
    } else if (fnName === 'phone_lookup' || fnName === 'phone_call' || fnName === 'phone_message') {
      fnResult = await aiPhoneTool(fnName, fnArgs, latestUserText);
    } else if (fnName === 'disk_insights') {
      fnResult = await diskToolsBranches['disk_insights']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { diskSpace });
    } else if (fnName === 'start_timer') {
      fnResult = await timeToolsTimersBranches['start_timer']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { _saveTimers, timerState });
    } else if (fnName === 'control_timer') {
      fnResult = await timeToolsTimersBranches['control_timer']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { _saveTimers, timerState });
    } else if (fnName === 'list_timers') {
      fnResult = await timeToolsTimersBranches['list_timers']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { timerState });
    } else if (fnName === 'delete_timer') {
      fnResult = await timeToolsTimersBranches['delete_timer']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { _saveTimers, timerState });
    } else if (fnName === 'app_audio') {
      fnResult = await audioToolsBranches['app_audio']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText });
    } else if (fnName === 'obs_control') {
      fnResult = await streamingToolsBranches['obs_control']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText });
    } else if (fnName === 'twitch_action') {
      fnResult = await streamingToolsBranches['twitch_action']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText });
    } else if (fnName === 'youtube_broadcast') {
      fnResult = await streamingToolsBranches['youtube_broadcast']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText });
    } else if (fnName === 'streamerbot_action') {
      fnResult = await streamingToolsBranches['streamerbot_action']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText });
    } else if (fnName === 'spotify_control') {
      fnResult = await streamingToolsBranches['spotify_control']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { streams });
    } else if (fnName === 'home_assistant') {
      fnResult = await smartHomeToolsBranches['home_assistant']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { deckHa });
    } else if (fnName === 'discord_voice') {
      fnResult = await discordToolsBranches['discord_voice']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { discordLink });
    } else if (fnName === 'list_audio_devices') {
      fnResult = await audioToolsBranches['list_audio_devices']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { getAudioInfo });
    } else if (fnName === 'set_audio_device') {
      fnResult = await audioToolsBranches['set_audio_device']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { getAudioInfo, setDefaultAudioDevice, setMicMute });
    } else if (fnName === 'rate_store_item') {
      fnResult = await storeCatalogToolsRatingBranches['rate_store_item']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { _deckConfirms, hub, ratingVotes });
    } else if (fnName === 'run_deck_action') {
      fnResult = await deckToolsBranches['run_deck_action']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { _deckConfirms, deckRegistry, hub, readDeckStore });
    } else if (fnName === 'run_pc_command') {
      fnResult = await aiToolsPcBranches['run_pc_command']({ fnName, fnArgs, clientActions, runAction, phoneRefusal, provider, remote, pictures, uiLang, surface, apiKey, latestUserText }, { _pcControlEnabled });
    } else {
      fnResult = { error: 'unknown_function' };
    }
  } catch (fnErr) {
    fnResult = { error: fnErr.message };
  }

  return { fnResult, clientActions, pendingScreenImage };
}



const { getFfmpegPath } = require('./ffmpeg-install/ffmpeg-path.js');

const { captureScreenshot } = require('./screens/capture-screenshot.js');

const { mcpDevCapture } = require('./mcp/dev-capture.js');

const { transcodeMp4BackgroundToWebm } = require('./look/background-to-webm.js');

const { refreshMacFdaState, refreshLivingIndex } = require('./search/living-index-roots.js');

const { setDefaultAudioDevice } = require('./audio/default-device.js');

const { goToPageMiss } = require('./grid/go-to-page-miss.js');

const { _overlayHotkey } = require('./widget-options/overlay-hotkey.js');

const { sensorRateMs } = require('./system/sensor-rate.js');

const { collectSensors, readChosenSensors } = require('./system/sensors-read.js');

const { getCpuTemp } = require('./system/cpu-temp.js');

const { getGpuInfo } = require('./system/gpu-read.js');

const {
  sdkFeatureEnabled, sdkPkgSuspended, sdkGrantsFor, sdkStreamGranted, _sdkStreamGranted,
} = require('./widget-sdk/grants.js');

const { aiPresetDeps } = require('./grid/ai-preset-deps.js');

const { providerModelFor } = require('./ai/provider-models.js');

const { _pcControlEnabled } = require('./ai/pc-control-switch.js');

// In-memory mirror of the hub settings — the wake loop reads it on every clip and
// must not hit the disk that often. Populated at startup and on every POST.
hub.settings = { ...DEFAULT_HUB_SETTINGS };

const { settingsBoot } = require('./settings/boot-state.js');

const { gameSessionsEnabled } = require('./performance/game-sessions-switch.js');

const { geminiKeyFor } = require('./ai/gemini-key-for.js');

const { smallTaskModel } = require('./ai/small-task-model.js');

const {
  userAiBlocker, userAiVisionBlocker, lyricsTranslateBlocker,
} = require('./ai/user-ai-blockers.js');

const { backupSupersededLayout } = require('./grid/layout-backup.js');

const { writeHubSettings } = require('./settings/write.js');

const { getSlideshowDir } = require('./windows-tiles/slideshow-dir.js');

const { withHubSettingsLock } = require('./settings/write-lock.js');

const { chooseSensorSource } = require('./system/choose-sensor-source.js');

const { _flushLightingPersist, _persistLighting } = require('./lights/persist.js');

const { dropSdkGrant, saveSdkGrant } = require('./widget-sdk/grant-save.js');

const {
  updateVitalsSettings, updateGameSessionsSetting, updatePerfHudSetting, updateHubSettingKey,
  updateAiEdgeGlowSetting,
} = require('./settings/change-one.js');

const { noteUsageDay } = require('./settings/count-usage-day.js');

// One read-modify-write of hubSettings.layers for the capability runner (AI,
// Deck keys): the edit sees the committed value, and nothing is written when it
// returns { error }. Open surfaces re-hydrate from the settings broadcast.
// The shortcuts the layers own: the overlay's, the menu's and the widgets' keys.
function _layerHotkeys() {
  return [_overlayHotkey(), _menuHotkey(), ..._widgetKeys.bindings().map((b) => b.widgetId + '=' + b.combo)].join('|');
}

async function updateLayersSetting(edit) {
  return withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const res = edit(cur.layers);
    if (!res || res.error || !res.layers) return res || { error: 'failed' };
    const keys = _layerHotkeys();
    const saved = await writeHubSettings({ ...cur, layers: res.layers, rev: nextSettingsRev(cur.rev) });
    hub.settings = saved;
    broadcastSSE('settings', { rev: saved.rev });
    layersEdit.touch(saved.layers);
    // A rule just written acts now, not on the next tick.
    setImmediate(broadcastStatusNow);
    // The first overlay widget arms the overlay shortcut, the last one frees it;
    // a new menu shortcut takes the place of the old one.
    if (_layerHotkeys() !== keys) { try { refreshHotkeyListener(); } catch { /* the next save retries */ } }
    return { ...res, layers: saved.layers };
  });
}

// The recording options (capture-settings.js): `change` from the Settings pane
// or the AI; `folder` is only ever a path the folder dialog returned and the
// checks passed, or '' for the default. Returns the saved options.
// `folders`: { folder, shotFolder, benchFolder }, each a checked path or '' for
// the default; a key left out keeps its folder.
async function updateCaptureSettings(change, folders = {}) {
  return withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const { next } = CaptureSettings.applyCaptureChange(cur.capture, change);
    for (const key of CaptureSettings.FOLDER_KEYS) {
      if (folders && typeof folders[key] === 'string') next[key] = folders[key];
    }
    const replayKey = _replayHotkey();
    const saved = await writeHubSettings({ ...cur, capture: next, rev: nextSettingsRev(cur.rev) });
    hub.settings = saved;
    broadcastSSE('settings', { rev: saved.rev });
    // Instant Replay follows its switch, length and look right away.
    try { _replay.sync(); } catch { /* before startup: the first status tick syncs it */ }
    // Turning the replay on arms its save shortcut, off frees it.
    if (_replayHotkey() !== replayKey) { try { refreshHotkeyListener(); } catch { /* the next save retries */ } }
    return saved.capture;
  });
}

// For the length row in Settings: bytes per second the replay ring takes with
// these options (the engine's own formula on the main screen, or the real
// rate while it runs) and the free space where the ring lives.
async function replayDiskInfo(o) {
  const out = {};
  try {
    const s = _replay.status();
    let bitrate = s.on ? s.bitrate : 0;
    if (!bitrate && _captureHost.available()) {
      const r = await _captureHost.request('monitors', {}, { timeoutMs: 5000 });
      const list = (r && Array.isArray(r.monitors)) ? r.monitors : [];
      const main = list.find((m) => m && m.primary) || list[0];
      if (main) bitrate = estimateBitrate(main, o);
    }
    if (bitrate > 0) out.replayBytesPerSecond = ringByteRate(bitrate, { sound: o.replayAudio !== 'silent' });
  } catch { /* no estimate: the row shows the length alone */ }
  try {
    if (typeof fs.promises.statfs === 'function') {
      const st = await fs.promises.statfs(os.tmpdir());
      out.replayFreeBytes = Number(st.bavail) * Number(st.bsize);
    }
  } catch { /* unknown */ }
  return out;
}

const { captureOptions } = require('./screens/capture-options.js');

const { _replayHotkey } = require('./screens/replay-hotkey.js');

const { _comboHeldBy, _deckShortcutStatus } = require('./deck/shortcut-questions.js');

const { _appAudioAvailable } = require('./audio/app-audio-available.js');

// What the Xenon menu shows (xenon-menu.js): read from the settings and the
// runtime state, never a path, a window title or a file name.
// The Store's pictures and its count of updates (menu-store.js).
const _menuStore = () => MenuStore.read({
  catalog: () => communityCatalog.fetchVisibleCatalog(false),
  packages: async () => (await sdkPackagesCached()).packages.map((p) => ({ id: p.id, version: p.version, catalogVersion: widgetCatalogVersionOf(p.id) })),
  installs: (hub.settings || {}).contentInstalls,
});

// A widget key with no row in the hotkey table lost it: to a combination already
// held by another key, or to a full table.
function _widgetKeyStates(held) {
  const table = _hotkeyBindings();
  const out = {};
  for (const { lead } of LayersModel.boxes(LayersModel.normalize((hub.settings || {}).layers).widgets)) {
    if (!lead.key) continue;
    const slot = 'widget-' + lead.id;
    out[slot] = table.some((b) => b.slot === slot) ? held(slot)
      : table.some((b) => b.combo === lead.key.combo) ? 'clash' : 'full';
  }
  return out;
}

async function _xenonMenuState() {
  const hs = hub.settings || {};
  const catalog = await _layerCatalog();
  const store = await _menuStore();
  const last = await _captures.last(null).catch(() => null);
  const slots = _hotkey.slots || {};
  const held = (slot) => slots[slot] || (_hotkey.bindings.some((b) => b.slot === slot) ? (_hotkey.state || 'off') : 'off');
  const deckState = new Map(_deckShortcutStatus().map((x) => [x.keyId, x.state]));
  const searchCfg = hs.searchSettings || {};
  const pageKeys = (Array.isArray(hs.pageHotkeys) ? hs.pageHotkeys : []).map((b) => ({ combo: String(b.combo || ''), target: String(b.target || '') }));
  return XenonMenu.compose({
    probes: { ...capabilityRunner.probes(), appAudio: await _appAudioAvailable() },
    layers: hs.layers,
    monitors: layersHost.monitors(),
    layerNow: { whenOff: _situations.hidden(), keyOff: _widgetKeys.hidden(), keyPeek: !_widgetKeys.holdsRelease(), gaming: gameDetect.isGameRunning() },
    layerSteps: layersEdit.steps(),
    perfHud: hs.perfHud,
    tiles: catalog.tiles,
    packages: catalog.packages,
    shots: store.shots,
    storeUpdates: store.updates,
    deckKeys: LayerKey.choices(await readDeckConfigs()),
    scenes: catalog.scenes,
    capture: captureOptions(),
    // Whole paths, read only by the section; the rows carry the last two names.
    captureFolders: {
      videos: captureOptions().folder || await defaultCaptureFolder('recording'),
      shots: captureOptions().shotFolder || await defaultCaptureFolder('screenshot'),
    },
    replay: _captureHost.has('replay') ? _replay.status() : null,
    recording: _recorder.status().on === true,
    last: last ? { createdAt: last.createdAt, seconds: last.seconds || 0 } : null,
    now: Date.now(),
    keys: { menu: _menuHotkey(), overlay: _overlayHotkey(), replay: _replayHotkey() },
    keyStates: {
      menu: held('menu'), overlay: held('overlay'), replay: held('replay'), spotlight: held('spotlight'),
      ...Object.fromEntries(pageKeys.map((_, i) => ['page-' + i, held('page-' + i)])),
      ..._widgetKeyStates(held),
    },
    widgetKeys: await _sdkWidgetKeys().catch(() => []),
    searchKey: { on: searchCfg.hotkeyEnabled === true, combo: String(searchCfg.hotkeyCombo || 'alt+space') },
    pageKeys,
    deck: shortcutState.found.list.map((x) => ({ keyId: x.keyId, instance: x.instance, combo: x.combo, title: x.title, does: x.does, state: deckState.get(x.keyId) || 'off' })),
    usageMode: UsageMode.normalize(hs.usageMode) || '',
    scene: { ...ScreenSceneModel.settingsOf(hs), id: (hs.ambientMode || {}).sceneId, parts: normalizeLockWidgets(hs.lockWidgets), canvases: hs.ambientScenes, themes: hs.customThemes, waiting: require('./capabilities/desktop-scene').scenesWaiting(hs, catalog.scenes), dashboard: layersHost.dashboard() },
    alertsOn: !(hs.notifications && hs.notifications.onScreen === false),
    quiet: hs.notifications && hs.notifications.quiet,
    companionOn: !!(hs.aiFeatures && hs.aiFeatures.enabled === true && hs.aiFeatures.gameCompanion === true),
    power: await require('./power').read().catch(() => null),
  });
}

const { updateDesktopSceneSetting } = require('./ambient/desktop-scene-setting.js');

const { normalizeDeckStore } = require('./deck/store-normalize.js');

const { readDeckStore } = require('./deck/store-read.js');

async function writeDeckStore(store) {
  const safe = normalizeDeckStore(store);
  safe.savedAt = Date.now();
  await writeFileAtomic(DECK_FILE, JSON.stringify(safe));
  _refreshDeckShortcuts(safe.configs);
  return safe;
}

const { deckWrites } = require('./deck/write-state.js');
// Deck read-modify-writes run one at a time: POST /deck-config and the AI's key
// edits (capabilities/deck-shortcut.js) would otherwise both read rev N and the
// second write would drop the first one's change.
deckWrites.chain = Promise.resolve();
const { withDeckWrite } = require('./deck/write-queue.js');

// A server-side Deck edit: edit(configs) works on a copy and returns
// { changed: [instanceId], result }; only the changed instances are written, as
// the same 'set' ops a dashboard sends, and every dashboard re-syncs.
function updateDeckConfigs(edit) {
  return withDeckWrite(async () => {
    const current = await readDeckStore();
    const configs = JSON.parse(JSON.stringify(current.configs));
    const out = edit(configs) || {};
    const changed = Array.isArray(out.changed) ? out.changed : [];
    const ops = changed.filter((id) => configs[id]).map((id) => ({ t: 'set', id, config: configs[id] }));
    if (!ops.length) return out.result;
    const applied = deckStore.applyDeckOps(current, ops);
    if (!applied.changed) return out.result;
    applied.store.rev = current.rev + 1;
    const saved = await writeDeckStore(applied.store);
    broadcastSSE('deck', { rev: saved.rev });
    return out.result;
  });
}


const { redactSettingsSecrets, preserveSettingsSecrets } = require('./settings/secrets.js');

const {
  BACKUP_FORMAT, BACKUP_MIN_FORMAT, BACKUP_BACKGROUND_MAX_BYTES, BACKUP_SAFE_NAME_RE,
  localBackupStamp,
} = require('./settings/backup-format.js');

const { _backupSecretFlags, _backupNeedsSetup } = require('./settings/backup-secrets.js');
const { settingsBeforeImport, keepThisPcOnImport, deckOnImport, deckActionsHeldBack } = require('./settings/backup-keep.js');

const { _buildBackupBackground, _buildBackupFont } = require('./settings/backup-uploads.js');

// The installed third-party widget / Ambient-scene packages, as a LIGHTWEIGHT
// manifest — id + name + origin + surface only, never the package code/assets.
// Those packages live in DATA_DIR/widgets and do NOT travel in the backup (only
// their placement in the layout does); embedding them would bloat the file and
// re-distribute other people's work. Instead this list drives a "re-install
// these from their codes" report on import (mirrors secretsConfigured →
// needsSetup). Builtin examples ship with the app, so they're skipped. This is
// informational only, so it deliberately does NOT bump BACKUP_FORMAT: an older
// importer safely ignores it, and a bundle without it yields an empty report.
async function _buildBackupWidgetList() {
  try {
    const scan = await refreshSdkScan();
    return (scan.packages || [])
      .map((p) => ({ id: p.id, name: p.name || p.id, origin: widgetOriginOf(p.id), surface: p.surface === 'ambient' ? 'ambient' : 'tile' }))
      .filter((w) => w.origin !== 'builtin');
  } catch { return []; }
}

async function buildBackup() {
  const settings = await readHubSettingsForUpdate();
  // The explicit blank is redundant now that redactSettingsSecrets covers the
  // Gemini key too, and it is kept on purpose: it runs BEFORE the redactor, so
  // the exported blob carries `geminiApiKeySet: false`. A backup restored on
  // another machine must not show a "saved" placeholder for a key it does not
  // contain.
  const safeSettings = redactSettingsSecrets({ ...settings, geminiApiKey: '' });
  // Calendar links are redacted from every browser-facing copy, but the backup
  // must carry them: there is no "re-enter it" prompt for a calendar after a
  // restore, and the feed would simply vanish (see the section comment above).
  if (Array.isArray(settings.calendarFeeds)) safeSettings.calendarFeeds = settings.calendarFeeds;
  // Scene pictures live in files (scene-images.js); a backup carries them
  // inside the scenes, as it always did, so it restores on any PC.
  safeSettings.ambientScenes = await sceneImages.inlineForBackup(settings.ambientScenes, UPLOADS_DIR);
  const notesState = await readNotes().catch(() => ({ v: 1, activeId: '', notes: [] }));
  return {
    xenonBackup: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    secretsConfigured: _backupSecretFlags(settings, await _readStreamTokensSnapshot()),
    widgetsInstalled: await _buildBackupWidgetList(),
    data: {
      settings: safeSettings,
      deck: await readDeckStore().catch(() => null),
      events: await readEvents().catch(() => []),
      tasks: await readTasks().catch(() => []),
      timers: timerState.list,
      // `notes` stays a flat text blob so older Xenon builds can restore this
      // backup; `notesData` carries the full multi-note structure for current builds.
      notes: notesToText(notesState),
      notesData: notesState,
      aiMemory: aiMemory.list(),
      guardian: await guardian.exportStore().catch(() => null),
      gameSessions: _gameSessions.exportData(),
      background: await _buildBackupBackground(settings),
      font: await _buildBackupFont(settings),
    },
  };
}

async function saveBackupToDisk(chosen = '') {
  const bundle = await buildBackup();
  const stamp = localBackupStamp(new Date(), true);
  const fileName = `xenon-backup-${stamp}.json`;

  const home = os.homedir();
  const candidates = [chosen, path.join(home, 'Downloads'), home, DATA_DIR].filter(Boolean);
  let dir = DATA_DIR;
  for (const c of candidates) {
    try { if ((await fs.promises.stat(c)).isDirectory()) { dir = c; break; } }
    catch { /* try the next candidate */ }
  }

  const dest = path.join(dir, fileName);
  // Atomic + compact: a crash mid-export must not leave a truncated backup that
  // only fails when the user tries to restore it, and pretty-printing a bundle
  // that can embed a multi-MB background roughly doubles the work and the size.
  await writeFileAtomic(dest, JSON.stringify(bundle));
  return { ok: true, path: dest, fileName };
}

async function applyBackup(bundle, { remote = false, keepDeckActions = false } = {}) {
  const fmt = bundle ? Number(bundle.xenonBackup) : 0;
  if (!Number.isInteger(fmt) || fmt < BACKUP_MIN_FORMAT || fmt > BACKUP_FORMAT
      || !bundle.data || typeof bundle.data !== 'object') {
    return { ok: false, error: 'bad_format' };
  }
  const d = bundle.data;
  const restored = [];
  const failed = [];
  // Each section restores independently: one bad section must not abort the
  // rest mid-sequence (the old behavior left a silent half-import), and the
  // caller gets an exact per-section report either way.
  const apply = async (name, fn) => {
    try { await fn(); restored.push(name); }
    catch (e) { console.error(`Backup restore failed for ${name}:`, e.message); failed.push(name); }
  };

  // Background binary FIRST, so the settings section below can re-point its
  // backgroundMedia reference at the restored file.
  let backgroundFile = '';      // server-generated name written on THIS machine
  let backgroundSrcName = '';   // the name the bundle's settings reference
  if (d.background && typeof d.background === 'object'
      && typeof d.background.file === 'string' && BACKUP_SAFE_NAME_RE.test(d.background.file)
      && typeof d.background.data === 'string') {
    await apply('background', async () => {
      // Same constraints as POST /background: allowlisted extension, bounded
      // size, and a SERVER-generated destination name — the name inside the
      // bundle never reaches the filesystem (the durable-upload invariant).
      const ext = ('.' + (d.background.file.split('.').pop() || '')).toLowerCase();
      if (!BACKGROUND_MIME_BY_EXT.has(ext)) throw new Error('background_type');
      const buf = Buffer.from(d.background.data, 'base64');
      if (!buf.length || buf.length > BACKUP_BACKGROUND_MAX_BYTES) throw new Error('background_too_large');
      const destName = `background-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
      await writeFileAtomic(path.join(UPLOADS_DIR, destName), buf);
      backgroundSrcName = d.background.file;
      backgroundFile = destName;
    });
  }

  // Custom UI font binary — same server-generated-name discipline as the
  // background, so the settings section can re-point uiFont at the restored file.
  let fontFile = '';       // server-generated name written on THIS machine
  let fontSrcName = '';    // the name the bundle's settings reference
  if (d.font && typeof d.font === 'object'
      && typeof d.font.file === 'string' && BACKUP_SAFE_NAME_RE.test(d.font.file)
      && typeof d.font.data === 'string') {
    await apply('font', async () => {
      const ext = ('.' + (d.font.file.split('.').pop() || '')).toLowerCase();
      if (!FONT_MIME_BY_EXT.has(ext)) throw new Error('font_type');
      const buf = Buffer.from(d.font.data, 'base64');
      if (!buf.length || buf.length > FONT_MAX_BYTES) throw new Error('font_too_large');
      const destName = `font-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
      await writeFileAtomic(path.join(UPLOADS_DIR, destName), buf);
      // Deliberately no cleanupOldFonts here (unlike POST /font): the settings
      // section below may keep an already-present font, which a sweep would delete.
      fontSrcName = d.font.file;
      fontFile = destName;
    });
  }

  if (d.settings && typeof d.settings === 'object' && !Array.isArray(d.settings)) {
    await apply('settings', async () => {
      const prev = await settingsBeforeImport(readHubSettings);
      // Backups never carry secrets — keep EVERY one configured on THIS machine
      // (the same composed preserve helper as POST /settings; a hand-built chain
      // here once missed the stock/football/news keys and wiped them on import).
      // A secret tied to an address (Home Assistant, UniFi, OBS, Streamer.bot)
      // is kept only when the backup names the same address: the file comes
      // from outside, and a tampered one must not be able to redirect a saved
      // token to a host of its choosing. A changed address then shows up as
      // "needs setup" like any other missing secret.
      const incoming = keepThisPcOnImport(preserveSettingsSecrets({ ...d.settings }, prev), prev);
      // lighting.providers / deviceModes / native are bridge-owned (and the backup's copy
      // is token-less by design) — refill from the live bridge exactly like
      // POST /settings, so an import can never wipe this machine's pairings.
      incoming.lighting = {
        ...(incoming.lighting && typeof incoming.lighting === 'object' ? incoming.lighting : {}),
        providers: lighting.getExternalConfig(),
        deviceModes: lighting.getConfig().deviceModes,
        native: lighting.getConfig().native,
      };
      // Re-point the background reference at the file restored above, or keep it
      // only when its binary already exists here — never a broken background.
      const bgUrl = incoming.backgroundMedia && typeof incoming.backgroundMedia === 'object'
        ? String(incoming.backgroundMedia.url || '') : '';
      if (bgUrl) {
        const bgName = bgUrl.split('/').pop() || '';
        if (backgroundFile && bgName === backgroundSrcName) {
          incoming.backgroundMedia = { ...incoming.backgroundMedia, url: `/uploads/${backgroundFile}` };
        } else if (!(BACKUP_SAFE_NAME_RE.test(bgName) && fs.existsSync(path.join(UPLOADS_DIR, bgName)))) {
          incoming.backgroundMedia = null;
        }
      }
      // Same re-pointing for the custom font: adopt the restored file, keep an
      // already-present one, otherwise drop to the default typeface (never a
      // dangling font reference).
      const fontUrl = incoming.uiFont && typeof incoming.uiFont === 'object'
        ? String(incoming.uiFont.url || '') : '';
      if (fontUrl) {
        const fontName = fontUrl.split('/').pop() || '';
        if (fontFile && fontName === fontSrcName) {
          incoming.uiFont = { ...incoming.uiFont, url: `/uploads/${fontFile}` };
        } else if (!(BACKUP_SAFE_NAME_RE.test(fontName) && fs.existsSync(path.join(UPLOADS_DIR, fontName)))) {
          incoming.uiFont = null;
        }
      }
      // A backup carries the store id of the machine it was EXPORTED from, and
      // restoring one does not make this machine that install: keep ours (the
      // first write mints one when there is none). Adopting the backup's would
      // tell every surface here that the store changed under them.
      incoming.storeId = (prev && prev.storeId) || '';
      // The anonymous feature counts are the PC owner's choice, as on POST
      // /settings: a backup posted from a paired device keeps the stored value.
      if (remote) incoming.usageStats = !!(prev && prev.usageStats === true);
      if (remote) incoming.batteryAskDevices = !prev || prev.batteryAskDevices !== false;
      // Bump rev past the current copy so every client's hydrate (which keeps the
      // newer rev) adopts the imported settings instead of clobbering them back.
      incoming.rev = Math.max(Number(incoming.rev) || 0, (prev && prev.rev) || 0) + 1;
      const settings = await writeHubSettings(incoming);
      hub.settings = settings;
      // Same post-save hooks as POST /settings; none of them may fail the import.
      try { lighting.applyConfig(settings.lighting); _syncSessionWatch(); }
      catch (e) { console.error('Backup lighting apply failed:', e.message); }
      // An import carries fileTransfer too, and the caps are held in the module,
      // not read per request — without this they stay at the pre-import values.
      try { _applyTransferLimits(); }
      catch (e) { console.error('Backup transfer limits apply failed:', e.message); }
      batteryMonitor.peripheralsChanged();
      // A backup with the anonymous counts off deletes what was waiting, as the switch does.
      if (prev && prev.usageStats === true && settings.usageStats !== true) usageStats.clear().catch(() => {});
      refreshExternalFeeds().catch(() => {});
      refreshObsWatch();
      refreshHaWatch();
      refreshSbWatch();
      refreshUnifiEventsWatch();
      broadcastSSE('settings', { rev: settings.rev });   // other open surfaces adopt the import live
    });
  }
  if (d.deck && typeof d.deck === 'object' && !Array.isArray(d.deck)) {
    await apply('deck', async () => {
      // Bump rev past the current store so every client (including one holding a
      // newer localStorage copy) adopts the imported deck on its next hydrate.
      const cur = await readDeckStore().catch(() => null);
      const store = deckOnImport(d.deck, cur, keepDeckActions === true && !remote);
      store.rev = Math.max(store.rev, (cur && cur.rev) || 0) + 1;
      const saved = await writeDeckStore(store);
      broadcastSSE('deck', { rev: saved.rev });   // open dashboards re-sync the imported decks live
    });
  }
  if (Array.isArray(d.events)) await apply('events', () => writeEvents(d.events));
  if (Array.isArray(d.tasks))  await apply('tasks',  () => writeTasks(d.tasks));
  if (Array.isArray(d.timers)) {
    await apply('timers', async () => {
      timerState.list = d.timers.slice(0, TIMERS_MAX).map(_normalizeTimer);
      await _saveTimers();
    });
  }
  if (d.notesData && typeof d.notesData === 'object' && !Array.isArray(d.notesData)) {
    await apply('notes', () => writeNotes(d.notesData));         // structured multi-note backup
  } else if (typeof d.notes === 'string' && d.notes) {
    await apply('notes', () => writeNotes(textToNotesState(d.notes)));   // legacy flat-text backup
  }
  if (Array.isArray(d.aiMemory)) await apply('aiMemory', () => aiMemory.importFacts(d.aiMemory));
  if (d.guardian && typeof d.guardian === 'object') await apply('guardian', () => guardian.importStore(d.guardian));
  if (Array.isArray(d.gameSessions)) await apply('gameSessions', () => _gameSessions.importData(d.gameSessions));

  // hub.settings is the maintained in-memory mirror (just updated when the
  // settings section applied) — no need to re-read the file from disk.
  const deckNow = await readDeckStore().catch(() => null);
  const needsSetup = _backupNeedsSetup(bundle.secretsConfigured, hub.settings || {}, await _readStreamTokensSnapshot(), d.settings, d.deck, deckNow);
  // SDK widget / Ambient-scene packages live in DATA_DIR/widgets and don't travel
  // in the backup — only their placement in the restored layout does. Report the
  // ones the backup listed that are NOT installed on THIS machine, so the user
  // knows to re-import them from their gallery / share codes. Absent list (a v1/v2
  // bundle, or a code-free export) → empty report.
  const listed = Array.isArray(bundle.widgetsInstalled) ? bundle.widgetsInstalled : [];
  let needsWidgets = [];
  if (listed.length) {
    let localIds = new Set();
    try { localIds = new Set((await refreshSdkScan()).packages.map((p) => p.id)); }
    catch { /* scan failure → report everything listed as missing */ }
    needsWidgets = listed
      .filter((w) => w && typeof w.id === 'string' && !localIds.has(w.id))
      .map((w) => ({
        id: String(w.id).slice(0, 60),
        name: String(w.name || w.id).slice(0, 80),
        origin: ['import', 'creator', 'local', 'builtin'].includes(w.origin) ? w.origin : 'unknown',
        surface: w.surface === 'ambient' ? 'ambient' : 'tile',
      }))
      .slice(0, 200);
  }
  const result = { ok: restored.length > 0 && failed.length === 0, restored, failed, needsSetup, needsWidgets, deckActions: deckActionsHeldBack(d.deck, deckNow) };
  // Nothing restored at all → give the client a real error code (it shows the
  // generic import error for ok:false; without this it would be a blank reason).
  if (!restored.length) result.error = failed.length ? 'restore_failed' : 'empty_backup';
  return result;
}

const { remoteControl } = require('./remote-control/engine-remote-control.js');
const { winNotifWanted } = require('./settings/notification-switches.js');

const { _feedWidgetInUse } = require('./grid/feed-widget-in-use.js');

const { processesWanted, perfWanted } = require('./performance/feeds-wanted.js');

const { readEvents, readTasks } = require('./time/store-read.js');

const { readIdleSeconds, _idleProbe } = require('./system/idle-seconds.js');

const { backgroundHeld } = require('./performance/background-held.js');

const { _guardHelperMediaBlindSpot, mediaScriptArgs } = require('./media/helper-blind-spot.js');

const { refreshWinNotifWatch } = require('./notification-open/watch-refresh.js');

const {
  saveTileSettings, saveVitalsState, saveNoticeSeen, updatePerformanceSetting,
} = require('./settings/save-from-page.js');

const { phoneSettings } = require('./transfer/phone-settings.js');

const { _claudeSettings } = require('./claude-code/settings-read.js');

const { CAPTURE_FOLDER_TITLES } = require('./screens/capture-folder-titles.js');

const { stepsLanguage } = require('./screens/steps-language.js');

const { _writeTasksNow } = require('./time/tasks-write-now.js');

const { _saveTimers } = require('./time/timers-save.js');

const { _startSttDevice, _sttDeviceWhenReady } = require('./ai/stt-start.js');

const { getAudioInfo } = require('./audio/info-read.js');

const { refreshDiscordWatch } = require('./discord/watch-refresh.js');

const { updateNotificationsSetting } = require('./settings/notifications-setting.js');

const { withTasksWrite, writeTasks } = require('./time/tasks-write.js');

const { _whisperReady } = require('./ai/whisper-ready.js');

const { wakeWordWanted } = require('./ai/wake-word-wanted.js');

const { refreshWakeWordWatch } = require('./ai/wake-word-watch.js');

const {
  updateScreenAlertsSetting, updateUsageModeSetting,
} = require('./settings/usage-and-alerts-settings.js');

const { gameSessionFacts, syncCoreShield } = require('./performance/core-shield-sync.js');

// Wire remoteControl into the Deck action dispatcher now that the orchestrator
// is available. The registry closes over deckRegistryDeps by reference, so this
// assignment is immediately visible to subsequent deckRegistry.run() calls.
deckRegistryDeps.remote = remoteControl;

// Self-update (safe two-step): prepare downloads+validates a new release into
// DATA_DIR without touching the live install; apply hands off to an external
// elevated applier. Disabled on a git checkout.
const selfUpdate = createSelfUpdate({ root: path.join(__dirname, '..'), dataDir: DATA_DIR });

const {
  AUTO_UPDATE_STATE_PATH, autoUpdateIdleSeconds,
} = require('./updates/auto-update-inputs.js');
// Test-only knobs for the end-to-end run, never set by an install: a release
// age of 0 hours, and an idle PC. Logged loudly so they cannot go unnoticed.
const AUTO_UPDATE_MIN_AGE_MS = (() => {
  const h = Number(process.env.XENON_AUTOUPDATE_MIN_AGE_H);
  return Number.isFinite(h) && h >= 0 && h < 24 * 30 ? h * 3600 * 1000 : undefined;
})();
if (AUTO_UPDATE_MIN_AGE_MS !== undefined) console.warn('[auto-update] TEST OVERRIDE: release age limit ' + (AUTO_UPDATE_MIN_AGE_MS / 3600000) + 'h');
if (AUTO_UPDATE_ASSUME_IDLE) console.warn('[auto-update] TEST OVERRIDE: the PC is treated as idle');

async function autoUpdateSignals() {
  const blockers = [];
  try { if (gameDetect.isGaming() || gameDetect.isGameRunning()) blockers.push('game'); } catch { /* probe off */ }
  const perf = hub.settings && hub.settings.performance;
  if (perf && perf.active === true) blockers.push('performance');
  try { if (fileTransfer.stats().inflight > 0) blockers.push('transfer'); } catch { /* not ready */ }
  try {
    const ds = await diskSpace.status();
    if (ds && (ds.running || (ds.clean && ds.clean.running))) blockers.push('disk');
  } catch { /* disk module unavailable: nothing running there */ }
  try { if (_claudeBridge.pendingCount > 0) blockers.push('claude'); } catch { /* bridge off */ }
  try { if (_codexBridge.pendingCount > 0) blockers.push('codex'); } catch { /* bridge off */ }
  try { if (_chatgptAsker.activeCount > 0) blockers.push('chatgpt'); } catch { /* not ready */ }
  if (liveVoice.active) blockers.push('voice');
  try { if (calls.current().length > 0) blockers.push('call'); } catch { /* calls off */ }
  return { blockers, idleSec: await autoUpdateIdleSeconds() };
}

const { _codexCfg } = require('./codex/widget-config.js');

const autoUpdater = autoUpdateLib.createAutoUpdater({
  currentVersion: APP_VERSION,
  selfUpdate,
  checkRelease: (force) => checkLatestRelease(force),
  isEnabled: () => !!(hub.settings && hub.settings.autoUpdate !== false),
  signals: autoUpdateSignals,
  readLastResult: () => readPwshJson(path.join(DATA_DIR, 'update-result.json')),
  store: {
    read: () => readPwshJson(AUTO_UPDATE_STATE_PATH),
    write: (obj) => writeFileAtomic(AUTO_UPDATE_STATE_PATH, JSON.stringify(obj)),
  },
  broadcast: (event, data) => { try { broadcastSSE(event, data); } catch { /* no clients */ } },
  log: (msg) => console.log('[auto-update] ' + msg),
  port: PORT,
  minAgeMs: AUTO_UPDATE_MIN_AGE_MS,
});

const widgetAutoUpdater = widgetAutoUpdateLib.createWidgetAutoUpdater({
  currentVersion: APP_VERSION,
  isEnabled: () => !!(hub.settings && hub.settings.autoUpdateWidgets !== false),
  safeMode: () => !!(hub.settings && hub.settings.safeMode === true),
  signals: autoUpdateSignals,
  fetchCatalog: () => communityCatalog.fetchVisibleCatalog(false),
  fetchCode: (id) => communityCatalog.fetchCode(id),
  // The supporter pass already saved on this PC, never a typed one.
  // Never through the trial: what this installs stays on disk for good.
  redeem: (entryId, kv) => supporterRedeem.redeem({ entryId, code: '', kv, dataDir: DATA_DIR, allowTrial: false }),
  // Tried first for a locked widget: an install the hub already knows as an owner
  // needs no pass, which is what lets a purchased (XL) widget update by itself.
  update: (entryId, opts) => supporterRedeem.update({ entryId, have: opts && opts.have, kv: opts && opts.kv, dataDir: DATA_DIR }),
  codec: { peekLocked: presetCodec.peekLocked, decodePreset: presetCodec.decodePreset },
  validatePayload: (payload) => sdkWidgets.validateWidgetPayload(payload),
  listInstalled: async () => (await sdkPackagesCached()).packages,
  originOf: (id) => widgetOriginOf(id),
  catalogVersionOf: (id) => widgetCatalogVersionOf(id),
  isSuspended: (id) => sdkPkgSuspended(id),
  // The RAW approved grants: sdkGrantsFor() masks to empty under safe mode and for
  // a suspended package, which would read as "nothing approved" here.
  grantsOf: (id) => {
    const sw = hub.settings && hub.settings.sdkWidgets;
    return (sw && sw.grants && typeof sw.grants === 'object' && sw.grants[id]) || {};
  },
  installStaged: async (validated, catalogVersion) => {
    const res = await sdkWidgets.installPackageStaged(SDK_WIDGETS_DIR, SDK_STAGING_DIR, validated, async () => {
      const scan = await refreshSdkScan();
      return scan.packages.some((p) => p.id === validated.id && p.version === validated.manifest.version);
    });
    if (res.ok) {
      await recordWidgetOrigin(validated.id, sdkWidgets.mergeOrigin(widgetOriginOf(validated.id), 'import'), catalogVersion);
      await refreshSdkScan();
    }
    return res;
  },
  store: {
    read: () => readPwshJson(WIDGET_AUTO_UPDATE_STATE_PATH),
    write: (obj) => writeFileAtomic(WIDGET_AUTO_UPDATE_STATE_PATH, JSON.stringify(obj)),
  },
  broadcast: (event, data) => { try { broadcastSSE(event, data); } catch { /* no clients */ } },
  log: (msg) => console.log('[widget-auto-update] ' + msg),
});

// Guardian — opt-in hardware-health history. The interval only does real work
// while the user has enabled the feature in Settings → Funzioni AI; collection
// is local and free, the AI reads the digest via the guardian_report tool.
const guardian = createGuardian({
  dataDir: DATA_DIR,
  getSystemInfo,
  isEnabled: () => {
    const s = hub.settings;
    // Collect when EITHER the dedicated sensor-history opt-in is on, OR the AI
    // Guardian feature is on (which reads the same history via guardian_report).
    // So existing AI-Guardian users keep collecting, and history is available on
    // its own without the AI.
    const history = !!(s && s.sensorHistory && s.sensorHistory.enabled === true);
    const f = s && s.aiFeatures;
    const aiGuardian = !!(f && f.enabled === true && f.guardian === true);
    return history || aiGuardian;
  },
  getEveryMin: () => (hub.settings && hub.settings.sensorHistory || {}).everyMin,
  onAlert: ({ type, value }) => broadcastSSE('guardian_alert', { type, value }),
  // Foreground-app usage ("PC Screen Time"): the game detector already tracks the
  // focused process cheaply — reuse it, don't add a second probe.
  getForegroundApp: () => { try { return gameDetect.getForegroundProcess(); } catch { return ''; } },
  isForegroundGame: () => { try { return gameDetect.isGaming(); } catch { return false; } },
});

const { briefing } = require('./ai/engine-briefing.js');

const { streams } = require('./streaming/providers.js');
const { makeStreamProviders } = require('./streaming/make-providers.js');

const { playInTile } = require('./windows-tiles/play-in-tile.js');

// Twitch + YouTube live integrations. Tokens persist to a server-only file
// (stream-tokens.json). `let` (not const) so the providers can be RE-CREATED when
// the user pastes/saves their app credentials in Settings → Streaming, picking up
// the new client_id/secret without a server restart (see saveStreamConfig).
makeStreamProviders();
// Twitch Deck actions (Phase 2). These arrow deps read `streams.twitch` at call
// time, so a re-created provider is picked up automatically.
deckRegistryDeps.twitchClip = () => streams.twitch.createClip();
deckRegistryDeps.twitchMarker = (description) => streams.twitch.createMarker(description);
deckRegistryDeps.twitchAd = (length) => streams.twitch.runAd(length);
deckRegistryDeps.twitchTitle = (title) => streams.twitch.setTitle(title);
deckRegistryDeps.twitchGame = (game) => streams.twitch.setGame(game);
deckRegistryDeps.twitchChat = (message) => streams.twitch.sendChat(message);
deckRegistryDeps.twitchShoutout = (login) => streams.twitch.shoutout(login);
deckRegistryDeps.twitchChatMode = (mode) => streams.twitch.setChatMode(mode);
// YouTube Deck action: start/stop/toggle the live broadcast.
deckRegistryDeps.ytBroadcast = (mode) => streams.youtube.transitionBroadcast(mode);

// Spotify integration (Authorization Code + PKCE — no client secret). `let` so it
// can be re-created when the user saves a Client ID in Settings → Streaming (see
// saveStreamConfig). Tokens persist to the same server-only stream-tokens.json.
const { SPOTIFY_LOCAL_FALLBACK } = require('./media/spotify-local-fallback.js');
deckRegistryDeps.spotify = async (action) => {
  const r = await streams.spotify.runAction(action);
  const cmd = SPOTIFY_LOCAL_FALLBACK[action.type];
  if (!cmd || !r || r.ok !== false || r.error !== 'rate_limited') return r;
  let media = null;
  try { media = await getMediaInfo(); } catch { return r; }
  if (!media || !media.active || !/spotify/i.test(String(media.app || ''))) return r;
  // A key that says "play" or "pause" must stay idempotent: under a rate limit the
  // key's own idea of the state is stale, so trust Windows and do nothing when the
  // app is already where the key wants it.
  const wanted = (action.type === 'spotifyPlay' && (action.mode === 'play' || action.mode === 'pause')) ? action.mode : '';
  if (wanted && (wanted === 'play') === (media.playbackStatus === 'Playing')) return { ok: true };
  try { await mediaAction(cmd); return { ok: true }; } catch { return r; }
};

const { discordLink } = require('./discord/link.js');
const { makeDiscordProvider } = require('./discord/make-provider.js');
makeDiscordProvider();
// All Discord Deck actions funnel through the provider (it owns the RPC socket and
// the current-state reads). Reads `discordLink.rpc` at call time so a re-created
// provider is picked up automatically.
deckRegistryDeps.discord = (action) => discordLink.rpc.runAction(action);
const { openDiscordChat } = require('./discord/open-chat.js');
deckRegistryDeps.discordOpenChat = openDiscordChat;

// Live Discord voice state pushed to the dashboard widget over SSE. The provider
// SUBSCRIBEs to voice events and calls us on each change (mute/deaf/volume, channel
// join/leave, who's speaking). Like the OBS watch, the persistent RPC socket is
// held only while the dashboard is open (SSE clients > 0) AND Discord is linked, so
// a closed dashboard or an unlinked account keeps zero sockets open.
const { stopDiscordWatch } = require('./discord/watch-stop.js');

const { discordMirror } = require('./discord/mirrored.js');
winNotif.init({
  // Per-app mute: match the AUMID when the toast has one, the display name
  // otherwise (some Win32 toasts carry no AUMID). Read live from settings so
  // a just-saved mute applies without restarting the child.
  isExcluded(item) {
    const wn = hub.settings && hub.settings.windowsNotifications;
    const list = (wn && Array.isArray(wn.excluded)) ? wn.excluded : [];
    if (!list.length) return false;
    const key = String((item && (item.aumid || item.app)) || '');
    return key !== '' && list.some(e => e && e.id === key);
  },
  onItem(item) {
    broadcastSSE('windows_notification', item);
    // The same toast is also the ring sensor for the Calls feature (Teams, Zoom,
    // Phone Link and anything else the user listed). calls.onNotification is a
    // no-op unless that feature is on, and it classifies rather than forwards —
    // nothing about the notification feed changes here.
    try { calls.onNotification(item); } catch { /* a ring must never break the feed */ }
    // A mirrored Windows toast counts as a "notification" for the RGB event effect
    // (no-op unless enabled in Settings → Illuminazione → Effetti evento).
    try { lighting.onEvent('notification'); } catch { /* lighting optional */ }
  },
  onPresent(ids) {
    // Which toasts are still in Action Center. Only the call card uses this: a
    // ringing toast vanishes when the caller hangs up, and that disappearance is
    // the only thing that says so.
    try { calls.onNotificationsPresent(ids); } catch { /* never breaks the reader */ }
  },
  onFeed() {
    // State change or feed replacement (seed / stop / exclusion prune): push the
    // whole picture so every open tile repaints without a fetch.
    broadcastSSE('windows_notifications', {
      enabled: winNotifWanted(),
      supported: winNotif.isSupported(),
      state: winNotif.reportedState(),
      items: winNotif.getFeed(),
    });
  },
});

const { callsSettings } = require('./transfer/calls-settings.js');
calls.init({
  platform: process.platform,
  broadcast: broadcastSSE,
  push: (message) => webPushNotify(message, { urgency: 'high', ttl: 60 }),
  getSettings: callsSettings,
  getLanguage: () => (hub.settings && hub.settings.language) || 'en',
  hotkeyAvailable: keySendAvailable,
  listWindows: () => runWindowsTool(['list'], 8000),
  focusWindow: (id) => runWindowsTool(['focus', String(id)], 5000),
  sendHotkey: sendHotkeyCombo,
  discordLinked: () => discordMirror.linkedForCalls,
  discordJoin: (channelId) => discordLink.rpc.runAction({ type: 'discordJoin', channel: String(channelId) }),
  // Read from the helper's own report, never assumed. Both are false on every
  // platform today (the HFP channel belongs to the OS), and the card draws its
  // buttons from them — so this is the single place that has to change if one
  // of the three ever hands the channel back.
  phoneCanAnswer: () => phone.canAnswer(),
  phoneCanHangUp: () => phone.canHangUp(),
  phoneAnswer: () => phone.answer(),
  phoneHangUp: () => phone.hangUp(),
  onEvent: (name) => { try { lighting.onEvent(name); } catch { /* lighting optional */ } },
});

function phoneKeysAvailable() {
  try { return phoneSettings().enabled === true && phone.canDial(); }
  catch { return false; }
}
const { phone } = require('./transfer/engine-phone.js');

const { aiPhoneTool } = require('./transfer/phone-assistant.js');

const { refreshAudioLevelsWatch } = require('./audio/levels-wanted.js');
const { changeSetting } = require('./settings/change-setting.js');

// Each tick goes straight out; the helper's own interval is the rate limit, and
// the payload is only the apps that are actually making sound.
audioLevels.onTick((peaks) => {
  if (sseClients.size === 0) return;
  broadcastSSE('audiolevels', { peaks });
});

const { announceAudioLevelsProblem } = require('./audio/levels-problem.js');
setInterval(announceAudioLevelsProblem, 5000).unref();

const {
  PROCESSES_POLL_MS, PROCESSES_POLL_GAME_MS, PROCESSES_TOP,
} = require('./performance/processes-stream-timing.js');
let _processesBusy = false;
let _processesPolledAt = 0;
// The last five minutes of readings, so a widget that draws history opens with
// it already drawn (GET /api/processes/history, replayed by the SDK host as a
// `history` message). Filled by the tick below and nothing else: no timer of its
// own, no disk, ~0.5 MB, and empty until someone has been granted the stream.
const _processesHistory = require('./stream-history').createStreamHistory({ maxAgeMs: 5 * 60 * 1000, maxItems: 160 });

const { normalizeProcesses } = require('./performance/processes-normalize.js');

const { announceProcessesProblem } = require('./performance/processes-problem.js');

setInterval(async () => {
  if (sseClients.size === 0) return;
  if (!processesWanted()) return;
  if (_processesBusy) return;
  if (backgroundHeld() && Date.now() - _processesPolledAt < PROCESSES_POLL_GAME_MS) return;
  _processesPolledAt = Date.now();
  _processesBusy = true;
  try {
    let raw = null;
    if (nativeCollectors && typeof nativeCollectors.processes === 'function') {
      raw = await nativeCollectors.processes(PROCESSES_TOP);
    } else if (POWERSHELL_SUPPORTED) {
      // runPowerShellWorker, NOT runCollector: runCollector falls back to a
      // one-shot spawn, and this script spawned per call would pay its priming
      // sleep every single tick. If the worker is gone, the honest answer is
      // "unavailable", not a version that costs 25x more and reports a 250ms
      // window as if it were the poll interval.
      raw = parseJsonOutput(await runPowerShellWorker(PROCESSES_SCRIPT, [String(PROCESSES_TOP)], 9000));
    }
    const data = normalizeProcesses(raw);
    if (!data) { announceProcessesProblem('unavailable'); return; }
    announceProcessesProblem('');
    _processesHistory.push(data);
    if (sseClients.size > 0) broadcastSSE('processes', data);
  } catch {
    announceProcessesProblem('unavailable');
  } finally {
    _processesBusy = false;
  }
}, PROCESSES_POLL_MS).unref();

const { SENSORS_STREAM_POLL_MS } = require('./system/sensors-stream-timing.js');
let _sensorsStreamBusy = false;
setInterval(async () => {
  if (sseClients.size === 0 || _sensorsStreamBusy || !sdkStreamGranted('sensors')) return;
  _sensorsStreamBusy = true;
  try {
    const r = await collectSensors(null);
    // `problem` only when there is no answer at all, so a widget can explain
    // the gap (sensorAccess says why) instead of drawing an empty machine.
    const problem = r.known || r.sensors.length ? undefined : 'unavailable';
    if (sseClients.size > 0) broadcastSSE('sensors', { sensors: r.sensors, problem, sensorAccess: sensorCache.reading.sensorAccess });
  } catch {
    if (sseClients.size > 0) broadcastSSE('sensors', { sensors: [], problem: 'unavailable', sensorAccess: sensorCache.reading.sensorAccess });
  } finally {
    _sensorsStreamBusy = false;
  }
}, SENSORS_STREAM_POLL_MS).unref();

const { _sttInputArgs, _sttVia, _sttDeviceLabel } = require('./ai/stt-input.js');
wakeWord.init({
  getFfmpegPath,
  getInputArgs: () => {
    if (sttDevice.ready) return _sttInputArgs();
    _startSttDevice();
    return null;
  },
  // Whisper hint follows the persisted UI language ('' → auto-detect); the
  // matcher is fuzzy enough to catch accented renderings either way.
  transcribe: (wav) => aiLocal.localStt(wav, (hub.settings && hub.settings.language) || 'auto', __dirname),
  isBusy: () => _sttPending.size > 0,
  // Every open dashboard gets the event; the /api/stt/start 409 guard already
  // prevents two tabs from double-starting a voice session.
  onWake: () => broadcastSSE('wake', { at: Date.now() }),
});

const { saveStreamConfig } = require('./streaming/save-config.js');

const { timeWrites } = require('./time/write-state.js');
// Every events write runs in one queue, so the reminder check (which marks
// `notifiedAt`) and a save never interleave, and a save from a copy older than
// the mark keeps it (calendar-reminders.js keepNotified).
timeWrites.events = Promise.resolve();
const { agendaState } = require('./time/agenda-state.js');

const { writeEvents, updateEvents } = require('./time/events-write.js');

// Every tasks write runs in one queue, and so does every read that a write is
// built on (updateTasks), so the assistant, a Deck key, the clock that reopens
// repeating tasks and two dashboards can never base a write on the same old
// list and drop each other's change.
timeWrites.tasks = Promise.resolve();

// Read, change and write the tasks as one step. `edit(tasks)` answers
// { next, ...result } to save `next`, or { ...result } without `next` to leave
// the file alone. A file that cannot be read fails the edit instead of
// starting from an empty list.
function updateTasks(edit) {
  return withTasksWrite(async () => {
    const cur = await readTasks();
    const out = (await edit(cur)) || {};
    if (!Array.isArray(out.next)) return { ...out, tasks: cur, seq: agendaState.tasksSeq, changed: false };
    const tasks = await _writeTasksNow(out.next);
    return { ...out, tasks, seq: agendaState.tasksSeq, changed: true };
  });
}

// Finished repeating tasks come back on the server's clock, for every screen.
function reopenDueTasksNow() {
  return updateTasks((cur) => {
    const r = listOps.reopenDueTasks(cur);
    return r.changed ? { next: r.list } : null;
  });
}
function startTasksReopenClock() {
  if (timeWrites.reopenTimer) clearInterval(timeWrites.reopenTimer);
  reopenDueTasksNow().catch(() => {});
  timeWrites.reopenTimer = setInterval(() => { reopenDueTasksNow().catch(() => {}); }, 60_000);
  timeWrites.reopenTimer.unref();
}

// ── Notes ─────────────────────────────────────────────────────────────────────
// Structured multi-note store (notes.json). The plain-text /notes API, the AI
// read/write functions and the backup bundle all speak a flattened text view so
// existing consumers (iCUE widget, older backups) keep working unchanged.

const { readNotes, writeNotes, saveNotesGuarded } = require('./time/notes-store.js');

// ── Timers ────────────────────────────────────────────────────────────────────

const { timerState } = require('./time/timer-list.js');

function _checkTimers() {
  let changed = false;
  for (const t of timerState.list) {
    // A stopwatch never finishes, so it never rings for having ENDED. It can
    // still chime on the way, if its owner asked for that.
    if (t.kind === 'stopwatch') {
      if (t.status !== 'running' || !(t.intervalSecs > 0)) continue;
      const due = Math.floor(_getTimerElapsed(t) / t.intervalSecs);
      if (due <= (t.chimes || 0)) continue;
      // One event even if several intervals passed while the machine slept:
      // waking to four stacked toasts for a stretch reminder is worse than
      // waking to one.
      t.chimes = due;
      changed = true;
      broadcastSSE('timer_chime', { id: t.id, label: t.label, every: t.intervalSecs, elapsed: Math.floor(_getTimerElapsed(t)) });
      try { lighting.onEvent('timer'); } catch {}
      webPushNotify({
        title: 'Xenon',
        body: t.label ? t.label : 'Stopwatch',
        tag: 'chime-' + t.id,
        url: '/',
      }, { urgency: 'high', ttl: 300 });
      continue;
    }
    if (t.status === 'running' && _getTimerRemaining(t) <= 0) {
      t.status = 'done';
      changed = true;
      broadcastSSE('timer_done', { id: t.id, label: t.label });
      try { lighting.onEvent('timer'); } catch {}
      // The first push call site, and the one that justifies the feature: a
      // countdown is the one thing on this dashboard whose whole purpose is to
      // reach you when you have walked away from the screen. The SSE event
      // above only reaches a page that is open.
      //
      // The label is the user's own text, and it is the only user content this
      // server ever puts on a lock screen — it is there because "timer
      // finished" without saying which one is useless when two are running.
      webPushNotify({
        title: 'Xenon',
        body: t.label ? t.label : 'Timer',
        tag: 'timer-' + t.id,
        url: '/',
      }, { urgency: 'high', ttl: 300 });
    }
  }
  if (changed) {
    _saveTimers();
    broadcastSSE('timer_update', { timers: timerState.list });
  }
}

async function _initTimers() {
  try {
    const raw = await fs.promises.readFile(TIMERS_FILE, 'utf8');
    const loaded = JSON.parse(raw);
    timerState.list = (Array.isArray(loaded) ? loaded : []).slice(0, TIMERS_MAX).map(_normalizeTimer);
  } catch (e) {
    if (e.code !== 'ENOENT') process.stdout.write(`[timers] load error: ${e.message}\n`);
    timerState.list = [];
  }
  if (timerState.checking) clearInterval(timerState.checking);
  timerState.checking = setInterval(_checkTimers, 1000);
  timerState.checking.unref();
}

const { refreshExternalFeeds } = require('./time/feeds-refresh.js');

const { EXTERNAL_FEEDS_INTERVAL_MS } = require('./ticker/feeds-interval.js');
setTimeout(() => { if (sseClients.size) refreshExternalFeeds().catch(() => {}); }, 4000).unref();
setInterval(() => {
  if (sseClients.size === 0) return;
  refreshExternalFeeds().catch(() => {});
}, EXTERNAL_FEEDS_INTERVAL_MS).unref();

const { _calendarReminders } = require('./time/engine-reminders.js');
_calendarReminders.start();

// ── Server-Sent Events infrastructure ────────────────────────────────────────
// Clients connect to GET /sse and receive named events instead of polling.
// Each event carries the same JSON payload the old poll endpoints returned,
// so the client-side render functions need no changes — only the fetch trigger
// changes from setInterval to EventSource.

const { _fpsDemand, _syncFpsMonitor } = require('./performance/engine-fps-demand.js');

const { stocksState } = require('./ticker/stocks-state.js');
const { stocksRefresh } = require('./ticker/stocks-refresh-state.js');

require('./ticker/stocks-alert-memory.js');


const { _widgetPlaced } = require('./grid/widget-placed.js');

const {
  _stocksSettings, _stocksProviderOpts, _footballSettings, _footballOpts, _newsSettings, _newsOpts,
} = require('./ticker/feed-settings.js');

const { refreshStocks } = require('./ticker/stocks-refresh.js');

// Client-gated cadence: a light 10s heartbeat that only fetches once the user's
// refreshSec has elapsed and a dashboard is actually open. Zero cost at rest.
setTimeout(() => { if (sseClients.size) refreshStocks().catch(() => {}); }, 5000).unref();
setInterval(() => {
  if (sseClients.size === 0) return;
  const period = Math.max(30, Number(_stocksSettings().refreshSec) || 60) * 1000;
  if (Date.now() - stocksRefresh.lastFetch < period) return;
  refreshStocks().catch(() => {});
}, 10000).unref();

const { footballState } = require('./ticker/football-state.js');

require('./ticker/football-alert-memory.js');


const { _footballPayload, _loadFootballInfo } = require('./ticker/football-push.js');


const { refreshFootball } = require('./ticker/football-refresh.js');

// Client-gated cadence (mirrors stocks): a light heartbeat that only fetches once
// the user's refreshSec has elapsed and a dashboard is actually open.
setTimeout(() => { if (sseClients.size) refreshFootball().catch(() => {}); }, 6000).unref();
setInterval(() => {
  if (sseClients.size === 0) return;
  const period = Math.max(60, Number(_footballSettings().refreshSec) || 120) * 1000;
  if (Date.now() - footballState.lastFetch < period) return;
  refreshFootball().catch(() => {});
}, 15000).unref();

const { newsState } = require('./ticker/news-state.js');

const { refreshNews } = require('./ticker/news-refresh.js');


const { editFavorites } = require('./settings/edit-favorites.js');

// Display-only feed: also gated on the widget/ticker actually using it, so a
// user who never added the News widget pays zero network for it.
setTimeout(() => { if (sseClients.size && _feedWidgetInUse('news', 'news')) refreshNews().catch(() => {}); }, 8000).unref();
setInterval(() => {
  if (sseClients.size === 0) return;
  if (!_feedWidgetInUse('news', 'news')) return;
  const period = Math.max(120, Number(_newsSettings().refreshSec) || 600) * 1000;
  if (Date.now() - newsState.lastFetch < period) return;
  refreshNews().catch(() => {});
}, 30000).unref();

const { _claudeReader } = require('./claude-code/engine-usage-reader.js');
const { claudeState } = require('./claude-code/tile-state.js');
const { claudeRefresh } = require('./claude-code/refresh-state.js');

const _claudeBridge = claudeBridge.createBridge({
  onChange: () => _claudeBridgeChanged(),
  defaultMode: () => claudeState.defaultMode,
  terminal: (id) => _claudeInbox.present(id),
});
// Tile messages for a session open in a terminal (claude-inbox.js): the Xenon
// mod holds a request here while its session runs, and a message for that
// session while it is idle goes through it, as a new turn in the terminal,
// instead of a background run. The bridge decides what may be handed over.
const _claudeInbox = claudeInbox.createInbox({
  take: (id) => _claudeBridge.takeForTerminal(id),
  onPresence: (id, present) => {
    if (!present) _claudeBridge.terminalGone(id);
    _claudeBridgeChanged();
  },
});
const { bridgePush } = require('./claude-code/bridge-push-state.js');

// Runs the dashboard starts itself. It shares the bridge's repaint throttle
// because a run and the permission requests it triggers are one story on screen.
// The runs go through Claude Code's NORMAL permission mode, so every tool call
// comes back through the bridge as a card the user answers here.
// Files handed to a run from the touchscreen. They live under DATA_DIR, which is
// never HTTP-reachable; only their path travels, and only into the prompt.
const _claudeAttach = claudeAttach.createAttachments({ dir: path.join(DATA_DIR, 'claude-attach') });

const _claudeRunner = claudeRun.createRunner({
  projectsDir: () => claudeUsage.resolveProjectsDir(),
  foldersFile: path.join(DATA_DIR, 'claude-folders.json'),
  onChange: () => _claudeBridgeChanged(),
});

// The "/" picker of the tile's prompt box: names and descriptions of the
// commands and skills a run can use. The project comes from the runner's own
// allowlist by id, never from the request.
const _claudeCommands = claudeCommands.createCommandList({
  configDir: () => path.dirname(claudeUsage.resolveProjectsDir()),
  projectDir: async (id) => ((await _claudeRunner.listProjects(false)).find((p) => p.id === id) || {}).path || '',
});

// The chat list on the tile's Chats face. Removal reuses the disk pipeline's
// Recycle Bin/Trash path and its guard; a session the bridge sees running is
// refused, along with any transcript written in the last few minutes.
const _claudeHistory = claudeHistory.createSessionStore({
  projectsDir: () => claudeUsage.resolveProjectsDir(),
  trash: (root, paths) => diskSpace.trashUnder(root, paths),
  liveIds: () => new Set((_claudeBridge.snapshot().sessions || []).filter((s) => !s.ended).map((s) => s.id)),
});

// Bridge-driven repaints are throttled (a busy session fires Pre/PostToolUse per
// tool call) but NOT gated on the widget being on the dashboard the way the
// filesystem scan is: a pending approval must reach the fullscreen overlay even
// when the user never added the tile, and a push costs no disk I/O.
function _claudeBridgeChanged() {
  if (bridgePush.timer || sseClients.size === 0) return;
  bridgePush.timer = setTimeout(() => {
    bridgePush.timer = null;
    try { _claudeBroadcast(); } catch { /* a repaint must never break ingest */ }
  }, 300);
  if (typeof bridgePush.timer.unref === 'function') bridgePush.timer.unref();
}

// Claude Code's own live session registry (<configDir>/sessions/<pid>.json),
// read on a slow cadence and merged as CORROBORATION only — see the rule at the
// top of claude-sessions.js. It answers the two questions no hook can: a session
// that started before Xenon did is listed, and a session killed with Ctrl-C
// (which fires no SessionEnd) is retired now instead of an hour from now.
//
// Client-gated like every other periodic read: with nobody watching, a stale
// list costs nothing, and the first thing a connecting client gets is a fresh
// one. Deliberately not fast — the hook feed is what makes the tile live; this
// only keeps it honest.
let _claudeRegistryTimer = null;
async function _claudeSyncRegistry() {
  try { _claudeBridge.mergeRegistry(await claudeSessions.readRegistry()); }
  catch { /* no registry is simply no corroboration */ }
}
// Esc in the terminal ends a turn without a Stop hook: the transcript's last
// line says so, so a session that claims to work is checked against it.
async function _claudeCheckInterrupts() {
  try {
    for (const w of _claudeBridge.workingSessions()) {
      if (await claudeTranscript.interruptedSince(claudeUsage.resolveProjectsDir(), w.id, w.since)) {
        _claudeBridge.markInterrupted(w.id);
      }
    }
  } catch { /* a failed check leaves the session as it was */ }
}
_claudeRegistryTimer = setInterval(() => {
  if (sseClients.size === 0) return;
  _claudeSyncRegistry();
  _claudeCheckInterrupts();
}, 7000);
if (typeof _claudeRegistryTimer.unref === 'function') _claudeRegistryTimer.unref();

const { _claudeBridgeAuth } = require('./claude-code/bridge-auth.js');

// What /api/claude/mod tells the mod: which hub, and whether the tile is out.
function _claudeModReply() {
  return { ok: true, hub: APP_VERSION, tile: _widgetPlaced('claude'), mod: _claudeBridge.modStatus() };
}

// Shows the approval card and waits for a tap. Resolves the PermissionRequest
// decision ({ behavior, … }) on an explicit Allow/Deny, null on anything else
// (expired, too many waiting, caller gone): null always means "the terminal
// asks". Shared by the hook route and the mod's route.
async function _claudeHoldPermission(res, data, opts) {
  const pendingReq = _claudeBridge.requestPermission(data, opts);
  if (!pendingReq) return null;                    // too many already waiting
  // Claude Code gave up (Ctrl-C, or its own hook timeout): stop showing a
  // card nobody can answer any more.
  const onGone = () => _claudeBridge.cancel(pendingReq.id);
  res.on('close', onGone);
  const out = await pendingReq.promise;
  res.off('close', onGone);
  if (out.verdict !== 'allow' && out.verdict !== 'deny') return null;
  // A plan also carries the echoed input and the chosen mode: without
  // updatedInput Claude Code ignores an allow for ExitPlanMode and keeps its
  // own dialog up (claude-bridge.js, header note 2).
  const decision = { behavior: out.verdict };
  if (out.verdict === 'allow' && out.updatedInput) decision.updatedInput = out.updatedInput;
  if (out.verdict === 'allow' && out.updatedPermissions) decision.updatedPermissions = out.updatedPermissions;
  if (out.verdict === 'deny' && out.message) decision.message = out.message;
  return decision;
}

// Resolve (or mint) the bridge token once at boot. Until it lands, both ingest
// endpoints reject — which is the safe direction, and the window is a few ms.
claudeLink.ensureToken(DATA_DIR).then((t) => { claudeState.bridgeToken = t; }).catch(() => {});

const { _claudeLinkStatus } = require('./claude-code/link-status.js');
_claudeLinkStatus().catch(() => {});

// Build the wire payload: the aggregate + the budget config the reactor needs to
// draw the "remaining" gauge (there is no official quota API, so the ceiling is
// whatever plan/budget the user picked).
function _claudePayload(usage) {
  const cfg = _claudeSettings();
  const live = _claudeBridge.snapshot();
  return {
    usage,
    // Live state straight from Claude Code (quota, sessions, pending approvals).
    // Null-safe for every consumer: the widget falls back to the transcript
    // aggregate whenever the user hasn't linked Claude Code yet.
    live,
    // The title Claude Code gave each session shown (a /rename wins), so three
    // sessions in one project stop reading "xenon", "xenon", "xenon". Answered
    // from memory; a title read in the background repaints the tile.
    titles: _claudeSessionTitles(live, usage),
    // Runs the dashboard started itself, so the tile can show progress and offer
    // a stop. Empty for every user who never uses the feature.
    runs: _claudeRunner.snapshot(),
    budget: {
      weekly: claudeUsage.effectiveWeeklyBudget(cfg),
      plan: cfg.plan,
      weeklyTokenBudget: cfg.weeklyTokenBudget,
    },
    tile: cfg.tile,
    refreshedAt: Date.now(),
  };
}

function _claudeSessionTitles(live, usage) {
  const ids = ((live && live.sessions) || []).map((s) => s.id)
    .concat(((usage && usage.sessions) || []).map((s) => s.id));
  return _claudeHistory.titles(ids, () => { try { _claudeBroadcast(); } catch { /* the next push retries */ } });
}

// Every read path must rebuild the live block rather than serve the copy stored
// in the cache: bridge changes are only broadcast while an SSE client is
// connected, so the cached `live` can be arbitrarily old. Serving it would let a
// dashboard seed itself with an empty approvals list while Claude Code is
// actually blocked waiting for a tap.
function _claudeFresh() {
  return _claudePayload(claudeState.cache.data ? claudeState.cache.data.usage : null);
}

// Single exit point for both feeds. `usage` defaults to whatever the last
// filesystem scan produced, so a bridge-only change (a tool call, an approval)
// repaints without re-reading any transcript.
function _claudeBroadcast(usage) {
  const u = usage !== undefined ? usage : (claudeState.cache.data ? claudeState.cache.data.usage : null);
  const payload = _claudePayload(u);
  // Change detection folds in the budget so a settings edit repaints too, the
  // bridge signature so live state does as well — not just token activity — and
  // the runs, without which a run the dashboard just started would sit in the
  // payload and never be pushed: nothing else about the payload changes when a
  // run appears, so the broadcast was suppressed and the tile showed nothing.
  // Elapsed time is deliberately NOT in the signature; a still-running run must
  // not force a repaint every tick.
  const runSig = payload.runs.map(r => `${r.id}:${r.state}:${r.output.length}`).join(',');
  const titleSig = Object.keys(payload.titles).map((id) => id + '=' + payload.titles[id]).join('\n');
  const fullSig = `${u ? u.sig : ''}|${payload.budget.weekly}|${payload.budget.plan}|${payload.live.sig}|${runSig}|${titleSig}`;
  const changed = fullSig !== claudeState.cache.sig;
  claudeState.cache = { data: payload, sig: fullSig, refreshedAt: payload.refreshedAt };
  if (changed) broadcastSSE('claude', payload);
  return payload;
}

async function refreshClaude() {
  if (claudeRefresh.refreshing) return claudeState.cache;
  claudeRefresh.refreshing = true;
  claudeRefresh.lastFetch = Date.now();
  try {
    const usage = await _claudeReader.getUsage(Date.now());
    _claudeBroadcast(usage);
  } catch { /* keep last good cache */ }
  finally { claudeRefresh.refreshing = false; }
  return claudeState.cache;
}

// Client-gated cadence (mirrors stocks/football): only scans the filesystem once a
// dashboard is open and the user's refreshSec has elapsed.
// Display-only feed: also gated on the widget actually being on the dashboard,
// so a user who never added the Claude widget pays zero filesystem scans for it.
setTimeout(() => { if (sseClients.size && _feedWidgetInUse('claude')) refreshClaude().catch(() => {}); }, 4000).unref();
setInterval(() => {
  if (sseClients.size === 0) return;
  if (!_feedWidgetInUse('claude')) return;
  const period = Math.max(20, Number(_claudeSettings().refreshSec) || 60) * 1000;
  if (Date.now() - claudeRefresh.lastFetch < period) return;
  refreshClaude().catch(() => {});
}, 10000).unref();

// ── OpenAI Codex ─────────────────────────────────────────────────────────────
// Two feeds, kept apart because they cost different things:
//  - the ACCOUNT side (plan windows, tokens per day, recent conversations) comes
//    from one `codex app-server` child (codex-appserver.js), running only while a
//    Codex or ChatGPT tile is placed or a widget holds the `codex` stream AND a
//    dashboard is open, stopped a few minutes after that stops being true;
//  - the LIVE side (sessions, approvals) is pushed by Codex itself through the
//    hooks codex-link.js installs (codex-bridge.js) and costs nothing until a
//    hook fires. Like the Claude bridge it is not gated on the tile: a pending
//    approval must reach the overlay even when the tile was never added.
const _codexBridge = codexBridge.createBridge({
  onChange: () => _codexChanged(),
  waitMs: () => {
    const w = hub.settings && hub.settings.codexWidget;
    return (w && Number.isFinite(w.waitSec) ? w.waitSec : 90) * 1000;
  },
});
const _codexApp = codexAppServer.createAppServer({
  resolveExe: () => aiCli.resolveCodex(),
  env: () => aiCli.childEnv('codex'),
  cwd: () => privateTmpDir(),
  clientVersion: APP_VERSION || '0.0.0',
  isOurHook: (cmd) => codexLink.isOurCommand(cmd),
  onChange: () => { _codexRefreshLink().catch(() => {}); },
  log: (m) => console.log('[codex] ' + m),
});
const { codexState } = require('./codex/tile-state.js');
const { codexRefresh } = require('./codex/refresh-state.js');

const { _codexWanted } = require('./codex/wanted.js');
function _syncCodexDemand() {
  const wanted = _codexWanted();
  _codexApp.setDemand({ wanted, visible: wanted });
}

const { _codexBridgeAuth } = require('./codex/bridge-auth.js');

// The link as the tile shows it. `trust` is Codex's own verdict (hooks/list)
// when the app-server child is running, else null and the tile explains /hooks.
// Reading never writes: every rewrite of hooks.json costs the user a re-trust.
async function _codexLinkStatus({ fresh = false } = {}) {
  const trust = await _codexApp.hooksStatus({ fresh }).catch(() => null);
  const st = await codexLink.status(DATA_DIR, { trust });
  codexRefresh.linkCache = {
    linked: st.linked, complete: st.complete, unparsable: st.unparsable, trust: st.trust,
    exists: st.exists, linkedAt: st.linkedAt, repairedAt: codexRefresh.linkRepairedAt,
  };
  return { ...st, repairedAt: codexRefresh.linkRepairedAt };
}
async function _codexRefreshLink() {
  await _codexLinkStatus().catch(() => {});
  _codexChanged();
}

// Boot: the token codex-hook.js presents (and the port it dials, stored next to
// it), then a repair only for a link the user made whose node or script path
// moved. A repair changes the hook hash, so the tile says to trust it again.
codexLink.ensureToken(DATA_DIR, PORT)
  .then((t) => { codexState.bridgeToken = t; return codexLink.repairLink(DATA_DIR, PORT); })
  .then((st) => {
    if (st && st.repaired) {
      codexRefresh.linkRepairedAt = Date.now();
      console.log('[codex] Codex hooks pointed at a path that moved; updated (trust them again in Codex /hooks)');
    }
    return _codexLinkStatus();
  })
  .catch(() => {});

function _codexPayload() {
  const app = _codexApp.snapshot();
  return {
    app,
    live: _codexBridge.snapshot(),
    link: codexRefresh.linkCache,
    cfg: _codexCfg(),
    // What an SDK widget granted the `codex` stream receives: built here, an
    // allowlist of numbers (codex-bridge.js sdkProjection). main.js forwards only
    // this part to widget frames.
    sdk: codexBridge.sdkProjection(app, _codexBridge.counts()),
    refreshedAt: Date.now(),
  };
}
function _codexBroadcast() {
  const payload = _codexPayload();
  const { refreshedAt, live, ...rest } = payload;
  const sig = live.sig + '|' + JSON.stringify(rest);
  if (sig === codexRefresh.sig) return payload;
  codexRefresh.sig = sig;
  broadcastSSE('codex', payload);
  return payload;
}
function _codexChanged() {
  if (codexRefresh.pushTimer || sseClients.size === 0) return;
  codexRefresh.pushTimer = setTimeout(() => {
    codexRefresh.pushTimer = null;
    try { _codexBroadcast(); } catch { /* a repaint must never break ingest */ }
  }, 300);
  if (typeof codexRefresh.pushTimer.unref === 'function') codexRefresh.pushTimer.unref();
}

// ── "Ask ChatGPT" tile ───────────────────────────────────────────────────────
// Conversations answered on the user's ChatGPT plan through OpenAI's own codex
// program (chatgpt-ask.js has the why). The store is DATA_DIR/chatgpt.json, a
// bounded cache written atomically; a turn runs off the request and its answer
// arrives over SSE ('chatgpt'), and every running turn is killed on shutdown.
const _chatgptStore = chatgptAsk.createStore({ file: path.join(DATA_DIR, 'chatgpt.json'), writeFileAtomic });
const _chatgptAsker = chatgptAsk.createAsker({
  store: _chatgptStore,
  chat: (opts) => aiCli.chat(opts),
  model: () => {
    const w = hub.settings && hub.settings.chatgptWidget;
    return (w && w.model) || 'default';
  },
  onChange: (id) => _chatgptChanged(id),
});
function _chatgptPayload(changedId) {
  return {
    conversations: _chatgptStore.list(),
    active: _chatgptAsker.snapshot(),
    // The one conversation that changed, whole, so an open thread repaints
    // without a second request. Only sent on a change, never on a seed.
    changed: changedId ? _chatgptStore.get(changedId) : null,
  };
}
function _chatgptChanged(id) {
  if (sseClients.size === 0) return;
  try { broadcastSSE('chatgpt', _chatgptPayload(id)); } catch { /* a repaint must never break a turn */ }
}

const { speakOnServer } = require('./ai/speak-on-server.js');

const { LEAKED_CALL_RE, _parseLeakedToolCall } = require('./ai/leaked-tool-call.js');

const { _geminiOneShot, _transcribeAudio, _geminiWebSearch } = require('./ai/gemini-calls.js');

const { completeWithUserAi } = require('./ai/complete-with-user-ai.js');

const {
  STARTUP_TASK_CHECK_MS, LEFTOVER_TASKS_DELAY_MS, tidyLeftoverTasks,
} = require('./install/leftover-tasks.js');

const { batteryWanted } = require('./device-battery/wanted.js');

const { desiredBindHost, BIND_HOST } = require('./paired/bind-host.js');

const { helperArrived, ensureHelperUpToDate } = require('./updates/helper-up-to-date.js');

const { refreshStartupTaskState } = require('./install/startup-task-refresh.js');

const { addIntegrationAiFunctions } = require('./streaming/assistant-functions.js');

const { _audioToWav16k } = require('./ai/audio-to-wav.js');

const { _noteAudioWatched, audioPollWanted } = require('./audio/watched.js');

const { _aiPerformancePlan } = require('./ai/performance-plan.js');

const { ensureCaptureEngine } = require('./screens/capture-engine-install.js');

// Security: only accept connections from loopback addresses.
// Double-checked at both the TCP socket level (remoteAddress) and the HTTP Host header
// level, so DNS-rebinding / Host-spoofing attacks from non-loopback IPs are blocked.
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const ALLOWED_HOSTS = new Set([
  '127.0.0.1:' + PORT, 'localhost:' + PORT, '[::1]:' + PORT,
  '127.0.0.1:3030', 'localhost:3030', '[::1]:3030',
  '127.0.0.1', 'localhost', '[::1]',
]);

// JSONP responses are readable by any page that can inject a <script> tag:
// script loads send no Origin header, so the Origin layer below never sees
// them, and the request still comes from loopback (the user's own browser).
// So one route answers it: the iCUE widget's check that Xenon is on, and all it
// learns is that (see /status). The widget shows the dashboard itself, in a
// frame. Everything else ships only as plain JSON, which a page on another site
// cannot read: what plays, your notes, your apps and your PC's numbers are not
// for any site you happen to visit.
const JSONP_PATHS = new Set(['/status']);
function isJsonpAllowed(pathname) {
  return JSONP_PATHS.has(pathname);
}

// State-mutating endpoints that also accept GET so the iCUE widget can reach
// them via <script> JSONP (Qt WebEngine blocks fetch). That same shape is a
// CSRF vector: any visited web page can trigger them with a <script> tag, which
// sends no Origin, so the loopback/Origin checks below can't catch it. They are
// guarded by the Sec-Fetch-Site check in the request handler.
const CSRF_MUTATION_PATHS = new Set([
  // Allow pressed on a widget on the screen (sdk-grant.js).
  '/sdk/grant',
  // A tile's own choices saved from a widget on the screen (tile-settings.js).
  '/settings/tile',
  // The Vitals widget's state saved from a widget on the screen (vitals-state.js).
  '/api/vitals/state',
  // Performance Mode with no dashboard (perf-screen.js): a page on another site
  // must not start an optimize session, nor rewrite the saved power plan GUID.
  '/api/performance/screen',
  '/api/performance/state',
  // Postpones the automatic update by an hour. It can only delay, never start
  // an install, but a page on another site has no business holding updates
  // back for the user either.
  '/update/auto/postpone',
  // Marks What's New and the fixes of a release as read. A page on another site
  // could otherwise make sure the user never hears about an update.
  '/update/notice-seen',
  // Bit's messages: filing one, or spending the day's on a page nobody sees, is
  // not something another site may do for the user.
  '/bit/messages/file',
  '/bit/messages/import',
  '/bit/messages/shown',
  '/bit/messages/read',
  // Raises a UAC prompt and changes the startup task's run level. POST-only, but
  // guarded here too: a cross-site drive-by must not be able to make the local
  // server throw an administrator prompt at the user.
  '/system/enable-sensors',
  '/api/ffmpeg/install',
  // Opens a System Settings pane in front of whatever the user was doing. It
  // grants nothing and takes no input, but a page that could throw the
  // permissions pane on screen at will is a nuisance a drive-by should not have.
  '/macos/fda-settings',
  // Answering a call focuses another application and presses keys into it, or
  // joins a Discord voice channel. POST-only, but listed for the same reason
  // /api/claude/decide is: a sandboxed SDK widget posts with Origin: null, and
  // the Sec-Fetch-Site reject is the only thing that stops one from answering
  // (or declining) a call on the user's behalf while they watch it happen.
  '/api/calls/act',
  // The debug ring. It only answers under XENON_CALLS_TEST=1, but a path that
  // can take over the screen belongs here whenever it is reachable at all.
  '/api/calls/test',
  // Places a real call on a real network. It is the only path in the product
  // that costs the user money per use and reaches a third party, so a drive-by
  // must not be able to reach it — nor a sandboxed SDK widget, which posts with
  // Origin: null and would otherwise be one fetch away from dialling.
  '/api/phone/dial',
  // Sends a real SMS, under the number this phone owns. Same class as
  // dialling: it reaches a third party, it is metered, it cannot be recalled.
  // (No apostrophes in this block: a test extracts these entries with a quote
  // regex over the raw source, and a lone apostrophe in a comment shifts the
  // pairing for every entry after it.)
  '/api/phone/send',
  '/toggle', '/mic/volume', '/volume/set', '/speaker/mute',
  '/audio/app/volume', '/audio/app/mute',
  // Runs PowerShell on a path taken from the query string (an icon lookup).
  // Read-only, but no page on another site may aim it.
  '/deck/app-icon',
  // A GET that once saved notes: guarded like the other controls so no page on
  // another site can reach it.
  '/notes',
  '/media/source', '/media/playpause', '/media/next', '/media/previous',
  // GET but not purely read-only: ?refresh=1 busts the catalog TTL cache and
  // forces an outbound fetch (throttled to 1/min). Guarded here so a cross-site
  // <img>/<script> drive-by can't make the local server hit the network.
  '/api/community/catalog',
  // Same property, worse economics: every cache-missed id is an outbound HTTPS
  // request for codes/<id>.txt with no refresh throttle — a cross-site <img>
  // loop over ids would turn the local server into a request pump without this.
  '/api/community/code',
  // Same property as the catalog: ?refresh=1 busts the TTL and forces an
  // outbound fetch of messages.json, so a drive-by must not be able to drive it.
  '/api/community/messages',
  // POST triggers an outbound request to the hub; the GET's cache miss does too.
  '/api/community/installed',
  '/api/community/installs',
  '/api/community/poll',
  // POST-only: stops a chat turn. Harmless, but a page on another site has no
  // business cutting the AI answers of the user short.
  '/api/ai/turn/stop',
  // A read, but a cache miss asks the supporter hub for its count.
  '/api/community/support-goal',
  // POST-only, but it triggers an outbound request to the supporter hub AND a
  // successful call consumes one of the code's device activations — a cross-site
  // drive-by (or a sandboxed iframe posting with Origin: null) must not be able
  // to burn a user's activations or pump the hub.
  '/api/community/redeem',
  // The owner update: POST-only, an outbound request to the supporter hub, and a
  // successful answer carries a content key and sometimes a private file, so a
  // drive-by or a sandboxed iframe with a null Origin must not be able to ask.
  '/api/community/update',
  // Same shape one step further: the remembered pass. /forget destroys
  // something only the user can restore (by typing the code again) and /save
  // would let a sandboxed widget plant a code of its own, so neither may be
  // reachable from a drive-by. Both POST-only, so a navigation misses them too.
  // The matching GET (/api/community/supporter) is a pure read and is
  // deliberately NOT here: listing it would refuse it on the paired-device door,
  // where the import dialog needs it.
  '/api/community/supporter/forget',
  '/api/community/supporter/save',
  // Buying with Sparks spends them and reaches the hub; the Sparks code save and
  // forget are the pass save and forget above. All POST-only. The matching read
  // (/api/community/sparks, booleans) is not listed, so a paired phone can show it.
  '/api/community/buy',
  '/api/community/sparks/save',
  '/api/community/sparks/forget',
  // The pass trial: /check reaches the hub, /tried writes what the trial took off.
  // POST-only; the matching read (/api/community/trial) is not listed, so a paired
  // phone can show the state of the trial.
  '/api/community/trial/check',
  '/api/community/trial/tried',
  // Automatic limited stock is a read, but a cache miss reaches the Hub.
  '/api/community/limited-status',
  // A YouTube search is 100 of the account's 10,000 daily quota units, so the
  // cost is the attack: a couple of hundred drive-by requests would leave the
  // user's own YouTube integration dead for the rest of the day.
  '/stream/youtube/search',
  // The SDK read surface reaches searchVideos, so it is the same 100 units a
  // drive-by away — and the paged reads defeat their own caches the way the chat
  // read does, one distinct page token at a time.
  '/stream/youtube/query',
  // The live-chat read spends quota too, and its cache cannot protect it from a
  // drive-by: the answer is held per PAGE TOKEN, so a loop over distinct ?page=
  // values misses every time, and with no broadcast on air the miss also costs
  // two liveBroadcasts.list calls before the cache is even consulted. Roughly
  // 5,000 <img> loads would exhaust the same 10,000-unit day /search is listed
  // here to protect. (Named back in as a remote read below: it changes nothing
  // on the PC and a paired phone genuinely shows the chat.)
  '/stream/youtube/chat',
  // Creator-side writes on the user's own channel. Creating a broadcast also
  // creates an ingestion endpoint on the account, cancelling throws one away, and
  // privacy decides who can watch — none of that may happen from a page the user
  // merely visited. The chat POST speaks publicly under the user's name.
  '/stream/youtube/broadcast/create',
  '/stream/youtube/broadcast/cancel',
  '/stream/youtube/privacy',
  '/stream/youtube/chat/send',
  // A Twitch channel search sends text the caller chose to Twitch under the
  // user's own token. No daily budget to burn here, but it is still an outbound
  // request a page the user merely visited has no business making. The chat send
  // is the stronger case of the same thing: it speaks publicly as the user.
  '/stream/twitch/search',
  '/stream/twitch/chat/send',
  // Ratings: the GET's cache miss triggers an outbound hub fetch (same rationale
  // as /api/community/catalog); the POST casts a vote under THIS install's id —
  // a drive-by must be able to do neither.
  '/api/community/ratings',
  '/api/community/rate',
  '/api/community/rating-close',
  // POST-only pack installs (the 'icons' / 'sounds' preset kinds) and the
  // widget package install. Belt-and-suspenders like /api/community/redeem: an
  // Origin:null frame must not be able to write a pack or widget folder behind
  // the user's back — installs go through the import dialog.
  '/icon-pack',
  '/sound-pack',
  '/sdk/install',
  // Downloads a native DLL from an external release and drops it where the
  // server will later load it as code. A drive-by page must not be able to start
  // that: the fetch is pinned and hash-checked, but the decision to run it is the
  // user's. POST-only already; listed so an Origin:null frame is refused too.
  '/api/lighting/sdk-install',
  // Claude Code bridge. The two ingest paths are POSTed by the `claude` process
  // itself (which sends no Sec-Fetch-Site, so this never blocks them) and are
  // additionally token-gated; listing them stops a browser page from POSTing
  // fabricated sessions or, worse, fabricated permission requests at the
  // touchscreen. /decide answers a real one and /link writes Claude Code's own
  // settings.json — neither may ever be reachable from a drive-by or from an
  // Origin:null sandboxed iframe.
  '/api/claude/event',
  '/api/claude/permission',
  // Same class as /permission and /event, and for the sharper version of the
  // same reason: /question is token-gated ingest whose response text is put in
  // front of the model, and /turn-end is the one ingest endpoint that can tell
  // a session to keep going. A page must be able to forge neither.
  '/api/claude/question',
  '/api/claude/turn-end',
  // The mod feed: token-gated ingest like /event, posted by the claude process.
  // The inbox hands a tile message to the mod, which starts a turn with it.
  '/api/claude/mod',
  '/api/claude/mod/permission',
  '/api/claude/mod/inbox',
  '/api/claude/decide',
  // Browser-originated like /decide, and guarded for the same reason. /answer
  // resolves a question Claude is blocked on and /reply puts words into a live
  // session under the name of whoever owns it — an Origin:null sandboxed widget
  // must not be one fetch away from either. (No apostrophes in this block: see
  // the note above /api/phone/send. A lone one shifts the pairing for every
  // entry after it, and the failure lands on an unrelated route.)
  '/api/claude/answer',
  '/api/claude/reply',
  '/api/claude/link',
  '/api/claude/unlink',
  '/api/claude/run',
  '/api/claude/run/stop',
  '/api/claude/folder',
  '/api/claude/attach',
  // Moves chat transcripts to the Recycle Bin: never from a drive-by page or a
  // sandboxed widget frame.
  '/api/claude/history/delete',
  // OpenAI Codex bridge, the same shape. /event and /permission are posted by
  // codex-hook.js (which Codex runs) and are token-gated as well; listing them
  // stops a page from forging a session or an approval card. /decide answers a
  // real one, and /link writes the Codex hooks.json, so neither may be reachable
  // from a drive-by or an Origin:null widget frame. The GET of /link is a pure
  // read (it never repairs) and is named back in for paired devices.
  '/api/codex/event',
  '/api/codex/permission',
  '/api/codex/decide',
  '/api/codex/link',
  '/api/codex/unlink',
  // The Ask ChatGPT tile: /ask spends the user plan on a program run, /cancel
  // kills one, /delete removes conversations. None may be a drive-by.
  '/api/chatgpt/ask',
  '/api/chatgpt/cancel',
  '/api/chatgpt/delete',
  // Local file search: /open launches a file with its registered handler and
  // /reveal opens an Explorer window — a drive-by or Origin:null iframe must
  // be able to do neither, even though both only accept server-minted opaque
  // ids. POST-only already; listed as belt-and-suspenders.
  '/search/open',
  '/search/reveal',
  // A question from a widget to the AI set for Bit spends Sparks, the money of
  // a key or plan quota, so the same: POST-only, listed so a navigation is refused.
  '/sdk/ai',
  // Widget authors' MCP (mcp-dev.js): pairing hands out a token and the calls
  // install widgets, so POST-only and never a navigation. Loopback only besides.
  '/api/mcp/dev/pair', '/api/mcp/dev/pair/poll', '/api/mcp/dev/pair/answer', '/api/mcp/dev/call',
  '/api/mcp/dev/report', '/api/mcp/dev/revoke', '/api/mcp/dev/connect',
  // Disk space: /scan spawns a full-drive walk (minutes of I/O), /clean moves
  // files to the Recycle Bin and /api/disk/advisor spends AI quota while
  // sharing the explicitly selected snapshot with the configured provider —
  // none may be reachable from a drive-by or Origin:null sandboxed iframe.
  '/disk/scan',
  '/disk/scan/cancel',
  '/disk/clean',
  '/disk/clean/cancel',
  // Opens a file manager window on the PC, like /search/reveal.
  '/disk/reveal',
  '/api/disk/advisor',
  // Dev cleanup: prunes Docker, removes Ollama models, recycles editor folders,
  // raises a UAC prompt to compact a virtual disk; the unlock spends a device
  // slot of the supporter pass on the hub.
  '/api/devclean/run',
  '/api/devclean/compact',
  '/api/features/devclean/unlock',
  // GET, but a cache miss sends one outbound lookup to LRCLIB for the song
  // playing now, so a cross-site page must not be able to drive it.
  '/api/lyrics',
  '/api/features/lyrics/unlock',
  // Spends the one trial this install gets: a navigation must not be able to.
  '/api/features/lyrics/trial',
  // Supporter Lyrics widget writes: a song's timing, and a translation that may
  // spend the user's AI provider quota. POST-only.
  '/api/lyrics/offset',
  '/api/lyrics/translate',
  // Suppresses the Edge fallback after the native kiosk opened the Spotlight
  // window — a drive-by must not be able to swallow the user's hotkey.
  '/spotlight/claimed',
  // Takes the sound/AI/mixer step of a Deck shortcut for this dashboard; a drive-by
  // must not be able to swallow the step (deck-shortcut-runner.js).
  '/deck/shortcut-claim',
  // A Deck key's AI/mixer step, handed from a window that cannot run it.
  '/deck/client-step',
  // A key placed on the screen: it runs what the key does.
  '/deck/press',
  '/tiles/play-claim',
  // The native shell says whether it draws widget layers and which monitors it
  // sees; a drive-by must not be able to switch the placement tools of the AI on.
  '/layers/host',
  // The virtual desktop the shell shows; a drive-by must not flip the widget pages.
  '/layers/desk',
  // Opens, closes the Xenon menu over the screen or wakes Bit (screen-menu.js).
  '/screen-menu',
  // Desktop capture. Both are GETs, but each spawns ffmpeg, photographs the
  // screen and writes a temp file — squarely the "GET that mutates" shape this
  // list exists for, and the returned image is the user's whole desktop. The
  // Origin layer cannot see a <script>/<img> drive-by (no Origin header) and
  // isAllowedRequest() accepts Origin:null from sandboxed iframes, so the
  // Sec-Fetch-Site reject is the only guard that catches either.
  '/api/screenshot',
  '/api/screenshot/monitor',
  // Paired-device access. /enable opens a door onto the LAN, /pair mints an
  // invitation, and the revokes close doors — a cross-site drive-by (or an
  // Origin:null sandboxed iframe) must be able to do none of them. /redeem is
  // listed for the same reason as /api/community/redeem: it is the one
  // pre-auth write on the remote door, and the Sec-Fetch-Site reject is the
  // layer that catches a shape the Origin check cannot see.
  '/api/remote-access/enable',
  '/api/remote-access/https',
  '/api/remote-access/https/setup',
  '/api/remote-access/pair',
  '/api/remote-access/pair/cancel',
  '/api/remote-access/redeem',
  '/api/remote-access/rename',
  '/api/remote-access/revoke',
  '/api/remote-access/revoke-all',
  // Web Push. /key mints the VAPID key pair on first call (a write), /subscribe
  // stores an address the PC will later send encrypted messages to, and /test
  // makes it send one — so all three are writes, and the last two are outbound.
  // A drive-by that could reach /subscribe would be registering ITS push
  // endpoint against the user's dashboard, which is the one shape that turns a
  // notification feature into a channel out of the machine.
  '/api/push/key',
  '/api/push/subscribe',
  '/api/push/unsubscribe',
  '/api/push/test',
  // File transfer. /upload writes a file to this PC, /open launches one with
  // its registered handler, /reveal opens a file-manager window, /delete
  // removes one, and /settings names the folder future arrivals land in — none
  // may be reachable from a drive-by or an Origin:null sandboxed iframe.
  //
  // /api/transfer/file, /thumb and /list are deliberately ABSENT. They are
  // pure reads, and listing a read here is not free: this set is handed to the
  // paired-device gate, which refuses every GET in it, and /file is fetched by
  // a top-level navigation the moment the user taps Download — so listing it
  // would refuse the very download that was just asked for.
  '/api/transfer/upload',
  '/api/transfer/open',
  '/api/transfer/reveal',
  '/api/transfer/delete',
  '/api/transfer/undo',
  '/api/transfer/settings',
  '/api/transfer/settings/pick',
  // Recording options: /pick opens a dialog on the PC, the POST names the
  // folder recordings land in and how many old ones may be deleted.
  '/capture/settings',
  '/capture/settings/pick',
  // The gallery: deleting, trimming, copying a capture, showing it in its folder.
  '/captures/delete',
  '/captures/reveal',
  '/captures/copy',
  '/captures/send',
  '/captures/trim',
  '/captures/clips',
  // The editor: private spots read off a screenshot, an edited copy saved.
  '/captures/spots',
  '/captures/save',
  // Writing down what is said in a video (whisper, on this PC).
  '/captures/transcribe',
  // A vertical, smaller or GIF copy of a video, and stopping one.
  '/captures/export', '/captures/export-cancel',
  '/api/ai-local/scan', // the hardware scan for local models: it saves what it found in the settings
]);

function isAllowedRequest(req) {
  // Layer 1: TCP source IP must be loopback (blocks LAN spoofing regardless of Host)
  const remoteAddr = req.socket.remoteAddress || '';
  if (!LOOPBACK_IPS.has(remoteAddr)) return false;

  // Layer 2: Host header must be a loopback address (protects against DNS rebinding)
  const host = (req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return false;

  // Layer 3: If an Origin header is present, it must also be loopback or opaque.
  // 'null' = opaque origin from Qt WebEngine (file:// or qrc:// page) — allowed.
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      // URL parsing strips the brackets from an IPv6 literal, so an
      // `http://[::1]:3030` Origin arrives here as hostname `::1`. Accept both
      // spellings; otherwise a legitimate loopback IPv6 page is rejected.
      const u = new URL(origin);
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' &&
          u.hostname !== '::1' && u.hostname !== '[::1]') return false;
    } catch { return false; }
  }
  return true;
}

// What a page on another site may do on the loopback door: see cross-site.js.
const { refusedCrossSite, refusedSocketOrigin } = require('./cross-site');

// ── The second door: paired devices (R1.1) ───────────────────────────────────
// isAllowedRequest() above is untouched and remains the only judge of LOCAL
// trust. What follows is a separate, narrower entrance for a phone or tablet the
// user has explicitly paired, and it is consulted ONLY after the loopback check
// has already failed. The two never mix: a request that fails one is never
// retried against the other, and a paired device gains nothing on the loopback
// path (it cannot produce a loopback source IP).
//
// See server/remote-access.js for the model. The short version: off by default,
// Host must be an IP literal this machine owns (a NAME is always refused, which
// is the whole anti-rebinding defence), Origin must be exactly ours (`null` is
// refused here even though loopback accepts it for the iCUE WebView),
// Sec-Fetch-Site must be same-origin on anything that is not a navigation, the
// path must be on an allowlist that denies by default, and the token is a
// per-device secret stored only as a hash.
// The one list that says which GETs mutate is CSRF_MUTATION_PATHS above; hand
// it to the paired-device gate rather than let it keep a second copy that can
// fall behind. (It ships a fallback copy for the unit tests, and a test reads
// this set out of the source and fails if the two have drifted.)
remoteAccessLib.useGetMutators(CSRF_MUTATION_PATHS);
const remoteAccess = remoteAccessLib.createRemoteAccess({ dir: DATA_DIR });
remoteAccess.load().catch((e) => console.error('[remote-access] load failed:', e.message));

// Web Push (T2c). Loaded eagerly because it is cheap (a JSON file that is
// usually absent) and because `webPushNotify` below is called from timers that
// must not await a first-use disk read. It mints NOTHING until the user asks:
// the key pair appears on disk the first time a device subscribes.
const webPush = webPushLib.createWebPush({ dir: DATA_DIR, log: (m) => console.log(m) });
webPush.load().catch((e) => console.error('[web-push] load failed:', e.message));

/**
 * The one place anything in this server sends a notification to a phone.
 *
 * A single funnel on purpose: push is the only thing Xenon does that reaches a
 * user who is not looking at a screen, so what may do it has to be countable.
 * Every call site is something the user set up themselves and is waiting for —
 * never a digest, never a nudge, and never mirrored content (a lock screen is a
 * public surface, and a notification body is not a place to put someone's
 * calendar). Failures are logged and swallowed: no feature may break because a
 * push service is down.
 */
function webPushNotify(message, opts) {
  if (!webPush.hasKeys() || !webPush.count()) return Promise.resolve({ ok: true, sent: 0 });
  return webPush.send(message, opts).catch((e) => {
    console.warn('[web-push] notify failed:', e && e.message);
    return { ok: false, sent: 0 };
  });
}

// ── Phone ↔ PC file transfer ────────────────────────────────────────────────
// The store lives under DATA_DIR and is never HTTP-reachable except through the
// dedicated routes below, which address files by an opaque id this server
// minted. See file-transfer.js for why the client's filename is a label, why
// delivery into the user's folder is a copy made afterwards rather than the
// upload's destination, and why retention can only ever remove our own
// duplicate.
const fileTransfer = fileTransferLib.createFileTransfer({
  dir: path.join(DATA_DIR, 'transfer'),
  dataDir: DATA_DIR,
  appRoot: path.join(__dirname, '..'),
});
// init() only reconciles the store against its own directory; the LIMITS come
// from the settings, so they are applied where those are read (the listen
// callback below, POST /api/transfer/settings, and the backup import) and never
// from here. Chaining them onto init() looked equivalent and was not: this runs
// at module evaluation, `hub.settings` is populated inside the listen
// callback, and init() won that race on every boot — so the user's maxFileMb,
// quotaMb and keepDays were silently replaced by the defaults on every restart,
// until they happened to re-save that one settings pane.
fileTransfer.init().catch((e) => console.error('[transfer] init failed:', e.message));

// Belt for the braces: every failure path in the upload route aborts its own
// write handle, so this only ever finds an upload whose socket died in a way
// `pipeline` never reported. Unref'd, so it cannot hold the process open.
const _transferSweepTimer = setInterval(() => {
  fileTransfer.sweepInflight().catch(() => {});
}, 5 * 60 * 1000);
_transferSweepTimer.unref();

function transferSettings() {
  const s = (hub.settings && hub.settings.fileTransfer) || DEFAULT_HUB_SETTINGS.fileTransfer;
  return s;
}

// The one push this feature can send, in the user's own language. Short, and
// deliberately carrying NO file name: a lock screen is a public surface, and
// the push funnel's rule is that a notification body never mirrors content.
const TRANSFER_PUSH_BODY = Object.freeze({
  it: 'Un file ti aspetta su Xenon',
  en: 'A file is waiting for you on Xenon',
  es: 'Un archivo te espera en Xenon',
  fr: 'Un fichier vous attend sur Xenon',
  de: 'Eine Datei wartet auf dich in Xenon',
  pt: 'Um ficheiro está à tua espera no Xenon',
  nl: 'Er staat een bestand voor je klaar in Xenon',
  ru: 'В Xenon вас ждёт файл',
  ja: 'Xenon にファイルが届いています',
  ko: 'Xenon에 파일이 도착했습니다',
  zh: 'Xenon 上有一个文件在等你',
});
function transferPushBody() {
  const lang = String((hub.settings && hub.settings.language) || '').slice(0, 2).toLowerCase();
  return TRANSFER_PUSH_BODY[lang] || TRANSFER_PUSH_BODY.en;
}

function transferEnabled() {
  return transferSettings().enabled !== false && fileTransfer.isLoaded();
}

/**
 * Where arrivals are copied. An empty setting means "wherever this OS keeps
 * Downloads" rather than "nowhere", so the feature works on first run without
 * the user having to choose a folder before their first photo.
 */
function transferInboxDir() {
  const s = transferSettings();
  if (s.inboxDir) return s.inboxDir;
  return fileTransferLib.defaultInboxDir({});
}

function _applyTransferLimits() {
  const s = transferSettings();
  fileTransfer.limits({
    maxBytes: Math.round(s.maxFileMb * 1024 * 1024),
    quotaBytes: Math.round(s.quotaMb * 1024 * 1024),
    keepMs: Math.round(s.keepDays * 24 * 60 * 60 * 1000),
  });
}

/**
 * The whole list, not a delta — the `status` convention, so a surface that
 * reconnects is correct with no replay to reason about. In-flight uploads ride
 * along so a phone that opens the dashboard mid-transfer sees them at once.
 */
function transferState(includePaths) {
  const st = fileTransfer.stats();
  return {
    enabled: transferEnabled(),
    items: fileTransfer.list({ includePaths: includePaths === true }),
    pending: fileTransfer.inflightList(),
    count: st.count,
    bytes: st.bytes,
    quotaBytes: st.quotaBytes,
    maxBytes: st.maxBytes,
  };
}

// Deliberately NOT gated behind a `transferWanted()` / `refreshTransferWatch()`
// pair. That idiom exists to stop a background poller or a child process from
// running when nobody can see its output; there is neither here, the events are
// emitted by the request that caused them, and broadcastSSE already returns
// immediately with no clients. Gating it would mean a file arriving while the
// widget happens to be hidden is never announced anywhere — the "looks alive,
// does nothing" failure this codebase avoids everywhere else.
function broadcastTransfer() {
  broadcastSSE('transfer', transferState(false));
}

// ── Taking a delete back ────────────────────────────────────────────────────
// A removed record is held here, blob and all, for a few seconds. Reported as
// "if I delete one photo they all get deleted and there is no way back": the
// first half was a boot bug (see file-transfer.js init), the second half was
// true on its own — the bin says "remove from the list", and with the copy into
// your own folder turned off that list holds the only copy there is.
//
// In memory, not on disk: an undo is a thing you do in the next breath, and a
// restart is exactly the moment to stop holding files nobody asked to keep.
// init()'s orphan sweep reclaims the blob if the process dies mid-window.
const TRANSFER_UNDO_MS = 12000;
const _transferUndo = new Map();   // id -> { rec, timer }

function holdForUndo(rec) {
  const timer = setTimeout(() => {
    _transferUndo.delete(rec.id);
    fileTransfer.discardBlob(rec).catch(() => {});
  }, TRANSFER_UNDO_MS);
  timer.unref && timer.unref();
  _transferUndo.set(rec.id, { rec, timer });
}

async function undoTransferDelete(id) {
  const held = _transferUndo.get(id);
  if (!held) return false;
  clearTimeout(held.timer);
  _transferUndo.delete(id);
  return !!(await fileTransfer.restore(held.rec));
}

/**
 * Copy a stored arrival into the user's folder, then tell every surface.
 *
 * Runs off the request path: the file is already safe by the time this starts,
 * so a folder that was renamed, unmounted or filled up degrades to "kept in
 * Xenon's inbox" with a reason, and never fails the transfer that succeeded.
 */
async function deliverTransfer(rec) {
  const s = transferSettings();
  if (!s.autoDeliver) return null;
  const inbox = transferInboxDir();
  if (!inbox) return null;
  // Validated BEFORE anything is created. `not_found` is the one refusal mkdir
  // is allowed to answer — the default <Downloads>/Xenon does not exist on a
  // fresh install — and it is reached only after the containment rules have
  // passed, because validInboxDir tests "absolute", "inside DATA_DIR" and
  // "inside the app root" before it ever stats. Creating first and checking
  // afterwards meant a folder the check was about to refuse got brought into
  // existence anyway.
  const inboxOpts = { dataDir: DATA_DIR, appRoot: path.join(__dirname, '..') };
  let check = await fileTransferLib.validInboxDir(inbox, inboxOpts);
  if (!check.ok && check.error === 'not_found') {
    try { await fs.promises.mkdir(inbox, { recursive: true }); } catch { /* re-checked below */ }
    check = await fileTransferLib.validInboxDir(inbox, inboxOpts);
  }
  if (!check.ok) {
    console.warn('[transfer] inbox refused:', check.error, inbox);
    return null;
  }
  const out = await fileTransfer.deliver(rec, inbox);
  if (!out.ok) {
    console.warn('[transfer] delivery failed:', out.error, inbox);
    return null;
  }
  await fileTransfer.markDelivered(rec.id, out.path);
  return out.path;
}

// The T2 door. Built here, started only when the user opts in (see
// _syncRemoteHttps) — a Tailscale-shaped feature must cost nothing on the very
// many machines that do not have Tailscale.
const remoteHttps = remoteHttpsLib.createRemoteHttps({
  tailscale: remoteControlTailscale.createTailscale({}),
  dataDir: DATA_DIR,
  // Deliberately not `server`'s inline handler: the function, so both listeners
  // run the identical application, behind the same error boundary.
  handler: (req, res) => runGuarded(handleRequest, req, res),
  log: (m) => console.log(m),
});

// The guided setup behind the panel's single button. It owns no state on disk —
// `onSettings` is the one write, and it goes through the same locked writer
// everything else uses.
// Named rather than inline because the status route asks it the same question
// the setup does ("can this machine install Tailscale by itself?"), and the
// instance caches what it has already probed — a fresh one per poll would
// re-run `command -v` on every status request.
const remoteHttpsInstaller = remoteControlInstaller.createInstaller({});

const remoteHttpsSetup = remoteHttpsSetupLib.createHttpsSetup({
  tailscale: remoteControlTailscale.createTailscale({}),
  installer: remoteHttpsInstaller,
  https: remoteHttps,
  log: (m) => console.log(m),
  onSettings: async (value) => {
    await withHubSettingsLock(async () => {
      const cur = await readHubSettingsForUpdate();
      const saved = await writeHubSettings({
        ...cur,
        remoteAccess: { ...(cur.remoteAccess || {}), https: value === true },
        rev: nextSettingsRev(cur.rev),
      });
      hub.settings = saved;
      broadcastSSE('settings', { rev: saved.rev });
    });
  },
});

/**
 * Bring the HTTPS door up or down to match the settings. Idempotent, never
 * throws, and safe to call from a settings save or at boot.
 *
 * It is gated on `remoteAccess.enabled` as well as its own flag on purpose: the
 * HTTPS listener serves the paired-device door and nothing else, so with pairing
 * switched off it would be a port answering to nobody.
 */
async function _syncRemoteHttps() {
  const ra = (hub.settings && hub.settings.remoteAccess) || {};
  const want = ra.enabled === true && ra.https === true;
  try {
    if (want) {
      const r = await remoteHttps.start();
      if (!r.ok) console.log('[https] not started: ' + r.reason);
    } else {
      await remoteHttps.stop();
    }
  } catch (e) { console.error('[https] sync failed:', e.message); }
}

/**
 * The door's state for the Settings panel: the cached one while it is up, a
 * freshly probed reason while it is down and the user has asked for it.
 *
 * Only asked when the switch is ON, so a machine that never wanted the door
 * never spawns the CLI for it.
 */
async function _remoteHttpsState() {
  const ra = (hub.settings && hub.settings.remoteAccess) || {};
  const st = remoteHttps.status();
  if (st.running || ra.enabled !== true || ra.https !== true) return st;
  return await remoteHttps.refreshReason().catch(() => st);
}

// Live sockets per paired device, so revoking one hangs up on it immediately
// instead of leaving an SSE stream running until the phone gives up.
const _remoteSockets = new Map();

// Our own addresses change when the user moves between networks or Tailscale
// comes up. Re-enumerating per request is wasteful and caching forever is wrong,
// so refresh on a short TTL — a stale entry only ever costs one refused request.
let _ownAddrCache = { at: 0, list: [] };
function _ownAddresses() {
  const now = Date.now();
  if (now - _ownAddrCache.at > 5000) {
    _ownAddrCache = { at: now, list: remoteAccessLib.ownAddresses() };
  }
  return _ownAddrCache.list;
}

function remoteAccessEnabled() {
  const ra = hub.settings && hub.settings.remoteAccess;
  // The store must be read before a token can resolve. Until it is, report the
  // feature as OFF rather than let the gate decide "this device is not paired":
  // in the few ms after boot that would send a perfectly good phone to the
  // pairing page, which reads as having been silently unpaired.
  return !!(ra && ra.enabled === true) && remoteAccess.isLoaded();
}

// The response a non-loopback request has always received. Kept byte-identical
// so a LAN scanner cannot tell a Xenon with the feature off from one built
// before the feature existed.
function _classicForbidden(res) {
  res.writeHead(403, { 'Content-Type': 'text/plain' });
  res.end('Forbidden');
  return null;
}

// A refusal a HUMAN is looking at must be readable. The phone's first hit is a
// top-level navigation, so a bare JSON body would put `{"error":...}` on screen
// with nothing to act on — and the most likely reason to land here is an older
// browser that does not send Sec-Fetch-Site at all (Safari gained it in 16.4),
// which is precisely the case where the person needs a sentence, not a code.
// Anything asking for JSON still gets JSON; only a document request gets a page.
const _REMOTE_DENY_HTML = [
  '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  '<meta name="robots" content="noindex"><meta name="color-scheme" content="dark">',
  '<title>Xenon</title><style>',
  'html,body{margin:0;height:100%}body{background:#070808;color:#f2f4f3;display:flex;align-items:center;',
  'justify-content:center;padding:32px;text-align:center;',
  'font:400 16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}',
  '.m{width:52px;height:52px;margin:0 auto 18px;border-radius:15px;background:linear-gradient(150deg,#1ed760,#0f8f3d);',
  'display:flex;align-items:center;justify-content:center;font-weight:800;font-size:24px;color:#041007}',
  'h1{font-size:1.15rem;margin:0 0 10px}p{margin:0;color:#9aa3a0;font-size:0.92rem}',
  'code{display:block;margin-top:22px;color:#4a5250;font-size:0.72rem}</style></head><body><div>',
  '<div class="m">X</div><h1 id="h"></h1><p id="p"></p><code>__REASON__</code></div>',
  '<script>(function(){var R="__REASON__";',
  'var T={',
  'en:{unpaired:["This device is not paired","Open Settings on your PC, choose Add device, and scan the code it shows."],bad_origin:["Opened from somewhere else","This page was reached from another site. Type the address shown on your PC directly instead."],bad_fetch_site:["Opened from somewhere else","This page was reached from another site. Type the address shown on your PC directly instead."],remote_denied:["That part stays on the PC","Paired devices can watch the dashboard and control media, audio and the microphone. This is not one of those."],other:["Xenon cannot open this","Go back to the pairing page on your PC and try again."]},',
  'it:{unpaired:["Questo dispositivo non \\u00e8 abbinato","Apri le Impostazioni sul PC, scegli Aggiungi dispositivo e inquadra il codice che compare."],bad_origin:["Aperta da un altro sito","Questa pagina \\u00e8 stata raggiunta da un altro sito. Digita direttamente l\\u2019indirizzo mostrato sul PC."],bad_fetch_site:["Aperta da un altro sito","Questa pagina \\u00e8 stata raggiunta da un altro sito. Digita direttamente l\\u2019indirizzo mostrato sul PC."],remote_denied:["Questa parte resta sul PC","I dispositivi abbinati possono guardare la dashboard e comandare media, audio e microfono. Questa non \\u00e8 una di quelle."],other:["Xenon non pu\\u00f2 aprire questa pagina","Torna alla pagina di abbinamento sul PC e riprova."]},',
  'de:{unpaired:["Dieses Ger\\u00e4t ist nicht gekoppelt","\\u00d6ffne die Einstellungen am PC, w\\u00e4hle Ger\\u00e4t hinzuf\\u00fcgen und scanne den angezeigten Code."],bad_origin:["Von woanders ge\\u00f6ffnet","Diese Seite wurde \\u00fcber eine andere Website erreicht. Gib die am PC angezeigte Adresse direkt ein."],bad_fetch_site:["Von woanders ge\\u00f6ffnet","Diese Seite wurde \\u00fcber eine andere Website erreicht. Gib die am PC angezeigte Adresse direkt ein."],remote_denied:["Das bleibt am PC","Gekoppelte Ger\\u00e4te sehen das Dashboard und steuern Medien, Audio und Mikrofon. Dies geh\\u00f6rt nicht dazu."],other:["Xenon kann das hier nicht \\u00f6ffnen","Geh am PC zur\\u00fcck zur Kopplungsseite und versuche es erneut."]},',
  'fr:{unpaired:["Cet appareil n\\u2019est pas associ\\u00e9","Ouvre les R\\u00e9glages sur le PC, choisis Ajouter un appareil et scanne le code affich\\u00e9."],bad_origin:["Ouverte depuis ailleurs","Cette page a \\u00e9t\\u00e9 atteinte depuis un autre site. Saisis directement l\\u2019adresse affich\\u00e9e sur le PC."],bad_fetch_site:["Ouverte depuis ailleurs","Cette page a \\u00e9t\\u00e9 atteinte depuis un autre site. Saisis directement l\\u2019adresse affich\\u00e9e sur le PC."],remote_denied:["\\u00c7a reste sur le PC","Les appareils associ\\u00e9s voient le tableau de bord et pilotent m\\u00e9dias, audio et micro. Pas ceci."],other:["Xenon ne peut pas ouvrir \\u00e7a","Retourne \\u00e0 la page d\\u2019association sur le PC et r\\u00e9essaie."]},',
  'es:{unpaired:["Este dispositivo no est\\u00e1 vinculado","Abre Ajustes en el PC, elige A\\u00f1adir dispositivo y escanea el c\\u00f3digo que aparece."],bad_origin:["Abierta desde otro sitio","Se lleg\\u00f3 a esta p\\u00e1gina desde otro sitio. Escribe directamente la direcci\\u00f3n que ves en el PC."],bad_fetch_site:["Abierta desde otro sitio","Se lleg\\u00f3 a esta p\\u00e1gina desde otro sitio. Escribe directamente la direcci\\u00f3n que ves en el PC."],remote_denied:["Esto se queda en el PC","Los dispositivos vinculados ven el panel y controlan medios, audio y micr\\u00f3fono. Esto no es una de esas cosas."],other:["Xenon no puede abrir esto","Vuelve a la p\\u00e1gina de vinculaci\\u00f3n en el PC e int\\u00e9ntalo de nuevo."]},',
  'pt:{unpaired:["Este dispositivo n\\u00e3o est\\u00e1 emparelhado","Abre as Defini\\u00e7\\u00f5es no PC, escolhe Adicionar dispositivo e l\\u00ea o c\\u00f3digo apresentado."],bad_origin:["Aberta a partir de outro s\\u00edtio","Esta p\\u00e1gina foi alcan\\u00e7ada a partir de outro s\\u00edtio. Escreve diretamente o endere\\u00e7o mostrado no PC."],bad_fetch_site:["Aberta a partir de outro s\\u00edtio","Esta p\\u00e1gina foi alcan\\u00e7ada a partir de outro s\\u00edtio. Escreve diretamente o endere\\u00e7o mostrado no PC."],remote_denied:["Isto fica no PC","Os dispositivos emparelhados veem o painel e controlam multim\\u00e9dia, \\u00e1udio e microfone. Isto n\\u00e3o."],other:["O Xenon n\\u00e3o consegue abrir isto","Volta \\u00e0 p\\u00e1gina de emparelhamento no PC e tenta de novo."]},',
  'ru:{unpaired:["\\u042d\\u0442\\u043e \\u0443\\u0441\\u0442\\u0440\\u043e\\u0439\\u0441\\u0442\\u0432\\u043e \\u043d\\u0435 \\u043f\\u0440\\u0438\\u0432\\u044f\\u0437\\u0430\\u043d\\u043e","\\u041e\\u0442\\u043a\\u0440\\u043e\\u0439\\u0442\\u0435 \\u043d\\u0430\\u0441\\u0442\\u0440\\u043e\\u0439\\u043a\\u0438 \\u043d\\u0430 \\u041f\\u041a, \\u0432\\u044b\\u0431\\u0435\\u0440\\u0438\\u0442\\u0435 \\u00ab\\u0414\\u043e\\u0431\\u0430\\u0432\\u0438\\u0442\\u044c \\u0443\\u0441\\u0442\\u0440\\u043e\\u0439\\u0441\\u0442\\u0432\\u043e\\u00bb \\u0438 \\u043e\\u0442\\u0441\\u043a\\u0430\\u043d\\u0438\\u0440\\u0443\\u0439\\u0442\\u0435 \\u043f\\u043e\\u043a\\u0430\\u0437\\u0430\\u043d\\u043d\\u044b\\u0439 \\u043a\\u043e\\u0434."],bad_origin:["\\u041e\\u0442\\u043a\\u0440\\u044b\\u0442\\u043e \\u0441 \\u0434\\u0440\\u0443\\u0433\\u043e\\u0433\\u043e \\u0441\\u0430\\u0439\\u0442\\u0430","\\u041d\\u0430 \\u044d\\u0442\\u0443 \\u0441\\u0442\\u0440\\u0430\\u043d\\u0438\\u0446\\u0443 \\u043f\\u0435\\u0440\\u0435\\u0448\\u043b\\u0438 \\u0441 \\u0434\\u0440\\u0443\\u0433\\u043e\\u0433\\u043e \\u0441\\u0430\\u0439\\u0442\\u0430. \\u0412\\u0432\\u0435\\u0434\\u0438\\u0442\\u0435 \\u0430\\u0434\\u0440\\u0435\\u0441, \\u043f\\u043e\\u043a\\u0430\\u0437\\u0430\\u043d\\u043d\\u044b\\u0439 \\u043d\\u0430 \\u041f\\u041a, \\u043d\\u0430\\u043f\\u0440\\u044f\\u043c\\u0443\\u044e."],bad_fetch_site:["\\u041e\\u0442\\u043a\\u0440\\u044b\\u0442\\u043e \\u0441 \\u0434\\u0440\\u0443\\u0433\\u043e\\u0433\\u043e \\u0441\\u0430\\u0439\\u0442\\u0430","\\u041d\\u0430 \\u044d\\u0442\\u0443 \\u0441\\u0442\\u0440\\u0430\\u043d\\u0438\\u0446\\u0443 \\u043f\\u0435\\u0440\\u0435\\u0448\\u043b\\u0438 \\u0441 \\u0434\\u0440\\u0443\\u0433\\u043e\\u0433\\u043e \\u0441\\u0430\\u0439\\u0442\\u0430. \\u0412\\u0432\\u0435\\u0434\\u0438\\u0442\\u0435 \\u0430\\u0434\\u0440\\u0435\\u0441, \\u043f\\u043e\\u043a\\u0430\\u0437\\u0430\\u043d\\u043d\\u044b\\u0439 \\u043d\\u0430 \\u041f\\u041a, \\u043d\\u0430\\u043f\\u0440\\u044f\\u043c\\u0443\\u044e."],remote_denied:["\\u042d\\u0442\\u043e \\u043e\\u0441\\u0442\\u0430\\u0451\\u0442\\u0441\\u044f \\u043d\\u0430 \\u041f\\u041a","\\u041f\\u0440\\u0438\\u0432\\u044f\\u0437\\u0430\\u043d\\u043d\\u044b\\u0435 \\u0443\\u0441\\u0442\\u0440\\u043e\\u0439\\u0441\\u0442\\u0432\\u0430 \\u0432\\u0438\\u0434\\u044f\\u0442 \\u043f\\u0430\\u043d\\u0435\\u043b\\u044c \\u0438 \\u0443\\u043f\\u0440\\u0430\\u0432\\u043b\\u044f\\u044e\\u0442 \\u043c\\u0435\\u0434\\u0438\\u0430, \\u0437\\u0432\\u0443\\u043a\\u043e\\u043c \\u0438 \\u043c\\u0438\\u043a\\u0440\\u043e\\u0444\\u043e\\u043d\\u043e\\u043c. \\u042d\\u0442\\u043e \\u043d\\u0435 \\u0438\\u0437 \\u0438\\u0445 \\u0447\\u0438\\u0441\\u043b\\u0430."],other:["Xenon \\u043d\\u0435 \\u043c\\u043e\\u0436\\u0435\\u0442 \\u044d\\u0442\\u043e \\u043e\\u0442\\u043a\\u0440\\u044b\\u0442\\u044c","\\u0412\\u0435\\u0440\\u043d\\u0438\\u0442\\u0435\\u0441\\u044c \\u043a \\u0441\\u0442\\u0440\\u0430\\u043d\\u0438\\u0446\\u0435 \\u043f\\u0440\\u0438\\u0432\\u044f\\u0437\\u043a\\u0438 \\u043d\\u0430 \\u041f\\u041a \\u0438 \\u043f\\u043e\\u043f\\u0440\\u043e\\u0431\\u0443\\u0439\\u0442\\u0435 \\u0441\\u043d\\u043e\\u0432\\u0430."]},',
  'ko:{unpaired:["\\uc5f0\\uacb0\\ub418\\uc9c0 \\uc54a\\uc740 \\uae30\\uae30\\uc785\\ub2c8\\ub2e4","PC\\uc5d0\\uc11c \\uc124\\uc815\\uc744 \\uc5f4\\uace0 \\uae30\\uae30 \\ucd94\\uac00\\ub97c \\uc120\\ud0dd\\ud55c \\ub4a4, \\ud45c\\uc2dc\\ub41c \\ucf54\\ub4dc\\ub97c \\uc2a4\\uce94\\ud558\\uc138\\uc694."],bad_origin:["\\ub2e4\\ub978 \\uacf3\\uc5d0\\uc11c \\uc5f4\\ub838\\uc2b5\\ub2c8\\ub2e4","\\ub2e4\\ub978 \\uc0ac\\uc774\\ud2b8\\ub97c \\uac70\\uccd0 \\uc774 \\ud398\\uc774\\uc9c0\\uc5d0 \\uc654\\uc2b5\\ub2c8\\ub2e4. PC\\uc5d0 \\ud45c\\uc2dc\\ub41c \\uc8fc\\uc18c\\ub97c \\uc9c1\\uc811 \\uc785\\ub825\\ud558\\uc138\\uc694."],bad_fetch_site:["\\ub2e4\\ub978 \\uacf3\\uc5d0\\uc11c \\uc5f4\\ub838\\uc2b5\\ub2c8\\ub2e4","\\ub2e4\\ub978 \\uc0ac\\uc774\\ud2b8\\ub97c \\uac70\\uccd0 \\uc774 \\ud398\\uc774\\uc9c0\\uc5d0 \\uc654\\uc2b5\\ub2c8\\ub2e4. PC\\uc5d0 \\ud45c\\uc2dc\\ub41c \\uc8fc\\uc18c\\ub97c \\uc9c1\\uc811 \\uc785\\ub825\\ud558\\uc138\\uc694."],remote_denied:["\\uc774 \\uae30\\ub2a5\\uc740 PC\\uc5d0 \\ub0a8\\uc2b5\\ub2c8\\ub2e4","\\uc5f0\\uacb0\\ub41c \\uae30\\uae30\\ub294 \\ub300\\uc2dc\\ubcf4\\ub4dc\\ub97c \\ubcf4\\uace0 \\ubbf8\\ub514\\uc5b4\\u00b7\\uc624\\ub514\\uc624\\u00b7\\ub9c8\\uc774\\ud06c\\ub97c \\uc81c\\uc5b4\\ud560 \\uc218 \\uc788\\uc2b5\\ub2c8\\ub2e4. \\uc774\\uac83\\uc740 \\ud574\\ub2f9\\ub418\\uc9c0 \\uc54a\\uc2b5\\ub2c8\\ub2e4."],other:["Xenon\\uc744 \\uc5ec\\uae30\\uc11c \\uc5f4 \\uc218 \\uc5c6\\uc2b5\\ub2c8\\ub2e4","PC\\uc758 \\ud398\\uc5b4\\ub9c1 \\ud654\\uba74\\uc73c\\ub85c \\ub3cc\\uc544\\uac00 \\ub2e4\\uc2dc \\uc2dc\\ub3c4\\ud558\\uc138\\uc694."]},',
  'ja:{unpaired:["\\u3053\\u306e\\u30c7\\u30d0\\u30a4\\u30b9\\u306f\\u30da\\u30a2\\u30ea\\u30f3\\u30b0\\u3055\\u308c\\u3066\\u3044\\u307e\\u305b\\u3093","PC \\u3067\\u8a2d\\u5b9a\\u3092\\u958b\\u304d\\u3001\\u300c\\u30c7\\u30d0\\u30a4\\u30b9\\u3092\\u8ffd\\u52a0\\u300d\\u3092\\u9078\\u3093\\u3067\\u8868\\u793a\\u3055\\u308c\\u305f\\u30b3\\u30fc\\u30c9\\u3092\\u8aad\\u307f\\u53d6\\u3063\\u3066\\u304f\\u3060\\u3055\\u3044\\u3002"],bad_origin:["\\u5225\\u306e\\u5834\\u6240\\u304b\\u3089\\u958b\\u304b\\u308c\\u307e\\u3057\\u305f","\\u5225\\u306e\\u30b5\\u30a4\\u30c8\\u7d4c\\u7531\\u3067\\u3053\\u306e\\u30da\\u30fc\\u30b8\\u306b\\u6765\\u3066\\u3044\\u307e\\u3059\\u3002PC \\u306b\\u8868\\u793a\\u3055\\u308c\\u3066\\u3044\\u308b\\u30a2\\u30c9\\u30ec\\u30b9\\u3092\\u76f4\\u63a5\\u5165\\u529b\\u3057\\u3066\\u304f\\u3060\\u3055\\u3044\\u3002"],bad_fetch_site:["\\u5225\\u306e\\u5834\\u6240\\u304b\\u3089\\u958b\\u304b\\u308c\\u307e\\u3057\\u305f","\\u5225\\u306e\\u30b5\\u30a4\\u30c8\\u7d4c\\u7531\\u3067\\u3053\\u306e\\u30da\\u30fc\\u30b8\\u306b\\u6765\\u3066\\u3044\\u307e\\u3059\\u3002PC \\u306b\\u8868\\u793a\\u3055\\u308c\\u3066\\u3044\\u308b\\u30a2\\u30c9\\u30ec\\u30b9\\u3092\\u76f4\\u63a5\\u5165\\u529b\\u3057\\u3066\\u304f\\u3060\\u3055\\u3044\\u3002"],remote_denied:["\\u3053\\u308c\\u306f PC \\u306b\\u6b8b\\u308a\\u307e\\u3059","\\u30da\\u30a2\\u30ea\\u30f3\\u30b0\\u3057\\u305f\\u30c7\\u30d0\\u30a4\\u30b9\\u306f\\u30c0\\u30c3\\u30b7\\u30e5\\u30dc\\u30fc\\u30c9\\u306e\\u8868\\u793a\\u3068\\u3001\\u30e1\\u30c7\\u30a3\\u30a2\\u30fb\\u97f3\\u58f0\\u30fb\\u30de\\u30a4\\u30af\\u306e\\u64cd\\u4f5c\\u304c\\u3067\\u304d\\u307e\\u3059\\u3002\\u3053\\u308c\\u306f\\u305d\\u306e\\u5bfe\\u8c61\\u5916\\u3067\\u3059\\u3002"],other:["Xenon \\u3092\\u3053\\u3053\\u3067\\u958b\\u3051\\u307e\\u305b\\u3093","PC \\u306e\\u30da\\u30a2\\u30ea\\u30f3\\u30b0\\u753b\\u9762\\u306b\\u623b\\u3063\\u3066\\u3084\\u308a\\u76f4\\u3057\\u3066\\u304f\\u3060\\u3055\\u3044\\u3002"]},',
  'zh:{unpaired:["\\u6b64\\u8bbe\\u5907\\u5c1a\\u672a\\u914d\\u5bf9","\\u5728\\u7535\\u8111\\u4e0a\\u6253\\u5f00\\u8bbe\\u7f6e\\uff0c\\u9009\\u62e9\\u201c\\u6dfb\\u52a0\\u8bbe\\u5907\\u201d\\uff0c\\u7136\\u540e\\u626b\\u63cf\\u51fa\\u73b0\\u7684\\u4ee3\\u7801\\u3002"],bad_origin:["\\u4ece\\u522b\\u5904\\u6253\\u5f00","\\u8fd9\\u4e2a\\u9875\\u9762\\u662f\\u4ece\\u53e6\\u4e00\\u4e2a\\u7f51\\u7ad9\\u8df3\\u8f6c\\u6765\\u7684\\u3002\\u8bf7\\u76f4\\u63a5\\u8f93\\u5165\\u7535\\u8111\\u4e0a\\u663e\\u793a\\u7684\\u5730\\u5740\\u3002"],bad_fetch_site:["\\u4ece\\u522b\\u5904\\u6253\\u5f00","\\u8fd9\\u4e2a\\u9875\\u9762\\u662f\\u4ece\\u53e6\\u4e00\\u4e2a\\u7f51\\u7ad9\\u8df3\\u8f6c\\u6765\\u7684\\u3002\\u8bf7\\u76f4\\u63a5\\u8f93\\u5165\\u7535\\u8111\\u4e0a\\u663e\\u793a\\u7684\\u5730\\u5740\\u3002"],remote_denied:["\\u8fd9\\u4e00\\u90e8\\u5206\\u7559\\u5728\\u7535\\u8111\\u4e0a","\\u5df2\\u914d\\u5bf9\\u7684\\u8bbe\\u5907\\u53ef\\u4ee5\\u67e5\\u770b\\u4eea\\u8868\\u677f\\u5e76\\u63a7\\u5236\\u5a92\\u4f53\\u3001\\u97f3\\u9891\\u548c\\u9ea6\\u514b\\u98ce\\u3002\\u8fd9\\u4e00\\u9879\\u4e0d\\u5728\\u5176\\u4e2d\\u3002"],other:["Xenon \\u65e0\\u6cd5\\u6253\\u5f00\\u8fd9\\u4e2a\\u9875\\u9762","\\u8bf7\\u56de\\u5230\\u7535\\u8111\\u4e0a\\u7684\\u914d\\u5bf9\\u9875\\u9762\\u91cd\\u8bd5\\u3002"]},',
  'nl:{unpaired:["Dit apparaat is niet gekoppeld","Open Instellingen op de pc, kies Apparaat toevoegen en scan de code die verschijnt."],bad_origin:["Vanaf ergens anders geopend","Deze pagina is via een andere site bereikt. Typ het adres dat je op de pc ziet rechtstreeks in."],bad_fetch_site:["Vanaf ergens anders geopend","Deze pagina is via een andere site bereikt. Typ het adres dat je op de pc ziet rechtstreeks in."],remote_denied:["Dit blijft op de pc","Gekoppelde apparaten bekijken het dashboard en bedienen media, audio en microfoon. Dit hoort daar niet bij."],other:["Xenon kan dit hier niet openen","Ga op de pc terug naar de koppelpagina en probeer het opnieuw."]},',
  '};',
  'var l=String(navigator.language||"en").slice(0,2).toLowerCase();var D=T[l]||T.en;',
  'var s=D[R]||D.other;',
  'document.documentElement.lang=T[l]?l:"en";',
  'document.getElementById("h").textContent=s[0];document.getElementById("p").textContent=s[1];})();',
  '<\/script></body></html>',
].join('');

function _wantsHtml(req) {
  return /\btext\/html\b/i.test(String(req.headers.accept || ''));
}

function _remoteJsonDeny(res, status, error, req) {
  if (req && _wantsHtml(req)) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    // The reason is one of our own fixed verdict strings, never user input —
    // but it lands inside both an HTML text node and a JS string literal, so
    // keep it constrained to the shape those two contexts agree on.
    res.end(_REMOTE_DENY_HTML.replace(/__REASON__/g, String(error).replace(/[^a-z_]/gi, '')));
    return null;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ ok: false, error }));
  return null;
}

function _peerIp(req) {
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function _noteRemoteSocket(deviceId, socket) {
  let set = _remoteSockets.get(deviceId);
  if (!set) { set = new Set(); _remoteSockets.set(deviceId, set); }
  if (set.has(socket)) return;
  set.add(socket);
  socket.once('close', () => {
    const s = _remoteSockets.get(deviceId);
    if (!s) return;
    s.delete(socket);
    if (s.size === 0) _remoteSockets.delete(deviceId);
  });
}

// Hang up on a device (or on everyone) the instant its token stops being valid.
// Without this, revoking a device leaves its open SSE stream feeding it live
// system data for as long as the socket survives — the revoke would look
// instant and not be.
function _dropRemoteSockets(deviceId) {
  const ids = deviceId ? [deviceId] : [..._remoteSockets.keys()];
  for (const id of ids) {
    const set = _remoteSockets.get(id);
    if (!set) continue;
    for (const socket of set) { try { socket.destroy(); } catch { /* already gone */ } }
    _remoteSockets.delete(id);
  }
}

/**
 * Decide what a non-loopback request may do.
 * @returns {{device: object|null}|null} a context to continue with, or null
 *   after this function has already answered — callers MUST return on null.
 */
function _remoteGate(req, res, secure) {
  // Short-circuit before any parsing or hashing. gateDecision() checks this
  // first too and would reach the same answer — but this is the default state
  // for every install, and anything scanning the LAN would otherwise make us
  // parse a URL and run a SHA-256 per packet for a feature nobody turned on.
  if (!remoteAccessEnabled()) return _classicForbidden(res);

  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return _classicForbidden(res); }

  // The token lookup is stateful, so it happens here; everything else is the
  // pure decision in remote-access.js, where the ORDER of the checks — which is
  // itself part of the security property — is unit-tested.
  const token = remoteAccessLib.readCookie(req.headers.cookie, remoteAccessLib.COOKIE_NAME);
  // A sandboxed SDK widget has an opaque origin, so its stylesheet and script
  // requests carry NO cookie however the cookie is spelled (measured — see the
  // widget-asset section in remote-access.js). Those requests present the
  // device's asset capability in the PATH instead. It is only ever consulted
  // for that path shape, so it cannot become a second way to hold a token: the
  // key lives nowhere else, and `/sdk/wk/...` serves nothing but static files
  // of installed packages.
  const device = remoteAccess.authenticate(token)
    || (() => {
      const parsed = remoteAccessLib.parseWidgetAssetPath(pathname);
      return parsed ? remoteAccess.authenticateAssetKey(parsed.key) : null;
    })();

  const verdict = remoteAccessLib.gateDecision({
    enabled: remoteAccessEnabled(),
    host: req.headers.host || '',
    origin: req.headers.origin,
    fetchSite: req.headers['sec-fetch-site'],
    fetchMode: req.headers['sec-fetch-mode'],
    method: req.method,
    pathname,
    hasDevice: !!device,
    addresses: _ownAddresses(),
    // The port THIS listener answers on, read from the socket rather than from
    // the PORT constant: with the T2 door up there are two, and the Host check
    // compares against the one the request actually arrived on.
    port: (req.socket && req.socket.localPort) || PORT,
    secure: secure === true,
    // The single certificate name the TLS listener accepts as a Host, learned
    // from the local tailscaled. '' whenever that door is down, which is what
    // keeps the exception from existing at all on a plain install.
    tlsHost: (secure === true && remoteHttps) ? remoteHttps.status().host : '',
  });

  switch (verdict) {
    case 'forbidden':
      return _classicForbidden(res);
    case 'bad_origin':
    case 'bad_fetch_site':
    case 'remote_denied':
      return _remoteJsonDeny(res, 403, verdict, req);
    case 'unpaired':
      return _remoteJsonDeny(res, 401, 'unpaired', req);
    case 'redirect_pair':
      res.writeHead(302, { Location: '/pair', 'Cache-Control': 'no-store' });
      res.end();
      return null;
    case 'pre_auth':
      // The pairing page and the redeem POST. Rate-limited by source address so
      // the one door without a token cannot be hammered; redeem() limits again
      // and burns the code after a handful of wrong guesses.
      if (!remoteAccess.withinPreAuthRate(_peerIp(req), Date.now())) return _remoteJsonDeny(res, 429, 'rate_limited');
      return { device: null };
    case 'ok':
      if (!remoteAccess.withinRate(device.id, Date.now())) return _remoteJsonDeny(res, 429, 'rate_limited');
      remoteAccess.touch(device, _peerIp(req));
      _noteRemoteSocket(device.id, req.socket);
      return { device };
    default:
      // An unknown verdict is a bug, and the safe reading of a bug is "no".
      return _classicForbidden(res);
  }
}

// Named, not inline, because a SECOND listener shares it: the T2 HTTPS door in
// remote-https.js serves the identical application — same routes, same handlers,
// same gate — over TLS on the Tailscale address. One handler, so the two
// transports can never drift into two behaviours.
// One client of the live feed, on HTTP (`/sse`) or on a socket (`/sse/socket`,
// sse-socket.js): it joins `sseClients` and is seeded with the current state.
function openSseClient(req, res, isRemote, remote) {
  res.write(':connected\n\n');

  // A paired device holds a few streams at most (a tab or two); more from
  // the same device are its oldest ones left open, so the oldest is closed.
  if (isRemote && remote && remote.device) {
    res._xenonDevice = remote.device.id;
    const mine = [...sseClients].filter((c) => c._xenonDevice === remote.device.id);
    while (mine.length >= SSE_MAX_PER_DEVICE) {
      const old = mine.shift();
      sseClients.delete(old);
      try { old.destroy(); } catch { /* already gone */ }
    }
  }
  sseClients.add(res);
  // The registry poll is client-gated, so a dashboard opening after a while
  // would otherwise seed itself from a list up to one interval old — long
  // enough to draw a session that has already been closed.
  _claudeSyncRegistry();
  _syncFpsMonitor(); // a dashboard is watching → run PresentMon (if installed)
  refreshObsWatch();
  refreshDiscordWatch();
  refreshHaWatch();
  refreshSbWatch();
  refreshWlWatch();
  refreshVoicemeeterWatch();
  refreshUnifiEventsWatch();
  refreshWinNotifWatch();
  refreshWakeWordWatch();
  refreshAudioLevelsWatch();
  _syncCodexDemand();
  req.on('close', () => { sseClients.delete(res); if (sseClients.size === 0) streamingLive.obsWanted = false; _syncFpsMonitor(); refreshObsWatch(); refreshDiscordWatch(); refreshHaWatch(); refreshSbWatch(); refreshWlWatch(); refreshVoicemeeterWatch(); refreshUnifiEventsWatch(); refreshWinNotifWatch(); refreshWakeWordWatch(); refreshAudioLevelsWatch(); _syncCodexDemand(); });

  // A dashboard is open, which is what "a day of use" means — see noteUsageDay.
  noteUsageDay();
  // Push current state immediately so the client doesn't wait for the first tick.
  seedReadings(res, [
    { event: 'system', read: getSystemInfo },
    { event: 'media', read: getMediaInfo },
    { event: 'audio', read: getAudioInfo, fallback: { unavailable: true } },
  ]).then(() => {
    // Full status payload — a partial {muted}-only seed read as "no game" on the
    // client, hiding the Companion pill on every SSE (re)connect.
    res.write(`event: status\ndata: ${JSON.stringify(statusPayload())}\n\n`);
  }).catch(() => {});
  // The Voicemeeter mixer as last read: the poll only broadcasts a change, so a
  // widget opening later would otherwise wait for someone to move a fader.
  if (vmWatch.lastJson) { try { res.write(`event: voicemeeter\ndata: ${vmWatch.lastJson}\n\n`); } catch (e) { /* ignore */ } }
  // A benchmark already recording: lights its Deck key, no toast (seed).
  try {
    const bench = _benchmark.status();
    if (bench.running) res.write(`event: benchmark\ndata: ${JSON.stringify({ running: true, game: bench.game, seed: true })}\n\n`);
  } catch (e) { /* ignore */ }
  // A recording already going: lights its Deck key and shows the "Recording" card.
  try {
    const rec = _recorder.status();
    if (rec.on) res.write(`event: recording\ndata: ${JSON.stringify({ ...rec, seed: true })}\n\n`);
  } catch (e) { /* ignore */ }
  // The steps recorder running: lights its Deck key and shows its card.
  try {
    const st = _stepsRecorder.status();
    if (st.on) res.write(`event: steps
data: ${JSON.stringify({ ...st, seed: true })}

`);
  } catch (e) { /* ignore */ }
  // Instant Replay on: lights its Deck key, no "replay on" card (seed).
  try {
    const rp = _replay.status();
    if (rp.enabled) res.write(`event: replay\ndata: ${JSON.stringify({ ...rp, seed: true })}\n\n`);
  } catch (e) { /* ignore */ }
  // Seed a ringing call. A dashboard that opens (or a phone that unlocks)
  // mid-ring must show the card immediately: the whole point of the feature is
  // the ~40 seconds a call lasts, and waiting for the next broadcast would
  // spend most of them. Empty is the normal case and costs one line.
  try {
    const ringing = calls.current();
    if (ringing.length) res.write(`event: calls\ndata: ${JSON.stringify({ calls: ringing })}\n\n`);
  } catch (e) { /* ignore */ }
  // Seed the phone's live state for the same reason, one level down: the
  // widget shows "in chiamata" while a call is up, and a dashboard opened
  // during one would otherwise look idle until the call ended.
  try {
    if (phone.enabled()) res.write(`event: phone\ndata: ${JSON.stringify(phone.state())}\n\n`);
  } catch (e) { /* ignore */ }
  // Seed the transfer list. A phone that opens the dashboard while a file is
  // still going up must see both the list and the upload in progress at once,
  // rather than an empty widget until something next changes. The path to the
  // delivered copy is included only for the PC — see transferState.
  try { res.write(`event: transfer\ndata: ${JSON.stringify(transferState(!isRemote))}\n\n`); } catch (e) { /* ignore */ }
  // Seed the just-connected client with the current OBS state (if watching).
  if (obsWatching.stop) { try { res.write(`event: obs\ndata: ${JSON.stringify(obsWatch.state)}\n\n`); } catch (e) { /* ignore */ } }
  if (obsWatching.stop && obsWatch.preview.image) { try { res.write(`event: obs_preview\ndata: ${JSON.stringify(obsWatch.preview)}\n\n`); } catch (e) { /* ignore */ } }
  // Seed the just-connected client with the current Home Assistant state.
  buildHaState().then((st) => { try { res.write(`event: homeassistant\ndata: ${JSON.stringify(st)}\n\n`); } catch (e) { /* ignore */ } }).catch(() => {});
  // Seed the just-connected client with the current Streamer.bot globals.
  buildSbState().then((st) => { try { res.write(`event: streamerbot\ndata: ${JSON.stringify(st)}\n\n`); } catch (e) { /* ignore */ } }).catch(() => {});
  // Seed the current peripheral battery. The 'battery' tick is 90s, and unlike
  // the builtin tile (which fetches GET /api/battery on mount) a sandboxed SDK
  // widget has no seed endpoint of its own — it can only wait for the stream,
  // so without this it sits on "Looking for devices…" for up to a minute and a
  // half after every reload. getDevices() is TTL-cached and dedups concurrent
  // callers, so several surfaces connecting at once still cost one read.
  // Gated like the tick: nothing that shows a battery, nothing to seed.
  batteryWanted()
    .then((wanted) => (wanted ? batteryMonitor.getDevices() : null))
    .then((payload) => { if (payload) { try { res.write(`event: battery\ndata: ${JSON.stringify(payload)}\n\n`); } catch (e) { /* ignore */ } } })
    .catch(() => {});
  // Seed the current stock quotes (paint immediately), then kick a refresh if
  // the cache is empty/stale so a freshly opened dashboard fills in fast.
  try { if (stocksState.cache.quotes.length) res.write(`event: stocks\ndata: ${JSON.stringify(stocksState.cache)}\n\n`); } catch (e) { /* ignore */ }
  if (!stocksState.cache.quotes.length || Date.now() - stocksState.cache.refreshedAt > 5 * 60 * 1000) refreshStocks().catch(() => {});
  // Seed the current football fixtures/results, then kick a refresh if stale.
  try { if (footballState.cache.teams.length) res.write(`event: football\ndata: ${JSON.stringify(_footballPayload())}\n\n`); } catch (e) { /* ignore */ }
  if (!footballState.cache.teams.length || Date.now() - footballState.cache.refreshedAt > 5 * 60 * 1000) refreshFootball().catch(() => {});
  // Seed the current news headlines, then kick a refresh if empty/stale
  // (display-only feed: only when the widget/ticker actually uses it).
  try { if (newsState.cache.items.length) res.write(`event: news\ndata: ${JSON.stringify(newsState.cache)}\n\n`); } catch (e) { /* ignore */ }
  if (_feedWidgetInUse('news', 'news') && (!newsState.cache.items.length || Date.now() - newsState.cache.refreshedAt > 15 * 60 * 1000)) refreshNews().catch(() => {});
  // Seed the current Claude Code usage aggregate, then refresh if empty/stale
  // (display-only feed: only when the widget is on the dashboard).
  try { res.write(`event: claude\ndata: ${JSON.stringify(_claudeFresh())}\n\n`); } catch (e) { /* ignore */ }
  if (_feedWidgetInUse('claude') && (!claudeState.cache.data || Date.now() - claudeState.cache.refreshedAt > 5 * 60 * 1000)) refreshClaude().catch(() => {});
  // Seed the Codex state (live approvals included, so a card waiting before this
  // dashboard opened is drawn at once).
  try { res.write(`event: codex\ndata: ${JSON.stringify(_codexPayload())}\n\n`); } catch (e) { /* ignore */ }
  // A store put back from its daily copy at this boot: say so to the screens
  // that open in the first half hour (each shows it once, main.js).
  if (_storeRecovery.length && Date.now() - _storeRecoveryAt < 30 * 60 * 1000) {
    try { res.write(`event: store_recovery\ndata: ${JSON.stringify({ at: _storeRecoveryAt, stores: _storeRecovery.map(({ file, state, from }) => ({ file, state, from })) })}\n\n`); } catch (e) { /* ignore */ }
  }
  // Seed the SDK data-only streams (tasks/notes/agenda) for custom widgets.
  // Unlike system/media/audio/status these are broadcast ONLY on change, so a
  // sandboxed widget subscribing to one (it can't fetch) would paint nothing
  // until the user next edits a task/note/event. Same loopback-only stream and
  // same payload shape as the change broadcasts; the custom-widget host forwards
  // each only to a frame that was granted that stream.
  { const seq = agendaState.tasksSeq; readTasks().then(t => { try { res.write(`event: tasks\ndata: ${JSON.stringify({ tasks: t, seq })}\n\n`); } catch (e) { /* ignore */ } }).catch(() => {}); }
  { const seq = agendaState.eventsSeq; readEvents().then(ev => { try { res.write(`event: agenda\ndata: ${JSON.stringify({ events: ev, seq })}\n\n`); } catch (e) { /* ignore */ } }).catch(() => {}); }
  readNotes().then(n => { try { if (n) res.write(`event: notes\ndata: ${JSON.stringify(n)}\n\n`); } catch (e) { /* ignore */ } }).catch(() => {});
  // Timers too: timer_update otherwise fires only on mutations/completions, so
  // a reloaded dashboard (or a fresh Virtual Deck popup) would show blank
  // countdown faces and unlit timerRunning keys for the rest of a running timer.
  try { res.write(`event: timer_update\ndata: ${JSON.stringify({ timers: timerState.list })}\n\n`); } catch (e) { /* ignore */ }
  // And the relayed SDK deck states, so a fresh Virtual Deck popup paints its
  // sdkState keys without waiting for the next widget state change.
  try { if (Object.keys(_sdkDeckStates.states).length) res.write(`event: sdk_states\ndata: ${JSON.stringify(_sdkDeckStates)}\n\n`); } catch (e) { /* ignore */ }
  // Same reason: a surface that connects AFTER a script set a state would
  // otherwise draw its key dark until the next change, which for a state that
  // changes twice a day is most of the day. Sent even when the map is EMPTY,
  // unlike the relayed SDK states above: a widget granted the `scriptStates`
  // stream has no other way to tell "nothing is set" from "not told yet", and
  // an empty map is one short line per connection.
  try { res.write(`event: script_states\ndata: ${JSON.stringify(_scriptStates)}\n\n`); } catch (e) { /* ignore */ }
}

const { chatWithCloudKey } = require('./ai/chat-cloud-key.js');
const { chatWithXenon } = require('./ai/chat-xenon.js');
const { chatWithCli } = require('./ai/chat-cli.js');
const { chatWithOllama } = require('./ai/chat-ollama.js');
const { chatWithLocalServer } = require('./ai/chat-local-server.js');

// feature-routes.js loads the tables of routes here, in the order the lines
// below always loaded them. A line below names a table this file still calls.
featureRoutes.loadTables();
const { branches: deckBranches } = require('./deck/routes.js');
const { branches: installBranches } = require('./install/routes.js');
const { branches: engineBranches } = require('./engine/routes.js');
const { branches: widgetSdkCallsBranches } = require('./widget-sdk/routes-calls.js');
const { branches: widgetSdkPackagesBranches } = require('./widget-sdk/routes-packages.js');
const { branches: diskBranches } = require('./disk/routes.js');
const { branches: storeCatalogPacksBranches } = require('./store-catalog/routes-packs.js');
const { branches: timeBranches } = require('./time/routes.js');
const { branches: lookBranches } = require('./look/routes.js');
const { branches: smartHomeCamerasBranches } = require('./smart-home/routes-cameras.js');
const { branches: widgetSdkImagesBranches } = require('./widget-sdk/routes-images.js');
const { branches: mcpDevBranches } = require('./mcp/routes-dev.js');

// The names of this file the tables of routes are handed (feature-routes.js),
// read once, at the first request. tools/restructure/dispatch-move.mjs writes the list.
const routeHands = () => ({
  AI_MODELS, BACKGROUND_EXT_BY_MIME, FONT_EXT_BY_MIME, PORT, SLIDESHOW_ASSET_EXT_BY_MIME, TILE_ASSET_EXT_BY_MIME, TRANSFER_UNDO_MS,
  _aiPerformancePlan, _audioToWav16k, _captureCovers, _captureExport, _captureFolder, _captureGallery, _captureHost, _captures,
  _chatgptAsker, _chatgptPayload, _chatgptStore, _claudeAttach, _claudeBridge, _claudeBridgeAuth, _claudeCommands, _claudeFresh,
  _claudeHistory, _claudeHoldPermission, _claudeInbox, _claudeLinkStatus, _claudeModReply, _claudeRunner, _codexApp, _codexBridge,
  _codexBridgeAuth, _codexChanged, _codexLinkStatus, _codexPayload, _deckConfirms, _deskPageSync, _dropRemoteSockets, _footballPayload,
  _gameSessions, _geminiOneShot, _loadFootballInfo, _menuHotkey, _peerIp, _perfStream, _persistLighting, _processesHistory,
  _remoteHttpsState, _replay, _saveTimers, _sttDeviceLabel, _sttDeviceWhenReady, _sttInputArgs, _sttVia, _syncCodexDemand, _syncRemoteHttps,
  _syncSessionWatch, _transcribeAudio, _transcripts, _whisperReady, _xenonMenuState, aiActionLog, aiMemory, applyBackup, applyBindHost,
  applySecondScreenMode, autoUpdater, batteryMonitor, bitMessages, broadcastHaDeckStates, broadcastTransfer, buildBackup, buildHaState,
  buildSbState, buildWlState, capabilityRunner, captureScreenshot, chooseBackupFolder, chooseCaptureFolder, chooseTransferFolder,
  cliOneShot, collectSensors, companionLookSparks, completeWithUserAi, deckChroma, deckHa, deckObs, deckPress, deckRegistry, deckSb,
  deckShortcutRunner, deckUnifi, deckVoicemeeter, deckWaveLink, defaultCaptureFolder, deliverTransfer, devClean, drawShell, dropSdkGrant,
  embeddedBrowser, featureUnlock, fileSearch, fileTransfer, geminiKeyFor, getAudioInfo, getCurrentLyrics, getFfmpegPath, getMediaInfo,
  getNetworkInfo, getSlideshowDir, getSystemInfo, getWeather, guardian, haQuery, helperArrived, helperInstall, holdForUndo, iconPackStore,
  installWidgetPayload, isCatalogUpdateOf, keySendAvailable, keySendProblem, layersEdit, layersHost, layersPeek, livingIndex, loadWhatsNew,
  lyricsForPlayingKey, lyricsOffsets, lyricsTranslateBlocker, lyricsTranslator, makeMarkClips, mediaAction, nativeMedia,
  openDeckPopupWindow, openDiscordChat, perfRegistry, perfSession, perfStats, performAiUndo, phone, phoneKeysAvailable, ratingVotes,
  readHubSettings, readHubSettingsForUpdate, readNotes, recordWidgetOrigin, refreshClaude, refreshDiscordWatch, refreshExternalFeeds,
  refreshFootball, refreshHaWatch, refreshHotkeyListener, refreshLivingIndex, refreshObsWatch, refreshSbWatch, refreshSdkScan,
  refreshStocks, refreshUnifiEventsWatch, refreshWakeWordWatch, refreshWlWatch, remoteAccess, remoteAccessEnabled, remoteControl,
  remoteHttps, remoteHttpsInstaller, remoteHttpsSetup, replayDiskInfo, roastSparks, routeHotkeyIndex, routeSpotlightHotkey,
  saveBackupToDisk, saveNotesGuarded, saveNoticeSeen, saveSdkGrant, saveStreamConfig, saveTileSettings, saveVitalsState, screenCapture,
  screenMenu, sdkAi, sdkPackagesCached, secondScreen, selfUpdate, sendCaptureToPhone, setDefaultAudioDevice, setMediaPreferredSource,
  setMicMute, smallTaskModel, soundPackStore, speakOnServer, stopServerSpeak, svvExec, tilePlay, transcodeMp4BackgroundToWebm,
  transferEnabled, transferInboxDir, transferPushBody, transferSettings, transferState, trialPass, trialVault, undoTransferDelete,
  updateCaptureSettings, updateEvents, updatePerformanceSetting, updateTasks, updateTransferSettings, userAiVisionBlocker, vitalsNag,
  webPush, webPushNotify, widgetAutoUpdater, widgetCatalogVersionOf, widgetExportable, widgetOptionsStore, widgetOriginOf, withDeckWrite,
  writeDeckStore, writeEvents, writeHubSettings, writeNotes, writeTasks,
});

const handleRequest = async (req, res) => {
  // Which listener this arrived on. Read from the SOCKET, never from a header:
  // it decides whether a certificate name is an acceptable Host and which scheme
  // an Origin must carry, and a request must not be able to describe itself.
  const secureListener = !!(req.socket && req.socket.encrypted);

  // Two doors, never mixed. The loopback boundary is unchanged and is tried
  // first; only a request it refuses is offered the paired-device door, which
  // is off by default and far narrower (see _remoteGate).
  //
  // The TLS listener skips the loopback door entirely — it IS the paired-device
  // door. Its Host is a MagicDNS name, which the loopback boundary refuses by
  // design, so consulting it could only ever produce a 403 on the very URL we
  // handed the user. Opening the HTTPS address on the PC itself therefore asks
  // for pairing like any other device, which is the honest answer: that address
  // is the tailnet's, not this machine's private one.
  let remote = null;
  if (secureListener || !isAllowedRequest(req)) {
    remote = _remoteGate(req, res, secureListener);
    if (!remote) return;              // _remoteGate has already answered
  }
  // True for anything that arrived through the paired-device door. Handlers use
  // it to withhold what a phone must not see (see /settings) — it is never used
  // to GRANT anything: authorization is the allowlist's job, not a handler's.
  const isRemote = remote !== null;

  // On every answer, both doors. A route that sends its own CSP (SDK widgets,
  // icon packs, captures) replaces this one through writeHead, and keeps its
  // stricter policy.
  //  · frame-ancestors: only Xenon's own pages and the iCUE widget (a local
  //    file, file: or qrc:) may show a page of ours in a frame. Without it a
  //    site could put the dashboard in an invisible frame and steer a click
  //    onto a Deck key or a setting.
  //  · nosniff: a browser never guesses a type, so an answer can never be
  //    taken for a page or a script it was not served as.
  //  · frame-src: the frames our pages may load are our own (widgets, scenes,
  //    backgrounds) and the YouTube and Twitch players, with Google's sign-in
  //    page, the one Google host a player may need. Never a wildcard on
  //    google.com: script.google.com and docs.google.com hand whatever is in
  //    the URL to whoever wrote the page. The browser checks it
  //    on every navigation of a child frame too, before the request leaves,
  //    so a widget or a background preview that sends its frame to another
  //    site is stopped there, data in the URL included.
  //  · object-src, base-uri, form-action: nothing of ours uses plugins, a
  //    <base> tag or forms posting elsewhere, so none may appear.
  res.setHeader('Content-Security-Policy', [
    "frame-ancestors 'self' file: qrc:",
    "frame-src 'self' https://www.youtube-nocookie.com https://*.youtube-nocookie.com https://www.youtube.com https://*.youtube.com https://player.twitch.tv https://*.twitch.tv https://accounts.google.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Requests from other sites: see cross-site.js. Before the OPTIONS reply,
  // so a refused preflight is refused here too.
  let reqPathEarly = '';
  try { reqPathEarly = new URL(req.url, 'http://localhost').pathname; } catch { /* refused below as foreign if it matters */ }
  if (!isRemote && refusedCrossSite(req, PORT, reqPathEarly, { jsonp: isJsonpAllowed })) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // CORS headers required for the iCUE widget WebView (opaque origin, qrc:// or file://).
  // Access-Control-Allow-Private-Network is required by Chrome 104+ (Private Network
  // Access spec) when a non-secure context (file://) fetches a private-network address.
  //
  // NOT sent on the paired-device door, and withholding them turns out to be
  // the FIRST line of defence there rather than a tidy-up. A phone's own page
  // is same-origin and needs none of them, whereas Allow-Private-Network is
  // precisely the header a public website needs before Chrome will let it
  // reach a private address at all. Measured: from a page on another origin, a
  // credentialed cross-origin POST, a no-cors POST and an <img> drive-by
  // against the LAN address all failed to produce a single request at the
  // server — Private Network Access stopped them in the browser. Behind that
  // sit SameSite=Strict (no cookie on a cross-site-initiated request) and the
  // exact-Origin check; see remote-access.js.
  if (!isRemote) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // JSONP support: if ?cb=<name> is present, wrap the response in a JS callback.
  // Used by the iCUE widget where fetch() is blocked by Qt WebEngine's
  // LocalContentCanAccessRemoteUrls policy; <script> tag injection bypasses it.
  const urlObj  = new URL(req.url, 'http://localhost');
  const jsonpCb = urlObj.searchParams.get('cb');
  const json    = data => {
    const body = JSON.stringify(data);
    // Local API responses are live state — never let the browser/WebView cache them
    // (a cached /api/lighting/status was masking real changes during diagnosis).
    if (jsonpCb && /^[A-Za-z_$][\w$]*$/.test(jsonpCb) && isJsonpAllowed(urlObj.pathname)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(jsonpCb + '(' + body + ');');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
    }
  };
  const err500 = msg  => { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(String(msg)); };
  // Every dashboard page leaves through here: asset-version.js puts a version on
  // what it lists, so the load asks nothing for a file the browser already has.
  const sendPage = async (html) => {
    const page = await assetVersion.stamp(html, __dirname, APP_VERSION);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(page);
  };

  const reqPath = urlObj.pathname;

  // Any audio route means a surface is showing (or driving) the Volume UI right
  // now, which is what keeps the 8s SoundVolumeView tick alive — see
  // audioPollWanted(). Done here rather than in each handler so a route added
  // later cannot forget it and silently let the mixer go stale mid-adjustment.
  if (reqPath.startsWith('/audio') || reqPath.startsWith('/volume/') || reqPath.startsWith('/speaker/')) {
    _noteAudioWatched();
  }

  // CSRF guard: reject cross-site drive-by requests to state-mutating endpoints.
  // The browser stamps Sec-Fetch-Site and a page can't forge it — a cross-site
  // <script>/<img>/fetch is 'cross-site', while the same-origin dashboard's own
  // fetch is 'same-origin'. Only the cross-site case is blocked; an absent header
  // (non-browser caller / older WebView) is allowed, same as the /deck/sound gate.
  // The SDK proxy/webhook POST routes are state-touching ingress that, like the
  // GET mutators above, must NOT be reachable by a cross-site drive-by. They rely
  // only on the Origin layer otherwise, and isAllowedRequest() deliberately
  // accepts `Origin: null` (Qt WebEngine) — so a hostile page's sandboxed iframe
  // (opaque origin → Origin: null) could otherwise reach them. Prefix match:
  // /sdk/hook carries a /<pkg>/<id> tail. Loopback tools send no Sec-Fetch-Site.
  const isSdkSensitive = reqPath === '/sdk/fetch' || reqPath.startsWith('/sdk/hook/') || reqPath === '/sdk/handler-ack' || reqPath === '/sdk/deck-states' || reqPath === '/sdk/store' || reqPath === '/sdk/secret' || reqPath === '/state/set';
  // Pack DELETE carries a /<id> tail (not an exact CSRF_MUTATION_PATHS entry),
  // so guard it by prefix — the same belt-and-suspenders the POST installs get,
  // so an Origin:null iframe can never remove a user's installed packs even if
  // the CORS method allowlist ever widens.
  const isPackMutation = req.method === 'DELETE' && (reqPath.startsWith('/icon-pack/') || reqPath.startsWith('/sound-pack/'));
  // A top-level NAVIGATION to any of these has no legitimate caller: every one is
  // a fetch/JSONP/POST endpoint, never a page a browser should land on. The
  // Sec-Fetch-Site layer alone misses that shape, because a browser-INITIATED
  // navigation stamps `none` rather than `cross-site` — which is exactly what a
  // CDP-driven navigate sends, so the embedded browser tile could otherwise be
  // pointed at every GET mutator above (`/notes?save=` replaces the whole notes
  // store). Absent header = non-browser caller, still allowed.
  const isTopLevelNav = String(req.headers['sec-fetch-mode'] || '').toLowerCase() === 'navigate';
  if ((CSRF_MUTATION_PATHS.has(reqPath) || isSdkSensitive || isPackMutation) &&
      (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site' || isTopLevelNav)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (reqPath === '/' && req.method === 'GET') {
    await engineBranches['GET /'](req, res, { json, err500, reqPath, urlObj, isRemote, remote, sendPage });

  } else if (reqPath === '/ping' && req.method === 'GET') {
    await engineBranches['GET /ping'](req, res, { json, err500, reqPath, urlObj, isRemote });

  } else if (reqPath === '/status' && req.method === 'GET') {
    await engineBranches['GET /status'](req, res, { json, err500, reqPath, urlObj, isRemote, jsonpCb }, { statusPayload });

  } else if (reqPath === '/system/theme' && req.method === 'GET') {
    // The OS colour scheme, for the "Auto" appearance. The embedded WebView's
    // prefers-color-scheme is not an authority — it is wrong at exactly the
    // moments that matter. On macOS it reports LIGHT for a moment after the
    // display wakes, which fired the media-query listener and repainted the
    // whole dashboard white; nothing corrected it afterwards, because nothing
    // else on that platform knew any better. Reported on Discord from a Mac
    // mini (Sep 2026): dark before the screen slept, white after it woke.
    //
    // So the OS is asked directly, per platform, and that reading is what Auto
    // resolves against. `osDark: null` means "no reading here" and sends the
    // client back to the media query — an unknown must never be answered as
    // light, since light is the wrong half of the guess.
    json(await osTheme.read());

  } else if (reqPath === '/api/disks/io' && req.method === 'GET') {
    await diskBranches['GET /api/disks/io'](req, res, { json, err500, reqPath, urlObj, isRemote }, { getDiskIo });

  } else if (reqPath === '/api/devstorage' && req.method === 'GET') {
    await diskBranches['GET /api/devstorage'](req, res, { json, err500, reqPath, urlObj, isRemote }, { devClean });

  } else if (featureRoutes.has(req.method, reqPath)) {
    // A route that lives in its feature's routes.js (feature-routes.js).
    await featureRoutes.run(req.method, reqPath, req, res, { json, err500, reqPath, urlObj, isRemote, jsonpCb, remote, sendPage, sdkStreamGranted: _sdkStreamGranted, history: guardian, getFfmpegPath }, routeHands);

  } else if (reqPath.startsWith('/deck/sounds/') && req.method === 'DELETE') {
    await deckBranches['DELETE /deck/sounds/*'](req, res, { json, err500, reqPath, urlObj, isRemote });

  } else if (BIT_MESSAGE_ROUTES[reqPath] && req.method === 'POST') {
    // Filed, imported from the old mail, shown, read. Everything is rebuilt in
    // bit-messages.js; all four are in CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req, BIT_MESSAGE_BODY_MAX) || '{}');
      json({ ok: await BIT_MESSAGE_ROUTES[reqPath](body) });
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'bad_request' }));
    }

  } else if (reqPath === '/api/startup-task' && req.method === 'GET') {
    await installBranches['GET /api/startup-task'](req, res, { json, err500, reqPath, urlObj, isRemote }, { startupTaskCheck });

  } else if (reqPath === '/api/native/install' && req.method === 'POST') {
    await installBranches['POST /api/native/install'](req, res, { json, err500, reqPath, urlObj, isRemote });

  } else if (reqPath.startsWith('/api/unifiprotect/snapshot/') && req.method === 'GET') {
    await smartHomeCamerasBranches['GET /api/unifiprotect/snapshot/*'](req, res, { json, err500, reqPath, urlObj, isRemote }, { deckUnifi, readHubSettings });

  } else if (reqPath.startsWith('/api/ha/camera/snapshot/') && req.method === 'GET') {
    await smartHomeCamerasBranches['GET /api/ha/camera/snapshot/*'](req, res, { json, err500, reqPath, urlObj, isRemote }, { deckHa });

  } else if (reqPath === '/startup/auto-open' && req.method === 'GET') {
    await installBranches['GET /startup/auto-open'](req, res, { json, err500, reqPath, urlObj, isRemote });

  } else if (reqPath === '/startup/auto-open' && req.method === 'POST') {
    await installBranches['POST /startup/auto-open'](req, res, { json, err500, reqPath, urlObj, isRemote });

  } else if (reqPath.startsWith('/api/timers/') && req.method === 'PATCH') {
    await timeBranches['PATCH /api/timers/*'](req, res, { json, err500, reqPath, urlObj, isRemote }, { _saveTimers });

  } else if (reqPath.startsWith('/api/timers/') && req.method === 'DELETE') {
    await timeBranches['DELETE /api/timers/*'](req, res, { json, err500, reqPath, urlObj, isRemote }, { _saveTimers });

  } else if (reqPath === '/api/ai' && req.method === 'POST') {
    try {
      const aiRaw = await readBodyBuffer(req, 10 * 1024 * 1024); // 10 MB — accommodate base64 images
      const aiBody = JSON.parse(aiRaw.toString('utf8') || '{}');
      aiTurns.begin(aiBody.turnId, res);
      const apiKey = await geminiKeyFor(aiBody.key);
      const messages = Array.isArray(aiBody.messages) ? aiBody.messages.slice(0, 50) : [];
      const isVoice = aiBody.voice === true;
      // Rolling summary of earlier turns the client folded out of its window
      // (see /api/ai/summarize). Injected into the system prompt so the model
      // keeps the thread of a long conversation. Bounded defensively.
      const convSummary = String(aiBody.summary || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
      // The UI language. Used to force the reply language — without it Gemini tends
      // to answer in English when the turn carries an image or audio (little text to
      // infer from), which breaks an otherwise Italian conversation.
      const _uiLang2 = String(aiBody.lang || '').toLowerCase().slice(0, 2);
      const langName = aiLangName(_uiLang2);

      const provider = aiLocal.sanitizeProvider(aiBody.provider);
      const ollModel = aiLocal.sanitizeModel(aiBody.model);

      if (provider === 'gemini' && !apiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_key' })); return;
      }
      if (!messages.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no_messages' })); return;
      }

      const AI_FUNCTIONS = buildCoreAiFunctions();

      // Validate and sanitise attachment parts sent by the client. Gemini accepts
      // images, PDFs and plain text inline; documents are sent as text/plain.
      const ALLOWED_ATTACH_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain']);
      const rawImageParts = Array.isArray(aiBody.imageParts) ? aiBody.imageParts.slice(0, 4) : [];
      const safeImageParts = rawImageParts
        .filter(p => p && ALLOWED_ATTACH_TYPES.has(p.mimeType) && typeof p.data === 'string' && p.data.length > 0)
        .map(p => ({ mimeType: p.mimeType, data: p.data.slice(0, 8 * 1024 * 1024) }));

      // Validate and sanitise an optional audio clip sent by the client. When
      // present, Gemini transcribes AND answers the spoken request in this single
      // call — no separate speech-to-text round-trip needed.
      const ALLOWED_AUDIO_TYPES = new Set(['audio/wav', 'audio/webm', 'audio/ogg', 'audio/mp4']);
      const rawAudioParts = Array.isArray(aiBody.audioParts) ? aiBody.audioParts.slice(0, 1) : [];
      const safeAudioParts = rawAudioParts
        .filter(p => p && ALLOWED_AUDIO_TYPES.has(p.mimeType) && typeof p.data === 'string' && p.data.length > 0)
        .map(p => ({ mimeType: p.mimeType, data: p.data.slice(0, 12 * 1024 * 1024) }));
      const hasAudio = safeAudioParts.length > 0;

      // The same pictures fitted to go inside a creation (ai-attached-pictures.js),
      // with a line telling the model how to name them.
      const _aiPictures = aiPictures.picturesFrom(aiBody.pictures);
      const _aiSurface = aiSurface.surfaceOf(aiBody, req.headers.referer);
      const picturesNote = aiPictures.picturesNote(_aiPictures);

      // Inject images + audio into the last user message (current turn only — not stored in history)
      let currentMessages = messages.slice();
      const extraParts = [
        ...(picturesNote ? [{ text: picturesNote }] : []),
        ...safeImageParts.map(p => ({ inlineData: p })),
        ...safeAudioParts.map(p => ({ inlineData: p })),
      ];
      if (extraParts.length > 0 && currentMessages.length > 0) {
        const last = currentMessages[currentMessages.length - 1];
        if (last.role === 'user') {
          currentMessages[currentMessages.length - 1] = {
            role: 'user',
            parts: [...(last.parts || []), ...extraParts],
          };
        }
      }

      const _latestUserText = (() => {
        for (let i = currentMessages.length - 1; i >= 0; i--) {
          const msg = currentMessages[i];
          if (!msg || msg.role !== 'user' || !Array.isArray(msg.parts)) continue;
          return msg.parts.map(p => typeof p.text === 'string' ? p.text : '').join(' ').trim();
        }
        return '';
      })();
      const _latestLooksLikeClothingWeather = /\b(vestit|vesti|vestir|indoss|mettermi|mettere|temperatur|meteo|weather|temperature|wear|outfit|clothes|jacket|giacca|felpa|maglione|cappotto)\b/i.test(_latestUserText);
      const _latestExplicitlyWantsScreen = /\b(schermo|monitor|screenshot|display|desktop|finestra|immagine|foto|screen|look|see|read|guarda|vedi|leggi|analizza|mostrato|visualizzato)\b/i.test(_latestUserText);

      const _now = new Date();
      const _nowDate = _now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const _nowTime = _now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const _tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      // Deck profiles live only in the browser; the client sends the current list
      // each turn. Surface their exact names so Xenon can switch by name reliably.
      const _deckProfiles = (Array.isArray(aiBody.deckProfiles) ? aiBody.deckProfiles : [])
        .map((p) => (p && typeof p === 'object') ? { name: String(p.name || '').slice(0, 40), active: !!p.active } : { name: String(p || '').slice(0, 40), active: false })
        .filter((p) => p.name)
        .slice(0, 24);
      const _deckProfilesText = _deckProfiles.length
        ? ` The Deck widget has these profiles (switch with switch_deck_profile using the EXACT name): ${_deckProfiles.map((p) => p.active ? `"${p.name}" (currently active)` : `"${p.name}"`).join(', ')}.`
        : '';
      // ── Opt-in advanced AI features ──────────────────────────────────
      // The client sends only the flags the user enabled in Settings → Funzioni
      // AI. Each flag unlocks its tools + prompt context for this turn only, so
      // disabled features cost zero extra tokens.
      const _features = (aiBody.features && typeof aiBody.features === 'object') ? aiBody.features : {};
      // Integrations the user connected: their tools and the line that names them.
      const { streamingText: _streamingText, integrationsText: _integrationsText } = await addIntegrationAiFunctions(AI_FUNCTIONS);
      // GENESIS — AI-composed dashboard pages. The page/widget map is client-
      // owned (like deck profiles), so the client sends a snapshot per turn.
      let _genesisText = '';
      if (_features.genesis === true) {
        const ds = (aiBody.dashboardState && typeof aiBody.dashboardState === 'object') ? aiBody.dashboardState : null;
        const _avail = (ds && Array.isArray(ds.availableWidgets) ? ds.availableWidgets : [])
          // 64, not 32: the list has grown past 40, and the cut fell on the
          // newest widgets (search, disk, transfer, phone…), which the model was
          // then never told exist.
          .filter(w => typeof w === 'string').slice(0, 64).map(w => w.slice(0, 24));
        const _pages = (ds && Array.isArray(ds.pages) ? ds.pages : [])
          .filter(p => p && typeof p === 'object').slice(0, 8)
          .map(p => ({
            name: String(p.name || '').slice(0, 40),
            widgets: (Array.isArray(p.widgets) ? p.widgets : []).slice(0, 64).map(w => String(w).slice(0, 24)),
          }));
        const _maxPages = (ds && Number.isFinite(ds.maxPages)) ? ds.maxPages : 8;
        AI_FUNCTIONS.push(
          { name: 'genesis_compose_page', description: 'GENESIS: create a NEW dashboard page with the given name and widgets, then switch to it. Call this ONLY once you know what the page is for: if the user just said "create a dashboard/page" with no purpose, ask first. Pick widgets ONLY from the available widget ids in the system context. Use "tabs" to group related widgets into tabbed tiles and "sizes" to make key tiles wider.', parameters: { type: 'OBJECT', properties: {
            name: { type: 'STRING', description: 'Short page name in the user\'s language, e.g. "Streaming"' },
            widgets: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Widget ids to place on the page (3-6 is ideal), from the available list' },
            tabs: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'STRING' } }, description: 'Optional: groups of 2+ widget ids (all also present in "widgets") to merge into a single tabbed tile. e.g. [["twitch","obs"]] puts Twitch and OBS as tabs in one tile. Use when widgets are related or when the user asks for tabs.' },
            sizes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { widget: { type: 'STRING' }, size: { type: 'STRING', description: 'small | medium | large | wide | full' } }, required: ['widget', 'size'] }, description: 'Optional: make specific tiles wider than the balanced default. Use "wide"/"full" for the page\'s primary tile (e.g. the main video/preview or chat).' },
          }, required: ['name', 'widgets'] } },
          { name: 'genesis_add_widgets', description: 'GENESIS: add widgets to an EXISTING dashboard page (referenced by its exact name from the current pages list), then switch to it. Use "tabs" to group widgets into tabbed tiles without disturbing the rest of the page.', parameters: { type: 'OBJECT', properties: {
            page: { type: 'STRING', description: 'Exact name of the existing page' },
            widgets: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Widget ids to add, from the available list' },
            tabs: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'STRING' } }, description: 'Optional: groups of 2+ widget ids (on this page) to merge into tabbed tiles.' },
          }, required: ['page', 'widgets'] } },
          { name: 'genesis_duplicate_widget', description: 'GENESIS: mirror/duplicate a single widget onto another dashboard page (by its exact name). Duplicable widgets (media, mic, tasks, notes, agenda, system, audio, timer, lighting) become a LIVE copy shown on both pages; use when the user wants the same widget available on more than one page.', parameters: { type: 'OBJECT', properties: {
            widget: { type: 'STRING', description: 'Widget id to duplicate, from the available list' },
            page: { type: 'STRING', description: 'Exact name of the destination page' },
          }, required: ['widget', 'page'] } },
          { name: 'genesis_remove_page', description: 'GENESIS: remove a dashboard page by its exact name. DESTRUCTIVE: always confirm with the user before calling.', parameters: { type: 'OBJECT', properties: {
            page: { type: 'STRING', description: 'Exact name of the page to remove' },
          }, required: ['page'] } },
          { name: 'genesis_setup_deck', description: 'GENESIS: populate the Deck (stream-deck) widget with a ready-to-use profile of keys. Call this in the SAME turn whenever you compose/extend a page that includes the "deck" widget, or when the user asks to configure the deck. Each key needs a short title in the user\'s language, one emoji icon, a theme-fitting accent hex color and an action from the allowed list.', parameters: { type: 'OBJECT', properties: {
            profile: { type: 'STRING', description: 'Short profile name in the user\'s language matching the theme, e.g. "Gaming"' },
            cols: { type: 'NUMBER', description: 'Grid columns (1-8), proportionate to the number of keys' },
            rows: { type: 'NUMBER', description: 'Grid rows (1-8); cols×rows should fit all keys' },
            keys: { type: 'ARRAY', description: 'The deck keys, most essential first (4-10 ideal)', items: { type: 'OBJECT', properties: {
              title: { type: 'STRING', description: 'Short key label in the user\'s language (max ~12 chars)' },
              icon: { type: 'STRING', description: 'An icon from the Deck\'s own library when one fits: ' + require('./js/deck-icons.js').ids().join(', ') + '. Else a single emoji' },
              color: { type: 'STRING', description: 'Accent hex color for the key, e.g. #ff3b30' },
              action: { type: 'STRING', description: 'One of: media_playpause, media_next, media_prev, play_sound, mic_toggle, volume_mute, volume_up, volume_down, app_mixer, app_volume_up, app_volume_down, app_mute, ai_voice, ai_chat, ai_prompt, lighting_color, open_app, open_file, open_store_app, open_url, hotkey, webhook, dashboard_page, obs_record, obs_stream, obs_scene, obs_scene_next, twitch_clip, twitch_marker, twitch_ad, twitch_title, twitch_game, twitch_chat, twitch_shoutout, twitch_chatmode, yt_broadcast, sb_action, remote_disconnect, remote_block, remote_screen_cycle' },
              value: { type: 'STRING', description: 'Action parameter when needed: prompt text for ai_prompt; hex color for lighting_color; URL for open_url/webhook; app path for open_app/open_file; key combo for hotkey (e.g. "ctrl+shift+m"); a page name or next/prev/back for dashboard_page; scene name for obs_scene; app name for app_volume_up/down and app_mute; new title/game/message/login for twitch_title/twitch_game/twitch_chat/twitch_shoutout. Omit otherwise.' },
              ledColor: { type: 'STRING', description: 'Optional hex color: flashes the RGB lighting when the key fires. Use on the most important keys.' },
            }, required: ['title', 'icon', 'action'] } },
          }, required: ['profile', 'keys'] } },
        );
        _genesisText = ` GENESIS (dashboard composer) is ENABLED. Available widget ids: ${_avail.join(', ') || 'unknown'}.` +
          ` Current pages: ${_pages.map(p => `"${p.name}" [${p.widgets.join(', ') || 'empty'}]`).join('; ') || 'none'} (max ${_maxPages} pages).` +
          ' When the request names a clear activity or theme (e.g. "build me a streaming page"), pick the most relevant widgets (3-6) and call genesis_compose_page with a short fitting name: no need to ask which widgets.' +
          ' When the request is GENERIC ("create a new dashboard/page" with no purpose), do NOT compose yet: first ask, in the user\'s language, one short question about what the page is for, suggesting 2-3 concrete examples (e.g. gaming, work/focus, music, streaming). If useful, follow up with at most ONE more question about what they want to see on it, then compose. Never ask more than two questions before composing.' +
          ' RICH LAYOUT: compose thoughtfully, not just a flat row of tiles:' +
          '  • TABS: pass "tabs" to genesis_compose_page/genesis_add_widgets to merge related widgets into a single tabbed tile. ALWAYS honour an explicit request for tabs, AND use tabs on your own when two or more widgets are closely related or the page would otherwise be crowded, e.g. group [obs, twitch] or [obs, twitch, youtube] on a streaming page, [tasks, agenda, notes] on a work page, [media, audio, mic] for sound. Never group a widget the user wants prominent on its own.' +
          '  • SIZES: pass "sizes" to make the page\'s primary tile wider ("wide" or "full"), e.g. the OBS/preview tile on a streaming page, the media tile on a music page, so the layout has a clear focal point.' +
          '  • DUPLICATE: call genesis_duplicate_widget to mirror a widget (media, mic, tasks, notes, agenda, system, audio, timer, lighting) onto another page when the user wants it available in more than one place (e.g. "keep the player on every page").' +
          ' DECK: the "deck" widget is a programmable stream-deck key grid, NEVER leave it empty. Whenever a page you compose or extend includes "deck" (or the user asks to set up the deck), ALSO call genesis_setup_deck in the same turn: pick the most essential keys for the theme (4-10), e.g. for gaming: mic toggle, app mixer, play/pause, lighting color, OBS record; for streaming: OBS stream/record/scene, mic toggle, mixer, each with a short title in the user\'s language, one fitting emoji, an accent hex color matching the theme, and add ledColor on the most important keys so the RGB lighting reacts on press. Choose cols×rows proportionate to the key count (4 keys → 2x2, 6 → 3x2, 8 → 4x2).' +
          ' After all genesis calls, ALWAYS recap briefly in the user\'s language what you created: the page, its widgets, and each deck key with its function.' +
          ' Confirm before genesis_remove_page.';
      }
      // GUARDIAN — long-term hardware health. Exposes a single read-only tool
      // that returns the locally-computed digest (no extra API calls).
      let _guardianText = '';
      if (_features.guardian === true) {
        AI_FUNCTIONS.push({
          name: 'guardian_report',
          description: 'GUARDIAN: get the hardware-health digest, CPU/GPU load and temperature plus RAM usage aggregated over the last 24h / 7 days / 30 days, with 7d-vs-30d trend deltas. Call BEFORE answering any question about PC health, temperatures over time, thermal trends, or "is my PC ok".',
          parameters: { type: 'OBJECT', properties: {} },
        });
        AI_FUNCTIONS.push({
          name: 'query_sensor_history',
          description: 'GUARDIAN: get the recorded history of ONE sensor broken down for comparison, today vs yesterday, last 24h, 7-day and 30-day averages, the peak day of the last 30 days, and the last 7 daily points. Use this (not guardian_report) for specific time comparisons like "was my GPU hotter yesterday than today", "what was my worst day this month", "how has my CPU temp trended this week".',
          parameters: { type: 'OBJECT', properties: {
            metric: { type: 'STRING', description: 'Which sensor: "cpu" (load %), "cpuTemp", "gpu" (load %), "gpuTemp", "mem" (RAM %), "cpuWatts" or "gpuWatts" (power draw). Friendly names like "gpu temp", "ram" or "cpu power" also work.' },
          }, required: ['metric'] },
        });
        _guardianText = ' GUARDIAN (hardware health history) is ENABLED: when the user asks about PC health, temperatures, or long-term trends, call guardian_report and base your analysis ONLY on its real data, mention notable maxima and 7d-vs-30d trends, suggest practical fixes (dust, fan curve, background apps) only when the data justifies them, and say so plainly when everything looks healthy. For a SPECIFIC time comparison or a single sensor over time (today vs yesterday, worst day this month, this week\'s trend), call query_sensor_history with the metric instead. If collectedDays is low, note that the history is still short.';
      }
      // PERSISTENT MEMORY — durable facts Xenon remembers about the user across
      // sessions. On by default (local & private); disabled via Settings →
      // Funzioni AI. The tools are exposed and the stored facts are injected into
      // the prompt only while enabled, so a user who turned it off pays nothing.
      let _memoryText = '';
      {
        const _sm = (await readHubSettings().catch(() => null)) || {};
        if (_sm.aiMemory !== false) {
          AI_FUNCTIONS.push(...buildMemoryFunctions());
          _memoryText = aiMemory.count() > 0 ? aiMemory.formatForPrompt() : aiMemory.emptyPromptHint();
        }
      }
      // PC CONTROL — consent-gated generic Windows command execution. Off by
      // default; the tool NEVER runs a command directly — it proposes one that
      // executes only after the user approves a confirmation card.
      let _pcControlText = '';
      // POWERSHELL_SUPPORTED, not just the flag: a tool the runner cannot
      // execute must not reach the model at all. Offering it would produce a
      // confirmation card the user approves and that then fails to spawn.
      if (_features.pcControl === true && POWERSHELL_SUPPORTED) {
        AI_FUNCTIONS.push({
          name: 'run_pc_command',
          description: 'PC CONTROL: run a Windows PowerShell command on the user\'s PC to do something the other tools do not cover (system tweaks, file operations, launching things with arguments, queries…). This NEVER runs automatically: the user sees a confirmation card with the exact command and must approve it. Propose the SMALLEST, most targeted command that does the job, and always fill "description" with a short plain-language explanation of what it does and why. Prefer a dedicated tool when one exists (audio, media, apps, lighting…), and run_deck_action for anything a Deck key does: typing text, pressing keys or a hotkey, opening a file or a link, moving a window.',
          parameters: { type: 'OBJECT', properties: {
            command: { type: 'STRING', description: 'The exact PowerShell command to run, e.g. "Get-Process | Sort CPU -desc | Select -First 5".' },
            description: { type: 'STRING', description: 'Short plain-language summary of what this command does, shown to the user on the confirmation card.' },
          }, required: ['command', 'description'] },
        });
        _pcControlText = ' PC CONTROL is ENABLED: you may use run_pc_command for actions no other tool covers. It executes ONLY after the user approves a confirmation card showing the exact command, so after calling it, do NOT say it is done; instead tell the user to review and confirm on the card: the result is shown to them there once it runs. Always prefer a dedicated tool when one exists. Keep commands minimal and safe; if a request is ambiguous or potentially destructive (deleting files, changing system config), explain the risk and ask the user to confirm the intent before proposing the command.'
          + ' Make each command SELF-SUFFICIENT so it does not fail on a missing prerequisite: when creating a file in a folder that may not exist, create the folder first in the same command (e.g. `New-Item -ItemType Directory -Force -Path "$HOME\\Desktop\\Nintendo" | Out-Null; New-Item -ItemType File -Force -Path "$HOME\\Desktop\\Nintendo\\dante.txt" -Value "…"`), and generally use `-Force`/existence checks so a reasonable command succeeds on the first try. If a command fails, read the error shown on the card and propose a corrected one.';
      }
      // The core tools on every turn, the rest by group when a request needs one
      // (ai-tool-groups.js): past 128 tools the hub and OpenAI refuse the turn.
      // Claude Code and Codex reach the tools through MCP and keep the full list.
      const toolKit = AiToolGroups.kit(AI_FUNCTIONS, aiBody.toolGroups);
      const AI_TOOLS = toolKit.tools;
      const _summaryText = convSummary
        ? ` CONVERSATION MEMORY. A summary of earlier parts of THIS conversation that scrolled out of the recent window (treat it as accurate context; the recent turns follow after it): ${convSummary}`
        : '';
      // Its own string so the Xenon credits path can move it out of the cached prefix.
      const SYS_NOW = `Current date and time: ${_nowDate}, ${_nowTime} (${_tz}). `;
      const SYS_BASE = SYS_NOW +
        // The screen matters to the assistant only as a shape (short, wide, touch-first),
        // never as a brand: naming one display here made the AI answer "I run on a CORSAIR
        // Xeneon Edge" to a user on a Mac with a spare monitor, or on a phone.
        'You are Xenon, a capable, helpful AI assistant embedded in Xenon. A real-time dashboard the user runs on whatever screen they can spare: a second monitor, a touchscreen, a paired phone or tablet, or a small wide panel next to their main display.' +
        ' Answer ANY question the user asks, drawing on your broad general knowledge (technology, science, history, everyday topics, etc.).' +
        ' For anything recent, live, or that you are not certain about (news, prices, sports results, weather elsewhere, release dates, "what is X today"…), call web_search instead of guessing, then answer using the results.' +
        ' YOU CAN DIRECTLY CONTROL THE WHOLE DASHBOARD: this is a core part of your job, not an afterthought. Whenever the user asks for something a tool covers, DO IT with the tool instead of only describing it. Your controls, by area:' +
        '  • Audio & mic: mute/unmute the mic, set mic volume, set speaker volume, mute the speaker, turn a single app up/down or mute it (per-app mixer), and switch the default speaker/output or microphone/input device by name (list them first if unsure).' +
        '  • Media: play/pause, next, previous track, and choose which app the Now Playing tile follows (media source).' +
        '  • Productivity: read/replace notes; list/create/complete/delete tasks (and clear all); list/create/delete calendar events (and clear all); start/list/delete countdown timers.' +
        '  • RGB lighting: set a manual colour, clear it, enable/disable reactive effects, configure event-flash effects, and turn the whole lighting bridge on/off.' +
        '  • System & apps: read live CPU/GPU/RAM/disk stats and individual sensors (e.g. CPU temp), open or close any app/website/file on Windows, lock the PC, and turn Performance Mode on/off.' +
        '  • Appearance: change the theme/skin by name OR set exact semantic hex colours for the app canvas, panels, nested surfaces, controls, primary/muted text, borders, accent foreground and success/warning/error/info states via customize_appearance; Light/Dark/Auto seed a coherent palette and unsafe contrast is repaired by default. One tile on its own: style_tile sets its material (Liquid Glass, clear, frosted, solid, no panel, or back to the theme) and the colour of its glass, on any skin.' +
        '  • Preferences: set the 12h/24h clock, temperature unit, interface language, weather location (auto or a manual city), and which widgets show on the focus lock screen, via configure_preferences.' +
        '  • Dashboard UI: navigate between dashboard pages, switch the Deck to one of its profiles, and open the weather / settings / app-switcher panels or the focus lock screen.' +
        '  • Screen vision: capture and analyse any monitor.' +
        '  • Creator & marketplace: search the community catalog and start installs (the user always confirms in the review dialog), CREATE brand-new custom widgets by writing their code (ground with sdk_reference, then create_widget), and build or extend full Deck profiles (ground with deck_action_catalog, then configure_deck). You can also create ANY other Xenon creation as a share code that opens in the import window for the user to review: a theme (also with light and dark palettes), an animated background, a page, a bigger Deck profile with folders, the top bar, an icon pack, an Ambient scene or a whole package (ground with preset_reference, then create_preset). Sound packs cannot be generated: they are audio files.' +
        ' APP KNOWLEDGE: you have built-in documentation about Xenon itself. BEFORE answering any question about how Xenon works: setup, requirements, why something reads empty (e.g. fans/watts and admin rights), updates, the marketplace, supporter codes, publishing content, integrations setup, privacy, troubleshooting: call xenon_knowledge with the question and ground your answer on the returned card instead of guessing; if the card does not cover it, say plainly what you are unsure about.' +
        ' Feature-gated extras appear as extra tools ONLY when the matching integration is connected or the user enabled them: full Spotify playback control incl. playing/queueing any song by name (spotify_control), smart-home control via Home Assistant incl. detailed brightness/colour/temperature/fan/cover control (home_assistant), Discord voice control incl. join-by-name/mute/deafen/volume (discord_voice), composing/editing dashboard pages (Genesis: pages, tabbed tiles, widget duplication, Deck setup), controlling OBS/Twitch/YouTube/Streamer.bot (Streaming), reading long-term hardware-health history (Guardian), and running arbitrary confirmed Windows commands (PC Control: run_pc_command). When such a tool is present, prefer it over a generic answer. When the user asks for something you genuinely have no tool for: if PC Control is enabled and the task is doable via a Windows command, propose one with run_pc_command; otherwise say plainly you cannot do it rather than pretending you did.' +
        ' WHEN ASKED WHAT YOU CAN DO, OR whether you can do/control a specific thing ("puoi controllare il mio PC?", "sai gestire l\'audio?", "can you also…?"): NEVER give a vague blurb and NEVER give a NARROW answer that mentions only one slice (e.g. only "monitoring") while omitting the rest: that is underselling and it reads as dishonest. Lead with the truth that you do not just READ/monitor the PC, you actively CONTROL it, then name the real breadth from the control surface above: open & close apps, control audio/mic (incl. per-app mixer and switching the output/mic device), media & media source, RGB lighting, any Deck action (Wave Link, Voicemeeter, OBS, Streamer.bot, smart home), lock the PC, live CPU/GPU/RAM/disk stats and sensors, Performance Mode, appearance incl. exact hex colours and light/dark, preferences (clock, unit, language, weather, lock-screen widgets), notes/tasks/calendar/timers, pages/Deck profiles/panels, screen vision, searching & installing community marketplace content, and CREATING new custom widgets and Deck profiles from scratch, plus any enabled extras (Genesis page-building, Streaming control, Guardian health history, and, when PC Control is on, running arbitrary confirmed Windows commands, which is real, deep control of the machine). In a VOICE turn answer in ONE or TWO short spoken sentences that name several of these areas in flowing prose (NO bulleted list, no "*", no line breaks) and offer to detail any (e.g. "Sì, non solo lo monitoro: apro e chiudo app, gestisco audio media e luci, blocco il PC, cambio tema e impostazioni, e con il Controllo PC attivo eseguo comandi Windows. Vuoi che ti mostri qualcosa?"). Only in a TEXT turn give a short organised list. Ground it in the tools you actually have this turn: do not invent capabilities.' +
        ' SCREEN VISION SAFETY: call capture_screen ONLY when the latest user message explicitly asks you to inspect/read/look at the screen, monitor, screenshot, image, window, or visible UI. Do not ask which monitor unless the user actually requested screen vision. For weather, temperature, clothing, outfit, or "what should I wear" questions, use get_weather and answer directly; never route those to capture_screen, even if speech-to-text produced a short/garbled phrase such as "che vesti".' +

        // ── Conversational data collection ──────────────────────────────────
        ' CONVERSATIONAL BEHAVIOUR: follow these rules every time:' +
        ' (1) COLLECT BEFORE ACTING: when the user asks you to do something but has not provided the information you need to call the function, ask for it conversationally, one concise question at a time, and wait for the answer. Do NOT call the function with invented, empty, or guessed required fields.' +
        '     Examples: "aggiungimi un task" → ask what the task is; "metti un timer" → ask for how long; "crea un evento" → ask title then date/time; "scrivi nelle note" → ask what to write; "cambia tema" → ask which (xenon/ocean/ember/violet/mono).' +
        ' (2) IDENTIFY BEFORE DELETE/COMPLETE: when the user says "elimina il task", "segna come fatto il timer", etc. without specifying which one, call list_tasks/list_timers/list_calendar_events first and then ask the user to confirm which item.' +
        ' (3) CONFIRM DESTRUCTIVE ACTIONS: before running clear_all_tasks, clear_all_calendar_events, write_notes (overwrite), edit_note delete, delete_calendar_event, or any bulk delete, briefly state what you are about to do ("Sto per cancellare tutti i task, procedo?") and wait for confirmation. Exception: if the user\'s message already makes the intent unambiguous and explicit ("sì cancella tutto", "svuota tutto"), proceed directly.' +
        ' (4) COLLECT KEY OPTIONAL FIELDS TOO: after required fields, also ask for these specific optional ones before calling the function:' +
        '   • create_task → after the task text, ask for priority (alta / media / bassa).' +
        '   • start_timer → after the duration, ask for a label (e.g. "Come lo chiamo?": skip if user seems in a hurry or already answered).' +
        '   • create_calendar_event → collect in this exact order before calling the function: (a) title if missing, (b) date if missing, (c) time if missing, ask as one short question e.g. "A che ora?": do NOT skip this, do NOT default to 00:00, (d) then ask once about a reminder ("Vuoi un promemoria? Se sì, quando?"). Call create_calendar_event EXACTLY ONCE with all collected fields: never call it before the reminder question, never call it twice.' +
        '   For all other optional fields (recurrence, notes on events, etc.) use sensible defaults and do NOT ask unless the user explicitly mentions them.' +
        '   Exception: if the request already contains everything ("crea evento riunione domani alle 15"), call immediately, no further questions.' +
        ' (5) VOLUME WITHOUT A NUMBER: if the user says "alza", "abbassa", "aumenta", "diminuisci" volume/microfono without a number, infer a reasonable delta (±20 from the current value or a sensible target like 80 for "alza" and 40 for "abbassa") and act without asking.' +
        ' (6) ACT ONLY ON THE CURRENT REQUEST: earlier turns in this conversation may show actions you already completed (e.g. a task you added). NEVER repeat or re-execute a past action unless the user explicitly asks again in their latest message. Each new user message is a fresh request: respond to THAT, do not carry over or replay a previous command.' +
        ' (7) ASK WHEN GENUINELY UNSURE: you are a real assistant, not a guesser. When a request is ambiguous, could reasonably mean different things, or would produce a big/irreversible change from an unclear instruction, ask ONE short clarifying question before acting instead of guessing. But do NOT over-ask: when the intent is clear or a sensible default obviously fits, just do it. Balance: one good question beats a wrong action, and one confident action beats a needless question.' +

        // ── Other rules ─────────────────────────────────────────────────────
        aiTurnRecord.SYSTEM_NOTE +
        aiDeckRun.TOOL_TEXT_NOTE +
        ' TOOL CALLS: invoke functions ONLY through the native function-calling mechanism. NEVER write a tool call as plain text (e.g. "[call:...]", "default_api.…", code blocks): anything you write as text is shown and spoken to the user verbatim.' +
        ' Always reply in the same language as the user.' +
        ' IMPORTANT. Speech-to-text artefacts: the STT engine may occasionally merge consecutive words when the user mixes Italian with English proper nouns. If you receive something like "apristim", "aprispot", "apridiscord", or similar phonetic mashups, interpret them as the most likely Italian command plus the English app name (e.g. "apristim" → open Steam, "aprispot" → open Spotify). Always prefer a command interpretation over treating the input as gibberish.' +
        _deckProfilesText +
        _streamingText +
        _integrationsText +
        _genesisText +
        _guardianText +
        _memoryText +
        _summaryText +
        _pcControlText;
      // Voice turns are spoken aloud, so keep them short and conversational: this
      // also makes both the reply generation and the text-to-speech noticeably faster.
      const SYS_VOICE = ' This is a VOICE conversation: your reply will be spoken aloud. Keep it SHORT and natural, like a spoken answer: 1-2 sentences, no markdown, no lists, no headings. Get straight to the point as if talking to a person.' +
        ' When you need to ask the user a clarifying question (data collection), ask only ONE question per turn and keep it to a single short spoken sentence: the microphone will reopen automatically after your reply so the user can answer immediately.' +
        ' If the user only says a dismissal ("stop", "basta", "ferma", "esci", "lascia stare", "grazie" with nothing else), reply with a single short word like "Ok" and call close_ai_panel.';
      const SYS_AUDIO = ' The user\'s request is provided as an audio clip: transcribe it yourself and act on it. Ignore any bracketed placeholder like "[richiesta vocale]": it is just an internal label, not something the user said. If a short text snippet also accompanies the audio, it is the BEGINNING of the same spoken sentence (captured a moment earlier) and the audio continues it: treat them as one continuous request and combine them.';
      // [[answer]] lines become one-tap rows in the chat (js/ai-reply-choices.js): the
      // answers to Bit's own question, or up to 2 next steps after it did something.
      const SYS_TEXT = ' Be concise but complete; replies may be read aloud. Say what things do in plain words: never show internal names (action types, fields, values in code).' +
        ' When the request can really go different ways and a wrong guess would waste the work (it points at something you cannot see, it needs a fact only the user has, or it can mean two very different things), do not guess: ask one question and offer 2 to 4 real alternatives, the one you would pick first, each alone on its own last line as [[answer | what it means]], at most 12 words after the bar. Use the bar only for real alternatives, never for a yes or no and never to confirm an action. Never ask what you can decide yourself (colours, layout, names). If the user tells you to decide, pick and go on without asking again.' +
        ' When you ask the user something (rule 7, data collection, or a question about any topic that needs more detail) and the answer is one of a few likely options, end your reply with 2 to 4 short answers, each alone on its own last line as [[answer]] (e.g. [[Sì]] and [[No]] on two lines), in the user\'s language, at most 6 words each. They show as buttons the user taps to reply; the user can still type anything else. Only add them to a real question, never to a statement, and do not ask just to offer buttons: ask only when the answer changes what you do.' +
        ' After you actually DID something for the user (changed the dashboard, a setting, a page, or made a widget), you may instead end with at most 2 concrete next steps they are likely to want, in the same [[...]] format, phrased as what the user would say (e.g. [[Rendilo più grande]] [[Mettilo nella pagina Giochi]]). Never generic ones (no [[Altro?]] or [[Serve altro?]]), never after a plain answer, a fact or small talk.';
      // Strong language lock — placed LAST so it overrides any tendency to drift to
      // English (which happens most when the turn carries an image or audio).
      const SYS_LANG = langName
        ? ` CRITICAL: the user's language is ${langName}. You MUST always reply in ${langName}, including when you describe a screenshot, an image, or anything you "see", unless the user's latest message is clearly in a different language, whether they typed it OR spoke it (match the language they actually used this turn). Never switch to English on your own.`
        : '';
      // Opt-in "advanced reasoning" (Settings → Funzioni AI): route TEXT turns to
      // the stronger model. Voice / audio turns stay on the fast model — latency
      // matters when the reply is spoken aloud. `chatModel` is a `let` so the
      // fallback below can drop back to the fast model if the pro model is
      // unavailable (e.g. not enabled on the user's key), mid-conversation.
      const _reasonSettings = (await readHubSettings().catch(() => null)) || {};
      let chatModel = (_reasonSettings.aiProReasoning === true && !isVoice && !hasAudio)
        ? AI_MODELS.chatPro : AI_MODELS.chat;
      const callGemini = (msgs) => withThinking(chatModel, (thinking) => callGeminiOnce(msgs, thinking));
      const callGeminiOnce = (msgs, thinking) => new Promise((resolve, reject) => {
        const payload = JSON.stringify({
          system_instruction: { parts: [{ text: SYS_BASE + ((isVoice || hasAudio) ? SYS_VOICE : SYS_TEXT) + (hasAudio ? SYS_AUDIO : '') + SYS_LANG }] },
          tools: [{ functionDeclarations: AI_TOOLS }],
          contents: msgs,
          generationConfig: applyThinking({ temperature: 0.7, maxOutputTokens: 1024, candidateCount: 1 }, thinking),
        });
        const aiReq = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/${chatModel}:generateContent?key=${encodeURIComponent(apiKey)}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
        }, (aiRes) => {
          let data = '';
          aiRes.on('data', chunk => { data += chunk; });
          aiRes.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
              else resolve(parsed);
            } catch (parseErr) { reject(parseErr); }
          });
        });
        aiReq.on('error', reject);
        aiReq.setTimeout(30000, () => { aiReq.destroy(); reject(new Error('Gemini request timed out (' + chatModel + ')')); });
        aiReq.write(payload);
        aiReq.end();
      });

      const _AI_FN_NAMES = new Set(AI_FUNCTIONS.map(f => f.name));
      const getCandidate = (r) => {
        let content = r.candidates && r.candidates[0] && r.candidates[0].content;
        const parts = (content && content.parts) || [];
        // Gemini 3 can prepend "thought" parts even with thinking disabled; the
        // functionCall / real answer may sit in any later part. Reading only
        // parts[0] used to skip tool calls and leak thought text to the chat.
        let part = parts.find(p => p.functionCall) || parts.find(p => p.text && !p.thought) || parts[0];
        // Fallback: the model sometimes writes the tool call as plain text
        // ("[call:default_api:fn{…}]"). Recover it as a real functionCall and
        // rewrite the history turn so the functionResponse stays well-formed.
        if (part && !part.functionCall) {
          const visText = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
          const leaked = _parseLeakedToolCall(visText, _AI_FN_NAMES);
          if (leaked) {
            part = { functionCall: { name: leaked.name, args: leaked.args } };
            content = { role: 'model', parts: [part] };
          }
        }
        return { content, part };
      };

      // currentMessages already built above (with optional imageParts injected)
      const clientActions = [];
      const turnRecord = aiTurnRecord.create();  // the tools this reply ran, kept in its history message

      if (provider === 'ollama') {
        await chatWithOllama({
          AI_TOOLS, SYS_BASE, SYS_LANG, SYS_TEXT, SYS_VOICE, _aiPictures, _aiSurface, _latestExplicitlyWantsScreen,
          _latestLooksLikeClothingWeather, _latestUserText, _uiLang2, aiBody, apiKey, currentMessages, hasAudio,
          isRemote, isVoice, json, langName, ollModel, res, toolKit, turnRecord, aiLocal, aiStoppedReply,
          executeAiTool, readHubSettings,
        });
        return;
      }

      if (provider === 'localapi') {
        await chatWithLocalServer({
          AI_TOOLS, SYS_BASE, SYS_LANG, SYS_TEXT, SYS_VOICE, _aiPictures, _aiSurface, _latestExplicitlyWantsScreen,
          _latestLooksLikeClothingWeather, _latestUserText, _uiLang2, apiKey, currentMessages, hasAudio, isRemote,
          isVoice, json, langName, provider, res, toolKit, turnRecord, aiLocalServer, aiStoppedReply, aiTurns,
          executeAiTool, readHubSettings,
        });
        return;
      }

      if (aiCli.isCliProvider(provider)) {
        await chatWithCli({
          AI_FUNCTIONS, SYS_BASE, SYS_LANG, SYS_TEXT, SYS_VOICE, _aiPictures, _aiSurface, _latestExplicitlyWantsScreen,
          _latestLooksLikeClothingWeather, _latestUserText, _uiLang2, apiKey, currentMessages, hasAudio, isRemote,
          isVoice, json, langName, provider, res, turnRecord, aiCli, aiStoppedReply, aiTurns, executeAiTool,
          readHubSettings,
        });
        return;
      }

      if (provider === 'xenon') {
        await chatWithXenon({
          AI_TOOLS, SYS_BASE, SYS_LANG, SYS_NOW, SYS_TEXT, SYS_VOICE, _aiPictures, _aiSurface,
          _latestExplicitlyWantsScreen, _latestLooksLikeClothingWeather, _latestUserText, _uiLang2, apiKey,
          currentMessages, hasAudio, isRemote, isVoice, json, langName, provider, res, toolKit, turnRecord, DATA_DIR,
          aiStoppedReply, aiXenon, executeAiTool, hub, readHubSettings,
        });
        return;
      }

      if (provider === 'openai' || provider === 'anthropic') {
        await chatWithCloudKey({
          AI_TOOLS, SYS_BASE, SYS_LANG, SYS_TEXT, SYS_VOICE, _aiPictures, _aiSurface, _latestExplicitlyWantsScreen,
          _latestLooksLikeClothingWeather, _latestUserText, _uiLang2, apiKey, currentMessages, hasAudio, isRemote,
          isVoice, json, langName, provider, res, toolKit, turnRecord, aiAnthropic, aiOpenai, aiStoppedReply,
          executeAiTool, providerModelFor, readHubSettings,
        });
        return;
      }

      // Pro model unavailable / errored → transparently fall back to the fast
      // model (for this call AND the rest of the tool loop) so the user is never
      // stranded by an opt-in setting — including when the failure happens on a
      // later loop iteration, AFTER a tool call already mutated state.
      //
      // A model the API says it does not have is also DROPPED from the cached
      // list, so the next turn resolves to the runner-up instead of re-sending a
      // dead id forever. That is the difference between a fallback and a repair:
      // `gemini-3.5-pro` had been retired and every advanced-reasoning turn paid
      // a failed request before falling back, with nothing saying so.
      const isBusyModel = (err) => /timed out|high demand|overloaded|UNAVAILABLE|503/i.test(String((err && err.message) || ''));
      const callGeminiWithFallback = async (msgs) => {
        try {
          return await callGemini(msgs);
        } catch (err) {
          if (aiGemini.isMissingModel(err)) aiModels.markMissing('gemini', chatModel);
          const fast = AI_MODELS.chat;
          if (chatModel !== fast) { chatModel = fast; return await callGemini(msgs); }
          // The fast model is a pin Google has since retired ("no longer available to
          // new users"), or it timed out / is overloaded: markMissing() cannot repair
          // a pin, so try what `auto` picks, then its lighter sibling, then the real error.
          const canMoveOn = (e) => aiGemini.isMissingModel(e) || isBusyModel(e);
          if (!canMoveOn(err)) throw err;
          const others = [aiModels.resolve('gemini', 'chat', 'auto', apiKey), aiModels.resolve('gemini', 'chat', 'auto:flash-lite', apiKey)]
            .filter(id => id !== chatModel);
          return await aiGemini.tryOtherModels(others, (id) => { chatModel = id; return callGemini(msgs); }, err, canMoveOn);
        }
      };

      let geminiResult = await callGeminiWithFallback(currentMessages);
      let { content, part } = getCandidate(geminiResult);

      // Function calling loop. Bounded by BOTH a step cap and a wall-clock budget
      // so multi-step requests (e.g. Genesis composing a page AND setting up the
      // Deck, or a chain of dashboard actions) can complete instead of being cut
      // off at 3 steps — while a runaway or slow model can never hang the turn.
      const AI_MAX_TOOL_ITERS = 8;
      const AI_TOOL_TIME_BUDGET_MS = 28000;
      const _loopStart = Date.now();
      let pendingScreenImage = null; // base64 JPEG to feed Gemini after capture_screen
      for (let iter = 0; iter < AI_MAX_TOOL_ITERS && part && part.functionCall; iter++) {
        if (iter > 0 && Date.now() - _loopStart > AI_TOOL_TIME_BUDGET_MS) break;
        const fnName = part.functionCall.name;
        const fnArgs = part.functionCall.args || {};
        currentMessages = [...currentMessages, content];

        const { fnResult, clientActions: fnClientActions, pendingScreenImage: fnScreen } =
          await toolKit.call(fnName, fnArgs, () => executeAiTool(fnName, fnArgs, {
            apiKey,
            uiLang: _uiLang2,
            latestUserText: _latestUserText,
            latestLooksLikeClothingWeather: _latestLooksLikeClothingWeather,
            latestExplicitlyWantsScreen: _latestExplicitlyWantsScreen,
            pictures: _aiPictures,
            surface: _aiSurface,
            remote: isRemote,
          }).then(r => turnRecord.note(fnName, r)));
        for (const a of fnClientActions) clientActions.push(a);
        if (fnScreen) pendingScreenImage = fnScreen;

        currentMessages = [...currentMessages, {
          role: 'user',
          parts: [{ functionResponse: { name: fnName, response: { output: JSON.stringify(fnResult) } } }],
        }];

        // Feed the captured screenshot to Gemini so it can actually see the screen.
        if (pendingScreenImage) {
          currentMessages.push({
            role: 'user',
            parts: [
              { text: 'Here is the current screenshot of the requested monitor.' },
              { inlineData: { mimeType: 'image/jpeg', data: pendingScreenImage } },
            ],
          });
          pendingScreenImage = null;
        }

        geminiResult = await callGeminiWithFallback(currentMessages);
        ({ content, part } = getCandidate(geminiResult));
      }

      const text = ((content && content.parts) || [])
        .filter(p => p.text && !p.thought)
        .map(p => p.text).join('')
        // Never show/speak a leaked text tool call (it was either executed via
        // the fallback above or is plain noise).
        .replace(new RegExp(LEAKED_CALL_RE.source, 'g'), '')
        .trim();
      json({ text, clientActions, newContent: turnRecord.message(content), toolGroups: toolKit.groups() });
    } catch (e) {
      if (aiStoppedReply(e, json)) return;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/log' && req.method === 'POST') {
    await engineBranches['POST /api/log'](req, res, { json, err500, reqPath, urlObj, isRemote });

  } else if (req.method === 'DELETE' && reqPath.startsWith('/font/')) {
    await lookBranches['DELETE /font/*'](req, res, { json, err500, reqPath, urlObj, isRemote });

  } else if (req.method === 'GET' && reqPath.startsWith('/icon-pack/')) {
    await storeCatalogPacksBranches['GET /icon-pack/*'](req, res, { json, err500, reqPath, urlObj, isRemote }, { iconPackStore });

  } else if (req.method === 'DELETE' && reqPath.startsWith('/icon-pack/')) {
    await storeCatalogPacksBranches['DELETE /icon-pack/*'](req, res, { json, err500, reqPath, urlObj, isRemote }, { iconPackStore });

  } else if (req.method === 'DELETE' && reqPath.startsWith('/sound-pack/')) {
    await storeCatalogPacksBranches['DELETE /sound-pack/*'](req, res, { json, err500, reqPath, urlObj, isRemote }, { soundPackStore });

  } else if (reqPath === '/disk/status' && req.method === 'GET') {
    await diskBranches['GET /disk/status'](req, res, { json, err500, reqPath, urlObj, isRemote }, { diskSpace });

  } else if (reqPath === '/disk/overview' && req.method === 'GET') {
    await diskBranches['GET /disk/overview'](req, res, { json, err500, reqPath, urlObj, isRemote }, { diskSpace });

  } else if (reqPath === '/disk/reveal' && req.method === 'POST') {
    await diskBranches['POST /disk/reveal'](req, res, { json, err500, reqPath, urlObj, isRemote }, { diskSpace });

  } else if (reqPath === '/disk/browse' && req.method === 'GET') {
    await diskBranches['GET /disk/browse'](req, res, { json, err500, reqPath, urlObj, isRemote }, { diskSpace });

  } else if (reqPath === '/api/disk/advisor' && req.method === 'POST') {
    await diskBranches['POST /api/disk/advisor'](req, res, { json, err500, reqPath, urlObj, isRemote }, { _geminiOneShot, cliOneShot, diskSpace, fileSearch, getInstalledApps, readHubSettings });

  } else if (reqPath === '/disk/scan' && req.method === 'POST') {
    await diskBranches['POST /disk/scan'](req, res, { json, err500, reqPath, urlObj, isRemote }, { diskSpace });

  } else if (reqPath === '/disk/scan/cancel' && req.method === 'POST') {
    await diskBranches['POST /disk/scan/cancel'](req, res, { json, err500, reqPath, urlObj, isRemote }, { diskSpace });

  } else if (reqPath === '/disk/clean' && req.method === 'POST') {
    await diskBranches['POST /disk/clean'](req, res, { json, err500, reqPath, urlObj, isRemote }, { diskSpace });

  } else if (reqPath === '/disk/clean/cancel' && req.method === 'POST') {
    await diskBranches['POST /disk/clean/cancel'](req, res, { json, err500, reqPath, urlObj, isRemote }, { diskSpace });

  } else if (reqPath.startsWith('/api/devclean/') && !(await featureUnlock.isUnlocked('devclean'))) {
    // The gate lives here, not only in the tile: every Dev cleanup route
    // refuses until the feature is unlocked.
    res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'locked' }));

  } else if (reqPath === '/api/devclean/overview' && req.method === 'GET') {
    await diskBranches['GET /api/devclean/overview'](req, res, { json, err500, reqPath, urlObj, isRemote }, { devClean });

  } else if (reqPath === '/api/devclean/run' && req.method === 'POST') {
    await diskBranches['POST /api/devclean/run'](req, res, { json, err500, reqPath, urlObj, isRemote }, { devClean });

  } else if (reqPath === '/api/devclean/compact' && req.method === 'POST') {
    await diskBranches['POST /api/devclean/compact'](req, res, { json, err500, reqPath, urlObj, isRemote }, { devClean });

  } else if (req.method === 'GET' && reqPath.startsWith('/uploads/')) {
    await lookBranches['GET /uploads/*'](req, res, { json, err500, reqPath, urlObj, isRemote });

  } else if (req.method === 'GET' && /^\/(styles|components|js|vendor|public|shared|assets)(\/|$)/.test(reqPath)) {
    // Static asset handler for refactored CSS/JS files, vendored libs (GridStack),
    // bundled images under public/, and the shared @xenon/core modules exposed via
    // the server/shared junction. Normalise to an absolute path and reject any
    // traversal outside __dirname (the junction target is our own packages/core,
    // and path.normalize is purely lexical so the guard still holds).
    const rel = reqPath.replace(/^\//, '');
    const abs = path.normalize(path.join(__dirname, rel));
    if (!abs.startsWith(path.join(__dirname, path.sep)) && abs !== __dirname) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const ext = path.extname(abs).toLowerCase();
    const STATIC_MIME = {
      '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif',
      // The self-hosted UI face (styles/fonts.css). Served as
      // application/octet-stream a browser still renders it, but it logs a MIME
      // complaint and any future font-src CSP would have nothing to allow.
      '.woff2': 'font/woff2', '.woff': 'font/woff',
      '.mp4': 'video/mp4',
    };
    const mime = STATIC_MIME[ext] || 'application/octet-stream';
    if (ext === '.mp4') {
      // A <video> asks for byte ranges: WebKit will not play a file served whole.
      fs.promises.stat(abs)
        .then(stat => serveFileRange(req, res, abs, stat, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' }))
        .catch(e => { if (e.code === 'ENOENT') { res.writeHead(404); res.end(); } else err500(e.message); });
    } else if (ext === '.css' || ext === '.js') {
      // CSS/JS: a URL with the version of the file as it is now stays in the cache
      // (asset-version.js). Any other revalidates on every load but skips the
      // transfer when the file is unchanged: the ETag comes from size+mtime, so a
      // local edit produces a new tag and shows on refresh.
      fs.promises.stat(abs).then(stat => {
        const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
        const cacheControl = assetVersion.cacheControl(urlObj.searchParams.get('v'), stat, APP_VERSION);
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { 'Cache-Control': cacheControl, 'ETag': etag }); res.end(); return;
        }
        return fs.promises.readFile(abs).then(data => {
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cacheControl, 'ETag': etag });
          res.end(data);
        });
      }).catch(e => { if (e.code === 'ENOENT') { res.writeHead(404); res.end(); } else err500(e.message); });
    } else {
      // Images/static assets: cache for a day (effectively immutable filenames).
      fs.promises.readFile(abs)
        .then(data => { res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' }); res.end(data); })
        .catch(e => { if (e.code === 'ENOENT') { res.writeHead(404); res.end(); } else err500(e.message); });
    }

  // ── Twitch live integration (OAuth device flow) ──────────────────────────
  // Responses never include tokens — only { connected, login, configured } or the
  // device-flow code/URL the user authorises on their phone.
  } else if (reqPath.startsWith('/api/mcp/dev/')) {
    await mcpDevBranches['* /api/mcp/dev/*'](req, res, { json, err500, reqPath, urlObj, isRemote }, { handleMcpDevRoute });

  } else if (req.method === 'GET' && (reqPath.startsWith('/sdk/tile/') || reqPath.startsWith('/sdk/asset/'))) {
    await widgetSdkImagesBranches['GET /sdk/tile/*|/sdk/asset/*'](req, res, { json, err500, reqPath, urlObj, isRemote }, { sdkAssets, sdkPackagesCached });

  } else if (req.method === 'POST' && reqPath.startsWith('/sdk/hook/')) {
    await widgetSdkCallsBranches['POST /sdk/hook/*'](req, res, { json, err500, reqPath, urlObj, isRemote }, { sdkPackagesCached });

  } else if (req.method === 'GET' && reqPath.startsWith('/sdk/export/')) {
    await widgetSdkPackagesBranches['GET /sdk/export/*'](req, res, { json, err500, reqPath, urlObj, isRemote }, { widgetExportable });

  } else if (req.method === 'GET' && reqPath.startsWith('/sdk/check/')) {
    await widgetSdkPackagesBranches['GET /sdk/check/*'](req, res, { json, err500, reqPath, urlObj, isRemote });

  } else if (req.method === 'DELETE' && reqPath.startsWith('/sdk/widget/')) {
    await widgetSdkPackagesBranches['DELETE /sdk/widget/*'](req, res, { json, err500, reqPath, urlObj, isRemote }, { recordWidgetOrigin, refreshSdkScan, trialVault, updateLayersSetting });

  } else if (req.method === 'GET' && (reqPath.startsWith('/sdk/widget/') || reqPath.startsWith(remoteAccessLib.WIDGET_ASSET_PREFIX))) {
    // Sandboxed widget assets. resolveAsset() is the trust boundary (package id
    // + per-segment validation + extension allowlist + prefix check), and EVERY
    // response carries WIDGET_CSP: `sandbox allow-scripts` keeps the document
    // sandboxed even when navigated to directly, and `connect-src 'none'`
    // blocks all network from widget code — a sandboxed iframe fetches with
    // Origin:null, which isAllowedRequest() accepts for the iCUE WebView, so
    // this CSP is the layer that keeps widget code away from the local API.
    //
    // Two spellings, ONE body below. `/sdk/wk/<key>/<pkg>/<file>` is the same
    // tree addressed with the paired device's asset capability in the path,
    // which exists because a sandboxed document's opaque origin withholds the
    // cookie from exactly these requests (remote-access.js says why, with the
    // measurement). The key was already resolved by _remoteGate — a request
    // reaching here has passed the same door as every other remote request — so
    // all that is left is to look past it at the package and the file. Serving
    // the two from one place is the point: a divergence would mean a widget
    // behaves differently depending on which screen it is on.
    const keyed = remoteAccessLib.parseWidgetAssetPath(reqPath);
    // The CSP for THIS response, with scripts limited to this widget's folder
    // and the serving origin named beside 'self' for the rest. A sandboxed
    // document's origin is opaque, and on a WebKit engine
    // 'self' then matches nothing — which blocked every widget's own stylesheet
    // and script on iPhone and iPad while Chromium was fine. The Host has
    // already passed the loopback allowlist or the paired-device gate before it
    // gets here, and widgetCspFor validates it again before writing it into a
    // header. Secure is read from the socket, never from a header.
    const widgetCsp = sdkWidgets.widgetCspFor(req.headers.host, !!(req.socket && req.socket.encrypted), sdkWidgets.widgetAssetRoot(reqPath));
    const assetPath = keyed ? '/sdk/widget/' + keyed.rest : reqPath;
    const m = /^\/sdk\/widget\/([^/]+)\/(.+)$/.exec(assetPath);
    // Reserved host scripts: served from server memory, BEFORE resolveAsset (which
    // refuses the names so a package file can never shadow them from disk). Same
    // headers as every widget asset — they run under the identical sandbox.
    let probePath = null;
    try { probePath = m ? decodeURIComponent(m[2]) : null; } catch { probePath = null; }
    // A trial package is served from the vault's memory, and only while the
    // trial runs; an installed copy of the same id is served from disk instead.
    const reservedAsset = sdkWidgets.isReservedAsset(probePath);
    const trialPkg = m && !reservedAsset
      && (await sdkPackagesCached()).packages.some((p) => p.id === m[1] && p.trial === true);
    const trialFile = trialPkg ? await trialVault.asset(m[1], m[2]) : null;
    const abs = (m && !trialPkg && !reservedAsset)
      ? sdkWidgets.resolveAsset(SDK_WIDGETS_DIR, m[1], m[2]) : null;
    if (trialFile) {
      res.writeHead(200, {
        'Content-Type': trialFile.mime,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': sdkWidgets.assetCsp(widgetCsp, trialFile.mime),
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(trialFile.mime.startsWith('text/html')
        ? sdkWidgets.prepareWidgetHtml(trialFile.bytes.toString('utf8'), sdkWidgets.widgetAssetRoot(reqPath)) : trialFile.bytes);
    } else if (m && reservedAsset) {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': widgetCsp,
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(probePath === sdkWidgets.FRAME_GUARD_FILENAME ? sdkWidgets.FRAME_GUARD_SOURCE : sdkWidgets.PERF_PROBE_SOURCE);
    } else if (!abs) { res.writeHead(404); res.end(); }
    else {
      try {
        const data = await fs.promises.readFile(abs);
        const mime = sdkWidgets.mimeFor(abs);
        // Widget HTML gets the host scripts injected at serve time; every other
        // asset streams verbatim.
        const payload = mime.startsWith('text/html')
          ? sdkWidgets.prepareWidgetHtml(data.toString('utf8'), sdkWidgets.widgetAssetRoot(reqPath))
          : data;
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': sdkWidgets.assetCsp(widgetCsp, mime),
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(payload);
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'EISDIR') { res.writeHead(404); res.end(); }
        else err500(e.message);
      }
    }

  } else if (reqPath === '/sse' && req.method === 'GET') {
    await engineBranches['GET /sse'](req, res, { json, err500, reqPath, urlObj, isRemote, remote }, { openSseClient });
  } else {
    res.writeHead(404); res.end();
  }
};

const { trackSockets } = require('./listener-sockets.js');
// A route that throws past its own try still gets an answer (http/request-boundary.js).
const server = http.createServer((req, res) => runGuarded(handleRequest, req, res));
const listenerSockets = trackSockets(server);

// ── Embedded-browser relay WebSocket ──────────────────────────────────────────
// The Browser widget streams CDP screencast frames over this loopback-only socket
// and sends pointer/keyboard input back. Each client owns its tiles and they are
// closed when it disconnects (which lets the headless Edge idle-shut-down).
const { WebSocketServer } = require('ws');
const sseSocket = require('./sse-socket');
const embeddedWss = new WebSocketServer({ noServer: true });
const liveWss = new WebSocketServer({ noServer: true });
// The feed only speaks: a window has nothing to send, so nothing big is accepted.
const feedWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 });
const { embeddedConn } = require('./windows-tiles/embedded-conn-state.js');

const { _packWsFrame } = require('./windows-tiles/ws-frame.js');

const { _startLivePcmCapture } = require('./ai/live-pcm-capture.js');

const { _teardownLiveSession } = require('./ai/live-session-end.js');

const { _buildLiveSystemInstruction } = require('./ai/live-system-instruction.js');

const { _handleSecondScreenClient } = require('./screens/second-screen-client.js');

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { pathname = ''; }
  const WS_PATHS = ['/embedded-browser/ws', '/second-screen/ws', '/api/ai/live', '/sse/socket'];
  if (!WS_PATHS.includes(pathname)) { socket.destroy(); return; }
  // Same loopback/Host/Origin guard as every HTTP route — the relay is local-only.
  if (!isAllowedRequest(req)) { socket.destroy(); return; }
  // Only our own pages, same-origin, open these sockets (cross-site.js).
  if (refusedSocketOrigin(req, PORT)) { socket.destroy(); return; }
  if (pathname === '/sse/socket') {
    feedWss.handleUpgrade(req, socket, head, (client) => {
      client.on('error', () => { /* the close that follows drops it */ });
      openSseClient(sseSocket.socketRequest(client), sseSocket.socketResponse(client), false, null);
    });
    return;
  }
  if (pathname === '/api/ai/live') {
    liveWss.handleUpgrade(req, socket, head, (client) => _handleLiveClient(client));
    return;
  }
  if (pathname === '/second-screen/ws') {
    embeddedWss.handleUpgrade(req, socket, head, (client) => _handleSecondScreenClient(client));
    return;
  }
  embeddedWss.handleUpgrade(req, socket, head, (client) => _handleEmbeddedClient(client));
});

// Execute the cross-surface follow plan for a Browser-widget navigation: any idle
// sibling tile still sitting on the page this one just left is re-navigated so it
// picks up the shared session (GitHub #96). Best-effort — a sibling that has gone
// away simply drops out.
function _applyBrowserSync(localId, connId, url, userInitiated) {
  let plan;
  try { plan = browserSync.navigated(localId, connId, url, { at: Date.now(), userInitiated: !!userInitiated }); }
  catch (e) { return; }
  for (const step of plan) embeddedBrowser.navigate(step.tid, step.url).catch(() => {});
}

function _handleEmbeddedClient(client) {
  const connId = 'c' + (++embeddedConn.seq);
  const myTiles = new Set();                 // server-namespaced tile ids owned by this client
  const myLocalIds = new Set();              // logical tile ids open here (for cross-surface sync cleanup)
  const send = (obj) => { try { client.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } };
  let useBinary = false;                     // set by the first 'open' that opts in
  client.on('message', async (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const localId = String(m.tile || '');
    const tid = connId + ':' + localId;        // namespaced so tiles never collide across clients
    try {
      switch (m.type) {
        case 'open': {
          myTiles.add(tid);
          myLocalIds.add(localId);
          browserSync.open(localId, connId, tid);
          if (m.binary === true) useBinary = true;
          const onFrame = (data, meta) => {
            if (!useBinary) { send({ type: 'frame', tile: localId, data, meta }); return; }
            let payload; try { payload = Buffer.from(data, 'base64'); } catch (e) { return; }
            try { client.send(_packWsFrame({ type: 'frame', tile: localId, meta }, payload)); } catch (e) { /* ignore */ }
          };
          // A page-driven navigation (a link click, a login redirect) fans out to
          // idle sibling surfaces still on the same page; user-typed navigations
          // are flagged separately below and don't.
          const onNav = (url) => { send({ type: 'nav', tile: localId, url }); _applyBrowserSync(localId, connId, url, false); };
          const r = await embeddedBrowser.open(tid, m.url, m.w, m.h, m.dpr, onFrame, onNav);
          await embeddedBrowser.startScreencast(tid);
          send({ type: 'opened', tile: localId, url: r.url });
          break;
        }
        case 'navigate': { browserSync.markUserNav(localId, connId, Date.now()); const r = await embeddedBrowser.navigate(tid, m.url); send({ type: 'nav', tile: localId, url: r.url }); break; }
        case 'resize':    await embeddedBrowser.setSize(tid, m.w, m.h, m.dpr); break;
        case 'input':     browserSync.markInput(localId, connId, Date.now()); await embeddedBrowser.input(tid, m.event); break;
        case 'screencast': if (m.on) await embeddedBrowser.startScreencast(tid); else await embeddedBrowser.stopScreencast(tid); break;
        case 'reload':    browserSync.markInput(localId, connId, Date.now()); await embeddedBrowser.reload(tid); break;
        case 'clearData': browserSync.markInput(localId, connId, Date.now()); await embeddedBrowser.clearData(tid); send({ type: 'cleared', tile: localId }); break;
        case 'history':   browserSync.markUserNav(localId, connId, Date.now()); await embeddedBrowser.navHistory(tid, m.dir < 0 ? -1 : 1); break;
        case 'close':     myTiles.delete(tid); myLocalIds.delete(localId); browserSync.close(localId, connId); await embeddedBrowser.closeTile(tid); break;
        default: break;
      }
    } catch (e) {
      send({ type: 'error', tile: localId, error: String((e && e.message) || e) });
    }
  });
  const cleanup = () => {
    for (const tid of myTiles) embeddedBrowser.closeTile(tid).catch(() => {});
    myTiles.clear();
    for (const lid of myLocalIds) browserSync.close(lid, connId);
    myLocalIds.clear();
  };
  client.on('close', cleanup);
  client.on('error', cleanup);
}

function _handleLiveClient(client) {
  const send = (obj) => { try { client.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } };
  let started = false;
  let aborted = false; // a stop/close arrived while 'start' was still mid-await
  let langName = '';
  let uiLang = '';
  let latestUserText = '';
  const endClient = (reason) => { try { send({ type: 'closed', reason }); } catch {} try { client.close(); } catch {} };

  client.on('message', async (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.type === 'start') {
      if (started) return;
      started = true;
      const reject = (code, msg) => { process.stdout.write(`[Live] start rejected: ${code}\n`); send({ type: 'error', code, error: msg }); endClient(code); };
      const settings = (await readHubSettings().catch(() => null)) || {};
      if (aborted) { endClient('aborted'); return; } // client stopped/closed during the settings read
      // NOTE: we deliberately do NOT re-check settings.aiLiveVoice here. The toggle
      // is a client-side UX gate (the browser only opens this socket when it's on);
      // it is not a security boundary (isAllowedRequest already is). Re-checking a
      // freshly-read setting here only created a desync failure mode — client ON but
      // persisted OFF → silently rejected — which is exactly the "starts then stops"
      // bug. Trust the intent: a connected client wants a Live session.
      const apiKey = String(m.key || settings.geminiApiKey || '').trim();
      if (!apiKey) { reject('no_key', 'No Gemini API key'); return; }
      if (liveVoice.active) { reject('busy', 'A live session is already active'); return; }
      // Wait for the capture device to actually be probed (like the STT path)
      // rather than bailing synchronously — on a fresh boot the probe can lag the
      // first click and would otherwise wrongly report "no microphone".
      try {
        await Promise.race([
          _sttDeviceWhenReady(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('device timeout')), 8000)),
        ]);
      } catch (e) { reject('no_mic', 'Microphone not ready'); return; }
      if (aborted) { endClient('aborted'); return; }
      if (!_sttInputArgs()) { reject('no_mic', 'No microphone available'); return; }

      uiLang = String(m.lang || '').toLowerCase().slice(0, 2);
      langName = aiLangName(uiLang);
      const summary = String(m.summary || '').replace(/\s+/g, ' ').trim().slice(0, 2000);

      liveVoice.active = true;
      refreshWakeWordWatch();   // sync(false) — keep the wake word down for the session
      await wakeWord.suspend(); // ensure its capture child has actually exited
      // A stop/close during the suspend await: liveVoice.active is now true (so the
      // teardown restores the wake word/duck), but no session/capture exists yet.
      if (aborted) { _teardownLiveSession('aborted').then(() => endClient('aborted')); return; }
      _duckSpeakerVolume();

      const timer = setTimeout(() => { send({ type: 'timeout' }); _teardownLiveSession('timeout').then(() => endClient('timeout')); }, LIVE_MAX_SESSION_MS);
      liveNow.session = { session: null, capture: null, timer };

      const tools = buildCoreAiFunctions();
      // Match the turn-based handler: expose the memory tools by voice too when
      // memory is on, so "remember this" / "forget that" work in a Live session.
      if (settings.aiMemory !== false) tools.push(...buildMemoryFunctions());
      const linked = await addIntegrationAiFunctions(tools);
      const systemInstruction = _buildLiveSystemInstruction({ langName, summary }) + linked.streamingText + linked.integrationsText;

      const session = aiLive.createLiveSession({
        apiKey,
        model: AI_MODELS.live,
        systemInstruction,
        // Fixed for the whole session, so no use_tools: the core, then whole groups up to the cap.
        tools: AiToolGroups.forLive(tools),
        WebSocketImpl: require('ws').WebSocket,
        onSetupComplete: () => { process.stdout.write('[Live] setup complete: session ready\n'); send({ type: 'ready' }); },
        onAudio: (b64) => send({ type: 'audio', data: b64 }),
        onInputText: (text) => { latestUserText = text; send({ type: 'input', text }); },
        onOutputText: (text) => send({ type: 'output', text }),
        onInterrupted: () => send({ type: 'interrupted' }),
        onToolCall: async (calls) => {
          for (const c of calls) {
            let out = { error: 'failed' };
            const forwarded = [];
            try {
              const r = await executeAiTool(c.name, c.args || {}, {
                apiKey, uiLang, latestUserText,
                latestLooksLikeClothingWeather: false, latestExplicitlyWantsScreen: false, provider: 'gemini',
              });
              out = r.fnResult || { ok: true };
              for (const a of (r.clientActions || [])) forwarded.push(a);
            } catch (e) { out = { error: String((e && e.message) || e) }; }
            for (const a of forwarded) send({ type: 'action', action: a.action, args: a.args });
            if (liveNow.session && liveNow.session.session) liveNow.session.session.sendToolResponse([{ id: c.id, name: c.name, response: { output: JSON.stringify(out) } }]);
          }
        },
        onError: (e) => { const msg = String((e && e.message) || e); process.stdout.write(`[Live] gemini error: ${msg}\n`); send({ type: 'error', error: msg }); _teardownLiveSession('error').then(() => endClient('error')); },
        onClose: (info) => {
          const detail = info ? `code=${info.code} reason=${info.reason || '(none)'}` : '';
          process.stdout.write(`[Live] gemini socket closed ${detail}\n`);
          // Forward the close reason so the client can show why (bad model/key →
          // typically 1007/1008/1011) and fall back to the turn-based path.
          if (liveVoice.active) { send({ type: 'error', code: 'gemini_closed', error: `Gemini Live closed (${detail})` }); _teardownLiveSession('gemini_closed').then(() => endClient('gemini_closed')); }
        },
      });
      liveNow.session.session = session;

      try {
        liveNow.session.capture = _startLivePcmCapture(
          (frame) => { if (session && !session.closed) session.sendAudio(frame); },
          (e) => { send({ type: 'error', code: 'capture', error: String((e && e.message) || e) }); _teardownLiveSession('capture').then(() => endClient('capture')); },
        );
      } catch (e) {
        send({ type: 'error', code: 'capture', error: String((e && e.message) || e) });
        _teardownLiveSession('capture_start').then(() => endClient('capture_start'));
        return;
      }
      process.stdout.write('[Live] session started\n');
      return;
    }

    if (m.type === 'stop') { aborted = true; await _teardownLiveSession('client_stop'); endClient('stopped'); return; }
    if (m.type === 'interrupt') { try { if (liveNow.session && liveNow.session.session) liveNow.session.session.endAudioTurn(); } catch {} return; }
  });

  const onGone = () => { aborted = true; _teardownLiveSession('client_gone'); };
  client.on('close', onGone);
  client.on('error', onGone);
}

const { startupTaskCheck } = require('./install/startup-task-state.js');

const { helperInstall } = require('./audio/helper-install-state.js');

// The host the last listen() attempt used, so an EADDRINUSE retry re-binds the
// same stack (see the error handler below).
let _listenHost = BIND_HOST;
let _bootStarted = false;
let _eaddrinuseRetries = 0;
const { EADDRINUSE_MAX_RETRIES, EADDRINUSE_RETRY_MS } = require('./paired/listen-retry.js');

// A new install starts on Bit, with the trial Sparks waiting for its first
// message (welcome-sparks.js), on the model they can pay for: a widget on the
// default one costs more than the trial holds, and would stop halfway. Only
// here, before the first request: an update keeps the AI its owner chose.
async function seedFreshInstall() {
  if (!FRESH_INSTALL) return;
  await withHubSettingsLock(async () => {
    if (await readHubSettings()) return;
    await writeHubSettings({ ...DEFAULT_HUB_SETTINGS, aiProvider: 'xenon', xenonModel: 'haiku' });
    await welcomeSparks.markPending(DATA_DIR);
    startupLog.write('settings: new install, starting on Bit');
  });
}


function _startListen(host) {
  _listenHost = host;
  server.listen(PORT, host, () => {
    console.log('Widget server running on http://' + host + ':' + PORT);
    // Into the log as well: under the hidden launcher this console goes nowhere,
    // and "did it ever reach listening?" is the question that splits a start
    // that failed from one that started and then died.
    startupLog.write('listening on http://' + host + ':' + PORT);
    // A listener moved by applyBindHost() comes back through here, and so does the
    // IPv6 fallback: everything below belongs to the process, not to the listener.
    if (_bootStarted) return;
    _bootStarted = true;
    // The slow readings start now rather than at the page's first ask: the window is
    // still opening, and this is the wait the dashboard would otherwise show as "--".
    getSystemInfo().catch(() => {});
    // Refresh an outdated native helper left behind by an in-app self-update. Delayed
    // and fire-and-forget so it never competes with boot; runs at most once per version.
    setTimeout(() => { try { ensureHelperUpToDate(); } catch { /* ignore */ } }, 8000);
    setTimeout(() => { try { ensureCaptureEngine(); } catch { /* ignore */ } }, 12000);
    setTimeout(() => { require('./sensor-service/migrate.js').migrateElevatedEngine({ dataDir: DATA_DIR, version: APP_VERSION, script: ENABLE_SENSORS_SCRIPT }).catch(() => {}); }, 15000);
    // After the engine's first look, so what it can do is known. Not there yet = next start.
    setTimeout(() => { capabilityRunner.seedKeys().catch((e) => console.warn('[keys] defaults failed:', e && e.message)); }, 20000);
    // Its first look is two minutes in: the dashboard's own startup comes first.
    autoUpdater.start().catch((e) => console.warn('[auto-update] start failed:', e && e.message));
    widgetAutoUpdater.start().catch((e) => console.warn('[widget-auto-update] start failed:', e && e.message));
    trialVault.init()
      .then(() => trialPass.start())
      .then(() => trialVault.sync())
      .catch((e) => console.warn('[trial-pass] start failed:', e && e.message))
      // After the vault, so a pass-trial package is in the scan it reads.
      .then(() => migrateSdkGrantGroups())
      .catch((e) => console.warn('[sdk] grant group migration failed:', e && e.message));
    setTimeout(tidyLeftoverTasks, LEFTOVER_TASKS_DELAY_MS).unref();
    getAudioInfo().then(info => {
      if (info && info.mic && typeof info.mic.muted === 'boolean') audioCache.muted = info.mic.muted;
      console.log('Speaker cache:', audioCache.speakerId);
      console.log('Mic cache:   ', audioCache.micId);
      console.log('Mic muted:   ', audioCache.muted);
    }).catch(e => console.error('Audio init failed:', e.message));
    setTimeout(_startSttDevice, STT_DEVICE_DELAY_MS).unref();
    // The T2 HTTPS door, when the user asked for it. Deferred and fire-and-forget:
    // it shells out to tailscale and may fetch a certificate, neither of which
    // belongs in front of the dashboard coming up.
    setTimeout(() => { _syncRemoteHttps().catch(() => {}); }, 3000);
    _initTimers().catch(() => {}); // Load persisted timers + start 1-second check loop
    startTasksReopenClock();          // finished repeating tasks come back on time
    startStoreSnapshots();            // a copy a day of settings, Deck, notes, tasks, calendar, timers
    ratingVotes.start();              // tickets for Store entries, real use, Bit's one ask
    // PresentMon (real in-game FPS) is NOT started here: it holds an admin ETW
    // tracing session, so it stays paused until the first dashboard connects and
    // is torn down after the last one leaves (fps-demand.js, from the SSE path).
    try { gameDetect.startGameDetect(); } catch (e) { console.error('Game detect init failed:', e.message); } // Game mode via foreground full-screen detection
    try { guardian.start(); } catch (e) { console.error('Guardian init failed:', e.message); } // Opt-in sensor history (no-op while disabled)
    // Lighting ↔ Home Assistant bridge: the HA lighting provider rides the shared
    // deckHa client via runtime hooks, so its token/URL never enter the lighting
    // config. listLights only touches HA when the integration is configured.
    try {
      lighting.setExternalRuntime('homeassistant', {
        callService: (domain, service, target, data) => deckHa.callService(domain, service, target, data),
        listLights: async () => {
          const s = (await readHubSettings().catch(() => null)) || {};
          const ha = s.homeAssistant || {};
          if (!ha.url || !ha.token) return [];   // HA not configured → nothing to list
          const ents = await deckHa.listEntities().catch(() => []);
          return ents.filter(e => e && e.domain === 'light');
        },
      });
    } catch (e) { console.error('Lighting HA runtime init failed:', e.message); }
    // Lighting ↔ Razer Chroma bridge: the Chroma lighting provider fans the
    // dashboard's ambient/reactive/album colour to every Razer device through the
    // shared deckChroma session. Gated on the chroma.enabled opt-in so a disabled
    // integration never opens a Chroma session from the lighting path.
    try {
      lighting.setExternalRuntime('chroma', {
        applyColor: async (color) => {
          const s = (await readHubSettings().catch(() => null)) || {};
          if (!(s.chroma && s.chroma.enabled === true)) return;   // opt-in gate
          return deckChroma.applyColor(color);
        },
        release: () => deckChroma.release(),
        available: () => { try { return deckChroma.getStatus().available; } catch (e) { return false; } },
      });
    } catch (e) { console.error('Lighting Chroma runtime init failed:', e.message); }
    // Whether the boot read got as far as answering at all, so the catch below
    // can tell "this settings file could not be read" from "something later in
    // this block threw". Those need different sentences: only the first one
    // means the running app is not the user's configuration.
    let settingsBootRead = false;
    readHubSettings().then(s => {
      settingsBootRead = true;
      // readHubSettings() answers null on ENOENT, and that is the ONE honest
      // signal that this is a genuinely fresh install rather than an existing one
      // whose owner just switched the version ping on. It has to be captured HERE,
      // at boot: by the time the first ping fires, an old install always has the
      // file, so asking then would call every late opt-in a new install and
      // corrupt the retention curve permanently. See version-ping.js.
      settingsBoot.fileMissing = (s === null);
      if (s) hub.settings = s;
      // Which store this process is actually running on, written down where a
      // person can read it. Reported on Discord as "my whole layout is back to
      // the factory default after an update", and there was no way to answer it:
      // a layout that resets and a layout that was never loaded look identical
      // from the dashboard, and nothing on the machine said which had happened.
      // The path is part of the line on purpose — an install pointed at a second
      // data folder is the other way the same screen appears, and the log is then
      // the only place that says so.
      startupLog.write(s
        ? 'settings: loaded ' + SETTINGS_FILE + ' (rev ' + (Number(s.rev) || 0)
            + ', store ' + (String(s.storeId || '').slice(0, 8) || 'none') + ')'
        : 'settings: no file at ' + SETTINGS_FILE
            + ': starting a NEW store, so this run begins from the factory defaults');
      // A layout about to be replaced by the version migration is copied out
      // before anything writes over it, and the fact is stated — the reset itself
      // is silent from every surface, which is how it reads as a bug rather than
      // as the upgrade step it is.
      if (s) {
        const backup = backupSupersededLayout();
        if (backup) {
          startupLog.write('settings: this build replaces the saved dashboard layout with the new default'
            + ' (layout format ' + backup.from + ' → ' + DASHBOARD_LAYOUT_VERSION + ').'
            + ' The layout you had is kept at ' + backup.file);
        }
      }
      // Mint the store id NOW rather than on the first save. A fresh install
      // whose settings.json does not exist yet answers GET /settings with no
      // payload at all, and the client's legacy seed path then pushes its own
      // localStorage copy up — which is the very restore-from-a-stale-surface
      // this identity exists to stop. One write, only when it is missing.
      if (!s || !s.storeId) {
        withHubSettingsLock(async () => {
          const cur = await readHubSettingsForUpdate();
          if (cur.storeId) return;                    // another writer got there first
          hub.settings = await writeHubSettings(cur);   // writeHubSettings mints
        }).catch(e => console.error('[settings] store id init failed:', e.message));
      }
      // The settings are in memory now, so the transfer caps can finally come
      // from them rather than from DEFAULT_HUB_SETTINGS (see fileTransfer.init).
      try { _applyTransferLimits(); } catch (e) { console.error('Transfer limits init failed:', e.message); }
      // The listener started on loopback because these settings had not been
      // read yet. If paired access was already on from a previous run, this is
      // where it opens — otherwise the phone that worked yesterday would find
      // nothing today until the user toggled the switch off and on again.
      try { applyBindHost(); } catch { /* the listener stays where it is */ }
      // Apply persisted lighting config (no-op/zero-cost while master is OFF).
      // Layouts a Gen2 controller fills in by itself are saved like the user's own.
      lighting.setNativeChangeHook(() => { _persistLighting(); });
      try { lighting.applyConfig((s || hub.settings).lighting); _syncSessionWatch(); } catch (e) { console.error('Lighting init failed:', e.message); }
      // Spotlight: start the global-hotkey listener if enabled, and rebuild the
      // crawler index for the user's extra search folders (both no-op/cheap
      // when off; delayed so they never compete with boot).
      setTimeout(() => {
        // The Deck's key shortcuts register with the page ones (refreshes the
        // listener itself when there are any).
        readDeckStore().then((store) => _refreshDeckShortcuts(store.configs)).catch(() => {});
        try { refreshHotkeyListener(); } catch { /* ignore */ }
        // Whether this install still starts itself at sign-in. Delayed with the
        // rest of the non-urgent boot work: nothing on screen depends on it, and
        // the answer matters for tomorrow rather than for this second.
        refreshStartupTaskState().catch(() => {});
        setInterval(() => { refreshStartupTaskState().catch(() => {}); }, STARTUP_TASK_CHECK_MS).unref();
        // Full Disk Access is asked BEFORE the index is first pointed at
        // anything, because the entire point of the gate is that the first walk
        // never touches a protected folder — asking afterwards would raise the
        // dialogs once and only then settle down, which is the bug.
        refreshMacFdaState()
          .catch(() => {})
          .finally(() => { try { refreshLivingIndex(); } catch { /* ignore */ } });
      }, 5000).unref();
      // And keep asking. The grant disappears on its own — it is bound to the
      // app's code signature, which changes with every build — so the state
      // this reads is not something a startup probe can hold. It also means
      // granting the permission is enough on its own: the index comes back
      // within a minute, with nothing to restart and nothing to click in Xenon.
      if (process.platform === 'darwin') {
        _macFdaTimer = setInterval(() => { refreshMacFdaState().catch(() => {}); }, 60000);
        _macFdaTimer.unref();
      }
    }).catch(err => {
      // Was `.catch(() => {})`. A settings file that exists but cannot be read —
      // a permission the OS took away, a half-copied data folder — left the
      // engine serving DEFAULT_HUB_SETTINGS with the transfer caps, the bind
      // host and the lighting config all unapplied, and said nothing anywhere.
      // It is not even a silent fallback the user can work around: POST
      // /settings is fail-closed against the same read, so every save is
      // refused too and the dashboard keeps showing defaults it can never
      // persist. Exactly the state that needs a line in the log.
      const why = (err && err.message) ? err.message : String(err);
      startupLog.write(settingsBootRead
        ? 'settings: loaded, but a startup step after it failed: ' + why
        : 'FAILED to read ' + SETTINGS_FILE + ': ' + why
            + '. This run falls back to the factory defaults, and every settings save is'
            + ' refused until that file can be read. Do not re-create your setup yet.');
      console.error('[settings] boot read failed:', why);
    });
  });
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    // A previous instance (or one of its long-lived children — media host,
    // pwsh worker, embedded browser) may still be releasing port 3030. The tray
    // "Restart" respawns node fast, so an immediate exit here left the dashboard
    // dead until a manual retry ("RESTART fails" in issue #100). Wait and retry
    // a few times before giving up, so a quick restart just picks up the port
    // once the old process finishes shutting down.
    if (_eaddrinuseRetries < EADDRINUSE_MAX_RETRIES) {
      _eaddrinuseRetries++;
      console.warn('Port ' + PORT + ' in use, retrying in ' + EADDRINUSE_RETRY_MS + 'ms (' + _eaddrinuseRetries + '/' + EADDRINUSE_MAX_RETRIES + ')…');
      // Re-listen WITHOUT a callback: the original _startListen() registered the
      // boot callback via once('listening'), which survives failed attempts and
      // fires on the eventual success — passing it again would double-run boot.
      setTimeout(() => { try { server.listen(PORT, _listenHost); } catch { /* re-emits 'error' */ } }, EADDRINUSE_RETRY_MS);
      return;
    }
    console.error('Port ' + PORT + ' is already in use. Close the other node process before restarting.');
    // Same reason as the listening line above. This one matters more: the fix is
    // not "reinstall Xenon", which is what the splash otherwise sends people to
    // do, it is "find what else is on 3030" — and nothing said so anywhere.
    startupLog.write('FAILED: port ' + PORT + ' is already in use by another program, after '
      + EADDRINUSE_MAX_RETRIES + ' retries. Xenon cannot share it.');
    process.exit(1);
  } else if ((err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL') && server.listening === false) {
    // IPv6 not available on this system — fall back to IPv4 loopback
    console.warn('IPv6 not available, falling back to 127.0.0.1');
    _startListen('127.0.0.1');
  } else {
    throw err;
  }
});

// IPv4 loopback. Only an explicit XENON_BIND_HOST reaches anything else, and
// the error handler above still falls back to 127.0.0.1 if that override names
// a stack this machine does not have.
//
// Deliberately the NARROW host even when paired access is on: the stored
// settings have not been read yet at this point, so widening here would mean
// guessing. applyBindHost() below runs once they load and opens it then — a
// listener that starts closed and opens a moment later is the safe order.
// A new install's settings go down first, so its first screen already reads them.
seedFreshInstall()
  .catch((e) => startupLog.write('settings: could not prepare the new install: ' + (e && e.message)))
  .finally(() => _startListen(BIND_HOST));

/**
 * Re-bind when paired access is switched on or off. No-op when the wanted host
 * is already the one in use, so it is safe to call on every settings write.
 *
 * `dropAll` is what makes this finish: close() alone waits for every open
 * connection to end, and the dashboard holds an SSE stream and WebSockets open
 * forever, so without it the rebind would never complete and nothing could
 * reach the server. Every client reconnects by itself.
 */
let _rebinding = false;
function applyBindHost() {
  const want = desiredBindHost();
  if (_rebinding || want === _listenHost) return;
  _rebinding = true;
  console.log(`[bind] paired access changed: moving listener to ${want}:${PORT}`);
  try {
    server.close(() => {
      _eaddrinuseRetries = 0;
      try { _startListen(want); } catch { /* the 'error' handler above owns retries */ }
      _rebinding = false;
    });
    listenerSockets.dropAll();
  } catch {
    _rebinding = false;
  }
}

// ── SSE broadcast timers ──────────────────────────────────────────────────────
// These replace client-side setInterval polling.  Timers only run work when at
// least one SSE client is connected, so they have no cost at idle.

function idleProbeWanted() {
  const v = hub.settings && hub.settings.vitals;
  if (v && v.enabled !== false) {
    if (v.pet && v.pet.enabled === true) return true; // pet presence gate
    if (v.awayPause !== false) return true;           // meters' away-pause (default on)
  }
  // Ambient screensaver auto-start also needs whole-PC idle, so it doesn't fire
  // while the user is active on another screen (idleMinutes clamped by normalize).
  const a = hub.settings && hub.settings.ambientMode;
  if (a && a.enabled !== false && Number(a.idleMinutes) > 0) return true;
  // The PC's own screensaver on the screens without the dashboard
  // (js/screen-scene-model.js wantsIdle): the native shell opens it from idleSec.
  if (a && a.enabled !== false && Number(a.saverMinutes) > 0) return true;
  // Presenza ambientale (ambient.js): the greeting splash holds a day-part until
  // someone is actually at the PC. Without this signal it falls back to greeting
  // on the clock alone, which spends the morning greeting on an empty room.
  const f = hub.settings && hub.settings.aiFeatures;
  if (f && f.enabled === true && f.ambient === true) return true;
  // A widget or a page ruled by "the PC is idle" (situations.js).
  return _situations.needs('idle');
}
async function _pollIdleProbe() {
  let delay = IDLE_POLL_MS;
  // A tick with no SSE client (2-3s EventSource reconnect gap) or with every
  // consumer off simply SKIPS the read — it must not wipe the sample: the 60s
  // freshness gates in statusPayload() and /api/vitals/nag already stop stale
  // values from being served, and wiping here would break the return-transition
  // broadcast (prev must stay a number across a reconnect hiccup) and reset the
  // fast cadence exactly while a screensaver is up.
  if (sseClients.size > 0 && idleProbeWanted()) {
    // Unreadable → idleSec reads null → PC actions stay off.
    const sec = await readIdleSeconds();
    if (sec != null) {
      const prev = _idleProbe.sec;
      _idleProbe.sec = sec;
      _idleProbe.at = Date.now();
      if (typeof prev === 'number' && prev >= IDLE_AWAY_SEC && _idleProbe.sec < IDLE_AWAY_SEC) broadcastStatusNow();
    }
    // Cadence from the last KNOWN sample — even when this read failed. A single
    // worker hiccup while the user is away must not drop back to the slow tick
    // right when spotting the return matters most.
    if (typeof _idleProbe.sec === 'number' && _idleProbe.sec >= IDLE_AWAY_SEC) delay = IDLE_POLL_FAST_MS;
  }
  setTimeout(_pollIdleProbe, delay).unref();
}
setTimeout(_pollIdleProbe, IDLE_POLL_MS).unref();

// The ONE shape of a 'status' payload — used by GET /status, the periodic SSE
// broadcast AND the SSE connect-seed. Every 'status' event must carry the full
// set: a partial one (the old seed sent just {muted}) reads as "no game" on the
// client and hid the Game Companion pill / confused Performance Mode on every
// SSE reconnect.
// bootAt = when this server process started. Vitals (vitals.js) uses it as a
// boot fence: a last-refill stamp older than it means the PC was off (or the
// backend restarted) in between, so the meters reseed to full instead of
// charging the downtime as neglect.
const _serverBootAt = Date.now();
function statusPayload() {
  let gaming = false;
  let activity = 'other';
  try { gaming = gameDetect.isGaming(); } catch { gaming = false; }
  try { activity = gameDetect.getActivity(); } catch { activity = 'other'; }
  let fgProcess = '';
  try { fgProcess = gameDetect.getForegroundProcess(); } catch { fgProcess = ''; }
  // gameRunning = game alive (foreground OR background); drives the Companion pill.
  // Computed before getGameProcess (it prunes the name once the game has exited).
  let gameRunning = false;
  try { gameRunning = gameDetect.isGameRunning(); } catch { gameRunning = false; }
  let gameProcess = '';
  try { gameProcess = gameDetect.getGameProcess(); } catch { gameProcess = ''; }
  // Presence for Vitals + Bit: seconds since real keyboard/mouse input, or
  // null when the probe is off (idleProbeWanted false) or stale — null means
  // "unknown": the pet never fires PC-invading actions on unknown, and the
  // meters' away-pause simply stays inactive (today's wall-clock behavior).
  const idleSec = (_idleProbe.at > 0 && Date.now() - _idleProbe.at < 60000) ? _idleProbe.sec : null;
  // version rides along so a page left open across a self-update can detect
  // the server changed under it and reload onto the matching client JS
  // (main.js) — a stale client's normalizers can corrupt shared state on save.
  // whenOff: opaque ids of the widgets whose rule or key hides them now, never why.
  const whenOff = [...new Set([..._situations.hidden(), ..._widgetKeys.hidden()])];
  return { muted: audioCache.muted, gaming, activity, process: fgProcess, gameRunning, gameProcess, idleSec, whenOff, bootAt: _serverBootAt, version: APP_VERSION };
}

const { statusSent } = require('./system/status-sent-state.js');
// A widget page marked "when I play" is shown while a game runs (layer-pages.js).
const _gamePageSync = LayerPages.createGamePageSync({
  current: () => hub.settings && hub.settings.layers,
  update: (edit) => updateLayersSetting(edit),
  warn: (msg) => console.warn(msg),
});
// A widget page tied to a virtual desktop is shown on it (POST /layers/desk).
const _deskPageSync = LayerPages.createDeskPageSync({
  current: () => hub.settings && hub.settings.layers,
  update: (edit) => updateLayersSetting(edit),
  warn: (msg) => console.warn(msg),
});
// A widget page with a situation comes forward while it holds (situations.js).
const _whenPageSync = LayerPages.createWhenPageSync({
  current: () => hub.settings && hub.settings.layers,
  update: (edit) => updateLayersSetting(edit),
  warn: (msg) => console.warn(msg),
});
const { _perfNet } = require('./performance/engine-perf-net.js');
// One summary per game played (game-sessions.js). Fed by the status tick, so it
// adds no timer of its own; the system tick adds the CPU/GPU averages.
const _gameSessions = createGameSessions({
  fps: fpsMonitor,
  file: path.join(DATA_DIR, 'game-sessions.json'),
  writeFileAtomic,
  enabled: gameSessionsEnabled,
  onEnd: () => { try { _perfStream.sessionEnded(); } catch {} },
});
_gameSessions.load().catch(() => {});
// A benchmark run (benchmark.js): its own 1 s timer only while one is going.
// Start and end are told to every dashboard over SSE `benchmark`.
let _documentsDir = null;
const documentsRoot = () => (_documentsDir || (_documentsDir = resolveDocumentsDir({ execFile })));
const _benchmark = createBenchmark({
  fps: fpsMonitor,
  game: () => (gameDetect.isGameRunning() ? gameDetect.getGameProcess() : ''),
  documentsDir: documentsRoot,
  // The folder the user chose for benchmark files, or Documents/Xenon/Benchmark.
  folder: () => _captureFolder.resolve(captureOptions().benchFolder),
  writeFile: (file, text) => fs.promises.writeFile(file, text, 'utf8'),
  mkdir: (dir, opts) => fs.promises.mkdir(dir, opts),
  onStart: ({ game }) => broadcastSSE('benchmark', { running: true, game }),
  onEnd: (result) => broadcastSSE('benchmark', { running: false, result }),
});
// What Xenon captured (captures.js), saved under the user's Pictures and Videos folders.
let _picturesDir = null;
let _videosDir = null;
const videosRoot = () => (_videosDir || (_videosDir = resolveUserFolder('videos', { execFile })));
const picturesRoot = () => (_picturesDir || (_picturesDir = resolveUserFolder('pictures', { execFile })));
const _captures = createCaptures({
  file: path.join(DATA_DIR, 'captures.json'),
  writeFileAtomic,
  picturesDir: picturesRoot,
  videosDir: videosRoot,
  // A capture deleted here or pruned for space takes its preview and its pins
  // on the screen with it (capabilities/screen-pin.js).
  onRemove: (id) => {
    _captureGallery.forget(id);
    _transcripts.forget(id).catch(() => {});
    updateLayersSetting(cur => LayersModel.unpinCapture(cur, id)).catch(() => { /* a pin left shows "not found" with its x */ });
  },
});
// The gallery's previews, trims and clipboard copies (capture-gallery.js).
const _captureGallery = createCaptureGallery({
  host: _captureHost,
  store: _captures,
  thumbDir: path.join(DATA_DIR, 'capture-thumbs'),
  mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
  exists: (p) => fs.promises.access(p).then(() => true, () => false),
  unlink: (p) => fs.promises.unlink(p),
});
// "To phone" (capture-send.js): the capture into the file transfer's PC → phone
// list, the same push a file sent from the PC gets, every Files tile refreshed.
const _captureSend = createCaptureSend({
  store: _captures,
  transfer: fileTransfer,
  enabled: () => transferEnabled(),
  phones: () => remoteAccess.count(),
  sizeOf: (p) => fs.promises.stat(p).then((st) => (st.isFile() ? st.size : null), () => null),
  link: (a, b) => fs.promises.link(a, b),
  copyFile: (a, b) => fs.promises.copyFile(a, b, fs.constants.COPYFILE_EXCL),
  rename: (a, b) => fs.promises.rename(a, b),
  unlink: (p) => fs.promises.unlink(p),
});
// "Copy to a folder" (capture-copy.js): Desktop, Downloads, Documents, Pictures
// or Videos by name; the path stays here.
const _captureCopy = createCaptureCopy({
  store: _captures,
  folderOf: (place) => resolveUserFolder(place, { execFile }),
  mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
  exists: (p) => fs.promises.access(p).then(() => true, () => false),
  copyFile: (a, b) => fs.promises.copyFile(a, b),
  rename: (a, b) => fs.promises.rename(a, b),
  unlink: (p) => fs.promises.unlink(p),
});
async function sendCaptureToPhone(id) {
  const r = await _captureSend.send(id);
  if (r.ok && !r.already) {
    broadcastTransfer();
    if (transferSettings().notifyPhone) {
      webPushNotify({ title: 'Xenon', body: transferPushBody(), tag: 'transfer', url: '/' }, { urgency: 'normal', ttl: 3600 }).catch(() => {});
    }
  }
  return r;
}
// "Clips from marks" (capture-gallery.js clips()): the gallery's button, the
// Deck key and Bit. Every open gallery shows the new copies.
async function makeMarkClips(id, which) {
  const r = await _captureGallery.clips(id, { which: String(which || 'auto') });
  if (!r.ok) return r;
  broadcastSSE('captures', { changed: true });
  return {
    ok: true, clips: r.clips, of: r.of, first: r.entries[0].id, names: r.entries.map(e => e.name),
    ...(r.stopped ? { stopped: r.stopped } : {}),
  };
}
// Videos made ready to share (capture-export.js): vertical, fitted to a size,
// GIF. Every open gallery follows the progress; a new copy refreshes them.
const _captureExport = createCaptureExport({
  host: _captureHost,
  store: _captures,
  sizeOf: (p) => fs.promises.stat(p).then((st) => st.size, () => null),
  onProgress: (ev) => broadcastSSE('capture_export', ev),
  onDone: (ev) => {
    broadcastSSE('capture_export', {
      id: ev.id, kind: ev.kind, from: ev.from, done: true, ok: ev.ok === true,
      ...(ev.ok ? { newId: ev.entry.id, name: ev.entry.name, bytes: ev.bytes } : { error: ev.error }),
    });
    if (ev.ok) broadcastSSE('captures', { changed: true });
  },
});
// Screenshots made ready to share: private spots, covered and edited copies.
const _captureCovers = CaptureCovers.createCaptureCovers({
  host: _captureHost,
  store: _captures,
  exists: (p) => fs.promises.access(p).then(() => true, () => false),
  writeFile: (p, data) => fs.promises.writeFile(p, data),
  rename: (a, b) => fs.promises.rename(a, b),
  unlink: (p) => fs.promises.unlink(p),
});
// What is said in a recording, written down on this PC (capture-transcripts.js):
// the engine decodes the sound, the voice's whisper.cpp writes it, one at a time.
const _transcripts = createCaptureTranscripts({
  host: _captureHost,
  store: _captures,
  dir: path.join(DATA_DIR, 'capture-transcripts'),
  whisper: () => (_whisperReady() ? { exe: aiLocal.whisperExe(__dirname), model: aiLocal.whisperPaths(__dirname).model } : null),
  spawn: (exe, args) => spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }),
  clean: aiLocal.cleanTranscript,
  speedArgs: aiLocal.whisperSpeedArgs,
  lowPriority: lowerPriority,
  readFile: (p, enc) => fs.promises.readFile(p, enc),
  writeFileAtomic,
  unlink: (p) => fs.promises.unlink(p),
  readdir: (dir) => fs.promises.readdir(dir),
  mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
  stat: (p) => fs.promises.stat(p),
  onState: (ev) => broadcastSSE('transcript', ev),
});
_transcripts.load().catch(() => {});
const { folderChoice } = require('./files/folder-choice-state.js');
const _captureFolder = createCaptureFolder({
  host: _captureHost,
  validDir: (dir) => fileTransferLib.validInboxDir(dir, { dataDir: DATA_DIR, appRoot: path.join(__dirname, '..') }),
  title: () => LayerI18n.text(CAPTURE_FOLDER_TITLES[folderChoice.kind], hub.settings && hub.settings.language),
});
async function defaultCaptureFolder(kind) {
  if (kind === 'screenshot') return path.join(await picturesRoot(), 'Xenon');
  if (kind === 'benchmark') return path.join(await documentsRoot(), 'Xenon', 'Benchmark');
  if (kind === 'bugreport') return path.join(await documentsRoot(), 'Xenon', 'Bug reports');
  // The log folder has no default: nothing is added until the user picks one.
  if (kind === 'buglogs') return documentsRoot();
  return path.join(await videosRoot(), 'Xenon');
}
// The dialog opens where that kind of file goes now.
async function chooseCaptureFolder(kind = 'recording') {
  const k = CaptureSettings.FOLDERS[kind] ? kind : 'recording';
  // The dialog on screen is for another kind: its answer must not land here.
  if (_captureFolder.picking() && folderChoice.kind !== k) return { ok: false, error: 'picking' };
  folderChoice.kind = k;
  const cur = captureOptions()[CaptureSettings.FOLDERS[k]];
  return _captureFolder.choose(cur || await defaultCaptureFolder(k));
}
// Where files from a paired phone arrive (fileTransfer.inboxDir).
async function chooseTransferFolder() {
  if (_captureFolder.picking()) return { ok: false, error: 'picking' };
  folderChoice.kind = 'transfer';
  return _captureFolder.choose(transferInboxDir());
}
// The only writer of the fileTransfer block: POST /api/transfer/settings and
// its /pick. `body.inboxDir`, when set, was validated by the caller.
async function updateTransferSettings(body) {
  await withHubSettingsLock(async () => {
    // `prev` is read INSIDE the lock: one captured before acquiring it is
    // already stale by the time the write lands.
    const cur = await readHubSettingsForUpdate();
    const merged = { ...(cur.fileTransfer || {}) };
    for (const key of ['enabled', 'autoDeliver', 'notifyPhone']) {
      if (typeof body[key] === 'boolean') merged[key] = body[key];
    }
    for (const key of ['maxFileMb', 'quotaMb', 'keepDays']) {
      if (Number.isFinite(Number(body[key]))) merged[key] = Number(body[key]);
    }
    if (typeof body.inboxDir === 'string') merged.inboxDir = body.inboxDir.trim();
    const saved = await writeHubSettings({
      ...cur,
      fileTransfer: merged,
      rev: nextSettingsRev(cur.rev, body.rev),
    });
    hub.settings = saved;
    broadcastSSE('settings', { rev: saved.rev });
  });
  _applyTransferLimits();
  broadcastTransfer();
  return { ok: true, ...transferSettings(), inboxDir: transferInboxDir() };
}
// Where one backup goes (/backup/save from the iCUE view): asked each time,
// never remembered, opening in Downloads.
async function chooseBackupFolder() {
  if (_captureFolder.picking()) return { ok: false, error: 'picking' };
  folderChoice.kind = 'backup';
  return _captureFolder.choose(path.join(os.homedir(), 'Downloads'));
}
_captures.load().catch(() => {});
// Markers on the capture timeline (capture-markers.js): the user's bookmarks
// and, from the status tick, the game's stutters while something records.
const captureRunning = () => _recorder.status().on === true || _replay.status().on === true;
const _captureMarkers = createCaptureMarkers({
  fps: fpsMonitor,
  active: captureRunning,
  autoMarks: () => captureOptions().autoMarks !== false,
  onAdd: (m) => _autoClips.onMark(m),
});
// PresentMon pauses with no dashboard connected (fps-demand.js); a recording
// that marks stutters keeps it reading, or the video gets none.
function holdFpsForMarkers() {
  _fpsDemand.capture(captureRunning() && captureOptions().autoMarks !== false);
}
// A screen or window recording (recorder.js). Start and end go to every
// dashboard over SSE `recording` (the Deck key, the "Recording" card); the
// saved file over SSE `capture`, like a screenshot.
const _recorder = createRecorder({
  host: _captureHost,
  store: _captures,
  game: () => (gameDetect.isGameRunning() ? gameDetect.getGameProcess() : ''),
  mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
  exists: (p) => fs.promises.access(p).then(() => true, () => false),
  options: captureOptions,
  folder: () => _captureFolder.resolve(captureOptions().folder),
  markers: _captureMarkers,
  onChange: (state) => broadcastSSE('recording', state),
  onSaved: (e) => broadcastSSE('capture', {
    kind: 'recording', id: e.id, name: e.name, game: e.game, seconds: e.seconds, reason: e.reason,
    ...(e.every ? { every: e.every, span: e.span } : {}),
    ...(e.pruned ? { pruned: e.pruned, limitGB: captureOptions().maxGB } : {}),
  }),
});
const { _captureLast } = require('./screens/engine-capture-last.js');
const _stepsRecorder = createStepsRecorder({
  host: _captureHost,
  root: documentsRoot,
  mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
  readFile: (p) => fs.promises.readFile(p),
  writeFile: (p, data) => fs.promises.writeFile(p, data, 'utf8'),
  rename: (a, b) => fs.promises.rename(a, b),
  rmdir: (dir) => fs.promises.rmdir(dir),
  words: async () => {
    const lang = stepsLanguage();
    const out = {};
    for (const key of StepsDoc.ALL_WORDS) out[key] = await LayerI18n.text(key, lang);
    return out;
  },
  badge: () => LayerI18n.text('steps_badge', stepsLanguage()),
  lang: stepsLanguage,
  when: (ms) => {
    try { return new Date(ms).toLocaleString(stepsLanguage(), { dateStyle: 'long', timeStyle: 'short' }); } catch { return new Date(ms).toLocaleString(); }
  },
  openFile: (file) => { openExternalPath(file).catch((e) => console.warn('[steps] open failed:', e && e.message)); },
  reveal: (file) => revealInFileManager(file),
  remember: _captureLast.forKind('steps'),
  exists: (file) => fs.promises.access(file).then(() => true, () => false),
  onChange: (state) => broadcastSSE('steps', state),
  onSaved: (e) => broadcastSSE('capture', { kind: 'steps', count: e.count, reason: e.reason }),
});
// Instant Replay (replay.js): the last seconds of the screen in a ring on disk
// (user-folders.js `replayRingDir`), saved like a recording. State to every dashboard over SSE
// `replay` (the Deck key, Settings); the saved clip over SSE `capture`.
const _replay = createReplay({
  host: _captureHost,
  store: _captures,
  options: captureOptions,
  folder: () => _captureFolder.resolve(captureOptions().folder),
  game: () => (gameDetect.isGameRunning() ? gameDetect.getGameProcess() : ''),
  // Running, not only in front: an Alt+Tab must not throw the kept minutes away.
  gaming: () => gameDetect.isGameRunning(),
  ringDir: replayRingDir(),
  mkdir: (dir) => fs.promises.mkdir(dir, { recursive: true }),
  markers: _captureMarkers,
  onChange: (state) => broadcastSSE('replay', state),
  onSaved: (e) => broadcastSSE('capture', {
    kind: 'replay', id: e.id, name: e.name, game: e.game, seconds: e.seconds,
    ...(e.auto ? { auto: e.auto } : {}),
    ...(e.folderMissing === true ? { folderMissing: true } : {}),
    ...(e.pruned ? { pruned: e.pruned, limitGB: captureOptions().maxGB } : {}),
  }),
});
// Clips the replay saves by itself around a marked moment (capture-autoclips.js,
// capture.replayClips); fed by the marker log above.
const _autoClips = createAutoClips({
  replay: _replay,
  recording: () => _recorder.status().on === true,
  mode: () => captureOptions().replayClips || 'marks',
});
// The bug report package (bug-report.js): the window in front, the last
// seconds from Instant Replay, the system and the chosen logs, in one .zip in
// Documents/Xenon/Bug reports. Never the PC name, the user name or a window
// title; the notice carries counts and the zip's name only.
const _bugReport = createBugReport({
  host: _captureHost,
  replay: () => _replay,
  folder: () => _captureFolder.resolve(captureOptions().bugFolder),
  defaultDir: () => defaultCaptureFolder('bugreport'),
  logFolder: () => _captureFolder.resolve(captureOptions().bugLogs),
  system: async () => {
    const s = await getSystemInfo().catch(() => ({}));
    return {
      xenon: APP_VERSION, os: os.type(), osRelease: os.release(), arch: os.arch(),
      cpu: s.cpuName, cores: os.cpus().length,
      ramTotal: s.memory && s.memory.total, ramPercent: s.memory && s.memory.percent,
      gpu: s.gpuName, vramTotal: s.vramTotal, uptime: s.uptime,
    };
  },
  foreground: () => { try { return gameDetect.getForegroundProcess(); } catch { return ''; } },
  fs: fs.promises,
  tmpRoot: os.tmpdir(),
  writeZip,
  reveal: (file) => revealInFileManager(file),
  remember: _captureLast.forKind('bugreport'),
  onSaved: (e) => broadcastSSE('capture', {
    kind: 'bugreport', name: e.name, app: e.app, video: e.video, screenshot: e.screenshot, logs: e.logs,
    ...(e.noVideo ? { noVideo: e.noVideo } : {}),
    ...(e.logsMissing === true ? { logsMissing: true } : {}),
    ...(e.folderMissing === true ? { folderMissing: true } : {}),
  }),
});
// "Why does it stutter?" (stutter-why.js): the system tick feeds it while a game
// runs; the perf stream carries its line, the Deck key and Bit ask it directly.
const _stutterWatch = createStutterWatch({
  fps: fpsMonitor,
  readSystem: async () => ({ ...(await getSystemInfo()), cpuMaxCore: cpuRead.maxCore }),
  game: () => (gameDetect.isGameRunning() ? gameDetect.getGameProcess() : ''),
  culprit: perfSession.culprit,
});
const { _exclusiveHint } = require('./performance/engine-exclusive-hint.js');
const { _fpsNotice } = require('./sensor-service/engine-fps-notice.js');
const _perfStream = createPerfStream({
  fps: fpsMonitor,
  why: () => _stutterWatch.current(),
  wanted: perfWanted,
  hasClients: () => sseClients.size > 0,
  broadcast: (payload) => broadcastSSE('perf', payload),
  last: () => _gameSessions.last(),
  bench: () => _benchmark.status(),
  // A game that runs but draws no readable frames is named, not "start a game".
  game: () => (gameDetect.isGameRunning() ? gameDetect.getGameProcess() : ''),
  access: () => require('./sensor-service/fps-access.js').instance().current(),
});

function syncBackgroundHold() {
  const on = backgroundHeld();
  livingIndex.hold(on);
  diskSpace.hold(on);
  // A ringing call stays as quick as ever, that switch is why the reader may be running.
  winNotif.setPace(on && !hub.settings?.calls?.enabled);
}

function broadcastStatusNow() {
  try { syncBackgroundHold(); } catch {}
  try { syncCoreShield(); } catch {}
  // Instant Replay follows the game with or without a dashboard open; this
  // tick also settles a backup import or a missed game event.
  try { _replay.sync(); } catch {}
  try { holdFpsForMarkers(); } catch {}
  try { _fpsDemand.game(gameDetect.isGameRunning()); } catch {}
  if (sseClients.size === 0) {
    _perfStream.setGaming(false);
    // A session still ends when its game does, and a recording marks its
    // stutters, dashboard open or not.
    if (_gameSessions.isOpen()) {
      try { _gameSessions.tick(gameSessionFacts(gameDetect.isGameRunning(), gameDetect.getGameProcess())); } catch {}
    }
    try { _captureMarkers.tick({ running: gameDetect.isGameRunning(), game: gameDetect.getGameProcess() }); } catch {}
    return;
  }
  try { _situations.tick(); } catch (e) { console.warn('situations: ' + e.message); }
  const st = statusPayload();
  try { _gameSessions.tick(gameSessionFacts(st.gameRunning, st.gameProcess)); } catch {}
  try { _captureMarkers.tick({ running: st.gameRunning, game: st.gameProcess }); } catch {}
  try { _perfStream.setGaming(st.gaming && perfWanted()); } catch {}
  try { lighting.onStatus({ gaming: st.gaming }); } catch {}
  try { _gamePageSync(st.gameRunning); } catch {}
  try { briefing.onStatusTick(st); } catch {}
  const j = JSON.stringify(st);
  if (j === statusSent.json && Date.now() - statusSent.at < 30000) return;
  statusSent.json = j;
  statusSent.at = Date.now();
  broadcastSSE('status', st);
}

setInterval(broadcastStatusNow, 3000).unref();

// Apps a crashed server left moved go back before the first tick decides anything.
perfSession.shield.recover();

// Game-mode flips ride the foreground probe's instant push lines: broadcast
// right away so entering/leaving a game doesn't wait for the next 3s tick.
try { gameDetect.onGamingChange(() => broadcastStatusNow()); } catch {}

const { mediaSent } = require('./media/sent-state.js');
async function broadcastMediaNow() {
  if (sseClients.size === 0) return;
  const payload = mediaForBroadcast(await getMediaInfo());
  const j = JSON.stringify(payload);
  if (j === mediaSent.json) return;
  mediaSent.json = j;
  broadcastSSE('media', payload);
}

setInterval(() => { broadcastMediaNow().catch(() => {}); }, 2000).unref();

// 5s, matched to the caches underneath rather than picked as a feel. getCpuTemp
// and getGpuInfo each hold their reading for 5s, so this is the fastest cadence
// that costs nothing extra: every tick now lands on a fresh read instead of
// re-sending a value up to two seconds old, which is where the "sensors feel
// slow" impression came from. Going BELOW 5s would mean lowering those caches
// too, and that is the expensive half — on Windows they are LibreHardwareMonitor
// round-trips through the persistent worker, paid continuously on a machine that
// is often also running a game. If a faster rate is ever offered it belongs in
// Settings, saying what it costs, not as a new default for everyone.
// Self-rescheduling rather than a fixed interval: the cadence is a setting now,
// and a setInterval would hold whatever it was created with until a restart.
// Each tick reads it again, so a change in Settings applies to the next one.
//
// The delay is taken AFTER the await, not before: a read that takes longer than
// the interval (a cold LHM call, a busy machine) would otherwise queue ticks on
// top of each other, and at 1s that stops being theoretical.
async function _systemTick() {
  if (sseClients.size > 0) {
    try {
      const sys = await getSystemInfo();
      broadcastSSE('system', sys);
      _perfNet.tick();
      lighting.onSystem(sys);
      try { briefing.onSystemSample(sys); } catch {}
      try { _gameSessions.onSystem(sys); } catch {}
      try {
        const game = gameDetect.isGameRunning() ? gameDetect.getGameProcess() : '';
        _stutterWatch.onSystem(game ? { ...sys, cpuMaxCore: cpuRead.maxCore } : null, game);
        try { _exclusiveHint.onTick(game); } catch {}
        _fpsNotice.onTick(game);
      } catch {}
    } catch {}
  }
  const t = setTimeout(_systemTick, sensorRateMs());
  t.unref && t.unref();
}
{ const t = setTimeout(_systemTick, sensorRateMs()); t.unref && t.unref(); }

let _batteryPolledAt = 0;
let _lastBatteryJson = '';
setInterval(async () => {
  if (sseClients.size === 0) return;
  if (backgroundHeld() && Date.now() - _batteryPolledAt < BATTERY_POLL_GAME_MS) return;
  try {
    if (!(await batteryWanted())) return;
    _batteryPolledAt = Date.now();
    const payload = await batteryMonitor.getDevices();
    const j = JSON.stringify(payload);
    if (j === _lastBatteryJson) return;
    _lastBatteryJson = j;
    broadcastSSE('battery', payload);
  } catch {}
}, 90000).unref();

const { AUDIO_POLL_GAME_MS } = require('./audio/poll-timings.js');
let _audioPolledAt = 0;
let _lastAudioJson = '';
setInterval(async () => {
  if (sseClients.size === 0) return;
  if (!audioPollWanted()) return;
  if (backgroundHeld() && Date.now() - _audioPolledAt < AUDIO_POLL_GAME_MS) return;
  _audioPolledAt = Date.now();
  try {
    const a = await getAudioInfo();
    lighting.onAudio(a);   // no-op today; kept as the seam a future audio effect binds to
    const j = JSON.stringify(a);
    if (j !== _lastAudioJson) { _lastAudioJson = j; broadcastSSE('audio', a); }
  } catch {
    // SoundVolumeView failed (commonly AV-quarantined). Tell clients so the Volume
    // section can show an explicit "audio unavailable" notice instead of sitting
    // silently on placeholder dashes. Deduped like a normal payload.
    const j = '{"unavailable":true}';
    if (j !== _lastAudioJson) { _lastAudioJson = j; broadcastSSE('audio', { unavailable: true }); }
  }
}, 8000).unref();

// Keepalive ping every 20 s to prevent proxy/load-balancer timeouts.
setInterval(() => {
  if (sseClients.size === 0) return;
  const ping = ':ping\n\n';
  for (const res of sseClients) {
    try { res.write(ping); } catch { sseClients.delete(res); }
  }
}, 20000).unref();

// ── Last-resort process guards ────────────────────────────────────────────────
// The backend runs unattended 24/7. Node terminates the process on an unhandled
// promise rejection (and on an uncaught exception), so a single stray error in
// ANY of the many background tasks — SSE broadcasts, sensor polls, lighting, the
// game/foreground probes — would take the whole dashboard down, after which the
// tray "Restart" could race the still-held port. That is the most likely cause
// of the "crashed again, RESTART fails" reports on machines where the PowerShell
// sensor layer keeps failing (issue #100). Log loudly and keep serving instead
// of dying: a broken sensor read must never kill the dashboard. Genuinely fatal
// conditions (a failed listen) are still handled explicitly at their source, and
// intentional shutdown sets _shuttingDown so these don't fire spuriously.
let _shuttingDown = false;
process.on('unhandledRejection', (reason) => {
  if (_shuttingDown) return;
  console.error('[unhandledRejection] ' + ((reason && reason.stack) || (reason && reason.message) || reason));
});
process.on('uncaughtException', (err) => {
  if (_shuttingDown) return;
  console.error('[uncaughtException] ' + ((err && err.stack) || err));
});

// Graceful shutdown: close SSE streams and the HTTP server so port 3030 is
// released promptly on Ctrl+C / SIGTERM. Without this, long-lived SSE
// connections keep the process alive for 30+ seconds after the signal,
// causing EADDRINUSE on quick restarts (npm run start immediately after Ctrl+C).
// The handler calls process.exit(0) explicitly — the old comment warning
// about suppressing Ctrl+C only applies to handlers that *return* without
// exiting. A 3-second safety timeout force-exits if connections drain slowly.
function _gracefulShutdown() {
  _shuttingDown = true;
  // No countdown or install may start while this process is going away.
  try { autoUpdater.stop(); } catch {}
  try { widgetAutoUpdater.stop(); } catch {}
  layersEdit.stop();
  layersPeek.stop();
  _perfStream.stop();
  _calendarReminders.stop();
  deckShortcutRunner.stop();
  mcpDev.close();
  featureRoutes.stop();
  // Flush a pending (debounced) lighting persist so the last change survives.
  // The promise is awaited by the exit path below — firing it and exiting
  // immediately could kill the process mid write-fsync-rename. A game session
  // in progress is closed and saved the same way.
  let shutdownFlush = Promise.resolve();
  try { shutdownFlush = _flushLightingPersist().catch(() => {}); } catch {}
  // The apps Core Shield moved go back while this process can still reach them.
  try { shutdownFlush = Promise.all([shutdownFlush, perfSession.shield.stop()]).catch(() => {}); } catch {}
  try { const sessions = _gameSessions.flush(); shutdownFlush = Promise.all([shutdownFlush, sessions]).catch(() => {}); } catch {}
  try { const bench = _benchmark.flush(); shutdownFlush = Promise.all([shutdownFlush, bench]).catch(() => {}); } catch {}
  // Cache access times kept in memory since the last periodic write (sdk-asset-cache.js).
  try { if (typeof sdkAssets.flush === 'function') { const a = sdkAssets.flush(); shutdownFlush = Promise.all([shutdownFlush, a]).catch(() => {}); } } catch {}
  // A recording in progress is stopped and indexed before the engine goes; the
  // index is written after it. Past the safety timeout the engine still
  // finishes the file by itself when its stdin closes with this process.
  try { _transcripts.stop(); } catch {}
  try { _autoClips.stop(); } catch {}
  try {
    const shots = Promise.all([_recorder.flush().catch(() => {}), _stepsRecorder.flush().catch(() => {}), _replay.flush().catch(() => {})])
      .then(() => _captureHost.stop())
      .then(() => _captures.flush());
    shutdownFlush = Promise.all([shutdownFlush, shots]).catch(() => {});
  } catch { _captureHost.stop(); }
  // Terminate all open SSE streams (the main long-lived handles).
  for (const res of sseClients) { try { res.end(); } catch {} }
  sseClients.clear();
  // Flush the paired-device store's debounced "last seen" bookkeeping, and let
  // go of the socket bookkeeping. Nothing here is security-critical — the
  // tokens are already on disk — but a shutdown should not lose the last hour
  // of "when did my phone last connect".
  try { shutdownFlush = shutdownFlush.then(() => remoteAccess.flush()).catch(() => {}); } catch {}
  // Write the debounced lyrics cache now rather than lose the last few songs.
  try { shutdownFlush = shutdownFlush.then(() => lyricsCache.flush()).catch(() => {}); } catch {}
  try { shutdownFlush = shutdownFlush.then(() => usageStats.flush()).catch(() => {}); } catch {}
  try { ratingVotes.stop(); shutdownFlush = shutdownFlush.then(() => ratingVotes.flush()).catch(() => {}); } catch {}
  try { shutdownFlush = shutdownFlush.then(() => lyricsOffsets.flush()).catch(() => {}); } catch {}
  try { shutdownFlush = shutdownFlush.then(() => lyricsTranslator.flush()).catch(() => {}); } catch {}
  // The T2 listener holds its own sockets — including SSE streams, which never
  // end on their own — and the process would not exit with them open.
  try { shutdownFlush = shutdownFlush.then(() => remoteHttps.stop()).catch(() => {}); } catch {}
  // An upload in flight dies with its socket, and its `.part` is left behind.
  // Sweep them here rather than only at the next boot, so a restart during a
  // transfer does not leave half a video occupying disk until then. Age 0: at
  // shutdown every in-flight upload is over, whatever its clock says.
  try { clearInterval(_transferSweepTimer); } catch {}
  try { shutdownFlush = shutdownFlush.then(() => fileTransfer.sweepInflight(0)).catch(() => {}); } catch {}
  try { _remoteSockets.clear(); } catch {}
  // Release RGB bridge so iCUE reclaims device control immediately.
  try { lighting.releaseAll(); lighting.disconnect(); } catch {}
  // Native controllers: hand the headers back to the board's own effects and
  // close the USB handles before the process goes.
  try { shutdownFlush = shutdownFlush.then(() => lighting.closeNative()).catch(() => {}); } catch {}
  try { _sessionWatch.stop(); } catch {}
  // Stop the persistent PowerShell collector host (safe to kill: no SMTC handles).
  try { _killWorker('shutdown'); } catch {}
  // Retire the SMTC media host gracefully (stdin close → clean exit → handles released).
  try { _retireMediaHost('shutdown'); } catch {}
  // …and the non-Windows one: a detached perl/playerctl child outlives
  // process.exit, so it has to be told.
  try { if (nativeMedia) nativeMedia.stop(); } catch {}
  // Kill the headless embedded-browser Edge instance (if one is running).
  try { embeddedBrowser.shutdown(); } catch {}
  // Stop the second-screen capture host (if one is running).
  try { screenCapture.shutdown(); } catch {}
  // Stop the PresentMon FPS reader (holds an admin ETW tracing session) and the
  // foreground game probe. Both spawn long-lived children with no job object, so
  // without an explicit stop process.exit orphans them across every restart.
  try { _fpsDemand.stop(); } catch {}
  try { fpsMonitor.stopFpsMonitor(); } catch {}
  try { gameDetect.stopGameDetect(); } catch {}
  try { winNotif.stop(); } catch {}
  try { calls.stop(); } catch {}
  try { phone.stop(); } catch {}
  try { wakeWord.stop(); } catch {}
  try { audioLevels.stop(); } catch {}
  try { guardian.stop(); } catch {}
  // Settle every pending Claude Code permission request. These are HTTP requests
  // the `claude` process is actively blocked on — exiting without answering would
  // leave each of them hanging until their own 600s hook timeout expires.
  // The mod's held inbox requests too, for the same reason.
  try { _claudeInbox.stop(); } catch {}
  try { _claudeBridge.stop(); } catch {}
  try { if (_claudeRegistryTimer) { clearInterval(_claudeRegistryTimer); _claudeRegistryTimer = null; } } catch {}
  // Runs the dashboard started are children with no job object: exiting without
  // this orphans a `claude` process (and the tool processes it spawned) with no
  // terminal attached to stop it.
  try { _claudeRunner.stopAll(); } catch {}
  // Codex: settle every approval codex-hook.js is blocked on (each would
  // otherwise hold Codex for the rest of its hook timeout), and stop the
  // app-server child, which has no job object to die with us.
  try { _codexBridge.stop(); } catch {}
  try { _codexApp.stop(); } catch {}
  // Ask ChatGPT turns are codex children with no job object: kill them.
  try { _chatgptAsker.stopAll(); } catch {}
  // Kill any in-flight STT recorder: unlike the other children it has no stop
  // module, so Ctrl+C mid-recording would orphan an ffmpeg that keeps the mic
  // device open — blocking the wake word after restart.
  for (const rec of _sttPending.values()) { try { rec.ffmpegProc.kill(); } catch {} }
  _sttPending.clear();
  // Tear down any active Voce Live session — its continuous ffmpeg capture and
  // Gemini WebSocket are long-lived children/handles with no job object, so
  // process.exit would orphan the ffmpeg (mic stays open, wake word dead).
  try { _teardownLiveSession('shutdown'); } catch {}
  // Stop the live voice watch (clears its reconnect timer) then close the Discord
  // RPC named-pipe socket. Stopping first prevents close() from scheduling a
  // reconnect during shutdown.
  try { stopDiscordWatch(); } catch {}
  try { discordLink.rpc.close(); } catch {}
  // Stop the live Home Assistant watch (clears its reconnect timer) then close the
  // WebSocket. Stopping first prevents close() from scheduling a reconnect.
  try { if (haWatching.stop) { const stopHa = haWatching.stop; stopHa(); haWatching.stop = null; } } catch {}
  try { if (haWatch.notifyTimer) { clearTimeout(haWatch.notifyTimer); haWatch.notifyTimer = null; } } catch {}
  try { deckHa.close(); } catch {}
  // Stop the Wave Link mixer watch (clears its reconnect timer) then close the WS;
  // uninitialize any held Chroma session so Synapse reclaims device control.
  try { if (wlWatching.stop) { const stopWl = wlWatching.stop; stopWl(); wlWatching.stop = null; } } catch {}
  try { if (wlWatch.notifyTimer) { clearTimeout(wlWatch.notifyTimer); wlWatch.notifyTimer = null; } } catch {}
  try { deckWaveLink.close(); } catch {}
  // Stop the UniFi Protect camera-notifications watch (clears its reconnect timer)
  // then close the updates WebSocket — a long-lived socket with no job object.
  try { if (unifiWatching.stop) { const stopUnifi = unifiWatching.stop; stopUnifi(); unifiWatching.stop = null; } } catch {}
  try { deckUnifiEvents.close(); } catch {}
  try { deckChroma.close(); } catch {}
  // Resolve any parked sdk_handler calls so their /actions/run responses flush
  // before the server closes (their timers are cleared with them).
  try { sdkHandlerShutdown(); } catch {}
  // Retire the local-search PS host (stdin close → clean COM release) and
  // flush its pending open-frequency write. stop() RETURNS that write's
  // promise: folding it into shutdownFlush is what makes the exit path wait
  // for it, otherwise every result opened in the last debounce window before
  // quitting was silently lost.
  try { shutdownFlush = Promise.all([shutdownFlush, Promise.resolve(fileSearch.stop()).catch(() => {})]); } catch {}
  // Stop a running disk scan (the helper child has no job object).
  try { diskSpace.stop(); } catch {}
  try { devClean.stop(); } catch {}
  try { trialPass.stop(); } catch {}
  // Stop the Living Index host (in-RAM index + watchers).
  try { livingIndex.stop(); } catch {}
  // Unregister the global Spotlight hotkey (and cancel a pending respawn, so a
  // retry can't spawn a helper on the way out) and close its popup windows.
  try { _cancelHotkeyRetry(); _stopHotkeyListener(); } catch {}
  try { _widgetKeys.stop(); } catch {}
  for (const pid of _spotlightPopupPids) { try { process.kill(pid); } catch {} }
  _spotlightPopupPids.clear();
  // Close any Virtual Deck popup windows we spawned — they have no job object,
  // so process.exit would orphan them on a dead server.
  for (const pid of _deckPopupPids) { try { process.kill(pid); } catch {} }
  _deckPopupPids.clear();
  // Close the HTTP server; exit once all remaining connections drain AND the
  // lighting flush (if one was pending) has reached the disk.
  server.close(() => { shutdownFlush.then(() => process.exit(0)); });
  // Safety: force-exit after 3 s if some connection or write refuses to finish.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT',  _gracefulShutdown);
process.on('SIGTERM', _gracefulShutdown);
