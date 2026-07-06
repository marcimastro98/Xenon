'use strict';

const SETTINGS_STORAGE_KEY = 'xeneonedge.settings.v1';
const SETTINGS_MAX_BACKGROUND_BYTES = 200 * 1024 * 1024;
const SETTINGS_MIN_PANEL_ALPHA = 0.18;
const SETTINGS_BACKGROUND_TYPES = Object.freeze(new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm',
]));
const SETTINGS_BACKGROUND_EXTENSIONS = Object.freeze(new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm']));

const DASHBOARD_WIDGET_IDS = Object.freeze(['media', 'agenda', 'mic', 'audio', 'system', 'notes', 'tasks', 'calendar', 'timer', 'chat', 'deck', 'remote', 'twitch', 'obs', 'youtube', 'discord', 'spotify', 'browser', 'secondscreen', 'weather', 'smarthome', 'streamerbot', 'notifications', 'stocks', 'football', 'news', 'claude', 'vitals', 'custom']);
// Selectable stock-data providers + chart ranges (mirrors server/stocks.js).
const STOCK_PROVIDER_IDS = Object.freeze(['auto', 'yahoo', 'twelvedata', 'finnhub']);
const STOCK_RANGE_IDS = Object.freeze(['1d', '1w', '1m', '1y']);
const TICKER_POSITIONS = Object.freeze(['bottom', 'top']);
// Selectable weather data providers + the standalone-tile sections. Declared up
// here so they're initialized before hubSettings is normalized at module load
// (a mid-file const would hit a TDZ ReferenceError during that normalization).
const WEATHER_PROVIDER_IDS = Object.freeze(['auto', 'open-meteo', 'metno', 'wttr']);
// How often (minutes) the client re-fetches the weather. 10 min is the floor:
// the server caches provider responses for ~10 min, so polling faster than that
// only re-reads the cache without fresher data (and would pester the free APIs).
const WEATHER_REFRESH_CHOICES = Object.freeze([10, 15, 30, 60, 120, 180]);
const WEATHER_TILE_SECTIONS = Object.freeze(['metrics', 'hourly', 'forecast']);
// Individually toggleable weather fields: the 3 hero chips + the 8 detail
// metrics. Hiding one removes it from both the dashboard tile and the modal.
const WEATHER_FIELD_IDS = Object.freeze([
  'feels', 'wind', 'rain',
  'aqi', 'humidity', 'pm25', 'pm10', 'no2', 'pollen', 'pressure', 'visibility', 'uv', 'clouds',
]);
const WEATHER_FIELDS_ALL_ON = Object.freeze(
  WEATHER_FIELD_IDS.reduce((acc, id) => { acc[id] = true; return acc; }, {}),
);
// Vitals — game-style self-care meters (widget + topbar chips + reminders).
// Declared up here for the same TDZ reason as the weather constants above.
const VITALS_IDS = Object.freeze(['hydration', 'energy', 'stamina', 'focus', 'posture']);
const VITALS_DEFAULT_MIN = Object.freeze({ hydration: 45, energy: 180, stamina: 60, focus: 25, posture: 45 });
const VITALS_DEFAULT_ON = Object.freeze({ hydration: true, energy: true, stamina: true, focus: true, posture: false });
const DASHBOARD_PAGE_IDS = Object.freeze(['dashboard']);
const DASHBOARD_TAB_IDS = Object.freeze(['main', 'net']);
const CALENDAR_TAB_IDS = Object.freeze(['calendar', 'tasks']);
const MEDIA_VIEW_IDS = Object.freeze(['media', 'calendar']);
const DASHBOARD_CARD_IDS = Object.freeze({
  main: ['cpu', 'gpu', 'ram', 'disk'],
  net: ['ping', 'fps', 'latency', 'bandwidth'],
  audio: ['volume', 'speaker', 'microphone'],
  twitch: ['info', 'actions', 'chat'],
  obs: ['preview', 'controls', 'scenes'],
  youtube: ['info', 'actions'],
});
const DASHBOARD_WIDGET_SIZES = Object.freeze(['compact', 'normal', 'wide', 'tall', 'large', 'full']);
const DASHBOARD_CARD_SIZES = Object.freeze(['compact', 'normal', 'wide']);
// 24 columns (with half-height rows) = fine-grained, near-free tile placement.
// Layouts saved on the old 12-column grid are scaled ×2 once — keyed on
// layout.gridCols, see scaleDashboardLayoutUnits — so nothing moves on upgrade.
const DASHBOARD_GRID_COLUMNS = 24;     // GridStack column count
const DASHBOARD_GRID_MAX_ROW = 400;    // generous clamp for y/h
// Bump when the default dashboard layout changes in a way that should override
// users' saved layouts on upgrade. v5 = copies (duplicated widget placements).
// CAREFUL: the 12→24-column unit migration (scaleDashboardLayoutUnits) relies
// on this NOT being bumped — a bump resets saved layouts to default BEFORE the
// ×2 scaler ever runs, wiping user layouts instead of migrating them. Never
// use this constant as the grid-units fence.
const DASHBOARD_LAYOUT_VERSION = 6;
const DEFAULT_DASHBOARD_LAYOUT = Object.freeze({
  gridCols: 24,   // geometry units flag — layouts without it are 12-column
  widgets: Object.freeze({
    media:    Object.freeze({ x: 0, y: 0, w: 8, h: 8, visible: true,  page: 'dashboard' }),
    agenda:   Object.freeze({ x: 8, y: 0, w: 8, h: 8, visible: true,  page: 'dashboard' }),
    system:   Object.freeze({ x: 16, y: 0, w: 8, h: 8, visible: true,  page: 'dashboard' }),
    mic:      Object.freeze({ x: 0, y: 8, w: 6, h: 4, visible: false, page: 'dashboard' }),
    audio:    Object.freeze({ x: 6, y: 8, w: 6, h: 4, visible: false, page: 'dashboard' }),
    notes:    Object.freeze({ x: 12, y: 8, w: 6, h: 4, visible: false, page: 'dashboard' }),
    tasks:    Object.freeze({ x: 18, y: 8, w: 6, h: 4, visible: false, page: 'dashboard' }),
    calendar: Object.freeze({ x: 0, y: 12, w: 6, h: 4, visible: false, page: 'dashboard' }),
    timer:    Object.freeze({ x: 6, y: 12, w: 6, h: 4, visible: false, page: 'dashboard' }),
    chat:     Object.freeze({ x: 8, y: 0, w: 8, h: 8, visible: true,  page: 'dashboard' }),
    deck:     Object.freeze({ x: 0, y: 12, w: 8, h: 6, visible: false, page: 'dashboard' }),
    remote:   Object.freeze({ x: 8, y: 12, w: 8, h: 6, visible: false, page: 'dashboard' }),
    twitch:   Object.freeze({ x: 16, y: 12, w: 8, h: 4, visible: false, page: 'dashboard' }),
    obs:      Object.freeze({ x: 16, y: 16, w: 8, h: 6, visible: false, page: 'dashboard' }),
    youtube:  Object.freeze({ x: 16, y: 22, w: 8, h: 4, visible: false, page: 'dashboard' }),
    discord:  Object.freeze({ x: 16, y: 26, w: 8, h: 8, visible: false, page: 'dashboard' }),
    spotify:  Object.freeze({ x: 16, y: 34, w: 8, h: 16, visible: false, page: 'dashboard' }),
    browser:  Object.freeze({ x: 0, y: 18, w: 12, h: 10, visible: false, page: 'dashboard' }),
    secondscreen: Object.freeze({ x: 12, y: 18, w: 12, h: 10, visible: false, page: 'dashboard' }),
    weather:  Object.freeze({ x: 16, y: 8, w: 8, h: 8, visible: false, page: 'dashboard' }),
    smarthome: Object.freeze({ x: 0, y: 18, w: 8, h: 8, visible: false, page: 'dashboard' }),
    streamerbot: Object.freeze({ x: 8, y: 18, w: 8, h: 10, visible: false, page: 'dashboard' }),
    notifications: Object.freeze({ x: 16, y: 18, w: 8, h: 10, visible: false, page: 'dashboard' }),
    stocks:   Object.freeze({ x: 0, y: 28, w: 8, h: 10, visible: false, page: 'dashboard' }),
    football: Object.freeze({ x: 8, y: 28, w: 8, h: 10, visible: false, page: 'dashboard' }),
    news:     Object.freeze({ x: 0, y: 38, w: 8, h: 10, visible: false, page: 'dashboard' }),
    claude:   Object.freeze({ x: 16, y: 28, w: 8, h: 10, visible: false, page: 'dashboard' }),
    vitals:   Object.freeze({ x: 8, y: 38, w: 8, h: 8, visible: false, page: 'dashboard' }),
    custom:   Object.freeze({ x: 0, y: 28, w: 8, h: 8, visible: false, page: 'dashboard' }),
  }),
  groups: Object.freeze({
    'media-group': Object.freeze({ id: 'media-group', members: Object.freeze(['media', 'chat']), active: 'media', x: 0, y: 0, w: 8, h: 8, page: 'dashboard', seeded: true, autoTabByMedia: true }),
  }),
  pages: Object.freeze([
    Object.freeze({ id: 'dashboard', name: '', nameKey: 'page_dashboard' }),
  ]),
  cards: Object.freeze({
    main: Object.freeze({
      cpu: Object.freeze({ order: 0, size: 'normal', visible: true }),
      gpu: Object.freeze({ order: 1, size: 'normal', visible: true }),
      ram: Object.freeze({ order: 2, size: 'normal', visible: true }),
      disk: Object.freeze({ order: 3, size: 'normal', visible: true }),
    }),
    net: Object.freeze({
      ping: Object.freeze({ order: 0, size: 'normal', visible: true }),
      fps: Object.freeze({ order: 1, size: 'normal', visible: true }),
      latency: Object.freeze({ order: 2, size: 'normal', visible: true }),
      bandwidth: Object.freeze({ order: 3, size: 'normal', visible: true }),
    }),
    audio: Object.freeze({
      volume: Object.freeze({ order: 0, size: 'wide', visible: true }),
      speaker: Object.freeze({ order: 1, size: 'normal', visible: true }),
      microphone: Object.freeze({ order: 2, size: 'normal', visible: true }),
    }),
    twitch: Object.freeze({
      info: Object.freeze({ order: 0, size: 'normal', visible: true }),
      actions: Object.freeze({ order: 1, size: 'normal', visible: true }),
      chat: Object.freeze({ order: 2, size: 'normal', visible: true }),
    }),
    obs: Object.freeze({
      preview: Object.freeze({ order: 0, size: 'normal', visible: true }),
      controls: Object.freeze({ order: 1, size: 'normal', visible: true }),
      scenes: Object.freeze({ order: 2, size: 'normal', visible: true }),
    }),
    youtube: Object.freeze({
      info: Object.freeze({ order: 0, size: 'normal', visible: true }),
      actions: Object.freeze({ order: 1, size: 'normal', visible: true }),
    }),
  }),
  tabs: Object.freeze({ order: ['main', 'net'], active: 'main' }),
  calendarTabs: Object.freeze({ order: ['calendar', 'tasks'], active: 'calendar' }),
  mediaView: Object.freeze({ active: 'media' }),
  // When true the top bar (clock, quick actions, Layout/Settings/App) is hidden,
  // freeing the full surface for widgets. A floating Layout button re-opens the
  // editor (which temporarily reveals the bar) so the user can never get stuck.
  topbarHidden: false,
});

// The activities Performance Mode can detect and react to. One list, used by
// the normalizers, the settings toggles, and the trigger-app editor. Declared
// before DEFAULT_HUB_SETTINGS: hubSettings is normalized at module load.
const PERF_ACTIVITIES = ['gaming', 'coding', 'writing', 'streaming', 'creating', 'meeting'];

// Lighting effects a context profile can apply (a subset of the ambient-animation
// styles). '' in a profile means "don't touch lighting"; 'none' turns it off.
const CONTEXT_LIGHTING_STYLES = ['none', 'solid', 'breathing', 'cycle'];

const DEFAULT_HUB_SETTINGS = Object.freeze({
  appearance: 'dark', // 'light' | 'dark' | 'auto' (auto follows the OS colour scheme)
  // Dashboard style language. 'glass' = the Liquid Glass default; 'retro' swaps
  // the whole dashboard to the opt-in Pixel Retro-gaming skin (themes-retro.css,
  // keyed off :root[data-style="retro"]). Scanlines are a retro-only sub-toggle.
  styleMode: 'glass', // 'glass' | 'retro'
  retroScanlines: true,
  // 'full' keeps the classic glass bar; 'minimal' docks the quick actions into
  // collapsible edge rails and shrinks clock/date/weather/page-dots into one
  // compact island pill (see js/topbar-minimal.js).
  topbarStyle: 'full', // 'full' | 'minimal'
  // Minimal-mode edge-rail drawer positions (true = collapsed). Server-synced (not
  // browser-local) so the kiosk remembers the choice across launches / storage
  // resets; both default closed so the rails never open on their own.
  topbarRails: { left: true, right: true },
  clockFormat: 'auto', // 'auto' | '12' | '24' — auto follows the UI language (en → 12h)
  weekStart: 'mon', // 'mon' | 'sun' — calendar first day of week
  swipeNavigation: true, // drag / finger-swipe to change dashboard page (touchscreen-friendly)
  accent: '#1ed760',
  dynamicAlbumTheme: true, // tint the accent from the now-playing album art
  background: '#070808',
  text: '#f0f3f1',
  panelAlpha: 0.94,
  bgDim: 0.48,
  bgBlur: 0,
  backgroundMedia: null,
  lockWidgets: Object.freeze({ clock: true, weather: true, media: true, calendar: true }),
  weather: Object.freeze({
    mode: 'auto', city: '', provider: 'auto',
    refreshMin: 30, // how often (minutes) the client re-fetches weather
    // Which extra sections the standalone Weather tile shows below the hero card
    // (the topbar chip + modal are unaffected). All on by default. `fields`
    // toggles individual detail chips/metrics and applies to the tile AND modal.
    tile: Object.freeze({ metrics: true, hourly: true, forecast: true, fields: WEATHER_FIELDS_ALL_ON }),
  }),
  tempUnit: 'c', // 'c' | 'f' — weather temperature display unit
  // Open the dashboard in the default browser at Windows logon (default on).
  // Only reconciled into a real scheduled task from a standalone browser view —
  // never from inside the Xeneon Edge iframe (see reconcileAutoOpenBrowser).
  autoOpenBrowser: true,
  // Opt-in ad-blocker for the Browser tile (Settings → Browser). OFF by default.
  browserAdblock: false,
  // Stock-market (Borsa) widget + ticker. Keys are server-only (redacted); the
  // client keeps only the `*Set` placeholder flags.
  stocks: Object.freeze({
    watchlist: Object.freeze([
      Object.freeze({ symbol: 'FTSEMIB.MI', name: 'FTSE MIB' }),
      Object.freeze({ symbol: '^GSPC', name: 'S&P 500' }),
      Object.freeze({ symbol: 'AAPL', name: 'Apple' }),
      Object.freeze({ symbol: 'BTC-EUR', name: 'Bitcoin' }),
    ]),
    provider: 'auto', refreshSec: 60, alertPercent: 2,
    tile: Object.freeze({ chart: true, sparklines: true }),
  }),
  twelveDataKey: '', twelveDataKeySet: false,
  finnhubKey: '', finnhubKeySet: false,
  // Football (Calcio) widget + ticker. The TheSportsDB Premium key is server-only
  // (redacted); the client keeps only the `*Set` placeholder flag.
  football: Object.freeze({
    teams: Object.freeze([
      Object.freeze({ id: '133670', name: 'Napoli', league: 'Italian Serie A', leagueId: '4332' }),
      Object.freeze({ id: '133681', name: 'Inter Milan', league: 'Italian Serie A', leagueId: '4332' }),
      Object.freeze({ id: '133682', name: 'Roma', league: 'Italian Serie A', leagueId: '4332' }),
      Object.freeze({ id: '4480', type: 'league', name: 'UEFA Champions League', league: 'UEFA Champions League' }),
    ]),
    refreshSec: 120, alerts: true,
    tile: Object.freeze({ results: true, standings: true }),
  }),
  sportsDbKey: '', sportsDbKeySet: false,
  // News widget + ticker. The NewsData.io key is server-only (redacted); the
  // client keeps only the `*Set` placeholder flag.
  news: Object.freeze({
    feeds: Object.freeze([
      Object.freeze({ id: 'ansa', type: 'source', name: 'ANSA' }),
      Object.freeze({ id: 'bbc', type: 'source', name: 'BBC News' }),
      Object.freeze({ id: 'tech', type: 'topic', name: 'Tecnologia', query: 'tecnologia' }),
    ]),
    refreshSec: 600,
    tile: Object.freeze({ images: true }),
  }),
  newsDataKey: '', newsDataKeySet: false,
  // Scrolling ticker bar (news/stocks/football). OFF by default; bottom edge.
  ticker: Object.freeze({ enabled: false, position: 'bottom', speed: 50, sources: Object.freeze({ stocks: true, football: true, news: true }) }),
  dashboardLayout: DEFAULT_DASHBOARD_LAYOUT,
  dashboardLayoutVersion: DASHBOARD_LAYOUT_VERSION,
  dashboardPresets: Object.freeze([]), // saved widget/tab-group/page templates
  geminiApiKey: '',
  aiProvider: 'gemini', // 'gemini' | 'ollama' — selected AI backend
  ollamaModel: 'auto',  // 'auto' | whitelist key | custom model tag
  ollamaUrl: 'http://localhost:11434',
  hardwareScan: null,   // server-generated hardware probe; mirrored back as-is
  aiTtsEnabled: true,
  aiMicSensitivity: 50, // 0..100 — wake-word mic sensitivity slider (lower = stricter, fewer false positives)
  aiChatHidden: false, // user hid the AI chat tab in the Media tile
  aiMemory: true, // persistent AI memory — Xenon remembers durable facts about the user across sessions
  aiProReasoning: false, // advanced reasoning — route text chat turns to the stronger model
  aiLiveVoice: false, // Voce Live (beta) — full-duplex realtime voice via Gemini Live (off by default)
  // Advanced AI features. ALL OFF by default — each one is an explicit opt-in
  // because they consume AI quota (Gemini) or compute (local provider).
  // `enabled` is the master switch: when false every feature below is inert
  // regardless of its own toggle.
  aiFeatures: Object.freeze({
    enabled: false,       // master switch for all advanced AI features
    genesis: false,       // Genesis — AI composes dashboard pages on request
    gameCompanion: false, // Game Companion — AI watches the game screen for live insights
    guardian: false,      // Guardian — hardware history + AI health analysis
    ambient: false,       // Ambient presence — proactive spoken/visual moments
    pcControl: false,     // PC Control — AI runs confirmed Windows commands (consent-gated)
  }),
  // Local sensor history (Settings → Performance). OFF by default; independent of
  // the AI Guardian feature — when on, the server records CPU/GPU load+temp and
  // RAM over time for the history charts, with or without any AI. Never leaves the PC.
  sensorHistory: Object.freeze({ enabled: false }),
  // Proactive moments (Settings → Performance). Deterministic and bounded:
  // sustained-thermal alerts, game-session recaps, morning agenda in the
  // greeting splash. Each individually toggleable, default ON.
  proactive: Object.freeze({ thermal: true, recap: true, morning: true, anomaly: true }),
  // Master notifications switch (Settings → Notifiche). `enabled` (default ON) is
  // the global gate — off silences every source and stops the background watchers.
  // `popups` (default ON) keeps the feeds but suppresses on-screen toasts.
  notifications: Object.freeze({ enabled: true, popups: true }),
  // Vitals (Settings → Notifiche → Vitals). Game-style self-care meters that
  // drain with time at the PC; tap to refill. Master ON (the widget is still
  // hidden until added from the "+" palette); topbar chips are an opt-in.
  vitals: Object.freeze({
    enabled: true, topbar: false, reminders: true,
    items: Object.freeze({
      hydration: Object.freeze({ on: true, min: 45 }),
      energy: Object.freeze({ on: true, min: 180 }),
      stamina: Object.freeze({ on: true, min: 60 }),
      focus: Object.freeze({ on: true, min: 25 }),
      posture: Object.freeze({ on: false, min: 45 }),
    }),
    state: Object.freeze({ last: Object.freeze({}), xp: 0, day: '', fills: 0 }),
  }),
  // Discord notification mirroring (Settings → Streaming → Discord). OFF by
  // default (privacy); enabling needs a one-time Discord re-link for the extra
  // notifications scope. `hide` masks each notification's text until tapped.
  discordNotifications: Object.freeze({ enabled: false, hide: false }),
  // Windows notification mirroring (the Notifications tile). OFF by default
  // (privacy) — read locally via the native helper / PowerShell fallback,
  // nothing leaves the PC. `hide` masks each notification's text until tapped;
  // `excluded` is the per-app mute list ({id: AUMID-or-name, name: display}).
  windowsNotifications: Object.freeze({ enabled: false, hide: false, toast: true, excluded: Object.freeze([]) }),
  // Local "Hey Xenon" wake word. OFF by default (privacy) — when on, the server
  // listens to the microphone locally (ffmpeg + whisper.cpp) while a dashboard
  // is open; audio never leaves the PC and candidate clips are never stored.
  wakeWord: Object.freeze({ enabled: false }),
  // Third-party widget SDK (the Custom widget tile). OFF by default — community
  // packages run in a sandboxed, network-less iframe and each one gets an
  // explicit per-package permission grant (data streams + action categories)
  // before it renders. `assign` maps a tile instance id → package id.
  sdkWidgets: Object.freeze({ enabled: false, assign: Object.freeze({}), grants: Object.freeze({}) }),
  // Background FX (all 0..100 unless noted). Aurora = soft flowing accent
  // gradients behind the grid (only when no custom image/video bg). Grid =
  // a perspective neon grid scrolling toward a glowing horizon.
  bgAurora: Object.freeze({ enabled: true, intensity: 55, speed: 50 }),
  bgGrid: Object.freeze({ enabled: true, color: '#1ed760', intensity: 45, speed: 50 }),
  gameMode: true, // auto-pause ambient FX while a game / intensive app is running
  // Performance Mode (opt-in, off by default). Broader than gameMode: a
  // user-triggered / suggested profile that pauses dashboard animations and
  // applies reversible system tweaks (power plan) with confirmation. See
  // docs/superpowers/specs/performance-mode.md.
  // (PERF_ACTIVITIES below must stay above the first normalizeSettings call —
  // hubSettings is initialized at module load.)
  // Smart context profiles: per-activity page/lighting/deck/style that auto-apply
  // when the foreground activity changes and revert when it ends
  // (context-profiles.js). Off by default; empty entry = "don't touch that
  // dimension". `style` switches the whole dashboard look (glass/retro) — e.g.
  // Pixel Retro while gaming — through the same styleMode the Appearance page uses.
  contextProfiles: Object.freeze({
    enabled: false,
    revertOnExit: true,
    map: Object.freeze({
      gaming: Object.freeze({ page: '', lighting: '', deck: '', style: '' }),
      coding: Object.freeze({ page: '', lighting: '', deck: '', style: '' }),
      writing: Object.freeze({ page: '', lighting: '', deck: '', style: '' }),
      streaming: Object.freeze({ page: '', lighting: '', deck: '', style: '' }),
      creating: Object.freeze({ page: '', lighting: '', deck: '', style: '' }),
      meeting: Object.freeze({ page: '', lighting: '', deck: '', style: '' }),
    }),
  }),
  performance: Object.freeze({
    enabled: false,        // master opt-in
    autoSuggest: true,     // show a banner when a tracked activity is detected
    // 'suggest' shows the banner + confirmation sheet; 'auto' applies the safe,
    // reversible tweaks (animations, power plan, priority) by itself when an
    // enabled activity starts and restores them when it ends. App closing is
    // NEVER automatic — it always goes through the sheet.
    autoMode: 'suggest',
    // Which detected activities trigger the auto-suggest banner. Gaming only by
    // default — the others are opt-in so the suggestion never nags during
    // normal desk work unless the user wants it.
    autoActivities: Object.freeze({ gaming: true, coding: false, writing: false, streaming: false, creating: false, meeting: false }),
    useAi: true,           // let Xenon AI drive the decisions (when a provider is configured)
    active: false,         // runtime: an optimization session is currently applied
    activatedBy: '',       // runtime: '' | 'manual' | 'auto' — auto sessions auto-restore
    autoActivity: '',      // runtime: the activity that auto-applied the session
    savedPowerPlan: '',    // GUID of the user's power plan before we switched (for restore)
    closedApps: [],        // runtime: apps we closed this session, for one-tap reopen
    // Learning: per-app keep/close counters from the user's sheet choices, used
    // to bias future preselection toward what this user actually does.
    appChoices: Object.freeze({}),
    // runtime: what was actually applied this session (the sheet lets the user
    // pick per-run, so this can differ from `opts`). Drives restore + perf-mode.
    applied: Object.freeze({ pauseAnimations: false, powerPlan: 'none', boostedProc: '' }),
    opts: Object.freeze({
      pauseAnimations: true, // pause dashboard animations + background FX (reversible)
      powerPlan: 'high',     // 'none' | 'high' | 'ultimate' — Windows power scheme to apply
      manageApps: false,     // offer to close chosen background apps (opt-in, high-touch)
      priorityBoost: false,  // nudge the active app's process priority up (reversible)
      pauseStreams: true,    // pause heavy live tiles (Browser, future second screen) while gaming/optimizing
    }),
    // User customization of the per-activity trigger app lists, relative to the
    // built-in defaults: `add` extends, `remove` drops a default. Process names,
    // lowercase, no extension.
    activityApps: Object.freeze({
      gaming:  Object.freeze({ add: [], remove: [] }),
      coding:  Object.freeze({ add: [], remove: [] }),
      writing: Object.freeze({ add: [], remove: [] }),
    }),
  }),
  lighting: Object.freeze({
    enabled: false,            // master OFF by default — explicit opt-in
    brightness: 1.0,
    pauseDuringGame: true,
    devices: {},               // deviceId → bool opt-in
    // All OFF by default — each effect is opt-in and independent of the master.
    effects: Object.freeze({
      temperature: false,
      volume: false,
      musicAlbum: false,
      timer:        Object.freeze({ enabled: false, color: '#ff0000', style: 'blink', durationMs: 1800 }),
      notification: Object.freeze({ enabled: false, color: '#ff0000', style: 'blink', durationMs: 1800 }),
      reminder:     Object.freeze({ enabled: false, color: '#ff0000', style: 'blink', durationMs: 1800 }),
    }),
    animation: Object.freeze({ style: 'none', color: '#1ed760', speed: 50, palette: Object.freeze(['#1ed760', '#0066ff']) }),
    manualColor: '',
    providers: Object.freeze({}),
    deviceModes: Object.freeze({}),
  }),
  obsHost: '',
  obsAutoLaunch: true,
  obsPort: 4455,
  // obsPassword / streamerbotPassword are server-only secrets: redacted on the
  // wire, restored on save. The client copy is always '' and the server surfaces
  // an `*Set` flag so the UI can show a "saved" placeholder (like homeAssistant).
  obsPassword: '',
  obsPasswordSet: false,
  streamerbotHost: '',
  streamerbotPort: 8080,
  streamerbotPassword: '',
  streamerbotPasswordSet: false,
  // Home Assistant Smart Home bridge. url/entities are client-managed; `token` is
  // a server-only secret (redacted on the wire, restored on save), so the client
  // copy is always '' and the server surfaces a `tokenSet` flag for the UI.
  homeAssistant: Object.freeze({ url: '', token: '', entities: Object.freeze([]), tokenSet: false }),
  // First-run tutorial state. `seenVersion` is the ONBOARDING_VERSION the user
  // last finished/skipped; 0 = never seen, so the tour shows once. Persisted in
  // settings (not just localStorage) so a Xeneon Edge WebView storage wipe can't
  // make the tutorial reappear on every boot.
  onboarding: Object.freeze({ seenVersion: 0 }),
  language: '', // '' means "use browser language or 'en'"; set to a SUPPORTED_LANGS code to persist across browser resets
  // Second-screen capture preferences (client-owned). fps/quality tune the live
  // stream; width/height is the virtual display mode applied via create-display.
  secondScreen: Object.freeze({ fps: 15, quality: 55, width: 1920, height: 1080, fit: 'contain', touchControl: false }),
});

const SETTINGS_PRESETS = Object.freeze([
  { id: 'xenon',   nameKey: 'settings_preset_xenon',   accent: '#1ed760', background: '#070808', text: '#f0f3f1' },
  { id: 'ocean',   nameKey: 'settings_preset_ocean',   accent: '#46c7e8', background: '#050a12', text: '#eefaff' },
  { id: 'ember',   nameKey: 'settings_preset_ember',   accent: '#ff8a3d', background: '#100807', text: '#fff4ee' },
  { id: 'violet',  nameKey: 'settings_preset_violet',  accent: '#a78bfa', background: '#090712', text: '#f7f2ff' },
  { id: 'mono',    nameKey: 'settings_preset_mono',    accent: '#f0f3f1', background: '#000000', text: '#f7f7f2' },
]);

// Declared before loadHubSettings() runs: normalizeLighting() reads it at module
// init, so it must not be in the temporal dead zone when settings hydrate.
const LIGHTING_STYLES = ['blink', 'pulse', 'solid'];

let hubSettings = loadHubSettings();
let settingsStatusTimer = null;
let settingsServerSaveTimer = null;
let weatherSettingsFetchTimer = null;

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeHex(value, fallback) {
  const raw = String(value || '').trim();
  const short = raw.match(/^#?([0-9a-f]{3})$/i);
  if (short) {
    return '#' + short[1].split('').map(ch => ch + ch).join('').toLowerCase();
  }
  const full = raw.match(/^#?([0-9a-f]{6})$/i);
  return full ? '#' + full[1].toLowerCase() : fallback;
}

function hexToRgb(hex) {
  const safe = normalizeHex(hex, DEFAULT_HUB_SETTINGS.accent).slice(1);
  return [0, 2, 4].map(index => parseInt(safe.slice(index, index + 2), 16));
}

function sanitizeBackgroundMedia(value) {
  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || '').trim();
  const name = String(value.name || '').trim().slice(0, 120);
  const type = String(value.type || '').trim().slice(0, 60);
  const version = String(value.version || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  if (!url.startsWith('/uploads/')) return null;
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return null;
  if (!/^(image|video)\//.test(type)) return null;
  return { url, name: name || url.split('/').pop(), type, version };
}

function normalizeLockWidgets(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.lockWidgets;
  return {
    clock: source.clock !== undefined ? !!source.clock : defaults.clock,
    weather: source.weather !== undefined ? !!source.weather : defaults.weather,
    media: source.media !== undefined ? !!source.media : defaults.media,
    calendar: source.calendar !== undefined ? !!source.calendar : defaults.calendar,
  };
}

function sanitizeWeatherCity(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>`"'\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normalizeWeatherTile(value) {
  const src = value && typeof value === 'object' ? value : {};
  const def = DEFAULT_HUB_SETTINGS.weather.tile;
  const out = {};
  WEATHER_TILE_SECTIONS.forEach(k => { out[k] = typeof src[k] === 'boolean' ? src[k] : def[k]; });
  const srcFields = src.fields && typeof src.fields === 'object' ? src.fields : {};
  const fields = {};
  WEATHER_FIELD_IDS.forEach(id => { fields[id] = typeof srcFields[id] === 'boolean' ? srcFields[id] : true; });
  out.fields = fields;
  return out;
}
function normalizeWeatherSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = source.mode === 'manual' ? 'manual' : DEFAULT_HUB_SETTINGS.weather.mode;
  const provider = WEATHER_PROVIDER_IDS.includes(source.provider) ? source.provider : DEFAULT_HUB_SETTINGS.weather.provider;
  const refreshMin = WEATHER_REFRESH_CHOICES.includes(Number(source.refreshMin))
    ? Number(source.refreshMin) : DEFAULT_HUB_SETTINGS.weather.refreshMin;
  return {
    mode,
    city: sanitizeWeatherCity(source.city),
    provider,
    refreshMin,
    tile: normalizeWeatherTile(source.tile),
  };
}

function normalizeBgAurora(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.bgAurora;
  return {
    enabled: source.enabled !== false,
    intensity: clampNumber(source.intensity, 0, 100, defaults.intensity),
    speed: clampNumber(source.speed, 0, 100, defaults.speed),
  };
}

function normalizeBgGrid(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.bgGrid;
  return {
    enabled: source.enabled !== false,
    color: normalizeHex(source.color, defaults.color),
    intensity: clampNumber(source.intensity, 0, 100, defaults.intensity),
    speed: clampNumber(source.speed, 0, 100, defaults.speed),
  };
}

function cloneDashboardLayout(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeDashboardOrder(value, fallback, maxOrder) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return fallback;
  return Math.max(0, Math.min(maxOrder, numeric));
}

function normalizeDashboardSize(value, allowedSizes, fallback) {
  return allowedSizes.includes(value) ? value : fallback;
}

// Grid geometry for a widget (drag&drop model): {x,y,w,h,visible} in cells.
function normalizeDashboardGeom(sourceItem, fallbackItem) {
  const s = sourceItem && typeof sourceItem === 'object' ? sourceItem : {};
  const intIn = (v, min, max, fb) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fb; };
  return {
    x: intIn(s.x, 0, DASHBOARD_GRID_COLUMNS - 1, fallbackItem.x),
    y: intIn(s.y, 0, DASHBOARD_GRID_MAX_ROW, fallbackItem.y),
    w: intIn(s.w, 1, DASHBOARD_GRID_COLUMNS, fallbackItem.w),
    h: intIn(s.h, 1, DASHBOARD_GRID_MAX_ROW, fallbackItem.h),
    visible: s.visible === undefined ? fallbackItem.visible : s.visible !== false,
  };
}

function normalizeDashboardItem(sourceItem, fallbackItem, maxOrder, allowedSizes) {
  const source = sourceItem && typeof sourceItem === 'object' ? sourceItem : {};
  return {
    order: normalizeDashboardOrder(source.order, fallbackItem.order, maxOrder),
    size: normalizeDashboardSize(source.size, allowedSizes, fallbackItem.size),
    visible: source.visible === undefined ? fallbackItem.visible : source.visible !== false,
  };
}

function sortDashboardIds(collection) {
  return Object.keys(collection).sort((left, right) => {
    const diff = collection[left].order - collection[right].order;
    return diff || left.localeCompare(right);
  });
}

function reindexDashboardCollection(collection) {
  sortDashboardIds(collection).forEach((id, index) => { collection[id].order = index; });
}

function normalizeCalendarTabs(source) {
  const src = source && typeof source === 'object' ? source : {};
  const srcOrder = Array.isArray(src.order) ? src.order : DEFAULT_DASHBOARD_LAYOUT.calendarTabs.order;
  const order = srcOrder.filter(t => CALENDAR_TAB_IDS.includes(t));
  CALENDAR_TAB_IDS.forEach(t => { if (!order.includes(t)) order.push(t); });
  return {
    order,
    active: ['calendar', 'tasks', 'timer', 'notes'].includes(src.active) ? src.active : DEFAULT_DASHBOARD_LAYOUT.calendarTabs.active,
  };
}

function normalizeMediaView(source) {
  const src = source && typeof source === 'object' ? source : {};
  return {
    active: MEDIA_VIEW_IDS.includes(src.active) ? src.active : DEFAULT_DASHBOARD_LAYOUT.mediaView.active,
  };
}

// NB: the page cap (8) is inlined here; the named DASHBOARD_PAGES_MAX const
// lives in dashboard-pages.js — declaring it here too would redeclare it in the
// shared browser global scope and break that script.
function normalizeDashboardPages(value) {
  const seed = cloneDashboardLayout(DEFAULT_DASHBOARD_LAYOUT.pages);
  if (!Array.isArray(value)) return seed;
  const out = [];
  const seen = new Set();
  value.forEach(p => {
    if (!p || typeof p !== 'object') return;
    const id = String(p.id || '').trim().slice(0, 64);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const page = { id, name: String(p.name == null ? '' : p.name).trim().slice(0, 40) };
    if (p.nameKey) page.nameKey = String(p.nameKey).slice(0, 64);
    out.push(page);
  });
  return out.length ? out.slice(0, 8) : seed;
}

function normalizeDashboardGroups(value, widgets, pageIds, copies) {
  const copyIds = new Set((Array.isArray(copies) ? copies : []).map(c => c.id));
  const isInstance = (m) => (widgets && widgets[m]) || copyIds.has(m);
  const out = {};
  const src = value && typeof value === 'object' ? value : {};
  const used = new Set();
  Object.keys(src).forEach(gid => {
    const g = src[gid] && typeof src[gid] === 'object' ? src[gid] : {};
    let members = Array.isArray(g.members) ? g.members.filter(m => isInstance(m) && !used.has(m)) : [];
    members = members.filter((m, i) => members.indexOf(m) === i);
    if (members.length < 2) return;            // a group needs ≥2 members
    members.forEach(m => used.add(m));
    const id = String(gid).slice(0, 64);
    out[id] = {
      id, members,
      active: members.includes(g.active) ? g.active : members[0],
      x: Math.max(0, Math.round(Number(g.x)) || 0),
      y: Math.max(0, Math.round(Number(g.y)) || 0),
      w: Math.max(1, Math.round(Number(g.w)) || 8),
      h: Math.max(1, Math.round(Number(g.h)) || 8),
      page: pageIds.includes(g.page) ? g.page : pageIds[0],
      seeded: g.seeded === true,
      autoTabByMedia: g.autoTabByMedia === true,
    };
  });
  return out;
}

function normalizeDashboardTabs(sourceTabs) {
  const source = sourceTabs && typeof sourceTabs === 'object' ? sourceTabs : {};
  const sourceOrder = Array.isArray(source.order) ? source.order : DEFAULT_DASHBOARD_LAYOUT.tabs.order;
  const order = sourceOrder.filter(tab => DASHBOARD_TAB_IDS.includes(tab));
  DASHBOARD_TAB_IDS.forEach(tab => { if (!order.includes(tab)) order.push(tab); });
  return {
    order,
    active: ['main', 'net', 'volume', 'mic'].includes(source.active) ? source.active : DEFAULT_DASHBOARD_LAYOUT.tabs.active,
  };
}

// One-time unit migration: layouts saved before the 24-column grid carry no
// gridCols flag and are in 12-column units — double every geometry (widgets,
// groups, copies) so each tile keeps its exact position and size on the finer
// grid. Idempotent: the flag is stamped on the normalized output, and until the
// layout is re-saved the scaling always re-derives from the raw 12-unit source.
// Mirrors the server normalizer (server.js) — keep both in sync. If the grid
// resolution ever changes again, branch on the STORED gridCols value (absent =
// 12-column) and derive the factor per source unit — never reuse this blanket ×2.
function scaleDashboardLayoutUnits(source) {
  if (Number(source.gridCols) === DASHBOARD_GRID_COLUMNS) return source;
  const scaleBox = (o) => {
    if (!o || typeof o !== 'object') return o;
    const out = Object.assign({}, o);
    ['x', 'y', 'w', 'h'].forEach(k => {
      const n = Number(out[k]);
      if (Number.isFinite(n)) out[k] = Math.round(n * 2);
    });
    return out;
  };
  const out = Object.assign({}, source);
  if (source.widgets && typeof source.widgets === 'object') {
    out.widgets = {};
    Object.keys(source.widgets).forEach(id => { out.widgets[id] = scaleBox(source.widgets[id]); });
  }
  if (source.groups && typeof source.groups === 'object') {
    out.groups = {};
    Object.keys(source.groups).forEach(id => { out.groups[id] = scaleBox(source.groups[id]); });
  }
  if (Array.isArray(source.copies)) out.copies = source.copies.map(scaleBox);
  return out;
}

function normalizeDashboardLayout(value) {
  const source = scaleDashboardLayoutUnits(value && typeof value === 'object' ? value : {});
  const layout = cloneDashboardLayout(DEFAULT_DASHBOARD_LAYOUT);
  const sourceWidgets = source.widgets && typeof source.widgets === 'object' ? source.widgets : {};

  DASHBOARD_WIDGET_IDS.forEach(widgetId => {
    const fb = DEFAULT_DASHBOARD_LAYOUT.widgets[widgetId];
    const geom = normalizeDashboardGeom(sourceWidgets[widgetId], fb);
    const srcPage = sourceWidgets[widgetId] && sourceWidgets[widgetId].page;
    // Keep ANY saved page id (incl. user-created pages); it's clamped to a real
    // page below against the actual page list. Validating here against the static
    // default ids would wrongly reset widgets added to a user page back to their
    // default page — making "+ add" land on the wrong page.
    geom.page = (typeof srcPage === 'string' && srcPage) ? srcPage : (fb.page || 'dashboard');
    layout.widgets[widgetId] = geom;
  });

  Object.keys(DASHBOARD_CARD_IDS).forEach(groupId => {
    const sourceCards = source.cards && source.cards[groupId] && typeof source.cards[groupId] === 'object'
      ? source.cards[groupId]
      : {};
    DASHBOARD_CARD_IDS[groupId].forEach(cardId => {
      layout.cards[groupId][cardId] = normalizeDashboardItem(
        sourceCards[cardId],
        DEFAULT_DASHBOARD_LAYOUT.cards[groupId][cardId],
        DASHBOARD_CARD_IDS[groupId].length - 1,
        DASHBOARD_CARD_SIZES,
      );
    });
    reindexDashboardCollection(layout.cards[groupId]);
  });

  layout.pages = normalizeDashboardPages(source.pages);
  const pageIds = layout.pages.map(p => p.id);
  const firstPage = pageIds[0];
  DASHBOARD_WIDGET_IDS.forEach(widgetId => {
    if (!pageIds.includes(layout.widgets[widgetId].page)) layout.widgets[widgetId].page = firstPage;
  });
  // Extra placements (duplicated widgets). Validated against known widgets/pages.
  layout.copies = (typeof DashboardInstances !== 'undefined')
    ? DashboardInstances.normalizeCopies(source.copies, layout.widgets, pageIds)
    : [];
  // Fall back to the seeded default groups when the source has none (e.g. reset,
  // or a pre-groups saved layout) — otherwise the welcome media-group is lost.
  layout.groups = normalizeDashboardGroups(
    source.groups !== undefined ? source.groups : DEFAULT_DASHBOARD_LAYOUT.groups,
    layout.widgets, pageIds, layout.copies);

  layout.tabs = normalizeDashboardTabs(source.tabs);
  layout.calendarTabs = normalizeCalendarTabs(source.calendarTabs);
  layout.mediaView = normalizeMediaView(source.mediaView);
  layout.topbarHidden = source.topbarHidden === true;
  layout.gridCols = DASHBOARD_GRID_COLUMNS;  // units flag — see scaleDashboardLayoutUnits
  return layout;
}

// Minimal-mode edge-rail drawer state (true = collapsed). Both sides default
// collapsed so a fresh state never opens them on its own; only an explicit
// `false` (a rail the user opened) re-opens it. Mirrors the server normalizer.
function normalizeTopbarRails(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { left: v.left !== false, right: v.right !== false };
}

function normalizeSettings(source) {
  const value = source && typeof source === 'object' ? source : {};
  // One-time migration: if the saved layout predates the current version,
  // force the new default layout (overrides the user's old saved layout on
  // upgrade) while preserving all other settings.
  const layoutVersion = Number(value.dashboardLayoutVersion) || 0;
  const resetLayout = layoutVersion < DASHBOARD_LAYOUT_VERSION;
  return {
    appearance: ['light', 'dark', 'auto'].includes(value.appearance) ? value.appearance : DEFAULT_HUB_SETTINGS.appearance,
    styleMode: value.styleMode === 'retro' ? 'retro' : 'glass',
    retroScanlines: value.retroScanlines !== false,
    topbarStyle: value.topbarStyle === 'minimal' ? 'minimal' : 'full',
    topbarRails: normalizeTopbarRails(value.topbarRails),
    clockFormat: ['auto', '12', '24'].includes(value.clockFormat) ? value.clockFormat : DEFAULT_HUB_SETTINGS.clockFormat,
    weekStart: ['mon', 'sun'].includes(value.weekStart) ? value.weekStart : DEFAULT_HUB_SETTINGS.weekStart,
    swipeNavigation: value.swipeNavigation !== false,
    accent: normalizeHex(value.accent, DEFAULT_HUB_SETTINGS.accent),
    dynamicAlbumTheme: value.dynamicAlbumTheme !== false,
    background: normalizeHex(value.background, DEFAULT_HUB_SETTINGS.background),
    text: normalizeHex(value.text, DEFAULT_HUB_SETTINGS.text),
    panelAlpha: clampNumber(value.panelAlpha, SETTINGS_MIN_PANEL_ALPHA, 1, DEFAULT_HUB_SETTINGS.panelAlpha),
    bgDim: clampNumber(value.bgDim, 0.05, 0.9, DEFAULT_HUB_SETTINGS.bgDim),
    bgBlur: clampNumber(value.bgBlur, 0, 24, DEFAULT_HUB_SETTINGS.bgBlur),
    backgroundMedia: sanitizeBackgroundMedia(value.backgroundMedia),
    lockWidgets: normalizeLockWidgets(value.lockWidgets),
    weather: normalizeWeatherSettings(value.weather),
    tempUnit: value.tempUnit === 'f' ? 'f' : 'c',
    autoOpenBrowser: value.autoOpenBrowser !== false,
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
    geminiApiKey: String(value.geminiApiKey || '').trim().slice(0, 200),
    aiProvider: value.aiProvider === 'ollama' ? 'ollama' : 'gemini',
    ollamaModel: (typeof value.ollamaModel === 'string'
      && /^[a-z0-9._:-]+$/.test(value.ollamaModel)
      && value.ollamaModel.length <= 60)
      ? value.ollamaModel : 'auto',
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
    aiFeatures: normalizeAiFeatures(value.aiFeatures),
    sensorHistory: { enabled: !!(value.sensorHistory && value.sensorHistory.enabled === true) },
    proactive: normalizeProactive(value.proactive),
    notifications: normalizeNotifications(value.notifications),
    vitals: normalizeVitals(value.vitals),
    discordNotifications: normalizeDiscordNotifications(value.discordNotifications),
    windowsNotifications: normalizeWindowsNotifications(value.windowsNotifications),
    wakeWord: normalizeWakeWord(value.wakeWord),
    sdkWidgets: normalizeSdkWidgets(value.sdkWidgets),
    bgAurora: normalizeBgAurora(value.bgAurora),
    bgGrid: normalizeBgGrid(value.bgGrid),
    gameMode: value.gameMode !== false,
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
    news: normalizeNewsClient(value.news),
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
    // Monotonic save revision: bumped on every real (server-bound) save so the
    // boot-time merge can tell which copy is newer and a stale server copy can
    // never clobber a more recent local one (see hydrateHubSettingsFromServer).
    rev: Number.isFinite(value.rev) && value.rev > 0 ? Math.floor(value.rev) : 0,
    onboarding: normalizeOnboarding(value.onboarding),
    language: SUPPORTED_LANGS.includes(value.language) ? value.language : '',
  };
}

// Home Assistant settings (client mirror). url/entities are client-managed; the
// token is a server-only secret — the client never persists a real one, but keeps
// a freshly-typed value until it's saved (then the server redacts it back to '').
// `tokenSet` (server-provided) drives the "saved" placeholder in the UI.
function normalizeHomeAssistant(value) {
  const src = (value && typeof value === 'object') ? value : {};
  const isEntity = (s) => typeof s === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(s.trim());
  const entities = Array.isArray(src.entities)
    ? src.entities.filter(isEntity).filter((v, i, a) => a.indexOf(v) === i).slice(0, 100)
    : [];
  return {
    url: String(src.url || '').trim().slice(0, 200),
    token: typeof src.token === 'string' ? src.token.slice(0, 400) : '',
    entities,
    tokenSet: src.tokenSet === true || (typeof src.token === 'string' && src.token.length > 0),
  };
}

// Per-instance saved tabs for each Browser widget tile, keyed by its instance id
// (the base "browser" or a copy id like "browser~ab12"). Bounded and scheme-free
// here — the server re-validates http/https before navigating.
function normalizeBrowserTiles(value) {
  const v = value && typeof value === 'object' ? value : {};
  const out = {};
  let n = 0;
  for (const key of Object.keys(v)) {
    if (n >= 32) break;
    if (!/^browser(~[a-z0-9]+)?$/.test(key)) continue;
    const entry = v[key];
    if (!entry || typeof entry !== 'object') continue;
    const norm = normalizeBrowserTileEntry(entry);
    if (!norm) continue;
    out[key] = norm;
    n++;
  }
  return out;
}

// A tile persists either the current multi-tab shape { tabs:[{url}], active } or
// the legacy single-URL shape { url }. Preserve whichever it is — the multi-tab
// shape used to be silently dropped here (only { url } survived), so every tab was
// lost on a settings round-trip. Tab count is capped to match the widget's MAX_TABS.
function normalizeBrowserTileEntry(entry) {
  if (Array.isArray(entry.tabs)) {
    const tabs = entry.tabs.slice(0, 6).map((tb) => ({ url: String((tb && tb.url) || '').slice(0, 2048) }));
    if (!tabs.length) return null;
    if (tabs.length === 1 && !tabs[0].url) return null;   // a lone blank tab isn't worth persisting
    const active = Math.max(0, Math.min(tabs.length - 1, parseInt(entry.active, 10) || 0));
    return { tabs, active };
  }
  const url = String(entry.url || '').slice(0, 2048);
  return url ? { url } : null;
}

// Global Browser-widget favorites: a shared list of { label, url } quick-access
// shortcuts, available in every Browser tile. Bounded and scheme-free here — the
// relay re-validates http/https before navigating to one.
function normalizeBrowserFavorites(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (out.length >= 16) break;
    if (!entry || typeof entry !== 'object') continue;
    const url = String(entry.url || '').trim().slice(0, 2048);
    if (!url) continue;
    out.push({ label: String(entry.label || '').slice(0, 40), url });
  }
  return out;
}

// Second-screen capture prefs. fps/quality are clamped to sane live-stream
// ranges; width/height are validated against the resolution presets the UI
// offers (falling back to 1920×1080). The preset list is local on purpose:
// normalizeSecondScreen runs during module init (loadHubSettings), before any
// module-level const declared lower in the file would be initialized (TDZ).
function normalizeSecondScreen(value) {
  const d = DEFAULT_HUB_SETTINGS.secondScreen;
  // Includes ultra-wide modes (2560×720, 3440×1440) so the virtual display can
  // match the Xeneon Edge bar and fill the tile without letterboxing.
  const RESOLUTIONS = [[1280, 720], [1920, 1080], [2560, 720], [2560, 1440], [3440, 1440]];
  const v = value && typeof value === 'object' ? value : {};
  const fps = Math.max(5, Math.min(60, parseInt(v.fps, 10) || d.fps));
  const quality = Math.max(20, Math.min(90, parseInt(v.quality, 10) || d.quality));
  const w = parseInt(v.width, 10);
  const h = parseInt(v.height, 10);
  const match = RESOLUTIONS.find((r) => r[0] === w && r[1] === h);
  // How the captured frame fills the tile: 'contain' shows the whole desktop
  // (letterboxed when aspect ratios differ); 'cover' fills the tile edge-to-edge,
  // cropping the overflow. Anything unexpected falls back to 'contain'.
  const fit = v.fit === 'cover' ? 'cover' : 'contain';
  // Whether a finger touch drives the virtual screen (true) or scrolls the
  // dashboard (false, default). A mouse always drives it regardless; this only
  // gates touch so the tile doesn't swallow swipes/taps meant for navigation.
  const touchControl = v.touchControl === true;
  return { fps, quality, width: match ? match[0] : d.width, height: match ? match[1] : d.height, fit, touchControl };
}

// First-run tutorial state: just a monotonic "last seen version" integer.
function normalizeOnboarding(value) {
  const v = value && typeof value === 'object' ? value : {};
  const seen = Number(v.seenVersion);
  return { seenVersion: Number.isFinite(seen) && seen > 0 ? Math.floor(seen) : 0 };
}

// Advanced AI features (Genesis, Game Companion, Guardian, ambient presence).
// Every flag is strict opt-in: anything that isn't literally `true` stays off,
// so old/corrupted settings can never silently enable a paying feature.
// Proactive moments (briefing engine). Default ON — only a literal `false`
// turns a type off, so existing settings keep every moment enabled.
function normalizeProactive(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    thermal: v.thermal !== false,
    recap: v.recap !== false,
    morning: v.morning !== false,
    anomaly: v.anomaly !== false,
  };
}

// Local "Hey Xenon" wake word — privacy-touching, strict opt-in: anything that
// isn't literally `true` stays off. Same shape the server persists.
function normalizeWakeWord(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { enabled: v.enabled === true };
}

// Master notifications switch (Settings → Notifiche). Both default ON; same shape
// the server persists so both sides normalize identically.
function normalizeNotifications(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { enabled: v.enabled !== false, popups: v.popups !== false };
}

// Vitals — known-key rebuild, identical to the server normalizer (server.js):
// per-vital enable + interval, plus the widget-owned state (last-refill
// timestamps, XP, daily fill counter).
function normalizeVitals(value) {
  const v = value && typeof value === 'object' ? value : {};
  const itemsSrc = v.items && typeof v.items === 'object' ? v.items : {};
  const stateSrc = v.state && typeof v.state === 'object' ? v.state : {};
  const lastSrc = stateSrc.last && typeof stateSrc.last === 'object' ? stateSrc.last : {};
  const items = {};
  const last = {};
  VITALS_IDS.forEach((id) => {
    const it = itemsSrc[id] && typeof itemsSrc[id] === 'object' ? itemsSrc[id] : {};
    items[id] = {
      on: typeof it.on === 'boolean' ? it.on : VITALS_DEFAULT_ON[id],
      min: Math.round(clampNumber(it.min, 5, 480, VITALS_DEFAULT_MIN[id])),
    };
    const ts = Number(lastSrc[id]);
    last[id] = Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : 0;
  });
  // Bit, the pixel guardian pet. Each rung of the nag ladder is strict opt-in:
  // the PC-invading actions (monitor popups, minimize-all, workstation lock)
  // require `=== true`, so nothing invasive can turn itself on via a stale blob.
  const petSrc = v.pet && typeof v.pet === 'object' ? v.pet : {};
  const pet = {
    enabled: petSrc.enabled === true,
    tone: ['soft', 'spicy', 'savage'].includes(petSrc.tone) ? petSrc.tone : 'spicy',
    effects: petSrc.effects !== false,
    sounds: petSrc.sounds !== false,
    monitors: petSrc.monitors === true,
    minimize: petSrc.minimize === true,
    lock: petSrc.lock === true,
    quietInGame: petSrc.quietInGame !== false,
  };
  return {
    enabled: v.enabled !== false,
    topbar: v.topbar === true,
    reminders: v.reminders !== false,
    pet,
    items,
    state: {
      last,
      xp: Math.round(clampNumber(stateSrc.xp, 0, 1e9, 0)),
      day: typeof stateSrc.day === 'string' ? stateSrc.day.slice(0, 10) : '',
      fills: Math.round(clampNumber(stateSrc.fills, 0, 100000, 0)),
      // Today's refills in order (the widget's "combo ribbon"); bounded.
      log: Array.isArray(stateSrc.log) ? stateSrc.log.filter(x => VITALS_IDS.includes(x)).slice(-40) : [],
    },
  };
}

// Discord notification mirroring — privacy-touching, strict opt-in: anything
// that isn't literally `true` stays off.
function normalizeDiscordNotifications(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { enabled: v.enabled === true, hide: v.hide === true };
}

// Third-party widget SDK (client-owned schema; the server round-trips it via
// sanitizeServerPassthrough). Strict opt-in known-key rebuild: the feature flag,
// tile→package assignments and per-package grants all collapse to safe empties
// on anything malformed — a corrupted blob can never grant a widget more than
// the user explicitly allowed.
const SDK_WIDGET_STREAMS = Object.freeze(['status', 'system', 'media', 'audio']);
const SDK_WIDGET_ACTION_CATS = Object.freeze(['media', 'volume', 'mic', 'lighting', 'url']);
const SDK_PACKAGE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
// Grant-side mirrors of the server manifest rules (sdk-widgets.js is the
// authority; a grant can never widen what the manifest declared, so a loose
// hostname check here is safe — the server re-validates every proxied fetch).
const SDK_HOST_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const SDK_SUB_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
function normalizeSdkWidgets(value) {
  const v = value && typeof value === 'object' ? value : {};
  const assign = {};
  let n = 0;
  if (v.assign && typeof v.assign === 'object') {
    for (const key of Object.keys(v.assign)) {
      if (n >= 32) break;
      if (!/^custom(~[a-z0-9]+)?$/.test(key)) continue;
      const pkg = String(v.assign[key] || '');
      if (!SDK_PACKAGE_ID_RE.test(pkg)) continue;
      assign[key] = pkg; n++;
    }
  }
  const grants = {};
  n = 0;
  if (v.grants && typeof v.grants === 'object') {
    for (const key of Object.keys(v.grants)) {
      if (n >= 32) break;
      if (!SDK_PACKAGE_ID_RE.test(key)) continue;
      const g = v.grants[key];
      if (!g || typeof g !== 'object') continue;
      grants[key] = {
        streams: Array.isArray(g.streams) ? g.streams.filter((s, i, a) => SDK_WIDGET_STREAMS.includes(s) && a.indexOf(s) === i) : [],
        actions: Array.isArray(g.actions) ? g.actions.filter((s, i, a) => SDK_WIDGET_ACTION_CATS.includes(s) && a.indexOf(s) === i) : [],
        hosts: Array.isArray(g.hosts) ? g.hosts.filter((s, i, a) => typeof s === 'string' && SDK_HOST_RE.test(s) && a.indexOf(s) === i).slice(0, 8) : [],
        hooks: Array.isArray(g.hooks) ? g.hooks.filter((s, i, a) => typeof s === 'string' && SDK_SUB_ID_RE.test(s) && a.indexOf(s) === i).slice(0, 8) : [],
      };
      n++;
    }
  }
  return { enabled: v.enabled === true, assign, grants };
}

// Windows notification mirroring — same shape the server persists (known-key
// rebuild, bounded excluded list) so both sides normalize identically.
function normalizeWindowsNotifications(value) {
  const v = value && typeof value === 'object' ? value : {};
  const excluded = [];
  if (Array.isArray(v.excluded)) {
    for (const e of v.excluded.slice(0, 100)) {
      const id = String((e && e.id) || '').slice(0, 200).trim();
      if (!id) continue;
      excluded.push({ id, name: String((e && e.name) || '').slice(0, 200) });
    }
  }
  // `toast` defaults ON: when the feature is enabled, a new toast pops for each
  // incoming notification unless the user turns pop-ups off (purely presentational
  // — the reader runs regardless, so this doesn't change background cost).
  return { enabled: v.enabled === true, hide: v.hide === true, toast: v.toast !== false, excluded };
}

// Stock (Borsa) config — mirrors server/stocks.js normalizeStocks. Watchlist
// symbols are cleaned to the ticker charset; provider keys are handled separately
// (server-only, redacted). Known-key rebuild, bounded.
function normalizeStocksClient(value) {
  const src = value && typeof value === 'object' ? value : {};
  const provider = STOCK_PROVIDER_IDS.includes(src.provider) ? src.provider : 'auto';
  const refreshSec = clampNumber(src.refreshSec, 30, 900, 60);
  const alertPercent = clampNumber(src.alertPercent, 0.5, 25, 2);
  const tile = src.tile && typeof src.tile === 'object' ? src.tile : {};
  let watchlist;
  if (Array.isArray(src.watchlist)) {
    watchlist = [];
    const seen = new Set();
    for (const e of src.watchlist) {
      const sym = String((e && e.symbol != null) ? e.symbol : (e || '')).trim().toUpperCase().slice(0, 20);
      if (!/^[A-Z0-9.\-^=]+$/.test(sym) || seen.has(sym)) continue;
      seen.add(sym);
      const name = String((e && e.name) || '').trim().slice(0, 60);
      watchlist.push(name ? { symbol: sym, name } : { symbol: sym });
      if (watchlist.length >= 30) break;
    }
  } else {
    watchlist = DEFAULT_HUB_SETTINGS.stocks.watchlist.map(w => ({ ...w }));
  }
  return { watchlist, provider, refreshSec, alertPercent, tile: { chart: tile.chart !== false, sparklines: tile.sparklines !== false } };
}

// Football (Calcio) config — mirrors server/football.js normalizeFootball. Team
// ids are numeric strings; the Premium key is handled separately (server-only,
// redacted). Known-key rebuild, bounded.
function normalizeFootballClient(value) {
  const src = value && typeof value === 'object' ? value : {};
  const refreshSec = clampNumber(src.refreshSec, 60, 900, 120);
  const tile = src.tile && typeof src.tile === 'object' ? src.tile : {};
  let teams;
  if (Array.isArray(src.teams)) {
    teams = [];
    const seen = new Set();
    for (const e of src.teams) {
      const id = String((e && e.id != null) ? e.id : (e || '')).trim();
      if (!/^[0-9]{1,12}$/.test(id)) continue;
      const isLeague = !!(e && typeof e === 'object' && e.type === 'league');
      const key = (isLeague ? 'L:' : 'T:') + id;
      if (seen.has(key)) continue;
      seen.add(key);
      const team = { id };
      if (isLeague) team.type = 'league';
      if (e && typeof e === 'object') {
        const name = String(e.name || '').trim().slice(0, 60);
        const badge = String(e.badge || '').trim().slice(0, 300);
        const league = String(e.league || '').trim().slice(0, 60);
        const leagueId = String(e.leagueId || '').trim();
        if (name) team.name = name;
        if (/^https:\/\//i.test(badge)) team.badge = badge;
        if (league) team.league = league;
        if (/^[0-9]{1,12}$/.test(leagueId)) team.leagueId = leagueId;
      }
      teams.push(team);
      if (teams.length >= 20) break;
    }
  } else {
    teams = DEFAULT_HUB_SETTINGS.football.teams.map(tm => ({ ...tm }));
  }
  return { teams, refreshSec, alerts: src.alerts !== false, tile: { results: tile.results !== false, standings: tile.standings !== false } };
}

// News config — mirrors server/news.js normalizeNews. Feeds are followed sources
// (curated ids) or free-text topics; the NewsData.io key is handled separately
// (server-only, redacted). Known-key rebuild, bounded.
function normalizeNewsClient(value) {
  const src = value && typeof value === 'object' ? value : {};
  const refreshSec = clampNumber(src.refreshSec, 120, 3600, 600);
  const tile = src.tile && typeof src.tile === 'object' ? src.tile : {};
  let feeds;
  if (Array.isArray(src.feeds)) {
    feeds = [];
    const seen = new Set();
    for (const e of src.feeds) {
      if (!e || typeof e !== 'object') continue;
      if (e.type === 'topic') {
        const query = String(e.query || e.name || '').trim().slice(0, 60);
        const id = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        if (!id || seen.has('t:' + id)) continue;
        seen.add('t:' + id);
        feeds.push({ id, type: 'topic', name: String(e.name || query).trim().slice(0, 40), query });
      } else {
        const id = String(e.id || '').trim().slice(0, 40);
        if (!id || seen.has('s:' + id)) continue;
        seen.add('s:' + id);
        feeds.push({ id, type: 'source', name: String(e.name || id).trim().slice(0, 40) });
      }
      if (feeds.length >= 12) break;
    }
  } else {
    feeds = DEFAULT_HUB_SETTINGS.news.feeds.map(f => ({ ...f }));
  }
  return { feeds, refreshSec, tile: { images: tile.images !== false } };
}

function normalizeTickerClient(value) {
  const v = value && typeof value === 'object' ? value : {};
  const s = v.sources && typeof v.sources === 'object' ? v.sources : {};
  return {
    enabled: v.enabled === true,
    position: v.position === 'top' ? 'top' : 'bottom',
    speed: clampNumber(v.speed, 10, 100, 50),
    sources: { stocks: s.stocks !== false, football: s.football !== false, news: s.news !== false },
  };
}

function normalizeAiFeatures(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    enabled: v.enabled === true,
    genesis: v.genesis === true,
    gameCompanion: v.gameCompanion === true,
    guardian: v.guardian === true,
    ambient: v.ambient === true,
    pcControl: v.pcControl === true,
  };
}

// Single gate used by every advanced-AI client module: a feature is active only
// when the master switch AND its own toggle are both on.
function aiFeatureEnabled(key) {
  const f = hubSettings && hubSettings.aiFeatures;
  return !!(f && f.enabled === true && f[key] === true);
}

function normalizePerformance(value) {
  const d = DEFAULT_HUB_SETTINGS.performance;
  const v = value && typeof value === 'object' ? value : {};
  const o = v.opts && typeof v.opts === 'object' ? v.opts : {};
  const powerPlan = ['none', 'high', 'ultimate'].includes(o.powerPlan) ? o.powerPlan : d.opts.powerPlan;
  const savedPowerPlan = (typeof v.savedPowerPlan === 'string'
    && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v.savedPowerPlan))
    ? v.savedPowerPlan.toLowerCase() : '';
  // Closed-app records (for one-tap reopen). Keep only the fields we need, and
  // only entries with a launchable executable path; cap the list defensively.
  const closedApps = (Array.isArray(v.closedApps) ? v.closedApps : [])
    .filter(a => a && typeof a === 'object' && typeof a.path === 'string' && /\.(exe|lnk)$/i.test(a.path))
    .slice(0, 30)
    .map(a => ({ name: String(a.name || '').slice(0, 80), path: a.path.slice(0, 1024) }));
  const aa = v.autoActivities && typeof v.autoActivities === 'object' ? v.autoActivities : {};
  const dAA = DEFAULT_HUB_SETTINGS.performance.autoActivities;
  const autoActivities = {};
  for (const act of PERF_ACTIVITIES) {
    autoActivities[act] = typeof aa[act] === 'boolean' ? aa[act] : !!dAA[act];
  }
  const ap = v.applied && typeof v.applied === 'object' ? v.applied : {};
  const appliedPlan = ['none', 'high', 'ultimate'].includes(ap.powerPlan) ? ap.powerPlan : 'none';
  return {
    enabled: v.enabled === true,
    autoSuggest: v.autoSuggest !== false,
    autoMode: v.autoMode === 'auto' ? 'auto' : 'suggest',
    autoActivities,
    useAi: v.useAi !== false,
    active: v.active === true,
    activatedBy: ['manual', 'auto'].includes(v.activatedBy) ? v.activatedBy : '',
    autoActivity: PERF_ACTIVITIES.includes(v.autoActivity) ? v.autoActivity : '',
    savedPowerPlan,
    closedApps,
    appChoices: normalizePerfAppChoices(v.appChoices),
    applied: {
      pauseAnimations: ap.pauseAnimations === true,
      powerPlan: appliedPlan,
      boostedProc: (typeof ap.boostedProc === 'string' && /^[\w.+\- ]{1,60}$/.test(ap.boostedProc)) ? ap.boostedProc : '',
    },
    opts: {
      pauseAnimations: o.pauseAnimations !== false,
      powerPlan,
      manageApps: o.manageApps === true,
      priorityBoost: o.priorityBoost === true,
      pauseStreams: o.pauseStreams !== false,
    },
    activityApps: normalizeActivityApps(v.activityApps),
  };
}

// Smart context profiles (context-profiles.js owns the behavior). Rebuild from
// known keys only: page/deck are free strings (loosely bounded — the live lists
// validate at apply time), lighting is a fixed enum. Off by default.
function normalizeContextProfiles(value) {
  const v = value && typeof value === 'object' ? value : {};
  const srcMap = v.map && typeof v.map === 'object' ? v.map : {};
  const map = {};
  for (const act of PERF_ACTIVITIES) {
    const e = srcMap[act] && typeof srcMap[act] === 'object' ? srcMap[act] : {};
    map[act] = {
      page: typeof e.page === 'string' ? e.page.slice(0, 64) : '',
      lighting: CONTEXT_LIGHTING_STYLES.includes(e.lighting) ? e.lighting : '',
      deck: typeof e.deck === 'string' ? e.deck.slice(0, 80) : '',
      style: ['glass', 'retro'].includes(e.style) ? e.style : '',
    };
  }
  return { enabled: v.enabled === true, revertOnExit: v.revertOnExit !== false, map };
}

// Sanitize a list of process names: lowercase, no extension, safe chars only,
// deduped and capped. Shared by the per-activity add/remove lists.
function normalizeAppNameList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const n = String(raw == null ? '' : raw).toLowerCase().trim().replace(/\.exe$/, '');
    if (!/^[a-z0-9._+\-]{1,40}$/.test(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= 40) break;
  }
  return out;
}

function normalizeActivityApps(value) {
  const v = value && typeof value === 'object' ? value : {};
  const one = (a) => {
    const x = a && typeof a === 'object' ? a : {};
    return { add: normalizeAppNameList(x.add), remove: normalizeAppNameList(x.remove) };
  };
  const out = {};
  for (const act of PERF_ACTIVITIES) out[act] = one(v[act]);
  return out;
}

// Per-app keep/close counters (learning from the sheet choices). Keys are bare
// lowercase process names; counts are small bounded ints; the map is capped.
function normalizePerfAppChoices(value) {
  const v = value && typeof value === 'object' ? value : {};
  const out = {};
  let n = 0;
  for (const key of Object.keys(v)) {
    const name = String(key).toLowerCase().trim().replace(/\.exe$/, '');
    if (!/^[a-z0-9._+\- ]{1,40}$/.test(name)) continue;
    const c = v[key] && typeof v[key] === 'object' ? v[key] : {};
    const kept = Math.min(99, Math.max(0, parseInt(c.kept, 10) || 0));
    const closed = Math.min(99, Math.max(0, parseInt(c.closed, 10) || 0));
    if (!kept && !closed) continue;
    out[name] = { kept, closed };
    if (++n >= 60) break;
  }
  return out;
}

function normalizeLightingEvent(value, fallback) {
  const f = fallback || { enabled: true, color: '#ff0000', style: 'blink', durationMs: 1800 };
  const fDur = clampNumber(f.durationMs, 500, 10000, 1800);
  if (typeof value === 'boolean') return { enabled: value, color: f.color, style: f.style, durationMs: fDur };
  const v = value && typeof value === 'object' ? value : {};
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : f.enabled,
    color: normalizeHex(v.color, f.color),
    style: LIGHTING_STYLES.includes(v.style) ? v.style : f.style,
    durationMs: clampNumber(v.durationMs, 500, 10000, fDur),
  };
}
function normalizeLighting(value) {
  const v = value && typeof value === 'object' ? value : {};
  const d = DEFAULT_HUB_SETTINGS.lighting;
  const fx = v.effects && typeof v.effects === 'object' ? v.effects : {};
  return {
    enabled: v.enabled === true,
    brightness: clampNumber(v.brightness, 0, 1, d.brightness),
    pauseDuringGame: v.pauseDuringGame !== false,
    devices: (v.devices && typeof v.devices === 'object') ? v.devices : {},
    effects: {
      temperature: fx.temperature === true,
      volume: fx.volume === true,
      musicAlbum: fx.musicAlbum === true,
      timer: normalizeLightingEvent(fx.timer, d.effects.timer),
      notification: normalizeLightingEvent(fx.notification, d.effects.notification),
      reminder: normalizeLightingEvent(fx.reminder, d.effects.reminder),
    },
    animation: normalizeLightingAnimation(v.animation, d.animation),
    manualColor: /^#[0-9a-f]{6}$/i.test(String(v.manualColor)) ? v.manualColor : '',
    providers: normalizeLightingProviders(v.providers),
    deviceModes: normalizeLightingDeviceModes(v.deviceModes),
  };
}

const LIGHTING_DEVICE_MODES = ['follow', 'color', 'animation', 'temperature', 'album', 'off'];
function normalizeLightingDeviceModes(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const id of Object.keys(value)) {
    const v = value[id];
    if (!v || typeof v !== 'object') continue;
    const e = { mode: LIGHTING_DEVICE_MODES.includes(v.mode) ? v.mode : 'follow' };
    if (typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color)) e.color = v.color;
    if (v.anim && typeof v.anim === 'object') {
      e.anim = {
        style: ['solid', 'breathing', 'cycle', 'aurora', 'candle'].includes(v.anim.style) ? v.anim.style : 'cycle',
        color: /^#[0-9a-f]{6}$/i.test(String(v.anim.color)) ? v.anim.color : '#1ed760',
        speed: clampNumber(v.anim.speed, 1, 100, 50),
      };
    }
    out[String(id)] = e;
  }
  return out;
}

// Note: arrays inlined (not module-level consts) because normalizeLighting runs
// during the top-level hubSettings init, before a later const would initialise (TDZ).
function normalizeLightingAnimation(value, fallback) {
  const f = fallback || { style: 'none', color: '#1ed760', speed: 50, palette: ['#1ed760', '#0066ff'] };
  const v = value && typeof value === 'object' ? value : {};
  const hex = /^#[0-9a-f]{6}$/i.test(String(v.color)) ? v.color : f.color;
  const fPal = Array.isArray(f.palette) && f.palette.length >= 2 ? f.palette : ['#1ed760', '#0066ff'];
  const palette = (Array.isArray(v.palette) ? v.palette : []).slice(0, 5)
    .filter(h => /^#[0-9a-f]{6}$/i.test(String(h)));
  return {
    style: ['none', 'solid', 'breathing', 'cycle', 'wave', 'aurora', 'candle', 'palette'].includes(v.style) ? v.style : f.style,
    color: hex,
    speed: clampNumber(v.speed, 1, 100, f.speed),
    palette: palette.length >= 2 ? palette : fPal.slice(),
  };
}
// Mirror the server provider shape so a full-settings save round-trips the
// discovered devices instead of wiping them. Keep this id list aligned with the
// server's LIGHTING_PROVIDER_IDS (server.js).
function normalizeLightingProviders(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const id of ['govee', 'lifx', 'wled', 'hue', 'nanoleaf', 'openrgb', 'homeassistant', 'yeelight']) {
    const p = value[id];
    if (!p || typeof p !== 'object' || !Array.isArray(p.devices)) continue;
    const devices = p.devices.map(dev => {
      const host = String(dev && dev.host || '').trim();
      if (!host) return null;
      const out = {
        id: String(dev.id || `${id}:${host}`),
        name: String(dev && dev.name || id),
        host,
        optedIn: !(dev && dev.optedIn === false),
      };
      if (dev && dev.token) out.token = String(dev.token);
      return out;
    }).filter(Boolean);
    if (devices.length) out[id] = { devices };
  }
  return out;
}

function loadHubSettings() {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}'));
  } catch {
    return normalizeSettings(null);
  }
}

function saveLocalHubSettings() {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(hubSettings));
}

function postHubSettingsToServer() {
  const body = JSON.stringify({ settings: normalizeSettings(hubSettings) });
  return fetch('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  });
}

function queueHubSettingsServerSave() {
  clearTimeout(settingsServerSaveTimer);
  settingsServerSaveTimer = setTimeout(() => {
    settingsServerSaveTimer = null;
    postHubSettingsToServer().catch(() => {});
  }, 250);
}

function saveHubSettings(options = {}) {
  const toServer = options.server !== false;
  // Bump the save revision only on a real, server-bound save (a user change).
  // Local-only mirrors (hydrate, lighting sync) must NOT bump it, or they'd make
  // the local copy look spuriously newer than the server's and re-push needlessly.
  if (toServer) {
    const cur = Number.isFinite(hubSettings && hubSettings.rev) ? hubSettings.rev : 0;
    hubSettings = normalizeSettings({ ...hubSettings, rev: cur + 1 });
  } else {
    hubSettings = normalizeSettings(hubSettings);
  }
  saveLocalHubSettings();
  if (toServer) queueHubSettingsServerSave();
}

// The Lighting page persists RGB config directly via /api/lighting/*. Mirror that
// change into the client settings store (local only — the server already saved it)
// so a later full-settings save can't push a stale `lighting` back over it.
function syncHubLighting(lighting) {
  if (!lighting || typeof lighting !== 'object') return;
  hubSettings = normalizeSettings({ ...hubSettings, lighting });
  saveLocalHubSettings();
}
window.syncHubLighting = syncHubLighting;

// First-run tutorial state. The getter is read by onboarding.js to decide
// whether to auto-start the tour; the setter records the version the user just
// finished/skipped and persists it to the server so it survives a storage wipe.
function getOnboardingSeen() {
  return (hubSettings && hubSettings.onboarding && Number(hubSettings.onboarding.seenVersion)) || 0;
}
window.getOnboardingSeen = getOnboardingSeen;

function setOnboardingSeen(version) {
  const v = Math.max(0, Math.floor(Number(version) || 0));
  hubSettings = normalizeSettings({ ...hubSettings, onboarding: { seenVersion: v } });
  saveHubSettings();
}
window.setOnboardingSeen = setOnboardingSeen;

// Home Assistant (Smart Home) settings bridge for the Smart Home page module.
// The token is write-only from the client's side: an empty patch.token leaves the
// stored one untouched (the server preserves it), so we never overwrite a saved
// token with a blank unless the user explicitly typed a new one.
window.getHomeAssistantSettings = () => (hubSettings && hubSettings.homeAssistant) || { url: '', token: '', entities: [], tokenSet: false };
window.setHomeAssistantSettings = (patch) => {
  const cur = (hubSettings && hubSettings.homeAssistant) || {};
  const next = { ...cur, ...(patch || {}) };
  hubSettings = normalizeSettings({ ...hubSettings, homeAssistant: next });
  saveHubSettings();
  return hubSettings.homeAssistant;
};

function sendHubSettingsBeacon() {
  try {
    const body = JSON.stringify({ settings: normalizeSettings(hubSettings) });
    if (navigator.sendBeacon) {
      navigator.sendBeacon('/settings', new Blob([body], { type: 'application/json' }));
      return;
    }
    postHubSettingsToServer().catch(() => {});
  } catch {}
}

async function hydrateHubSettingsFromServer() {
  try {
    const res = await fetch('/settings', { cache: 'no-store' });
    if (!res.ok) { postHubSettingsToServer().catch(() => {}); return; }
    const data = await res.json().catch(() => ({}));
    if (!data || !data.settings) {
      postHubSettingsToServer().catch(() => {});
      return;
    }
    const keyBefore = hubSettings && hubSettings.geminiApiKey;
    // Keep locally-stored sensitive keys (geminiApiKey) even if the server
    // copy is older and doesn't have them yet.
    const localRaw = normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}'));
    const serverRev = Number.isFinite(data.settings.rev) ? data.settings.rev : 0;
    const localRev = Number.isFinite(localRaw.rev) ? localRaw.rev : 0;
    // If the local copy is newer than the server's — a change (e.g. a new page or
    // a moved widget) that didn't reach the server before the last shutdown —
    // keep local and push it back, instead of letting the stale server copy
    // clobber it. Otherwise the server copy wins (covers a wiped localStorage).
    const localNewer = localRev > serverRev;
    const base = localNewer ? localRaw : data.settings;
    // Snapshot the rendered page list so we can tell, after merging, whether the
    // set of dashboard pages changed (e.g. the server copy restored a page that
    // the local copy — rendered at startup — didn't have). applyDashboardLayout
    // only places widgets into EXISTING page grids; a new page needs the pager
    // rebuilt, or its section/dot never appears until a manual reload.
    const pagesBefore = JSON.stringify(getDashboardLayout().pages.map(p => p.id));
    hubSettings = normalizeSettings({
      ...base,
      rev: Math.max(localRev, serverRev),
      geminiApiKey: localRaw.geminiApiKey || data.settings.geminiApiKey || '',
      // Client-owned settings: keep whichever side actually has them so they
      // survive an older server build / a server restart.
      performance: base.performance || data.settings.performance || localRaw.performance,
      gameMode: typeof base.gameMode === 'boolean' ? base.gameMode
        : (typeof data.settings.gameMode === 'boolean' ? data.settings.gameMode : localRaw.gameMode),
    });
    saveHubSettings({ server: false });
    // Back the local copy up to the server when it won the merge, or when it
    // holds an API key the server was missing (also triggers wake-word start).
    if (localNewer || (hubSettings.geminiApiKey && !data.settings.geminiApiKey)) {
      postHubSettingsToServer().catch(() => {});
    }
    applyHubSettings();
    // Rebuild the pager when the page set changed (creates the missing page
    // section + dot); otherwise just reposition widgets in the existing grids.
    // DashboardPages.rebuild() runs applyDashboardLayout() itself at the end.
    const pagesAfter = JSON.stringify(getDashboardLayout().pages.map(p => p.id));
    if (pagesAfter !== pagesBefore && window.DashboardPages && typeof window.DashboardPages.rebuild === 'function') {
      window.DashboardPages.rebuild();
    } else if (typeof applyDashboardLayout === 'function') {
      applyDashboardLayout();
    }
    // Re-push the current album-art colour to the lighting bridge now that the
    // settings (and thus the server's lighting state) are hydrated: at a cold
    // boot the bridge may not have been ready for media.js's first one-shot push,
    // and its de-dupe would never retry — leaving the lights out of sync until a
    // manual reload. Best-effort: the server ignores it when lighting is off.
    if (typeof refreshAlbumAccent === 'function') refreshAlbumAccent();
    if ($('settings-overlay') && !$('settings-overlay').hidden) renderSettingsModal();
    // If the key appeared or disappeared after hydration, re-sync the AI chat UI.
    // This handles the case where localStorage was empty at startup but the key
    // was found in the server settings file (e.g. after a fresh browser session).
    if (keyBefore !== hubSettings.geminiApiKey) {
      if (typeof onAiKeyUpdated === 'function') onAiKeyUpdated();
    }
    if (typeof updateMediaChatKeyState === 'function') updateMediaChatKeyState();
    // Bring the logon "open in browser" task in line with the saved intent —
    // a no-op inside the Edge iframe, so pure-Edge installs never get a tab.
    reconcileAutoOpenBrowser();
    // First-run tutorial: now that the persisted seenVersion is authoritative,
    // offer the tour once (it self-defers past any greeting splash and no-ops
    // inside the embedded host).
    if (window.Onboarding && typeof window.Onboarding.maybeStart === 'function') window.Onboarding.maybeStart();
  } catch {}
}

// Live settings sync across surfaces: the server broadcasts an SSE `settings`
// event (with the new rev) after every accepted save. When ANOTHER surface
// (Xeneon Edge screen / external browser / native app — different origins, so
// the `storage` event never fires across them) saved, our local rev is older →
// re-hydrate so this dashboard adopts the change live instead of clobbering it
// wholesale with its own stale blob on its next edit. Our own save comes back
// with a rev we already hold and is ignored.
//
// Coalesced and deferred, never dropped: a burst of broadcasts (a slider drag
// on another surface saves ~4×/sec) runs ONE trailing hydrate, and an event
// arriving while a local save is debounce-pending or a hydrate is in flight is
// retried shortly after instead of being lost (the server assigns strictly
// increasing revs, so a stale local rev always sees a newer one eventually).
let _settingsSsePendingRev = 0;
let _settingsSseTimer = null;
let _settingsSseHydrating = false;
function _onServerSettingsRev(rev) {
  const serverRev = Number(rev) || 0;
  if (serverRev > _settingsSsePendingRev) _settingsSsePendingRev = serverRev;
  if (!_settingsSseTimer) _settingsSseTimer = setTimeout(_runSettingsSseHydrate, 400);
}
window._onServerSettingsRev = _onServerSettingsRev;

function _runSettingsSseHydrate() {
  _settingsSseTimer = null;
  const localRev = (hubSettings && Number.isFinite(hubSettings.rev)) ? hubSettings.rev : 0;
  if (_settingsSsePendingRev <= localRev) { _settingsSsePendingRev = 0; return; }
  if (settingsServerSaveTimer || _settingsSseHydrating) {
    // Defer, don't drop: our own pending save may still be OLDER than the
    // broadcast rev (the server bumps past it), so re-check shortly.
    _settingsSseTimer = setTimeout(_runSettingsSseHydrate, 400);
    return;
  }
  _settingsSseHydrating = true;
  Promise.resolve(hydrateHubSettingsFromServer())
    .catch(() => {})
    .finally(() => {
      _settingsSseHydrating = false;
      // A newer rev may have arrived mid-hydrate — re-check instead of dropping it.
      if (!_settingsSseTimer) _settingsSseTimer = setTimeout(_runSettingsSseHydrate, 400);
    });
}

function isVideoBackground(media) {
  return media && /^video\//.test(media.type);
}

function isSupportedBackgroundFile(file) {
  if (!file) return false;
  if (file.type && SETTINGS_BACKGROUND_TYPES.has(file.type.toLowerCase())) return true;
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  return SETTINGS_BACKGROUND_EXTENSIONS.has(ext);
}

function getBackgroundSource(media) {
  if (!media) return '';
  return media.version ? `${media.url}?v=${encodeURIComponent(media.version)}` : media.url;
}

function createBackgroundImage(source) {
  const image = document.createElement('img');
  image.id = 'user-bg-image';
  image.alt = '';
  image.dataset.source = source;
  image.src = source;
  return image;
}

function ensureBackgroundVideoPlayback(video = $('user-bg-video')) {
  if (!video || video.hidden || document.hidden) return;
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  const playAttempt = video.play();
  if (playAttempt && typeof playAttempt.catch === 'function') playAttempt.catch(() => {});
}

function clearBackgroundVideoError(video) {
  const media = hubSettings.backgroundMedia;
  if (!video || !media || !isVideoBackground(media)) return;
  if (video.dataset.source !== getBackgroundSource(media)) return;
  const status = $('settings-status');
  if (status?.dataset.messageKey === 'settings_bg_video_failed') setSettingsStatus('', '');
}

function reportBackgroundVideoError(video) {
  const media = hubSettings.backgroundMedia;
  if (!video || !media || !isVideoBackground(media)) return;
  if (video.dataset.source !== getBackgroundSource(media)) return;
  if (video.readyState >= 2) return;
  setSettingsStatus('settings_bg_video_failed', 'error');
}

function createBackgroundVideo(source) {
  const video = document.createElement('video');
  video.id = 'user-bg-video';
  video.autoplay = true;
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.controls = false;
  video.disablePictureInPicture = true;
  video.setAttribute('autoplay', '');
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.dataset.source = source;
  video.addEventListener('loadeddata', () => { clearBackgroundVideoError(video); ensureBackgroundVideoPlayback(video); });
  video.addEventListener('canplay', () => { clearBackgroundVideoError(video); ensureBackgroundVideoPlayback(video); });
  video.addEventListener('error', () => reportBackgroundVideoError(video));
  video.src = source;
  video.load();
  ensureBackgroundVideoPlayback(video);
  return video;
}

function replaceBackgroundNode(current, fresh, fallbackParent) {
  if (current) current.replaceWith(fresh);
  else fallbackParent.appendChild(fresh);
  return fresh;
}

// ── Appearance (light / dark / auto) ──────────────────────────────
// Light-mode base palette. Set as inline custom properties on :root so they
// win over the dark defaults in global.css; removed again in dark mode so the
// stylesheet defaults (and the user's custom colours) take over. Component CSS
// fixups for hard-coded colours live in styles/themes-light.css, keyed off
// the [data-appearance="light"] attribute set below.
const LIGHT_BG = '#eceff3';
const LIGHT_TEXT = '#171d1b';
const LIGHT_ONLY_TOKENS = Object.freeze({
  '--muted-text': '#566159',
  '--dim-text': '#828c87',
  '--line': '#d6dce0',
  '--panel-rgb': '255, 255, 255',
  '--panel-soft-rgb': '244, 247, 250',
  '--panel-border': 'rgba(15, 25, 30, 0.10)',
  '--floating-ui-bg': 'rgba(255, 255, 255, 0.66)',
  '--floating-ui-border': 'rgba(15, 25, 30, 0.12)',
  '--glass-bg': 'linear-gradient(135deg, rgba(255,255,255,0.80), rgba(255,255,255,0.52))',
  '--glass-border': 'rgba(255,255,255,0.88)',
  '--glass-highlight': 'rgba(255,255,255,0.95)',
  '--glass-sheen': 'linear-gradient(180deg, rgba(255,255,255,0.6), transparent 38%)',
  '--oled-bg-rgb': '255, 255, 255',
  '--oled-border': 'rgba(15, 25, 30, 0.08)',
  '--readability-shadow': '0 1px 2px rgba(20,30,40,0.10)',
  '--icon-readability-filter': 'none',
  '--slider-fill': 'var(--accent)',
  '--slider-track': 'rgba(15, 25, 30, 0.12)',
  '--shadow-sm': '0 1px 2px rgba(20,30,40,0.08)',
  '--shadow-md': '0 1px 2px rgba(20,30,40,0.05), 0 8px 22px -6px rgba(20,30,40,0.10)',
  '--shadow-lg': '0 2px 4px rgba(20,30,40,0.05), 0 18px 44px -12px rgba(20,30,40,0.14)',
  '--shadow-xl': '0 3px 6px rgba(20,30,40,0.06), 0 30px 70px -18px rgba(20,30,40,0.18)',
  '--panel-topline': 'rgba(255,255,255,0.85)',
  '--panel-drop': '0 1px 2px rgba(20,30,40,0.05), 0 10px 30px -16px rgba(20,30,40,0.14)',
});

// Windows app theme read from the server registry (reliable). Cached in
// localStorage so a reload starts on the correct scheme immediately, instead of
// the WebView's (unreliable) prefers-color-scheme — which otherwise flashed the
// dashboard white on 'auto' until the first /system/theme fetch landed (up to 30s).
const OS_THEME_KEY = 'xeneonedge.osDark.v1';
let _osPrefersDark = (() => {
  try { const v = localStorage.getItem(OS_THEME_KEY); return v === 'true' ? true : v === 'false' ? false : null; }
  catch { return null; }
})();
let _osThemeChecked = false;   // one fresh /system/theme read per page load

function resolveAppearance(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  // 'auto' follows the OS colour scheme. Prefer the server's registry reading
  // (the embedded WebView's prefers-color-scheme is unreliable); fall back to
  // the media query until that value is available.
  if (typeof _osPrefersDark === 'boolean') return _osPrefersDark ? 'dark' : 'light';
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}

// Poll the OS theme from the server (Windows registry) so "Auto" is reliable
// even when the WebView doesn't report prefers-color-scheme correctly.
function refreshOsTheme() {
  // The OS scheme only matters in 'auto', and the endpoint spawns reg.exe server-side.
  // Skip the poll unless we're on auto and the tab is visible — OS theme flips are
  // also caught live by the matchMedia listener below, so this is only a fallback.
  if (document.hidden || !hubSettings || hubSettings.appearance !== 'auto') return;
  fetch('/system/theme')
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      if (!data || typeof data.osDark !== 'boolean') return;
      const changed = _osPrefersDark !== data.osDark;
      _osPrefersDark = data.osDark;
      try { localStorage.setItem(OS_THEME_KEY, String(data.osDark)); } catch { /* quota */ }
      if (changed && hubSettings && hubSettings.appearance === 'auto') applyHubSettings();
    })
    .catch(() => {});
}
refreshOsTheme();
setInterval(refreshOsTheme, 30000);

function setAppearance(mode) {
  if (!['light', 'dark', 'auto'].includes(mode)) return;
  hubSettings.appearance = mode;
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
  if (mode === 'auto') refreshOsTheme();   // fetch the current OS scheme right away
}

// ── Dashboard style (Liquid Glass / Pixel Retro) ─────────────────
function setStyleMode(mode) {
  if (!['glass', 'retro'].includes(mode)) return;
  hubSettings.styleMode = mode;
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
}

function updateRetroScanlines(enabled) {
  hubSettings.retroScanlines = enabled !== false && enabled !== 'false';
  saveHubSettings();
  applyHubSettings();
}

function syncStyleModeControls() {
  const retro = hubSettings.styleMode === 'retro';
  document.querySelectorAll('.settings-style-btn').forEach(btn => {
    const active = btn.dataset.stylemode === hubSettings.styleMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  const scan = $('settings-retro-scanlines');
  if (scan) scan.checked = hubSettings.retroScanlines;
  const scanRow = $('settings-retro-scanlines-row');
  if (scanRow) {
    scanRow.hidden = !retro;
    // Hide the whole grid too, or the empty container leaves a blank strip.
    const grid = scanRow.closest('.settings-grid');
    if (grid) grid.hidden = !retro;
  }
  // Retro always forces the dark CRT look, so the Tema (light/dark/auto)
  // control would save-but-do-nothing — dim it instead of lying active.
  const themeGroup = document.querySelector('.settings-theme-group');
  if (themeGroup) themeGroup.classList.toggle('is-disabled', retro);
}

// Re-apply when the OS scheme flips, but only while the user is on 'auto'.
if (window.matchMedia) {
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (hubSettings && hubSettings.appearance === 'auto') applyHubSettings();
    });
  } catch {}
}

// ── Dynamic album-art accent ──────────────────────────────────────
// Runtime-only override of the accent colour, driven by the now-playing album
// art (album-theme.js extracts it, media.js feeds it in via setDynamicAccent).
// hubSettings.accent stays the persistent user choice — this only layers a
// visual tint on top, and clears back to it when music stops or the feature is
// off.
let _dynamicAccent = null;

function applyAccentColor() {
  const root = document.documentElement;
  const useDynamic = hubSettings.dynamicAlbumTheme !== false && _dynamicAccent;
  const accent = useDynamic ? _dynamicAccent : hubSettings.accent;
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--green', accent);
  root.style.setProperty('--accent-rgb', hexToRgb(accent).join(', '));
}

// Called by media.js on every media update. Pass a hex to tint the theme from
// the album art, or null to fall back to the user's chosen accent.
function setDynamicAccent(hex) {
  const valid = hubSettings.dynamicAlbumTheme !== false
    && typeof hex === 'string'
    && /^#[0-9a-fA-F]{6}$/.test(hex);
  const next = valid ? hex : null;
  if (next === _dynamicAccent) return;
  _dynamicAccent = next;
  applyAccentColor();
}

function applyHubSettings() {
  hubSettings = normalizeSettings(hubSettings);
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
  const root = document.documentElement;
  const panelSoftAlpha = Math.max(0.14, Math.min(1, hubSettings.panelAlpha - 0.02));
  const panelBorderAlpha = Math.min(0.18, 0.045 + (hubSettings.panelAlpha * 0.08));
  const panelShadowAlpha = Math.min(0.30, 0.05 + (hubSettings.panelAlpha * 0.18));
  const panelHighlightAlpha = Math.min(0.07, 0.012 + (hubSettings.panelAlpha * 0.04));
  const bgSafeDim = Math.max(hubSettings.bgDim, 0.18);
  const bgSafeDimStrong = Math.min(0.9, bgSafeDim + 0.11);
  const bgBlur = Math.round(hubSettings.bgBlur);
  const bgScale = bgBlur > 0 ? Math.min(1.06, 1 + (bgBlur / 600)) : 1;

  // Dashboard style language: themes-retro.css keys every rule off this
  // attribute, so removing it restores Liquid Glass with zero residue.
  // Retro is always a dark CRT skin: it forces the dark appearance so the
  // light-mode inline tokens and themes-light.css fixups never mix into it
  // (the user's light/auto choice is preserved and resumes on switch-back).
  const retro = hubSettings.styleMode === 'retro';
  if (retro) root.dataset.style = 'retro';
  else delete root.dataset.style;
  document.body.classList.toggle('retro-scanlines', retro && hubSettings.retroScanlines);

  const light = !retro && resolveAppearance(hubSettings.appearance) === 'light';
  root.dataset.appearance = light ? 'light' : 'dark';

  // 'auto' resolves from the cached OS scheme above (no white flash); still do one
  // fresh registry read per page load so a scheme change while the dashboard was
  // closed is picked up promptly instead of only on the next 30s poll.
  if (hubSettings.appearance === 'auto' && !_osThemeChecked && !document.hidden) {
    _osThemeChecked = true;
    refreshOsTheme();
  }

  // Accent works in both schemes — always applied. applyAccentColor honours an
  // active album-art override (see setDynamicAccent) while falling back to the
  // user's saved accent.
  applyAccentColor();

  if (light) {
    root.style.setProperty('--bg', LIGHT_BG);
    root.style.setProperty('--text', LIGHT_TEXT);
    // Respect the user's panel-opacity slider in light mode too, so lowering it
    // makes the white tiles genuinely translucent over the background.
    root.style.setProperty('--panel-alpha', hubSettings.panelAlpha.toFixed(2));
    root.style.setProperty('--panel-soft-alpha', panelSoftAlpha.toFixed(2));
    root.style.setProperty('--panel-border-alpha', '0.10');
    root.style.setProperty('--panel-shadow-alpha', '0.10');
    root.style.setProperty('--panel-highlight-alpha', '0.55');
    Object.entries(LIGHT_ONLY_TOKENS).forEach(([key, val]) => root.style.setProperty(key, val));
  } else {
    root.style.setProperty('--bg', hubSettings.background);
    root.style.setProperty('--text', hubSettings.text);
    root.style.setProperty('--panel-alpha', hubSettings.panelAlpha.toFixed(2));
    root.style.setProperty('--panel-soft-alpha', panelSoftAlpha.toFixed(2));
    root.style.setProperty('--panel-border-alpha', panelBorderAlpha.toFixed(3));
    root.style.setProperty('--panel-shadow-alpha', panelShadowAlpha.toFixed(3));
    root.style.setProperty('--panel-highlight-alpha', panelHighlightAlpha.toFixed(3));
    Object.keys(LIGHT_ONLY_TOKENS).forEach(key => root.style.removeProperty(key));
  }

  root.style.setProperty('--bg-dim', hubSettings.bgDim.toFixed(2));
  root.style.setProperty('--bg-safe-dim', bgSafeDim.toFixed(2));
  root.style.setProperty('--bg-safe-dim-strong', bgSafeDimStrong.toFixed(2));
  root.style.setProperty('--bg-blur', `${bgBlur}px`);
  root.style.setProperty('--bg-scale', bgScale.toFixed(3));

  // ── Background FX (aurora + perspective grid) ───────────────────
  const aurora = normalizeBgAurora(hubSettings.bgAurora);
  const grid = normalizeBgGrid(hubSettings.bgGrid);
  // Aurora only shows when there's no custom image/video background.
  const auroraOn = aurora.enabled && !hubSettings.backgroundMedia;
  document.body.classList.toggle('aurora-on', auroraOn);
  root.style.setProperty('--aurora-opacity', (0.12 + (aurora.intensity / 100) * 0.5).toFixed(3));
  root.style.setProperty('--aurora-duration', `${(72 - (aurora.speed / 100) * 54).toFixed(1)}s`);

  // Like the aurora, the neon grid only shows when there's no custom image/video
  // background — it shouldn't compete with (or visibly flicker over) a user wallpaper.
  document.body.classList.toggle('grid-on', grid.enabled && !hubSettings.backgroundMedia);
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

  const media = hubSettings.backgroundMedia;
  const bgLayer = $('user-bg-layer');
  let image = $('user-bg-image');
  let video = $('user-bg-video');
  document.body.classList.toggle('has-user-bg', !!media);
  document.body.classList.toggle('no-user-bg', !media);

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
    document.body.dataset.bgType = 'image';
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

function findMatchingPreset() {
  return SETTINGS_PRESETS.find(preset =>
    normalizeHex(preset.accent, '') === hubSettings.accent &&
    normalizeHex(preset.background, '') === hubSettings.background &&
    normalizeHex(preset.text, '') === hubSettings.text
  );
}

function renderSettingsPresets() {
  const box = $('settings-presets');
  if (!box) return;
  const active = findMatchingPreset();
  box.replaceChildren(...SETTINGS_PRESETS.map(preset => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `preset-btn${active && active.id === preset.id ? ' active' : ''}`;
    btn.setAttribute('aria-label', t(preset.nameKey));
    btn.style.setProperty('--preset-accent', preset.accent);
    btn.style.setProperty('--preset-glow', `${preset.accent}88`);
    btn.addEventListener('click', () => setThemePreset(preset.id));

    const swatch = document.createElement('span');
    swatch.className = 'preset-swatch';
    const name = document.createElement('span');
    name.className = 'preset-name';
    name.textContent = t(preset.nameKey);
    btn.append(swatch, name);
    return btn;
  }));
}

function syncSettingsControls() {
  // Sync appearance (light/dark/auto) segmented control
  document.querySelectorAll('.settings-appearance-btn').forEach(btn => {
    const active = btn.dataset.appearance === hubSettings.appearance;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  // Sync color preview divs + hex text for each color key
  ['accent', 'background', 'text'].forEach(key => {
    const hex = hubSettings[key];
    const preview = $(`settings-${key}-swatch`);
    const hexInput = $(`settings-${key}`);
    if (preview) preview.style.background = hex;
    if (hexInput) { hexInput.value = hex.toUpperCase(); hexInput.classList.remove('invalid'); }
  });

  const rangeMap = [
    ['settings-panel-alpha', String(hubSettings.panelAlpha)],
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

  const media = hubSettings.backgroundMedia;
  const title = $('settings-bg-title');
  const sub = $('settings-bg-sub');
  if (title) title.textContent = media ? media.name : t('settings_bg_upload');
  if (sub) sub.textContent = media ? t(isVideoBackground(media) ? 'settings_bg_video_loaded' : 'settings_bg_image_loaded') : t('settings_bg_upload_hint');
  const blurNote = $('settings-bg-blur-note');
  if (blurNote) blurNote.textContent = media ? t('settings_bg_blur_note_active') : t('settings_bg_blur_note_empty');

  // Sync active language button
  syncLangButtons();
  syncStyleModeControls();
  syncTopbarStyleControls();
  // Swap the topbar chrome (full bar ⇄ edge rails + island pill) to match.
  if (window.TopbarMinimal) window.TopbarMinimal.apply();
  syncClockFormatControls();
  syncWeekStartControls();
  syncLockWidgetSettings();
  syncAutoOpenBrowserControl();
  syncBrowserAdblockControl();
  syncWeatherSettingsControls();
  syncStocksTickerControls();
  syncAiSettingsControls();
  syncBgFxControls();
  syncGameModeControls();
  syncSensorHistoryControls();
  syncProactiveControls();
  syncNotificationsControls();
  syncVitalsControls();
  syncSdkWidgetsControls();
  syncPerformanceControls();
  syncContextProfileControls();
  syncSecondScreenControls();
  syncDynamicAlbumControls();
  refreshGameModeStatus();
  // The whole RGB hub renders dynamically into Settings → Illuminazione.
  if (window.LightingPage) window.LightingPage.init();
  // Remote Control wizard renders dynamically into Settings → Controllo Remoto.
  if (window.RemoteControl) window.RemoteControl.init();
  // Streaming (Twitch) connect panel renders into Settings → Streaming.
  if (window.StreamingPage) window.StreamingPage.init();
  // Spotify connect card renders into its own Settings → Spotify section.
  if (window.SpotifySettings) window.SpotifySettings.init();
  // Home Assistant connect + device picker renders into Settings → Smart Home.
  if (window.SmartHome && typeof window.SmartHome.initSettings === 'function') window.SmartHome.initSettings();
  // External calendars section — injected dynamically (no HTML change required).
  _initCalendarFeedsSection();
}

function renderSettingsModal() {
  renderSettingsPresets();
  syncSettingsControls();
}

function setSettingsStatus(messageKey, mode) {
  const el = $('settings-status');
  if (!el) return;
  clearTimeout(settingsStatusTimer);
  el.classList.remove('ok', 'error');
  el.dataset.messageKey = messageKey || '';
  if (mode) el.classList.add(mode);
  el.textContent = messageKey ? t(messageKey) : '';
  if (messageKey) settingsStatusTimer = setTimeout(() => setSettingsStatus('', ''), 2600);
}

function syncLangButtons() {
  const sel = document.getElementById('settings-lang-select');
  if (sel && sel.value !== lang) {
    sel.value = lang;
    // Notify the custom-select wrapper (custom-select.js) so its visible label
    // tracks a programmatic language change (e.g. loaded from settings, or set by
    // Xenon AI). setLang() early-returns on an unchanged code, so the onchange
    // handler firing here cannot recurse.
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

let _settingsCat = 'appearance';
function settingsSetCategory(cat) {
  _settingsCat = cat;
  const content = document.getElementById('settings-content');
  if (content) {
    content.dataset.cat = cat;
    content.querySelectorAll('[data-settings-cat]').forEach(el => {
      el.hidden = el.dataset.settingsCat !== cat;
    });
    content.scrollTop = 0;
  }
  document.querySelectorAll('.settings-nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.settingsCat === cat);
  });
}

// The Settings overlay is a full-viewport frosted backdrop (backdrop-filter blur),
// so it triggers the same ambient re-blur flicker as the update dialog on some GPUs
// (issue #56). Freeze the ambient while it's open; the token-set registry keeps it
// frozen if a frosted overlay (e.g. the update dialog) is stacked on top.
function freezeSettingsAmbient(on) {
  try {
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('settings', on);
  } catch { /* ignore */ }
}

function toggleSettings() {
  const overlay = $('settings-overlay');
  if (!overlay) return;
  overlay.hidden = !overlay.hidden;
  if (!overlay.hidden) { renderSettingsModal(); settingsSetCategory(_settingsCat); }
  freezeSettingsAmbient(!overlay.hidden);
}

function closeSettings() {
  const overlay = $('settings-overlay');
  if (overlay) overlay.hidden = true;
  freezeSettingsAmbient(false);
}

function setThemePreset(id) {
  const preset = SETTINGS_PRESETS.find(item => item.id === id);
  if (!preset) return;
  hubSettings = normalizeSettings({ ...hubSettings, accent: preset.accent, background: preset.background, text: preset.text });
  saveHubSettings();
  applyHubSettings();
  renderSettingsModal();
  setSettingsStatus('settings_saved', 'ok');
}

function updateSettingsColor(key, value) {
  if (!['accent', 'background', 'text'].includes(key)) return;
  const hex = normalizeHex(value, null);
  if (!hex) return;
  hubSettings = normalizeSettings({ ...hubSettings, [key]: hex });
  saveHubSettings();
  applyHubSettings();
  renderSettingsPresets(); // aggiorna solo l'evidenziazione dei preset, senza resettare i colori aperti
}

// ── Xenon AI programmatic customization ───────────────────────────
// Apply any subset of {preset, appearance, accent, background, text} in one
// save+repaint, reusing the same validation as the manual controls. Called by
// the AI's customize_appearance tool. Returns true if anything changed.
function applyAiAppearance(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const patch = {};
  if (typeof o.preset === 'string') {
    const preset = SETTINGS_PRESETS.find(p => p.id === o.preset.trim().toLowerCase());
    if (preset) { patch.accent = preset.accent; patch.background = preset.background; patch.text = preset.text; }
  }
  if (['light', 'dark', 'auto'].includes(o.appearance)) patch.appearance = o.appearance;
  for (const key of ['accent', 'background', 'text']) {
    const hex = normalizeHex(o[key], null);
    if (hex) patch[key] = hex;
  }
  if (!Object.keys(patch).length) return false;
  hubSettings = normalizeSettings({ ...hubSettings, ...patch });
  saveHubSettings();
  applyHubSettings();
  if (typeof renderSettingsModal === 'function') renderSettingsModal();
  setSettingsStatus('settings_saved', 'ok');
  return true;
}

// Apply any subset of dashboard preferences the AI's configure_preferences tool
// passed. Each field routes through its existing setter so validation, live
// repaint and persistence match the manual controls exactly.
function applyAiPreferences(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  let changed = false;
  if (['auto', '12', '24'].includes(o.clock_format)) { updateClockFormat(o.clock_format); changed = true; }
  if (['c', 'f'].includes(o.temp_unit)) { updateTempUnit(o.temp_unit); changed = true; }
  if (typeof o.language === 'string' && SUPPORTED_LANGS.includes(o.language) && typeof setLang === 'function') { setLang(o.language); changed = true; }
  if (typeof o.weather_city === 'string' && o.weather_city.trim()) {
    updateWeatherMode('manual');
    updateWeatherCity(o.weather_city.trim(), true);
    changed = true;
  } else if (['auto', 'manual'].includes(o.weather_mode)) {
    updateWeatherMode(o.weather_mode); changed = true;
  }
  if (o.lock_widgets && typeof o.lock_widgets === 'object') {
    ['clock', 'weather', 'media', 'calendar'].forEach(key => {
      if (typeof o.lock_widgets[key] === 'boolean') { updateLockWidgetSetting(key, o.lock_widgets[key]); changed = true; }
    });
  }
  return changed;
}

/* ── Hex text input helper ───────────────────────────────── */

/**
 * Chiamata da oninput/onchange del campo hex testuale.
 * Applica il colore solo se il valore è un hex valido.
 */
function onHexInput(key, rawValue) {
  const input = $(`settings-${key}`);
  const raw = rawValue.trim();
  const hex = normalizeHex(raw.startsWith('#') ? raw : `#${raw}`, null);
  if (!hex) {
    if (input) input.classList.add('invalid');
    return;
  }
  if (input) input.classList.remove('invalid');
  const preview = $(`settings-${key}-swatch`);
  if (preview) preview.style.background = hex;
  updateSettingsColor(key, hex);
}

function updateSettingsRange(key, value) {
  if (!['panelAlpha', 'bgDim', 'bgBlur'].includes(key)) return;
  hubSettings = normalizeSettings({ ...hubSettings, [key]: value });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
}

// ── Background FX controls (aurora + grid) ────────────────────────
function updateBgFx(group, key, value) {
  if (!['bgAurora', 'bgGrid'].includes(group)) return;
  const current = hubSettings[group] && typeof hubSettings[group] === 'object' ? hubSettings[group] : {};
  const next = { ...current, [key]: key === 'enabled' ? !!value : value };
  hubSettings = normalizeSettings({ ...hubSettings, [group]: next });
  saveHubSettings();
  applyHubSettings();
  syncBgFxControls();
}

function updateGridColor(rawValue) {
  const raw = String(rawValue || '').trim();
  const hex = normalizeHex(raw.startsWith('#') ? raw : `#${raw}`, null);
  const input = $('settings-grid-color');
  if (!hex) { if (input) input.classList.add('invalid'); return; }
  if (input) input.classList.remove('invalid');
  const swatch = $('settings-grid-color-swatch');
  if (swatch) swatch.style.background = hex;
  updateBgFx('bgGrid', 'color', hex);
}

// Open the in-app ColorPicker from a settings colour preview (the native colour
// dialog is blocked in the iCUE WebView). `key` is a hub colour key ('accent',
// 'background', 'text') or 'grid' for the neon-grid background colour. Wired
// via onclick on the .settings-color-preview divs in index.html.
function openSettingsColorPicker(key, anchor) {
  if (!window.ColorPicker) return;
  const input = $(key === 'grid' ? 'settings-grid-color' : `settings-${key}`);
  const raw = input ? input.value.trim() : '';
  const value = normalizeHex(raw.startsWith('#') ? raw : `#${raw}`, '#1ed760');
  window.ColorPicker.open({
    anchor, value,
    onPick: (hex) => {
      if (input) input.value = hex.toUpperCase();
      if (key === 'grid') updateGridColor(hex);
      else onHexInput(key, hex);
    },
  });
}

function syncBgFxControls() {
  const a = normalizeBgAurora(hubSettings.bgAurora);
  const g = normalizeBgGrid(hubSettings.bgGrid);
  const setVal = (id, val) => { const el = $(id); if (el) el.value = val; };
  const setChk = (id, on) => { const el = $(id); if (el) el.checked = on; };
  setChk('settings-aurora-enabled', a.enabled);
  setVal('settings-aurora-intensity', String(a.intensity));
  setVal('settings-aurora-speed', String(a.speed));
  setChk('settings-grid-enabled', g.enabled);
  setVal('settings-grid-intensity', String(g.intensity));
  setVal('settings-grid-speed', String(g.speed));
  const colorInput = $('settings-grid-color');
  if (colorInput) { colorInput.value = g.color.toUpperCase(); colorInput.classList.remove('invalid'); }
  const colorSwatch = $('settings-grid-color-swatch');
  if (colorSwatch) colorSwatch.style.background = g.color;
}

// ── Game mode (auto-pause ambient FX during games) ────────────────
let _gamingActive = false; // last server-reported "a game is presenting" state
let _gameModeTimer = null;

// Minimum time the gaming state must hold before we fade the ambient layers in
// or out. Closing windows / Alt-Tabbing briefly flips the foreground through
// fullscreen-shaped windows, which would otherwise toggle body.game-mode rapidly
// and animate the aurora/grid opacity on and off — read as flicker, especially
// the neon grid over a custom background. A short dwell absorbs those blips.
const GAME_MODE_DWELL_MS = 900;

function _gameModeDesired() {
  return _gamingActive && hubSettings.gameMode !== false;
}

// Apply the class immediately — used for direct user actions (toggling the
// setting, reset, settings re-apply), which must take effect at once.
function _evalGameModeClass() {
  if (_gameModeTimer) { clearTimeout(_gameModeTimer); _gameModeTimer = null; }
  document.body.classList.toggle('game-mode', _gameModeDesired());
}

// Called from the SSE 'status' handler with the live gaming flag. Debounced so a
// transient foreground change doesn't visibly fade the ambient FX in/out.
function applyGameMode(gaming) {
  _gamingActive = !!gaming;
  const desired = _gameModeDesired();
  // Already in the desired state (or a pending flip would land where we already
  // are): cancel any pending change and stop — nothing to animate.
  if (desired === document.body.classList.contains('game-mode')) {
    if (_gameModeTimer) { clearTimeout(_gameModeTimer); _gameModeTimer = null; }
    return;
  }
  if (_gameModeTimer) clearTimeout(_gameModeTimer);
  _gameModeTimer = setTimeout(() => {
    _gameModeTimer = null;
    document.body.classList.toggle('game-mode', _gameModeDesired());
  }, GAME_MODE_DWELL_MS);
}

function updateGameMode(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, gameMode: !!enabled });
  saveHubSettings();
  _evalGameModeClass();
  syncGameModeControls();
  setSettingsStatus('settings_saved', 'ok');
}

function syncGameModeControls() {
  const el = $('settings-gamemode-enabled');
  if (el) el.checked = hubSettings.gameMode !== false;
}

// Local sensor-history opt-in (Settings → Performance). Independent of the AI
// Guardian feature: turning this on records CPU/GPU/RAM over time for the history
// charts, with or without any AI. Off by default; the data never leaves the PC.
function updateSensorHistory(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, sensorHistory: { enabled: !!enabled } });
  saveHubSettings();
  syncSensorHistoryControls();
  // Let the System-tile History tab appear/disappear immediately.
  document.dispatchEvent(new CustomEvent('sensor-history-changed'));
  setSettingsStatus('settings_saved', 'ok');
}

