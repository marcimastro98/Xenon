'use strict';

const SETTINGS_STORAGE_KEY = 'xeneonedge.settings.v1';
const SETTINGS_MAX_BACKGROUND_BYTES = 200 * 1024 * 1024;
const SETTINGS_MIN_PANEL_ALPHA = 0.18;
const SETTINGS_BACKGROUND_TYPES = Object.freeze(new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm',
]));
const SETTINGS_BACKGROUND_EXTENSIONS = Object.freeze(new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm']));
const SETTINGS_MAX_FONT_BYTES = 8 * 1024 * 1024;
const SETTINGS_FONT_TYPES = Object.freeze(new Set(['font/woff2', 'font/woff', 'font/ttf', 'font/otf']));
const SETTINGS_FONT_EXTENSIONS = Object.freeze(new Set(['woff2', 'woff', 'ttf', 'otf']));
// Uploaded fonts are registered under one fixed family name; the actual typeface
// comes from the @font-face src, so the family label never needs to match the file.
const USER_FONT_FAMILY = 'XenonUserFont';

const DASHBOARD_WIDGET_IDS = Object.freeze(['media', 'agenda', 'mic', 'audio', 'system', 'notes', 'tasks', 'calendar', 'timer', 'chat', 'deck', 'remote', 'twitch', 'obs', 'youtube', 'discord', 'spotify', 'browser', 'secondscreen', 'weather', 'smarthome', 'streamerbot', 'wavelink', 'lighting', 'notifications', 'stocks', 'football', 'news', 'claude', 'vitals', 'unifi', 'slideshow', 'fans', 'power', 'battery', 'custom']);
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
// How many days the "next days" forecast shows (1–7). The server always returns
// up to 7 days; the client trims to this preference. wttr.in only exposes 3 days,
// so on that provider the forecast simply shows what's available.
const WEATHER_FORECAST_DAY_CHOICES = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
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
// Bit's escalation ladder — minutes a vital must sit at zero before each rung.
// Defaults mirror core.STAGE_AT; each is user-tunable in Settings → Bit.
const VITALS_PET_STAGES = Object.freeze(['decay', 'gameover', 'overlay', 'minimize', 'lock']);
const VITALS_PET_DEFAULT_THR = Object.freeze({ decay: 5, gameover: 8, overlay: 10, minimize: 15, lock: 20 });
const DASHBOARD_PAGE_IDS = Object.freeze(['dashboard']);
const DASHBOARD_TAB_IDS = Object.freeze(['main', 'net']);
const CALENDAR_TAB_IDS = Object.freeze(['calendar', 'tasks']);
const MEDIA_VIEW_IDS = Object.freeze(['media', 'calendar']);
const DASHBOARD_CARD_IDS = Object.freeze({
  main: ['cpu', 'gpu', 'ram', 'disk'],
  net: ['ping', 'fps', 'latency', 'bandwidth'],
  audio: ['volume', 'speaker', 'microphone'],
  twitch: ['info', 'actions', 'chat'],
  obs: ['preview', 'controls', 'scenes', 'audio'],
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
    wavelink: Object.freeze({ x: 0, y: 18, w: 8, h: 10, visible: false, page: 'dashboard' }),
    lighting: Object.freeze({ x: 8, y: 46, w: 8, h: 12, visible: false, page: 'dashboard' }),
    notifications: Object.freeze({ x: 16, y: 18, w: 8, h: 10, visible: false, page: 'dashboard' }),
    stocks:   Object.freeze({ x: 0, y: 28, w: 8, h: 10, visible: false, page: 'dashboard' }),
    football: Object.freeze({ x: 8, y: 28, w: 8, h: 10, visible: false, page: 'dashboard' }),
    news:     Object.freeze({ x: 0, y: 38, w: 8, h: 10, visible: false, page: 'dashboard' }),
    claude:   Object.freeze({ x: 16, y: 28, w: 8, h: 10, visible: false, page: 'dashboard' }),
    vitals:   Object.freeze({ x: 8, y: 38, w: 8, h: 8, visible: false, page: 'dashboard' }),
    unifi:    Object.freeze({ x: 8, y: 18, w: 8, h: 8, visible: false, page: 'dashboard' }),
    slideshow: Object.freeze({ x: 0, y: 48, w: 8, h: 8, visible: false, page: 'dashboard' }),
    fans:     Object.freeze({ x: 16, y: 38, w: 8, h: 8, visible: false, page: 'dashboard' }),
    power:    Object.freeze({ x: 16, y: 46, w: 8, h: 8, visible: false, page: 'dashboard' }),
    battery:  Object.freeze({ x: 0, y: 56, w: 8, h: 8, visible: false, page: 'dashboard' }),
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
      audio: Object.freeze({ order: 3, size: 'normal', visible: true }),
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
  autoPalette: false, // true only after selecting Auto; manual colour edits freeze the palette
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
  // Minimal-mode edge rails auto-hide after ~10s untouched (revealed by an edge
  // touch). Default on; off keeps them always visible. See js/topbar-minimal.js.
  topbarRailsAutoHide: true,
  // Minimal-island personalization (Settings → Aspetto → Barra superiore).
  // align: island anchor (centre/left/right). items: ordered island segments,
  // each with a hidden flag. Full-bar mode ignores this. Defaults = centred
  // island with every segment shown.
  topbarClock: {
    align: 'center',
    items: [
      { id: 'time', hidden: false },
      { id: 'date', hidden: false },
      { id: 'weather', hidden: false },
      { id: 'vitals', hidden: false },
      { id: 'dots', hidden: false },
    ],
  },
  clockFormat: 'auto', // 'auto' | '12' | '24' — auto follows the UI language (en → 12h)
  weekStart: 'mon', // 'mon' | 'sun' — calendar first day of week
  swipeNavigation: true, // drag / finger-swipe to change dashboard page (touchscreen-friendly)
  swipeHomeGesture: true, // native app: swipe up from the bottom → Windows desktop (native-bridge.js)
  hideOnRdp: false, // native app: hide the kiosk during a Windows Remote Desktop session (opt-in; native-bridge.js)
  nativeZoom: 1, // native app: WebView2 interface scale, 0.5–3 (Settings slider; native-bridge.js)
  accent: '#1ed760',
  dynamicAlbumTheme: true, // tint the accent from the now-playing album art
  background: '#070808',
  // Semantic surfaces. Null means "derive from background"; explicit values
  // travel with themes and let one palette recolour every panel/control.
  surface: null,
  surfaceAlt: null,
  controlColor: null,
  text: '#f0f3f1',
  accentText: null,
  successColor: null,
  warningColor: null,
  dangerColor: null,
  infoColor: null,
  // Dual-palette themes: { light: {...roles}, dark: {...roles} } or null. A theme
  // that carries both lets one card be cream paper in Light and an ink board in
  // Dark, and follow Windows live on Auto — without the author giving up exact
  // authored colours the way autoPalette does. deriveEffectiveThemePalette()
  // overlays the variant matching the resolved appearance; any manual colour edit
  // bakes the visible variant in and drops the pair (see freezePaletteVariants).
  paletteVariants: null,
  contrastGuard: true,
  panelAlpha: 0.94,
  bgDim: 0.48,
  bgBlur: 0,
  // Pause the aurora/grid + decorative loops after a minute of no interaction to
  // save GPU (js/ambient-idle.js). On by default; users can switch it off so the
  // dashboard keeps animating while idle.
  idleAnimationPause: true,
  // Freeze the aurora/grid, the animated background and the Deck decor for the
  // whole session when the native shell is rendering on the weaker of two GPUs
  // (js/native-bridge.js → body.low-power-gpu). On by default: on that hardware a
  // frame cap alone did not recover the frame rate, only stopping the loops did.
  // Off = keep everything moving and accept the cost. Inert on single-GPU
  // machines and on the browser surface, where the class is never set.
  hybridGpuAnimationPause: true,
  // Extended theme tokens (full Aspetto editor). All part of a saved theme; the
  // defaults reproduce the stock Liquid Glass look exactly, and they apply inline
  // only under glass (retro owns its own geometry/material).
  uiRoundness: 1, // corner-radius multiplier 0..2 (1 = stock 8/10/16/20px)
  glassBlur: 22, // --glass-blur px, 0..40
  glassSaturate: 160, // --glass-saturate %, 100..220
  panelBorderStrength: 1, // multiplier on the derived panel-border alpha, 0..2
  panelShadowStrength: 1, // multiplier on the derived panel-shadow alpha, 0..2
  mutedText: null, // optional secondary-text colour (#rrggbb) or null = auto
  lineColor: null, // optional divider/border colour (#rrggbb) or null = auto
  backgroundMedia: null,
  uiFont: null, // custom global typeface: { url, name, version } or null → default Inter
  lockWidgets: Object.freeze({ clock: true, weather: true, media: true, calendar: true }),
  // Ambient / Screensaver mode (evolution of the Focus lock screen).
  // idleMinutes 0 = never auto-start; sceneId 'builtin' = the native scene
  // (lockscreen.js, configured by lockWidgets) or an installed SDK package id
  // whose manifest declares surface:'ambient'.
  ambientMode: Object.freeze({ enabled: true, idleMinutes: 0, sceneId: 'builtin' }),
  // Native canvas Ambient scenes the user composed (or imported). Client-owned
  // (like customThemes): referenced by ambientMode.sceneId as "canvas:<id>".
  ambientScenes: Object.freeze([]),
  weather: Object.freeze({
    mode: 'auto', city: '', provider: 'auto',
    refreshMin: 30, // how often (minutes) the client re-fetches weather
    forecastDays: 3, // how many days the "next days" forecast shows (1–7)
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
  // Anonymous version ping — OFF unless the user opts in (Settings → Generale → Aggiornamenti).
  // Sends only {version, os} on the update check the app already makes, never
  // the install id. Mirror of server.js; see docs/privacy.html.
  versionPing: false,
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
  // Imported/custom themes shown alongside the built-ins in the Temi gallery.
  // Each is a full look { id, name, skin, appearance?, accent, background, text,
  // panelAlpha?, bgDim?, bgBlur?, retroScanlines?, dynamicAlbumTheme?, uiFont? }.
  customThemes: Object.freeze([]),
  // Import receipts group every resource brought in by one code/catalog item so
  // Settings can uninstall the whole download without guessing by display name.
  contentInstalls: Object.freeze([]),
  geminiApiKey: '',
  aiProvider: 'gemini', // 'gemini' | 'ollama' | 'openai' | 'anthropic' — selected AI backend
  ollamaModel: 'auto',  // 'auto' | whitelist key | custom model tag
  ollamaUrl: 'http://localhost:11434',
  // ChatGPT (OpenAI) + Claude (Anthropic). Keys are SERVER-ONLY: the server
  // redacts them on the wire and sends only the *Set booleans, so the browser
  // never holds them. The model tags are user-overridable.
  openaiApiKey: '',
  openaiApiKeySet: false,
  openaiModel: 'gpt-4o',
  anthropicApiKey: '',
  anthropicApiKeySet: false,
  anthropicModel: 'claude-sonnet-5',
  hardwareScan: null,   // server-generated hardware probe; mirrored back as-is
  aiTtsEnabled: true,
  aiMicSensitivity: 50, // 0..100 — wake-word mic sensitivity slider (lower = stricter, fewer false positives)
  aiChatHidden: false, // user hid the AI chat tab in the Media tile
  aiMemory: true, // persistent AI memory — Xenon remembers durable facts about the user across sessions
  aiProReasoning: false, // advanced reasoning — route text chat turns to the stronger model
  aiLiveVoice: false, // Voce Live (beta) — full-duplex realtime voice via Gemini Live (off by default)
  // Voice chat presentation: false = full opaque "room" (orb + text over a dark
  // backdrop, the default); true = ambient — the dashboard stays visible and only
  // the screen edge glows, with the live captions in a small glass strip.
  aiVoiceAmbient: false,
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
  // User-given fan names for the Fans widget, keyed "<kind>|<sensor name>"
  // ("mb|Fan #3" → "Radiatore alto"). The board only reports header numbers —
  // the user is the one who knows what's plugged where. Empty = no renames;
  // clearing a label in the widget deletes its key (the reset path).
  fanLabels: Object.freeze({}),
  // Proactive moments (Settings → Performance). Deterministic and bounded:
  // sustained-thermal alerts, game-session recaps, morning agenda in the
  // greeting splash. Each individually toggleable, default ON.
  proactive: Object.freeze({ thermal: true, recap: true, morning: true, anomaly: true }),
  // Master notifications switch (Settings → Notifiche). `enabled` (default ON) is
  // the global gate — off silences every source and stops the background watchers.
  // `popups` (default ON) keeps the feeds but suppresses on-screen toasts.
  // `sounds` (default ON) plays a short synthesized cue per pop-up (and the
  // calendar reminder alarm); off keeps the toasts silent.
  notifications: Object.freeze({ enabled: true, popups: true, sounds: true }),
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
  // Static premium background (0 animations). Alternative to the animated aurora
  // for a rich look at near-zero render cost. style: none|nebulosa|prisma|halo.
  bgStatic: Object.freeze({ style: 'none', intensity: 70 }),
  // Code-defined animated background: a user snippet (or one carried in a shared
  // theme/package) run inside a locked-down sandboxed iframe (see js/custom-bg.js).
  // Off by default; when enabled it owns the backdrop like a static bg does.
  bgCustom: Object.freeze({ enabled: false, name: '', code: '', assets: Object.freeze({}), fps: 30 }),
  // Slideshow widget — an ordered set of images/GIFs (inline data: URIs) plus its
  // playback options. Rules live in js/slideshow-widget.js (shared with the server).
  slideshow: Object.freeze({ images: Object.freeze([]), intervalMs: 6000, fit: 'cover' }),
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
  homeAssistant: Object.freeze({ url: '', token: '', entities: Object.freeze([]), cameras: Object.freeze([]), energyEntities: Object.freeze([]), camAngles: Object.freeze({}), tokenSet: false }),
  // UniFi Protect cameras. host/username/cameras are client-managed; the console
  // `password` is a server-only secret (redacted on the wire, restored on save),
  // so the client copy is always '' and the server surfaces a `passwordSet` flag.
  unifi: Object.freeze({ host: '', username: '', password: '', cameras: Object.freeze([]), passwordSet: false, columns: 0, fit: 'cover', aspect: '16:9', order: Object.freeze([]), refreshMs: 1500, angles: Object.freeze({}), notify: Object.freeze({ enabled: false, types: Object.freeze({ person: true, vehicle: true, package: false, animal: false, motion: false, ring: true }), cooldownSec: 45 }) }),
  // Local hardware SDKs — opt-in, no secrets (unauthenticated localhost). Chroma:
  // just an enable flag. Wave Link: enable + optional pinned port (0 = auto-scan).
  chroma: Object.freeze({ enabled: false }),
  wavelink: Object.freeze({ enabled: false, port: 0 }),
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

// The Aspetto → Temi gallery has two tiers:
//  • Built-in STYLES (below) — Liquid Glass and Pixel Retro. Ocean/Ember/… were
//    dropped: they were just Liquid Glass with different colours, and colours are
//    edited in the Colori section. Selecting a style changes ONLY the skin and
//    keeps your colours/font (glass card previews your live palette; retro shows
//    the CRT palette, which themes-retro.css forces anyway).
//  • Imported/saved THEMES (hubSettings.customThemes) — a full snapshot of the
//    visual identity (THEME_SETTING_KEYS), applied as one look and switchable.
const BUILTIN_THEMES = Object.freeze([
  Object.freeze({ id: 'glass', nameKey: 'settings_style_glass', skin: 'glass', live: true }),
  Object.freeze({ id: 'retro', nameKey: 'settings_style_retro', skin: 'retro', accent: '#f5c518', background: '#050510', text: '#e8f6ff' }),
  // 'comic' is a real skin (themes-comic.css) but deliberately NOT a permanent
  // gallery card: it isn't a general-purpose console like Retro, it's the
  // companion look for a comic-styled theme/background. It's reached only by a
  // theme that selects styleMode:"comic" (e.g. an imported pack) — so users who
  // don't want it never see a stray card. The engine still lives in the app;
  // normStyleMode below keeps 'comic' valid everywhere it's applied.
]);

// The dashboard style languages (skins). 'glass' is the default; 'retro' and
// 'comic' are full skins, each a themes-<skin>.css keyed off
// :root[data-style="<skin>"]. 'retro' has a built-in card; 'comic' is only
// selected by a theme (above). Anything else normalizes back to 'glass'.
const STYLE_MODES = Object.freeze(['glass', 'retro', 'comic']);
const normStyleMode = (v) => (STYLE_MODES.includes(v) ? v : 'glass');

// The settings that make up a "theme": the whole visual identity of the Aspetto
// tab — mode, style, colours, surface and font — every one applied by
// applyHubSettings(). Topbar layout and the Sfondo (background media) tab are
// deliberately NOT part of a theme (structural/personal, not the look). Keep this
// the single source of truth: snapshot, apply and active-match all read from it.
const THEME_SETTING_KEYS = Object.freeze([
  'appearance', 'autoPalette', 'styleMode', 'retroScanlines',
  'accent', 'background', 'surface', 'surfaceAlt', 'controlColor',
  'text', 'mutedText', 'lineColor', 'accentText',
  'successColor', 'warningColor', 'dangerColor', 'infoColor', 'contrastGuard',
  'paletteVariants',
  'dynamicAlbumTheme',
  'panelAlpha', 'panelBorderStrength', 'panelShadowStrength',
  'uiRoundness', 'glassBlur', 'glassSaturate',
  'bgDim', 'bgBlur', 'bgAurora', 'bgGrid', 'bgStatic', 'bgCustom',
  'uiFont',
]);

// Declared before loadHubSettings() runs: normalizeLighting()/normalizeBgStatic()
// read these at module init, so they must not be in the temporal dead zone when
// settings hydrate.
const LIGHTING_STYLES = ['blink', 'pulse', 'solid'];
const BG_STATIC_STYLES = ['none', 'nebulosa', 'prisma', 'halo'];
// normalizeAmbientMode() also runs during that init, so its lookup tables must be
// initialized up here too — not further down the file. They previously sat below
// loadHubSettings() and threw "Cannot access 'AMBIENT_IDLE_MINUTES' before
// initialization" (a TDZ ReferenceError) on load, which aborted loadHubSettings
// and cascaded into "hubSettings is not defined" across every module.
const AMBIENT_IDLE_MINUTES = [0, 1, 2, 5, 10, 15, 30];
// sceneId is 'builtin' or an SDK package id (same charset as WIDGET_ID_RE in
// server/sdk-widgets.js — folder-name safe, never traverses).
const AMBIENT_SCENE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
// normalizeBgCustom() also runs during that init. Bounded even though the code
// only ever runs sandboxed — a huge snippet would bloat every settings save,
// theme snapshot and share code. Generous enough for an elaborate hand-drawn
// scene; genuinely heavy raster art belongs in bgCustom.assets, not the source.
// Keep in step with CODE_MAX in js/custom-bg.js (the sandbox second-guard).
const BG_CUSTOM_CODE_MAX = 60000;

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

// A pasted-SVG wallpaper is stored as a base64 data:image/svg+xml URI (not a
// served /uploads file). Bounded so it can't bloat the persisted settings blob.
const BG_SVG_DATA_RE = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/;
const BG_SVG_MAX_CHARS = 512 * 1024;
function sanitizeBackgroundMedia(value) {
  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || '').trim();
  const name = String(value.name || '').trim().slice(0, 120);
  const type = String(value.type || '').trim().slice(0, 60);
  const version = String(value.version || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  // A pasted SVG wallpaper lives inline as a base64 data: URI. It is only ever
  // rendered as an <img> source (secure static mode — no scripts/fetches), so it
  // is safe; bounded so it can't bloat the settings blob.
  if (url.startsWith('data:')) {
    if (url.length > BG_SVG_MAX_CHARS || !BG_SVG_DATA_RE.test(url)) return null;
    return { url, name: name || 'svg', type: 'image/svg+xml', version };
  }
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return null;
  if (!/^(image|video)\//.test(type)) return null;
  return { url, name: name || url.split('/').pop(), type, version };
}

// Custom UI font reference — mirrors sanitizeBackgroundMedia (server-side twin:
// sanitizeSettingsUiFont). Only a server-generated /uploads/ path with a known
// font extension survives; anything else resets to the default typeface.
function sanitizeUiFont(value) {
  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || '').trim();
  const name = String(value.name || '').trim().slice(0, 120);
  const version = String(value.version || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return null;
  const ext = url.slice(url.lastIndexOf('.') + 1).toLowerCase();
  if (!SETTINGS_FONT_EXTENSIONS.has(ext)) return null;
  return { url, name: name || url.split('/').pop(), version };
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

function normalizeAmbientMode(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.ambientMode;
  const idle = Number(source.idleMinutes);
  // sceneId is 'builtin', an SDK package id, or a "canvas:<id>" reference into
  // hubSettings.ambientScenes (a native canvas scene). Anything else resets to
  // the default so a stale reference can't strand the picker.
  const raw = typeof source.sceneId === 'string' ? source.sceneId : '';
  const isCanvas = typeof AmbientScene !== 'undefined' ? AmbientScene.isCanvasRef(raw) : /^canvas:[a-z0-9][a-z0-9-]{1,40}$/.test(raw);
  const sceneId = (raw === 'builtin' || AMBIENT_SCENE_ID_RE.test(raw) || isCanvas) ? raw : defaults.sceneId;
  return {
    enabled: source.enabled !== undefined ? !!source.enabled : defaults.enabled,
    idleMinutes: AMBIENT_IDLE_MINUTES.includes(idle) ? idle : defaults.idleMinutes,
    sceneId,
  };
}

// Native canvas Ambient scenes — client-owned array (like customThemes),
// deep-normalized through the shared AmbientScene module (which also needs
// DashboardInstances for per-component style/image validation). Both load AFTER
// settings.js, so at the initial parse-time loadHubSettings() they aren't ready
// yet: fall back to the RAW array (same idiom as normalizeDashboardLayout's
// copies) so a scene's styles/images are never stripped on hydrate — the deep
// normalize runs on the next save/sync once the modules are up. The renderer
// (ambient-canvas.js) re-normalizes before building DOM, so unvalidated raw
// never reaches the screen.
function normalizeAmbientScenes(value) {
  if (typeof AmbientScene !== 'undefined' && AmbientScene.normalizeScenes
      && typeof DashboardInstances !== 'undefined') {
    return AmbientScene.normalizeScenes(value);
  }
  return Array.isArray(value) ? value : [];
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
  const forecastDays = WEATHER_FORECAST_DAY_CHOICES.includes(Number(source.forecastDays))
    ? Number(source.forecastDays) : DEFAULT_HUB_SETTINGS.weather.forecastDays;
  return {
    mode,
    city: sanitizeWeatherCity(source.city),
    provider,
    refreshMin,
    forecastDays,
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

function normalizeBgStatic(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.bgStatic;
  return {
    style: BG_STATIC_STYLES.includes(source.style) ? source.style : defaults.style,
    intensity: clampNumber(source.intensity, 0, 100, defaults.intensity),
  };
}

// Bundled image assets ({name → data:image URI}) the draw() code can paint via
// drawImage. Embedded — never fetched — so a background stays self-contained and
// the sandbox CSP (connect-src 'none') is untouched. The rules live in ONE
// place: CustomBg.sanitizeBgAssets (js/custom-bg.js, loaded before this file;
// the server require()s the same module), so client, server and sandbox can
// never drift. Fail-closed: without CustomBg no asset survives normalization.
function normalizeBgAssets(value) {
  return (window.CustomBg && CustomBg.sanitizeBgAssets) ? CustomBg.sanitizeBgAssets(value) : {};
}
function normalizeBgCustom(value) {
  const source = value && typeof value === 'object' ? value : {};
  const code = typeof source.code === 'string' ? source.code.slice(0, BG_CUSTOM_CODE_MAX) : '';
  const out = {
    // No code → can't be "enabled" (nothing to render).
    enabled: !!source.enabled && !!code,
    name: typeof source.name === 'string' ? source.name.trim().slice(0, 60) : '',
    code,
    assets: normalizeBgAssets(source.assets),
    // Frame-rate cap (paints per second). Rule owner is CustomBg.sanitizeBgFps
    // (same single-owner shape as the assets above); fail-closed to the default.
    fps: (window.CustomBg && CustomBg.sanitizeBgFps) ? CustomBg.sanitizeBgFps(source.fps) : 30,
  };
  // Redistribution marker: set when the background arrived via a share code
  // (someone else's work → not re-exportable); cleared when the user replaces
  // the code with their own from the editor/presets.
  if (source.imported === true && code) out.imported = true;
  if (out.imported && typeof ContentInstalls !== 'undefined'
      && ContentInstalls.INSTALL_ID_RE.test(String(source.installId || ''))) {
    out.installId = String(source.installId);
  }
  return out;
}

// Slideshow config. The rules (MIME allowlist, per-image + total + count caps,
// interval clamp, fit mode) live in ONE place — SlideshowWidget.sanitizeSlideshow
// (js/slideshow-widget.js, loaded before this file; the server require()s the same
// module) — so client, server and normalizer never drift. Fail-closed: without the
// module nothing survives, matching normalizeBgAssets above.
function normalizeSlideshow(value) {
  return (window.SlideshowWidget && SlideshowWidget.sanitizeSlideshow)
    ? SlideshowWidget.sanitizeSlideshow(value)
    : { images: [], intervalMs: 6000, fit: 'cover' };
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
// Shared per-tile style normalizer (client global / server require of the same
// pure module), guarded so a missing dependency degrades to "no style".
function normTileStyle(src) {
  return (typeof DashboardInstances !== 'undefined' && DashboardInstances.normalizeTileStyle)
    ? DashboardInstances.normalizeTileStyle(src) : null;
}

function normalizeDashboardGeom(sourceItem, fallbackItem) {
  const s = sourceItem && typeof sourceItem === 'object' ? sourceItem : {};
  const intIn = (v, min, max, fb) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fb; };
  const out = {
    x: intIn(s.x, 0, DASHBOARD_GRID_COLUMNS - 1, fallbackItem.x),
    y: intIn(s.y, 0, DASHBOARD_GRID_MAX_ROW, fallbackItem.y),
    w: intIn(s.w, 1, DASHBOARD_GRID_COLUMNS, fallbackItem.w),
    h: intIn(s.h, 1, DASHBOARD_GRID_MAX_ROW, fallbackItem.h),
    visible: s.visible === undefined ? fallbackItem.visible : s.visible !== false,
  };
  const style = normTileStyle(s.style);
  if (style) out.style = style;
  return out;
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
    const style = normTileStyle(g.style);
    if (style) out[id].style = style;
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

// Minimal-island personalization: anchor + ordered segment list with hidden
// flags. Rebuild from the canonical id set (drop unknown/dupes, append missing
// in default order). Migrates the earlier {date,weather} booleans when `items`
// is absent. Mirrors normalizeTopbarClock on the server. The canonical id list
// is inlined (not a module const) because normalizeSettings runs at load time,
// before a top-level const would be initialised — a TDZ crash otherwise.
function normalizeTopbarClock(value) {
  const canonical = ['time', 'date', 'weather', 'vitals', 'dots', 'badges'];
  const v = value && typeof value === 'object' ? value : {};
  const align = ['center', 'left', 'right'].includes(v.align) ? v.align : 'center';
  const legacyHidden = {};
  if (!Array.isArray(v.items)) {
    if (v.date === false) legacyHidden.date = true;
    if (v.weather === false) legacyHidden.weather = true;
  }
  const seen = new Set();
  const items = [];
  if (Array.isArray(v.items)) {
    for (const it of v.items) {
      const id = it && typeof it === 'object' ? it.id : null;
      if (!canonical.includes(id) || seen.has(id)) continue;
      seen.add(id);
      items.push({ id, hidden: it.hidden === true });
    }
  }
  for (const id of canonical) {
    if (seen.has(id)) continue;
    items.push({ id, hidden: legacyHidden[id] === true });
  }
  return { align, items };
}

// Rebuild the imported-themes list from untrusted input (localStorage, server
// hydration, or a freshly imported preset): known keys only, every value coerced
// through the same helpers the live settings use, so a crafted theme can't slip
// an unclamped number or a non-hex colour into the store. Bounded to keep the
// gallery (and the synced settings blob) from growing without limit.
function normalizeCustomThemes(list) {
  if (!Array.isArray(list)) return [];
  const D = DEFAULT_HUB_SETTINGS;
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    // A full visual snapshot, every field coerced with the same helpers the live
    // settings use and keyed identically (styleMode, not skin) so applyThemeById
    // can hand it straight to normalizeSettings. Defaults fill any missing field,
    // so all cards carry the complete THEME_SETTING_KEYS set and compare cleanly.
    const theme = {
      id: String(raw.id || '').trim().slice(0, 40)
        || ('ct_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      name: String(raw.name || '').trim().slice(0, 40),
      appearance: ['light', 'dark', 'auto'].includes(raw.appearance) ? raw.appearance : D.appearance,
      autoPalette: raw.autoPalette === true || (raw.autoPalette == null && raw.appearance === 'auto'),
      styleMode: normStyleMode(raw.styleMode),
      retroScanlines: raw.retroScanlines !== false,
      accent: normalizeHex(raw.accent, D.accent),
      background: normalizeHex(raw.background, D.background),
      surface: normalizeHex(raw.surface, null),
      surfaceAlt: normalizeHex(raw.surfaceAlt, null),
      controlColor: normalizeHex(raw.controlColor, null),
      text: normalizeHex(raw.text, D.text),
      accentText: normalizeHex(raw.accentText, null),
      successColor: normalizeHex(raw.successColor, null),
      warningColor: normalizeHex(raw.warningColor, null),
      dangerColor: normalizeHex(raw.dangerColor, null),
      infoColor: normalizeHex(raw.infoColor, null),
      paletteVariants: normalizePaletteVariants(raw.paletteVariants),
      contrastGuard: raw.contrastGuard !== false,
      dynamicAlbumTheme: raw.dynamicAlbumTheme !== false,
      panelAlpha: clampNumber(raw.panelAlpha, SETTINGS_MIN_PANEL_ALPHA, 1, D.panelAlpha),
      panelBorderStrength: clampNumber(raw.panelBorderStrength, 0, 2, D.panelBorderStrength),
      panelShadowStrength: clampNumber(raw.panelShadowStrength, 0, 2, D.panelShadowStrength),
      uiRoundness: clampNumber(raw.uiRoundness, 0, 2, D.uiRoundness),
      glassBlur: clampNumber(raw.glassBlur, 0, 40, D.glassBlur),
      glassSaturate: clampNumber(raw.glassSaturate, 100, 220, D.glassSaturate),
      mutedText: normalizeHex(raw.mutedText, null),
      lineColor: normalizeHex(raw.lineColor, null),
      bgDim: clampNumber(raw.bgDim, 0.05, 0.9, D.bgDim),
      bgBlur: clampNumber(raw.bgBlur, 0, 24, D.bgBlur),
      bgAurora: normalizeBgAurora(raw.bgAurora),
      bgGrid: normalizeBgGrid(raw.bgGrid),
      bgStatic: normalizeBgStatic(raw.bgStatic),
      bgCustom: normalizeBgCustom(raw.bgCustom),
      uiFont: sanitizeUiFont(raw.uiFont),
    };
    // Redistribution marker: themes that arrived via a share code are someone
    // else's work — export blocks re-sharing them (see exportTheme guard).
    if (raw.imported === true) theme.imported = true;
    if (theme.imported && typeof ContentInstalls !== 'undefined'
        && ContentInstalls.INSTALL_ID_RE.test(String(raw.installId || ''))) {
      theme.installId = String(raw.installId);
    }
    out.push(theme);
    if (out.length >= 24) break;
  }
  return out;
}

// Dual-palette themes ({ light, dark }). ThemePalette owns the rules so client
// and server can't drift; theme-palette.js loads before this module. A function
// declaration (not a const): loadHubSettings() normalizes at module load, far
// above this line, and a const would still be in the temporal dead zone there.
function normalizePaletteVariants(value) {
  return ThemePalette.normalizeVariants(value);
}

// User fan names: a flat { "<kind>|<sensor name>": "label" } map. Explicit
// rebuild (no spread of untrusted input), bounded on both axes: keys follow the
// collector's shape (kind ≤8 + '|' + name ≤48), labels are what fits a row.
function normalizeFanLabels(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  let n = 0;
  for (const key of Object.keys(v)) {
    if (n >= 64) break;
    if (typeof key !== 'string' || key.length > 60 || !key.includes('|')) continue;
    const label = typeof v[key] === 'string' ? v[key].trim().slice(0, 32) : '';
    if (!label) continue;
    out[key] = label;
    n++;
  }
  return out;
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
    autoPalette: value.autoPalette === true || (value.autoPalette == null && value.appearance === 'auto'),
    styleMode: normStyleMode(value.styleMode),
    retroScanlines: value.retroScanlines !== false,
    topbarStyle: value.topbarStyle === 'minimal' ? 'minimal' : 'full',
    topbarRails: normalizeTopbarRails(value.topbarRails),
    topbarRailsAutoHide: value.topbarRailsAutoHide !== false,
    topbarClock: normalizeTopbarClock(value.topbarClock),
    clockFormat: ['auto', '12', '24'].includes(value.clockFormat) ? value.clockFormat : DEFAULT_HUB_SETTINGS.clockFormat,
    weekStart: ['mon', 'sun'].includes(value.weekStart) ? value.weekStart : DEFAULT_HUB_SETTINGS.weekStart,
    swipeNavigation: value.swipeNavigation !== false,
    swipeHomeGesture: value.swipeHomeGesture !== false,
    hideOnRdp: value.hideOnRdp === true,
    nativeZoom: clampNumber(value.nativeZoom, 0.6, 1.6, DEFAULT_HUB_SETTINGS.nativeZoom),
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
    hybridGpuAnimationPause: value.hybridGpuAnimationPause !== false,
    uiRoundness: clampNumber(value.uiRoundness, 0, 2, DEFAULT_HUB_SETTINGS.uiRoundness),
    glassBlur: clampNumber(value.glassBlur, 0, 40, DEFAULT_HUB_SETTINGS.glassBlur),
    glassSaturate: clampNumber(value.glassSaturate, 100, 220, DEFAULT_HUB_SETTINGS.glassSaturate),
    panelBorderStrength: clampNumber(value.panelBorderStrength, 0, 2, DEFAULT_HUB_SETTINGS.panelBorderStrength),
    panelShadowStrength: clampNumber(value.panelShadowStrength, 0, 2, DEFAULT_HUB_SETTINGS.panelShadowStrength),
    mutedText: normalizeHex(value.mutedText, null),
    lineColor: normalizeHex(value.lineColor, null),
    backgroundMedia: sanitizeBackgroundMedia(value.backgroundMedia),
    uiFont: sanitizeUiFont(value.uiFont),
    lockWidgets: normalizeLockWidgets(value.lockWidgets),
    ambientMode: normalizeAmbientMode(value.ambientMode),
    ambientScenes: normalizeAmbientScenes(value.ambientScenes),
    weather: normalizeWeatherSettings(value.weather),
    tempUnit: value.tempUnit === 'f' ? 'f' : 'c',
    autoOpenBrowser: value.autoOpenBrowser !== false,
    versionPing: value.versionPing === true,
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
    contentInstalls: (typeof ContentInstalls !== 'undefined' && ContentInstalls.normalizeContentInstalls)
      ? ContentInstalls.normalizeContentInstalls(value.contentInstalls) : [],
    geminiApiKey: String(value.geminiApiKey || '').trim().slice(0, 200),
    aiProvider: ['ollama', 'openai', 'anthropic'].includes(value.aiProvider) ? value.aiProvider : 'gemini',
    ollamaModel: (typeof value.ollamaModel === 'string'
      && /^[a-z0-9._:-]+$/.test(value.ollamaModel)
      && value.ollamaModel.length <= 60)
      ? value.ollamaModel : 'auto',
    // ChatGPT (OpenAI) + Claude (Anthropic). The keys are redacted to '' on the
    // wire (server-only) and re-supplied only while the user is typing one; the
    // *Set booleans carry "a key is saved" so the UI and the ready-gate know.
    openaiApiKey: String(value.openaiApiKey || '').trim().slice(0, 200),
    openaiApiKeySet: value.openaiApiKeySet === true || !!String(value.openaiApiKey || '').trim(),
    openaiModel: (typeof value.openaiModel === 'string' && value.openaiModel.trim() && value.openaiModel.length <= 60)
      ? value.openaiModel.trim() : 'gpt-4o',
    anthropicApiKey: String(value.anthropicApiKey || '').trim().slice(0, 200),
    anthropicApiKeySet: value.anthropicApiKeySet === true || !!String(value.anthropicApiKey || '').trim(),
    anthropicModel: (typeof value.anthropicModel === 'string' && value.anthropicModel.trim() && value.anthropicModel.length <= 60)
      ? value.anthropicModel.trim() : 'claude-sonnet-5',
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
    aiFeatures: normalizeAiFeatures(value.aiFeatures),
    sensorHistory: { enabled: !!(value.sensorHistory && value.sensorHistory.enabled === true) },
    fanLabels: normalizeFanLabels(value.fanLabels),
    proactive: normalizeProactive(value.proactive),
    notifications: normalizeNotifications(value.notifications),
    vitals: normalizeVitals(value.vitals),
    discordNotifications: normalizeDiscordNotifications(value.discordNotifications),
    windowsNotifications: normalizeWindowsNotifications(value.windowsNotifications),
    wakeWord: normalizeWakeWord(value.wakeWord),
    sdkWidgets: normalizeSdkWidgets(value.sdkWidgets),
    bgAurora: normalizeBgAurora(value.bgAurora),
    bgGrid: normalizeBgGrid(value.bgGrid),
    bgStatic: normalizeBgStatic(value.bgStatic),
    bgCustom: normalizeBgCustom(value.bgCustom),
    slideshow: normalizeSlideshow(value.slideshow),
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
    language: SUPPORTED_LANGS.includes(value.language) ? value.language : '',
  };
}

// Per-camera view transforms (rotation / flip / digital zoom+pan), shared by the
// UniFi and Home Assistant camera stores — same contract, different id shape.
// Mirrors server/actions/unifi.js normalizeUnifiAngles / home-assistant.js
// normalizeHaCamAngles. Identity entries (no rot/flip, zoom ≤ 1) are dropped.
function normalizeCamAngles(value, isId) {
  const rots = [0, 90, 180, 270];
  const clampPan = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(100, Math.max(-100, Math.round(n))) : 0; };
  const out = {};
  if (!value || typeof value !== 'object') return out;
  let n = 0;
  for (const id of Object.keys(value)) {
    if (n >= 60 || !isId(id)) continue;
    const a = value[id];
    if (!a || typeof a !== 'object') continue;
    const rot = rots.includes(a.rot) ? a.rot : 0;
    const flip = a.flip === 1 || a.flip === true ? 1 : 0;
    const z = Number(a.zoom);
    const zoom = Number.isFinite(z) ? Math.min(3, Math.max(1, Math.round(z * 100) / 100)) : 1;
    if (!rot && !flip && zoom <= 1) continue;
    const entry = { rot, flip };
    if (zoom > 1) {
      entry.zoom = zoom;
      const panX = clampPan(a.panX), panY = clampPan(a.panY);
      if (panX) entry.panX = panX;
      if (panY) entry.panY = panY;
    }
    out[id] = entry; n++;
  }
  return out;
}

// Home Assistant settings (client mirror). url/entities are client-managed; the
// token is a server-only secret — the client never persists a real one, but keeps
// a freshly-typed value until it's saved (then the server redacts it back to '').
// `tokenSet` (server-provided) drives the "saved" placeholder in the UI.
function normalizeHomeAssistant(value) {
  const src = (value && typeof value === 'object') ? value : {};
  const isEntity = (s) => typeof s === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(s.trim());
  const isCam = (s) => isEntity(s) && /^camera\./.test(String(s).trim());
  const entities = Array.isArray(src.entities)
    ? src.entities.filter(isEntity).filter((v, i, a) => a.indexOf(v) === i).slice(0, 100)
    : [];
  // Camera selection + per-camera view transforms — mirror server/actions/
  // home-assistant.js (normalizeHomeAssistant / normalizeHaCamAngles). Opt-in:
  // the `cameras` array is BOTH the selection and the display order.
  const cameras = Array.isArray(src.cameras)
    ? src.cameras.filter(isCam).filter((v, i, a) => a.indexOf(v) === i).slice(0, 60)
    : [];
  // Energy widget selection (power/energy sensors) — independent of the Smart
  // Home tile's `entities`; mirror of the server normalizer (cap 24).
  const energyEntities = Array.isArray(src.energyEntities)
    ? src.energyEntities.filter(isEntity).filter((v, i, a) => a.indexOf(v) === i).slice(0, 24)
    : [];
  const camAngles = normalizeCamAngles(src.camAngles, isCam);
  return {
    url: String(src.url || '').trim().slice(0, 200),
    token: typeof src.token === 'string' ? src.token.slice(0, 400) : '',
    entities,
    cameras,
    energyEntities,
    camAngles,
    tokenSet: src.tokenSet === true || (typeof src.token === 'string' && src.token.length > 0),
  };
}

// UniFi Protect settings (client mirror). host/username/cameras are client-managed;
// the console password is a server-only secret — the client never persists a real
// one but keeps a freshly-typed value until it's saved (then the server redacts it
// back to ''). `passwordSet` (server-provided) drives the "saved" placeholder.
function normalizeUnifi(value) {
  const src = (value && typeof value === 'object') ? value : {};
  const isCam = (s) => typeof s === 'string' && /^[A-Za-z0-9]{4,64}$/.test(s);
  const camIds = (arr) => (Array.isArray(arr)
    ? arr.filter(isCam).filter((v, i, a) => a.indexOf(v) === i).slice(0, 60)
    : []);
  const cols = Number(src.columns);
  const ms = Number(src.refreshMs);
  const fits = ['cover', 'contain'];
  const aspects = ['16:9', '4:3', '1:1'];
  const angles = normalizeCamAngles(src.angles, isCam);
  // Notification prefs — mirror server/actions/unifi.js normalizeUnifiNotify. When
  // the block is absent (fresh/upgrade) a sensible starter set is enabled so turning
  // notifications on isn't silent; once present, the exact choices are honoured.
  const notifyKinds = ['person', 'vehicle', 'package', 'animal', 'motion', 'ring'];
  const ns = (src.notify && typeof src.notify === 'object') ? src.notify : {};
  const nst = (ns.types && typeof ns.types === 'object') ? ns.types : { person: true, vehicle: true, ring: true };
  const notifyTypes = {};
  for (const k of notifyKinds) notifyTypes[k] = nst[k] === true;
  const nsCd = Number(ns.cooldownSec);
  const notify = {
    enabled: ns.enabled === true,
    types: notifyTypes,
    cooldownSec: Number.isFinite(nsCd) ? Math.min(600, Math.max(5, Math.round(nsCd))) : 45,
  };
  return {
    host: String(src.host || '').trim().slice(0, 200),
    username: String(src.username || '').trim().slice(0, 120),
    password: typeof src.password === 'string' ? src.password.slice(0, 200) : '',
    cameras: camIds(src.cameras),
    passwordSet: src.passwordSet === true || (typeof src.password === 'string' && src.password.length > 0),
    // Display-layout prefs — mirror server/actions/unifi.js normalizeUnifiLayout.
    columns: Number.isFinite(cols) ? Math.min(6, Math.max(0, Math.round(cols))) : 0,
    fit: fits.includes(src.fit) ? src.fit : 'cover',
    aspect: aspects.includes(src.aspect) ? src.aspect : '16:9',
    order: camIds(src.order),
    refreshMs: Number.isFinite(ms) ? Math.min(60000, Math.max(500, Math.round(ms))) : 1500,
    angles,
    notify,
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
  // chromeHidden (toolbar hidden) is a per-tile UI pref that MUST round-trip: it
  // was silently dropped here, so hiding the toolbar on one surface never reached
  // the others — it only applied on the screen that set it, in memory, until a
  // reload wiped it (GitHub #101).
  const chromeHidden = !!entry.chromeHidden;
  if (Array.isArray(entry.tabs)) {
    const tabs = entry.tabs.slice(0, 6).map((tb) => ({ url: String((tb && tb.url) || '').slice(0, 2048) }));
    if (!tabs.length) return null;
    if (tabs.length === 1 && !tabs[0].url && !chromeHidden) return null;   // a lone blank tab isn't worth persisting (unless a UI pref rides on it)
    const active = Math.max(0, Math.min(tabs.length - 1, parseInt(entry.active, 10) || 0));
    return { tabs, active, chromeHidden };
  }
  const url = String(entry.url || '').slice(0, 2048);
  return (url || chromeHidden) ? { url, chromeHidden } : null;
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
  return { enabled: v.enabled !== false, popups: v.popups !== false, sounds: v.sounds !== false };
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
  const thrSrc = petSrc.thresholds && typeof petSrc.thresholds === 'object' ? petSrc.thresholds : {};
  const thresholds = {};
  VITALS_PET_STAGES.forEach((stage) => {
    thresholds[stage] = Math.round(clampNumber(thrSrc[stage], 1, 480, VITALS_PET_DEFAULT_THR[stage]));
  });
  const pet = {
    enabled: petSrc.enabled === true,
    tone: ['soft', 'spicy', 'savage'].includes(petSrc.tone) ? petSrc.tone : 'spicy',
    effects: petSrc.effects !== false,
    sounds: petSrc.sounds !== false,
    lighting: petSrc.lighting === true,
    monitors: petSrc.monitors === true,
    minimize: petSrc.minimize === true,
    lock: petSrc.lock === true,
    quietInGame: petSrc.quietInGame !== false,
    // Where Bit lives: the floating corner sprite, a mini chip in the topbar
    // clock cluster, or both. AI roasts (Xenon AI-generated lines with offline
    // bank fallback) are strict opt-in; night quiet (23–07: Bit sleeps, never
    // escalates past decay) is on by default.
    position: ['floating', 'topbar', 'both'].includes(petSrc.position) ? petSrc.position : 'floating',
    aiRoasts: petSrc.aiRoasts === true,
    nightQuiet: petSrc.nightQuiet !== false,
    thresholds,
  };
  // Bit's durable bookkeeping (state.pet): truce (snooze/mute-today) and the
  // per-episode escalation flags, persisted so a reload can't re-fire GAME
  // OVER/minimize/lock and a truce granted on one surface holds on the others.
  // Episodes are keyed by z = the episode's zeroAt instant (a stable identity
  // across reloads and surfaces). Known-key rebuild — never spread.
  const petStSrc = stateSrc.pet && typeof stateSrc.pet === 'object' ? stateSrc.pet : {};
  const epSrc = petStSrc.ep && typeof petStSrc.ep === 'object' ? petStSrc.ep : {};
  const ep = {};
  VITALS_IDS.forEach((id) => {
    const e = epSrc[id];
    if (!e || typeof e !== 'object') return;
    const z = Number(e.z);
    if (!Number.isFinite(z) || z <= 0) return;
    ep[id] = {
      z: Math.floor(z),
      goAt: Math.max(0, Math.floor(Number(e.goAt) || 0)),
      ovAt: Math.max(0, Math.floor(Number(e.ovAt) || 0)),
      min: e.min === true,
      lock: e.lock === true,
    };
  });
  const statePet = {
    snoozeUntil: Math.round(clampNumber(petStSrc.snoozeUntil, 0, Date.now() + 24 * 3600000, 0)),
    muteDay: typeof petStSrc.muteDay === 'string' ? petStSrc.muteDay.slice(0, 10) : '',
    ep,
  };
  // Bit's long-term memory: daily self-care streak + grow-only lifetime
  // counters (fuel for contextual/AI roasts and streak praise).
  const memSrc = stateSrc.mem && typeof stateSrc.mem === 'object' ? stateSrc.mem : {};
  const mem = {
    streak: Math.round(clampNumber(memSrc.streak, 0, 100000, 0)),
    bestStreak: Math.round(clampNumber(memSrc.bestStreak, 0, 100000, 0)),
    lastFillDay: typeof memSrc.lastFillDay === 'string' ? memSrc.lastFillDay.slice(0, 10) : '',
    locksTotal: Math.round(clampNumber(memSrc.locksTotal, 0, 1e6, 0)),
    gameoversTotal: Math.round(clampNumber(memSrc.gameoversTotal, 0, 1e6, 0)),
  };
  return {
    enabled: v.enabled !== false,
    topbar: v.topbar === true,
    reminders: v.reminders !== false,
    // Freeze the meters while the user is away from the PC (no real input for
    // 5+ min, via the server idle probe) and resume exactly where they were.
    awayPause: v.awayPause !== false,
    pet,
    items,
    state: {
      last,
      xp: Math.round(clampNumber(stateSrc.xp, 0, 1e9, 0)),
      day: typeof stateSrc.day === 'string' ? stateSrc.day.slice(0, 10) : '',
      fills: Math.round(clampNumber(stateSrc.fills, 0, 100000, 0)),
      // Today's refills in order (the widget's "combo ribbon"); bounded.
      log: Array.isArray(stateSrc.log) ? stateSrc.log.filter(x => VITALS_IDS.includes(x)).slice(-40) : [],
      // freezeStart identity of the last credited away period (see
      // vitals-pet-core.awayCredit) — merged as max server-side.
      awayCreditAt: Math.max(0, Math.floor(Number(stateSrc.awayCreditAt) || 0)),
      pet: statePet,
      mem,
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
// MUST mirror sdk-widgets.js SDK_STREAMS and Object.keys(SDK_ACTION_CATEGORIES)
// — a grant carrying a stream/action the server allows but this list omits gets
// silently stripped on save, so the widget is granted a capability it can never
// use (the exact bug where a to-do widget's `tasks` stream+action were dropped,
// leaving it empty and un-writable). server/test/sdk-grant-cats-sync guards this.
const SDK_WIDGET_STREAMS = Object.freeze(['status', 'system', 'media', 'audio', 'wavelink', 'stocks', 'football', 'news', 'claude', 'obs', 'discord', 'discordChannels', 'discordSoundboard', 'discordNotifications', 'streamerbot', 'homeassistant', 'tasks', 'notes', 'agenda', 'weather', 'battery']);
const SDK_WIDGET_ACTION_CATS = Object.freeze(['media', 'volume', 'mic', 'lighting', 'chroma', 'wavelink', 'spotify', 'obs', 'discord', 'homeassistant', 'twitch', 'youtube', 'streamerbot', 'url', 'tasks', 'soundboard']);
const SDK_PACKAGE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
// Grant-side mirrors of the server manifest rules (sdk-widgets.js is the
// authority; a grant can never widen what the manifest declared, so a loose
// hostname check here is safe — the server re-validates every proxied fetch).
const SDK_HOST_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const SDK_SUB_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
// Addresses the user typed into a manifest's userHosts slots, keyed by slot id.
// Same reasoning as SDK_HOST_RE: keep the shape, let sdk-widgets.js
// resolveUserHosts be the authority — it re-validates host and scope on every
// proxied request, so nothing here can widen the allowlist. What this DOES have
// to get right is round-tripping the value unharmed: a key silently dropped on
// save is a host the user configured that never reaches the server.
function normalizeSdkUserHosts(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  let n = 0;
  for (const key of Object.keys(v)) {
    if (n >= 4) break;
    if (!SDK_SUB_ID_RE.test(key)) continue;
    const slot = v[key];
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) continue;
    const host = String(slot.host || '').trim().toLowerCase();
    if (!SDK_HOST_RE.test(host)) continue;
    const port = Number(slot.port);
    out[key] = {
      host,
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0,
      scheme: slot.scheme === 'https' ? 'https' : 'http',
    };
    n++;
  }
  return out;
}
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
        handlers: Array.isArray(g.handlers) ? g.handlers.filter((s, i, a) => typeof s === 'string' && SDK_SUB_ID_RE.test(s) && a.indexOf(s) === i).slice(0, 8) : [],
        // The all-or-nothing consent flags and the user-filled addresses. These
        // MUST be listed: this rebuild is an allowlist, so a key it omits is
        // stripped from the grant on every save. Omitting `storage`/`secrets`
        // silently disabled both features and — because grantNeedsReview asks
        // "does the manifest declare something the grant lacks?" — pinned any
        // widget requesting them in a permanent "asks for new permissions" loop.
        storage: g.storage === true,
        secrets: g.secrets === true,
        island: g.island === true,
        badge: g.badge === true,
        clipboard: g.clipboard === true,
        userHosts: normalizeSdkUserHosts(g.userHosts),
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
      } else if (e.type === 'custom') {
        // User-added RSS URL. The server assigns the deterministic id + validates the
        // host; the client only preserves what came back, so a plain settings save
        // (e.g. toggling "show images") can't drop or corrupt a custom feed.
        const id = String(e.id || '').trim().slice(0, 40);
        const url = String(e.url || '').trim().slice(0, 600);
        if (!id || !/^https:\/\//i.test(url) || seen.has('c:' + id)) continue;
        seen.add('c:' + id);
        feeds.push({ id, type: 'custom', name: String(e.name || '').trim().slice(0, 40), url });
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
    // style is 'glass'/'retro' OR a saved custom theme id (ct_…). Loosely bounded
    // like page/deck — the gallery validates it at apply time (an id that no
    // longer exists simply no-ops), so a removed theme never wedges a profile.
    const styleId = typeof e.style === 'string' ? e.style.slice(0, 40) : '';
    map[act] = {
      page: typeof e.page === 'string' ? e.page.slice(0, 64) : '',
      lighting: CONTEXT_LIGHTING_STYLES.includes(e.lighting) ? e.lighting : '',
      deck: typeof e.deck === 'string' ? e.deck.slice(0, 80) : '',
      style: /^[a-z0-9_-]+$/i.test(styleId) ? styleId : '',
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
  // Server-only secrets stay OUT of localStorage (unlike geminiApiKey, which the
  // browser legitimately holds): the OpenAI/Anthropic keys, the UniFi console
  // password and the Home Assistant token. They stay in memory only long enough
  // for the pending POST to reach the server, which then redacts them back to ''
  // on the next hydrate. The *Set flags are kept so the readiness checks and the
  // "saved" placeholders survive a reload.
  let forLocal = hubSettings;
  if (hubSettings && (hubSettings.openaiApiKey || hubSettings.anthropicApiKey
      || (hubSettings.unifi && hubSettings.unifi.password)
      || (hubSettings.homeAssistant && hubSettings.homeAssistant.token))) {
    forLocal = { ...hubSettings, openaiApiKey: '', anthropicApiKey: '' };
    if (forLocal.unifi && forLocal.unifi.password) forLocal.unifi = { ...forLocal.unifi, password: '' };
    if (forLocal.homeAssistant && forLocal.homeAssistant.token) forLocal.homeAssistant = { ...forLocal.homeAssistant, token: '' };
  }
  // Asset-carrying backgrounds/theme cards can push the blob past the origin
  // quota; a thrown setItem must not abort the save flow (the server copy —
  // written right after — is the authoritative one and still gets the change).
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(forLocal));
  } catch (err) {
    console.warn('settings: local mirror skipped (storage quota?)', err);
  }
}

function postHubSettingsToServer() {
  // NO keepalive here: keepalive caps the request body at 64KB across the whole
  // page, and a settings blob with imported themes / Ambient scenes / decor easily
  // exceeds that — the fetch then rejects IMMEDIATELY ("Failed to fetch") and the
  // save never reaches the server, while the localStorage mirror makes everything
  // look saved on this screen. That silent divergence is exactly how UniFi camera
  // credentials kept "un-saving" for customized installs (same lesson as the Deck
  // outbox flush in deck.js). This POST runs while the page is alive (debounced
  // 250ms after the change), so it doesn't need to outlive an unload —
  // sendHubSettingsBeacon covers that case. A non-2xx answer rejects too, so
  // callers/retries can tell a failed save from a landed one.
  const body = JSON.stringify({ settings: normalizeSettings(hubSettings) });
  return fetch('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }).then(async (res) => {
    // Always drain the response, success or error: an UNREAD body bigger than
    // the network buffer keeps its connection permanently checked out of the
    // browser's 6-per-host pool. When the save ack still echoed the full
    // settings (multi-MB with imported themes), five discarded echoes + the
    // SSE stream starved the whole pool and every later request on the page
    // queued forever — the proven "dashboard deaf after importing a heavy
    // theme" wedge. The ack is slim now ({ok, rev}); the drain stays as the
    // client-side guarantee that no response can ever pin a connection again.
    try { await res.arrayBuffer(); } catch { /* stream already closed — the connection is free either way */ }
    if (!res.ok) { const e = new Error('settings save failed: HTTP ' + res.status); e.status = res.status; throw e; }
    return res;
  });
}

// A 4xx means the SERVER rejected this body and always will (malformed/oversized
// settings) — retrying can only loop forever, so give up and say so once. 408/429
// are the retryable exceptions (request timeout / rate limit). Anything without a
// status is a transport error (offline, server mid-restart) → retryable.
function _settingsSaveRetryable(err) {
  const s = err && err.status;
  if (!(typeof s === 'number' && s >= 400 && s < 500)) return true;
  return s === 408 || s === 429;
}

// Retry a failed background save with capped backoff for as long as the page
// lives (the change is already safe in the localStorage mirror; a one-shot POST
// to a server mid-restart is exactly what used to lose it). Token-superseded:
// a newer queued save or an explicit flush cancels the chain, and every attempt
// re-serializes the CURRENT settings, so a retry can never push stale state.
let _settingsSaveToken = 0;
function _postHubSettingsWithRetry(token, attempt) {
  if (token !== _settingsSaveToken) return;          // superseded by a newer save
  postHubSettingsToServer().catch((err) => {
    if (token !== _settingsSaveToken) return;
    if (!_settingsSaveRetryable(err)) {              // permanent client error → stop
      console.error('settings: server rejected the save and won\'t accept it — giving up', err);
      return;
    }
    if (attempt === 4) console.warn('settings: server save keeps failing, still retrying', err);
    setTimeout(() => _postHubSettingsWithRetry(token, attempt + 1), Math.min(800 * Math.pow(2, attempt), 10000));
  });
}

function queueHubSettingsServerSave() {
  clearTimeout(settingsServerSaveTimer);
  const token = ++_settingsSaveToken;
  settingsServerSaveTimer = setTimeout(() => {
    settingsServerSaveTimer = null;
    _postHubSettingsWithRetry(token, 0);
  }, 250);
}

// ── weather config: its OWN save channel, not the whole-settings blob ────────
// Weather (location/mode/provider/tile prefs) is edited from Settings on any
// surface, but the whole-blob transport is shared with high-frequency automatic
// saves (a Vitals/Bit heartbeat) and the unload beacon. A blob push from a
// surface that still holds the OLD location would clobber a change just made
// here via last-writer-wins — the empirically-reported "XENON stays on the wrong
// weather location, browser only fixes on Ctrl+R" bug (GitHub #109). So weather
// is persisted like the stocks watchlist / news feeds: a dedicated endpoint the
// server treats as the sole writer (POST /settings keeps prev.weather). The
// server bumps rev + broadcasts, so peer surfaces re-hydrate and refetch (#72).
let weatherConfigSaveTimer = null;
let _weatherConfigSaveToken = 0;
let _weatherConfigSavePending = false;  // a change made before the first hydrate
// The rev MUST travel with the weather block, exactly like the whole-blob save
// sends its own. commitWeatherChange() bumps the local rev on every keystroke in
// the city field while only the last one survives the 250ms debounce, so a server
// that re-derived the rev from its own stored copy (prevRev + 1) would fall
// several revisions BEHIND this surface. That gap is not cosmetic: a lower server
// rev makes _runSettingsSseHydrate() skip every incoming broadcast, and makes the
// boot hydrate treat the local copy as newer and ignore the server's — so this
// surface stops adopting a location set on another one (the "browser keeps auto
// location" residual of GitHub #109).
function weatherConfigPayload() {
  return {
    weather: normalizeWeatherSettings(hubSettings && hubSettings.weather),
    rev: Number.isFinite(hubSettings && hubSettings.rev) ? hubSettings.rev : 0,
  };
}
function postWeatherConfigToServer() {
  return fetch('/api/weather/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(weatherConfigPayload()),
  }).then(async (res) => {
    try { await res.arrayBuffer(); } catch { /* connection freed either way */ }
    if (!res.ok) { const e = new Error('weather save failed: HTTP ' + res.status); e.status = res.status; throw e; }
    return res;
  });
}
function _postWeatherConfigWithRetry(token, attempt) {
  if (token !== _weatherConfigSaveToken) return;               // superseded by a newer save
  postWeatherConfigToServer().catch((err) => {
    if (token !== _weatherConfigSaveToken) return;
    if (!_settingsSaveRetryable(err)) {                         // permanent client error → stop
      console.error('weather: server rejected the save and won\'t accept it — giving up', err);
      return;
    }
    setTimeout(() => _postWeatherConfigWithRetry(token, attempt + 1), Math.min(800 * Math.pow(2, attempt), 10000));
  });
}
function queueWeatherConfigServerSave() {
  clearTimeout(weatherConfigSaveTimer);
  const token = ++_weatherConfigSaveToken;
  weatherConfigSaveTimer = setTimeout(() => {
    weatherConfigSaveTimer = null;
    _postWeatherConfigWithRetry(token, 0);
  }, 250);
}

// Persist a weather-block change: bump rev + mirror locally (so this surface
// shows it at once), exactly like saveHubSettings — but push ONLY the weather
// block through its dedicated endpoint instead of the whole-settings blob. Every
// weather control calls this in place of saveHubSettings(); see the note above.
function commitWeatherChange() {
  const cur = Number.isFinite(hubSettings && hubSettings.rev) ? hubSettings.rev : 0;
  hubSettings = normalizeSettings({ ...hubSettings, rev: cur + 1 });
  saveLocalHubSettings();
  if (_hubHydratedFromServer) queueWeatherConfigServerSave();
  else _weatherConfigSavePending = true;   // flushed right after the first hydrate
}

// Immediate, awaitable save: cancel the debounced duplicate AND any retry chain
// (both would only re-post the same current state after us), then POST now.
// For callers that need the server to have the change before their next step —
// the browser-adblock relaunch, the Cameras connect flow refreshing its tiles.
function flushHubSettingsToServer() {
  clearTimeout(settingsServerSaveTimer);
  settingsServerSaveTimer = null;
  _settingsSaveToken++;
  return postHubSettingsToServer();
}
window.flushHubSettingsToServer = flushHubSettingsToServer;

// POST /settings overwrites the server copy wholesale (last-writer-wins), so a
// client that has not yet merged with the server MUST NOT push: a freshly wiped
// localStorage (app reinstall, WebView profile reset) would push factory
// defaults over the user's entire configuration — which is exactly what once
// destroyed a real install's theme/pages/settings. Until the first hydrate
// completes, server-bound saves are parked local-only and flushed (now carrying
// the merged, server-informed state) right after the hydrate.
let _hubHydratedFromServer = false;
let _hubServerSavePending = false;

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
  if (toServer) {
    if (_hubHydratedFromServer) queueHubSettingsServerSave();
    else _hubServerSavePending = true;
  }
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

// Fans-widget rename bridge. An empty/blank label deletes the key — that's the
// reset path back to the sensor's own name.
window.getFanLabels = () => ({ ...((hubSettings && hubSettings.fanLabels) || {}) });
window.setFanLabel = (key, label) => {
  const cur = { ...((hubSettings && hubSettings.fanLabels) || {}) };
  const k = String(key || '').slice(0, 60);
  const v = String(label || '').trim().slice(0, 32);
  if (!k) return cur;
  if (v) cur[k] = v; else delete cur[k];
  hubSettings = normalizeSettings({ ...hubSettings, fanLabels: cur });
  saveHubSettings();
  return hubSettings.fanLabels;
};

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

// UniFi Protect settings bridge for the Cameras page module. The password is
// write-only from the client's side: an empty patch.password leaves the stored one
// untouched (the server preserves it), so a save never wipes a saved password
// unless the user explicitly typed a new one.
// Fallback = the one canonical default (frozen — consumers already copy before
// mutating); hand-maintaining a second literal here drifted once already.
window.getUnifiSettings = () => (hubSettings && hubSettings.unifi) || DEFAULT_HUB_SETTINGS.unifi;
window.setUnifiSettings = (patch) => {
  const cur = (hubSettings && hubSettings.unifi) || {};
  const next = { ...cur, ...(patch || {}) };
  hubSettings = normalizeSettings({ ...hubSettings, unifi: next });
  saveHubSettings();
  return hubSettings.unifi;
};

function sendHubSettingsBeacon() {
  // Same wipe guard as saveHubSettings: a page that never merged with the
  // server (fresh storage, server down at boot) must not beacon its defaults
  // over the user's stored configuration on unload.
  if (!_hubHydratedFromServer) return;
  // A weather change still inside its 250ms debounce would be lost on unload: the
  // whole-blob beacon below no longer carries weather (POST /settings keeps
  // prev.weather), so flush it through its own endpoint. sendBeacon first, then a
  // keepalive fetch — the only requests that survive the page tearing down.
  if (weatherConfigSaveTimer) {
    weatherConfigSaveTimer = null;
    try {
      const wbody = JSON.stringify(weatherConfigPayload());   // carries the rev too — see the note there
      if (!(navigator.sendBeacon && navigator.sendBeacon('/api/weather/config', new Blob([wbody], { type: 'application/json' })))) {
        fetch('/api/weather/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: wbody, keepalive: true }).catch(() => {});
      }
    } catch { /* best-effort on unload */ }
  }
  try {
    const body = JSON.stringify({ settings: normalizeSettings(hubSettings) });
    // sendBeacon refuses bodies over its ~64KB queue limit (returns false), and a
    // settings blob with imported themes/scenes exceeds it. When it refuses, fall
    // back to a KEEPALIVE fetch — on unload that's the only request that survives
    // the page tearing down (a plain fetch is cancelled). Keepalive shares the same
    // ~64KB cap, but a >64KB body simply can't be delivered on unload by any method,
    // so that rejects harmlessly here; the live-page debounced save (no keepalive,
    // no cap) is what covers large blobs before it ever gets to unload.
    if (navigator.sendBeacon
        && navigator.sendBeacon('/settings', new Blob([body], { type: 'application/json' }))) {
      return;
    }
    fetch('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {}
}

// Hydrate could not read the server copy (offline at boot, server restarting):
// keep retrying in the background — server-bound saves stay parked until one
// attempt succeeds, so a blind client can never clobber the stored settings.
let _hubHydrateRetryTimer = null;
function scheduleHubHydrateRetry() {
  if (_hubHydrateRetryTimer || _hubHydratedFromServer) return;
  _hubHydrateRetryTimer = setTimeout(() => {
    _hubHydrateRetryTimer = null;
    // A reconnect reconcile may have hydrated us in the meantime — don't re-fetch.
    if (_hubHydratedFromServer) return;
    hydrateHubSettingsFromServer();
  }, 4000);
}

let _hubHydrateInflight = null;
// Dedupe concurrent hydrates. es.onopen fires on the FIRST SSE connect too, so the
// module-load hydrate and the SSE-onopen reconcile can both start before either
// finishes — that would run two overlapping fetch+normalize+save passes (and a
// redundant server POST) on every normal load. Share the in-flight promise instead.
function hydrateHubSettingsFromServer() {
  if (_hubHydrateInflight) return _hubHydrateInflight;
  _hubHydrateInflight = _hydrateHubSettingsImpl().finally(() => { _hubHydrateInflight = null; });
  return _hubHydrateInflight;
}
async function _hydrateHubSettingsImpl() {
  try {
    const res = await fetch('/settings', { cache: 'no-store' });
    if (!res.ok) { scheduleHubHydrateRetry(); return; }
    const data = await res.json().catch(() => ({}));
    if (!data || !data.settings) {
      // Server answered but has no settings payload (pre-/settings build): the
      // legacy seed path. Only seed it from a local copy that has real history —
      // never from factory defaults (rev 0), which would overwrite nothing
      // useful anyway and could mask a transient error as "configured".
      _hubHydratedFromServer = true;
      const seeded = loadHubSettings();
      if ((Number(seeded.rev) || 0) > 0) queueHubSettingsServerSave();
      return;
    }
    const keyBefore = hubSettings && hubSettings.geminiApiKey;
    // Keep locally-stored sensitive keys (geminiApiKey) even if the server
    // copy is older and doesn't have them yet.
    let rawLocal = {};
    try { rawLocal = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || '{}') || {}; } catch { rawLocal = {}; }
    const localRaw = normalizeSettings(rawLocal);
    const serverRev = Number.isFinite(data.settings.rev) ? data.settings.rev : 0;
    const localRev = Number.isFinite(localRaw.rev) ? localRaw.rev : 0;
    // If the local copy is newer than the server's — a change (e.g. a new page or
    // a moved widget) that didn't reach the server before the last shutdown —
    // keep local and push it back, instead of letting the stale server copy
    // clobber it. Otherwise the server copy wins (covers a wiped localStorage).
    const localNewer = localRev > serverRev;
    const base = localNewer ? localRaw : data.settings;
    // Grid-units laundering fence (mirror of the server's POST /settings
    // guard): when the RAW local copy predates the 24-column grid (no
    // layout.gridCols flag) while the server's is already migrated, the local
    // geometry was authored by pre-v4 JS — possibly by CLAMPING this server's
    // already-migrated 24-column layout down to 12 columns. normalizeSettings
    // above just re-migrated that ×2 and stamped the flag, so pushing it
    // (localNewer, e.g. a save that never landed while the server restarted
    // for the update) would hand the server doubled, full-screen geometry it
    // has no way to detect. Layout and presets from the server win instead.
    // The same stale-schema signal also means every settings section the old
    // client never knew is absent from the raw local copy — fill those from
    // the server too, or normalize would reset them to factory defaults and
    // the localNewer push would spread that over the user's configuration.
    const serverLayout = data.settings.dashboardLayout;
    const localUnitsStale = localNewer
      && serverLayout && Number(serverLayout.gridCols) === DASHBOARD_GRID_COLUMNS
      && Number(rawLocal.dashboardLayout && rawLocal.dashboardLayout.gridCols) !== DASHBOARD_GRID_COLUMNS;
    // Snapshot the rendered page list so we can tell, after merging, whether the
    // set of dashboard pages changed (e.g. the server copy restored a page that
    // the local copy — rendered at startup — didn't have). applyDashboardLayout
    // only places widgets into EXISTING page grids; a new page needs the pager
    // rebuilt, or its section/dot never appears until a manual reload.
    const pagesBefore = JSON.stringify(getDashboardLayout().pages.map(p => p.id));
    // Snapshot which widgets sit on which page too. A widget ADDED on another
    // surface (a primary made visible, a duplicate/custom copy, or a group change)
    // reaches us in the layout, but the incremental applyDashboardLayout pass
    // doesn't reliably materialize a newly-visible PRIMARY tile (a bare <section>
    // that lives in #widget-pool until wrapped by a full grid mount) — so it only
    // showed up after a manual reload (GitHub #72). When this placement signature
    // changes we do a full pager rebuild instead, exactly what a reload does.
    const placementBefore = _dashboardPlacementSig(getDashboardLayout());
    // Snapshot the SDK-widget assign/grants so we can tell whether a custom widget
    // was installed/assigned elsewhere: the assign map syncs via settings, but the
    // installed-package registry is a separate /sdk/widgets fetch the other screen
    // never refreshes on sync — leaving the tile stuck on "package was removed"
    // until a manual Rescan (GitHub #72). Refresh the registry when this changes.
    const sdkBefore = JSON.stringify((hubSettings && hubSettings.sdkWidgets) || {});
    // Weather inputs before the merge: when ANOTHER surface changed them, this
    // sync path is the only signal we get — without a refetch here the widget
    // keeps showing the previous location's data until the next poll (GitHub
    // #72: the Edge stayed on stale weather; only an actual language change
    // happened to refetch, via setLang → fetchWeather).
    const weatherBefore = _weatherSyncSig(hubSettings && hubSettings.weather);
    hubSettings = normalizeSettings({
      ...base,
      ...(localUnitsStale
        ? { ...data.settings, ...rawLocal, dashboardLayout: serverLayout, dashboardPresets: data.settings.dashboardPresets }
        : {}),
      rev: Math.max(localRev, serverRev),
      geminiApiKey: localRaw.geminiApiKey || data.settings.geminiApiKey || '',
      // Client-owned settings: keep whichever side actually has them so they
      // survive an older server build / a server restart.
      performance: base.performance || data.settings.performance || localRaw.performance,
      // Imported themes are client-owned (like dashboardPresets); an older server
      // that doesn't round-trip them yet must never blank the gallery on hydrate.
      customThemes: (Array.isArray(base.customThemes) && base.customThemes.length) ? base.customThemes
        : (Array.isArray(localRaw.customThemes) && localRaw.customThemes.length) ? localRaw.customThemes
        : (Array.isArray(data.settings.customThemes) ? data.settings.customThemes : []),
      contentInstalls: (Array.isArray(base.contentInstalls) && base.contentInstalls.length) ? base.contentInstalls
        : (Array.isArray(localRaw.contentInstalls) && localRaw.contentInstalls.length) ? localRaw.contentInstalls
        : (Array.isArray(data.settings.contentInstalls) ? data.settings.contentInstalls : []),
      // Native canvas Ambient scenes are client-owned too — same survival rule.
      ambientScenes: (Array.isArray(base.ambientScenes) && base.ambientScenes.length) ? base.ambientScenes
        : (Array.isArray(localRaw.ambientScenes) && localRaw.ambientScenes.length) ? localRaw.ambientScenes
        : (Array.isArray(data.settings.ambientScenes) ? data.settings.ambientScenes : []),
      gameMode: typeof base.gameMode === 'boolean' ? base.gameMode
        : (typeof data.settings.gameMode === 'boolean' ? data.settings.gameMode : localRaw.gameMode),
    });
    saveHubSettings({ server: false });
    // The merge landed — server-bound saves are safe from here on: whatever we
    // push now carries the server-informed state, never blind defaults.
    _hubHydratedFromServer = true;
    // Back the local copy up to the server when it won the merge, when it holds
    // an API key the server was missing (also triggers wake-word start), or when
    // a save was parked while we were still blind (pre-hydrate user change).
    if (localNewer || (hubSettings.geminiApiKey && !data.settings.geminiApiKey)
        || _hubServerSavePending) {
      // Through the queue (not a one-shot POST): a save the server misses here —
      // restarting mid-update, a transient network error — retries until it lands.
      queueHubSettingsServerSave();
    }
    _hubServerSavePending = false;
    // A weather change made before this first hydrate was parked (it must not push
    // over its own dedicated channel until we've merged with the server); flush it
    // now that we have, so the pre-hydrate location edit still reaches the server.
    if (_weatherConfigSavePending) { _weatherConfigSavePending = false; queueWeatherConfigServerSave(); }
    applyHubSettings();
    // Rebuild the pager when the page set changed (creates the missing page
    // section + dot); otherwise just reposition widgets in the existing grids.
    // DashboardPages.rebuild() runs applyDashboardLayout() itself at the end.
    const pagesAfter = JSON.stringify(getDashboardLayout().pages.map(p => p.id));
    const placementAfter = _dashboardPlacementSig(getDashboardLayout());
    // A page-set OR widget-placement change needs the full rebuild (mounts new page
    // grids AND re-wraps primaries into grid items, which the incremental pass
    // can't do for a bare pooled <section>); an unchanged set is just a reposition.
    // The pager preserves the current page across a rebuild, so this never yanks the
    // viewer to page 1.
    if ((pagesAfter !== pagesBefore || placementAfter !== placementBefore)
        && window.DashboardPages && typeof window.DashboardPages.rebuild === 'function') {
      window.DashboardPages.rebuild();
    } else if (typeof applyDashboardLayout === 'function') {
      applyDashboardLayout();
    }
    // Refetch/repoll weather when the merge changed what — or how often — we
    // fetch, mirroring what the local weather-control handlers already do.
    const weatherAfter = _weatherSyncSig(hubSettings.weather);
    if (weatherAfter.fetch !== weatherBefore.fetch) queueWeatherSettingsRefresh();
    if (weatherAfter.refreshMin !== weatherBefore.refreshMin
        && typeof startWeatherPolling === 'function') startWeatherPolling();
    // Reflect per-tile Browser state (toolbar hidden) that another surface changed
    // onto our already-mounted tiles — a mounted tile reads its config only at
    // mount, so without this the Edge kept its toolbar out of step (GitHub #72).
    if (window.BrowserTile && typeof window.BrowserTile.reconcileFromSettings === 'function') {
      window.BrowserTile.reconcileFromSettings();
    }
    // A custom (SDK) widget installed/assigned on another surface arrives here as a
    // changed assign map, but the installed-package registry is a separate
    // /sdk/widgets fetch this screen loaded once at boot — so the tile would render
    // "This widget package was removed" until a manual Rescan. Re-fetch the registry
    // (exactly what Rescan does) only when the SDK-widget state actually changed, so
    // an unrelated broadcast never triggers a disk rescan (GitHub #72).
    if (JSON.stringify(hubSettings.sdkWidgets || {}) !== sdkBefore
        && window.CustomWidget && typeof window.CustomWidget.refreshPackages === 'function') {
      window.CustomWidget.refreshPackages();
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
  } catch {
    // Network error (server restarting, offline boot): stay in the parked state
    // and try again — never fall through to pushing blind local state.
    scheduleHubHydrateRetry();
  }
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

// Reconcile settings after the SSE stream (re)connects. SSE has no replay: a
// `settings` broadcast that fired while our EventSource was down is gone for
// good, so a surface whose stream dropped can stay on stale — or, on a fresh
// native WebView whose initial hydrate raced a backend restart, factory —
// settings forever (GitHub #72: the native app stuck on the default theme +
// intro while the browser showed the real config). On every (re)connect, pull
// the current server rev: if it's ahead of ours, run the same coalesced hydrate
// the live broadcast would have; if we never completed the initial hydrate at
// all, force one now that the backend is clearly answering. No-op when in sync.
async function reconcileSettingsAfterReconnect() {
  try {
    const res = await fetch('/settings', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json().catch(() => null);
    const serverRev = (data && data.settings && Number.isFinite(data.settings.rev)) ? data.settings.rev : 0;
    const localRev = (hubSettings && Number.isFinite(hubSettings.rev)) ? hubSettings.rev : 0;
    // Only act when the server is genuinely ahead of us — that IS the missed
    // broadcast. Route it through the same coalesced path the live SSE `settings`
    // event uses; never a second direct hydrate here, which could run
    // concurrently with the boot-time hydrate (no in-flight guard) and double the
    // pager rebuild. If we never completed the initial hydrate at all, that isn't
    // this function's job: the boot hydrate's own 4s retry loop
    // (scheduleHubHydrateRetry) is already handling it, and a fresh surface with
    // no local settings has rev 0 < the server's, so it lands here anyway.
    if (serverRev > localRev) _onServerSettingsRev(serverRev);
  } catch { /* transient — the next reconnect's onopen will try again */ }
}
window._reconcileSettingsAfterReconnect = reconcileSettingsAfterReconnect;

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
  // Never hydrate while the layout editor is open: hydrate ends in
  // applyDashboardLayout(), whose grid.update() on a tile the user is actively
  // dragging/resizing kills the gesture and snaps the geometry back to the
  // last-saved state (the "my resize didn't stick" bug — typical when another
  // surface, e.g. the Xeneon screen, saves in the background). Deferred, not
  // dropped: it re-checks and lands as soon as the editor closes.
  if (typeof document !== 'undefined' && document.body
      && document.body.classList.contains('layout-editing')) {
    _settingsSseTimer = setTimeout(_runSettingsSseHydrate, 1000);
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

function isSupportedFontFile(file) {
  if (!file) return false;
  // Browsers report font MIME types inconsistently, so the extension is the
  // authority (matching the server's POST /font validation).
  const ext = String(file.name || '').split('.').pop().toLowerCase();
  if (SETTINGS_FONT_EXTENSIONS.has(ext)) return true;
  return !!(file.type && SETTINGS_FONT_TYPES.has(file.type.toLowerCase()));
}

// CSS format() hint by extension — helps the browser pick/decode the face.
function fontFaceFormat(url) {
  const ext = String(url || '').slice(url.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'woff2') return " format('woff2')";
  if (ext === 'woff') return " format('woff')";
  if (ext === 'ttf') return " format('truetype')";
  if (ext === 'otf') return " format('opentype')";
  return '';
}

function getFontSource(font) {
  if (!font || !font.url) return '';
  return font.version ? `${font.url}?v=${encodeURIComponent(font.version)}` : font.url;
}

// Register (or clear) the custom global typeface. The uploaded font is bound to a
// fixed @font-face family; --user-font-family flips global.css onto it, and the
// retro skin's own pixel fonts still win (they use !important) when active.
function applyUiFont() {
  const font = hubSettings.uiFont;
  const root = document.documentElement;
  let styleEl = document.getElementById('user-font-face');
  if (font && font.url) {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'user-font-face';
      document.head.appendChild(styleEl);
    }
    // The url charset is server-restricted to [A-Za-z0-9._-] (plus the version
    // query), so it cannot break out of the CSS url() context.
    const src = getFontSource(font);
    styleEl.textContent = `@font-face{font-family:'${USER_FONT_FAMILY}';src:url("${src}")${fontFaceFormat(font.url)};font-display:swap;}`;
    root.style.setProperty('--user-font-family', `'${USER_FONT_FAMILY}'`);
  } else {
    if (styleEl) styleEl.remove();
    root.style.removeProperty('--user-font-family');
  }
}

function getBackgroundSource(media) {
  if (!media) return '';
  // Data URIs are self-contained — appending a `?v=` cache-buster would corrupt them.
  if (media.url.startsWith('data:')) return media.url;
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
// Mode buttons seed an accessible stock palette. After that every colour is a
// normal editable theme field: no mode-specific constant is allowed to override
// what the user or an imported theme selected.
const APPEARANCE_COLOR_KEYS = Object.freeze([
  'background', 'surface', 'surfaceAlt', 'controlColor', 'text',
  'mutedText', 'lineColor', 'accentText',
  'successColor', 'warningColor', 'dangerColor', 'infoColor',
]);

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

// ── Dual-palette themes (paletteVariants) ─────────────────────────
// The variant a settings object is currently showing, or null when the theme
// carries no pair (or has no half for the resolved tone). resolveAppearance()
// already turns 'auto' into the live OS tone, so Auto follows Windows through the
// same matchMedia / refreshOsTheme repaints that autoPalette uses — no extra
// listener, and nothing is persisted when the OS flips.
function activePaletteVariant(settings) {
  if (!settings || !settings.paletteVariants) return null;
  return ThemePalette.variantFor(settings.paletteVariants, resolveAppearance(settings.appearance));
}

// Bake the variant that's on screen into the real colour keys and drop the pair.
// Every path where the user picks a colour themselves goes through this first:
// otherwise their edit lives on the frozen base palette while the overlay keeps
// painting the variant over it, so the change would look ignored — and the next
// OS flip would silently revert it. Returns a plain patch source for
// normalizeSettings (never mutates the input).
function freezePaletteVariants(settings) {
  const base = settings || {};
  if (!base.paletteVariants) return base;
  const frozen = ThemePalette.applyVariant(base, activePaletteVariant(base));
  frozen.paletteVariants = null;
  return frozen;
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
  const resolved = mode === 'auto' ? resolveAppearance(mode) : mode;
  // A dual-palette theme already answers this question: the author drew both
  // tones, so switching mode swaps to the authored variant instead of throwing
  // the theme away for the stock palette. autoPalette stays false — the variants
  // ARE the palette, and on 'auto' the overlay follows Windows by itself.
  if (hubSettings.paletteVariants && hubSettings.paletteVariants[resolved]) {
    hubSettings = normalizeSettings({ ...hubSettings, appearance: mode, autoPalette: false });
    saveHubSettings();
    applyHubSettings();
    syncSettingsControls();
    if (mode === 'auto') refreshOsTheme();
    return;
  }
  // No variant for the requested tone: the pair can't describe this look, so it
  // is dropped along with the rest of the previous palette below.
  const stock = window.ThemePalette && ThemePalette.STOCK[resolved];
  const patch = { appearance: mode, autoPalette: mode === 'auto', paletteVariants: null };
  // A mode switch is an intentional request for a usable light/dark starting
  // point. Keep the chosen accent, but reset every surface/foreground role so
  // Light really becomes light and Dark really becomes dark. Subsequent colour
  // edits remain exact and are never replaced inside applyHubSettings().
  if (stock) {
    for (const key of APPEARANCE_COLOR_KEYS) patch[key] = null;
    for (const key of ['background', 'surface', 'surfaceAlt', 'controlColor', 'text']) patch[key] = stock[key];
    patch.contrastGuard = true;
  }
  hubSettings = normalizeSettings({ ...hubSettings, ...patch });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
  if (mode === 'auto') refreshOsTheme();   // fetch the current OS scheme right away
}

// ── Dashboard style (Liquid Glass / Pixel Retro / Comic) ─────────
function setStyleMode(mode) {
  if (!STYLE_MODES.includes(mode)) return;
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
  // Refresh the gallery's active highlight (the skin lives on the cards now).
  renderThemeGallery();
  const scan = $('settings-retro-scanlines');
  if (scan) scan.checked = hubSettings.retroScanlines;
  const scanRow = $('settings-retro-scanlines-row');
  if (scanRow) {
    scanRow.hidden = !retro;
    // Hide the whole grid too, or the empty container leaves a blank strip.
    const grid = scanRow.closest('.settings-grid');
    if (grid) grid.hidden = !retro;
  }
  // Retro owns a fixed dark CRT palette. Comic is now palette-driven and may be
  // light or dark, so its mode buttons remain fully functional.
  const forcedAppearance = retro;
  const themeGroup = document.querySelector('.settings-theme-group');
  if (themeGroup) themeGroup.classList.toggle('is-disabled', forcedAppearance);
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

let _effectiveThemePalette = null;

function deriveEffectiveThemePalette() {
  const source = { ...hubSettings };
  if (hubSettings.appearance === 'auto' && hubSettings.autoPalette === true) {
    const stock = ThemePalette.STOCK[resolveAppearance('auto')];
    Object.assign(source, stock, {
      mutedText: null, lineColor: null, accentText: null,
      successColor: null, warningColor: null, dangerColor: null, infoColor: null,
    });
    // Accent remains a user preference even while the neutral palette follows
    // Windows; album-art accent may still replace it below.
    source.accent = hubSettings.accent;
  }
  // Dual-palette theme: overlay the half matching the resolved tone (on 'auto'
  // that's the live OS tone, so Windows flips repaint through the existing
  // matchMedia / refreshOsTheme listeners and nothing is persisted).
  Object.assign(source, ThemePalette.applyVariant(source, activePaletteVariant(hubSettings)));
  if (hubSettings.dynamicAlbumTheme !== false && _dynamicAccent) source.accent = _dynamicAccent;
  // Comic's default material is printed on the Base background. Authors can
  // still separate canvas and paper explicitly with `surface`.
  if (hubSettings.styleMode === 'comic' && !source.surface) source.surface = source.background;
  // Retro intentionally owns a fixed CRT palette; expose the same effective
  // colours to SDK widgets instead of leaking the previous skin's palette.
  if (hubSettings.styleMode === 'retro') {
    Object.assign(source, {
      background: '#050510', surface: '#0d0e20', surfaceAlt: '#121328', controlColor: '#181a34',
      text: '#e8e8dc', mutedText: '#a9a9c0', lineColor: '#4c4c78', accent: '#f5c518',
    });
  }
  const hint = hubSettings.styleMode === 'retro' ? 'dark' : resolveAppearance(hubSettings.appearance);
  return ThemePalette.derive(source, hint);
}

function applyThemePaletteTokens(root, palette) {
  Object.entries(ThemePalette.cssTokens(palette)).forEach(([key, value]) => root.style.setProperty(key, value));
  root.dataset.appearance = palette.tone;
  root.style.colorScheme = palette.tone;

  // Component-facing semantic material tokens. They are intentionally defined
  // in terms of the palette roles, so every future theme and per-tile override
  // inherits coherent fields, hover states and selected states automatically.
  const semantic = {
    '--surface-raised': 'var(--surface-alt)',
    '--surface-subtle': 'color-mix(in srgb, var(--surface), var(--text) 5%)',
    '--surface-strong': 'color-mix(in srgb, var(--surface), var(--text) 10%)',
    '--hover-bg': 'color-mix(in srgb, var(--surface), var(--text) 7%)',
    '--active-bg': 'color-mix(in srgb, var(--surface), var(--accent) 18%)',
    '--input-bg': 'var(--control-bg)',
    '--divider': 'color-mix(in srgb, var(--line), transparent 28%)',
    '--scrollbar-thumb': 'color-mix(in srgb, var(--text), transparent 76%)',
    '--selection-bg': 'color-mix(in srgb, var(--accent), var(--surface) 76%)',
    '--selection-text': 'var(--text)',
    '--focus-ring': 'color-mix(in srgb, var(--accent), transparent 25%)',
    '--floating-ui-bg': 'color-mix(in srgb, var(--surface), transparent 22%)',
    '--floating-ui-border': 'var(--line)',
    '--oled-bg-rgb': ThemePalette.rgb(palette.surface).join(', '),
    '--oled-border': 'var(--line)',
    '--slider-fill': 'var(--accent)',
    '--slider-track': 'var(--control-bg)',
  };
  Object.entries(semantic).forEach(([key, value]) => root.style.setProperty(key, value));

  const light = palette.tone === 'light';
  root.style.setProperty('--glass-bg', light
    ? 'linear-gradient(135deg, color-mix(in srgb, var(--surface) 88%, white), color-mix(in srgb, var(--surface-alt) 82%, transparent))'
    : 'linear-gradient(135deg, color-mix(in srgb, var(--surface) 88%, white 12%), color-mix(in srgb, var(--surface) 96%, transparent) 58%, color-mix(in srgb, var(--surface-alt) 92%, white 8%))');
  root.style.setProperty('--glass-border', light ? 'color-mix(in srgb, var(--line), white 28%)' : 'color-mix(in srgb, var(--line), white 14%)');
  root.style.setProperty('--glass-highlight', light ? 'color-mix(in srgb, var(--surface), white 70%)' : 'rgba(255,255,255,0.38)');
  root.style.setProperty('--glass-sheen', light
    ? 'linear-gradient(180deg, color-mix(in srgb, var(--surface), white 58%), transparent 38%)'
    : 'linear-gradient(180deg, rgba(255,255,255,0.14), transparent 30%)');
  root.style.setProperty('--readability-shadow', light ? 'none' : '0 1px 3px rgba(0,0,0,0.86), 0 0 14px rgba(0,0,0,0.42)');
  root.style.setProperty('--icon-readability-filter', light ? 'none' : 'drop-shadow(0 1px 2px rgba(0,0,0,0.86)) drop-shadow(0 0 8px rgba(0,0,0,0.32))');
  root.style.setProperty('--shadow-sm', light ? '0 1px 2px rgba(20,30,40,0.08)' : '0 1px 2px rgba(0,0,0,0.30)');
  root.style.setProperty('--shadow-md', light ? '0 1px 2px rgba(20,30,40,0.05), 0 8px 22px -6px rgba(20,30,40,0.10)' : '0 1px 2px rgba(0,0,0,0.22), 0 8px 22px -6px rgba(0,0,0,0.38)');
  root.style.setProperty('--shadow-lg', light ? '0 2px 4px rgba(20,30,40,0.05), 0 18px 44px -12px rgba(20,30,40,0.14)' : '0 2px 4px rgba(0,0,0,0.24), 0 18px 44px -12px rgba(0,0,0,0.50)');
  root.style.setProperty('--shadow-xl', light ? '0 3px 6px rgba(20,30,40,0.06), 0 30px 70px -18px rgba(20,30,40,0.18)' : '0 3px 6px rgba(0,0,0,0.26), 0 30px 70px -18px rgba(0,0,0,0.60)');
  root.style.setProperty('--panel-topline', light ? 'color-mix(in srgb, var(--surface), white 72%)' : 'rgba(255,255,255,0.055)');
  root.style.setProperty('--panel-drop', light ? '0 1px 2px rgba(20,30,40,0.05), 0 10px 30px -16px rgba(20,30,40,0.14)' : '0 1px 1px rgba(0,0,0,0.16), 0 10px 30px -14px rgba(0,0,0,0.45)');
  _effectiveThemePalette = palette;
  return palette;
}

function applyAccentColor() {
  const root = document.documentElement;
  return applyThemePaletteTokens(root, deriveEffectiveThemePalette());
}

function getEffectiveThemePalette() {
  return _effectiveThemePalette || deriveEffectiveThemePalette();
}
if (typeof window !== 'undefined') window.getEffectiveThemePalette = getEffectiveThemePalette;

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
  if (window.CustomWidget && typeof window.CustomWidget.refreshTheme === 'function') window.CustomWidget.refreshTheme();
}

// Extended full-editor theme tokens, applied inline on :root. Skipped under the
// full alternate skins, which own their geometry/material. A leftover inline
// --radius would otherwise defeat Retro's square corners and Comic's hand-drawn
// corners (hence the explicit removal on the alternate-skin branch). The defaults
// reproduce the stock Liquid Glass look, so an untouched theme is a visual no-op.
function applyThemeSurfaceTokens(root, alternateSkin) {
  const scoped = ['--radius', '--radius-control', '--radius-tile', '--radius-modal', '--glass-blur', '--glass-saturate'];
  if (alternateSkin) { scoped.forEach(prop => root.style.removeProperty(prop)); return; }
  const round = clampNumber(hubSettings.uiRoundness, 0, 2, 1);
  [['--radius', 8], ['--radius-control', 10], ['--radius-tile', 16], ['--radius-modal', 20]]
    .forEach(([prop, base]) => root.style.setProperty(prop, `${+(base * round).toFixed(2)}px`));
  root.style.setProperty('--glass-blur', `${Math.round(clampNumber(hubSettings.glassBlur, 0, 40, 22))}px`);
  root.style.setProperty('--glass-saturate', `${Math.round(clampNumber(hubSettings.glassSaturate, 100, 220, 160))}%`);
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
  syncSwipeHomeControl();
  syncHideRdpControl();
  const root = document.documentElement;
  const panelSoftAlpha = Math.max(0.14, Math.min(1, hubSettings.panelAlpha - 0.02));
  // Border/shadow strength are user multipliers (1 = stock look); caps widened so
  // a 2× still fits, but the default value is byte-for-byte the previous formula.
  const borderStrength = clampNumber(hubSettings.panelBorderStrength, 0, 2, 1);
  const shadowStrength = clampNumber(hubSettings.panelShadowStrength, 0, 2, 1);
  const panelBorderAlpha = Math.min(0.4, (0.045 + (hubSettings.panelAlpha * 0.08)) * borderStrength);
  const panelShadowAlpha = Math.min(0.6, (0.05 + (hubSettings.panelAlpha * 0.18)) * shadowStrength);
  const panelHighlightAlpha = Math.min(0.07, 0.012 + (hubSettings.panelAlpha * 0.04));
  const bgSafeDim = Math.max(hubSettings.bgDim, 0.18);
  const bgSafeDimStrong = Math.min(0.9, bgSafeDim + 0.11);
  const bgBlur = Math.round(hubSettings.bgBlur);
  const bgScale = bgBlur > 0 ? Math.min(1.06, 1 + (bgBlur / 600)) : 1;

  // Dashboard style language: skins own geometry/material only. Colour and
  // contrast always flow through ThemePalette; Retro is the sole fixed-palette
  // exception because its identity is a dark CRT.
  const retro = hubSettings.styleMode === 'retro';
  const comic = hubSettings.styleMode === 'comic';
  if (retro) root.dataset.style = 'retro';
  else if (comic) root.dataset.style = 'comic';
  else delete root.dataset.style;
  document.body.classList.toggle('retro-scanlines', retro && hubSettings.retroScanlines);

  // Idle animation auto-pause (ambient-idle.js runs independently; push the
  // current preference so toggling it takes effect at once).
  if (window.AmbientIdle) window.AmbientIdle.setEnabled(hubSettings.idleAnimationPause !== false);

  // Hybrid-GPU session freeze (js/native-bridge.js owns body.low-power-gpu; a
  // no-op on every other machine and on the browser surface).
  if (window.NativeGpuPause) window.NativeGpuPause.setEnabled(hubSettings.hybridGpuAnimationPause !== false);

  // Top-bar clock alignment + meta-field visibility (Settings → Aspetto).
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

  // Custom global typeface (independent of the colour palette).
  applyUiFont();

  root.style.setProperty('--panel-alpha', (comic ? 1 : hubSettings.panelAlpha).toFixed(2));
  root.style.setProperty('--panel-soft-alpha', (comic ? 1 : panelSoftAlpha).toFixed(2));
  root.style.setProperty('--panel-border-alpha', (light ? 0.10 * borderStrength : panelBorderAlpha).toFixed(3));
  root.style.setProperty('--panel-shadow-alpha', (light ? 0.10 * shadowStrength : panelShadowAlpha).toFixed(3));
  root.style.setProperty('--panel-highlight-alpha', light ? '0.55' : panelHighlightAlpha.toFixed(3));

  // Comic is opaque paper by default; the palette engine already maps its
  // automatic surface to Base background, while an explicit `surface` wins.
  if (comic) {
    root.style.setProperty('--panel-alpha', '1');
    root.style.setProperty('--panel-soft-alpha', '1');
  }

  root.style.setProperty('--bg-dim', hubSettings.bgDim.toFixed(2));
  root.style.setProperty('--bg-safe-dim', bgSafeDim.toFixed(2));
  root.style.setProperty('--bg-safe-dim-strong', bgSafeDimStrong.toFixed(2));
  root.style.setProperty('--bg-blur', `${bgBlur}px`);
  root.style.setProperty('--bg-scale', bgScale.toFixed(3));

  // Extended theme tokens — corner radius, glass blur/saturation and optional
  // secondary colours. Glass-only (the full skins own their geometry/material).
  applyThemeSurfaceTokens(root, retro || comic);

  // Borders consume the effective semantic line colour, whether it was picked
  // manually or auto-derived. Retro's !important CRT edge still wins.
  const lineAlpha = light ? (0.10 * borderStrength) : panelBorderAlpha;
  root.style.setProperty('--panel-border', `rgba(${ThemePalette.rgb(palette.line).join(', ')}, ${lineAlpha.toFixed(3)})`);

  // ── Background FX (static bg + aurora + perspective grid) ───────
  const aurora = normalizeBgAurora(hubSettings.bgAurora);
  const grid = normalizeBgGrid(hubSettings.bgGrid);
  const bgStatic = normalizeBgStatic(hubSettings.bgStatic);
  const bgCustom = normalizeBgCustom(hubSettings.bgCustom);
  // Code-defined animated background: when enabled (and no image/video wallpaper),
  // it owns the backdrop and suppresses the built-in FX below, exactly like a
  // static premium bg does. Mounted/cleared through the sandboxed CustomBg module.
  const customOn = bgCustom.enabled && !!bgCustom.code && !hubSettings.backgroundMedia;
  if (window.CustomBg && typeof window.CustomBg.apply === 'function') {
    window.CustomBg.apply(customOn ? bgCustom.code : null, customOn ? bgCustom.assets : null, bgCustom.fps);
  }

  // Static premium background — mutually exclusive with the animated aurora
  // (turning one on switches the other off: "zero animation" is the point) and,
  // like the aurora/grid, hidden when a custom image/video background is set or a
  // code-defined background owns the backdrop.
  const staticOn = bgStatic.style !== 'none' && !hubSettings.backgroundMedia && !customOn;
  if (staticOn) document.body.dataset.bgStatic = bgStatic.style;
  else delete document.body.dataset.bgStatic;
  root.style.setProperty('--static-opacity', (0.30 + (bgStatic.intensity / 100) * 0.70).toFixed(3));

  // Aurora only shows when there's no custom background and no static/code bg is active.
  const auroraOn = aurora.enabled && !hubSettings.backgroundMedia && !staticOn && !customOn;
  document.body.classList.toggle('aurora-on', auroraOn);
  root.style.setProperty('--aurora-opacity', (0.12 + (aurora.intensity / 100) * 0.5).toFixed(3));
  root.style.setProperty('--aurora-duration', `${(72 - (aurora.speed / 100) * 54).toFixed(1)}s`);

  // Like the aurora, the neon grid only shows when there's no custom image/video
  // background — it shouldn't compete with (or visibly flicker over) a user
  // wallpaper. A static premium OR code-defined background also owns the backdrop
  // on its own, so the animated grid is suppressed while one is active.
  document.body.classList.toggle('grid-on', grid.enabled && !hubSettings.backgroundMedia && !staticOn && !customOn);
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

  const media = hubSettings.backgroundMedia;
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

// ── Temi gallery (built-in styles + saved/imported themes) ───────────
// The saved/imported themes as stored on hubSettings (always an array).
function getCustomThemes() {
  return Array.isArray(hubSettings.customThemes) ? hubSettings.customThemes : [];
}

// A theme's display name: built-ins carry a translation key, saved ones a literal
// name the user (or the sharer) gave it.
function themeName(theme) {
  if (theme.nameKey) return t(theme.nameKey);
  return String(theme.name || '').trim() || t('theme_imported_default');
}

// Canonical signature of a look over THEME_SETTING_KEYS — both sides are already
// normalized, so a stable string compare tells whether two looks are identical.
function themeSignature(src) {
  return JSON.stringify(THEME_SETTING_KEYS.map(k => {
    const v = src ? src[k] : undefined;
    if (k === 'uiFont') return (v && v.url) ? String(v.url) : '';
    // Provenance belongs to the install receipt, not to the visual identity.
    // Re-importing the same look must still dedupe even when its installId differs.
    if (k === 'bgCustom' && v && typeof v === 'object') {
      const clean = Object.assign({}, v);
      delete clean.imported;
      delete clean.installId;
      return JSON.stringify(clean);
    }
    if (['accent', 'background', 'surface', 'surfaceAlt', 'controlColor', 'text', 'mutedText',
      'lineColor', 'accentText', 'successColor', 'warningColor', 'dangerColor', 'infoColor'].includes(k)) {
      return normalizeHex(v, '');
    }
    if (v && typeof v === 'object') return JSON.stringify(v);
    return v == null ? null : v;
  }));
}

// Exactly one card is highlighted: the saved theme whose full snapshot matches
// the live look, or — if none does (you're on a bare style with your own
// colours) — the current style (Liquid Glass / Pixel Retro).
function findActiveThemeId() {
  const sig = themeSignature(hubSettings);
  const match = getCustomThemes().find(theme => themeSignature(theme) === sig);
  if (match) return match.id;
  return hubSettings.styleMode === 'retro' ? 'retro' : 'glass';
}

// Copy the live look (every THEME_SETTING_KEYS field) into a plain object.
function snapshotCurrentTheme() {
  const snap = {};
  for (const k of THEME_SETTING_KEYS) snap[k] = hubSettings[k];
  return snap;
}

// Apply a gallery card. A built-in STYLE changes only the skin and keeps your
// colours/surface/font; a saved THEME applies its whole snapshot. Routed through
// normalizeSettings + applyHubSettings, exactly like the manual controls.
function applyThemeById(id) {
  const builtin = BUILTIN_THEMES.find(x => x.id === id);
  let patch;
  if (builtin) {
    // A built-in style resets to that style's STOCK look: every theme token back
    // to its default, then the style's own declared colours (if any) and its skin
    // on top. (Previously skin-only — it kept your custom colours, so clicking
    // "Liquid Glass" changed nothing visible and left the gallery highlight stuck
    // on a matching saved card.)
    patch = {};
    for (const k of THEME_SETTING_KEYS) if (k in DEFAULT_HUB_SETTINGS) patch[k] = DEFAULT_HUB_SETTINGS[k];
    for (const k of THEME_SETTING_KEYS) if (k in builtin) patch[k] = builtin[k];
    patch.styleMode = builtin.skin;
  } else {
    const theme = getCustomThemes().find(x => x.id === id);
    if (!theme) return;
    patch = {};
    for (const k of THEME_SETTING_KEYS) patch[k] = theme[k];
  }
  hubSettings = normalizeSettings({ ...hubSettings, ...patch });
  saveHubSettings();
  applyHubSettings();
  renderSettingsModal();
  setSettingsStatus('settings_saved', 'ok');
}

// Store a snapshot as a new gallery card (deduped by signature so re-saving /
// re-importing the same look doesn't stack). Returns the new card, or null if it
// already existed. `name` falls back to an auto-numbered default.
function addThemeCard(snapshot, name, opts) {
  const existing = getCustomThemes();
  const sig = themeSignature(snapshot);
  if (existing.some(theme => themeSignature(theme) === sig)) { renderThemeGallery(); return null; }
  const card = {
    ...snapshot,
    id: 'ct_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(name || '').trim().slice(0, 40)
      || (t('theme_custom_default') + ' ' + (existing.length + 1)),
  };
  // Redistribution marker for imported looks — export refuses to re-share them.
  if (opts && opts.imported === true) card.imported = true;
  if (card.imported && opts && typeof ContentInstalls !== 'undefined'
      && ContentInstalls.INSTALL_ID_RE.test(String(opts.installId || ''))) {
    card.installId = String(opts.installId);
  }
  hubSettings = normalizeSettings({ ...hubSettings, customThemes: existing.concat([card]) });
  saveHubSettings();
  renderThemeGallery();
  refreshThemeConsumers();
  return card;
}

// In-app text prompt / confirm. The Xeneon Edge WebView makes native
// prompt()/confirm() unreliable and clumsy on a touchscreen, so we render a small
// modal reusing the shared .preset-modal styling. Returns a Promise resolving to
// the entered string (text mode) or true (confirm mode), or null when cancelled.
function settingsPrompt(opts) {
  const o = opts || {};
  const isConfirm = o.type === 'confirm';
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'preset-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'preset-modal';
    const head = document.createElement('div');
    head.className = 'preset-modal-head';
    const h = document.createElement('h3');
    h.className = 'preset-modal-title';
    h.textContent = o.title || '';
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'preset-modal-close';
    x.setAttribute('aria-label', t('close')); x.textContent = '✕';
    head.appendChild(h); head.appendChild(x);
    const body = document.createElement('div');
    body.className = 'preset-modal-body';
    if (o.message) {
      const msg = document.createElement('p');
      msg.className = 'preset-modal-desc';
      msg.textContent = o.message;
      body.appendChild(msg);
    }
    let input = null;
    if (!isConfirm) {
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'settings-text-input';
      input.value = o.value != null ? String(o.value) : '';
      if (o.placeholder) input.placeholder = o.placeholder;
      input.maxLength = o.maxLength || 120;
      body.appendChild(input);
    }
    const row = document.createElement('div');
    row.className = 'preset-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'settings-btn subtle';
    cancel.textContent = o.cancelLabel || t('dlg_cancel');
    const ok = document.createElement('button');
    ok.type = 'button'; ok.className = 'settings-btn primary';
    ok.textContent = o.okLabel || t('dlg_save');
    row.appendChild(cancel); row.appendChild(ok);
    body.appendChild(row);
    modal.appendChild(head); modal.appendChild(body);
    overlay.appendChild(modal);

    let done = false;
    const finish = (val) => {
      if (done) return; done = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      else if (e.key === 'Enter' && input) { e.preventDefault(); finish(input.value); }
    };
    x.addEventListener('click', () => finish(null));
    cancel.addEventListener('click', () => finish(null));
    ok.addEventListener('click', () => finish(input ? input.value : true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    if (input) { input.focus(); input.select(); } else ok.focus();
  });
}

// Save the current look as a theme so you can come back to it later — the button
// that lets "import theme 2, then return to theme 1" actually work. Prompts for a
// name (in-app modal); empty falls back to an auto-numbered default, Cancel aborts.
async function saveCurrentTheme() {
  const fallback = t('theme_custom_default') + ' ' + (getCustomThemes().length + 1);
  const name = await settingsPrompt({ title: t('theme_name_prompt'), value: fallback, maxLength: 40 });
  if (name === null) return; // cancelled
  addThemeCard(snapshotCurrentTheme(), name);
  setSettingsStatus('settings_saved', 'ok');
}

// Persist the just-imported look as a card. preset-share has already applied the
// code, so we snapshot the resulting live settings — the card reproduces exactly
// what the user now sees, font included.
function saveImportedThemeCard(name, installId) {
  return addThemeCard(snapshotCurrentTheme(), name, { imported: true, installId });
}

// Keep import receipts truthful when the user removes one imported resource by
// hand instead of using "Remove all". Empty receipts disappear automatically.
function forgetInstalledContentResource(field, value) {
  if (typeof ContentInstalls === 'undefined' || !Array.isArray(hubSettings.contentInstalls)) return;
  const listFields = new Set(['themeIds', 'pagePresetIds', 'pageIds', 'deckPresetIds', 'widgetIds', 'ambientSceneIds', 'fontUrls']);
  if (!listFields.has(field) && field !== 'deckProfiles' && field !== 'background') return;
  const next = hubSettings.contentInstalls.map((record) => {
    const resources = ContentInstalls.normalizeResources(record.resources);
    if (field === 'deckProfiles' && value && typeof value === 'object') {
      resources.deckProfiles = resources.deckProfiles.filter(ref => !(ref.instanceId === value.instanceId && ref.profileId === value.profileId));
    } else if (field === 'background') {
      resources.background = false;
    } else {
      resources[field] = resources[field].filter(item => item !== value);
    }
    return Object.assign({}, record, { resources });
  }).filter(record => ContentInstalls.resourceCount(record.resources));
  if (JSON.stringify(next) === JSON.stringify(hubSettings.contentInstalls)) return;
  hubSettings = normalizeSettings(Object.assign({}, hubSettings, { contentInstalls: next }));
  saveHubSettings();
}
window.forgetInstalledContentResource = forgetInstalledContentResource;

// Rename a saved/imported theme (double-tap its name). Built-in styles have no id
// match, so they can't be renamed.
async function renameCustomTheme(id) {
  const theme = getCustomThemes().find(x => x.id === id);
  if (!theme) return;
  const name = await settingsPrompt({ title: t('theme_name_prompt'), value: theme.name || '', maxLength: 40 });
  if (name === null) return; // cancelled
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean || clean === theme.name) return;
  const next = getCustomThemes().map(x => x.id === id ? { ...x, name: clean } : x);
  hubSettings = normalizeSettings({ ...hubSettings, customThemes: next });
  saveHubSettings();
  renderThemeGallery();
  refreshThemeConsumers();
  setSettingsStatus('settings_saved', 'ok');
}

// Remove one saved/imported theme card. Built-in styles can't be removed.
function removeCustomTheme(id) {
  // Was this the look currently on screen? Check BEFORE removing the card.
  const wasActive = findActiveThemeId() === id;
  const next = getCustomThemes().filter(theme => theme.id !== id);
  if (next.length === getCustomThemes().length) return;
  forgetInstalledContentResource('themeIds', id);
  hubSettings = normalizeSettings({ ...hubSettings, customThemes: next });
  saveHubSettings();
  if (wasActive && typeof applyThemeById === 'function') {
    // Deleting the theme you're using drops you back to the stock Liquid Glass
    // look — there's no saved card left to sit on. applyThemeById re-renders the
    // gallery itself; refresh the other theme consumers too.
    applyThemeById('glass');
  } else {
    renderThemeGallery();
  }
  refreshThemeConsumers();
  setSettingsStatus('settings_saved', 'ok');
}

function makeThemeCard(theme, activeId, isCustom) {
  const wrap = document.createElement('div');
  wrap.className = 'theme-card-wrap';

  const card = document.createElement('button');
  card.type = 'button';
  const retro = (theme.styleMode || theme.skin || 'glass') === 'retro';
  card.className = 'theme-card' + (theme.id === activeId ? ' active' : '') + (retro ? ' theme-card--retro' : '');
  card.setAttribute('aria-pressed', theme.id === activeId ? 'true' : 'false');
  card.setAttribute('aria-label', themeName(theme));
  // The Liquid Glass style card previews your live palette (it keeps your
  // colours); the retro style and saved themes preview their own stored colours.
  const preview = theme.live
    ? { accent: hubSettings.accent, background: hubSettings.background, text: hubSettings.text }
    : { accent: theme.accent, background: theme.background, text: theme.text };
  card.style.setProperty('--tc-bg', preview.background);
  card.style.setProperty('--tc-accent', preview.accent);
  card.style.setProperty('--tc-text', preview.text);
  card.addEventListener('click', () => applyThemeById(theme.id));

  const swatch = document.createElement('span');
  swatch.className = 'theme-card-preview';
  const dot = document.createElement('span');
  dot.className = 'theme-card-dot';
  swatch.appendChild(dot);

  const foot = document.createElement('span');
  foot.className = 'theme-card-foot';
  const name = document.createElement('span');
  name.className = 'theme-card-name';
  name.textContent = themeName(theme);
  if (isCustom) {
    // Double-tap the name to rename this saved theme (single tap still applies it).
    name.title = t('settings_theme_rename');
    name.addEventListener('dblclick', (e) => { e.stopPropagation(); renameCustomTheme(theme.id); });
  }
  foot.appendChild(name);

  card.append(swatch, foot);
  wrap.appendChild(card);

  if (isCustom) {
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'theme-card-remove';
    rm.setAttribute('aria-label', t('settings_theme_remove'));
    rm.textContent = '✕';
    rm.addEventListener('click', (e) => { e.stopPropagation(); removeCustomTheme(theme.id); });
    wrap.appendChild(rm);
  }
  return wrap;
}

function renderThemeGallery() {
  const box = $('settings-theme-gallery');
  if (!box) return;
  const activeId = findActiveThemeId();
  const cards = BUILTIN_THEMES.map(theme => makeThemeCard(theme, activeId, false))
    .concat(getCustomThemes().map(theme => makeThemeCard(theme, activeId, true)));
  box.replaceChildren(...cards);
}

// Refresh UI OTHER than the gallery that lists saved themes (currently the
// contextual-profiles Style dropdown), so a theme added/renamed/removed appears
// or disappears there immediately — not only the next time Settings is opened.
// Guarded: no-ops when that section isn't in the DOM.
function refreshThemeConsumers() {
  try { if (typeof syncContextProfileControls === 'function') syncContextProfileControls(); } catch { /* section not mounted */ }
}

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
  // The hybrid-GPU freeze only exists on an iGPU+dGPU machine running the native
  // shell, so the row is hidden everywhere else rather than offering a switch
  // that provably does nothing.
  const hybridGpuPause = $('settings-hybrid-gpu-pause');
  if (hybridGpuPause) hybridGpuPause.checked = hubSettings.hybridGpuAnimationPause !== false;
  const hybridGpuRow = $('settings-hybrid-gpu-pause-row');
  if (hybridGpuRow) {
    hybridGpuRow.hidden = !(window.NativeGpuPause && window.NativeGpuPause.isLowPowerGpu());
  }
  const versionPing = $('settings-version-ping');
  if (versionPing) versionPing.checked = hubSettings.versionPing === true;

  const rangeMap = [
    ['settings-panel-alpha', String(hubSettings.panelAlpha)],
    ['settings-panel-border', String(hubSettings.panelBorderStrength)],
    ['settings-panel-shadow', String(hubSettings.panelShadowStrength)],
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
  if (shadowVal) shadowVal.textContent = formatPercent(hubSettings.panelShadowStrength);
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
  syncLockWidgetSettings();
  syncAutoOpenBrowserControl();
  syncSwipeHomeControl();
  syncHideRdpControl();
  syncNativeZoomControl();
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
  renderSlideshowSettings();
  // Bit only mounts/unmounts via sync(): the DOMContentLoaded pass sees the
  // localStorage copy, which a PC restart can reset — without this, a pet
  // enabled in the server settings never appeared until a manual toggle.
  if (window.VitalsPet && typeof window.VitalsPet.sync === 'function') window.VitalsPet.sync();
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
  // UniFi Protect connect + camera picker renders into Settings → Cameras.
  if (window.UnifiProtect && typeof window.UnifiProtect.initSettings === 'function') window.UnifiProtect.initSettings();
  // "Enable sensors" card renders into Settings → Performance (only when needed).
  if (window.SensorAccess && typeof window.SensorAccess.initSettings === 'function') window.SensorAccess.initSettings();
  // External calendars section — injected dynamically (no HTML change required).
  _initCalendarFeedsSection();
}

function renderSettingsModal() {
  renderThemeGallery();
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
    // handler firing here cannot recurse. The flag tells setLang this is a pure
    // label sync, NOT a user pick: without it, merely opening Settings on an
    // install whose language was never chosen would persist this surface's
    // browser-derived locale server-wide and flip every other screen's language.
    window._langSelectSyncing = true;
    try { sel.dispatchEvent(new Event('change', { bubbles: true })); }
    finally { window._langSelectSyncing = false; }
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
  // Display (DDC/CI) control is demand-only: enumerating monitors spawns a helper
  // process, so we only load it when the user actually opens the Schermo panel.
  if (cat === 'display' && typeof window.loadDisplayControl === 'function') {
    window.loadDisplayControl();
  }
  // Slideshow thumbnails paint when its pane opens (and update live via applyHubSettings).
  if (cat === 'slideshow') renderSlideshowSettings();
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
  const reset = {};
  for (const key of APPEARANCE_COLOR_KEYS) reset[key] = null;
  hubSettings = normalizeSettings({ ...hubSettings, ...reset, autoPalette: false, paletteVariants: null, accent: preset.accent, background: preset.background, text: preset.text, contrastGuard: true });
  saveHubSettings();
  applyHubSettings();
  renderSettingsModal();
  setSettingsStatus('settings_saved', 'ok');
}

function updateSettingsColor(key, value) {
  if (!['accent', 'background', 'surface', 'surfaceAlt', 'controlColor', 'text', 'mutedText',
    'lineColor', 'accentText', 'successColor', 'warningColor', 'dangerColor', 'infoColor'].includes(key)) return;
  const hex = normalizeHex(value, null);
  if (!hex) return;
  hubSettings = normalizeSettings({ ...freezePaletteVariants(hubSettings), [key]: hex, autoPalette: false });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
  renderThemeGallery(); // aggiorna solo l'evidenziazione delle card, senza resettare i colori aperti
}

// Reset an optional semantic role to the palette engine's automatic value.
function clearSettingsColor(key) {
  if (!['surface', 'surfaceAlt', 'controlColor', 'mutedText', 'lineColor', 'accentText',
    'successColor', 'warningColor', 'dangerColor', 'infoColor'].includes(key)) return;
  hubSettings = normalizeSettings({ ...freezePaletteVariants(hubSettings), [key]: null, autoPalette: false });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
  renderThemeGallery();
}

function updateContrastGuard(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, contrastGuard: enabled !== false });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
  renderThemeGallery();
}

function updateIdleAnimationPause(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, idleAnimationPause: enabled !== false });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
}

function updateHybridGpuAnimationPause(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, hybridGpuAnimationPause: enabled !== false });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
  // The background editor's "frozen on this machine" note is driven by the same
  // signal, so refresh it in the same gesture instead of on the next repaint.
  renderBgFrozenNote();
}

// ── Xenon AI programmatic customization ───────────────────────────
// Apply any subset of the semantic palette in one
// save+repaint, reusing the same validation as the manual controls. Called by
// the AI's customize_appearance tool. Returns true if anything changed.
function applyAiAppearance(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  let changed = false;
  // Skin switch — routes through the same setter the
  // gallery uses, so it persists and repaints exactly like a manual switch.
  if (STYLE_MODES.includes(o.style) && typeof setStyleMode === 'function') { setStyleMode(o.style); changed = true; }
  const patch = {};
  if (['light', 'dark', 'auto'].includes(o.appearance)) {
    const resolved = o.appearance === 'auto' ? resolveAppearance('auto') : o.appearance;
    // Mirror setAppearance(): a dual-palette theme swaps to its authored variant
    // rather than being replaced by the stock palette.
    if (hubSettings.paletteVariants && hubSettings.paletteVariants[resolved]) {
      Object.assign(patch, { appearance: o.appearance, autoPalette: false });
    } else {
      const stock = ThemePalette.STOCK[resolved];
      for (const key of APPEARANCE_COLOR_KEYS) patch[key] = null;
      for (const key of ['background', 'surface', 'surfaceAlt', 'controlColor', 'text']) patch[key] = stock[key];
      Object.assign(patch, { appearance: o.appearance, autoPalette: o.appearance === 'auto', paletteVariants: null, contrastGuard: true });
    }
  }
  if (typeof o.preset === 'string') {
    const preset = SETTINGS_PRESETS.find(p => p.id === o.preset.trim().toLowerCase());
    if (preset) { patch.accent = preset.accent; patch.background = preset.background; patch.text = preset.text; }
  }
  const colorMap = {
    accent: 'accent', background: 'background', surface: 'surface', surface_alt: 'surfaceAlt',
    control_color: 'controlColor', text: 'text', muted_text: 'mutedText', line_color: 'lineColor',
    accent_text: 'accentText', success_color: 'successColor', warning_color: 'warningColor',
    danger_color: 'dangerColor', info_color: 'infoColor',
  };
  let colorEdited = false;
  for (const [arg, key] of Object.entries(colorMap)) {
    const hex = normalizeHex(o[arg], null);
    if (hex) { patch[key] = hex; patch.autoPalette = false; colorEdited = true; }
  }
  if (typeof o.contrast_guard === 'boolean') patch.contrastGuard = o.contrast_guard;
  if (Object.keys(patch).length) {
    // An exact colour is a manual edit: freeze a dual-palette theme first, exactly
    // like updateSettingsColor(), so the AI's colour isn't overpainted by the
    // variant overlay (or reverted by the next OS flip).
    const base = colorEdited ? freezePaletteVariants(hubSettings) : hubSettings;
    hubSettings = normalizeSettings({ ...base, ...patch });
    saveHubSettings();
    applyHubSettings();
    changed = true;
  }
  if (changed) {
    if (typeof renderSettingsModal === 'function') renderSettingsModal();
    setSettingsStatus('settings_saved', 'ok');
  }
  return changed;
}

// AI: build a COMPLETE custom theme from a description, apply it live, and save it
// as a named card in the Temi gallery (so the user can switch back). Every field
// is optional and defaults to the current look; all route through the same
// normalizer + snapshot the manual editor uses. Called by create_dashboard_style.
function applyAiCreateStyle(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const patch = {};
  if (STYLE_MODES.includes(o.skin)) patch.styleMode = o.skin;
  if (['light', 'dark'].includes(o.base_appearance)) {
    patch.appearance = o.base_appearance;
    patch.autoPalette = false;
  }
  const colorMap = {
    accent: 'accent', background: 'background', surface: 'surface', surface_alt: 'surfaceAlt',
    control_color: 'controlColor', text: 'text', muted_text: 'mutedText', line_color: 'lineColor',
    accent_text: 'accentText', success_color: 'successColor', warning_color: 'warningColor',
    danger_color: 'dangerColor', info_color: 'infoColor',
  };
  let colorEdited = false;
  for (const [arg, key] of Object.entries(colorMap)) {
    const hex = normalizeHex(o[arg], null);
    if (hex) { patch[key] = hex; patch.autoPalette = false; colorEdited = true; }
  }
  const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null; };
  const nums = {
    panelAlpha: num(o.panel_opacity, 0.05, 1),
    uiRoundness: num(o.corner_radius, 0, 2),
    glassBlur: num(o.glass_blur, 0, 40),
    glassSaturate: num(o.glass_saturation, 100, 220),
    panelBorderStrength: num(o.border_strength, 0, 2),
    panelShadowStrength: num(o.shadow_strength, 0, 2),
  };
  for (const [key, val] of Object.entries(nums)) if (val != null) patch[key] = val;
  if (typeof o.contrast_guard === 'boolean') patch.contrastGuard = o.contrast_guard;
  // Authoring a new look on top of a dual-palette theme replaces its palette: bake
  // the visible variant in first, so the snapshot saved as a card is exactly what
  // ends up on screen rather than the other tone's colours.
  const base = (colorEdited || patch.appearance) ? freezePaletteVariants(hubSettings) : hubSettings;
  hubSettings = normalizeSettings({ ...base, ...patch });
  saveHubSettings();
  applyHubSettings();
  // Snapshot the resulting look into a named gallery card (dedupes by signature),
  // which then reads as the active theme.
  const name = (typeof o.name === 'string' && o.name.trim()) ? o.name.trim() : null;
  if (typeof addThemeCard === 'function') addThemeCard(snapshotCurrentTheme(), name);
  if (typeof renderSettingsModal === 'function') renderSettingsModal();
  setSettingsStatus('settings_saved', 'ok');
  return true;
}

// Apply an AI-authored animated background. The model wrote the draw() code; we
// drop it into bgCustom through the SAME normalize/persist path as the manual
// editor (code capped, enabled only when non-empty) and repaint live. The code
// still runs only inside the isolated sandbox iframe — see js/custom-bg.js.
function applyAiAnimatedBackground(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const code = typeof o.code === 'string' ? o.code : '';
  if (!code.trim()) return false;
  const current = hubSettings.bgCustom && typeof hubSettings.bgCustom === 'object' ? hubSettings.bgCustom : {};
  const name = (typeof o.name === 'string' && o.name.trim()) ? o.name.trim().slice(0, 60) : (current.name || '');
  // Fresh AI-authored code = the user's own background again → drop the marker.
  hubSettings = normalizeSettings({ ...hubSettings, bgCustom: { ...current, code, name, enabled: true, imported: false } });
  saveHubSettings();
  applyHubSettings();
  syncBgFxControls();
  if (typeof setSettingsStatus === 'function') setSettingsStatus('settings_saved', 'ok');
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
  if (!['panelAlpha', 'bgDim', 'bgBlur', 'uiRoundness', 'glassBlur', 'glassSaturate', 'panelBorderStrength', 'panelShadowStrength'].includes(key)) return;
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

// Static background style/intensity (Settings → Sfondo). Picking a style other
// than 'none' supersedes the animated aurora (see applyHubSettings).
function updateBgStatic(key, value) {
  if (!['style', 'intensity'].includes(key)) return;
  const current = hubSettings.bgStatic && typeof hubSettings.bgStatic === 'object' ? hubSettings.bgStatic : {};
  const next = { ...current, [key]: value };
  hubSettings = normalizeSettings({ ...hubSettings, bgStatic: next });
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

// ── Code-defined animated background (Settings → Sfondo) ──────────────────────
// Starter snippets. Each defines draw(ctx, t, w, h): ctx = 2D context, t =
// seconds elapsed, w/h = viewport size in CSS px. They run inside the sandboxed
// iframe (js/custom-bg.js), never against the real page.
const BG_CUSTOM_TEMPLATES = Object.freeze({
  stars: [
    '// Drifting starfield',
    'const N = 120, stars = [];',
    'for (let i = 0; i < N; i++) stars.push({ x: Math.random(), y: Math.random(), z: 0.3 + Math.random() });',
    'function draw(ctx, t, w, h) {',
    '  ctx.clearRect(0, 0, w, h);',
    '  for (const s of stars) {',
    '    const y = (s.y + t * 0.02 * s.z) % 1;',
    '    ctx.globalAlpha = 0.3 + s.z * 0.7;',
    '    ctx.fillStyle = "#9fe8ff";',
    '    ctx.fillRect(s.x * w, y * h, s.z * 2, s.z * 2);',
    '  }',
    '  ctx.globalAlpha = 1;',
    '}',
  ].join('\n'),
  waves: [
    '// Flowing gradient waves',
    'function draw(ctx, t, w, h) {',
    '  const g = ctx.createLinearGradient(0, 0, w, h);',
    '  g.addColorStop(0, "#0b1020");',
    '  g.addColorStop(1, "#101a3a");',
    '  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);',
    '  ctx.strokeStyle = "rgba(120,180,255,0.35)"; ctx.lineWidth = 2;',
    '  for (let k = 0; k < 4; k++) {',
    '    ctx.beginPath();',
    '    for (let x = 0; x <= w; x += 12) {',
    '      const y = h * 0.5 + Math.sin(x * 0.008 + t + k) * (30 + k * 18);',
    '      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);',
    '    }',
    '    ctx.stroke();',
    '  }',
    '}',
  ].join('\n'),
  grid: [
    '// Pulsing neon dots',
    'function draw(ctx, t, w, h) {',
    '  ctx.clearRect(0, 0, w, h);',
    '  const step = 46;',
    '  for (let x = step / 2; x < w; x += step)',
    '    for (let y = step / 2; y < h; y += step) {',
    '      const p = 0.5 + 0.5 * Math.sin(t * 2 + (x + y) * 0.01);',
    '      ctx.fillStyle = "rgba(53,224,142," + (0.15 + p * 0.6) + ")";',
    '      ctx.beginPath(); ctx.arc(x, y, 1.5 + p * 2, 0, 7); ctx.fill();',
    '    }',
    '}',
  ].join('\n'),
  nebula: [
    '// Drifting nebula',
    'const blobs = [];',
    'for (let i = 0; i < 5; i++) blobs.push({ x: Math.random(), y: Math.random(), h: Math.random() * 360, r: 0.3 + Math.random() * 0.3 });',
    'function draw(ctx, t, w, h) {',
    '  ctx.fillStyle = "#05060f"; ctx.fillRect(0, 0, w, h);',
    '  ctx.globalCompositeOperation = "lighter";',
    '  for (const b of blobs) {',
    '    const x = (b.x + Math.sin(t * 0.05 + b.h) * 0.05) * w;',
    '    const y = (b.y + Math.cos(t * 0.04 + b.h) * 0.05) * h;',
    '    const rad = b.r * Math.min(w, h);',
    '    const hue = (b.h + t * 6) % 360;',
    '    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);',
    '    g.addColorStop(0, "hsla(" + hue + ",70%,55%,0.5)");',
    '    g.addColorStop(1, "hsla(" + hue + ",70%,55%,0)");',
    '    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);',
    '  }',
    '  ctx.globalCompositeOperation = "source-over";',
    '}',
  ].join('\n'),
  aurora: [
    '// Aurora bands',
    'function draw(ctx, t, w, h) {',
    '  ctx.fillStyle = "#03040a"; ctx.fillRect(0, 0, w, h);',
    '  ctx.globalCompositeOperation = "lighter";',
    '  for (let k = 0; k < 3; k++) {',
    '    ctx.beginPath(); ctx.moveTo(0, h);',
    '    for (let x = 0; x <= w; x += 16) {',
    '      const y = h * 0.5 + Math.sin(x * 0.004 + t * 0.6 + k * 1.7) * 80 + Math.sin(x * 0.011 + t) * 30 - k * 60;',
    '      ctx.lineTo(x, y);',
    '    }',
    '    ctx.lineTo(w, h); ctx.closePath();',
    '    const g = ctx.createLinearGradient(0, h * 0.2, 0, h);',
    '    g.addColorStop(0, "hsla(" + (120 + k * 60) + ",80%,60%,0.28)");',
    '    g.addColorStop(1, "hsla(" + (120 + k * 60) + ",80%,60%,0)");',
    '    ctx.fillStyle = g; ctx.fill();',
    '  }',
    '  ctx.globalCompositeOperation = "source-over";',
    '}',
  ].join('\n'),
  matrix: [
    '// Matrix rain',
    'let cols = []; const cw = 14;',
    'function draw(ctx, t, w, h) {',
    '  const n = Math.ceil(w / cw);',
    '  if (cols.length !== n) { cols = []; for (let i = 0; i < n; i++) cols[i] = Math.random() * h; }',
    '  ctx.fillStyle = "rgba(0,10,4,0.18)"; ctx.fillRect(0, 0, w, h);',
    '  ctx.fillStyle = "#39ff9c"; ctx.font = cw + "px monospace";',
    '  for (let i = 0; i < n; i++) {',
    '    ctx.fillText(String.fromCharCode(0x30a0 + Math.floor(Math.random() * 96)), i * cw, cols[i]);',
    '    cols[i] = cols[i] > h + Math.random() * 400 ? 0 : cols[i] + cw;',
    '  }',
    '}',
  ].join('\n'),
  confetti: [
    '// Falling confetti',
    'const bits = [];',
    'for (let i = 0; i < 80; i++) bits.push({ x: Math.random(), y: Math.random(), s: 4 + Math.random() * 6, v: 0.05 + Math.random() * 0.12, a: Math.random() * 6, h: Math.random() * 360 });',
    'function draw(ctx, t, w, h) {',
    '  ctx.clearRect(0, 0, w, h);',
    '  for (const b of bits) {',
    '    b.y = (b.y + b.v * 0.02) % 1.1;',
    '    const x = b.x * w + Math.sin(t + b.a) * 12;',
    '    ctx.save(); ctx.translate(x, b.y * h); ctx.rotate(t * 2 + b.a);',
    '    ctx.fillStyle = "hsl(" + b.h + ",80%,60%)";',
    '    ctx.fillRect(-b.s / 2, -b.s / 2, b.s, b.s * 0.5);',
    '    ctx.restore();',
    '  }',
    '}',
  ].join('\n'),
  orbit: [
    '// Orbiting particles',
    'const dots = [];',
    'for (let i = 0; i < 60; i++) dots.push({ r: 0.1 + Math.random() * 0.5, a: Math.random() * 6.28, sp: 0.2 + Math.random() * 0.6, sz: 1 + Math.random() * 2, h: Math.random() * 360 });',
    'function draw(ctx, t, w, h) {',
    '  ctx.fillStyle = "rgba(6,8,16,0.35)"; ctx.fillRect(0, 0, w, h);',
    '  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2;',
    '  for (const d of dots) {',
    '    const ang = d.a + t * d.sp;',
    '    const x = cx + Math.cos(ang) * d.r * R;',
    '    const y = cy + Math.sin(ang) * d.r * R * 0.7;',
    '    ctx.fillStyle = "hsla(" + ((d.h + t * 10) % 360) + ",80%,65%,0.9)";',
    '    ctx.beginPath(); ctx.arc(x, y, d.sz, 0, 7); ctx.fill();',
    '  }',
    '}',
  ].join('\n'),
  plasma: [
    '// Plasma field',
    'function draw(ctx, t, w, h) {',
    '  const step = 28;',
    '  for (let x = 0; x < w; x += step)',
    '    for (let y = 0; y < h; y += step) {',
    '      const v = Math.sin(x * 0.01 + t) + Math.sin(y * 0.012 + t * 1.1) + Math.sin((x + y) * 0.008 + t * 0.7);',
    '      ctx.fillStyle = "hsl(" + (((v + 3) / 6 * 120 + 200) % 360) + ",70%,55%)";',
    '      ctx.fillRect(x, y, step, step);',
    '    }',
    '}',
  ].join('\n'),
});

function updateBgCustom(key, value) {
  if (!['enabled', 'name', 'code', 'assets', 'fps'].includes(key)) return;
  const current = hubSettings.bgCustom && typeof hubSettings.bgCustom === 'object' ? hubSettings.bgCustom : {};
  const next = { ...current, [key]: key === 'enabled' ? !!value : value };
  if (key === 'code') next.imported = false;   // user replaced the code → their own background again
  hubSettings = normalizeSettings({ ...hubSettings, bgCustom: next });
  saveHubSettings();
  applyHubSettings();
  syncBgFxControls();
  // No live frame means no status to show — clear any stale error.
  if (!next.enabled || !String(next.code || '').trim()) clearBgCodeError();
}

// ── Bundled background images (assets) ────────────────────────────────────────
// Pictures the draw() code can paint (assets.name → drawImage). Stored as data:
// URIs INSIDE bgCustom, so they persist, travel with a shared background code
// and never require the sandbox to touch the network. Caps live in
// normalizeBgAssets; here we pre-check to give a friendly toast instead of a
// silent drop.

// Derive a JS-safe asset key from a filename: "Pixel City 2.png" → "pixel_city_2".
function bgAssetKeyFromFilename(filename, taken) {
  let base = String(filename || '').replace(/\.[a-z0-9]+$/i, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  if (!/^[a-z]/.test(base)) base = ('img_' + base).slice(0, 24);
  if (!base) base = 'img';
  let key = base, n = 2;
  while (taken.includes(key)) key = (base.slice(0, 21) + '_' + n++);
  return key;
}

// Read the picked file(s) and add each as an asset (input.files → data URIs).
// Every rejection surfaces a toast — the pre-checks mirror EXACTLY what the
// sanitizer enforces (same CustomBg caps + data-URI shape), so nothing the user
// added here can be silently dropped by normalization later.
async function addBgAssetFiles(input) {
  const files = input && input.files ? Array.from(input.files) : [];
  if (input) input.value = '';   // allow re-picking the same file
  if (!files.length || !window.CustomBg) return;
  const current = normalizeBgCustom(hubSettings.bgCustom);
  const assets = { ...current.assets };
  let count = Object.keys(assets).length;
  let total = Object.values(assets).reduce((sum, v) => sum + v.length, 0);
  let added = 0;
  const warn = (titleKey, message) => {
    if (window.XenonToast) window.XenonToast.show({ type: 'error', title: t(titleKey), message: message || '' });
  };
  for (const file of files) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      warn('settings_bg_asset_invalid', file.name);
      continue;
    }
    if (count >= CustomBg.ASSET_MAX_COUNT) {
      warn('settings_bg_assets_full');
      break;
    }
    const uri = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
    // Empty/corrupt reads produce a URI the sanitizer would drop — reject them
    // HERE with a message instead of letting them vanish on normalize.
    if (!uri || !CustomBg.ASSET_DATA_RE.test(uri)) {
      warn('settings_bg_asset_invalid', file.name);
      continue;
    }
    if (uri.length > CustomBg.ASSET_MAX_CHARS || total + uri.length > CustomBg.ASSETS_TOTAL_MAX) {
      warn('settings_bg_asset_too_big', file.name);
      continue;
    }
    assets[bgAssetKeyFromFilename(file.name, Object.keys(assets))] = uri;
    count++; total += uri.length;
    added++;
  }
  if (added) updateBgCustom('assets', assets);
}

function removeBgAsset(key) {
  const current = normalizeBgCustom(hubSettings.bgCustom);
  if (!(key in current.assets)) return;
  const assets = { ...current.assets };
  delete assets[key];
  updateBgCustom('assets', assets);
}

// ── Slideshow widget ──────────────────────────────────────────────────────────
// Config (ordered images as data: URIs, interval, fit) lives in hubSettings.
// slideshow; the caps + shape rules are owned by SlideshowWidget.sanitizeSlideshow
// (js/slideshow-widget.js). Persisting through normalizeSettings + saveHubSettings
// means the images ride the settings backup for free, and the widget repaints
// live. Pre-checks here mirror the sanitizer so nothing gets silently dropped.
function updateSlideshowCfg(patch) {
  const current = (hubSettings.slideshow && typeof hubSettings.slideshow === 'object') ? hubSettings.slideshow : {};
  hubSettings = normalizeSettings({ ...hubSettings, slideshow: { ...current, ...patch } });
  saveHubSettings();
  if (window.SlideshowWidget && typeof SlideshowWidget.renderWidgets === 'function') SlideshowWidget.renderWidgets();
  renderSlideshowSettings();
}

// Upload one slideshow image to the server's disk-backed store and resolve its
// served /uploads/ URL. Images live on disk (not inline in the settings blob), so
// a slideshow can hold far more of them without weighing on localStorage/backups.
async function uploadSlideshowAsset(file) {
  const type = file.type || 'image/jpeg';
  const ext = type === 'image/png' ? 'png' : type === 'image/gif' ? 'gif' : type === 'image/webp' ? 'webp' : 'jpg';
  const form = new FormData();
  form.append('asset', file, `slide.${ext}`);
  const res = await fetch('/slideshow-asset', { method: 'POST', body: form });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.url) {
    const err = new Error((j && j.error) || 'upload failed');
    err.tooBig = res.status === 413;
    throw err;
  }
  return j.url;
}

async function addSlideshowImages(input) {
  const files = input && input.files ? Array.from(input.files) : [];
  if (input) input.value = '';   // allow re-picking the same file
  if (!files.length || !window.SlideshowWidget) return;
  const S = SlideshowWidget;
  const current = normalizeSlideshow(hubSettings.slideshow);
  const images = current.images.slice();
  let added = 0;
  const warn = (titleKey, message) => {
    if (window.XenonToast) window.XenonToast.show({ type: 'error', title: t(titleKey), message: message || '' });
  };
  for (const file of files) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { warn('slideshow_img_invalid', file.name); continue; }
    if (images.length >= S.SLIDE_MAX_COUNT) { warn('slideshow_full'); break; }
    try {
      const uri = await uploadSlideshowAsset(file);
      images.push({ name: String(file.name || '').slice(0, 80), uri });
      added++;
    } catch (e) {
      warn(e && e.tooBig ? 'slideshow_img_too_big' : 'slideshow_img_invalid', file.name);
    }
  }
  if (added) updateSlideshowCfg({ images });
}

function removeSlideshowImage(idx) {
  const current = normalizeSlideshow(hubSettings.slideshow);
  if (idx < 0 || idx >= current.images.length) return;
  const images = current.images.slice();
  images.splice(idx, 1);
  updateSlideshowCfg({ images });
}

function moveSlideshowImage(idx, dir) {
  const current = normalizeSlideshow(hubSettings.slideshow);
  const images = current.images.slice();
  const j = idx + dir;
  if (idx < 0 || idx >= images.length || j < 0 || j >= images.length) return;
  const tmp = images[idx]; images[idx] = images[j]; images[j] = tmp;
  updateSlideshowCfg({ images });
}

// Open the Settings overlay straight at the Slideshow pane (the widget's empty
// state links here).
function openSlideshowSettings() {
  const overlay = $('settings-overlay');
  if (overlay && overlay.hidden) toggleSettings();
  settingsSetCategory('slideshow');
}

// Fill the Slideshow settings pane: the thumbnail grid (reorder + remove) plus
// the interval and fit fields. Safe to call anytime — no-ops when the pane isn't
// in the DOM, and skips the grid rebuild when the image set is unchanged.
function renderSlideshowSettings() {
  const c = normalizeSlideshow(hubSettings.slideshow);
  const cap = window.SlideshowWidget ? SlideshowWidget.SLIDE_MAX_COUNT : 200;
  const intInput = $('settings-slideshow-interval');
  if (intInput && document.activeElement !== intInput) intInput.value = String(Math.round(c.intervalMs / 1000));
  const fitSel = $('settings-slideshow-fit');
  if (fitSel && document.activeElement !== fitSel) fitSel.value = c.fit;
  const countEl = $('settings-slideshow-count');
  if (countEl) countEl.textContent = c.images.length + ' / ' + cap;
  const host = $('settings-slideshow-assets');
  if (!host) return;
  const sig = c.images.length + '|' + c.images.map(im => im.uri.length).join(',');
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  const svg = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const L = svg('<path d="M15 18l-6-6 6-6"/>'), R = svg('<path d="M9 18l6-6-6-6"/>'), X = svg('<path d="M6 6l12 12M18 6L6 18"/>');
  const frag = document.createDocumentFragment();
  c.images.forEach((im, i) => {
    const cell = document.createElement('div'); cell.className = 'sl-asset';
    const img = document.createElement('img'); img.src = im.uri; img.alt = im.name || ''; img.decoding = 'async'; img.loading = 'lazy';
    cell.appendChild(img);
    const actions = document.createElement('div'); actions.className = 'sl-asset-actions';
    const mk = (cls, html, aria, on, disabled) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'sl-asset-btn ' + cls;
      b.innerHTML = html; b.setAttribute('aria-label', aria);
      if (disabled) b.disabled = true; else b.addEventListener('click', on);
      return b;
    };
    actions.appendChild(mk('sl-mv-l', L, t('slideshow_move_left', 'Move earlier'), () => moveSlideshowImage(i, -1), i === 0));
    actions.appendChild(mk('sl-mv-r', R, t('slideshow_move_right', 'Move later'), () => moveSlideshowImage(i, 1), i === c.images.length - 1));
    actions.appendChild(mk('sl-asset-rm', X, t('slideshow_remove', 'Remove'), () => removeSlideshowImage(i), false));
    cell.appendChild(actions);
    frag.appendChild(cell);
  });
  host.replaceChildren(frag);
}

// Render the asset chips (thumbnail + name + size + remove) under the editor.
// Data URIs are trusted here only as <img src> — the key is textContent.
// syncBgFxControls calls this on every settings sync (slider ticks included),
// so an identical asset set must cost nothing: skip when the signature matches.
let bgAssetChipsSig = null;
function renderBgAssetChips() {
  const wrap = $('settings-bgcode-assets');
  if (!wrap) return;
  const cb = normalizeBgCustom(hubSettings.bgCustom);
  const keys = Object.keys(cb.assets);
  const sig = keys.map((k) => k + ':' + cb.assets[k].length).join('|');
  if (sig === bgAssetChipsSig && wrap.childElementCount === keys.length) return;
  bgAssetChipsSig = sig;
  wrap.replaceChildren();
  wrap.hidden = !keys.length;
  keys.forEach((key) => {
    const chip = document.createElement('span');
    chip.className = 'settings-bgasset-chip';
    const img = document.createElement('img');
    img.className = 'settings-bgasset-thumb';
    img.alt = '';
    img.src = cb.assets[key];
    const label = document.createElement('span');
    label.className = 'settings-bgasset-name';
    label.textContent = 'assets.' + key;
    const size = document.createElement('span');
    size.className = 'settings-bgasset-size';
    size.textContent = Math.max(1, Math.round(cb.assets[key].length * 3 / 4 / 1024)) + ' KB';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'settings-bgasset-del';
    del.setAttribute('aria-label', t('settings_bg_asset_remove'));
    del.textContent = '×';
    del.addEventListener('click', () => removeBgAsset(key));
    chip.appendChild(img); chip.appendChild(label); chip.appendChild(size); chip.appendChild(del);
    wrap.appendChild(chip);
  });
}

let bgCodeLiveTimer = 0;
// Repaint the animated background WHILE typing (debounced) instead of only on
// blur, so the editor feels live. onchange still fires on blur as a final flush.
function updateBgCustomCodeLive(value) {
  if (bgCodeLiveTimer) clearTimeout(bgCodeLiveTimer);
  bgCodeLiveTimer = setTimeout(() => { bgCodeLiveTimer = 0; updateBgCustom('code', value); }, 400);
}

// Live character counter for the code editor. The code is capped at
// BG_CUSTOM_CODE_MAX (normalizeBgCustom slices it), so without this the excess
// would be truncated silently. Fires immediately on input (not debounced) and
// on every sync, turning warning-coloured near the cap and surfacing an
// explicit over-limit note past it — so hitting the ceiling is never a surprise.
function updateBgCodeCount(len) {
  const el = $('settings-bgcode-count');
  if (el) {
    el.textContent = len + ' / ' + BG_CUSTOM_CODE_MAX;
    el.classList.toggle('is-near', len > BG_CUSTOM_CODE_MAX * 0.9 && len <= BG_CUSTOM_CODE_MAX);
    el.classList.toggle('is-over', len > BG_CUSTOM_CODE_MAX);
  }
  const note = $('settings-bgcode-overlimit');
  if (note) note.hidden = len <= BG_CUSTOM_CODE_MAX;
}

function clearBgCodeError() {
  const el = $('settings-bgcode-error');
  if (el) { el.hidden = true; el.textContent = ''; }
}
// Show/clear the inline error under the code editor from the sandbox frame's
// reported status (dispatched by custom-bg.js). Untrusted message → textContent.
function renderBgCodeError(detail) {
  const el = $('settings-bgcode-error');
  if (!el) return;
  const d = detail || {};
  if (d.ok || !d.kind) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = (d.kind === 'nodraw')
    ? t('settings_bg_code_nodraw')
    : (d.kind === 'asset')
      ? t('settings_bg_code_asset_error') + (d.message ? ': ' + d.message : '')
      : t('settings_bg_code_error') + (d.message ? ': ' + d.message : '');
  el.hidden = false;
}
if (typeof document !== 'undefined') {
  document.addEventListener('xenon-bg-status', (e) => renderBgCodeError(e && e.detail));
}

// Tell the author when their snippet is frozen by the machine rather than by
// their code. On a hybrid-GPU machine the background runs for ~3s and then stops
// for the session (js/custom-bg.js hostPaused → body.low-power-gpu), which reads
// exactly like a broken animation loop: a theme author burned hours rewriting a
// working snippet before we found it (#118). This is not an error, so it is a
// separate note from renderBgCodeError's alert and says how to switch it off.
function renderBgFrozenNote() {
  const el = $('settings-bgcode-frozen');
  if (!el) return;
  const frozen = !!(window.NativeGpuPause
    && window.NativeGpuPause.isLowPowerGpu()
    && hubSettings.hybridGpuAnimationPause !== false);
  el.textContent = frozen ? t('settings_bg_code_frozen_gpu') : '';
  el.hidden = !frozen;
}

// Drop a starter snippet into the code box (and enable the background so the user
// sees it immediately). Never overwrites non-empty code without asking.
async function applyBgCustomTemplate(id) {
  const code = BG_CUSTOM_TEMPLATES[id];
  if (!code) return;
  const existing = (hubSettings.bgCustom && hubSettings.bgCustom.code) || '';
  if (existing.trim()) {
    const okReplace = await settingsPrompt({
      type: 'confirm',
      title: t('settings_bg_code_editor'),
      message: t('settings_bg_code_replace'),
      okLabel: t('dlg_replace'),
    });
    if (!okReplace) return;
  }
  const current = hubSettings.bgCustom && typeof hubSettings.bgCustom === 'object' ? hubSettings.bgCustom : {};
  // A picked preset ships with Xenon → the user's own choice, not an import.
  hubSettings = normalizeSettings({ ...hubSettings, bgCustom: { ...current, code, enabled: true, imported: false } });
  saveHubSettings();
  applyHubSettings();
  syncBgFxControls();
}

// Open the in-app ColorPicker from a settings colour preview (the native colour
// dialog is blocked in the iCUE WebView). `key` is a hub colour key ('accent',
// 'background', 'text') or 'grid' for the neon-grid background colour. Wired
// via onclick on the .settings-color-preview divs in index.html.
function openSettingsColorPicker(key, anchor) {
  if (!window.ColorPicker) return;
  const input = $(key === 'grid' ? 'settings-grid-color' : `settings-${key}`);
  const raw = input ? input.value.trim() : '';
  const cssVars = {
    accent: '--accent', background: '--bg', surface: '--surface', surfaceAlt: '--surface-alt',
    controlColor: '--control-bg', text: '--text', mutedText: '--muted-text', lineColor: '--line',
    accentText: '--on-accent', successColor: '--color-success', warningColor: '--color-warn',
    dangerColor: '--color-danger', infoColor: '--color-info',
  };
  const effective = key === 'grid' ? '#1ed760'
    : getComputedStyle(document.documentElement).getPropertyValue(cssVars[key] || '--accent').trim();
  const value = normalizeHex(raw.startsWith('#') ? raw : `#${raw}`, normalizeHex(effective, '#1ed760'));
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

  // Static background picker
  const st = normalizeBgStatic(hubSettings.bgStatic);
  document.querySelectorAll('.bgstatic-option').forEach(btn => {
    btn.setAttribute('aria-pressed', btn.dataset.bgstatic === st.style ? 'true' : 'false');
  });
  setVal('settings-bgstatic-intensity', String(st.intensity));
  const intensityRow = $('settings-bgstatic-intensity-row');
  if (intensityRow) intensityRow.hidden = st.style === 'none';
  const staticActive = st.style !== 'none';
  // A custom image/video background takes priority over the static bg (and every
  // FX layer). Tell the user their pick is hidden rather than silently no-op'ing.
  const mediaActive = !!hubSettings.backgroundMedia;
  const mediaNote = $('settings-bgstatic-media-off');
  if (mediaNote) mediaNote.hidden = !(staticActive && mediaActive);

  // Code-defined background controls + its own priority. When it's on it owns the
  // backdrop just like a static bg, so the aurora/grid/static are superseded.
  renderBgFrozenNote();
  const cb = normalizeBgCustom(hubSettings.bgCustom);
  setChk('settings-bgcode-enabled', cb.enabled);
  const codeName = $('settings-bgcode-name');
  if (codeName && document.activeElement !== codeName) codeName.value = cb.name;
  const codeFps = $('settings-bgcode-fps');
  if (codeFps) {
    // Bounds come from the rule owner so the field can never drift from what
    // the sanitizer actually accepts (same contract as the ASSET_* caps).
    if (window.CustomBg && CustomBg.FPS_MIN) { codeFps.min = String(CustomBg.FPS_MIN); codeFps.max = String(CustomBg.FPS_MAX); }
    if (document.activeElement !== codeFps) codeFps.value = String(cb.fps);
  }
  const codeField = $('settings-bgcode-input');
  // An imported background is someone else's work: never surface or let them edit
  // the source. Lock the editor entirely (empty + disabled + hidden), hide the
  // "how to write code" help, and show a lock banner. A template swap below flips
  // imported off (updateBgCustom → applyBgCustomTemplate), restoring the editor.
  const codeLocked = cb.imported === true && !!cb.code;
  const editorRow = $('settings-bgcode-editor-row');
  const codeHelp = $('settings-bgcode-help');
  const codeLockNote = $('settings-bgcode-locked');
  if (editorRow) editorRow.hidden = codeLocked;
  if (codeHelp) codeHelp.hidden = codeLocked;
  if (codeLockNote) codeLockNote.hidden = !codeLocked;
  if (codeField) {
    codeField.disabled = codeLocked;
    codeField.readOnly = codeLocked;
    if (codeLocked) {
      // Do not leave the source in the DOM at all — clear the field's value.
      codeField.value = '';
    } else if (document.activeElement !== codeField) {
      codeField.value = cb.code;
    }
  }
  // Keep the counter honest: reflect the field's live length when the user is
  // typing, otherwise the stored (already-capped) code length. Hidden while locked.
  updateBgCodeCount(codeLocked ? 0 : (codeField && document.activeElement === codeField ? codeField.value.length : cb.code.length));
  renderBgAssetChips();
  const codeMediaNote = $('settings-bgcode-media-off');
  if (codeMediaNote) codeMediaNote.hidden = !(cb.enabled && mediaActive);
  const codeGroup = $('settings-bgcode-group');
  if (codeGroup) codeGroup.classList.toggle('is-superseded', mediaActive);

  // The backdrop can be owned by a static premium bg OR a code-defined one: in
  // either case the animated aurora and neon grid don't render, so their controls
  // are disabled and annotated (the UI never claims an effect that isn't showing).
  const backdropOwned = staticActive || cb.enabled;
  const auroraNote = $('settings-aurora-superseded');
  if (auroraNote) auroraNote.hidden = !backdropOwned;
  const auroraGroup = $('settings-aurora-group');
  if (auroraGroup) auroraGroup.classList.toggle('is-superseded', backdropOwned);
  const gridNote = $('settings-grid-superseded');
  if (gridNote) gridNote.hidden = !backdropOwned;
  const gridGroup = $('settings-grid-group');
  if (gridGroup) gridGroup.classList.toggle('is-superseded', backdropOwned);
  [
    'settings-aurora-enabled', 'settings-aurora-intensity', 'settings-aurora-speed',
    'settings-grid-enabled', 'settings-grid-intensity', 'settings-grid-speed', 'settings-grid-color',
  ].forEach(id => {
    const el = $(id); if (el) el.disabled = backdropOwned;
  });
  // A code-defined background supersedes the static premium picker too.
  const staticGroup = $('settings-bgstatic-group');
  if (staticGroup) staticGroup.classList.toggle('is-superseded', cb.enabled);
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

// ── Available-update lookup (feeds the daily toast) ────────────────────────
// The list of installed packages itself now lives in the Store's "Installed"
// tab (js/installed-manager.js) — this is only the catalog JOIN behind the
// once-a-day "{n} widgets have updates" toast. The JOIN itself lives in
// community-gallery.js (CommunityGallery.findUpdates) — ONE implementation for
// the gallery, the installed manager and this toast, so the surfaces can never
// disagree about whether an update exists.
let _sdkUpdatesCache = null;   // pkgId → catalog entry with a newer version
let _sdkUpdatesInflight = null;   // shared promise so concurrent cold calls fetch the catalog once
async function _sdkCatalogUpdates(force) {
  if (_sdkUpdatesCache && !force) return _sdkUpdatesCache;
  if (!_sdkUpdatesInflight || force) {
    _sdkUpdatesInflight = (async () => {
      const out = new Map();
      try {
        const cat = await fetch('/api/community/catalog').then((r) => r.json());
        const updates = (window.CommunityGallery && window.CommunityGallery.findUpdates)
          ? await window.CommunityGallery.findUpdates((cat && cat.entries) || [])
          : [];
        // findUpdates now also returns receipt-matched NON-pkgId content
        // (themes, decks, packs) — those surface in the gallery's "Updates for
        // your content" section. This map is the SDK-package manager + the
        // "{n} widgets" daily toast, so keep ONLY pkgId-bearing entries (a
        // non-pkgId entry would land under the key `undefined`, collapse
        // several into one, and inflate the widget count with unactionable rows).
        for (const entry of updates) if (entry.pkgId) out.set(entry.pkgId, entry);
      } catch { /* offline → no update hints */ }
      _sdkUpdatesCache = out;
      _sdkUpdatesInflight = null;
      return out;
    })();
  }
  return _sdkUpdatesInflight;
}
// Once-a-day update check, client-driven (no server timer): on load, when
// anything from the catalog is installed, one catalog GET (absorbed by the
// server's 45-min TTL cache) surfaces available updates as a gentle toast.
//
// It counts EVERYTHING findUpdates returns, not just SDK packages. The old
// version gated on `sdkWidgets.enabled` and bailed unless a widget package was
// installed, so a user whose themes, decks and icon packs all had updates
// waiting was told nothing — and with the SDK off, never told anything at all.
// The gallery had the answer the whole time; only this notice was narrow.
async function checkSdkUpdatesDaily() {
  try {
    const KEY = 'xeneonedge.sdkUpdateCheck';
    const last = Number(localStorage.getItem(KEY) || 0);
    if (Date.now() - last < 24 * 3600 * 1000) return;
    if (!window.CommunityGallery || !window.CommunityGallery.findUpdates) return;
    const cat = await fetch('/api/community/catalog').then((r) => r.json()).catch(() => null);
    const entries = (cat && cat.entries) || [];
    if (!entries.length) return;
    // Stamp only once the check actually ran end-to-end — an offline attempt
    // must not burn the day's slot and hide a real update until tomorrow.
    const updates = await window.CommunityGallery.findUpdates(entries);
    localStorage.setItem(KEY, String(Date.now()));
    _sdkUpdatesCache = null;   // the package manager re-derives its pkgId view lazily
    if (!updates.length || !window.XenonToast) return;
    // Name the thing when there is only one — "1 aggiornamento" is a riddle,
    // "Aggiornamento per Nocturne" is an answer.
    const title = updates.length === 1
      ? t('settings_updates_toast_one', 'Aggiornamento per {name}').replace('{name}', updates[0].name || '')
      : t('settings_updates_toast_n', '{n} contenuti hanno un aggiornamento').replace('{n}', String(updates.length));
    window.XenonToast.show({
      type: 'notification',
      kicker: t('settings_sdk_title', 'Widget della community'),
      title,
      message: updates.length === 1 && updates[0].changelog
        ? updates[0].changelog
        : t('settings_updates_toast_sub', 'Apri lo Store → Installati per aggiornare'),
      duration: 7000,
      // '__installed' is the gallery's own deep-link to the Installed tab, where
      // every update has its button. A notice you can't act on is just noise.
      onClick: () => {
        try { if (window.CommunityGallery) window.CommunityGallery.open('__installed'); }
        catch { /* the toast is a hint, never a hard dependency */ }
      },
    });
  } catch { /* best-effort */ }
}
setTimeout(checkSdkUpdatesDaily, 15000);

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
  if (field !== 'enabled' && field !== 'popups' && field !== 'sounds') return;
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
  // Sound sub-toggle: likewise gated by the master switch.
  const snd = $('settings-notif-sounds');
  if (snd) { snd.checked = n.sounds !== false; snd.disabled = !enabled; }
  const sndRow = $('settings-notif-sounds-row');
  if (sndRow) sndRow.classList.toggle('is-disabled', !enabled);
  // Windows notification mirroring — the same two switches the Notifications
  // tile carries (the tile also owns the muted-apps list). The server gates the
  // mirror child on the master switch too, so mirror that gating here; "hide
  // content" additionally needs the mirror itself to be on.
  const wn = hubSettings.windowsNotifications || {};
  const wnOn = wn.enabled === true;
  const win = $('settings-winnotif');
  if (win) { win.checked = wnOn; win.disabled = !enabled; }
  const winRow = $('settings-winnotif-row');
  if (winRow) winRow.classList.toggle('is-disabled', !enabled);
  const winHide = $('settings-winnotif-hide');
  if (winHide) { winHide.checked = wn.hide === true; winHide.disabled = !enabled || !wnOn; }
  const winHideRow = $('settings-winnotif-hide-row');
  if (winHideRow) winHideRow.classList.toggle('is-disabled', !enabled || !wnOn);
}

// ── Vitals (Settings → Notifiche, Vitals card) ──
function updateVitalsSetting(field, enabled) {
  if (!['enabled', 'topbar', 'reminders', 'awayPause'].includes(field)) return;
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
  const FIELDS = ['enabled', 'tone', 'effects', 'sounds', 'lighting', 'monitors', 'minimize', 'lock', 'quietInGame', 'position', 'aiRoasts', 'nightQuiet'];
  if (!FIELDS.includes(field)) return;
  const cur = hubSettings.vitals || {};
  const pet = { ...(cur.pet || {}) };
  const next = (field === 'tone' || field === 'position') ? String(value) : !!value;
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

// Per-rung escalation delay (minutes a vital must be at zero before the stage).
// Guarded like updateVitalItem — syncVitalsControls dispatches 'change' on the
// custom-select, so an unchanged value must be a no-op, not a save loop.
function updateVitalsPetThreshold(stage, minutes) {
  if (!VITALS_PET_STAGES.includes(stage)) return;
  const cur = hubSettings.vitals || {};
  const pet = { ...(cur.pet || {}) };
  const thresholds = { ...(pet.thresholds || {}) };
  const next = Math.round(Number(minutes) || 0);
  if (thresholds[stage] === next) return;
  thresholds[stage] = next;
  pet.thresholds = thresholds;
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
  [['settings-vitals-topbar', v.topbar === true], ['settings-vitals-reminders', v.reminders !== false],
   ['settings-vitals-awaypause', v.awayPause !== false]].forEach(([id, on]) => {
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
   ['settings-vpet-lighting', pet.lighting === true],
   ['settings-vpet-quiet', pet.quietInGame !== false], ['settings-vpet-night', pet.nightQuiet !== false],
   ['settings-vpet-ai', pet.aiRoasts === true], ['settings-vpet-monitors', pet.monitors === true],
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
  // Where Bit lives (floating corner / topbar chip / both) — same guarded
  // custom-select sync pattern as the tone select.
  const pos = $('settings-vpet-position');
  if (pos) {
    pos.disabled = !petOn;
    const want = ['floating', 'topbar', 'both'].includes(pet.position) ? pet.position : 'floating';
    if (pos.value !== want) {
      pos.value = want;
      pos.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  const posRow = $('settings-vpet-position-row');
  if (posRow) posRow.classList.toggle('is-disabled', !petOn);
  // Escalation-timing selects (decay / gameover / overlay / minimize / lock).
  const thresholds = pet.thresholds || {};
  VITALS_PET_STAGES.forEach((stage) => {
    const sel = $('settings-vpet-thr-' + stage);
    if (sel) {
      sel.disabled = !petOn;
      const want = String(thresholds[stage] || VITALS_PET_DEFAULT_THR[stage]);
      if (sel.value !== want) {
        sel.value = want;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const row = $('settings-vpet-thr-' + stage + '-row');
    if (row) row.classList.toggle('is-disabled', !petOn);
  });
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

// ── Windows notification mirroring (Settings → Notifiche + the tile) ─────
// The enable/hide switches live in BOTH places (the tile also owns the
// muted-apps list); this is their single write path. `value` is a boolean for
// enabled/hide and the whole {id,name} array for excluded —
// normalizeWindowsNotifications bounds it all.
function updateWindowsNotifications(field, value) {
  const cur = hubSettings.windowsNotifications || {};
  hubSettings = normalizeSettings({ ...hubSettings, windowsNotifications: { ...cur, [field]: value } });
  saveHubSettings();
  syncNotificationsControls();
  // Repaint the tile so a toggle flipped in Settings lands there immediately —
  // the server's SSE state push would arrive a beat later, and only once it has
  // actually started the mirror child. Idempotent; the tile's own controls call
  // this too and paint again harmlessly.
  if (window.NotificationsWidget && typeof window.NotificationsWidget.renderWidgets === 'function') {
    window.NotificationsWidget.renderWidgets();
  }
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
    // Base styles PLUS every saved custom theme, so a profile can switch to a
    // full look (e.g. "when gaming → Cyberpunk"), not just the Glass/Retro skin.
    selects.appendChild(buildContextSelect(act, 'style', entry.style, [
      { value: '', label: tr('context_none') },
      { value: 'glass', label: tr('settings_style_glass') },
      { value: 'retro', label: tr('settings_style_retro') },
    ].concat(getCustomThemes().map(th => ({ value: th.id, label: themeName(th) })))));
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
  syncAmbientSettings();
}

// ── Ambient / Screensaver settings panel ─────────────────────────────
function syncAmbientSettings() {
  const cfg = normalizeAmbientMode(hubSettings.ambientMode);
  const enabled = $('settings-ambient-enabled');
  if (enabled) enabled.checked = cfg.enabled;
  const idle = $('settings-ambient-idle');
  if (idle) {
    const want = String(cfg.idleMinutes);
    if (idle.value !== want) {
      idle.value = want;
      // #settings-ambient-idle is a data-custom-select: it only re-syncs its
      // visible label on a 'change' event. Setting .value alone leaves the label
      // stuck on the HTML default ("Mai"), so a saved idle time looked reverted
      // after a refresh. The guarded updateAmbientSetting makes this a no-op save.
      idle.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  syncAmbientScenePicker(cfg);
  renderAmbientSceneManager();
  // The lockWidgets toggles only shape the builtin scene.
  const builtinWidgets = $('settings-ambient-builtin-widgets');
  if (builtinWidgets) builtinWidgets.hidden = cfg.sceneId !== 'builtin';
  // A disabled mode also retires its topbar button.
  const topBtn = $('ambient-topbtn');
  if (topBtn) topBtn.hidden = !cfg.enabled;
}

// Fill the scene <select> with builtin + every installed surface:'ambient'
// package. Options are rebuilt from the trusted normalized manifest list;
// names are untrusted manifest text → option.textContent.
function syncAmbientScenePicker(cfg) {
  const select = $('settings-ambient-scene');
  if (!select) return;
  const packages = (window.CustomWidget && typeof CustomWidget.cachedPackages === 'function')
    ? CustomWidget.cachedPackages().filter(p => p && p.surface === 'ambient') : [];
  const builtin = document.createElement('option');
  builtin.value = 'builtin';
  builtin.setAttribute('data-i18n', 'ambient_scene_builtin');
  builtin.textContent = t('ambient_scene_builtin');
  const options = [builtin];
  // Native canvas scenes the user composed in the editor (value "canvas:<id>").
  const scenes = Array.isArray(hubSettings.ambientScenes) ? hubSettings.ambientScenes : [];
  scenes.forEach(sc => {
    if (!sc || !sc.id) return;
    const opt = document.createElement('option');
    opt.value = 'canvas:' + sc.id;
    opt.textContent = sc.name || t('ambient_editor_untitled');
    options.push(opt);
  });
  packages.forEach(pkg => {
    const opt = document.createElement('option');
    opt.value = pkg.id;
    opt.textContent = pkg.name;
    options.push(opt);
  });
  select.replaceChildren(...options);
  // Keep the saved choice selected even while its package list hasn't loaded
  // yet — never silently rewrite the persisted sceneId from a sync pass. Canvas
  // refs are matched against the saved-scenes array, not the package list.
  const isCanvasSel = typeof AmbientScene !== 'undefined' && AmbientScene.isCanvasRef(cfg.sceneId);
  const known = cfg.sceneId === 'builtin'
    || packages.some(p => p.id === cfg.sceneId)
    || (isCanvasSel && scenes.some(s => s && 'canvas:' + s.id === cfg.sceneId));
  if (!known) {
    const ghost = document.createElement('option');
    ghost.value = cfg.sceneId;
    ghost.textContent = t('ambient_scene_missing');
    select.appendChild(ghost);
  }
  select.value = cfg.sceneId;
  // Warm the package cache whenever the picker syncs while it's empty —
  // without this, installed scenes stay invisible until some custom TILE
  // happens to paint (a dashboard with no custom tiles would never list them).
  if (window.CustomWidget && typeof CustomWidget.getPackages === 'function' && !packages.length) {
    CustomWidget.getPackages(false).then(() => {
      const fresh = CustomWidget.cachedPackages().some(p => p && p.surface === 'ambient');
      if (fresh) syncAmbientScenePicker(normalizeAmbientMode(hubSettings.ambientMode));
    }).catch(() => {});
  }
}

// Re-list the ambient scenes whenever the SDK package set changes (an install or
// removal), so a freshly imported scene appears in the dropdown with no page
// reload. No-op when the picker isn't in the DOM (settings closed).
window.addEventListener('xenon:sdk-packages', () => {
  try { syncAmbientScenePicker(normalizeAmbientMode(hubSettings.ambientMode)); } catch { /* settings not ready */ }
});

function updateAmbientSetting(key, value) {
  if (!['enabled', 'idleMinutes', 'sceneId'].includes(key)) return;
  const cur = normalizeAmbientMode(hubSettings.ambientMode);
  const next = { ...cur };
  if (key === 'enabled') next.enabled = !!value;
  else if (key === 'idleMinutes') next.idleMinutes = Number(value);
  else next.sceneId = String(value || 'builtin');
  // Guarded: syncAmbientSettings dispatches 'change' on the idle custom-select to
  // re-sync its visible label — an unchanged value must be a no-op, not a save
  // (and must not re-fire the scene grant prompt below).
  if (next.enabled === cur.enabled && next.idleMinutes === cur.idleMinutes && next.sceneId === cur.sceneId) return;
  hubSettings = normalizeSettings({ ...hubSettings, ambientMode: next });
  saveHubSettings();
  syncAmbientSettings();
  // Selecting an SDK scene the user never approved should prompt right away — the
  // grant dialog is clearer at pick time than at first activation. Canvas scenes
  // are first-party, so they never prompt.
  const isCanvas = typeof AmbientScene !== 'undefined' && AmbientScene.isCanvasRef(next.sceneId);
  if (key === 'sceneId' && next.sceneId !== 'builtin' && !isCanvas && window.CustomWidget) {
    const pkg = CustomWidget.cachedPackages().find(p => p && p.id === next.sceneId);
    if (pkg && !CustomWidget.packageGranted(pkg)) CustomWidget.requestGrant(pkg);
  }
  setSettingsStatus('settings_saved', 'ok');
}

// ── Native canvas scene manager (Settings → Ambient) ─────────────────────────
// Lists the canvas scenes installed via Import (authored as 'ambient-layout'
// codes — the xenon-creator flow / the gallery) with a remove action. There is
// no in-app editor; scenes are created by code and imported.
function renderAmbientSceneManager() {
  const list = $('settings-ambient-scene-list');
  if (!list) return;
  const scenes = Array.isArray(hubSettings.ambientScenes) ? hubSettings.ambientScenes : [];
  const activeId = normalizeAmbientMode(hubSettings.ambientMode).sceneId;
  if (!scenes.length) {
    list.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'settings-ambient-scene-empty',
      textContent: t('ambient_scenes_empty'),
    }));
    return;
  }
  const rows = scenes.map(sc => {
    const row = document.createElement('div');
    row.className = 'settings-ambient-scene-row';
    if ('canvas:' + sc.id === activeId) row.classList.add('is-active');
    const info = document.createElement('div');
    info.className = 'settings-ambient-scene-info';
    const name = document.createElement('span');
    name.className = 'settings-ambient-scene-name';
    name.textContent = sc.name || t('ambient_editor_untitled');   // untrusted → textContent
    const meta = document.createElement('span');
    meta.className = 'settings-ambient-scene-meta';
    const count = Array.isArray(sc.components) ? sc.components.length : 0;
    meta.textContent = t('ambient_editor_count').replace('{n}', count)
      + (sc.imported ? ' · ' + t('ambient_imported') : '');
    info.append(name, meta);
    const acts = document.createElement('div');
    acts.className = 'settings-ambient-scene-acts';
    const mk = (label, cls, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'settings-btn subtle' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.addEventListener('click', fn);
      return b;
    };
    // Scenes are authored as import codes (the xenon-creator flow / the gallery)
    // and installed through Import — the manager only lists and removes them.
    acts.append(mk(t('ambient_scene_delete'), 'danger', () => deleteAmbientScene(sc.id)));
    row.append(info, acts);
    return row;
  });
  list.replaceChildren(...rows);
}

function deleteAmbientScene(id) {
  const scenes = Array.isArray(hubSettings.ambientScenes) ? hubSettings.ambientScenes : [];
  const target = scenes.find(s => s && s.id === id);
  if (!target) return;
  if (!window.confirm(t('ambient_scene_delete_confirm').replace('{name}', target.name || t('ambient_editor_untitled')))) return;
  const next = scenes.filter(s => s && s.id !== id);
  const patch = { ambientScenes: next };
  // If the deleted scene was the active one, fall back to the builtin scene so
  // the picker/screensaver never points at a missing canvas ref.
  const cur = normalizeAmbientMode(hubSettings.ambientMode);
  if (cur.sceneId === 'canvas:' + id) patch.ambientMode = { ...cur, sceneId: 'builtin' };
  hubSettings = normalizeSettings({ ...hubSettings, ...patch });
  forgetInstalledContentResource('ambientSceneIds', id);
  saveHubSettings();
  onAmbientScenesChanged();
  setSettingsStatus('settings_saved', 'ok');
}

// Called after a scene is imported (preset-share applyAmbientLayout) or deleted —
// refresh the picker + manager and notify the ambient runtime.
function onAmbientScenesChanged() {
  try { syncAmbientSettings(); } catch { /* settings not open */ }
  if (window.AmbientMode && typeof AmbientMode.onSettingsChanged === 'function') AmbientMode.onSettingsChanged();
}
window.onAmbientScenesChanged = onAmbientScenesChanged;

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

// ── Swipe-up home gesture (native app only) ─────────────────────────────────
// In the native kiosk a quick up-swipe from the bottom of the screen drops the
// dashboard to the Windows desktop (see native-bridge.js). The row only shows
// inside the native app — the gesture doesn't exist on the browser/iCUE
// surfaces — and the value is pushed to the bridge, which also reconciles the
// shell's Windows edge-swipe block.
function syncSwipeHomeControl() {
  const row = $('settings-swipe-home-row');
  const check = $('settings-swipe-home');
  const isNativeApp = !!(window.XenonNative && window.XenonNative.isNative);
  // display (not `hidden`): the settings category switcher owns `hidden`.
  if (row) row.style.display = isNativeApp ? '' : 'none';
  const on = hubSettings.swipeHomeGesture !== false;
  if (check) check.checked = on;
  if (window.XenonNative && typeof window.XenonNative.setHomeGestureEnabled === 'function') {
    window.XenonNative.setHomeGestureEnabled(on);
  }
}

function updateSwipeHomeGesture(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, swipeHomeGesture: checked === true });
  saveHubSettings();
  syncSwipeHomeControl();
}

// ── Hide during Remote Desktop (native app only) ────────────────────────────
// When the user is RDP'd into this PC (their own Windows Remote Desktop — not our
// Sunshine/Moonlight remote control), the borderless kiosk would cover the desktop
// they came in to use. With this on, the native shell hides the window while a
// Remote Desktop session is active and shows it again at the console. Opt-in; the
// row only shows inside the native app, and the value is pushed to the bridge,
// which signals the shell and persists the choice for the next launch.
function syncHideRdpControl() {
  const row = $('settings-hide-rdp-row');
  const check = $('settings-hide-rdp');
  const isNativeApp = !!(window.XenonNative && window.XenonNative.isNative);
  // display (not `hidden`): the settings category switcher owns `hidden`.
  if (row) row.style.display = isNativeApp ? '' : 'none';
  const on = hubSettings.hideOnRdp === true;
  if (check) check.checked = on;
  if (window.XenonNative && typeof window.XenonNative.setHideOnRdp === 'function') {
    window.XenonNative.setHideOnRdp(on);
  }
}

function updateHideOnRdp(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, hideOnRdp: checked === true });
  saveHubSettings();
  syncHideRdpControl();
}

// ── Interface scale / zoom (native app only) ────────────────────────────────
// The native kiosk can scale its whole webview (WebView2 zoom factor),
// independent of the Windows display scale. The row only shows inside the
// native app; the value is pushed to the bridge, which applies and persists the
// zoom shell-side. The user can also zoom live with Ctrl + mouse wheel (enabled
// in the shell) — this slider is the persisted, explicit control.
function syncNativeZoomControl() {
  const row = $('settings-native-zoom-row');
  const slider = $('settings-native-zoom');
  const valueEl = $('settings-native-zoom-value');
  const isNativeApp = !!(window.XenonNative && window.XenonNative.isNative);
  // display (not `hidden`): the settings category switcher owns `hidden`.
  if (row) row.style.display = isNativeApp ? '' : 'none';
  const scale = clampNumber(hubSettings.nativeZoom, 0.6, 1.6, 1);
  if (slider) slider.value = String(scale);
  if (valueEl) valueEl.textContent = formatPercent(scale);
  if (isNativeApp && window.XenonNative && typeof window.XenonNative.setNativeZoom === 'function') {
    window.XenonNative.setNativeZoom(scale);
  }
}

function updateNativeZoom(value) {
  hubSettings = normalizeSettings({ ...hubSettings, nativeZoom: value });
  saveHubSettings();
  syncNativeZoomControl();
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

// Anonymous version ping. Purely a stored preference — the server reads it on
// the next update check and decides whether to send, so there is nothing to
// call here and nothing to undo if the user switches it straight back off.
function updateVersionPing(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, versionPing: checked === true });
  saveHubSettings();
  syncSettingsControls();
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
  // Cancel the debounced duplicate (and any retry chain) first, so a second
  // /settings POST can't land AFTER restart() and tear the freshly-relaunched
  // Edge back down.
  try { await flushHubSettingsToServer(); } catch { /* saveLocalHubSettings already persisted it locally */ }
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
  const daysSelect = $('settings-weather-days');
  if (daysSelect && daysSelect.value !== String(weather.forecastDays)) {
    daysSelect.value = String(weather.forecastDays);
    // Guarded updateWeatherForecastDays neutralizes this label-sync 'change' dispatch.
    daysSelect.dispatchEvent(new Event('change', { bubbles: true }));
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

// Signature of the weather settings the client's fetch/poll actually depends
// on: what to fetch (mode/city/provider — provider is applied server-side but
// still changes the data) and how often (refreshMin). The SSE-sync hydrate
// compares it before/after a merge so a change made on ANOTHER surface
// refetches here too, not only local control edits (GitHub #72).
function _weatherSyncSig(w) {
  const n = normalizeWeatherSettings(w);
  return {
    fetch: n.mode + '|' + String(n.city || '').toLowerCase() + '|' + n.provider,
    refreshMin: n.refreshMin,
  };
}

// Which widget instances sit on which page — the structural shape of the layout,
// NOT its geometry. Captures a primary being shown/hidden or moved to another page,
// a duplicated/custom copy being added/removed, and any tab-group change. An
// in-page move/resize does NOT change this (that's the light applyDashboardLayout
// path); a structural change routes to a full rebuild so a widget added on another
// screen materializes live instead of only after a reload (GitHub #72).
function _dashboardPlacementSig(layout) {
  if (!layout || typeof layout !== 'object') return '';
  const widgets = layout.widgets || {};
  const wids = Object.keys(widgets)
    .filter(id => widgets[id] && widgets[id].visible)
    .map(id => id + '@' + (widgets[id].page || ''))
    .sort();
  const copies = (Array.isArray(layout.copies) ? layout.copies : [])
    .map(c => c.id + '=' + c.widget + '@' + (c.page || ''))
    .sort();
  const groups = Object.keys(layout.groups || {})
    .map(gid => {
      const g = layout.groups[gid] || {};
      return gid + '@' + (g.page || '') + ':' + ((g.members || []).slice().sort().join(','));
    })
    .sort();
  return JSON.stringify({ wids, copies, groups });
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
  commitWeatherChange();
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
  commitWeatherChange();
  syncWeatherSettingsControls();
  if (typeof startWeatherPolling === 'function') startWeatherPolling();
  setSettingsStatus('settings_weather_saved', 'ok');
}

// Change how many days the "next days" forecast shows (1–7). The server already
// returns up to 7 days, so this only re-renders — no re-fetch needed.
function updateWeatherForecastDays(value) {
  const days = Number(value);
  if (!WEATHER_FORECAST_DAY_CHOICES.includes(days)) return;
  // No-op when unchanged (also neutralizes the sync-triggered 'change' dispatch).
  if (normalizeWeatherSettings(hubSettings.weather).forecastDays === days) return;
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, forecastDays: days },
  });
  commitWeatherChange();
  syncWeatherSettingsControls();
  if (typeof renderWeatherTile === 'function') renderWeatherTile();
  if (typeof renderWeatherDetails === 'function') renderWeatherDetails();
  setSettingsStatus('settings_weather_saved', 'ok');
}

function updateWeatherTileSection(key, checked) {
  if (!WEATHER_TILE_SECTIONS.includes(key)) return;
  const tile = { ...normalizeWeatherTile(hubSettings.weather && hubSettings.weather.tile), [key]: !!checked };
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, tile },
  });
  commitWeatherChange();
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
  commitWeatherChange();
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
  commitWeatherChange();
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
  // The clock position + island editor personalise the MINIMAL island only, so
  // hide the whole block in Full mode — the full bar has no personalization.
  const personalize = document.getElementById('topbar-personalize');
  if (personalize) personalize.hidden = style !== 'minimal';
  syncTopbarRailsAutoHide();
}

// Reflect the "auto-hide edge rails" toggle (minimal mode only). Default on.
function syncTopbarRailsAutoHide() {
  const el = $('settings-rails-autohide');
  if (el) el.checked = hubSettings.topbarRailsAutoHide !== false;
}

// Toggle whether the minimal edge rails hide themselves after ~10s untouched.
function updateTopbarRailsAutoHide(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, topbarRailsAutoHide: checked === true });
  saveHubSettings();
  syncTopbarRailsAutoHide();
  if (window.TopbarMinimal) window.TopbarMinimal.apply();
  if (window.SdkIsland) window.SdkIsland.apply();
  setSettingsStatus('settings_saved', 'ok');
}

// Switch between the full glass topbar and the minimal chrome (edge rails +
// island pill). Re-applies the dashboard layout so the grid reclaims/returns
// the bar's row with a smooth transition.
function updateTopbarStyle(style) {
  if (!['full', 'minimal'].includes(style)) return;
  hubSettings = normalizeSettings({ ...hubSettings, topbarStyle: style });
  saveHubSettings();
  syncTopbarStyleControls();
  syncTopbarClockControls();
  if (window.TopbarMinimal) window.TopbarMinimal.apply();
  if (window.SdkIsland) window.SdkIsland.apply();
  applyTopbarClockSettings();
  if (typeof applyDashboardLayoutWithTransition === 'function') applyDashboardLayoutWithTransition();
  setSettingsStatus('settings_saved', 'ok');
}

// Minimal-island segment id → i18n label key (editor rows).
const TOPBAR_ISLAND_LABELS = { time: 'topbar_el_time', date: 'topbar_el_date', weather: 'topbar_el_weather', vitals: 'topbar_el_vitals', dots: 'topbar_el_dots', badges: 'topbar_el_badges' };
const EYE_OPEN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5C5 5 2 12 2 12s3 7 10 7 10-7 10-7-3-7-10-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.8 3.2 1.4 4.6l3.1 3.1A12.9 12.9 0 0 0 2 12s3 7 10 7a10.8 10.8 0 0 0 4.4-.9l3 3 1.4-1.4L2.8 3.2ZM12 16a4 4 0 0 1-3.9-4.9l1.7 1.7A2 2 0 0 0 12 14a2 2 0 0 0 .2 0l1.7 1.7A4 4 0 0 1 12 16Zm0-11c7 0 10 7 10 7a13 13 0 0 1-2.2 3.2l-2.9-2.9A4 4 0 0 0 12 8a4 4 0 0 0-.4 0L9.2 5.6A10.9 10.9 0 0 1 12 5Z"/></svg>';
const GRIP_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// Reflect the island anchor on its segmented control, gate the block to minimal
// mode, and (re)render the segment reorder/visibility list.
function syncTopbarClockControls() {
  const cfg = hubSettings.topbarClock || {};
  const align = ['center', 'left', 'right'].includes(cfg.align) ? cfg.align : 'center';
  document.querySelectorAll('.settings-topbar-align[data-topbar-align]').forEach(btn => {
    const active = btn.dataset.topbarAlign === align;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  renderTopbarIslandEditor();
}

// Build the island segment list: one row per item in display order, each with a
// drag handle (reorder) and an eye toggle (show/hide). Rebuilt on every change.
function renderTopbarIslandEditor() {
  const host = document.getElementById('topbar-island-editor');
  if (!host) return;
  const items = (hubSettings.topbarClock && Array.isArray(hubSettings.topbarClock.items))
    ? hubSettings.topbarClock.items : [];
  host.replaceChildren();
  items.forEach((it, index) => {
    const row = document.createElement('div');
    row.className = 'island-edit-row';
    row.dataset.islandIndex = String(index);

    const handle = document.createElement('span');
    handle.className = 'island-edit-handle';
    handle.title = t('topbar_el_reorder');
    handle.innerHTML = GRIP_SVG; // static, trusted markup

    const label = document.createElement('span');
    label.className = 'island-edit-label';
    label.textContent = t(TOPBAR_ISLAND_LABELS[it.id] || it.id);

    const hidden = it.hidden === true;
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'island-edit-eye';
    eye.classList.toggle('is-hidden', hidden);
    eye.setAttribute('aria-pressed', String(!hidden));
    eye.title = t(hidden ? 'topbar_el_show' : 'topbar_el_hide');
    eye.innerHTML = hidden ? EYE_OFF_SVG : EYE_OPEN_SVG; // static, trusted markup
    eye.addEventListener('click', () => toggleTopbarIslandItem(it.id));

    row.append(handle, label, eye);
    host.appendChild(row);
  });
  initTopbarIslandDrag(host);
}

// Pointer-based vertical reorder for the island editor, delegated once on the
// list host. touch-action:none on the grip (CSS) lets the drag own the gesture
// without the settings panel scrolling. Same tap-vs-drag shape as app favorites.
let _islandDragInit = false;
function initTopbarIslandDrag(host) {
  if (_islandDragInit) return;
  _islandDragInit = true;
  let row = null, fromIndex = -1, startY = 0, dragging = false;

  host.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.island-edit-handle');
    if (!handle) { row = null; return; }
    row = handle.closest('.island-edit-row');
    if (!row) return;
    fromIndex = Number(row.dataset.islandIndex);
    startY = e.clientY; dragging = false;
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  });

  host.addEventListener('pointermove', (e) => {
    if (!row) return;
    if (!dragging && Math.abs(e.clientY - startY) > 6) {
      dragging = true;
      row.classList.add('dragging');
      host.classList.add('reordering');
    }
  });

  const finish = (e, commit) => {
    if (!row) return;
    const r = row; row = null;
    r.classList.remove('dragging');
    host.classList.remove('reordering');
    if (!dragging || !commit) return;
    // Insertion index = how many other rows sit above the pointer's midpoint.
    let insert = 0;
    for (const s of host.querySelectorAll('.island-edit-row')) {
      if (s === r) continue;
      const rect = s.getBoundingClientRect();
      if (e.clientY > rect.top + rect.height / 2) insert++;
    }
    reorderTopbarIslandItem(fromIndex, insert);
  };

  host.addEventListener('pointerup', (e) => finish(e, true));
  host.addEventListener('pointercancel', (e) => finish(e, false));
}

// Move an island segment to a new position (minimal island order).
function reorderTopbarIslandItem(fromIndex, toIndex) {
  const items = (hubSettings.topbarClock && Array.isArray(hubSettings.topbarClock.items))
    ? hubSettings.topbarClock.items.slice() : [];
  if (fromIndex < 0 || fromIndex >= items.length) return;
  const [moved] = items.splice(fromIndex, 1);
  items.splice(Math.max(0, Math.min(items.length, toIndex)), 0, moved);
  _saveTopbarIslandItems(items);
}

// Show/hide a single island segment.
function toggleTopbarIslandItem(id) {
  const source = (hubSettings.topbarClock && Array.isArray(hubSettings.topbarClock.items))
    ? hubSettings.topbarClock.items : [];
  const items = source.map(it => ({ id: it.id, hidden: it.id === id ? it.hidden !== true : it.hidden === true }));
  _saveTopbarIslandItems(items);
}

function _saveTopbarIslandItems(items) {
  hubSettings = normalizeSettings({ ...hubSettings, topbarClock: { ...(hubSettings.topbarClock || {}), items } });
  saveHubSettings();
  syncTopbarClockControls();
  applyTopbarClockSettings();
  setSettingsStatus('settings_saved', 'ok');
}

// Push the island anchor + segment layout onto the live topbar. MINIMAL only —
// in Full mode there is no personalization, so the attribute is cleared and the
// bar renders its default centred cluster.
function applyTopbarClockSettings() {
  const cfg = hubSettings.topbarClock || {};
  const align = ['center', 'left', 'right'].includes(cfg.align) ? cfg.align : 'center';
  if (hubSettings.topbarStyle === 'minimal') {
    document.body.dataset.topbarAlign = align;
    if (window.TopbarMinimal) {
      if (window.TopbarMinimal.applyIslandLayout) window.TopbarMinimal.applyIslandLayout();
      // The island moved (align) or its width changed (reorder/hide) — re-tuck any
      // tile now sitting under the pill so headers stay clear on the current page.
      if (window.TopbarMinimal.reflowIsland) window.TopbarMinimal.reflowIsland();
    }
  } else {
    delete document.body.dataset.topbarAlign;
  }
}

// Anchor the minimal island left/centre/right. Display-only.
function updateTopbarAlign(align) {
  if (!['center', 'left', 'right'].includes(align)) return;
  hubSettings = normalizeSettings({ ...hubSettings, topbarClock: { ...(hubSettings.topbarClock || {}), align } });
  saveHubSettings();
  syncTopbarClockControls();
  applyTopbarClockSettings();
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
  // SDK widgets that render their own clock (e.g. the POW! Ambient scene) read
  // the resolved 12h/24h flag from the theme bridge — re-push it so they follow.
  if (window.CustomWidget && typeof window.CustomWidget.refreshTheme === 'function') window.CustomWidget.refreshTheme();
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
  commitWeatherChange();
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

// Paste raw SVG markup as the wallpaper (stored inline as a data: URI, rendered
// only as an <img> — safe). An alternative to uploading an image/video file.
async function pasteSettingsBackgroundSvg() {
  const uri = await openSvgPasteDialog();
  if (!uri) return;
  hubSettings = normalizeSettings({
    ...hubSettings,
    backgroundMedia: { url: uri, name: 'svg', type: 'image/svg+xml', version: String(Date.now()) },
  });
  saveHubSettings();
  applyHubSettings();
  renderSettingsModal();
  setSettingsStatus('settings_bg_uploaded', 'ok');
}

async function uploadSettingsFont(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  if (!isSupportedFontFile(file)) {
    input.value = '';
    setSettingsStatus('settings_font_unsupported', 'error');
    return;
  }
  if (file.size > SETTINGS_MAX_FONT_BYTES) {
    input.value = '';
    setSettingsStatus('settings_font_too_large', 'error');
    return;
  }

  const form = new FormData();
  form.append('font', file);
  setSettingsStatus('settings_font_uploading', '');

  try {
    const res = await fetch('/font', { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) throw new Error(data.error || res.statusText);
    hubSettings = normalizeSettings({
      ...hubSettings,
      uiFont: { url: data.url, name: data.name || file.name, version: String(Date.now()) },
    });
    saveHubSettings();
    applyHubSettings();
    renderSettingsModal();
    setSettingsStatus('settings_font_uploaded', 'ok');
  } catch {
    setSettingsStatus('settings_font_upload_failed', 'error');
  } finally {
    input.value = '';
  }
}

function clearSettingsFont() {
  hubSettings = normalizeSettings({ ...hubSettings, uiFont: null });
  saveHubSettings();
  applyHubSettings();
  renderSettingsModal();
  setSettingsStatus('settings_font_removed', 'ok');
}

// Footer "Ripristina tutte le impostazioni": a full reset of every preference to
// its default. Only the dashboard layout and the external calendar feed
// subscriptions are preserved (they're structural/personal, not "settings" the
// user is trying to reset). Server-only secrets (Gemini key, integration
// passwords/tokens) are preserved server-side on save, so they survive this too.
function resetAllSettings() {
  hubSettings = normalizeSettings({
    ...DEFAULT_HUB_SETTINGS,
    dashboardLayout: hubSettings.dashboardLayout,
    calendarFeeds: hubSettings.calendarFeeds,
  });
  saveHubSettings();
  applyHubSettings();
  if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
  renderSettingsModal();
  setSettingsStatus('settings_reset_all_done', 'ok');
}

// Aspetto "Ripristina default": resets ONLY the appearance/theme (the visual
// identity of the Aspetto tab — THEME_SETTING_KEYS is the single source of
// truth). Everything else — weather location, tickers, integrations, toggles,
// the uploaded background, topbar layout — is left untouched.
function resetAppearanceDefaults() {
  const patch = {};
  for (const key of THEME_SETTING_KEYS) patch[key] = DEFAULT_HUB_SETTINGS[key];
  hubSettings = normalizeSettings({ ...hubSettings, ...patch });
  saveHubSettings();
  applyHubSettings();
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
  const ambientToggle = $('settings-ai-voice-ambient');
  if (ambientToggle) ambientToggle.checked = hubSettings.aiVoiceAmbient === true;
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
  const wlEnabledInput = $('settings-wavelink-enabled');
  if (wlEnabledInput) wlEnabledInput.checked = !!(hubSettings.wavelink && hubSettings.wavelink.enabled === true);
  const chromaEnabledInput = $('settings-chroma-enabled');
  if (chromaEnabledInput) chromaEnabledInput.checked = !!(hubSettings.chroma && hubSettings.chroma.enabled === true);
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
  // Community widget / Ambient-scene packages the backup couldn't carry and that
  // aren't installed here — the user re-adds them from their gallery/share codes.
  const widgets = (Array.isArray(summary.needsWidgets) ? summary.needsWidgets : [])
    .map((w) => (w && typeof w === 'object') ? (w.name || w.id || '') : String(w || ''))
    .filter(Boolean);
  let meta = '';
  if (needs.length) meta = `${tt('settings_backup_needs_setup', 'Da ricollegare:')} ${needs.join(', ')}`;
  if (widgets.length) meta += `${meta ? ' — ' : ''}${tt('settings_backup_needs_widgets', 'Widget da reinstallare dai loro codici:')} ${widgets.join(', ')}`;
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
        needsWidgets: Array.isArray(out.needsWidgets) ? out.needsWidgets : [],
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

// Show only the config rows that belong to the selected provider: the local
// panel for Ollama, the Gemini key row for Gemini, and the ChatGPT/Claude
// key+model panels for those. Shared by the initial sync and the radio handler.
function _reflectAiProviderRows(provider) {
  const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
  show('ai-local-panel', provider === 'ollama');
  show('settings-gemini-key-row', provider === 'gemini');
  show('settings-openai-panel', provider === 'openai');
  show('settings-anthropic-panel', provider === 'anthropic');
}

// Reflect the persisted provider settings into the AI controls. Safe to call
// repeatedly (it only reads hubSettings and writes control state).
function syncAiProviderControls() {
  const panel = $('ai-local-panel');
  const modelSel = $('ai-model-select');
  if (!panel || !modelSel) return;

  const cfg = hubSettings || {};
  const provider = ['ollama', 'openai', 'anthropic'].includes(cfg.aiProvider) ? cfg.aiProvider : 'gemini';
  document.querySelectorAll('input[name="aiProvider"]').forEach((r) => {
    r.checked = (r.value === provider);
  });
  _reflectAiProviderRows(provider);

  // ChatGPT / Claude: fill the model dropdown live from the provider (only for
  // the active one), and show a "saved" placeholder for the key (which is
  // server-only, so the field itself always renders empty).
  const savedPh = t('settings_key_saved');
  const oKey = $('settings-openai-key'); if (oKey) { oKey.value = ''; oKey.placeholder = cfg.openaiApiKeySet ? savedPh : 'sk-…'; }
  const aKey = $('settings-anthropic-key'); if (aKey) { aKey.value = ''; aKey.placeholder = cfg.anthropicApiKeySet ? savedPh : 'sk-ant-…'; }
  const oReset = $('settings-openai-reset'); if (oReset) oReset.hidden = !cfg.openaiApiKeySet;
  const aReset = $('settings-anthropic-reset'); if (aReset) aReset.hidden = !cfg.anthropicApiKeySet;
  if (provider === 'openai') _aiLoadProviderModels('openai');
  else if (provider === 'anthropic') _aiLoadProviderModels('anthropic');

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
    aiProvider: (checked && ['ollama', 'openai', 'anthropic'].includes(checked.value)) ? checked.value : 'gemini',
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
          if (p.error) {
            // Safety refusal or pull failure: show the real reason and stop —
            // never leave the bar sitting at 100% as if the model had installed.
            label.textContent = '⚠ ' + String(p.error);
            bar.style.width = '0%';
            aiLocalRefreshStatus();
            continue;
          }
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
      if (!r.checked) return;
      _reflectAiProviderRows(r.value);
      persistAiProviderSettings();
      if (r.value === 'ollama') { await aiLocalScan(); await aiLocalRefreshStatus(); await aiLocalSyncAutostart(); }
      else if (r.value === 'openai' || r.value === 'anthropic') _aiLoadProviderModels(r.value);
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

// ChatGPT (OpenAI) + Claude (Anthropic) key/model handlers. The keys are
// server-only: we send them on save (preserved server-side), and keep the *Set
// flag true so the ready-gate and the "saved" placeholder stay correct even
// after the server redacts the value back to '' on the next hydrate.
function updateOpenaiKey(value) {
  const v = String(value || '').trim().slice(0, 200);
  hubSettings = normalizeSettings({ ...hubSettings, openaiApiKey: v, openaiApiKeySet: v.length > 0 || hubSettings.openaiApiKeySet === true });
  saveHubSettings();
  if (typeof updateMediaChatKeyState === 'function') updateMediaChatKeyState();
  if (v.length > 8) _aiScheduleModelRefresh('openai'); // a real key was entered → refresh the model list once it's saved
}
function updateOpenaiModel(value) {
  hubSettings = normalizeSettings({ ...hubSettings, openaiModel: String(value || '').trim().slice(0, 60) || 'gpt-4o' });
  saveHubSettings();
}
function updateAnthropicKey(value) {
  const v = String(value || '').trim().slice(0, 200);
  hubSettings = normalizeSettings({ ...hubSettings, anthropicApiKey: v, anthropicApiKeySet: v.length > 0 || hubSettings.anthropicApiKeySet === true });
  saveHubSettings();
  if (typeof updateMediaChatKeyState === 'function') updateMediaChatKeyState();
  if (v.length > 8) _aiScheduleModelRefresh('anthropic'); // a real key was entered → refresh the model list once it's saved
}
function updateAnthropicModel(value) {
  hubSettings = normalizeSettings({ ...hubSettings, anthropicModel: String(value || '').trim().slice(0, 60) || 'claude-sonnet-5' });
  saveHubSettings();
}

// ── ChatGPT / Claude model pickers ──────────────────────────────────────────
// The dropdowns are filled LIVE from each provider's own models API (via
// /api/ai/models), so they always reflect the newest models the provider offers
// — no hardcoded list to keep current. A "Custom…" entry stays as a fallback for
// a model not in the list (or when offline), and the saved model is always kept
// selectable even if the API doesn't return it.
function _aiPopulateModelSelect(selId, custId, models, saved) {
  const sel = $(selId), cust = $(custId);
  if (!sel) return;
  const list = Array.isArray(models) ? models : [];
  sel.innerHTML = '';
  if (saved && !list.some((m) => m && m.id === saved)) {
    const o = document.createElement('option'); o.value = saved; o.textContent = saved; sel.appendChild(o);
  }
  for (const m of list) {
    if (!m || !m.id) continue;
    const o = document.createElement('option'); o.value = m.id; o.textContent = m.label || m.id; sel.appendChild(o);
  }
  const co = document.createElement('option'); co.value = '__custom__'; co.textContent = t('ai_model_custom'); sel.appendChild(co);
  sel.value = saved || (list[0] && list[0].id) || '';
  if (cust) cust.hidden = true;
}

async function _aiLoadProviderModels(provider) {
  const isO = provider === 'openai';
  const selId = isO ? 'settings-openai-model' : 'settings-anthropic-model';
  const custId = selId + '-custom';
  const saved = isO ? (hubSettings.openaiModel || 'gpt-4o') : (hubSettings.anthropicModel || 'claude-sonnet-5');
  if (!$(selId)) return;
  // Show the saved value immediately, then enrich from the API in the background.
  _aiPopulateModelSelect(selId, custId, [], saved);
  const keySet = isO ? hubSettings.openaiApiKeySet : hubSettings.anthropicApiKeySet;
  if (!keySet) return; // no key yet → nothing to fetch
  try {
    const r = await fetch('/api/ai/models?provider=' + provider);
    const d = await r.json();
    if (d && Array.isArray(d.models) && d.models.length) _aiPopulateModelSelect(selId, custId, d.models, saved);
  } catch { /* offline — keep the saved-only list */ }
}

// After a key is entered, the /api/ai/models endpoint reads it from the SERVER
// settings, which the 250ms-debounced save hasn't flushed yet — and typing fires
// per keystroke. Debounce past the save window so the list enriches once, with
// the key actually persisted.
let _aiModelRefreshTimer = null;
function _aiScheduleModelRefresh(provider) {
  if (_aiModelRefreshTimer) clearTimeout(_aiModelRefreshTimer);
  _aiModelRefreshTimer = setTimeout(() => { _aiModelRefreshTimer = null; _aiLoadProviderModels(provider); }, 700);
}

function onOpenaiModelSelect(v) {
  const cust = $('settings-openai-model-custom');
  if (v === '__custom__') { if (cust) { cust.hidden = false; cust.value = ''; cust.focus(); } return; }
  if (cust) cust.hidden = true;
  updateOpenaiModel(v);
}
function onAnthropicModelSelect(v) {
  const cust = $('settings-anthropic-model-custom');
  if (v === '__custom__') { if (cust) { cust.hidden = false; cust.value = ''; cust.focus(); } return; }
  if (cust) cust.hidden = true;
  updateAnthropicModel(v);
}

// Remove a saved OpenAI/Anthropic key. Sends key='' with *Set=false, which the
// server honours as an explicit clear (preserveAiProviderCreds skips preserving
// when *Set is false), so the key is actually removed rather than kept.
function resetOpenaiKey() {
  hubSettings = normalizeSettings({ ...hubSettings, openaiApiKey: '', openaiApiKeySet: false });
  saveHubSettings();
  syncAiProviderControls();
  if (typeof updateMediaChatKeyState === 'function') updateMediaChatKeyState();
}
function resetAnthropicKey() {
  hubSettings = normalizeSettings({ ...hubSettings, anthropicApiKey: '', anthropicApiKeySet: false });
  saveHubSettings();
  syncAiProviderControls();
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
    await flushHubSettingsToServer().catch(() => {});
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
        await flushHubSettingsToServer().catch(() => {});
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

// ── Local hardware SDKs: Elgato Wave Link + Razer Chroma (opt-in, no secrets) ──
function updateWavelinkEnabled(checked) {
  const cur = (hubSettings && hubSettings.wavelink) || {};
  hubSettings = normalizeSettings({ ...hubSettings, wavelink: { ...cur, enabled: checked === true } });
  saveHubSettings();
}
function updateChromaEnabled(checked) {
  const cur = (hubSettings && hubSettings.chroma) || {};
  hubSettings = normalizeSettings({ ...hubSettings, chroma: { ...cur, enabled: checked === true } });
  saveHubSettings();
}

// Probe the local Wave Link WebSocket and report the channel count (or failure).
// Flushes the pending save first so the server connects with the enable flag the
// user just toggled.
async function testWavelinkConnection(btn) {
  const out = document.getElementById('settings-wl-status');
  const setStatus = (cls, msg) => { if (out) { out.className = 'settings-note ' + cls; out.textContent = msg; } };
  if (btn) btn.disabled = true;
  setStatus('is-busy', t('settings_wl_testing', 'Testing…'));
  try {
    await flushHubSettingsToServer().catch(() => {});
    const r = await fetch('/api/wavelink/test', { method: 'POST' }).then((res) => res.json()).catch(() => null);
    if (r && r.ok) setStatus('is-ok', t('settings_wl_ok', 'Connected') + ' — ' + (r.count || 0) + ' ' + t('settings_wl_channels', 'channels'));
    else setStatus('is-err', t('settings_wl_fail', 'Could not reach Wave Link — is the app running?'));
  } catch (e) {
    setStatus('is-err', t('settings_wl_fail', 'Could not reach Wave Link — is the app running?'));
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Probe the local Razer Chroma SDK (init + immediate release). Independent of the
// enable flag so the user can verify Synapse before turning the integration on.
async function testChromaConnection(btn) {
  const out = document.getElementById('settings-chroma-status');
  const setStatus = (cls, msg) => { if (out) { out.className = 'settings-note ' + cls; out.textContent = msg; } };
  if (btn) btn.disabled = true;
  setStatus('is-busy', t('settings_chroma_testing', 'Testing…'));
  try {
    const r = await fetch('/api/chroma/test', { method: 'POST' }).then((res) => res.json()).catch(() => null);
    if (r && r.ok) setStatus('is-ok', t('settings_chroma_ok', 'Razer Chroma connected'));
    else setStatus('is-err', t('settings_chroma_fail', 'Could not reach Razer Chroma — is Synapse running?'));
  } catch (e) {
    setStatus('is-err', t('settings_chroma_fail', 'Could not reach Razer Chroma — is Synapse running?'));
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

function updateAiVoiceAmbient(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, aiVoiceAmbient: !!enabled });
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
