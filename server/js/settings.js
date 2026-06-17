'use strict';

const SETTINGS_STORAGE_KEY = 'xeneonedge.settings.v1';
const SETTINGS_MAX_BACKGROUND_BYTES = 200 * 1024 * 1024;
const SETTINGS_MIN_PANEL_ALPHA = 0.18;
const SETTINGS_BACKGROUND_TYPES = Object.freeze(new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm',
]));
const SETTINGS_BACKGROUND_EXTENSIONS = Object.freeze(new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm']));

const DASHBOARD_WIDGET_IDS = Object.freeze(['media', 'agenda', 'mic', 'audio', 'system', 'notes', 'tasks', 'calendar', 'timer', 'chat', 'deck', 'remote', 'twitch', 'obs', 'youtube', 'browser', 'secondscreen']);
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
const DASHBOARD_GRID_COLUMNS = 12;     // GridStack column count
const DASHBOARD_GRID_MAX_ROW = 200;    // generous clamp for y/h
// Bump when the default dashboard layout changes in a way that should override
// users' saved layouts on upgrade. v5 = copies (duplicated widget placements).
const DASHBOARD_LAYOUT_VERSION = 6;
const DEFAULT_DASHBOARD_LAYOUT = Object.freeze({
  widgets: Object.freeze({
    media:    Object.freeze({ x: 0, y: 0, w: 4, h: 4, visible: true,  page: 'dashboard' }),
    agenda:   Object.freeze({ x: 4, y: 0, w: 4, h: 4, visible: true,  page: 'dashboard' }),
    system:   Object.freeze({ x: 8, y: 0, w: 4, h: 4, visible: true,  page: 'dashboard' }),
    mic:      Object.freeze({ x: 0, y: 4, w: 3, h: 2, visible: false, page: 'dashboard' }),
    audio:    Object.freeze({ x: 3, y: 4, w: 3, h: 2, visible: false, page: 'dashboard' }),
    notes:    Object.freeze({ x: 6, y: 4, w: 3, h: 2, visible: false, page: 'dashboard' }),
    tasks:    Object.freeze({ x: 9, y: 4, w: 3, h: 2, visible: false, page: 'dashboard' }),
    calendar: Object.freeze({ x: 0, y: 6, w: 3, h: 2, visible: false, page: 'dashboard' }),
    timer:    Object.freeze({ x: 3, y: 6, w: 3, h: 2, visible: false, page: 'dashboard' }),
    chat:     Object.freeze({ x: 4, y: 0, w: 4, h: 4, visible: true,  page: 'dashboard' }),
    deck:     Object.freeze({ x: 0, y: 6, w: 4, h: 3, visible: false, page: 'dashboard' }),
    remote:   Object.freeze({ x: 4, y: 6, w: 4, h: 3, visible: false, page: 'dashboard' }),
    twitch:   Object.freeze({ x: 8, y: 6, w: 4, h: 2, visible: false, page: 'dashboard' }),
    obs:      Object.freeze({ x: 8, y: 8, w: 4, h: 3, visible: false, page: 'dashboard' }),
    youtube:  Object.freeze({ x: 8, y: 11, w: 4, h: 2, visible: false, page: 'dashboard' }),
    browser:  Object.freeze({ x: 0, y: 9, w: 6, h: 5, visible: false, page: 'dashboard' }),
    secondscreen: Object.freeze({ x: 6, y: 9, w: 6, h: 5, visible: false, page: 'dashboard' }),
  }),
  groups: Object.freeze({
    'media-group': Object.freeze({ id: 'media-group', members: Object.freeze(['media', 'chat']), active: 'media', x: 0, y: 0, w: 4, h: 4, page: 'dashboard', seeded: true, autoTabByMedia: true }),
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

const DEFAULT_HUB_SETTINGS = Object.freeze({
  appearance: 'dark', // 'light' | 'dark' | 'auto' (auto follows the OS colour scheme)
  accent: '#1ed760',
  dynamicAlbumTheme: true, // tint the accent from the now-playing album art
  background: '#070808',
  text: '#f0f3f1',
  panelAlpha: 0.94,
  bgDim: 0.48,
  bgBlur: 0,
  backgroundMedia: null,
  lockWidgets: Object.freeze({ clock: true, weather: true, media: true, calendar: true }),
  weather: Object.freeze({ mode: 'auto', city: '' }),
  tempUnit: 'c', // 'c' | 'f' — weather temperature display unit
  // Open the dashboard in the default browser at Windows logon (default on).
  // Only reconciled into a real scheduled task from a standalone browser view —
  // never from inside the Xeneon Edge iframe (see reconcileAutoOpenBrowser).
  autoOpenBrowser: true,
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
  }),
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
      timer:        Object.freeze({ enabled: false, color: '#ff0000', style: 'blink' }),
      notification: Object.freeze({ enabled: false, color: '#ff0000', style: 'blink' }),
      reminder:     Object.freeze({ enabled: false, color: '#ff0000', style: 'blink' }),
    }),
    animation: Object.freeze({ style: 'none', color: '#1ed760', speed: 50 }),
    manualColor: '',
    providers: Object.freeze({}),
    deviceModes: Object.freeze({}),
  }),
  obsHost: '',
  obsAutoLaunch: true,
  obsPort: 4455,
  obsPassword: '',
  streamerbotHost: '',
  streamerbotPort: 8080,
  streamerbotPassword: '',
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

function normalizeWeatherSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = source.mode === 'manual' ? 'manual' : DEFAULT_HUB_SETTINGS.weather.mode;
  return {
    mode,
    city: sanitizeWeatherCity(source.city),
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
      w: Math.max(1, Math.round(Number(g.w)) || 4),
      h: Math.max(1, Math.round(Number(g.h)) || 4),
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

function normalizeDashboardLayout(value) {
  const source = value && typeof value === 'object' ? value : {};
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
  return layout;
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
    aiFeatures: normalizeAiFeatures(value.aiFeatures),
    bgAurora: normalizeBgAurora(value.bgAurora),
    bgGrid: normalizeBgGrid(value.bgGrid),
    gameMode: value.gameMode !== false,
    performance: normalizePerformance(value.performance),
    lighting: normalizeLighting(value.lighting),
    calendarFeeds: Array.isArray(value.calendarFeeds) ? value.calendarFeeds : [],
    browserTiles: normalizeBrowserTiles(value.browserTiles),
    secondScreen: normalizeSecondScreen(value.secondScreen),
    obsHost: String(value.obsHost || '').trim().slice(0, 200),
    obsAutoLaunch: typeof value.obsAutoLaunch === 'boolean' ? value.obsAutoLaunch : true,
    obsPort: Math.max(1, Math.min(65535, parseInt(value.obsPort, 10) || 4455)),
    obsPassword: String(value.obsPassword || '').slice(0, 200),
    streamerbotHost: String(value.streamerbotHost || '').trim().slice(0, 200),
    streamerbotPort: Math.max(1, Math.min(65535, parseInt(value.streamerbotPort, 10) || 8080)),
    streamerbotPassword: String(value.streamerbotPassword || '').slice(0, 200),
    // Monotonic save revision: bumped on every real (server-bound) save so the
    // boot-time merge can tell which copy is newer and a stale server copy can
    // never clobber a more recent local one (see hydrateHubSettingsFromServer).
    rev: Number.isFinite(value.rev) && value.rev > 0 ? Math.floor(value.rev) : 0,
    onboarding: normalizeOnboarding(value.onboarding),
    language: SUPPORTED_LANGS.includes(value.language) ? value.language : '',
  };
}

// Per-instance saved URL for each Browser widget tile, keyed by its instance id
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
    const url = String(entry.url || '').slice(0, 2048);
    if (!url) continue;
    out[key] = { url };
    n++;
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
function normalizeAiFeatures(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    enabled: v.enabled === true,
    genesis: v.genesis === true,
    gameCompanion: v.gameCompanion === true,
    guardian: v.guardian === true,
    ambient: v.ambient === true,
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
  const f = fallback || { enabled: true, color: '#ff0000', style: 'blink' };
  if (typeof value === 'boolean') return { enabled: value, color: f.color, style: f.style };
  const v = value && typeof value === 'object' ? value : {};
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : f.enabled,
    color: normalizeHex(v.color, f.color),
    style: LIGHTING_STYLES.includes(v.style) ? v.style : f.style,
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
        style: ['solid', 'breathing', 'cycle'].includes(v.anim.style) ? v.anim.style : 'cycle',
        color: /^#[0-9a-f]{6}$/i.test(String(v.anim.color)) ? v.anim.color : '#1ed760',
        speed: clampNumber(v.anim.speed, 1, 100, 50),
      };
    }
    out[String(id)] = e;
  }
  return out;
}