function syncSensorHistoryControls() {
  const el = $('settings-senshist-enabled');
  if (el) el.checked = !!(hubSettings.sensorHistory && hubSettings.sensorHistory.enabled === true);
  // Keep the System-tile History tab's visibility in sync on every settings
  // render (initial hydrate included), not only on an explicit toggle.
  if (typeof window.syncSystemHistoryTab === 'function') window.syncSystemHistoryTab();
}

// ── Proactive moments (Settings → Performance) ────────────────────
// Per-type toggles for the briefing engine: sustained-thermal alerts and game
// session recaps are emitted server-side; the morning agenda enriches the
// greeting splash client-side. All default ON, all individually toggleable.
function updateProactive(type, enabled) {
  const cur = hubSettings.proactive || {};
  hubSettings = normalizeSettings({ ...hubSettings, proactive: { ...cur, [type]: !!enabled } });
  saveHubSettings();
  syncProactiveControls();
  setSettingsStatus('settings_saved', 'ok');
}

function syncProactiveControls() {
  const p = hubSettings.proactive || {};
  for (const type of ['thermal', 'recap', 'morning', 'anomaly']) {
    const el = $(`settings-proactive-${type}`);
    if (el) el.checked = p[type] !== false;
  }
}

// ── Third-party widget SDK (Settings → Widgets) ─────────────────────────────
// `patch` is a shallow patch of { enabled, assign, grants }; normalizeSettings
// re-validates the merged object, so a bad patch can never persist bad state.
function updateSdkWidgets(patch) {
  const cur = hubSettings.sdkWidgets || {};
  hubSettings = normalizeSettings({ ...hubSettings, sdkWidgets: { ...cur, ...(patch || {}) } });
  saveHubSettings();
  syncSdkWidgetsControls();
  if (window.CustomWidget && typeof window.CustomWidget.renderWidgets === 'function') window.CustomWidget.renderWidgets();
  setSettingsStatus('settings_saved', 'ok');
}

