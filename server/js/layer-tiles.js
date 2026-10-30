'use strict';

// Every built-in tile, and what a light layer page (layer-lite.html) needs to
// draw it: one row per tile of index.html. The server composes the page from it
// (layer-page.js), the model decides light or full page by it (layers-model.js)
// and the page feeds the tiles by it (layer-lite-tiles.js), so the three can
// never disagree. A test fails when a dashboard tile has no row here: a new
// tile is born light, or says why it needs the whole dashboard.
//
// A row:
//   css, js   files the tile needs, in load order (shared ones are added once)
//   markup    elements cut from index.html: a tile by name, anything else by
//             '#id'; without a tile name the page builds the tile (createCopyAtom)
//   global    window object whose renderWidgets() draws every copy of the tile
//   streams   SSE event -> method of `global` that takes its data
//   copies    true when a copy of the tile is a clone of its markup (no ids
//             inside), so the light page can draw copies too
//   full      instead of all the above: why only the whole dashboard can draw it
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LayerTiles = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // A tile cut from index.html by name and drawn by one widget object; its
  // stylesheet is components/<Css>/<Css>.css.
  function tile(name, global, js, streams, cssName, moreCss) {
    const css = ['components/' + (cssName || global) + '/' + (cssName || global) + '.css'].concat(moreCss || []);
    return { css, js, markup: [name], global, streams };
  }

  const SYSTEM = {
    css: ['components/SystemPanel/SystemPanel.css', 'components/DashboardLayout/DashboardLayout.css',
      'components/AudioSection/AudioSection.css', 'components/MicPanel/MicPanel.css',
      'components/DevicePicker/DevicePicker.css', 'components/GuardianHistory/GuardianHistory.css'],
    js: ['js/fit-row.js', 'js/spark-path.js', 'js/system.js', 'js/network.js', 'js/status.js', 'js/audio-feedback.js',
      'js/volume.js', 'js/mic.js', 'js/picker.js', 'js/guardian-history.js'],
  };
  const AGENDA = {
    css: ['components/CustomSelect/CustomSelect.css', 'components/CalendarView/CalendarView.css', 'components/DayModal/DayModal.css',
      'components/TasksPanel/TasksPanel.css', 'components/TimerPanel/TimerPanel.css', 'components/NotesPanel/NotesPanel.css'],
    js: ['js/custom-select.js', 'js/calendar.js', 'js/notes.js', 'js/tasks.js', 'js/timer.js'],
  };

  const TILES = {
    // The System tile brings its tabs: Volume, Microphone (its content lives in
    // the Microphone tile until moved into the tab), History, and the device
    // picker they open. Fed by layer-lite-tiles.js (cards, tabs, language).
    system: { ...SYSTEM, markup: ['system', 'mic', '#picker-overlay'] },
    // Volume and Microphone as tiles of their own: their content is the System
    // tile's tab, pulled out by layer-lite-tiles.js as the Agenda's tabs are.
    mic: { ...SYSTEM, markup: ['system', 'mic', '#picker-overlay'] },
    audio: { ...SYSTEM, markup: ['system', 'mic', 'audio', '#picker-overlay'] },
    // The page builds the tile itself; a tap opens its details, cut from index.html.
    weather: { css: ['components/WeatherModal/WeatherModal.css'], js: ['js/system.js'], markup: ['#weather-overlay'], copies: true },
    // The Media tile with what draws inside it: Spotify extras, lyrics, the
    // waveform and its cover tint. Not the Lyrics widget's stage or translation.
    media: {
      css: ['components/MediaPanel/MediaPanel.css', 'components/LyricsView/LyricsView.css'],
      js: ['js/album-theme.js', 'js/media.js', 'js/media-spotify.js', 'js/lyrics-core.js', 'js/lyrics-view.js',
        'js/media-lyrics.js', 'js/media-viz.js'],
      markup: ['media'],
    },
    // The Game performance tile; system.js for the GPU temperature in the user's unit,
    // alert-toasts.js for the "why does it stutter?" line's words, perf-hud.js for the parts shown.
    perf: {
      css: ['components/PerfWidget/PerfWidget.css'],
      js: ['js/system.js', 'js/alert-toasts.js', 'js/perf-hud.js', 'js/perf-widget.js'],
      markup: ['perf'],
      global: 'PerfWidget',
      streams: { perf: 'onPerf', system: 'onSystem' },
    },
    battery: tile('battery', 'BatteryWidget', ['js/battery-widget.js'], { battery: 'onSSE' }),
    fans: tile('fans', 'FansWidget', ['js/sensor-access.js', 'js/fans-widget.js'], { system: 'onSSE' }),
    power: tile('power', 'PowerWidget', ['js/guardian-history.js', 'js/sensor-access.js', 'js/power-widget.js'], { system: 'onSSE', homeassistant: 'onHaSSE' }),
    stocks: tile('stocks', 'StockWidget', ['js/stock-widget.js'], { stocks: 'onSSE' }, 'StockWidget'),
    football: tile('football', 'FootballWidget', ['js/tile-tab-memory.js', 'js/football-widget.js'], { football: 'onSSE' }),
    news: tile('news', 'NewsWidget', ['js/news-widget.js'], { news: 'onSSE' }),
    slideshow: tile('slideshow', 'SlideshowWidget', ['js/slideshow-widget.js'], {}),
    notifications: tile('notifications', 'NotificationsWidget', ['js/notifications-widget.js'], { windows_notifications: 'onState', windows_notification: 'onItem' }),
    wavelink: tile('wavelink', 'WaveLinkWidget', ['js/wavelink-widget.js'], { wavelink: 'onSSE' }),
    obs: tile('obs', 'ObsWidget', ['js/obs-widget.js'], { obs: 'onObs', obs_preview: 'onObsPreview' }),
    discord: tile('discord', 'DiscordWidget', ['js/tile-tab-memory.js', 'js/discord-widget.js'], { discord: 'onSSE', discord_notification: 'onNotification' }),
    streamerbot: tile('streamerbot', 'StreamerbotWidget', ['js/tile-tab-memory.js', 'js/streamerbot-widget.js'], { streamerbot: 'onState', streamerbot_event: 'onEvent' }),
    youtube: tile('youtube', 'YouTubeWidget', ['js/tile-tab-memory.js', 'js/watch-view.js', 'js/youtube-widget.js'], {}),
    youtubelive: tile('youtubelive', 'YouTubeLiveWidget', ['js/youtubelive-widget.js'], {}),
    twitchwatch: tile('twitchwatch', 'TwitchWatchWidget', ['js/tile-tab-memory.js', 'js/twitch-chat.js', 'js/watch-view.js', 'js/twitchwatch-widget.js'], {}),
    spotify: tile('spotify', 'SpotifyWidget', ['js/tile-tab-memory.js', 'js/spotify-widget.js'], {}),
    claude: tile('claude', 'ClaudeWidget', ['js/custom-select.js', 'js/claude-history.js', 'js/claude-thread.js', 'js/claude-roadmap.js', 'js/claude-ident.js',
      'js/claude-clawd.js', 'js/claude-rail.js', 'js/claude-console.js', 'js/claude-agents.js', 'js/claude-widget.js'], { claude: 'onSSE' },
      'ClaudeWidget', ['components/CustomSelect/CustomSelect.css']),
    openaicodex: tile('openaicodex', 'CodexWidget', ['js/approval-keys.js', 'js/codex-widget.js'], { codex: 'onSSE' }),
    chatgpt: tile('chatgpt', 'ChatGPTWidget', ['js/approval-keys.js', 'js/chatgpt-widget.js'], { chatgpt: 'onSSE', codex: 'onCodex' }),
    transfer: tile('transfer', 'TransferWidget', ['js/transfer-widget.js'], { transfer: 'onState', transfer_progress: 'onProgress' }),
    phone: tile('phone', 'PhoneWidget', ['js/tile-tab-memory.js', 'js/phone-widget.js'], { phone: 'onSSE' }),
    search: tile('search', 'SearchWidget', ['js/spotlight.js', 'js/search-widget.js'], {}, 'SearchWidget', ['components/Spotlight/Spotlight.css']),
    disk: tile('disk', 'DiskWidget', ['js/xenon-loader.js', 'js/tile-tab-memory.js', 'js/disk-intelligence.js', 'js/disk-widget.js'],
      { disk_clean: 'onCleanProgress', disk_update: 'onDiskUpdate' }, 'DiskWidget', ['components/XenonLoader/XenonLoader.css']),
    devclean: tile('devclean', 'DevCleanWidget', ['js/devclean-pitch.js', 'js/devclean-widget.js'], { devclean: 'onProgress' }, 'DevClean'),
    lyrics: tile('lyrics', 'LyricsWidget', ['js/lyrics-core.js', 'js/lyrics-view.js', 'js/lyrics-translation.js', 'js/lyrics-stage.js',
      'js/lyrics-widget-options.js', 'js/lyrics-widget.js'], {}, 'LyricsWidget', ['components/LyricsView/LyricsView.css']),
    smarthome: tile('smarthome', 'SmartHome', ['js/smart-home-order.js', 'js/smart-home-dashboard-tile.js', 'js/smart-home.js'],
      { homeassistant: 'onSSE' }, 'SmartHomePanel'),
    // Seeds itself from /api/lighting/status when drawn; no stream.
    lighting: tile('lighting', 'LightingWidget', ['js/lighting-widget.js'], {}),
    unifi: tile('unifi', 'UnifiProtect', ['js/unifi-widget.js'], { unifi_event: 'onNotification' }, 'UnifiPanel'),
    // The Agenda with its tabs (Calendar, Tasks, Timer, Notes), and each tab as
    // a tile of its own: its content is the Agenda's tab, pulled out by
    // layer-lite-tiles.js, which also loads their data and feeds the stream.
    agenda: { ...AGENDA, markup: ['agenda', '#day-modal'] },
    calendar: { ...AGENDA, markup: ['agenda', 'calendar', '#day-modal'] },
    tasks: { ...AGENDA, markup: ['agenda', 'tasks'] },
    timer: { ...AGENDA, markup: ['agenda', 'timer'] },
    notes: { ...AGENDA, markup: ['agenda', 'notes'] },
    remote: tile('remote', 'RemoteControl', ['js/custom-select.js', 'js/remote-control.js'], {}, 'RemoteControlSettings',
      ['components/CustomSelect/CustomSelect.css']),
    twitch: tile('twitch', 'StreamingPage', ['js/twitch-chat.js', 'js/streaming-page.js'],
      { status: 'onStatus', obs: 'onObs', obs_preview: 'onObsPreview' }, 'TwitchPanel'),
    // The Deck as the Virtual Deck popup shows it: keys and presses, no editor
    // (deck-editor.js is not here). deck.js draws it by itself; js/deck-feed.js
    // gives it the stream (layer-lite-tiles.js attaches it).
    deck: {
      css: ['components/DeckPanel/DeckPanel.css'],
      js: ['js/custom-select.js', 'js/spark-path.js', 'js/deck-shortcuts.js', 'js/deck-model.js', 'js/vitals-core.js', 'js/deck-store.js',
        'js/deck-icons.js', 'js/capability-catalog.js', 'js/deck-actions.js', 'js/deck-error-text.js', 'js/decor-bg.js', 'js/deck.js',
        'js/deck-feed.js'],
      markup: ['deck'],
    },
    chat: { full: 'the Xenon AI chat is ai.js, which a light page never loads; on the screen Bit opens in the alerts window instead' },
    browser: { full: 'its tabs and favourites are saved into the settings, and a layer page only reads them' },
    vitals: { full: "Bit's meters save their refills into the settings, and a layer page only reads them" },
    // Never placed on a layer (server.js LAYER_TILE_EXCLUDED): a Store widget is
    // placed by its package, and the mirror of the second screen is pointless there.
    custom: { full: 'never placed as a tile: a Store widget is placed by its package' },
    secondscreen: { full: 'never placed: it mirrors the second screen' },
    screen: { full: 'never placed: it is the Xenon menu of the main screen, which the screen opens with its own key' },
  };

  for (const row of Object.values(TILES)) {
    for (const k of Object.keys(row)) if (Array.isArray(row[k])) Object.freeze(row[k]);
    if (row.streams) Object.freeze(row.streams);
    Object.freeze(row);
  }
  Object.freeze(TILES);

  const has = (name) => typeof name === 'string' && Object.prototype.hasOwnProperty.call(TILES, name);
  // The row of a tile the light page carries, or null.
  function lite(name) {
    return has(name) && !TILES[name].full ? TILES[name] : null;
  }
  const LITE = Object.freeze(Object.keys(TILES).filter((n) => !TILES[n].full).sort());
  const COPIES = Object.freeze(LITE.filter((n) => TILES[n].copies === true));

  return Object.freeze({ TILES, LITE, COPIES, lite });
});
