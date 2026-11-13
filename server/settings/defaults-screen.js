// What a new install starts with, second part: the screensaver, weather and units, music and
// lyrics, the top bar, widget layers and the upcoming list.

const TopbarLook = require('../js/topbar-look.js');
const LayersModel = require('../js/layers-model.js');
const { WEATHER_FIELDS_ALL_ON } = require('../weather/fields-all-on.js');

const HUB_DEFAULTS_SCREEN = Object.freeze({
  // Ambient / Screensaver mode (client mirror in js/settings.js — keep in step).
  ambientMode: Object.freeze({ enabled: true, idleMinutes: 0, sceneId: 'builtin', wallpaper: false, saverMinutes: 0, openOnStartup: false }),
  // Native canvas Ambient scenes (client-owned, like customThemes).
  ambientScenes: Object.freeze([]),
  contentInstalls: Object.freeze([]),
  weather: Object.freeze({ mode: 'auto', city: '', provider: 'auto', refreshMin: 30, forecastDays: 3, tile: Object.freeze({ hero: 'full', look: 'new', metrics: true, hourly: true, forecast: true, fields: WEATHER_FIELDS_ALL_ON }) }),
  tempUnit: 'c', // 'c' | 'f' — weather temperature display unit
  hwTempUnit: 'auto', // 'auto' | 'c' | 'f' — hardware readings; auto follows tempUnit
  // Mirrors js/settings.js: 'off' | 'minimal' | 'wave'. Read by
  // audioLevelsWanted(): anything but 'off' is a first-party reason to run the
  // helper's meter, beside the SDK grants.
  mediaVisualizer: 'off',
  // Song lyrics from LRCLIB (sends title + artist; listed on the privacy page).
  // false = /api/lyrics answers 'off' and never reaches out.
  mediaLyrics: true,
  // Lyrics widget timing nudge, ms; a positive value shows lines earlier.
  lyricsOffsetMs: 0,
  // Supporter Lyrics widget. Translation sends the song's lines to the user's
  // own Xenon AI provider (one request per song, capped per month), so it is
  // off until they turn it on. Reading = romanization for ja/ko/zh lines.
  lyricsTranslate: false,
  lyricsReading: true,
  lyricsTranslateCap: 200,
  // How many questions a widget granted `ai` may ask the AI set for Bit each
  // day (sdk-ai.js): each one can cost Sparks, an API key's money or plan quota.
  sdkAiDailyCap: 50,
  // Spotify tile: when it starts the closed desktop app, start it minimized
  // (Windows and macOS; the Linux client cannot, see spotify-launch.js).
  spotifyStartMinimized: false,
  // Stage: the widget fills the screen while music plays on its page.
  lyricsStage: false,
  clockFormat: 'auto', // 'auto' | '12' | '24' — auto follows the UI language
  topbarStyle: 'minimal', // 'full' | 'minimal' — minimal docks the topbar actions into collapsible edge rails
  // Minimal-mode edge-rail drawer positions (true = collapsed). Persisted here —
  // not browser-local — so the kiosk remembers the choice across launches and a
  // WebView storage reset; both default closed so the rails never open on their own.
  topbarRails: Object.freeze({ left: true, right: true }),
  // Minimal-mode edge rails auto-hide after ~10s of no interaction, revealed again
  // by a touch at the screen edge. Default on; off keeps them always on screen.
  topbarRailsAutoHide: true,
  // The bar's look in every style (js/topbar-look.js owns the rules).
  topbarLook: TopbarLook.DEFAULTS,
  // Widgets outside the dashboard (js/layers-model.js owns the rules).
  layers: LayersModel.DEFAULTS,
  // Dynamic Island personalization (Settings → Dynamic Island). Visibility is
  // shared by Full + Minimal; order/anchor apply to the Minimal capsule. The
  // installed-package opt-outs and takeover gate are kept in the same object.
  topbarClock: Object.freeze({
    version: 2,
    align: 'center',
    takeovers: true,
    // Music takeover: the player owns the whole capsule while a track plays, and
    // the other segments return the moment it pauses. Off by default.
    mediaTakeover: false,
    // Page dots as labelled pills carrying the page names. Off by default.
    pageLabels: false,
    // The chrome buttons: order, side, visibility (see normalizeTopbarActions).
    actions: Object.freeze([
      Object.freeze({ id: 'lock', hidden: false, side: 'left' }),
      Object.freeze({ id: 'ambient', hidden: false, side: 'left' }),
      Object.freeze({ id: 'xenon', hidden: false, side: 'left' }),
      Object.freeze({ id: 'search', hidden: false, side: 'left' }),
      Object.freeze({ id: 'mini', hidden: false, side: 'left' }),
      Object.freeze({ id: 'layout', hidden: false, side: 'right' }),
      Object.freeze({ id: 'settings', hidden: false, side: 'right' }),
      Object.freeze({ id: 'apps', hidden: false, side: 'right' }),
      Object.freeze({ id: 'favorites', hidden: false, side: 'right' }),
    ]),
    hiddenSources: Object.freeze([]),
    items: Object.freeze([
      Object.freeze({ id: 'time', hidden: false }),
      Object.freeze({ id: 'date', hidden: false }),
      Object.freeze({ id: 'weather', hidden: false }),
      Object.freeze({ id: 'media', hidden: false }),
      Object.freeze({ id: 'vitals', hidden: true }),
      Object.freeze({ id: 'dots', hidden: false }),
      Object.freeze({ id: 'badges', hidden: false }),
      Object.freeze({ id: 'claude', hidden: false }),
      Object.freeze({ id: 'codex', hidden: false }),
    ]),
  }),
  weekStart: 'mon', // 'mon' | 'sun' — calendar first day of week
  // What the Upcoming list shows. 0 days = no horizon, which is what it always
  // did — the list simply took the next five, wherever they landed.
  upcomingCount: 5,
  upcomingDays: 0,
  upcomingColumns: 0,
  swipeNavigation: true, // drag / finger-swipe to change dashboard page
});

module.exports = { HUB_DEFAULTS_SCREEN };