function syncSdkWidgetsControls() {
  const el = $('settings-sdk-enabled');
  if (el) el.checked = !!(hubSettings.sdkWidgets && hubSettings.sdkWidgets.enabled === true);
}

// ── Master notifications switch (Settings → Notifiche) ──────────────────────
// `enabled` off silences every source and stops the background watchers (server
// re-arms on save); `popups` toggles the on-screen toasts only. Saving posts to
// the server so winNotifWanted()/discordNotifWanted() re-evaluate immediately.
// ── Stocks (Borsa) + ticker settings ──
function syncStocksTickerControls() {
  const s = hubSettings.stocks || {};
  const tk = hubSettings.ticker || {};
  const setVal = (id, v) => { const el = $(id); if (el && el.value !== String(v)) el.value = v; };
  const setChk = (id, v) => { const el = $(id); if (el) el.checked = !!v; };
  setVal('settings-stocks-provider', s.provider || 'auto');
  setVal('settings-stocks-refresh', s.refreshSec != null ? s.refreshSec : 60);
  setVal('settings-stocks-alert', s.alertPercent != null ? s.alertPercent : 2);
  // API keys are server-only (redacted on the wire): show a filled placeholder
  // when one is saved and keep the field blank, mirroring the OBS-password UX.
  const td = $('settings-stocks-twelvedata');
  if (td) { td.value = ''; td.placeholder = hubSettings.twelveDataKeySet ? '••••••••' : '—'; }
  const fh = $('settings-stocks-finnhub');
  if (fh) { fh.value = ''; fh.placeholder = hubSettings.finnhubKeySet ? '••••••••' : '—'; }
  // Football (Calcio)
  const f = hubSettings.football || {};
  setVal('settings-football-refresh', f.refreshSec != null ? f.refreshSec : 120);
  setChk('settings-football-alerts', f.alerts !== false);
  const ft = f.tile || {};
  setChk('settings-football-results', ft.results !== false);
  setChk('settings-football-standings', ft.standings !== false);
  const sk = $('settings-football-sportsdb');
  if (sk) { sk.value = ''; sk.placeholder = hubSettings.sportsDbKeySet ? '••••••••' : '—'; }
  // News
  const nw = hubSettings.news || {};
  setVal('settings-news-refresh', nw.refreshSec != null ? nw.refreshSec : 600);
  setChk('settings-news-images', (nw.tile || {}).images !== false);
  const nk = $('settings-news-newsdata');
  if (nk) { nk.value = ''; nk.placeholder = hubSettings.newsDataKeySet ? '••••••••' : '—'; }
  setChk('settings-ticker-enabled', tk.enabled);
  setVal('settings-ticker-position', tk.position || 'bottom');
  setVal('settings-ticker-speed', tk.speed != null ? tk.speed : 50);
  const src = tk.sources || {};
  setChk('settings-ticker-src-stocks', src.stocks !== false);
  setChk('settings-ticker-src-football', src.football !== false);
  setChk('settings-ticker-src-news', src.news !== false);
}

