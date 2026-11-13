// The dashboard layout a new install starts with, the built-in color presets and the keys that make
// up a theme.
'use strict';

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
    // Mirrors the server's entry, key for key: normalizeDashboardLayout runs on
    // both sides and reads a default per id, so an id present on one side only
    // is a crash on the other.
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
    // Mirror of the server default. Every id in DASHBOARD_CARD_IDS.youtube above
    // needs an entry: normalizeDashboardLayout reads a default for every id in
    // that list, so a missing one threw here on EVERY settings normalization,
    // which is the first thing the page does with hub settings. See the test.
    youtube: Object.freeze({
      player: Object.freeze({ order: 0, size: 'normal', visible: true }),
      library: Object.freeze({ order: 1, size: 'normal', visible: true }),
    }),
    youtubelive: Object.freeze({
      info: Object.freeze({ order: 0, size: 'normal', visible: true }),
      actions: Object.freeze({ order: 1, size: 'normal', visible: true }),
      chat: Object.freeze({ order: 2, size: 'normal', visible: true }),
    }),
    // Mirror of the server default: the chat card starts hidden.
    twitchwatch: Object.freeze({
      player: Object.freeze({ order: 0, size: 'normal', visible: true }),
      library: Object.freeze({ order: 1, size: 'normal', visible: true }),
      chat: Object.freeze({ order: 2, size: 'normal', visible: false }),
    }),
  }),
  tabs: Object.freeze({ order: ['main', 'net'], active: 'main' }),
  calendarTabs: Object.freeze({ order: ['calendar', 'tasks'], active: 'calendar' }),
  mediaView: Object.freeze({ active: 'media' }),
  // When true the top bar (clock, quick actions, Layout/Settings/App) is hidden,
  // freeing the full surface for widgets. A floating Layout button re-opens the
  // editor (which temporarily reveals the bar) so the user can never get stuck.
  topbarHidden: false,
  // When true the Timer widget's add row (label + duration + format hint) is
  // folded to a slim "+ New timer" strip. One flag, not one per instance: a
  // Timer copy is cloned without the add row (stripTimerClone).
  timerAddCollapsed: false,
  // The vertical layout (js/dashboard-portrait.js): generated until arranged.
  portrait: Object.freeze({ custom: false, items: Object.freeze({}) }),
});

// Lighting effects a context profile can apply (a subset of the ambient-animation
// styles). '' in a profile means "don't touch lighting"; 'none' turns it off.
const CONTEXT_LIGHTING_STYLES = ['none', 'solid', 'breathing', 'cycle'];

// What a saved layout with no `groups` gets: the tabs every install had before 5.0.0,
// when the chat shared the media tile and the Agenda had a tile of its own.
const LEGACY_SEEDED_GROUPS = Object.freeze({
  'media-group': Object.freeze({ ...DEFAULT_DASHBOARD_LAYOUT.groups['media-group'], members: Object.freeze(['media', 'chat']) }),
});

const SETTINGS_PRESETS = Object.freeze([
  { id: 'xenon',   nameKey: 'settings_preset_xenon',   accent: '#1ed760', background: '#070808', text: '#f0f3f1' },
  { id: 'ocean',   nameKey: 'settings_preset_ocean',   accent: '#46c7e8', background: '#050a12', text: '#eefaff' },
  { id: 'ember',   nameKey: 'settings_preset_ember',   accent: '#ff8a3d', background: '#100807', text: '#fff4ee' },
  { id: 'violet',  nameKey: 'settings_preset_violet',  accent: '#a78bfa', background: '#090712', text: '#f7f2ff' },
  { id: 'mono',    nameKey: 'settings_preset_mono',    accent: '#f0f3f1', background: '#000000', text: '#f7f7f2' },
]);

// The Aspetto → Temi gallery has two tiers:
//  • Built-in STYLES (below) — Liquid Glass, Classic and Pixel Retro. Ocean/Ember/…
//    were dropped: they were just the same style with different colours, and colours
//    are edited in the Colori section. Selecting a style puts back that style's stock
//    look (see applyThemeById), so the look a new install had before 5.0.0 stays one
//    tap away: Classic declares every value that was the factory default then.
//  • Imported/saved THEMES (hubSettings.customThemes) — a full snapshot of the
//    visual identity (THEME_SETTING_KEYS), applied as one look and switchable.
const CLASSIC_BACKDROP = Object.freeze({
  panelAlpha: 0.94,
  bgAurora: Object.freeze({ enabled: true, intensity: 55, speed: 50 }),
  bgGrid: Object.freeze({ enabled: true, color: '#1ed760', intensity: 45, speed: 50 }),
  bgStatic: Object.freeze({ style: 'none', intensity: 70 }),
});

// The dashboard style languages (skins). 'liquid' is the default of a new install;
// 'liquid', 'retro' and 'comic' each have a themes-<skin>.css keyed off
// :root[data-style="<skin>"]. 'comic' is only selected by a theme (above). Anything
// else normalizes back to 'glass', the one look a saved value can always mean.
const STYLE_MODES = Object.freeze(['liquid', 'glass', 'retro', 'comic']);
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
  'panelAlpha', 'panelBorderStrength', 'tileShadowStrength',
  'uiRoundness', 'glassBlur', 'glassSaturate',
  'bgDim', 'bgBlur', 'bgAurora', 'bgGrid', 'bgStatic', 'bgCustom',
  'uiFont',
]);
