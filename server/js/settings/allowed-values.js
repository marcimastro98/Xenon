// The lists of values a setting may take, and the limits the settings code checks against.
'use strict';

const SETTINGS_STORAGE_KEY = 'xeneonedge.settings.v1';
// Which settings store the mirror above belongs to (server.js mints one per
// settings.json). Its own key, not a field inside the blob: the blob is rebuilt
// by normalizeSettings on every save and would carry this value back to the
// server, and the one thing this must never do is travel.
const SETTINGS_STORE_KEY = 'xeneonedge.store.v1';
const SETTINGS_MAX_BACKGROUND_BYTES = 200 * 1024 * 1024;
const SETTINGS_MIN_PANEL_ALPHA = 0.18;
const SETTINGS_BACKGROUND_TYPES = Object.freeze(new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/webm',
]));
const SETTINGS_BACKGROUND_EXTENSIONS = Object.freeze(new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm']));
const SETTINGS_MAX_FONT_BYTES = 8 * 1024 * 1024;
const SETTINGS_FONT_TYPES = Object.freeze(new Set(['font/woff2', 'font/woff', 'font/ttf', 'font/otf']));
const SETTINGS_FONT_EXTENSIONS = Object.freeze(new Set(['woff2', 'woff', 'ttf', 'otf']));

const DASHBOARD_WIDGET_IDS = Object.freeze(['media', 'agenda', 'mic', 'audio', 'system', 'notes', 'tasks', 'calendar', 'timer', 'chat', 'deck', 'remote', 'twitch', 'twitchwatch', 'obs', 'youtube', 'youtubelive', 'discord', 'spotify', 'browser', 'secondscreen', 'weather', 'smarthome', 'streamerbot', 'wavelink', 'lighting', 'notifications', 'stocks', 'football', 'news', 'claude', 'openaicodex', 'chatgpt', 'vitals', 'unifi', 'slideshow', 'fans', 'power', 'battery', 'search', 'disk', 'devclean', 'lyrics', 'transfer', 'phone', 'perf', 'screen', 'custom']);
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
// How the tile draws current conditions: the big animated card, or one line
// (icon, temperature, feels-like) so hours and days get the space (GitHub #130).
// Mirrored in server.js normalizeSettingsWeather.
const WEATHER_TILE_HEROES = Object.freeze(['full', 'compact']);
const WEATHER_TILE_LOOKS = Object.freeze(['new', 'classic', 'custom']); // the 5.x tile, the 4.11 cards, or a widget of the user's
// Individually toggleable weather fields: the 3 hero chips + the 8 detail
// metrics. Hiding one removes it from both the dashboard tile and the modal.
const WEATHER_FIELD_IDS = Object.freeze([
  'feels', 'wind', 'rain',
  'aqi', 'humidity', 'pm25', 'pm10', 'no2', 'pollen', 'pressure', 'visibility', 'uv', 'clouds',
]);

// Vitals — game-style self-care meters (widget + topbar chips + reminders).
// Declared up here for the same TDZ reason as the weather constants above.
const VITALS_IDS = Object.freeze(['hydration', 'energy', 'stamina', 'focus', 'posture']);
const VITALS_DEFAULT_MIN = Object.freeze({ hydration: 45, energy: 180, stamina: 60, focus: 25, posture: 45 });
const VITALS_DEFAULT_ON = Object.freeze({ hydration: true, energy: true, stamina: true, focus: true, posture: false });
// Bit's escalation ladder — minutes a vital must sit at zero before each rung.
// Defaults mirror core.STAGE_AT; each is user-tunable in Settings → Bit.
const VITALS_PET_STAGES = Object.freeze(['decay', 'gameover', 'overlay', 'minimize', 'lock']);
const VITALS_PET_DEFAULT_THR = Object.freeze({ decay: 5, gameover: 8, overlay: 10, minimize: 15, lock: 20 });
// Sparks a day Bit's AI roasts may spend; mirrors server/vitals-roast-sparks.js.
const VITALS_ROAST_SPARKS_CAPS = Object.freeze([0, 10, 25, 50, 100]);
const DASHBOARD_PAGE_IDS = Object.freeze(['dashboard']);
const DASHBOARD_TAB_IDS = Object.freeze(['main', 'net']);
const CALENDAR_TAB_IDS = Object.freeze(['calendar', 'tasks']);
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
const DASHBOARD_WIDGET_SIZES = Object.freeze(['compact', 'normal', 'wide', 'tall', 'large', 'full']);
const DASHBOARD_CARD_SIZES = Object.freeze(['compact', 'normal', 'wide']);
// 24 columns (with half-height rows) = fine-grained, near-free tile placement.
// Layouts saved on the old 12-column grid are scaled ×2 once — keyed on
// layout.gridCols, see scaleDashboardLayoutUnits — so nothing moves on upgrade.
const DASHBOARD_GRID_COLUMNS = 24;     // GridStack column count
const DASHBOARD_GRID_MAX_ROW = 400;    // generous clamp for y/h

// Declared before loadHubSettings() runs: normalizeLighting()/normalizeBgStatic()
// read these at module init, so they must not be in the temporal dead zone when
// settings hydrate.
const LIGHTING_STYLES = ['blink', 'pulse', 'solid'];
const BG_STATIC_STYLES = ['none', 'nebulosa', 'prisma', 'halo', 'dusk'];
// normalizeAmbientMode() also runs during that init, so its lookup tables must be
// initialized up here too — not further down the file. They previously sat below
// loadHubSettings() and threw "Cannot access 'AMBIENT_IDLE_MINUTES' before
// initialization" (a TDZ ReferenceError) on load, which aborted loadHubSettings
// and cascaded into "hubSettings is not defined" across every module.
const AMBIENT_IDLE_MINUTES = [0, 1, 2, 5, 10, 15, 30];
// sceneId is 'builtin' or an SDK package id (same charset as WIDGET_ID_RE in
// server/sdk-widgets.js — folder-name safe, never traverses).
const AMBIENT_SCENE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const AMBIENT_THEME_REF_RE = /^theme:[A-Za-z0-9_-]{1,40}$/;
// normalizeBgCustom() also runs during that init. Bounded even though the code
// only ever runs sandboxed — a huge snippet would bloat every settings save,
// theme snapshot and share code. Generous enough for an elaborate hand-drawn
// scene; genuinely heavy raster art belongs in bgCustom.assets, not the source.
// Keep in step with CODE_MAX in js/custom-bg.js (the sandbox second-guard).
const BG_CUSTOM_CODE_MAX = 60000;
// normalizeSurface() runs during that same init. It lived beside its function
// further down, which reads fine and cannot work: a function DECLARATION is
// hoisted and a `const` is not, so the call below reached the function while
// this array was still in its temporal dead zone. The throw took
// loadHubSettings() with it, `hubSettings` was never assigned, and every module
// that reads it failed in turn — the dashboard booted with zero tiles and a
// console full of "hubSettings is not defined". Anything the initial normalize
// touches belongs above this line.
// 'both' = the dashboard lives on a paired phone AND keeps opening on this PC.
// It behaves exactly like 'auto' for the shell; what it carries is the user's
// answer, so Settings can show it and the phone guide knows it was chosen.
// 'phone' keeps its narrower meaning: nothing on this PC, not even at login.
// An older build normalizes an unknown kind to 'auto', which is the safe
// direction — the window stays visible rather than disappearing.
const SURFACE_KINDS = ['auto', 'screen', 'phone', 'both'];
// Every provider id Xenon AI knows, mirrored from ai-local.js AI_PROVIDERS.
// Up here because normalizeSettings reads them at load (see SURFACE_KINDS).
const AI_PROVIDER_IDS = ['gemini', 'ollama', 'localapi', 'openai', 'anthropic', 'claudecode', 'codex', 'xenon'];
const AI_CLI_PROVIDERS = ['claudecode', 'codex'];
// How often the sensor readings refresh, in ms. Mirrors SENSOR_RATE_MS in
// server.js — the server clamps to this same set, so an out-of-range value
// saved by anything else lands back on the default rather than being honoured.
//
// Declared HERE, beside SURFACE_KINDS, and not next to the function that reads
// it: normalizeSettings runs during `let hubSettings = loadHubSettings()` below,
// so a const declared after that line is in its temporal dead zone and the read
// throws — which boots the dashboard empty. settings-load-order.test.mjs is the
// guard, and it caught exactly that.
const SENSOR_RATE_MS = [5000, 2000, 1000];
// Here for that same reason: normalizePageHotkeys reads it during that init.
const MAX_PAGE_HOTKEYS = 8;
// normalizeNewsClient() runs during that same init too, and reaches this table
// through defaultNewsFeedsClient() when there is no saved feed list — a fresh
// install, or a settings blob that predates the key. It sat beside that function
// further down and threw "Cannot access 'NEWS_DEFAULT_TOPIC' before
// initialization" on load, exactly as AMBIENT_IDLE_MINUTES and SURFACE_KINDS did
// before it: the function is hoisted, the const is not, so the call arrives
// while the table is still in its temporal dead zone. It took loadHubSettings()
// with it and the dashboard booted empty.
//
// The word for "technology" per UI language. A MIRROR of DEFAULT_TOPIC in
// server/news.js, for the same reason normalizeNewsClient mirrors normalizeNews,
// and pinned in step with it by test/news-default-feeds.test.mjs — the two
// drifting would put one language in the chip and another in the query.
const NEWS_DEFAULT_TOPIC = Object.freeze({
  it: 'Tecnologia', en: 'Technology', de: 'Technologie', fr: 'Technologie',
  es: 'Tecnología', pt: 'Tecnologia', ru: 'Технологии', nl: 'Technologie',
  ko: '기술', ja: 'テクノロジー', zh: '科技',
});

// The same rule, and the same three consts that broke it. normalizeSdkWidgets(),
// normalizeSdkUserHosts() and normalizeLightingDeviceModes() all run during that
// initial normalize, and all three read a table that used to sit beside them
// further down the file.
//
// It was invisible because loadHubSettings() wraps the whole normalize in a
// `try { … } catch { return normalizeSettings(null); }` — so the TDZ
// ReferenceError was swallowed and the user's ENTIRE saved settings blob was
// silently replaced by defaults on load. It only fired once there was data on
// the branch that reads the table: measured by running settings.js against a
// stored blob with one SDK widget assigned, which is every user who has put a
// community widget on a tile. The server copy arriving a moment later is what
// hid it. Nothing about the catch changes here — it is the right shape for a
// corrupt blob — which is exactly why the ordering has to be checked instead
// (test/settings-load-order.test.mjs).
// MUST mirror sdk-widgets.js SDK_STREAMS and Object.keys(SDK_ACTION_CATEGORIES)
// — a grant carrying a stream/action the server allows but this list omits gets
// silently stripped on save, so the widget is granted a capability it can never
// use. server/test/sdk-grant-cats-sync guards that half.
// The daily numbers of AI questions a widget may get (server: sdk-ai.js DAILY_CAPS).
const SDK_AI_DAILY_CAPS = Object.freeze([20, 50, 100, 200]);
const SDK_WIDGET_STREAMS = Object.freeze(['status', 'system', 'network', 'diskIo', 'devStorage', 'media', 'audio', 'audioLevels', 'wavelink', 'voicemeeter', 'stocks', 'football', 'news', 'claude', 'codex', 'obs', 'discord', 'discordChannels', 'discordSoundboard', 'discordNotifications', 'streamerbot', 'homeassistant', 'twitchWatch', 'twitchChat', 'youtubeLive', 'youtube', 'tasks', 'notes', 'agenda', 'weather', 'battery', 'processes', 'sensors', 'spotify', 'scriptStates', 'lighting', 'perf', 'gameSessions', 'vitals', 'netPath', 'energy']);
const SDK_WIDGET_ACTION_CATS = Object.freeze(['media', 'volume', 'audioDevice', 'mic', 'lighting', 'chroma', 'wavelink', 'wavelinkOutput', 'voicemeeter', 'spotify', 'steam', 'obs', 'discord', 'homeassistant', 'twitch', 'youtube', 'youtubePlayer', 'streamerbot', 'url', 'tasks', 'vitals', 'soundboard', 'browser', 'watch', 'pages', 'capture', 'benchmark', 'gallery', 'layers', 'timers', 'performance']);
const SDK_PACKAGE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
// Grant-side mirrors of the server manifest rules (sdk-widgets.js is the
// authority; a grant can never widen what the manifest declared, so a loose
// hostname check here is safe — the server re-validates every proxied fetch).
const SDK_HOST_RE = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const SDK_SUB_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const LIGHTING_DEVICE_MODES = ['follow', 'color', 'animation', 'temperature', 'album', 'off', 'custom'];
// sanitizeBackgroundMedia() runs during that normalize too. A pasted-SVG
// wallpaper is stored as a base64 data:image/svg+xml URI (not a served
// /uploads file); bounded so it cannot bloat the persisted settings blob.
const BG_SVG_DATA_RE = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/;
const BG_SVG_MAX_CHARS = 512 * 1024;