function updateStocksCfg(patch) {
  const cur = hubSettings.stocks || {};
  hubSettings = normalizeSettings({ ...hubSettings, stocks: { ...cur, ...patch } });
  saveHubSettings();
  syncStocksTickerControls();
}

function updateFootballCfg(patch) {
  const cur = hubSettings.football || {};
  const next = { ...cur, ...patch };
  if (patch && patch.tile) next.tile = { ...(cur.tile || {}), ...patch.tile };
  hubSettings = normalizeSettings({ ...hubSettings, football: next });
  saveHubSettings();
  syncStocksTickerControls();
}

// The TheSportsDB Premium key is a server-only secret: an empty field means
// "leave the saved key untouched" (preserve-on-save), so only send a non-empty
// value. Blank input keeps the placeholder.
function setSportsDbKey(value) {
  const v = String(value || '').trim();
  if (!v) return;
  hubSettings = normalizeSettings({ ...hubSettings, sportsDbKey: v, sportsDbKeySet: true });
  saveHubSettings();
  syncStocksTickerControls();
}

function updateNewsCfg(patch) {
  const cur = hubSettings.news || {};
  const next = { ...cur, ...patch };
  if (patch && patch.tile) next.tile = { ...(cur.tile || {}), ...patch.tile };
  hubSettings = normalizeSettings({ ...hubSettings, news: next });
  saveHubSettings();
  syncStocksTickerControls();
}

