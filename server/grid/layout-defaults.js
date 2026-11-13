// The dashboard a new install starts with, and the ids, sizes and grid limits a saved layout is
// checked against.

const DASHBOARD_WIDGET_IDS = Object.freeze(['media', 'agenda', 'mic', 'audio', 'system', 'notes', 'tasks', 'calendar', 'timer', 'chat', 'deck', 'remote', 'twitch', 'twitchwatch', 'obs', 'youtube', 'youtubelive', 'discord', 'spotify', 'browser', 'secondscreen', 'weather', 'smarthome', 'streamerbot', 'wavelink', 'lighting', 'notifications', 'stocks', 'football', 'news', 'claude', 'openaicodex', 'chatgpt', 'vitals', 'unifi', 'slideshow', 'fans', 'power', 'battery', 'search', 'disk', 'devclean', 'lyrics', 'transfer', 'phone', 'perf', 'screen', 'custom']);
const DASHBOARD_TAB_IDS = Object.freeze(['main', 'net']);
const CALENDAR_TAB_IDS = Object.freeze(['calendar', 'tasks', 'timer']);
const MEDIA_VIEW_IDS = Object.freeze(['media', 'calendar']);
const DASHBOARD_CARD_IDS = Object.freeze({
  main: ['cpu', 'gpu', 'ram', 'disk'],
  net: ['ping', 'fps', 'latency', 'bandwidth'],
  audio: ['volume', 'speaker', 'microphone'],
  twitch: ['info', 'actions', 'chat'],
  twitchwatch: ['player', 'library', 'chat'],
  obs: ['preview', 'controls', 'scenes', 'audio'],
  youtube: ['player', 'library'],
  youtubelive: ['info', 'actions', 'chat'],
});
const DASHBOARD_CARD_SIZES = Object.freeze(['compact', 'normal', 'wide']);
// 24 columns (with half-height rows) = fine-grained, near-free tile placement.
// Layouts saved on the old 12-column grid are scaled ×2 once — keyed on
// layout.gridCols, see scaleDashboardLayoutUnits — so nothing moves on upgrade.
const DASHBOARD_GRID_COLUMNS = 24;     // GridStack column count
const DASHBOARD_GRID_MAX_ROW = 400;    // generous clamp for y/h
// Bump when the default dashboard layout changes in a way that should override
// users' saved layouts on upgrade. v5 = copies (multi-instance widgets).
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
    // Taller than the other stream tiles on purpose: this one holds a 16:9 video
    // player above its list, and at h:4 the player had no room to be a player.
    youtube:  Object.freeze({ x: 16, y: 22, w: 8, h: 10, visible: false, page: 'dashboard' }),
    twitchwatch: Object.freeze({ x: 0, y: 64, w: 8, h: 10, visible: false, page: 'dashboard' }),
    youtubelive: Object.freeze({ x: 16, y: 32, w: 8, h: 10, visible: false, page: 'dashboard' }),
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
    openaicodex: Object.freeze({ x: 16, y: 38, w: 8, h: 10, visible: false, page: 'dashboard' }),
    chatgpt:  Object.freeze({ x: 16, y: 48, w: 8, h: 12, visible: false, page: 'dashboard' }),
    vitals:   Object.freeze({ x: 8, y: 38, w: 8, h: 8, visible: false, page: 'dashboard' }),
    unifi:    Object.freeze({ x: 8, y: 18, w: 8, h: 8, visible: false, page: 'dashboard' }),
    slideshow: Object.freeze({ x: 0, y: 48, w: 8, h: 8, visible: false, page: 'dashboard' }),
    fans:     Object.freeze({ x: 16, y: 38, w: 8, h: 8, visible: false, page: 'dashboard' }),
    power:    Object.freeze({ x: 16, y: 46, w: 8, h: 8, visible: false, page: 'dashboard' }),
    battery:  Object.freeze({ x: 0, y: 56, w: 8, h: 8, visible: false, page: 'dashboard' }),
    perf:     Object.freeze({ x: 8, y: 74, w: 8, h: 10, visible: false, page: 'dashboard' }),
    search:   Object.freeze({ x: 8, y: 56, w: 8, h: 8, visible: false, page: 'dashboard' }),
    disk:     Object.freeze({ x: 16, y: 54, w: 8, h: 10, visible: false, page: 'dashboard' }),
    devclean: Object.freeze({ x: 0, y: 64, w: 8, h: 10, visible: false, page: 'dashboard' }),
    lyrics: Object.freeze({ x: 8, y: 64, w: 6, h: 10, visible: false, page: 'dashboard' }),
    transfer: Object.freeze({ x: 8, y: 64, w: 8, h: 10, visible: false, page: 'dashboard' }),
    // Tall rather than wide: it is a list of people, and the keypad wants the
    // height. Hidden until the user adds it, like every opt-in widget.
    phone: Object.freeze({ x: 16, y: 64, w: 8, h: 12, visible: false, page: 'dashboard' }),
    // The Xenon menu on the main screen, from the dashboard (js/screen-tile.js).
    screen:   Object.freeze({ x: 16, y: 76, w: 8, h: 12, visible: false, page: 'dashboard' }),
    custom:   Object.freeze({ x: 0, y: 28, w: 8, h: 8, visible: false, page: 'dashboard' }),
  }),
  groups: Object.freeze({
    'media-group': Object.freeze({ id: 'media-group', members: Object.freeze(['media', 'agenda']), active: 'media', x: 0, y: 0, w: 8, h: 8, page: 'dashboard', seeded: true, autoTabByMedia: true }),
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
    // Every id in DASHBOARD_CARD_IDS.youtube needs an entry here, and not as a
    // cosmetic default: normalizeDashboardLayout iterates that ID list and reads
    // the default for each one, so a missing entry threw on EVERY settings
    // normalization. See the test that pins the two together.
    youtube: Object.freeze({
      player: Object.freeze({ order: 0, size: 'normal', visible: true }),
      library: Object.freeze({ order: 1, size: 'normal', visible: true }),
    }),
    youtubelive: Object.freeze({
      info: Object.freeze({ order: 0, size: 'normal', visible: true }),
      actions: Object.freeze({ order: 1, size: 'normal', visible: true }),
      chat: Object.freeze({ order: 2, size: 'normal', visible: true }),
    }),
    // Twitch chat starts hidden: it is a second embedded page from Twitch, and a
    // tile that only ever watches does not need it. The card control turns it on.
    twitchwatch: Object.freeze({
      player: Object.freeze({ order: 0, size: 'normal', visible: true }),
      library: Object.freeze({ order: 1, size: 'normal', visible: true }),
      chat: Object.freeze({ order: 2, size: 'normal', visible: false }),
    }),
  }),
  tabs: Object.freeze({ order: ['main', 'net'], active: 'main' }),
  calendarTabs: Object.freeze({ order: ['calendar', 'tasks', 'timer'], active: 'calendar' }),
  mediaView: Object.freeze({ active: 'media' }),
  topbarHidden: false,
  // Mirrors js/settings.js — the Timer widget's add row folded to a strip. A
  // field missing from THIS copy is silently dropped on save, so the flag would
  // never survive a reload.
  timerAddCollapsed: false,
  // The vertical layout (js/dashboard-portrait.js): generated until arranged.
  portrait: Object.freeze({ custom: false, items: Object.freeze({}) }),
});

module.exports = {
  DASHBOARD_WIDGET_IDS, DASHBOARD_TAB_IDS, CALENDAR_TAB_IDS, MEDIA_VIEW_IDS, DASHBOARD_CARD_IDS,
  DASHBOARD_CARD_SIZES, DASHBOARD_GRID_COLUMNS, DASHBOARD_GRID_MAX_ROW, DASHBOARD_LAYOUT_VERSION,
  DEFAULT_DASHBOARD_LAYOUT,
};