// Note: array inlined (not a module-level const) because normalizeLighting runs
// during the top-level hubSettings init, before a later const would initialise (TDZ).
function normalizeLightingAnimation(value, fallback) {
  const f = fallback || { style: 'none', color: '#1ed760', speed: 50 };
  const v = value && typeof value === 'object' ? value : {};
  const hex = /^#[0-9a-f]{6}$/i.test(String(v.color)) ? v.color : f.color;
  return {
    style: ['none', 'solid', 'breathing', 'cycle'].includes(v.style) ? v.style : f.style,
    color: hex,
    speed: clampNumber(v.speed, 1, 100, f.speed),
  };
}
// Mirror the server provider shape so a full-settings save round-trips the
// discovered devices instead of wiping them.
function normalizeLightingProviders(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const id of ['wled', 'openrgb', 'hue', 'nanoleaf']) {
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
  '--shadow-md': '0 6px 18px rgba(20,30,40,0.10)',
  '--shadow-lg': '0 14px 36px rgba(20,30,40,0.12)',
  '--shadow-xl': '0 24px 60px rgba(20,30,40,0.16)',
});

// Windows app theme read from the server registry (reliable). null until the
// first /system/theme response; we then fall back to prefers-color-scheme.
let _osPrefersDark = null;

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
  fetch('/system/theme')
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      if (!data || typeof data.osDark !== 'boolean') return;
      const changed = _osPrefersDark !== data.osDark;
      _osPrefersDark = data.osDark;
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
  const root = document.documentElement;
  const panelSoftAlpha = Math.max(0.14, Math.min(1, hubSettings.panelAlpha - 0.02));
  const panelBorderAlpha = Math.min(0.18, 0.045 + (hubSettings.panelAlpha * 0.08));
  const panelShadowAlpha = Math.min(0.30, 0.05 + (hubSettings.panelAlpha * 0.18));
  const panelHighlightAlpha = Math.min(0.07, 0.012 + (hubSettings.panelAlpha * 0.04));
  const bgSafeDim = Math.max(hubSettings.bgDim, 0.18);
  const bgSafeDimStrong = Math.min(0.9, bgSafeDim + 0.11);
  const bgBlur = Math.round(hubSettings.bgBlur);
  const bgScale = bgBlur > 0 ? Math.min(1.06, 1 + (bgBlur / 600)) : 1;

  const light = resolveAppearance(hubSettings.appearance) === 'light';
  root.dataset.appearance = light ? 'light' : 'dark';

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

  document.body.classList.toggle('grid-on', grid.enabled);
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
  syncLockWidgetSettings();
  syncAutoOpenBrowserControl();
  syncWeatherSettingsControls();
  syncAiSettingsControls();
  syncBgFxControls();
  syncGameModeControls();
  syncPerformanceControls();
  syncSecondScreenControls();
  syncDynamicAlbumControls();
  refreshGameModeStatus();
  // The whole RGB hub renders dynamically into Settings → Illuminazione.
  if (window.LightingPage) window.LightingPage.init();
  // Remote Control wizard renders dynamically into Settings → Controllo Remoto.
  if (window.RemoteControl) window.RemoteControl.init();
  // Streaming (Twitch) connect panel renders into Settings → Streaming.
  if (window.StreamingPage) window.StreamingPage.init();
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
  document.querySelectorAll('.settings-lang-btn[data-lang]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
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

function toggleSettings() {
  const overlay = $('settings-overlay');
  if (!overlay) return;
  overlay.hidden = !overlay.hidden;
  if (!overlay.hidden) { renderSettingsModal(); settingsSetCategory(_settingsCat); }
}

function closeSettings() {
  const overlay = $('settings-overlay');
  if (overlay) overlay.hidden = true;
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

function _evalGameModeClass() {
  document.body.classList.toggle('game-mode', _gamingActive && hubSettings.gameMode !== false);
}

// Called from the SSE 'status' handler with the live gaming flag.
function applyGameMode(gaming) {
  _gamingActive = !!gaming;
  _evalGameModeClass();
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
}

function queueWeatherSettingsRefresh(delay = 0) {
  clearTimeout(weatherSettingsFetchTimer);
  weatherSettingsFetchTimer = setTimeout(() => {
    weatherSettingsFetchTimer = null;
    if (typeof fetchWeather === 'function') fetchWeather();
  }, delay);
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
  if (obsPassInput) obsPassInput.value = hubSettings.obsPassword || '';
  const obsAutoInput = $('settings-obs-autolaunch');
  if (obsAutoInput) obsAutoInput.checked = hubSettings.obsAutoLaunch !== false;
  const sbHostInput = $('settings-sb-host');
  if (sbHostInput) sbHostInput.value = hubSettings.streamerbotHost || '';
  const sbPortInput = $('settings-sb-port');
  if (sbPortInput) sbPortInput.value = hubSettings.streamerbotPort || 8080;
  const sbPassInput = $('settings-sb-password');
  if (sbPassInput) sbPassInput.value = hubSettings.streamerbotPassword || '';
  // Bind the local-provider section once, then refresh its values on every render.
  initAiProviderSettings();
  syncAiProviderControls();
  syncAiFeaturesControls();
}

// Reflect the advanced AI feature toggles (master + per-feature) in Settings.
// The per-feature rows are visually disabled while the master switch is off so
// the opt-in chain (master → feature) is obvious at a glance.
function syncAiFeaturesControls() {
  const f = normalizeAiFeatures(hubSettings.aiFeatures);
  const master = $('settings-aifeat-master');
  if (master) master.checked = f.enabled;
  ['genesis', 'gameCompanion', 'guardian', 'ambient'].forEach(key => {
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
    catch (e2) { backupToast('settings_backup_error'); }
  } finally {
    if (btn) btn.disabled = false;
  }
}

function importBackupPick() {
  const f = document.getElementById('settings-backup-file');
  if (f) { f.value = ''; f.click(); }
}

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
    if (!out || out.ok !== true) throw new Error((out && out.error) || 'import_failed');
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
        try {
          const p = JSON.parse(line);
          if (p.error) {
            // Surface the real reason instead of leaving the bar mid-way forever.
            label.textContent = '⚠ ' + String(p.error);
            aiLocalRefreshStatus();
          } else {
            if (typeof p.percent === 'number') bar.style.width = Math.max(0, Math.min(100, p.percent)) + '%';
            if (p.status) label.textContent = String(p.status);
            if (p.done) { bar.style.width = '100%'; aiLocalRefreshStatus(); }
          }
        } catch { /* skip malformed progress line */ }
      }
    }
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

function updateAiMicSensitivity(value) {
  const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  hubSettings = normalizeSettings({ ...hubSettings, aiMicSensitivity: v });
  saveHubSettings();
  const out = $('settings-ai-sens-val');
  if (out) out.textContent = String(v);
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
  btnLabel.textContent = t('external_calendars');
  btn.appendChild(btnLabel);
  // Append to the scrollable list so the support/version footer stays pinned.
  const navScroll = document.getElementById('settings-nav-scroll') || nav;
  navScroll.appendChild(btn);

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