// The NewsData.io key is a server-only secret: an empty field means "leave the
// saved key untouched" (preserve-on-save), so only send a non-empty value.
function setNewsDataKey(value) {
  const v = String(value || '').trim();
  if (!v) return;
  hubSettings = normalizeSettings({ ...hubSettings, newsDataKey: v, newsDataKeySet: true });
  saveHubSettings();
  syncStocksTickerControls();
}

function updateTickerCfg(patch) {
  const cur = hubSettings.ticker || {};
  const next = { ...cur, ...patch };
  if (patch && patch.sources) next.sources = { ...(cur.sources || {}), ...patch.sources };
  hubSettings = normalizeSettings({ ...hubSettings, ticker: next });
  saveHubSettings();
  syncStocksTickerControls();
  if (window.Ticker) window.Ticker.apply();   // show/hide/reposition the bar live
}

// API keys are server-only secrets: an empty field means "leave the saved key
// untouched" (preserve-on-save), so we only send a non-empty value.
function setStockApiKey(field, value) {
  if (field !== 'twelveDataKey' && field !== 'finnhubKey') return;
  const v = String(value || '').trim();
  if (!v) return;
  hubSettings = normalizeSettings({ ...hubSettings, [field]: v, [field + 'Set']: true });
  saveHubSettings();
  syncStocksTickerControls();
}

function updateNotifications(field, enabled) {
  if (field !== 'enabled' && field !== 'popups') return;
  const cur = hubSettings.notifications || {};
  hubSettings = normalizeSettings({ ...hubSettings, notifications: { ...cur, [field]: !!enabled } });
  saveHubSettings();
  syncNotificationsControls();
  setSettingsStatus('settings_saved', 'ok');
}

function syncNotificationsControls() {
  const n = hubSettings.notifications || {};
  const enabled = n.enabled !== false;
  const en = $('settings-notif-enabled');
  if (en) en.checked = enabled;
  const pop = $('settings-notif-popups');
  if (pop) { pop.checked = n.popups !== false; pop.disabled = !enabled; }
  // The pop-up sub-toggle is meaningless while notifications are off.
  const row = $('settings-notif-popups-row');
  if (row) row.classList.toggle('is-disabled', !enabled);
}

// ── Vitals (Settings → Notifiche, Vitals card) ──
function updateVitalsSetting(field, enabled) {
  if (!['enabled', 'topbar', 'reminders'].includes(field)) return;
  const cur = hubSettings.vitals || {};
  hubSettings = normalizeSettings({ ...hubSettings, vitals: { ...cur, [field]: !!enabled } });
  saveHubSettings();
  syncVitalsControls();
  if (window.VitalsWidget && typeof window.VitalsWidget.renderWidgets === 'function') window.VitalsWidget.renderWidgets();
  setSettingsStatus('settings_saved', 'ok');
}

function updateVitalItem(id, field, value) {
  if (!VITALS_IDS.includes(id)) return;
  const cur = hubSettings.vitals || {};
  const items = { ...(cur.items || {}) };
  const it = { ...(items[id] || {}) };
  // Guarded: syncVitalsControls dispatches 'change' to re-sync the custom-select
  // label — an unchanged value must be a no-op, not a save.
  if (field === 'on') {
    if ((it.on !== false) === !!value) return;
    it.on = !!value;
  } else if (field === 'min') {
    const next = Math.round(Number(value) || 0);
    if (Number(it.min) === next) return;
    it.min = next;
  } else return;
  items[id] = it;
  hubSettings = normalizeSettings({ ...hubSettings, vitals: { ...cur, items } });
  saveHubSettings();
  syncVitalsControls();
  if (window.VitalsWidget && typeof window.VitalsWidget.renderWidgets === 'function') window.VitalsWidget.renderWidgets();
  setSettingsStatus('settings_saved', 'ok');
}

// ── Bit, the pixel guardian (Settings → Notifiche, Vitals card) ──
function updateVitalsPetSetting(field, value) {
  const FIELDS = ['enabled', 'tone', 'effects', 'sounds', 'monitors', 'minimize', 'lock', 'quietInGame'];
  if (!FIELDS.includes(field)) return;
  const cur = hubSettings.vitals || {};
  const pet = { ...(cur.pet || {}) };
  const next = field === 'tone' ? String(value) : !!value;
  // Guarded like updateVitalItem: syncVitalsControls dispatches 'change' on the
  // tone custom-select — an unchanged value must be a no-op, not a save.
  if (pet[field] === next) return;
  pet[field] = next;
  hubSettings = normalizeSettings({ ...hubSettings, vitals: { ...cur, pet } });
  saveHubSettings();
  syncVitalsControls();
  if (window.VitalsPet && typeof window.VitalsPet.sync === 'function') window.VitalsPet.sync();
  setSettingsStatus('settings_saved', 'ok');
}

function syncVitalsControls() {
  const v = hubSettings.vitals || {};
  const enabled = v.enabled !== false;
  const en = $('settings-vitals-enabled');
  if (en) en.checked = enabled;
  [['settings-vitals-topbar', v.topbar === true], ['settings-vitals-reminders', v.reminders !== false]].forEach(([id, on]) => {
    const box = $(id);
    if (box) { box.checked = on; box.disabled = !enabled; }
    const row = $(id + '-row');
    if (row) row.classList.toggle('is-disabled', !enabled);
  });
  // Bit — the pet master toggle needs Vitals itself on; every sub-control needs
  // the pet on too (mirrors the notifications → popups disable pattern).
  const pet = v.pet || {};
  const petOn = enabled && pet.enabled === true;
  const pen = $('settings-vpet-enabled');
  if (pen) { pen.checked = pet.enabled === true; pen.disabled = !enabled; }
  const penRow = $('settings-vpet-enabled-row');
  if (penRow) penRow.classList.toggle('is-disabled', !enabled);
  [['settings-vpet-effects', pet.effects !== false], ['settings-vpet-sounds', pet.sounds !== false],
   ['settings-vpet-quiet', pet.quietInGame !== false], ['settings-vpet-monitors', pet.monitors === true],
   ['settings-vpet-minimize', pet.minimize === true], ['settings-vpet-lock', pet.lock === true]].forEach(([id, on]) => {
    const box = $(id);
    if (box) { box.checked = on; box.disabled = !petOn; }
    const row = $(id + '-row');
    if (row) row.classList.toggle('is-disabled', !petOn);
  });
  const tone = $('settings-vpet-tone');
  if (tone) {
    tone.disabled = !petOn;
    const want = ['soft', 'spicy', 'savage'].includes(pet.tone) ? pet.tone : 'spicy';
    if (tone.value !== want) {
      tone.value = want;
      tone.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  const toneRow = $('settings-vpet-tone-row');
  if (toneRow) toneRow.classList.toggle('is-disabled', !petOn);
  const items = v.items || {};
  VITALS_IDS.forEach((id) => {
    const it = items[id] || {};
    const chk = $('settings-vital-' + id);
    if (chk) { chk.checked = it.on !== false; chk.disabled = !enabled; }
    const sel = $('settings-vital-' + id + '-min');
    if (sel) {
      sel.disabled = !enabled;
      const want = String(it.min || VITALS_DEFAULT_MIN[id]);
      if (sel.value !== want) {
        sel.value = want;
        // The custom-select overlay re-syncs its visible label on 'change'; the
        // guarded updateVitalItem makes this dispatch a no-op for persistence.
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const row = $('settings-vital-' + id + '-row');
    if (row) row.classList.toggle('is-disabled', !enabled);
  });
}

// ── Discord notification mirroring (Settings → Streaming, Discord card) ──
// The toggles live inside the dynamically-built streaming card (streaming-page.js),
// which reads hubSettings.discordNotifications at build time — so there's no
// static control to sync here; saving is enough.
function updateDiscordNotifications(field, enabled) {
  const cur = hubSettings.discordNotifications || {};
  hubSettings = normalizeSettings({ ...hubSettings, discordNotifications: { ...cur, [field]: !!enabled } });
  saveHubSettings();
  setSettingsStatus('settings_saved', 'ok');
}

// ── Windows notification mirroring (the Notifications tile) ──────────────
// The controls live inside the tile itself (notifications-widget.js); this is
// its single write path. `value` is a boolean for enabled/hide and the whole
// {id,name} array for excluded — normalizeWindowsNotifications bounds it all.
function updateWindowsNotifications(field, value) {
  const cur = hubSettings.windowsNotifications || {};
  hubSettings = normalizeSettings({ ...hubSettings, windowsNotifications: { ...cur, [field]: value } });
  saveHubSettings();
  setSettingsStatus('settings_saved', 'ok');
}

// ── Smart context profiles (Settings → Performance) ───────────────
// Per-activity page/lighting/deck that auto-switch when the foreground activity
// changes; context-profiles.js applies them and reverts on exit. Opt-in.
function _saveContextProfiles(patch) {
  const prev = normalizeContextProfiles(hubSettings.contextProfiles);
  const next = { ...prev, ...patch, map: { ...prev.map, ...(patch.map || {}) } };
  hubSettings = normalizeSettings({ ...hubSettings, contextProfiles: next });
  saveHubSettings();
  if (window.ContextProfiles && typeof window.ContextProfiles.refresh === 'function') window.ContextProfiles.refresh();
}

function updateContextEnabled(enabled) {
  _saveContextProfiles({ enabled: !!enabled });
  syncContextProfileControls();
  setSettingsStatus('settings_saved', 'ok');
}

function updateContextRevert(revert) {
  _saveContextProfiles({ revertOnExit: !!revert });
  setSettingsStatus('settings_saved', 'ok');
}

// One dimension (page | lighting | deck | style) of one activity's profile
// changed. The custom-select updates its own visible label, so no full
// re-render is needed.
function updateContextMap(activity, dim, value) {
  if (!PERF_ACTIVITIES.includes(activity) || !['page', 'lighting', 'deck', 'style'].includes(dim)) return;
  const prev = normalizeContextProfiles(hubSettings.contextProfiles);
  const entry = { ...prev.map[activity], [dim]: value || '' };
  _saveContextProfiles({ map: { [activity]: entry } });
  setSettingsStatus('settings_saved', 'ok');
}

function resetContextProfiles() {
  const empty = {};
  for (const act of PERF_ACTIVITIES) empty[act] = { page: '', lighting: '', deck: '', style: '' };
  _saveContextProfiles({ map: empty });
  syncContextProfileControls();
  setSettingsStatus('settings_saved', 'ok');
}

function syncContextProfileControls() {
  const c = normalizeContextProfiles(hubSettings.contextProfiles);
  const en = $('settings-ctxprof-enabled');
  if (en) en.checked = c.enabled;
  const rev = $('settings-ctxprof-revert');
  if (rev) rev.checked = c.revertOnExit;
  const wrap = $('settings-ctxprof-options');
  if (wrap) wrap.classList.toggle('is-disabled', !c.enabled);
  renderContextProfileRows(c);
}

// One row per detectable activity, each with a Page / Lighting / Deck / Style
// dropdown. Options come from the live layout + deck instances, so they always
// match what the user has. Native <select data-custom-select> for consistent style.
function renderContextProfileRows(c) {
  const mount = $('settings-ctxprof-rows');
  if (!mount) return;
  const tr = (k) => (typeof t === 'function' ? t(k) : k);
  const pages = (hubSettings.dashboardLayout && Array.isArray(hubSettings.dashboardLayout.pages))
    ? hubSettings.dashboardLayout.pages : [];
  const pageLabel = (p) => p.name || (p.nameKey ? tr(p.nameKey) : '') || p.id;
  let deckProfiles = [];
  try { if (window.Deck && Deck.listProfiles) deckProfiles = Deck.listProfiles().map(p => p.name); } catch { deckProfiles = []; }
  const lightingOpts = [
    ['', 'context_none'], ['none', 'context_light_off'], ['solid', 'context_light_solid'],
    ['breathing', 'context_light_breathing'], ['cycle', 'context_light_cycle'],
  ];

  mount.textContent = '';
  for (const act of PERF_ACTIVITIES) {
    const entry = (c.map && c.map[act]) || { page: '', lighting: '', deck: '' };
    const row = document.createElement('div');
    row.className = 'settings-ctxprof-row';

    const label = document.createElement('span');
    label.className = 'settings-ctxprof-act';
    label.setAttribute('data-i18n', 'settings_perf_act_' + act);
    label.textContent = tr('settings_perf_act_' + act);
    row.appendChild(label);

    const selects = document.createElement('div');
    selects.className = 'settings-ctxprof-selects';
    selects.appendChild(buildContextSelect(act, 'page', entry.page,
      [{ value: '', label: tr('context_none') }].concat(pages.map(p => ({ value: p.id, label: pageLabel(p) })))));
    selects.appendChild(buildContextSelect(act, 'lighting', entry.lighting,
      lightingOpts.map(([value, key]) => ({ value, label: tr(key) }))));
    selects.appendChild(buildContextSelect(act, 'deck', entry.deck,
      [{ value: '', label: tr('context_none') }].concat(deckProfiles.map(n => ({ value: n, label: n })))));
    selects.appendChild(buildContextSelect(act, 'style', entry.style, [
      { value: '', label: tr('context_none') },
      { value: 'glass', label: tr('settings_style_glass') },
      { value: 'retro', label: tr('settings_style_retro') },
    ]));
    row.appendChild(selects);
    mount.appendChild(row);
  }
  if (typeof initAllCustomSelects === 'function') initAllCustomSelects(mount);
}

function buildContextSelect(activity, dim, current, options) {
  const sel = document.createElement('select');
  sel.className = 'settings-ctxprof-select';
  sel.setAttribute('data-custom-select', '');
  sel.setAttribute('data-cs-fixed', ''); // Settings body scrolls; anchor the panel
  sel.setAttribute('aria-label', dim);
  let hasCurrent = false;
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === current) { opt.selected = true; hasCurrent = true; }
    sel.appendChild(opt);
  }
  // A previously-picked page/deck that no longer exists stays selectable, so the
  // user can see and clear it instead of it silently snapping to "none".
  if (!hasCurrent && current) {
    const opt = document.createElement('option');
    opt.value = current; opt.textContent = current; opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => updateContextMap(activity, dim, sel.value));
  return sel;
}

// ── Performance Mode (Settings → Performance) ─────────────────────
// The heavy lifting (apply/restore, auto-suggest banner, confirmation sheet)
// lives in performance.js (window.Performance). These handlers persist the
// user's choices and let the controller re-evaluate. Opt-in, off by default.
function _savePerformance(patch) {
  const prev = normalizePerformance(hubSettings.performance);
  const next = { ...prev, ...patch, opts: { ...prev.opts, ...(patch.opts || {}) } };
  hubSettings = normalizeSettings({ ...hubSettings, performance: next });
  saveHubSettings();
  if (window.PerfMode && typeof window.PerfMode.refresh === 'function') window.PerfMode.refresh();
}

function updatePerformanceEnabled(enabled) {
  _savePerformance({ enabled: !!enabled });
  syncPerformanceControls();
  setSettingsStatus('settings_saved', 'ok');
}

// Single 3-state mode selector (replaces the old autoSuggest + autoMode pair).
//   'manual'  → only acts on "Optimize now"        (autoSuggest off, autoMode 'suggest')
//   'suggest' → banner when a tracked activity starts (autoSuggest on, autoMode 'suggest')
//   'auto'    → applies by itself, restores on exit  (autoMode 'auto')
// Mapped onto the two persisted fields so existing installs stay compatible.
function updatePerformanceMode(mode) {
  if (mode === 'auto') _savePerformance({ autoMode: 'auto' });
  else _savePerformance({ autoSuggest: mode === 'suggest', autoMode: 'suggest' });
  syncPerformanceControls();
  setSettingsStatus('settings_saved', 'ok');
}

// Toggle which activity auto-suggests (any of PERF_ACTIVITIES).
function updatePerformanceActivity(activity, enabled) {
  if (!PERF_ACTIVITIES.includes(activity)) return;
  const cur = normalizePerformance(hubSettings.performance);
  _savePerformance({ autoActivities: { ...cur.autoActivities, [activity]: !!enabled } });
  setSettingsStatus('settings_saved', 'ok');
}

// ── Per-activity trigger apps (add/remove vs the built-in defaults) ──
function _perfIsDefaultApp(activity, name) {
  const defs = (window.PerfMode && window.PerfMode.defaultApps) ? window.PerfMode.defaultApps(activity) : [];
  return defs.includes(name);
}

function _savePerformanceActivityApps(activity, lists) {
  const cur = normalizePerformance(hubSettings.performance).activityApps;
  _savePerformance({ activityApps: { ...cur, [activity]: lists } });
  renderPerformanceTriggerApps();
}

function addPerformanceTriggerApp(activity, inputEl) {
  if (!inputEl) return;
  const name = String(inputEl.value || '').toLowerCase().trim().replace(/\.exe$/, '');
  inputEl.value = '';
  if (!PERF_ACTIVITIES.includes(activity) || !/^[a-z0-9._+\-]{1,40}$/.test(name)) return;
  const cur = normalizePerformance(hubSettings.performance).activityApps[activity];
  const add = cur.add.slice();
  let remove = cur.remove.slice();
  if (_perfIsDefaultApp(activity, name)) {
    remove = remove.filter(n => n !== name); // re-enable a previously removed default
  } else if (!add.includes(name)) {
    add.push(name);
  }
  _savePerformanceActivityApps(activity, { add, remove });
}

function removePerformanceTriggerApp(activity, name) {
  if (!PERF_ACTIVITIES.includes(activity)) return;
  const cur = normalizePerformance(hubSettings.performance).activityApps[activity];
  let add = cur.add.slice();
  const remove = cur.remove.slice();
  if (_perfIsDefaultApp(activity, name)) {
    if (!remove.includes(name)) remove.push(name); // drop a default
  } else {
    add = add.filter(n => n !== name);
  }
  _savePerformanceActivityApps(activity, { add, remove });
}

// Build the chip editors (one per activity) into #settings-perf-app-editor.
function renderPerformanceTriggerApps() {
  const host = $('settings-perf-app-editor');
  if (!host) return;
  host.textContent = '';
  const activities = [
    ['gaming', 'settings_perf_act_gaming'],
    ['coding', 'settings_perf_act_coding'],
    ['writing', 'settings_perf_act_writing'],
    ['streaming', 'settings_perf_act_streaming'],
    ['creating', 'settings_perf_act_creating'],
    ['meeting', 'settings_perf_act_meeting'],
  ];
  for (const [activity, labelKey] of activities) {
    const block = document.createElement('div');
    block.className = 'perf-app-block';
    const head = document.createElement('div');
    head.className = 'perf-app-block-title';
    head.textContent = t(labelKey);
    block.appendChild(head);

    const chips = document.createElement('div');
    chips.className = 'perf-app-chips';
    const eff = (window.PerfMode && window.PerfMode.effectiveApps) ? window.PerfMode.effectiveApps(activity) : [];
    if (!eff.length) {
      const empty = document.createElement('span');
      empty.className = 'perf-app-empty settings-note';
      empty.textContent = t('settings_perf_apps_none') || '—';
      chips.appendChild(empty);
    }
    for (const name of eff) {
      const chip = document.createElement('span');
      chip.className = 'perf-app-chip';
      const label = document.createElement('span');
      label.textContent = name;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'perf-app-chip-x';
      x.textContent = '×';
      x.setAttribute('aria-label', 'remove');
      x.addEventListener('click', () => removePerformanceTriggerApp(activity, name));
      chip.appendChild(label);
      chip.appendChild(x);
      chips.appendChild(chip);
    }
    block.appendChild(chips);

    const addRow = document.createElement('div');
    addRow.className = 'perf-app-add';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'perf-app-input';
    input.placeholder = t('settings_perf_app_add') || 'app.exe';
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPerformanceTriggerApp(activity, input); } });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-btn perf-app-add-btn';
    btn.textContent = '+';
    btn.addEventListener('click', () => addPerformanceTriggerApp(activity, input));
    addRow.appendChild(input);
    addRow.appendChild(btn);
    block.appendChild(addRow);

    host.appendChild(block);
  }
}

function updatePerformanceUseAi(enabled) {
  _savePerformance({ useAi: !!enabled });
  setSettingsStatus('settings_saved', 'ok');
}

function updatePerformancePauseAnim(enabled) {
  _savePerformance({ opts: { pauseAnimations: !!enabled } });
  setSettingsStatus('settings_saved', 'ok');
}

// Phase 1 surfaces the power plan as a single high-performance toggle; the data
// model still supports 'ultimate' for later use.
function updatePerformancePowerPlan(enabled) {
  _savePerformance({ opts: { powerPlan: enabled ? 'high' : 'none' } });
  setSettingsStatus('settings_saved', 'ok');
}

function updatePerformanceManageApps(enabled) {
  _savePerformance({ opts: { manageApps: !!enabled } });
  setSettingsStatus('settings_saved', 'ok');
}

function updatePerformancePriority(enabled) {
  _savePerformance({ opts: { priorityBoost: !!enabled } });
  setSettingsStatus('settings_saved', 'ok');
}

// Pause the heavy live tiles (Browser, future second screen) while gaming or an
// optimization session is active. Off = let them keep streaming during games.
function updatePerformancePauseStreams(enabled) {
  _savePerformance({ opts: { pauseStreams: !!enabled } });
  setSettingsStatus('settings_saved', 'ok');
}

function optimizePerformanceNow() {
  if (window.PerfMode && typeof window.PerfMode.optimize === 'function') window.PerfMode.optimize();
}

function restorePerformance() {
  if (window.PerfMode && typeof window.PerfMode.restore === 'function') window.PerfMode.restore();
}

function syncPerformanceControls() {
  const p = normalizePerformance(hubSettings.performance);
  const setChecked = (id, checked) => { const el = $(id); if (el) el.checked = checked; };
  setChecked('settings-perf-enabled', p.enabled);
  // Derive the 3-state mode from the two persisted fields and reflect it onto
  // the segmented control + its dynamic description line.
  const mode = p.autoMode === 'auto' ? 'auto' : (p.autoSuggest ? 'suggest' : 'manual');
  const seg = $('settings-perf-mode');
  if (seg) {
    seg.querySelectorAll('.settings-seg-btn').forEach(b => {
      const on = b.dataset.mode === mode;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  const modeHint = $('settings-perf-mode-hint');
  if (modeHint) {
    const key = 'settings_perf_mode_' + mode + '_hint';
    modeHint.setAttribute('data-i18n', key);
    if (typeof t === 'function') modeHint.textContent = t(key);
  }
  for (const act of PERF_ACTIVITIES) setChecked('settings-perf-act-' + act, p.autoActivities[act]);
  // Activities (and their trigger-app editor) only matter when an automatic
  // mode is active; hide the whole block in manual mode.
  const actRow = $('settings-perf-activities');
  if (actRow) actRow.hidden = (mode === 'manual');
  renderPerformanceTriggerApps();
  setChecked('settings-perf-useai', p.useAi);
  setChecked('settings-perf-pauseanim', p.opts.pauseAnimations);
  setChecked('settings-perf-powerplan', p.opts.powerPlan !== 'none');
  setChecked('settings-perf-manageapps', p.opts.manageApps);
  setChecked('settings-perf-priority', p.opts.priorityBoost);
  setChecked('settings-perf-pausestreams', p.opts.pauseStreams);
  // Grey out the detail rows while the master toggle is off.
  const wrap = $('settings-perf-options');
  if (wrap) wrap.classList.toggle('is-disabled', !p.enabled);
}

// ── Second-screen capture settings ────────────────────────────────
// fps/quality just tune the live stream (the tile reads them on its next start).
// Resolution + remove drive the virtual display itself via the server's elevated
// create-display / remove-display (UAC) — surfaced with a clear status line.
// Guards the onchange handlers against the synthetic 'change' events we dispatch
// to refresh the custom-select labels during a programmatic sync.
let _ssSyncing = false;

function _saveSecondScreen(patch) {
  const cur = normalizeSecondScreen(hubSettings.secondScreen);
  hubSettings = normalizeSettings({ ...hubSettings, secondScreen: { ...cur, ...patch } });
  saveHubSettings({ server: true });
  syncSecondScreenControls();
}

function updateSecondScreenFps(value) {
  if (_ssSyncing) return;
  _saveSecondScreen({ fps: parseInt(value, 10) });
  setSettingsStatus('settings_saved', 'ok');
}

function updateSecondScreenQuality(value) {
  if (_ssSyncing) return;
  _saveSecondScreen({ quality: parseInt(value, 10) });
  setSettingsStatus('settings_saved', 'ok');
}

function updateSecondScreenResolution(value) {
  if (_ssSyncing) return;
  const parts = String(value || '').split('x');
  const width = parseInt(parts[0], 10);
  const height = parseInt(parts[1], 10);
  if (width && height) _saveSecondScreen({ width, height });
}

// Apply the chosen resolution to the virtual display. The server commits the mode
// live (no UAC in the common case); only first-time setup or a never-advertised
// mode falls back to the elevated, idempotent device (re)create. On success the
// tile is told to re-request its stream so the new size shows immediately.
async function applySecondScreenResolution(btn) {
  const s = normalizeSecondScreen(hubSettings.secondScreen);
  const status = $('settings-secondscreen-status');
  if (btn) btn.disabled = true;
  if (status) { status.hidden = false; status.textContent = t('second_screen_working'); }
  try {
    const res = await fetch('/second-screen/apply-resolution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: { width: s.width, height: s.height } }),
    }).then((r) => r.json());
    if (status) {
      if (res && res.code === 'display_needs_reboot') status.textContent = t('second_screen_reboot');
      else if (res && res.ok) status.textContent = t('second_screen_applied');
      else status.textContent = t('second_screen_install_failed');
    }
    if (res && res.ok && res.code !== 'display_needs_reboot') {
      window.dispatchEvent(new CustomEvent('second-screen-mode-changed'));
    }
  } catch (e) {
    if (status) status.textContent = t('second_screen_install_failed');
  }
  if (btn) btn.disabled = false;
}

// Remove the virtual display (disable / cleanup). Elevated, and destructive (the
// extra monitor and anything on it goes away), so confirm first — mirrors the
// page-delete confirmation pattern.
async function removeSecondScreenDisplay(btn) {
  const status = $('settings-secondscreen-status');
  const msg = (typeof t === 'function') ? t('second_screen_remove_confirm')
    : 'Remove the virtual second screen? Windows will close it and move any open windows back. You can re-create it anytime from here.';
  if (typeof confirm === 'function' && !confirm(msg)) return;
  if (btn) btn.disabled = true;
  if (status) { status.hidden = false; status.textContent = t('second_screen_working'); }
  try {
    const res = await fetch('/second-screen/remove-display', { method: 'POST' }).then((r) => r.json());
    if (status) status.textContent = res && res.ok ? t('second_screen_removed') : t('second_screen_install_failed');
  } catch (e) {
    if (status) status.textContent = t('second_screen_install_failed');
  }
  if (btn) btn.disabled = false;
}

// Persist the tile's fill mode ('contain' | 'cover'). Called from the second-screen
// tile's toolbar toggle; routed through here so it survives reloads/restarts like
// the other second-screen prefs. Exposed on window for the tile's separate scope.
function setSecondScreenFit(fit) {
  _saveSecondScreen({ fit: fit === 'cover' ? 'cover' : 'contain' });
}
window.setSecondScreenFit = setSecondScreenFit;

// Persist whether finger touch controls the virtual screen or scrolls the
// dashboard. Toggled from the tile's toolbar; exposed for the tile's scope.
function setSecondScreenTouchControl(on) {
  _saveSecondScreen({ touchControl: !!on });
}
window.setSecondScreenTouchControl = setSecondScreenTouchControl;

// Persist the quick FPS/quality presets picked from the tile's on-tile tune
// panel — same store the Settings selects use, so both UIs stay in sync
// (_saveSecondScreen re-syncs the selects). Exposed for the tile's scope.
function setSecondScreenCapture(fps, quality) {
  const patch = {};
  if (Number.isFinite(fps)) patch.fps = fps;
  if (Number.isFinite(quality)) patch.quality = quality;
  if (Object.keys(patch).length) _saveSecondScreen(patch);
}
window.setSecondScreenCapture = setSecondScreenCapture;

function syncSecondScreenControls() {
  const s = normalizeSecondScreen(hubSettings.secondScreen);
  _ssSyncing = true;
  // Set value then fire 'change' so the custom-select labels refresh; our own
  // onchange handlers no-op while _ssSyncing is set.
  const setVal = (id, val) => {
    const el = $(id);
    if (!el) return;
    el.value = String(val);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  setVal('settings-secondscreen-fps', s.fps);
  setVal('settings-secondscreen-quality', s.quality);
  setVal('settings-secondscreen-resolution', s.width + 'x' + s.height);
  _ssSyncing = false;
}

// ── Dynamic album-art accent toggle ───────────────────────────────
function updateDynamicAlbumTheme(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, dynamicAlbumTheme: !!enabled });
  saveHubSettings();
  if (!enabled) _dynamicAccent = null;
  applyAccentColor();
  syncDynamicAlbumControls();
  // Re-tint immediately from the current track when turning the feature on.
  if (enabled && typeof refreshAlbumAccent === 'function') refreshAlbumAccent();
  setSettingsStatus('settings_saved', 'ok');
}

function syncDynamicAlbumControls() {
  const el = $('settings-dynamic-album');
  if (el) el.checked = hubSettings.dynamicAlbumTheme !== false;
}

// ── Lighting settings (Settings → Illuminazione) ──────────────────
// The full RGB hub (master, brightness, manual colour, animation, reactive
// effects, event flashes, iCUE devices, external providers) renders dynamically
// via lighting-page.js into #settings-lighting-hub and persists through
// /api/lighting/*. syncSettingsControls() calls window.LightingPage.init().

// Reveal the install button only when PresentMon (the game-detection tool) is missing.
async function refreshGameModeStatus() {
  const row = $('settings-gamemode-install-row');
  if (!row) return;
  try {
    const res = await fetch(SERVER + '/api/gamemode/status');
    if (!res.ok) throw new Error('status unavailable');
    const data = await res.json();
    row.hidden = !!data.presentMonAvailable;
  } catch {
    // If we can't tell, hide the button rather than nag — the server may be old.
    row.hidden = true;
  }
}

async function installPresentMon(btn) {
  if (!btn) return;
  btn.disabled = true;
  setSettingsStatus('settings_gamemode_installing', 'ok');
  try {
    const res = await fetch(SERVER + '/api/gamemode/install-presentmon', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error('install failed');
    setSettingsStatus('settings_gamemode_installed', 'ok');
    await refreshGameModeStatus();
  } catch {
    setSettingsStatus('settings_gamemode_install_failed', 'error');
    btn.disabled = false;
  }
}

function syncLockWidgetSettings() {
  const widgets = normalizeLockWidgets(hubSettings.lockWidgets);
  Object.entries(widgets).forEach(([key, enabled]) => {
    const input = $(`settings-lock-${key}`);
    if (input) input.checked = enabled;
  });
}

function updateLockWidgetSetting(key, enabled) {
  if (!['clock', 'weather', 'media', 'calendar'].includes(key)) return;
  hubSettings = normalizeSettings({
    ...hubSettings,
    lockWidgets: { ...hubSettings.lockWidgets, [key]: !!enabled },
  });
  saveHubSettings();
  syncLockWidgetSettings();
  if (typeof refreshLockScreen === 'function') refreshLockScreen();
  setSettingsStatus('settings_saved', 'ok');
}

// ── "Open dashboard in browser at logon" toggle ──────────────────────
// Real-browser-only: inside the Xeneon Edge iCUE iframe the iframe loads the
// dashboard itself, so the toggle is meaningless there and is hidden. We detect
// the embedded case with window.top !== window.self (cross-origin safe — access
// throws, which we treat as embedded). On non-Windows the server reports it
// unsupported and the row stays hidden.
let _autoOpenSupported = null; // null = unknown until the server reconcile runs

function isEmbeddedView() {
  try { return window.top !== window.self; } catch { return true; }
}

function syncAutoOpenBrowserControl() {
  const row = $('settings-auto-open-row');
  const check = $('settings-auto-open');
  if (!row || !check) return;
  // Hide inside the Edge iframe, or where the server says it isn't supported.
  // Use display (not the `hidden` attribute) because the settings category
  // switcher owns `hidden` to show/hide whole category groups — toggling it here
  // would fight that. display:none wins regardless of the category state.
  const hide = isEmbeddedView() || _autoOpenSupported === false;
  row.style.display = hide ? 'none' : '';
  check.checked = hubSettings.autoOpenBrowser !== false;
}

// ── Swipe-to-page navigation ────────────────────────────────────────────────
// Reflects the checkbox and re-applies the gesture on the pager (native
// horizontal scroll + JS drag-pan). Default on; disabling keeps dot/keyboard
// navigation working.
function syncSwipeNavigationControl() {
  const el = $('settings-swipe-nav');
  if (el) el.checked = hubSettings.swipeNavigation !== false;
}

function updateSwipeNavigation(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, swipeNavigation: checked === true });
  saveHubSettings();
  syncSwipeNavigationControl();
  if (window.DashboardPager && DashboardPager.refreshSwipe) DashboardPager.refreshSwipe();
}

function updateAutoOpenBrowser(checked) {
  const enabled = checked === true;
  hubSettings = normalizeSettings({ ...hubSettings, autoOpenBrowser: enabled });
  saveHubSettings();
  syncAutoOpenBrowserControl();
  // Register/remove the actual logon task. The setting persists regardless; if
  // the task call fails we surface it instead of pretending it worked.
  fetch('/startup/auto-open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }).then(r => r.json()).then(data => {
    if (data && data.supported === false) { _autoOpenSupported = false; syncAutoOpenBrowserControl(); return; }
    if (!data || data.ok !== true) { setSettingsStatus('settings_error', 'error'); return; }
    setSettingsStatus('settings_saved', 'ok');
  }).catch(() => setSettingsStatus('settings_error', 'error'));
}

// Brings the real scheduled task in line with the user's saved intent — but
// only from a standalone browser, never from the Edge iframe. So a pure-Edge
// install never registers a browser-open task (no surprise tab), while a
// browser user gets auto-open from their first visit onward.
async function reconcileAutoOpenBrowser() {
  if (isEmbeddedView()) { syncAutoOpenBrowserControl(); return; }
  try {
    const res = await fetch('/startup/auto-open', { cache: 'no-store' });
    if (!res.ok) { syncAutoOpenBrowserControl(); return; } // old server / not yet restarted
    const data = await res.json().catch(() => ({}));
    if (!data || data.supported === false) { _autoOpenSupported = false; syncAutoOpenBrowserControl(); return; }
    _autoOpenSupported = true;
    const want = hubSettings.autoOpenBrowser !== false;
    if (data.enabled !== want) {
      await fetch('/startup/auto-open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: want }),
      }).catch(() => {});
    }
  } catch { /* leave row as-is; non-fatal */ }
  syncAutoOpenBrowserControl();
}

// ── Browser tile ad-blocker (Settings → Browser) ──────────────────────────────
let _browserAdblockBusy = false;   // guards against re-entrancy while installing

function setBrowserAdblockStatus(messageKey, mode) {
  const el = $('settings-browser-adblock-status');
  if (!el) return;
  if (!messageKey) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.classList.remove('ok', 'error');
  if (mode) el.classList.add(mode);
  el.textContent = t(messageKey);
}

function syncBrowserAdblockControl() {
  const check = $('settings-browser-adblock');
  if (!check) return;
  check.checked = hubSettings.browserAdblock === true;
  check.disabled = _browserAdblockBusy;
  if (!_browserAdblockBusy) setBrowserAdblockStatus('', '');
  // Reflect server state (Edge availability + an install in flight elsewhere). This
  // only mirrors the server transiently — it must NOT latch _browserAdblockBusy,
  // which is owned solely by this tab's own toggle, or the checkbox could stick
  // disabled forever after another dashboard's install finishes.
  fetch('/embedded-browser/adblock', { cache: 'no-store' })
    .then(r => r.json())
    .then(d => {
      if (!d || _browserAdblockBusy) return;   // this tab's own install owns the UI
      if (d.available === false) { check.disabled = true; setBrowserAdblockStatus('browser_unavailable', 'error'); }
      else if (d.busy) { check.disabled = true; setBrowserAdblockStatus('settings_browser_adblock_installing', ''); }
      else { check.disabled = false; setBrowserAdblockStatus('', ''); }
    })
    .catch(() => { /* old server / not restarted — leave the control as-is */ });
}

async function toggleBrowserAdblock(checked) {
  const check = $('settings-browser-adblock');
  const enabled = checked === true;
  if (_browserAdblockBusy) { if (check) check.checked = hubSettings.browserAdblock === true; return; }

  // Turning it on the first time downloads the extension. Show progress and revert
  // the toggle if the one-click install fails, so the user never ends up "enabled"
  // with nothing loaded.
  if (enabled) {
    _browserAdblockBusy = true;
    if (check) check.disabled = true;
    setBrowserAdblockStatus('settings_browser_adblock_installing', '');
    try {
      const res = await fetch('/embedded-browser/adblock/install', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!data || data.ok !== true || data.installed !== true) throw new Error('install_failed');
    } catch (e) {
      _browserAdblockBusy = false;
      if (check) { check.disabled = false; check.checked = hubSettings.browserAdblock === true; }
      setBrowserAdblockStatus('settings_browser_adblock_error', 'error');
      return;
    }
    _browserAdblockBusy = false;
    if (check) check.disabled = false;
  }

  hubSettings = normalizeSettings({ ...hubSettings, browserAdblock: enabled });
  saveHubSettings({ server: true });
  setBrowserAdblockStatus(enabled ? 'settings_browser_adblock_on' : 'settings_browser_adblock_off', 'ok');
  // Flush the save immediately (not just the 250 ms debounce) and WAIT for it: the
  // server tears the headless Edge down when browserAdblock changes, and that must
  // happen before we re-open the tiles — otherwise restart() would reopen against
  // the still-running old Edge and the toggle wouldn't take effect until next launch.
  // Cancel the debounced duplicate first, so a second /settings POST can't land
  // AFTER restart() and tear the freshly-relaunched Edge back down.
  clearTimeout(settingsServerSaveTimer); settingsServerSaveTimer = null;
  try { await postHubSettingsToServer(); } catch { /* saveLocalHubSettings already persisted it locally */ }
  try { if (window.BrowserTile && typeof window.BrowserTile.restart === 'function') window.BrowserTile.restart(); } catch { /* ignore */ }
}

function syncWeatherSettingsControls() {
  const weather = normalizeWeatherSettings(hubSettings.weather);
  document.querySelectorAll('.settings-weather-mode[data-weather-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.weatherMode === weather.mode);
    btn.setAttribute('aria-pressed', String(btn.dataset.weatherMode === weather.mode));
  });
  const cityInput = $('settings-weather-city');
  if (cityInput) {
    cityInput.value = weather.city;
    cityInput.disabled = weather.mode !== 'manual';
    cityInput.classList.toggle('disabled', weather.mode !== 'manual');
  }
  const unit = hubSettings.tempUnit === 'f' ? 'f' : 'c';
  document.querySelectorAll('.settings-temp-unit[data-temp-unit]').forEach(btn => {
    const active = btn.dataset.tempUnit === unit;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  const providerSelect = $('settings-weather-provider');
  if (providerSelect && providerSelect.value !== weather.provider) {
    providerSelect.value = weather.provider;
    // The custom-select overlay re-syncs its visible label on 'change'; the
    // guarded updateWeatherProvider makes this dispatch a no-op for persistence.
    providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const refreshSelect = $('settings-weather-refresh');
  if (refreshSelect && refreshSelect.value !== String(weather.refreshMin)) {
    refreshSelect.value = String(weather.refreshMin);
    // Guarded updateWeatherRefresh makes this label-sync dispatch a no-op for persistence.
    refreshSelect.dispatchEvent(new Event('change', { bubbles: true }));
  }
  WEATHER_TILE_SECTIONS.forEach(key => {
    const cb = $('settings-weather-tile-' + key);
    if (cb) cb.checked = weather.tile[key] !== false;
  });
  WEATHER_FIELD_IDS.forEach(id => {
    const cb = $('settings-weather-field-' + id);
    if (cb) cb.checked = weather.tile.fields[id] !== false;
  });
}

function queueWeatherSettingsRefresh(delay = 0) {
  clearTimeout(weatherSettingsFetchTimer);
  weatherSettingsFetchTimer = setTimeout(() => {
    weatherSettingsFetchTimer = null;
    if (typeof fetchWeather === 'function') fetchWeather();
  }, delay);
}

function updateWeatherProvider(provider) {
  if (!WEATHER_PROVIDER_IDS.includes(provider)) return;
  // No-op when unchanged. This also makes the programmatic `change` dispatched by
  // syncWeatherSettingsControls (to refresh the custom-select label) harmless.
  if (normalizeWeatherSettings(hubSettings.weather).provider === provider) return;
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, provider },
  });
  saveHubSettings();
  syncWeatherSettingsControls();
  queueWeatherSettingsRefresh();
  setSettingsStatus('settings_weather_saved', 'ok');
}

// Change how often the client re-fetches weather. Restarts the polling timer so
// the new cadence takes effect immediately (no reload needed).
function updateWeatherRefresh(value) {
  const min = Number(value);
  if (!WEATHER_REFRESH_CHOICES.includes(min)) return;
  // No-op when unchanged (also neutralizes the sync-triggered 'change' dispatch).
  if (normalizeWeatherSettings(hubSettings.weather).refreshMin === min) return;
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, refreshMin: min },
  });
  saveHubSettings();
  syncWeatherSettingsControls();
  if (typeof startWeatherPolling === 'function') startWeatherPolling();
  setSettingsStatus('settings_weather_saved', 'ok');
}

function updateWeatherTileSection(key, checked) {
  if (!WEATHER_TILE_SECTIONS.includes(key)) return;
  const tile = { ...normalizeWeatherTile(hubSettings.weather && hubSettings.weather.tile), [key]: !!checked };
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, tile },
  });
  saveHubSettings();
  syncWeatherSettingsControls();
  if (typeof renderWeatherTile === 'function') renderWeatherTile();
  setSettingsStatus('settings_weather_saved', 'ok');
}

// Toggle a single detail chip/metric (visibility, PM2.5, feels-like, …). Unlike
// the section toggles above, this applies to both the tile and the modal.
function updateWeatherTileField(id, checked) {
  if (!WEATHER_FIELD_IDS.includes(id)) return;
  const tile = normalizeWeatherTile(hubSettings.weather && hubSettings.weather.tile);
  tile.fields = { ...tile.fields, [id]: !!checked };
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, tile },
  });
  saveHubSettings();
  syncWeatherSettingsControls();
  if (typeof renderWeatherTile === 'function') renderWeatherTile();
  if (typeof renderWeatherDetails === 'function') renderWeatherDetails();
  setSettingsStatus('settings_weather_saved', 'ok');
}

function updateWeatherMode(mode) {
  if (!['auto', 'manual'].includes(mode)) return;
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, mode },
  });
  saveHubSettings();
  syncWeatherSettingsControls();
  queueWeatherSettingsRefresh();
  setSettingsStatus('settings_weather_saved', 'ok');
}

// Reflect the active clock format (Auto / 12h / 24h) on its segmented control.
function syncClockFormatControls() {
  const fmt = ['auto', '12', '24'].includes(hubSettings.clockFormat) ? hubSettings.clockFormat : 'auto';
  document.querySelectorAll('.settings-clock-format[data-clock-format]').forEach(btn => {
    const active = btn.dataset.clockFormat === fmt;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function syncTopbarStyleControls() {
  const style = hubSettings.topbarStyle === 'minimal' ? 'minimal' : 'full';
  document.querySelectorAll('.settings-topbar-style[data-topbar-style]').forEach(btn => {
    const active = btn.dataset.topbarStyle === style;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

// Switch between the full glass topbar and the minimal chrome (edge rails +
// island pill). Re-applies the dashboard layout so the grid reclaims/returns
// the bar's row with a smooth transition.
function updateTopbarStyle(style) {
  if (!['full', 'minimal'].includes(style)) return;
  hubSettings = normalizeSettings({ ...hubSettings, topbarStyle: style });
  saveHubSettings();
  syncTopbarStyleControls();
  if (window.TopbarMinimal) window.TopbarMinimal.apply();
  if (typeof applyDashboardLayoutWithTransition === 'function') applyDashboardLayoutWithTransition();
  setSettingsStatus('settings_saved', 'ok');
}

// Switch the dashboard/lock-screen clock between 12h and 24h. Display-only —
// repaint both clocks immediately so the change is visible without waiting for
// the next tick.
function updateClockFormat(fmt) {
  if (!['auto', '12', '24'].includes(fmt)) return;
  hubSettings = normalizeSettings({ ...hubSettings, clockFormat: fmt });
  saveHubSettings();
  syncClockFormatControls();
  if (typeof tickClock === 'function') tickClock();
  if (typeof renderLockClock === 'function') renderLockClock();
  setSettingsStatus('settings_saved', 'ok');
}

// Reflect the active first-day-of-week (Mon / Sun) on its segmented control.
function syncWeekStartControls() {
  const val = ['mon', 'sun'].includes(hubSettings.weekStart) ? hubSettings.weekStart : 'mon';
  document.querySelectorAll('.settings-week-start[data-week-start]').forEach(btn => {
    const active = btn.dataset.weekStart === val;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

// Switch the calendar's first day of week (Monday/Sunday). Display-only —
// repaint the calendar immediately so the change is visible.
function updateWeekStart(val) {
  if (!['mon', 'sun'].includes(val)) return;
  hubSettings = normalizeSettings({ ...hubSettings, weekStart: val });
  saveHubSettings();
  syncWeekStartControls();
  if (typeof renderCalendar === 'function') renderCalendar();
  setSettingsStatus('settings_saved', 'ok');
}

// Switch the weather temperature unit (°C/°F). The unit is display-only: the
// server keeps reporting Celsius and the client converts on render, so no
// re-fetch is needed — just re-paint the already-loaded weather.
function updateTempUnit(unit) {
  if (!['c', 'f'].includes(unit)) return;
  hubSettings = normalizeSettings({ ...hubSettings, tempUnit: unit });
  saveHubSettings();
  syncWeatherSettingsControls();
  if (typeof applyWeather === 'function') applyWeather(typeof weatherData !== 'undefined' ? weatherData : null);
  if (typeof renderLockScreen === 'function') renderLockScreen();
  setSettingsStatus('settings_weather_saved', 'ok');
}

function updateWeatherCity(value, commit = false) {
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, city: value },
  });
  saveHubSettings();
  if (commit) syncWeatherSettingsControls();
  if (hubSettings.weather.mode === 'manual' && hubSettings.weather.city) queueWeatherSettingsRefresh(450);
  setSettingsStatus('settings_weather_saved', 'ok');
}

async function uploadSettingsBackground(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  if (!isSupportedBackgroundFile(file)) {
    input.value = '';
    setSettingsStatus('settings_bg_unsupported', 'error');
    return;
  }
  if (file.size > SETTINGS_MAX_BACKGROUND_BYTES) {
    input.value = '';
    setSettingsStatus('settings_bg_too_large', 'error');
    return;
  }

  const form = new FormData();
  form.append('background', file);
  setSettingsStatus('settings_bg_uploading', '');

  try {
    const res = await fetch('/background', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) throw new Error(data.error || res.statusText);
    hubSettings = normalizeSettings({
      ...hubSettings,
      backgroundMedia: { url: data.url, name: data.name || file.name, type: data.type || file.type, version: String(Date.now()) },
    });
    saveHubSettings();
    applyHubSettings();
    renderSettingsModal();
    if (data.converted) setSettingsStatus('settings_bg_converted', 'ok');
    else if (data.conversion === 'ffmpeg-missing') setSettingsStatus('settings_bg_convert_missing', 'error');
    else if (data.conversion === 'failed') setSettingsStatus('settings_bg_convert_failed', 'error');
    else setSettingsStatus('settings_bg_uploaded', 'ok');
  } catch {
    setSettingsStatus('settings_bg_upload_failed', 'error');
  } finally {
    input.value = '';
  }
}

function clearSettingsBackground() {
  hubSettings = normalizeSettings({ ...hubSettings, backgroundMedia: null });
  saveHubSettings();
  applyHubSettings();
  renderSettingsModal();
  setSettingsStatus('settings_bg_removed', 'ok');
}

function resetHubAppearance() {
  // Preserve user data that isn't "appearance": the dashboard layout and the
  // external calendar feed subscriptions must survive an appearance reset.
  hubSettings = normalizeSettings({
    ...DEFAULT_HUB_SETTINGS,
    dashboardLayout: hubSettings.dashboardLayout,
    calendarFeeds: hubSettings.calendarFeeds,
  });
  saveHubSettings();
  applyHubSettings();
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
  renderSettingsModal();
  setSettingsStatus('settings_reset_done', 'ok');
}

function reloadHubSettingsFromStorage() {
  hubSettings = loadHubSettings();
  applyHubSettings();
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
  if ($('settings-overlay') && !$('settings-overlay').hidden) renderSettingsModal();
}

function syncAiSettingsControls() {
  const keyInput = $('settings-gemini-key');
  if (keyInput) keyInput.value = hubSettings.geminiApiKey || '';
  const ttsToggle = $('settings-ai-tts');
  if (ttsToggle) ttsToggle.checked = hubSettings.aiTtsEnabled !== false;
  const proToggle = $('settings-ai-pro');
  if (proToggle) proToggle.checked = hubSettings.aiProReasoning === true;
  const liveToggle = $('settings-ai-live');
  if (liveToggle) liveToggle.checked = hubSettings.aiLiveVoice === true;
  const memToggle = $('settings-ai-memory');
  if (memToggle) {
    const on = hubSettings.aiMemory !== false;
    memToggle.checked = on;
    const manage = $('settings-ai-memory-manage');
    if (manage) manage.hidden = !on;
    if (on) renderAiMemoryList();
  }
  const sens = $('settings-ai-sens');
  if (sens) {
    const v = Number.isFinite(hubSettings.aiMicSensitivity) ? hubSettings.aiMicSensitivity : 50;
    sens.value = String(v);
    const out = $('settings-ai-sens-val');
    if (out) out.textContent = String(v);
  }
  const obsHostInput = $('settings-obs-host');
  if (obsHostInput) obsHostInput.value = hubSettings.obsHost || '';
  const obsPortInput = $('settings-obs-port');
  if (obsPortInput) obsPortInput.value = hubSettings.obsPort || 4455;
  const obsPassInput = $('settings-obs-password');
  if (obsPassInput) {
    obsPassInput.value = hubSettings.obsPassword || '';
    obsPassInput.placeholder = hubSettings.obsPasswordSet ? '••••••••  ' + t('settings_ha_token_saved', 'Saved') : '';
  }
  const obsAutoInput = $('settings-obs-autolaunch');
  if (obsAutoInput) obsAutoInput.checked = hubSettings.obsAutoLaunch !== false;
  const sbHostInput = $('settings-sb-host');
  if (sbHostInput) sbHostInput.value = hubSettings.streamerbotHost || '';
  const sbPortInput = $('settings-sb-port');
  if (sbPortInput) sbPortInput.value = hubSettings.streamerbotPort || 8080;
  const sbPassInput = $('settings-sb-password');
  if (sbPassInput) {
    sbPassInput.value = hubSettings.streamerbotPassword || '';
    sbPassInput.placeholder = hubSettings.streamerbotPasswordSet ? '••••••••  ' + t('settings_ha_token_saved', 'Saved') : '';
  }
  // Bind the local-provider section once, then refresh its values on every render.
  initAiProviderSettings();
  syncAiProviderControls();
  syncAiFeaturesControls();
  syncWakeWordControls();
}

// Reflect the advanced AI feature toggles (master + per-feature) in Settings.
// The per-feature rows are visually disabled while the master switch is off so
// the opt-in chain (master → feature) is obvious at a glance.
function syncAiFeaturesControls() {
  const f = normalizeAiFeatures(hubSettings.aiFeatures);
  const master = $('settings-aifeat-master');
  if (master) master.checked = f.enabled;
  ['genesis', 'gameCompanion', 'guardian', 'ambient', 'pcControl'].forEach(key => {
    const input = $(`settings-aifeat-${key}`);
    if (!input) return;
    input.checked = f[key];
    input.disabled = !f.enabled;
    const row = input.closest('.aifeat-row');
    if (row) row.classList.toggle('aifeat-row-disabled', !f.enabled);
  });
}

// Show the running build version at the bottom of the Settings sidebar. Read
// from the server (which sources it from package.json) so it always matches the
// shipped build; stays empty and unobtrusive if the request fails.
async function initSettingsVersion() {
  const out = document.getElementById('settings-version');
  if (!out) return;
  try {
    const { version } = await (await fetch('/version')).json();
    if (version) out.textContent = `Xenon v${version}`;
  } catch { /* leave blank — no version indicator is better than a broken one */ }
  // The update pill, the red notification dots and the "Check for updates"
  // button visibility are all driven by js/update.js (XenonUpdate.refresh()),
  // so there is a single source of truth for "is an update available".
}
document.addEventListener('DOMContentLoaded', initSettingsVersion, { once: true });

// ── Configuration backup ──────────────────────────────────────────────────────
// Export: in a real browser, download the portable JSON (one file, no secrets);
// inside the Xeneon Edge iCUE WebView there is no download manager, so a blob
// download silently does nothing — there we ask the server (same PC) to write
// the file to the Downloads folder and toast the path. Import uploads one back,
// then reloads so every module re-hydrates the restored data.
function backupToast(titleKey, meta) {
  const title = (typeof window.t === 'function' && window.t(titleKey)) || titleKey;
  if (typeof showHubToast === 'function') showHubToast('Backup', title, meta || '');
}

// Server writes the backup to disk (Downloads) and returns the path. Used as the
// embedded-view path and as a fallback when a browser download is blocked.
async function exportBackupToDisk() {
  const res = await fetch('/backup/save', { method: 'POST' });
  const out = await res.json().catch(() => null);
  if (!out || out.ok !== true) throw new Error((out && out.error) || 'save_failed');
  backupToast('settings_backup_saved', out.path || '');
}

async function exportBackup() {
  const btn = document.querySelector('[onclick="exportBackup()"]');
  try {
    if (btn) btn.disabled = true;
    // Embedded WebView: no download manager — let the server save the file.
    if (isEmbeddedView()) { await exportBackupToDisk(); return; }
    // Real browser: native download of the JSON blob.
    const res = await fetch('/backup/export');
    if (!res.ok) throw new Error('export_failed');
    const blob = await res.blob();
    const name = 'xenon-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    backupToast('settings_backup_exported');
  } catch (e) {
    console.error('Backup export failed:', e);
    // Last resort: try the server-side save so the user always gets a file.
    try { await exportBackupToDisk(); }
    catch { backupToast('settings_backup_error'); }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function importBackupPick() {
  const f = document.getElementById('settings-backup-file');
  if (f) { f.value = ''; f.click(); }
}

// Human-readable labels for the `needsSetup` service keys the import reports
// (services the backup's owner had configured whose secrets can't travel in
// the file). Proper nouns — no translation needed.
const BACKUP_SERVICE_LABELS = {
  gemini: 'Gemini API', obs: 'OBS', streamerbot: 'Streamer.bot',
  homeAssistant: 'Home Assistant', sunshine: 'Sunshine (Remote)',
  twelveData: 'Twelve Data', finnhub: 'Finnhub', sportsDb: 'TheSportsDB',
  newsData: 'NewsData.io', spotify: 'Spotify', twitch: 'Twitch',
  youtube: 'YouTube', discord: 'Discord',
  lightingProviders: 'Hue / Nanoleaf',
};

// The import reloads the page, so the outcome summary (what needs re-linking,
// what failed) is parked in sessionStorage and toasted after the reload.
function showPendingBackupSummary() {
  let summary = null;
  try {
    summary = JSON.parse(sessionStorage.getItem('xenon.backupImportSummary') || 'null');
    sessionStorage.removeItem('xenon.backupImportSummary');
  } catch { summary = null; }
  if (!summary || typeof summary !== 'object') return;
  const tt = (k, fb) => (typeof window.t === 'function' && window.t(k)) || fb;
  const needs = (Array.isArray(summary.needsSetup) ? summary.needsSetup : [])
    .map((k) => BACKUP_SERVICE_LABELS[k] || k);
  const failed = Array.isArray(summary.failed) ? summary.failed : [];
  let meta = '';
  if (needs.length) meta = `${tt('settings_backup_needs_setup', 'Da ricollegare:')} ${needs.join(', ')}`;
  if (failed.length) meta += `${meta ? ' — ' : ''}${tt('settings_backup_partial', 'Non ripristinato:')} ${failed.join(', ')}`;
  backupToast('settings_backup_imported', meta);
}
document.addEventListener('DOMContentLoaded', showPendingBackupSummary, { once: true });

async function importBackupFile(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  const btn = document.getElementById('settings-backup-import-btn');
  try {
    const text = await file.text();
    JSON.parse(text);   // sanity check locally before shipping it to the server
    const res = await fetch('/backup/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: text,
    });
    const out = await res.json();
    // A partial import (some sections restored, some failed) still reloads —
    // the applied sections are live server-side either way; the summary toast
    // after the reload tells the user exactly what didn't make it.
    const restoredAny = out && Array.isArray(out.restored) && out.restored.length > 0;
    if (!out || (out.ok !== true && !restoredAny)) throw new Error((out && out.error) || 'import_failed');
    try {
      sessionStorage.setItem('xenon.backupImportSummary', JSON.stringify({
        needsSetup: Array.isArray(out.needsSetup) ? out.needsSetup : [],
        failed: Array.isArray(out.failed) ? out.failed : [],
      }));
    } catch { /* summary toast is best-effort */ }
    location.reload();
  } catch (e) {
    console.error('Backup import failed:', e);
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = (typeof window.t === 'function' && window.t('settings_backup_error')) || 'File non valido';
      setTimeout(() => { btn.textContent = orig; }, 3000);
    }
  }
}

const AI_KNOWN_MODELS = ['auto', 'qwen2.5:3b', 'qwen2.5:7b', 'llama3.1:8b', 'gemma4:12b'];
let _aiProviderBound = false;
// Models actually installed in Ollama (names from /api/tags), refreshed by
// aiLocalLoadModels(). Drives the custom-field autocomplete + download state.
let _ollamaInstalledModels = [];

// Fetch the installed Ollama models and populate the autocomplete datalist.
async function aiLocalLoadModels() {
  try {
    const data = await (await fetch('/api/ai-local/models')).json();
    _ollamaInstalledModels = Array.isArray(data && data.models) ? data.models : [];
  } catch {
    _ollamaInstalledModels = [];
  }
  const list = $('ai-model-list');
  if (list) {
    list.textContent = '';
    for (const name of _ollamaInstalledModels) {
      const opt = document.createElement('option');
      opt.value = name;
      list.appendChild(opt);
    }
  }
  _populateInstalledModelOptions();
  _aiUpdateModelDownloadState();
}

// Surface the actually-installed Ollama models as selectable options in the model
// dropdown (under an "Installed" group), so a user can pick a model they already
// have instead of only the preset tiers or a hand-typed custom tag. Preset tiers
// are skipped to avoid duplicates. Re-applies the stored selection afterwards, so
// it survives this async refresh landing after syncAiProviderControls().
function _populateInstalledModelOptions() {
  const modelSel = $('ai-model-select');
  if (!modelSel) return;
  const prev = $('ai-model-installed-group');
  if (prev) prev.remove();
  const extras = _ollamaInstalledModels.filter(name => !AI_KNOWN_MODELS.includes(name));
  if (extras.length) {
    const group = document.createElement('optgroup');
    group.id = 'ai-model-installed-group';
    group.label = t('ai_model_installed_group');
    extras.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      group.appendChild(opt);
    });
    const customOpt = modelSel.querySelector('option[value="__custom__"]');
    modelSel.insertBefore(group, customOpt);
  }
  _reflectModelSelection();
}

// Reflect the persisted ollamaModel into the model <select>: pick the matching
// option when one exists (a preset tier OR an installed model added above),
// otherwise fall back to the custom field.
function _reflectModelSelection() {
  const modelSel = $('ai-model-select');
  if (!modelSel) return;
  const modelCustom = $('ai-model-custom');
  const modelWarn = $('ai-model-custom-warn');
  const model = (hubSettings && hubSettings.ollamaModel) || 'auto';
  const hasOption = model !== '__custom__'
    && Array.from(modelSel.options).some(o => o.value === model);
  if (hasOption) {
    modelSel.value = model;
    if (modelCustom) modelCustom.hidden = true;
    if (modelWarn) modelWarn.hidden = true;
  } else {
    modelSel.value = '__custom__';
    if (modelCustom) { modelCustom.hidden = false; modelCustom.value = model; }
    if (modelWarn) modelWarn.hidden = false;
  }
}

// Resolve the concrete model tag for the current UI selection (not the stored
// 'auto'/'__custom__' marker). Empty string when custom is selected but blank.
function _resolveSelectedModelTag() {
  const modelSel = $('ai-model-select');
  if (!modelSel) return '';
  if (modelSel.value === '__custom__') {
    const modelCustom = $('ai-model-custom');
    return modelCustom ? modelCustom.value.trim() : '';
  }
  if (modelSel.value === 'auto') {
    const rec = hubSettings && hubSettings.hardwareScan && hubSettings.hardwareScan.recommended;
    return rec && rec !== 'auto' ? rec : 'qwen2.5:3b';
  }
  return modelSel.value;
}

// Normalized membership test against the installed-models list. Ollama reports
// tags as "name:tag" (e.g. "llama3.1:latest"), so a bare "llama3.1" matches any
// installed "llama3.1:*", and a "qwen2.5:7b" matches itself or "qwen2.5:7b:latest".
function _isModelInstalled(tag) {
  if (!tag) return false;
  if (_ollamaInstalledModels.includes(tag)) return true;
  if (_ollamaInstalledModels.includes(tag + ':latest')) return true;
  if (!tag.includes(':')) {
    return _ollamaInstalledModels.some(name => name.startsWith(tag + ':'));
  }
  return false;
}

// Reflect whether the selected model is already downloaded: set the status span
// and turn the pull button into "re-download/update" when it is (still enabled).
function _aiUpdateModelDownloadState() {
  const installedEl = $('ai-model-installed');
  const pullBtn = $('ai-pull-model');
  const tag = _resolveSelectedModelTag();
  if (!tag) {
    if (installedEl) installedEl.textContent = '';
    if (pullBtn) { pullBtn.hidden = false; pullBtn.textContent = t('ai_comp_download_model'); }
    return;
  }
  const installed = _isModelInstalled(tag);
  // Already downloaded → tell the user which model is in use and hide the
  // download button; only offer "Scarica modello" when the model is missing.
  if (installedEl) {
    installedEl.textContent = installed
      ? `${t('ai_model_in_use')} ${tag} ✓`
      : `${tag} — ${t('ai_model_not_installed')}`;
  }
  if (pullBtn) {
    pullBtn.hidden = installed;
    pullBtn.textContent = t('ai_comp_download_model');
  }
}

// Reflect the persisted provider settings into the local-AI controls. Safe to
// call repeatedly (it only reads hubSettings and writes control state).
function syncAiProviderControls() {
  const panel = $('ai-local-panel');
  const modelSel = $('ai-model-select');
  if (!panel || !modelSel) return;

  const cfg = hubSettings || {};
  const provider = cfg.aiProvider === 'ollama' ? 'ollama' : 'gemini';
  document.querySelectorAll('input[name="aiProvider"]').forEach((r) => {
    r.checked = (r.value === provider);
  });
  panel.hidden = provider !== 'ollama';
  // The Gemini API key is irrelevant for the local provider — hide it.
  const geminiKeyRow = $('settings-gemini-key-row');
  if (geminiKeyRow) geminiKeyRow.hidden = provider === 'ollama';

  const urlInput = $('ai-ollama-url');
  if (urlInput) urlInput.value = cfg.ollamaUrl || 'http://localhost:11434';

  _reflectModelSelection();

  if (cfg.hardwareScan) renderAiHwScan(cfg.hardwareScan);
  // When the local panel is already open on render, refresh live component state.
  if (provider === 'ollama') { aiLocalRefreshStatus(); aiLocalSyncAutostart(); aiLocalLoadModels(); }
}

// Render a hardware-scan result and gate the local provider on compatibility.
function renderAiHwScan(scan) {
  const hwBlock = $('ai-hw-block');
  const hwStats = $('ai-hw-stats');
  if (!hwStats) return;
  if (!scan || typeof scan !== 'object') { hwStats.textContent = '—'; return; }
  hwStats.textContent = `RAM ${scan.ram} GB · VRAM ${scan.vram} GB · ${scan.cores} core — ${scan.tier}`;
  const incompatible = scan.tier === 'incompatible';
  if (hwBlock) hwBlock.classList.toggle('ai-incompatible', incompatible);
  const ollamaRadio = $('ai-provider-ollama');
  if (ollamaRadio) ollamaRadio.disabled = incompatible;
  if (incompatible && ollamaRadio && ollamaRadio.checked) {
    const geminiRadio = $('ai-provider-gemini');
    if (geminiRadio) geminiRadio.checked = true;
    const panel = $('ai-local-panel');
    if (panel) panel.hidden = true;
    // Restore the cloud provider so persisted state matches the disabled UI.
    hubSettings = normalizeSettings({ ...hubSettings, aiProvider: 'gemini' });
    saveHubSettings();
  }
}

// Persist the current provider/model/url control values.
function persistAiProviderSettings() {
  const checked = document.querySelector('input[name="aiProvider"]:checked');
  const modelSel = $('ai-model-select');
  const modelCustom = $('ai-model-custom');
  const urlInput = $('ai-ollama-url');
  if (!modelSel) return;
  const model = modelSel.value === '__custom__'
    ? ((modelCustom && modelCustom.value.trim()) || 'auto')
    : modelSel.value;
  hubSettings = normalizeSettings({
    ...hubSettings,
    aiProvider: checked && checked.value === 'ollama' ? 'ollama' : 'gemini',
    ollamaModel: model,
    ollamaUrl: (urlInput && urlInput.value.trim()) || 'http://localhost:11434',
  });
  saveHubSettings();
}

async function aiLocalScan() {
  const hwStats = $('ai-hw-stats');
  if (hwStats) hwStats.textContent = '…';
  try {
    const data = await (await fetch('/api/ai-local/scan')).json();
    const scan = data && data.scan ? data.scan : data;
    renderAiHwScan(scan);
    hubSettings = normalizeSettings({ ...hubSettings, hardwareScan: scan });
    saveHubSettings();
  } catch {
    if (hwStats) hwStats.textContent = '—';
  }
}

async function aiLocalRefreshStatus() {
  try {
    const data = await (await fetch('/api/ai-local/status')).json();
    const status = data && data.status ? data.status : data;
    const set = (id, ok) => {
      const el = $(id);
      if (!el) return;
      el.className = ok ? 'ai-status-dot-ok' : 'ai-status-dot-bad';
      el.textContent = ok ? t('ai_comp_running') : t('ai_comp_missing');
    };
    // Ollama is reported as { installed, running }: running → green, installed but
    // stopped → amber with a "Start" button, not installed → red.
    const ollama = (status && status.ollama) || {};
    const ollamaEl = $('ai-status-ollama');
    const startBtn = $('ai-ollama-start');
    if (ollamaEl) {
      if (ollama.running) {
        ollamaEl.className = 'ai-status-dot-ok';
        ollamaEl.textContent = t('ai_comp_running');
      } else if (ollama.installed) {
        ollamaEl.className = 'ai-status-dot-warn';
        ollamaEl.textContent = t('ai_comp_installed_stopped');
      } else {
        ollamaEl.className = 'ai-status-dot-bad';
        ollamaEl.textContent = t('ai_comp_not_installed');
      }
    }
    // Show the Start button only when installed but not running.
    if (startBtn) startBtn.hidden = !(ollama.installed && !ollama.running);
    // Show the "Install Ollama" link only when Ollama is not installed at all.
    const ollamaInstallBtn = $('ai-ollama-install');
    if (ollamaInstallBtn) ollamaInstallBtn.hidden = !!ollama.installed;
    const whisperOk = !!(status && status.whisper);
    set('ai-status-whisper', whisperOk);
    // Show the "Download Whisper" button only when Whisper is not present.
    const whisperInstallBtn = $('ai-whisper-install');
    if (whisperInstallBtn) whisperInstallBtn.hidden = whisperOk;
    set('ai-status-tts', !!(status && (status.edgeTts ?? status.tts)));
  } catch { /* ignore — status stays unknown */ }
}

async function aiLocalStartOllama() {
  const startBtn = $('ai-ollama-start');
  const ollamaEl = $('ai-status-ollama');
  if (startBtn) startBtn.disabled = true;
  if (ollamaEl) ollamaEl.textContent = t('ai_comp_starting');
  try {
    await fetch('/api/ai-local/ollama-start', { method: 'POST' });
  } catch { /* ignore */ }
  if (startBtn) startBtn.disabled = false;
  await aiLocalRefreshStatus();
}

async function aiLocalSyncAutostart() {
  const cb = $('ai-ollama-autostart');
  if (!cb) return;
  try {
    const { enabled } = await (await fetch('/api/ai-local/ollama-autostart')).json();
    cb.checked = !!enabled;
  } catch { /* ignore */ }
}

async function aiLocalPullModel() {
  const prog = $('ai-pull-progress');
  const bar = $('ai-pull-bar');
  const label = $('ai-pull-label');
  const modelSel = $('ai-model-select');
  const modelCustom = $('ai-model-custom');
  if (!prog || !bar || !label || !modelSel) return;
  prog.hidden = false;
  bar.style.width = '0%';
  label.textContent = t('ai_pull_progress');
  const model = modelSel.value === '__custom__'
    ? (modelCustom ? modelCustom.value.trim() : '')
    : modelSel.value;
  try {
    const res = await fetch('/api/ai-local/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!res.body) throw new Error('no stream');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/^data:\s*/, '').trim();
        buf = buf.slice(nl + 2);
        if (!line) continue;
        try {
          const p = JSON.parse(line);
          if (p.total && p.completed) {
            bar.style.width = Math.round((p.completed / p.total) * 100) + '%';
          }
          if (p.status) label.textContent = String(p.status);
          if (p.done) { bar.style.width = '100%'; aiLocalRefreshStatus(); aiLocalLoadModels(); }
        } catch { /* skip malformed progress line */ }
      }
    }
  } catch (e) {
    label.textContent = String((e && e.message) || e);
  }
}

// Stream the /api/ai-local/whisper-install SSE and hand each parsed progress
// object ({ percent }, { status }, { error }, { done }) to onEvent. Shared by
// the local-provider panel and the wake-word row.
async function _streamWhisperInstall(onEvent) {
  const res = await fetch('/api/ai-local/whisper-install', { method: 'POST' });
  if (!res.body) throw new Error('no stream');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/^data:\s*/, '').trim();
      buf = buf.slice(nl + 2);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch { /* skip malformed progress line */ }
    }
  }
}

// Download + set up Whisper.cpp on demand. Mirrors aiLocalPullModel(): streams
// the whisper-install SSE and drives the shared progress bar from { percent }.
async function aiLocalInstallWhisper() {
  const prog = $('ai-pull-progress');
  const bar = $('ai-pull-bar');
  const label = $('ai-pull-label');
  if (!prog || !bar || !label) return;
  prog.hidden = false;
  bar.style.width = '0%';
  label.textContent = t('ai_pull_progress');
  try {
    await _streamWhisperInstall(p => {
      if (p.error) {
        // Surface the real reason instead of leaving the bar mid-way forever.
        label.textContent = '⚠ ' + String(p.error);
        aiLocalRefreshStatus();
        return;
      }
      if (typeof p.percent === 'number') bar.style.width = Math.max(0, Math.min(100, p.percent)) + '%';
      if (p.status) label.textContent = String(p.status);
      if (p.done) { bar.style.width = '100%'; aiLocalRefreshStatus(); }
    });
  } catch (e) {
    label.textContent = String((e && e.message) || e);
  }
}

// One-time binding of the local-AI provider controls. Idempotent via a guard.
function initAiProviderSettings() {
  if (_aiProviderBound) return;
  const panel = $('ai-local-panel');
  const modelSel = $('ai-model-select');
  if (!panel || !modelSel) return; // markup not present yet
  _aiProviderBound = true;

  document.querySelectorAll('input[name="aiProvider"]').forEach((r) => {
    r.addEventListener('change', async () => {
      const isLocal = r.value === 'ollama' && r.checked;
      panel.hidden = !isLocal;
      const geminiKeyRow = $('settings-gemini-key-row');
      if (geminiKeyRow) geminiKeyRow.hidden = isLocal;
      persistAiProviderSettings();
      if (isLocal) { await aiLocalScan(); await aiLocalRefreshStatus(); await aiLocalSyncAutostart(); }
    });
  });

  const rescan = $('ai-hw-rescan');
  if (rescan) rescan.addEventListener('click', aiLocalScan);
  const statusRefresh = $('ai-status-refresh');
  if (statusRefresh) statusRefresh.addEventListener('click', aiLocalRefreshStatus);
  const ollamaStart = $('ai-ollama-start');
  if (ollamaStart) ollamaStart.addEventListener('click', aiLocalStartOllama);
  const autostart = $('ai-ollama-autostart');
  if (autostart) autostart.addEventListener('change', async () => {
    try { await fetch('/api/ai-local/ollama-autostart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: autostart.checked }) }); }
    catch { /* ignore */ }
  });

  modelSel.addEventListener('change', () => {
    const custom = modelSel.value === '__custom__';
    const modelCustom = $('ai-model-custom');
    const modelWarn = $('ai-model-custom-warn');
    if (modelCustom) modelCustom.hidden = !custom;
    if (modelWarn) modelWarn.hidden = !custom;
    persistAiProviderSettings();
    _aiUpdateModelDownloadState();
  });
  const modelCustom = $('ai-model-custom');
  if (modelCustom) {
    modelCustom.addEventListener('change', persistAiProviderSettings);
    modelCustom.addEventListener('input', _aiUpdateModelDownloadState);
  }
  const urlInput = $('ai-ollama-url');
  if (urlInput) urlInput.addEventListener('change', persistAiProviderSettings);

  const pullBtn = $('ai-pull-model');
  if (pullBtn) pullBtn.addEventListener('click', aiLocalPullModel);
  const whisperInstall = $('ai-whisper-install');
  if (whisperInstall) whisperInstall.addEventListener('click', aiLocalInstallWhisper);
  const ollamaInstall = $('ai-ollama-install');
  if (ollamaInstall) ollamaInstall.addEventListener('click', () => window.open('https://ollama.com/download', '_blank'));
}

function updateAiKey(value) {
  hubSettings = normalizeSettings({ ...hubSettings, geminiApiKey: String(value || '').trim().slice(0, 200) });
  saveHubSettings();
  // Notify ai.js if wake word state needs to change
  if (typeof onAiKeyUpdated === 'function') onAiKeyUpdated();
  // Refresh the Media-tile chat (show input once a key is present, hide notice)
  if (typeof updateMediaChatKeyState === 'function') updateMediaChatKeyState();
}

function updateObsHost(value) {
  hubSettings = normalizeSettings({ ...hubSettings, obsHost: String(value || '').trim().slice(0, 200) });
  saveHubSettings();
}
function updateObsPort(value) {
  hubSettings = normalizeSettings({ ...hubSettings, obsPort: parseInt(value, 10) || 4455 });
  saveHubSettings();
}
function updateObsPassword(value) {
  hubSettings = normalizeSettings({ ...hubSettings, obsPassword: String(value || '').slice(0, 200) });
  saveHubSettings();
}
function updateObsAutoLaunch(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, obsAutoLaunch: !!checked });
  saveHubSettings();
}

function updateStreamerbotHost(value) {
  hubSettings = normalizeSettings({ ...hubSettings, streamerbotHost: String(value || '').trim().slice(0, 200) });
  saveHubSettings();
}
function updateStreamerbotPort(value) {
  hubSettings = normalizeSettings({ ...hubSettings, streamerbotPort: parseInt(value, 10) || 8080 });
  saveHubSettings();
}
function updateStreamerbotPassword(value) {
  hubSettings = normalizeSettings({ ...hubSettings, streamerbotPassword: String(value || '').slice(0, 200) });
  saveHubSettings();
}

// Probe the configured Streamer.bot WebSocket and report how many actions it
// exposes (or the failure). Flushes the pending settings save first so the
// server connects with the host/port/password the user just typed.
async function testStreamerbotConnection(btn) {
  const out = document.getElementById('settings-sb-status');
  const setStatus = (cls, msg) => { if (out) { out.className = 'settings-note settings-sb-status ' + cls; out.textContent = msg; } };
  if (btn) btn.disabled = true;
  setStatus('is-busy', (typeof t === 'function' ? t('settings_sb_testing') : 'Testing…'));
  try {
    if (typeof postHubSettingsToServer === 'function') await postHubSettingsToServer().catch(() => {});
    const r = await fetch('/streamerbot/actions').then((res) => res.json()).catch(() => null);
    if (r && r.ok) {
      // The probe connects to 127.0.0.1 by default even when Host is left blank, but
      // the widget/stateful-keys only activate once a host is actually saved (that's
      // the "I use Streamer.bot" opt-in that keeps the live socket off for everyone
      // else). So a successful test with a blank host persists the default — turning
      // the integration on now that the user has confirmed it works.
      if (!hubSettings.streamerbotHost) {
        hubSettings = normalizeSettings({ ...hubSettings, streamerbotHost: '127.0.0.1' });
        const hostInput = document.getElementById('settings-sb-host');
        if (hostInput) hostInput.value = '127.0.0.1';
        saveHubSettings();
        if (typeof postHubSettingsToServer === 'function') await postHubSettingsToServer().catch(() => {});
      }
      const n = (r.actions || []).length;
      setStatus('is-ok', (typeof t === 'function' ? t('settings_sb_ok') : 'Connected') + ' — ' + n + ' ' + (typeof t === 'function' ? t('settings_sb_actions') : 'actions'));
    } else {
      const base = (typeof t === 'function' ? t('settings_sb_fail') : 'Could not reach Streamer.bot');
      setStatus('is-err', (r && r.error) ? base + ' (' + r.error + ')' : base);
    }
  } catch (e) {
    setStatus('is-err', (typeof t === 'function' ? t('settings_sb_fail') : 'Could not reach Streamer.bot'));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function updateAiTts(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, aiTtsEnabled: !!enabled });
  saveHubSettings();
}

function updateAiProReasoning(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, aiProReasoning: !!enabled });
  saveHubSettings();
}

function updateAiLiveVoice(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, aiLiveVoice: !!enabled });
  saveHubSettings();
}

// ── Persistent AI memory (Settings → Xenon AI) ─────────────────────────────
// The server owns the fact store (data/ai-memory.json); the client flips the
// toggle and shows/clears the remembered facts. Text is rendered with
// textContent — never innerHTML — because the facts are user/AI-authored.

function updateAiMemory(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, aiMemory: !!enabled });
  saveHubSettings();
  const manage = $('settings-ai-memory-manage');
  if (manage) manage.hidden = !enabled;
  if (enabled) renderAiMemoryList();
}

async function renderAiMemoryList() {
  const list = $('settings-ai-memory-list');
  const empty = $('settings-ai-memory-empty');
  if (!list) return;
  let facts = [];
  try {
    const res = await fetch('/api/ai/memory');
    const data = await res.json();
    facts = Array.isArray(data.facts) ? data.facts : [];
  } catch { /* offline — leave the list as-is */ return; }
  list.textContent = '';
  if (empty) empty.hidden = facts.length > 0;
  for (const fact of facts) {
    const li = document.createElement('li');
    li.className = 'settings-memory-item';
    const span = document.createElement('span');
    span.className = 'settings-memory-text';
    span.textContent = fact.text || '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-memory-del';
    btn.setAttribute('aria-label', t('settings_ai_memory_forget', 'Forget'));
    btn.textContent = '×';
    btn.addEventListener('click', () => forgetAiMemoryFact(fact.id));
    li.appendChild(span);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function forgetAiMemoryFact(id) {
  try {
    await fetch('/api/ai/memory', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  } catch { /* ignore — the list refresh below reflects the true state */ }
  renderAiMemoryList();
}

async function clearAiMemory() {
  const msg = t('settings_ai_memory_clear_confirm', 'Delete everything Xenon remembers about you?');
  if (typeof confirm === 'function' && !confirm(msg)) return;
  try {
    await fetch('/api/ai/memory', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    if (window.XenonToast) window.XenonToast.show({ type: 'success', title: t('settings_ai_memory_cleared', 'Memory cleared') });
  } catch { /* ignore — the list refresh below reflects the true state */ }
  renderAiMemoryList();
}

function updateAiMicSensitivity(value) {
  const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  hubSettings = normalizeSettings({ ...hubSettings, aiMicSensitivity: v });
  saveHubSettings();
  const out = $('settings-ai-sens-val');
  if (out) out.textContent = String(v);
}

// ── "Hey Xenon" wake word (Settings → Xenon AI) ────────────────────────────
// The server owns the listener (ffmpeg + whisper.cpp); the client only flips
// the persisted toggle and reflects the live status line.

function updateWakeWord(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, wakeWord: { enabled: enabled === true } });
  saveHubSettings();
  // The /settings save starts/stops the server listener; re-read its status
  // after a beat so the row shows "listening" / "whisper missing" truthfully.
  // A second pass covers the slow path (device probe + first spawn take up to
  // a few seconds before isActive() flips).
  setTimeout(refreshWakeWordStatus, 600);
  setTimeout(refreshWakeWordStatus, 4500);
}

function syncWakeWordControls() {
  const toggle = $('settings-wake-enabled');
  if (!toggle) return;
  toggle.checked = !!(hubSettings.wakeWord && hubSettings.wakeWord.enabled);
  refreshWakeWordStatus();
}

async function refreshWakeWordStatus() {
  const out = $('settings-wake-status');
  const installBtn = $('settings-wake-whisper-btn');
  if (!out) return;
  const enabled = !!(hubSettings.wakeWord && hubSettings.wakeWord.enabled);
  if (!enabled) {
    out.textContent = '';
    if (installBtn) installBtn.hidden = true;
    return;
  }
  try {
    const st = await (await fetch('/api/wake/status')).json();
    if (!st.whisper) {
      out.textContent = t('wake_status_no_whisper', 'Serve Whisper (riconoscimento vocale locale): scaricalo qui sotto e l\'ascolto parte da solo.');
      if (installBtn) installBtn.hidden = false;
      return;
    }
    if (installBtn) installBtn.hidden = true;
    out.textContent = st.listening
      ? t('wake_status_listening', 'In ascolto: di\' «Hey Xenon» per aprire la chat vocale.')
      : t('wake_status_starting', 'Attivo — l\'ascolto parte quando il dashboard è aperto.');
  } catch {
    out.textContent = '';
    if (installBtn) installBtn.hidden = true;
  }
}

// One-click Whisper download from the wake-word row. Streams the same
// /api/ai-local/whisper-install SSE as the local-provider panel, but reports
// progress inline in the status line (that panel is hidden on Gemini).
async function wakeInstallWhisper(btn) {
  const out = $('settings-wake-status');
  if (btn) btn.disabled = true;
  try {
    await _streamWhisperInstall(p => {
      if (!out) return;
      if (p.error) out.textContent = '⚠ ' + String(p.error);
      else if (p.status || typeof p.percent === 'number') {
        out.textContent = String(p.status || '') + (typeof p.percent === 'number' ? ` ${Math.round(p.percent)}%` : '');
      }
    });
  } catch (e) {
    if (out) out.textContent = String((e && e.message) || e);
  } finally {
    if (btn) btn.disabled = false;
    refreshWakeWordStatus();
  }
}

// Toggle one advanced AI feature flag ('enabled' = master switch). Persisted
// like every other setting and re-synced so dependent rows enable/disable.
function updateAiFeature(key, checked) {
  const current = normalizeAiFeatures(hubSettings.aiFeatures);
  if (!(key in current)) return;
  current[key] = checked === true;
  hubSettings = normalizeSettings({ ...hubSettings, aiFeatures: current });
  saveHubSettings();
  syncAiFeaturesControls();
  // Let feature modules react immediately (start/stop watchers, hide UI …).
  document.dispatchEvent(new CustomEvent('ai-features-changed', { detail: normalizeAiFeatures(hubSettings.aiFeatures) }));
}


// ── External calendar feeds settings section ──────────────────────
// Renders a CRUD list for calendarFeeds inside the dynamically-injected
// "calendar" settings category. The section and its nav button are
// created once and reused on subsequent openings.

// Mirrors CALENDAR_FEED_PALETTE in server.js. The server only accepts a colour
// from this set (anything else is reset to the first entry), so the picker is a
// fixed swatch set rather than a free colour input.
const CALENDAR_FEED_PALETTE = ['#1ed760', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6'];

// Renders one help/warning line as an <li>, bolding the lead-in label before
// the first colon (handles both ASCII ':' and full-width '：' for CJK strings).
function appendFeedHelpLine(listEl, key) {
  const text = t(key);
  const li = document.createElement('li');
  const ci = text.search(/[:：]/);
  if (ci > 0 && ci < 40) {
    const lead = document.createElement('strong');
    lead.textContent = text.slice(0, ci);
    li.appendChild(lead);
    li.appendChild(document.createTextNode(text.slice(ci)));
  } else {
    li.textContent = text;
  }
  listEl.appendChild(li);
}

function renderCalendarFeeds(container) {
  const feeds = Array.isArray(hubSettings.calendarFeeds) ? hubSettings.calendarFeeds.slice() : [];
  container.textContent = '';

  const heading = document.createElement('h3');
  heading.textContent = t('external_calendars');
  const desc = document.createElement('p');
  desc.className = 'settings-hint';
  desc.textContent = t('external_calendars_desc');
  container.appendChild(heading);
  container.appendChild(desc);

  const list = document.createElement('div');
  list.className = 'feed-list';
  container.appendChild(list);

  function commit() {
    hubSettings = normalizeSettings({ ...hubSettings, calendarFeeds: feeds });
    saveHubSettings();
    loadExternalFeedStatus(list, feeds);
  }

  feeds.forEach((feed, idx) => {
    const row = document.createElement('div');
    row.className = 'feed-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = t('feed_name');
    nameInput.value = feed.name || '';
    nameInput.addEventListener('change', () => { feed.name = nameInput.value.trim(); commit(); });

    const urlInput = document.createElement('input');
    urlInput.type = 'url';
    urlInput.placeholder = t('feed_url');
    urlInput.value = feed.url || '';
    urlInput.addEventListener('change', () => { feed.url = urlInput.value.trim(); commit(); });

    const swatches = document.createElement('div');
    swatches.className = 'feed-swatches';
    CALENDAR_FEED_PALETTE.forEach(hex => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'feed-swatch';
      sw.style.background = hex;
      sw.title = hex;
      if ((feed.color || CALENDAR_FEED_PALETTE[0]) === hex) sw.classList.add('selected');
      sw.addEventListener('click', () => {
        feed.color = hex;
        swatches.querySelectorAll('.feed-swatch').forEach(s => s.classList.toggle('selected', s === sw));
        commit();
      });
      swatches.appendChild(sw);
    });

    const remLabel = document.createElement('label');
    remLabel.className = 'feed-toggle';
    const remCb = document.createElement('input');
    remCb.type = 'checkbox';
    remCb.checked = feed.reminders !== false;
    remCb.addEventListener('change', () => { feed.reminders = remCb.checked; commit(); });
    const remText = document.createTextNode(' ' + t('feed_reminders'));
    remLabel.appendChild(remCb);
    remLabel.appendChild(remText);

    const enLabel = document.createElement('label');
    enLabel.className = 'feed-toggle';
    const enCb = document.createElement('input');
    enCb.type = 'checkbox';
    enCb.checked = feed.enabled !== false;
    enCb.addEventListener('change', () => { feed.enabled = enCb.checked; commit(); });
    const enText = document.createTextNode(' ' + t('feed_enabled'));
    enLabel.appendChild(enCb);
    enLabel.appendChild(enText);

    const status = document.createElement('span');
    status.className = 'feed-status';
    status.dataset.feedId = feed.id || '';

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'feed-remove';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      feeds.splice(idx, 1);
      hubSettings = normalizeSettings({ ...hubSettings, calendarFeeds: feeds });
      saveHubSettings();
      renderCalendarFeeds(container);
    });

    row.append(nameInput, urlInput, swatches, remLabel, enLabel, status, del);
    list.appendChild(row);
  });

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'feed-add';
  addBtn.textContent = '+ ' + t('add_feed');
  addBtn.addEventListener('click', () => {
    feeds.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      name: '', url: '', color: '#1ed760', reminders: true, enabled: true,
    });
    hubSettings = normalizeSettings({ ...hubSettings, calendarFeeds: feeds });
    saveHubSettings();
    renderCalendarFeeds(container);
  });

  // "Refresh now" forces the server to re-fetch every feed immediately, instead
  // of waiting for the 15-min scheduler (useful because provider .ics links lag).
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'feed-refresh';
  refreshBtn.textContent = '↻ ' + t('refresh_feeds');
  refreshBtn.disabled = feeds.length === 0;
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.classList.add('is-loading');
    try {
      await fetch(SERVER + '/external-events/refresh', { method: 'POST' });
      if (typeof loadExternalEvents === 'function') await loadExternalEvents();
      await loadExternalFeedStatus(list, feeds);
    } catch { /* network/server unavailable — leave current state untouched */ }
    refreshBtn.classList.remove('is-loading');
    refreshBtn.disabled = feeds.length === 0;
  });

  const actions = document.createElement('div');
  actions.className = 'feed-actions';
  actions.append(addBtn, refreshBtn);
  container.appendChild(actions);

  // Help + warnings block — two visually separated groups so the wall of
  // warnings is scannable instead of overwhelming.
  const help = document.createElement('div');
  help.className = 'feed-help';

  const stepsGroup = document.createElement('div');
  stepsGroup.className = 'feed-help-group';
  const stepsTitle = document.createElement('h4');
  stepsTitle.className = 'feed-help-title';
  stepsTitle.textContent = t('feed_help_title');
  stepsGroup.appendChild(stepsTitle);
  const stepsList = document.createElement('ul');
  stepsList.className = 'feed-help-steps';
  ['feed_help_google', 'feed_help_outlook'].forEach(key => appendFeedHelpLine(stepsList, key));
  stepsGroup.appendChild(stepsList);
  help.appendChild(stepsGroup);

  const warnGroup = document.createElement('div');
  warnGroup.className = 'feed-help-group is-warn';
  const warnTitle = document.createElement('h4');
  warnTitle.className = 'feed-help-title';
  warnTitle.textContent = '⚠ ' + t('feed_warn_title');
  warnGroup.appendChild(warnTitle);
  const warnList = document.createElement('ul');
  warnList.className = 'feed-help-warnings';
  ['feed_warn_readonly', 'feed_warn_lag', 'feed_warn_dupes', 'feed_warn_privacy', 'feed_warn_recurrence']
    .forEach(key => appendFeedHelpLine(warnList, key));
  warnGroup.appendChild(warnList);
  help.appendChild(warnGroup);

  container.appendChild(help);

  loadExternalFeedStatus(list, feeds);
}

async function loadExternalFeedStatus(list, feeds) {
  if (!list || !feeds) return;
  try {
    const res = await fetch(SERVER + '/external-events');
    if (!res.ok) return;
    const data = await res.json();
    const byId = {};
    if (Array.isArray(data.feeds)) data.feeds.forEach(f => { byId[f.id] = f; });
    list.querySelectorAll('.feed-status').forEach(el => {
      const f = byId[el.dataset.feedId];
      if (!f) { el.textContent = ''; return; }
      el.textContent = f.status === 'ok'
        ? `${t('feed_status_ok')} (${f.count})`
        : `${t('feed_status_error')}: ${f.error || ''}`;
      el.classList.toggle('is-error', f.status === 'error');
    });
  } catch { /* leave status blank if endpoint unavailable */ }
}

// Idempotent bootstrap: injects the "calendar" nav button and section div
// the first time syncSettingsControls runs. Safe to call on every render.
let _calendarFeedsSectionReady = false;
function _initCalendarFeedsSection() {
  if (_calendarFeedsSectionReady) {
    // Section already exists — re-render feeds to pick up any settings changes.
    const hub = document.getElementById('settings-calendar-feeds-hub');
    if (hub) renderCalendarFeeds(hub);
    return;
  }

  const nav = document.getElementById('settings-nav');
  const content = document.getElementById('settings-content');
  if (!nav || !content) return; // markup not ready

  // Nav button
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'settings-nav-btn';
  btn.dataset.settingsCat = 'calendar';
  btn.addEventListener('click', () => settingsSetCategory('calendar'));
  // Calendar icon (same style as the other nav icons)
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
  const btnLabel = document.createElement('span');
  btnLabel.setAttribute('data-i18n', 'external_calendars'); // live-retranslates on language switch
  btnLabel.textContent = t('external_calendars');
  btn.appendChild(btnLabel);
  // Insert at the end of the "Widget" sidebar section (right before the
  // Integrazioni label) so the calendar sits with the other widget categories
  // instead of dangling at the bottom of the list.
  const navScroll = document.getElementById('settings-nav-scroll') || nav;
  const integrationsLabel = document.getElementById('settings-nav-label-integrations');
  if (integrationsLabel && integrationsLabel.parentElement === navScroll) navScroll.insertBefore(btn, integrationsLabel);
  else navScroll.appendChild(btn);

  // Section container (matches existing settings-group pattern)
  const section = document.createElement('div');
  section.className = 'settings-group';
  section.dataset.settingsCat = 'calendar';
  section.hidden = true; // settingsSetCategory controls visibility
  const hub = document.createElement('div');
  hub.id = 'settings-calendar-feeds-hub';
  section.appendChild(hub);
  content.appendChild(section);

  _calendarFeedsSectionReady = true;
  renderCalendarFeeds(hub);
}

window.SETTINGS_STORAGE_KEY = SETTINGS_STORAGE_KEY;
window.exportBackup      = exportBackup;
window.importBackupPick  = importBackupPick;
window.importBackupFile  = importBackupFile;
applyHubSettings();
hydrateHubSettingsFromServer();
window.addEventListener('pagehide', sendHubSettingsBeacon);
document.addEventListener('visibilitychange', () => ensureBackgroundVideoPlayback());
window.addEventListener('focus', () => ensureBackgroundVideoPlayback());
document.addEventListener('pointerdown', () => ensureBackgroundVideoPlayback(), { passive: true });
