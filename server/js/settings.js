'use strict';

const WEATHER_FIELDS_ALL_ON = Object.freeze(
  WEATHER_FIELD_IDS.reduce((acc, id) => { acc[id] = true; return acc; }, {}),
);
// Bump when the default dashboard layout changes in a way that should override
// users' saved layouts on upgrade. v5 = copies (duplicated widget placements).
// CAREFUL: the 12→24-column unit migration (scaleDashboardLayoutUnits) relies
// on this NOT being bumped — a bump resets saved layouts to default BEFORE the
// ×2 scaler ever runs, wiping user layouts instead of migrating them. Never
// use this constant as the grid-units fence.
const DASHBOARD_LAYOUT_VERSION = 6;
const DEFAULT_HUB_SETTINGS = Object.freeze({
  appearance: 'dark', // 'light' | 'dark' | 'auto' (auto follows the OS colour scheme)
  autoPalette: false, // true only after selecting Auto; manual colour edits freeze the palette
  // Dashboard style language. 'liquid' = Liquid Glass, the look of a new install:
  // every tile is real glass over the wallpaper (themes-liquid.css). 'glass' = the
  // Classic look every install from before 5.0.0 keeps, because its saved settings
  // say so. 'retro' swaps the whole dashboard to the opt-in Pixel Retro-gaming skin
  // (themes-retro.css, keyed off :root[data-style="retro"]). Scanlines are a
  // retro-only sub-toggle.
  styleMode: 'liquid', // 'liquid' | 'glass' | 'retro' | 'comic'
  retroScanlines: true,
  // 'full' keeps the classic glass bar; 'minimal' docks the quick actions into
  // collapsible edge rails and shrinks clock/date/weather/page-dots into one
  // compact island pill (see js/topbar-minimal.js).
  topbarStyle: 'minimal', // 'full' | 'minimal'
  // Minimal-mode edge-rail drawer positions (true = collapsed). Server-synced (not
  // browser-local) so the kiosk remembers the choice across launches / storage
  // resets; both default closed so the rails never open on their own.
  topbarRails: { left: true, right: true },
  // Minimal-mode edge rails auto-hide after ~10s untouched (revealed by an edge
  // touch). Default on; off keeps them always visible. See js/topbar-minimal.js.
  topbarRailsAutoHide: true,
  // The bar's look in every style (surface, size, buttons, clock, where toasts
  // appear, each button's own icon/label/colours). Rules in js/topbar-look.js.
  topbarLook: TopbarLook.normalize(null),
  // Widgets on the desktop, in the overlay or anchored to an app (single-screen
  // use). Off with nothing placed by default. Rules in js/layers-model.js.
  layers: LayersModel.normalize(null),
  // Dynamic Island personalization shared by Full + Minimal. `items` controls
  // built-in segments (order in Minimal, visibility in both chromes), while
  // hiddenSources holds per-installed-package opt-outs and takeovers gates the
  // temporary goal/build/track cards from the advanced SDK.
  topbarClock: {
    version: 2,
    align: 'center',
    takeovers: true,
    // Music takeover: while a track plays, the player gets the whole capsule and
    // the other segments step aside until it pauses. Off by default — it hides
    // the clock, which nobody should lose without asking for it.
    mediaTakeover: false,
    // Page dots as labelled pills carrying the page names. Off by default: a
    // dashboard that was never renamed would only gain "Pagina 2" chips.
    pageLabels: false,
    hiddenSources: [],
    items: [
      { id: 'time', hidden: false },
      { id: 'date', hidden: false },
      { id: 'weather', hidden: false },
      { id: 'media', hidden: false },
      { id: 'vitals', hidden: true },
      { id: 'dots', hidden: false },
      { id: 'badges', hidden: false },
      { id: 'claude', hidden: false },
      { id: 'codex', hidden: false },
      { id: 'perf', hidden: false },
    ],
    // The BUTTONS of the chrome, as opposed to the clock contents above. Order
    // and side apply in both chromes (quickbar/top-actions in Full become the
    // left/right rail in Minimal), so "left" means the same thing in each.
    // `mini` is the SDK mini-widget slot. It starts VISIBLE like every other row
    // — a package the user just installed has to appear without them hunting for
    // a switch — and takes no room until something draws in it: the element
    // carries its own `hidden` attribute while empty (js/sdk-mini.js). The two
    // are different statements: "there is nothing to show" versus "I do not want
    // this here", and only the second belongs in this list.
    actions: [
      { id: 'lock', hidden: false, side: 'left' },
      { id: 'ambient', hidden: false, side: 'left' },
      { id: 'xenon', hidden: false, side: 'left' },
      { id: 'search', hidden: false, side: 'left' },
      { id: 'mini', hidden: false, side: 'left' },
      { id: 'layout', hidden: false, side: 'right' },
      { id: 'settings', hidden: false, side: 'right' },
      { id: 'apps', hidden: false, side: 'right' },
      { id: 'favorites', hidden: false, side: 'right' },
    ],
  },
  clockFormat: 'auto', // 'auto' | '12' | '24' — auto follows the UI language (en → 12h)
  // How big the top bar's clock reads, as multipliers on the stock sizes. Two
  // knobs rather than one: the time is already large and the date deliberately
  // small, so "make the date bigger" and "make the time bigger" are different
  // wishes. 1 is byte-for-byte the old look. Asked for on Discord by someone who
  // wanted to read the date across a room.
  clockScale: 1,
  clockDateScale: 1,
  clockDateFormat: 'medium', // 'full' | 'medium' | 'short' — how much of the date the top bar spells out
  weekStart: 'mon', // 'mon' | 'sun' — calendar first day of week
  // What the Upcoming list shows. There was never a two-week rule, which is how
  // it read from outside: the list took the next five events and their dates
  // fell where they fell. 0 days = no horizon, which is what it always did.
  upcomingCount: 5,
  upcomingDays: 0,
  upcomingColumns: 0,   // 0 = as many as fit; 1 or 2 = the user's own choice
  swipeNavigation: true, // drag / finger-swipe to change dashboard page (touchscreen-friendly)
  swipeHomeGesture: true, // native app: swipe up from the bottom → Windows desktop (native-bridge.js)
  hideOnRdp: false, // native app: hide the kiosk during a Windows Remote Desktop session (opt-in; native-bridge.js)
  audioSetCommunications: true, // Windows: switching a device also moves the calls default (server setDefaultAudioDevice)
  nativeZoom: 1, // native app: interface scale, 0.6–2.5 (Settings slider; native-bridge.js)
  accent: '#6ee787',
  dynamicAlbumTheme: true, // tint the accent from the now-playing album art
  background: '#14181c',
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
  panelAlpha: 0.54,
  bgDim: 0.48,
  bgBlur: 0,
  // Pause the aurora/grid + decorative loops after a minute of no interaction to
  // save GPU (js/ambient-idle.js). On by default; users can switch it off so the
  // dashboard keeps animating while idle.
  idleAnimationPause: true,
  // The Xenon mark over the first moments of a load (js/boot-splash.js). On by
  // default; off, the dashboard shows from the first paint as before.
  bootSplash: true,
  // Safe mode: temporarily run without any imported content — third-party SDK
  // widgets, custom themes/skins, code and image/video backgrounds all go back
  // to factory look. Nothing is uninstalled or overwritten: every stored key
  // stays as-is and turning safe mode off restores the exact prior state. Used
  // to triage "is an imported item causing this?" without a bisect.
  safeMode: false,
  // Freeze the aurora/grid, the animated background and the Deck decor for the
  // whole session when the native shell is rendering on the weaker of two GPUs
  // (js/native-bridge.js → body.low-power-gpu). On by default: on that hardware a
  // frame cap alone did not recover the frame rate, only stopping the loops did.
  // Off = keep everything moving and accept the cost. Inert on single-GPU
  // machines and on the browser surface, where the class is never set.
  hybridGpuAnimationPause: true,
  // Extended theme tokens (full Aspetto editor). All part of a saved theme; the
  // defaults reproduce the stock look exactly, and they apply inline only under
  // the glass styles (retro owns its own geometry/material).
  uiRoundness: 1, // corner-radius multiplier 0..2 (1 = stock 8/10/16/20px)
  glassBlur: 22, // --glass-blur px, 0..40
  glassSaturate: 160, // --glass-saturate %, 100..220
  panelBorderStrength: 1, // multiplier on the derived panel-border alpha, 0..2
  // Multiplier on the derived panel-shadow alpha, 0..2. Off: since v4.11.9 every tile
  // cast a soft drop shadow, which on a dark wallpaper reads as a dark strip under each
  // card (and a "card behind the cards" under a transparent one). The key used to be
  // panelShadowStrength, and every install that ever saved its settings stored 1 there,
  // theme cards and shared theme codes too. Renaming it is what turns the shadow off
  // for them as well: the old key is simply no longer read. The slider is still there
  // for whoever wants one. Never read panelShadowStrength again.
  tileShadowStrength: 0,
  mutedText: null, // optional secondary-text colour (#rrggbb) or null = auto
  lineColor: null, // optional divider/border colour (#rrggbb) or null = auto
  backgroundMedia: null,
  uiFont: null, // custom global typeface: { url, name, version } or null → default Sofia Sans
  lockWidgets: Object.freeze({ clock: true, weather: true, media: true, calendar: true }),
  // Ambient / Screensaver mode (evolution of the Focus lock screen).
  // idleMinutes 0 = never auto-start; sceneId 'builtin' = the native scene
  // (lockscreen.js, configured by lockWidgets) or an installed SDK package id
  // whose manifest declares surface:'ambient'.
  // openOnStartup: boot straight into the scene and keep it up (a home screen,
  // not a screensaver: nothing dismisses it but the user).
  ambientMode: Object.freeze({ enabled: true, idleMinutes: 0, sceneId: 'builtin', wallpaper: false, saverMinutes: 0, openOnStartup: false }),
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
    // `hero` is 'full' (the big card) or 'compact' (a single line).
    tile: Object.freeze({ hero: 'full', look: 'new', metrics: true, hourly: true, forecast: true, fields: WEATHER_FIELDS_ALL_ON }),
  }),
  tempUnit: 'c', // 'c' | 'f' — weather temperature display unit
  // 'auto' | 'c' | 'f' — CPU/GPU temperatures, Guardian and briefing lines.
  // 'auto' follows tempUnit, which is what everyone had before it existed.
  hwTempUnit: 'auto',
  // The Media tile's waveform: 'off' | 'minimal' | 'wave'. An ADDITION to that
  // tile, so it defaults to off and has a quiet setting as well as a full one —
  // nobody gets a busier Media tile than the one they already had. Off is also
  // what keeps the helper's peak metering (~12 pushes a second) from running:
  // the cost follows the choice, the same rule the SDK `audioLevels` grant
  // follows, which until now was the only thing that could start it.
  mediaVisualizer: 'off',
  // Song lyrics from LRCLIB (title + artist leave the PC; see the privacy page).
  mediaLyrics: true,
  // Lyrics widget timing nudge in ms, -3000..3000 in 100 ms steps.
  lyricsOffsetMs: 0,
  // Supporter Lyrics widget: translation through the user's own AI provider
  // (off until turned on, capped per month), ja/ko/zh reading, stage mode.
  lyricsTranslate: false,
  lyricsReading: true,
  lyricsTranslateCap: 200,
  lyricsStage: false,
  // Questions a widget granted `ai` may ask the AI set for Bit per day (sdk-ai.js).
  sdkAiDailyCap: 50,
  // Spotify tile: start the closed desktop app minimized (Windows, macOS).
  spotifyStartMinimized: false,
  // Open the dashboard in the default browser at Windows logon (default on).
  // Only reconciled into a real scheduled task from a standalone browser view —
  // never from inside the Xeneon Edge iframe (see reconcileAutoOpenBrowser).
  autoOpenBrowser: true,
  // Anonymous version ping — ON by default for installs made from v4.8.0 onwards;
  // the switch is in Settings → Generale → Aggiornamenti. Sends only {version, os}
  // on the update check the app already makes, never the install id. Mirror of
  // server.js; see docs/privacy.html.
  //
  // This default reaches ONLY a fresh install, and that is deliberate: it applies
  // when there is no settings file yet, while `normalizeSettings` keeps the strict
  // `=== true` test so a stored blob decides for itself. An install that predates
  // the key therefore stays OFF rather than being switched on by an update — those
  // users read "off unless you turn it on" and left it alone, which is a choice.
  // Do not "simplify" that test to `!== false`: it would flip exactly those people.
  versionPing: true,
  autoUpdate: true,
  // Store widgets update themselves (server/widget-auto-update.js). On unless switched off.
  autoUpdateWidgets: true,
  // Announcements and the paid-drop card. ON by default, and normalized with
  // `!== false` — the opposite of versionPing above, deliberately: this is a
  // preference about being interrupted, not a data opt-in.
  hubMessages: true,
  catalogDrops: true,
  // The month's paid drops, shown once per session (js/catalog-drop.js). A new
  // key on purpose: it starts on for everybody, whatever catalogDrops said.
  monthlyDrops: true,
  // `=== true` like versionPing, not `!== false`: a new outbound report starts
  // on for fresh installs only, never switched on under an existing user.
  catalogStats: true,
  // Bit may ask for a vote on something in real use (server/rating-votes.js).
  ratingAsks: true,
  // Anonymous feature counts (server/usage-stats.js). Same rule as catalogStats:
  // on for a fresh install, an existing one stays off until its owner chooses.
  usageStats: true,
  // Mirror of server.js: asking devices on a dongle for their charge.
  batteryAskDevices: true,
  // The two startup cards' "don't show again" — the What's New release id and
  // the Discord invite flag. Mirror of server.js; see the note there for why
  // they stopped being localStorage-only in v4.11.6.
  whatsNewSeen: '',
  releaseNotesSeen: '',
  updateFailSeen: '',
  discordInviteSeen: false,
  // Voice channels pinned to the top of the Discord widget. Mirror of server.js;
  // see the note there for why this one is NOT per-device.
  // Which servers the user has collapsed in the Discord widget's Channels tab,
  // by guild id. Remembered rather than reset per visit: someone with a dozen
  // servers collapses the ones they never join once, and a list that forgets
  // makes them do it again at every sign-in (asked for on Discord, Sep 2026 —
  // "so your not forever scrolling"). Guild ids, not names, so a renamed server
  // stays collapsed and two servers with the same name are told apart.
  discordFavChannels: Object.freeze([]),
  discordCollapsedGuilds: Object.freeze([]),
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
    // The shape only. The list a fresh install actually gets is built in the
    // user's language by defaultNewsFeedsClient(); this is its 'en' answer, and
    // matches server/news.js DEFAULT_NEWS.
    feeds: Object.freeze([
      Object.freeze({ id: 'bbc', type: 'source', name: 'BBC News' }),
      Object.freeze({ id: 'guardian', type: 'source', name: 'The Guardian' }),
      Object.freeze({ id: 'tech', type: 'topic', name: 'Technology', query: 'technology' }),
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
  geminiApiKeySet: false,
  aiProvider: 'gemini', // 'gemini' | 'ollama' | 'localapi' | 'openai' | 'anthropic' | 'claudecode' | 'codex' | 'xenon' — selected AI backend
  ollamaModel: 'auto',  // 'auto' | whitelist key | custom model tag
  ollamaUrl: 'http://localhost:11434',
  localApiUrl: LocalServerFields.DEFAULT_URL,
  localApiModel: 'auto',
  localApiKey: '',
  localApiKeySet: false,
  localApiVision: false,
  // ChatGPT (OpenAI) + Claude (Anthropic). Keys are SERVER-ONLY: the server
  // redacts them on the wire and sends only the *Set booleans, so the browser
  // never holds them. The model tags are user-overridable.
  openaiApiKey: '',
  openaiApiKeySet: false,
  // 'auto' / 'auto:<family>' = follow the provider's newest model of that family
  // (resolved server-side in ai-models.js); a concrete id is a pin.
  openaiModel: 'auto',
  openaiSttModel: 'auto',
  openaiTtsModel: 'auto',
  anthropicApiKey: '',
  anthropicApiKeySet: false,
  anthropicModel: 'auto',
  xenonModel: 'sonnet', // Xenon credits: 'haiku' | 'sonnet' | 'opus'
  xenonEffort: 'medium', // how hard the creation model reasons: 'low' | 'medium' | 'high'
  // Claude Code / Codex (the user's own subscription, ai-cli.js). 'default'
  // lets the program choose; no key, the program has its own sign-in.
  claudeCodeModel: 'default',
  codexModel: 'default',
  geminiModel: 'auto',
  geminiModelPro: 'auto',
  geminiModelTts: 'auto',
  geminiModelLive: 'auto',
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
  // Which screens light their edges while a voice chat is on (native app,
  // js/ai-edge-glow.js): auto = the screen Bit was called from.
  aiEdgeGlow: 'auto',
  // How this PC uses Xenon: dashboard / widgets / both, '' = not asked yet
  // (js/usage-mode.js).
  usageMode: '',
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
  sensorHistory: Object.freeze({ enabled: false, everyMin: 5 }),
  // Game sessions log (Settings → Performance): ON unless explicitly turned off.
  gameSessions: Object.freeze({ enabled: true }),
  // What the Game performance tile shows (js/perf-hud.js).
  perfHud: Object.freeze(window.PerfHud ? window.PerfHud.normalizePerfHud() : {}),
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
  notifications: Object.freeze({ enabled: true, popups: true, sounds: true, quiet: 'auto' }),
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
  calls: Object.freeze({ enabled: false, push: true, sound: true, disabledApps: Object.freeze([]), apps: Object.freeze([]) }),
  // The paired phone (phonebook, call log, dialler, live call state). OFF by
  // default — enabling it reads the whole address book off the phone. `ring`
  // decides whether the structural incoming-call signal raises the fullscreen
  // card; the phonebook is useful without that.
  phone: Object.freeze({ enabled: false, ring: true, hide: true }),
  // Local "Hey Bit" wake word. OFF by default (privacy) — when on, the server
  // listens to the microphone locally (ffmpeg + whisper.cpp) while a dashboard
  // is open; audio never leaves the PC and candidate clips are never stored.
  wakeWord: Object.freeze({ enabled: false }),
  // Local search (Spotlight) + Disk widget knobs. Hotkey OFF by default (it
  // registers a system-wide key); dev folders empty (build dirs stay
  // non-cleanable until the user names their project roots).
  // No indexRoots here on purpose. This file runs in the BROWSER, which cannot
  // know whether the host is Windows, macOS or Linux, and a default of "C:\"
  // was written into settings.json on every non-Windows machine the moment the
  // dashboard saved anything — a root no POSIX walk can start from, which left
  // search dead while Settings displayed a configured folder. Leaving the key
  // absent is what lets the SERVER supply the platform's default, which is
  // where that decision already belongs (see normalizeSearchSettings).
  searchSettings: Object.freeze({ hotkeyEnabled: false, hotkeyCombo: 'alt+space', aiFullContext: false, recentInTile: false }),
  pageHotkeys: Object.freeze([]),
  diskSettings: Object.freeze({ devFolders: Object.freeze([]), installerAgeDays: 30 }),
  // Third-party widget SDK (the Custom widget tile). OFF by default — community
  // packages run in a sandboxed, network-less iframe and each one gets an
  // explicit per-package permission grant (data streams + action categories)
  // before it renders. `assign` maps a tile instance id → package id.
  sdkWidgets: Object.freeze({ enabled: false, assign: Object.freeze({}), grants: Object.freeze({}), suspended: Object.freeze([]) }),
  // Background FX (all 0..100 unless noted). Aurora = soft flowing accent
  // gradients behind the grid (only when no custom image/video bg). Grid =
  // a perspective neon grid scrolling toward a glowing horizon.
  bgAurora: Object.freeze({ enabled: false, intensity: 55, speed: 50 }),
  bgGrid: Object.freeze({ enabled: false, color: '#6ee787', intensity: 45, speed: 50 }),
  // Static premium background (0 animations). Alternative to the animated aurora
  // for a rich look at near-zero render cost. style: none|nebulosa|prisma|halo|dusk.
  bgStatic: Object.freeze({ style: 'dusk', intensity: 100 }),
  // Code-defined animated background: a user snippet (or one carried in a shared
  // theme/package) run inside a locked-down sandboxed iframe (see js/custom-bg.js).
  // Off by default; when enabled it owns the backdrop like a static bg does.
  bgCustom: Object.freeze({ enabled: false, name: '', code: '', assets: Object.freeze({}), fps: 30 }),
  // Slideshow widget — either an ordered set of uploaded images/GIFs or a folder on
  // this PC (`source`), plus its playback options. Rules live in
  // js/slideshow-widget.js (shared with the server).
  slideshow: Object.freeze({ images: Object.freeze([]), source: 'library', folder: '', shuffle: false, pauseGame: true, intervalMs: 6000, fit: 'cover' }),
  // Claude Code widget surfaces that appear OUTSIDE its tile, and so show up
  // even when the widget is on another page or not added at all: the permission
  // / question cards (with their fullscreen escalation) and the topbar marker.
  // Both on by default; see js/claude-widget.js.
  claudeWidget: Object.freeze({ approvals: true, questions: true, topbar: true }),
  // OpenAI Codex widget: the approval cards (Settings → Codex) and how long one
  // waits before the decision goes back to Codex. See js/codex-widget.js.
  codexWidget: Object.freeze({ approvals: true, waitSec: 90 }),
  // "Ask ChatGPT" tile: the model Codex answers with. See js/chatgpt-widget.js.
  chatgptWidget: Object.freeze({ model: 'default' }),
  gameMode: true, // auto-pause ambient FX while a game / intensive app is running
  gameIgnore: Object.freeze([]), // apps the user says are not games (js/game-ignore.js)
  bgGuard: true, // slow down, then still, an animated background that weighs on the PC (js/bg-guard.js)
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
  // Performance Mode: defaults and normalizer in js/perf-settings.js (the
  // "widgets only" driver page runs it too, without this file).
  performance: PERF_DEFAULTS,
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
    native: Object.freeze({ enabled: false, layouts: Object.freeze({}) }),
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
  homeAssistant: Object.freeze({ url: '', token: '', entities: Object.freeze([]), cameras: Object.freeze([]), energyEntities: Object.freeze([]), camAngles: Object.freeze({}), areaOrder: Object.freeze([]), tileView: 'auto', tokenSet: false }),
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
  // Which screen the user chose for Xenon, asked once at first run.
  //   kind:  'auto'   — whatever the machine offers (the historical behaviour)
  //          'screen' — a display on this PC, named in `monitor`
  //          'phone'  — a paired phone or tablet; this PC shows nothing
  //   asked: false until the first-run picker has been answered or dismissed.
  //   monitor/label: the chosen display, for Settings to show. The AUTHORITY for
  //     placement is the native shell's own display.json, which it must be able
  //     to read at launch, before the backend is necessarily up — this copy is
  //     what the dashboard renders and what a paired phone is able to write.
  // NOT `surface`: that key is the theme's main panel colour, and both used to
  // be written into the same object literal in normalizeSettings — the choice
  // won, the colour was destroyed, and Settings then threw on it. See
  // surfaceChoiceFrom() and its twin in server.js.
  surfaceChoice: Object.freeze({ kind: 'auto', asked: false, monitor: '', label: '' }),
  language: '', // '' means "use browser language or 'en'"; set to a SUPPORTED_LANGS code to persist across browser resets
  // Second-screen capture preferences (client-owned). fps/quality tune the live
  // stream; width/height is the virtual display mode applied via create-display.
  secondScreen: Object.freeze({ fps: 15, quality: 55, width: 1920, height: 1080, fit: 'contain', touchControl: false }),
});

const BUILTIN_THEMES = Object.freeze([
  Object.freeze({
    id: 'liquid', nameKey: 'settings_style_liquid', skin: 'liquid',
    accent: DEFAULT_HUB_SETTINGS.accent, background: DEFAULT_HUB_SETTINGS.background, text: DEFAULT_HUB_SETTINGS.text,
  }),
  Object.freeze({
    id: 'glass', nameKey: 'settings_style_glass', skin: 'glass',
    accent: '#1ed760', background: '#070808', text: '#f0f3f1', ...CLASSIC_BACKDROP,
  }),
  Object.freeze({ id: 'retro', nameKey: 'settings_style_retro', skin: 'retro', accent: '#f5c518', background: '#050510', text: '#e8f6ff', ...CLASSIC_BACKDROP }),
  // 'comic' is a real skin (themes-comic.css) but deliberately NOT a permanent
  // gallery card: it isn't a general-purpose console like Retro, it's the
  // companion look for a comic-styled theme/background. It's reached only by a
  // theme that selects styleMode:"comic" (e.g. an imported pack) — so users who
  // don't want it never see a stray card. The engine still lives in the app;
  // normStyleMode below keeps 'comic' valid everywhere it's applied.
]);

let hubSettings = loadHubSettings();
let weatherSettingsFetchTimer = null;

// The feed set a fresh install starts with, in the user's language. Its table
// (NEWS_DEFAULT_TOPIC) lives up beside SURFACE_KINDS and not here — see the note
// there; the initial normalize reaches this function before this point in the
// file has been evaluated.
function defaultNewsFeedsClient(langCode) {
  const raw = String(langCode || '').toLowerCase().slice(0, 2);
  const l = Object.prototype.hasOwnProperty.call(NEWS_DEFAULT_TOPIC, raw) ? raw : 'en';
  const sources = l === 'it'
    ? [{ id: 'ansa', type: 'source', name: 'ANSA' }, { id: 'bbc', type: 'source', name: 'BBC News' }]
    : [{ id: 'bbc', type: 'source', name: 'BBC News' }, { id: 'guardian', type: 'source', name: 'The Guardian' }];
  const topic = NEWS_DEFAULT_TOPIC[l];
  return [...sources, { id: 'tech', type: 'topic', name: topic, query: topic.toLowerCase() }];
}

// A layer surface (`?layer=`, js/layer-host.js) is a viewer of these settings: it
// changes them in memory to show its tiles and must never write them back, to
// localStorage (shared with the dashboard on this origin) or to the server.
// Read from the URL, not LayerHost, because saves can run before layer-host.js loads.
const _settingsReadOnly = /[?&]layer=/.test(String((window.location && window.location.search) || ''));

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

window._reconcileSettingsAfterReconnect = reconcileSettingsAfterReconnect;

let _osPrefersDark = (() => {
  try { const v = localStorage.getItem(OS_THEME_KEY); return v === 'true' ? true : v === 'false' ? false : null; }
  catch { return null; }
})();

// Ask the server what the OS actually says (Windows registry, macOS `defaults`,
// GNOME `gsettings`) so "Auto" is reliable even where the WebView doesn't report
// prefers-color-scheme correctly — which on macOS is every time the display
// wakes. See server/os-theme.js.
function refreshOsTheme() {
  // The OS scheme only matters in 'auto', and the endpoint spawns a process
  // server-side. Skip the poll unless we're on auto and the page is visible.
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
// Coming back from display sleep is precisely when the WebView's own reading is
// least trustworthy, so ask the OS again the moment the page is visible rather
// than up to 30 s later — that gap is how long a wrongly repainted dashboard
// used to stay wrong.
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshOsTheme(); });

// Re-apply when the OS scheme flips, but only while the user is on 'auto'.
//
// The media query says "look again", not "you are light now". Where the OS can
// be read directly that reading decides, and this only asks for a fresh one:
// after a macOS display wakes, the WebView announces light on a Mac that never
// left dark, and repainting on its word turned the whole dashboard white until
// something else forced a repaint. The WebView gets the last word only on a
// platform where nothing can be read at all.
if (window.matchMedia) {
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (!hubSettings || hubSettings.appearance !== 'auto') return;
      refreshOsTheme();
      if (typeof _osPrefersDark !== 'boolean') applyHubSettings();
    });
  } catch {}
}

const PANEL_DROP_CSS = ThemeTokens.PANEL_DROP_CSS;
if (typeof window !== 'undefined') window.PANEL_DROP_CSS = PANEL_DROP_CSS;

if (typeof window !== 'undefined') window.backdropIsPlain = backdropIsPlain;
if (typeof window !== 'undefined') window.getEffectiveThemePalette = getEffectiveThemePalette;

// On a narrow screen the category sidebar collapses to the current category
// alone (see the max-width:720px block in SettingsModal.css). The rule is one
// line and needs to know nothing about which button was hit: collapsed, the
// only button on screen is the active one, so a tap means "show me the list";
// open, a tap on any of them means the choice is made. Delegated from the
// document so the categories added at runtime (calendar) are covered too, and
// it runs after the button's own onclick, which is what settles the highlight.
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('.settings-nav-btn');
  const nav = btn && btn.closest('.settings-nav');
  if (nav) nav.classList.toggle('is-open');
});

if (typeof document !== 'undefined') {
  document.addEventListener('xenon-bg-status', (e) => renderBgCodeError(e && e.detail));
}

if (typeof document !== 'undefined') {
  document.addEventListener('xenon-bg-slow', (e) => {
    renderBgSlowNote();
    const d = (e && e.detail) || {};
    if (d.level !== 3 || _bgStillToldFor.has(d.code)) return;
    _bgStillToldFor.add(d.code);
    if (typeof showHubToast === 'function') showHubToast(t('settings_bg_slow_toast_kicker'), t('settings_bg_slow_toast'), t('settings_bg_slow_toast_meta'));
  });
}

document.addEventListener('change', (e) => {
  const details = e.target.closest && e.target.closest('details[data-on-summary]');
  if (details) syncExpanderSummary(details);
});

// Re-list the ambient scenes whenever the SDK package set changes (an install or
// removal), so a freshly imported scene appears in the dropdown with no page
// reload. No-op when the picker isn't in the DOM (settings closed).
window.addEventListener('xenon:sdk-packages', () => {
  try {
    const cfg = normalizeAmbientMode(hubSettings.ambientMode);
    syncAmbientScenePicker(cfg);
    syncAmbientSceneNote(cfg); // the list lands after Settings first draws
  } catch { /* settings not ready */ }
});

// Performance Mode starting or ending changes what that line has to say.
window.addEventListener('xenon:perf-change', () => {
  const el = $('settings-media-viz-status');
  if (el && el.isConnected && !el.closest('[hidden]')) refreshMediaVizStatus(true);
});

// Read by js/update.js and js/discord-invite.js. A namespace rather than bare
// globals because discord-invite.js is parsed BEFORE this file and reaches these
// only at call time.
window.XenonStartupCards = {
  whenReady: whenStartupCardsReady,
  whatsNewDismissed,
  rememberWhatsNew: rememberWhatsNewSeen,
  whatsNewSeen: () => (hubSettings && hubSettings.whatsNewSeen) || legacyCardFlag('whatsNewSeen'),
  releaseNotesSeen: () => (hubSettings && hubSettings.releaseNotesSeen) || '',
  updateFailSeen: () => (hubSettings && hubSettings.updateFailSeen) || '',
  rememberUpdateNotice,
  discordInviteDismissed,
  rememberDiscordInvite: rememberDiscordInviteSeen,
  supportAskDismissed,
  rememberSupportAsk: rememberSupportAskSeen,
  supportAskSeenDay,
  supportAppealYear,
  rememberSupportAppeal,
  silenceSupportAppeal,
  shareNudgeDismissed,
  rememberShareNudge: rememberShareNudgeSeen,
  usageHistory,
};

function syncWeatherSettingsControls() {
  const weather = normalizeWeatherSettings(hubSettings.weather);
  document.querySelectorAll('.settings-weather-mode[data-weather-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.weatherMode === weather.mode);
    btn.setAttribute('aria-pressed', String(btn.dataset.weatherMode === weather.mode));
  });
  const cityInput = $('settings-weather-city');
  if (cityInput) {
    cityInput.value = weather.city;
    cityInput.closest('.settings-row').hidden = weather.mode !== 'manual';
  }
  const unit = hubSettings.tempUnit === 'f' ? 'f' : 'c';
  document.querySelectorAll('.settings-temp-unit[data-temp-unit]').forEach(btn => {
    const active = btn.dataset.tempUnit === unit;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  const hwUnit = ['c', 'f'].includes(hubSettings.hwTempUnit) ? hubSettings.hwTempUnit : 'auto';
  document.querySelectorAll('.settings-hw-temp-unit[data-hw-temp-unit]').forEach(btn => {
    const active = btn.dataset.hwTempUnit === hwUnit;
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
  if (window.WeatherLook) window.WeatherLook.sync();
  document.querySelectorAll('.settings-weather-hero[data-weather-hero]').forEach(btn => {
    const active = btn.dataset.weatherHero === weather.tile.hero;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
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

// Big card or one line for the tile's current conditions. Tile only: the
// modal always has the room for the full hero.
function updateWeatherTileHero(hero) {
  if (!WEATHER_TILE_HEROES.includes(hero)) return;
  const tile = normalizeWeatherTile(hubSettings.weather && hubSettings.weather.tile);
  if (tile.hero === hero) return;
  hubSettings = normalizeSettings({
    ...hubSettings,
    weather: { ...hubSettings.weather, tile: { ...tile, hero } },
  });
  commitWeatherChange();
  syncWeatherSettingsControls();
  if (typeof renderWeatherTile === 'function') renderWeatherTile();
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
// How much of the date the top bar spells out. Display-only, like the time
// format beside it: redraw now rather than at the next tick, or the segmented
// control moves and nothing else does for up to a second.
function updateClockDateFormat(fmt) {
  if (!['full', 'medium', 'short'].includes(fmt)) return;
  hubSettings = normalizeSettings({ ...hubSettings, clockDateFormat: fmt });
  saveHubSettings();
  syncClockFormatControls();
  if (typeof tickClock === 'function') tickClock();
  // SDK widgets that print a date of their own read the shape from the theme
  // bridge (theme.dateFormat) — re-push it, exactly as the time format beside
  // this does, so a live widget follows instead of waiting for a reload.
  if (window.CustomWidget && typeof window.CustomWidget.refreshTheme === 'function') window.CustomWidget.refreshTheme();
  // A shorter date makes the island's capsule narrower, and the tiles beneath it
  // clear a pill whose width was measured before the change.
  if (window.TopbarMinimal && typeof window.TopbarMinimal.reflowIsland === 'function') {
    window.TopbarMinimal.reflowIsland();
  }
  setSettingsStatus('settings_saved', 'ok');
}

function syncClockFormatControls() {
  const fmt = ['auto', '12', '24'].includes(hubSettings.clockFormat) ? hubSettings.clockFormat : 'auto';
  document.querySelectorAll('.settings-clock-format[data-clock-format]').forEach(btn => {
    const active = btn.dataset.clockFormat === fmt;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  const dfmt = ['full', 'medium', 'short'].includes(hubSettings.clockDateFormat) ? hubSettings.clockDateFormat : 'full';
  document.querySelectorAll('.settings-clock-date-format[data-clock-date-format]').forEach(btn => {
    const active = btn.dataset.clockDateFormat === dfmt;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function syncTopbarStyleControls() {
  // Two different things: whether the bar is there at all (the layout flag, also
  // toggled from the Layout editor) and what it looks like when it is. Hidden wins,
  // so the segment agrees with the screen however the bar was switched off.
  const layout = (hubSettings && hubSettings.dashboardLayout) || {};
  const style = layout.topbarHidden === true ? 'none'
    : (hubSettings.topbarStyle === 'minimal' ? 'minimal' : 'full');
  document.querySelectorAll('.settings-topbar-style[data-topbar-style]').forEach(btn => {
    const active = btn.dataset.topbarStyle === style;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  // Built-in visibility applies to Full and Minimal. Position only belongs to
  // Minimal; edge rails exist in Minimal and None (the user's existing no-pill
  // mode deliberately keeps those controls reachable).
  const personalize = document.getElementById('topbar-personalize');
  if (personalize) personalize.hidden = false;
  const alignRow = document.getElementById('topbar-align-personalize');
  if (alignRow) alignRow.hidden = style !== 'minimal';
  const railsRow = document.getElementById('topbar-rails-personalize');
  setSettingsCardAvailable(railsRow, style !== 'full');
  syncTopbarRailsAutoHide();
}

// Reflect the "auto-hide edge rails" toggle (minimal mode only). Default on.
function syncTopbarRailsAutoHide() {
  const el = $('settings-rails-autohide');
  if (el) el.checked = hubSettings.topbarRailsAutoHide !== false;
}

// Toggle whether the minimal edge rails hide themselves when untouched
// (after topbarLook.railDelay seconds).
function updateTopbarRailsAutoHide(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, topbarRailsAutoHide: checked === true });
  saveHubSettings();
  syncTopbarRailsAutoHide();
  // The delay and "what stays on the edge" rows only apply while this is on.
  if (window.TopbarLookSettings) window.TopbarLookSettings.sync();
  if (window.TopbarMinimal) window.TopbarMinimal.apply();
  if (window.SdkIsland) window.SdkIsland.apply();
  setSettingsStatus('settings_saved', 'ok');
}

// Switch between the full glass topbar, the minimal chrome (edge rails + island
// pill), and no bar at all. Re-applies the dashboard layout so the grid reclaims/
// returns the bar's row with a smooth transition.
// "None" is deliberately NOT a third topbarStyle: it writes the same
// dashboardLayout.topbarHidden flag the Layout editor's hide button already owns.
// A second flag for the same question would let the two controls disagree, and the
// existing one is what the body class, TopbarMinimal and the floating Layout button
// (the way back in once the bar is gone) all read.
function updateTopbarStyle(style) {
  if (!['full', 'minimal', 'none'].includes(style)) return;
  const hide = style === 'none';
  hubSettings = normalizeSettings({
    ...hubSettings,
    // Hiding keeps the style underneath, so bringing the bar back restores the look
    // the user had instead of dropping them on Full.
    topbarStyle: hide ? hubSettings.topbarStyle : style,
    dashboardLayout: { ...getDashboardLayout(), topbarHidden: hide },
  });
  saveHubSettings();
  syncTopbarStyleControls();
  syncTopbarClockControls();
  if (window.TopbarMinimal) window.TopbarMinimal.apply();
  if (window.SdkIsland) window.SdkIsland.apply();
  applyTopbarClockSettings();
  if (typeof applyDashboardLayoutWithTransition === 'function') applyDashboardLayoutWithTransition();
  setSettingsStatus('settings_saved', 'ok');
}

// A whole bar at once (a `topbar` share code, js/topbar-share.js): look, style,
// island, buttons and rails land together, then every control and both chromes
// repaint. `share` comes from TopbarShare.read(); normalizeSettings still
// rebuilds each list.
function applyTopbarSetup(share) {
  hubSettings = normalizeSettings({ ...hubSettings, ...TopbarShare.patch(hubSettings, share) });
  saveHubSettings();
  TopbarLook.apply(hubSettings.topbarLook);
  syncTopbarStyleControls();
  syncTopbarClockControls();
  if (window.TopbarLookSettings) window.TopbarLookSettings.sync();
  if (window.TopbarButtonOptions) window.TopbarButtonOptions.sync();
  if (window.TopbarMinimal) window.TopbarMinimal.apply();
  if (window.SdkIsland) window.SdkIsland.apply();
  applyTopbarClockSettings();
  if (typeof applyDashboardLayoutWithTransition === 'function') applyDashboardLayoutWithTransition();
}

// Built-in island segment id → i18n label key (editor rows).
const TOPBAR_ISLAND_LABELS = { time: 'topbar_el_time', date: 'topbar_el_date', weather: 'topbar_el_weather', media: 'topbar_el_media', vitals: 'topbar_el_vitals', dots: 'topbar_el_dots', badges: 'topbar_el_badges', claude: 'topbar_el_claude', codex: 'topbar_el_codex', perf: 'topbar_el_perf' };
// Chrome-button id → i18n label key. Must stay in step with ACTION_SELECTORS in
// js/topbar-minimal.js and with the canonical list in BOTH normalizers
// (js/settings.js and its server.js twin) — pinned by test/topbar-island-sync.
const TOPBAR_ACTION_LABELS = {
  lock: 'topbar_btn_lock', ambient: 'topbar_btn_ambient', xenon: 'topbar_btn_xenon',
  search: 'topbar_btn_search', mini: 'topbar_btn_mini', layout: 'topbar_btn_layout',
  settings: 'topbar_btn_settings', apps: 'topbar_btn_apps', favorites: 'topbar_btn_favorites',
};
const EYE_OPEN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5C5 5 2 12 2 12s3 7 10 7 10-7 10-7-3-7-10-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"/></svg>';
const EYE_OFF_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.8 3.2 1.4 4.6l3.1 3.1A12.9 12.9 0 0 0 2 12s3 7 10 7a10.8 10.8 0 0 0 4.4-.9l3 3 1.4-1.4L2.8 3.2ZM12 16a4 4 0 0 1-3.9-4.9l1.7 1.7A2 2 0 0 0 12 14a2 2 0 0 0 .2 0l1.7 1.7A4 4 0 0 1 12 16Zm0-11c7 0 10 7 10 7a13 13 0 0 1-2.2 3.2l-2.9-2.9A4 4 0 0 0 12 8a4 4 0 0 0-.4 0L9.2 5.6A10.9 10.9 0 0 1 12 5Z"/></svg>';
const CARET_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// Which segment option panels are open. View-only state: it survives the
// editor's full re-render but is deliberately never persisted.
const _islandOpenRows = new Set();
const GRIP_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// Reflect the island anchor and (re)render the built-in visibility/order list.
function syncTopbarClockControls() {
  const cfg = hubSettings.topbarClock || {};
  const align = ['center', 'left', 'right'].includes(cfg.align) ? cfg.align : 'center';
  document.querySelectorAll('.settings-topbar-align[data-topbar-align]').forEach(btn => {
    const active = btn.dataset.topbarAlign === align;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  renderTopbarIslandEditor();
  renderTopbarActionsEditor();
  const takeovers = $('settings-island-takeovers');
  if (takeovers) takeovers.checked = cfg.takeovers !== false;
  // The look page reads the button sides too (a rail holding Settings or Layout).
  if (window.TopbarLookSettings) window.TopbarLookSettings.sync();
}

// Build one editor list: a row per item in display order, each with a drag handle
// (reorder) and an eye toggle (show/hide). Shared by the island-segment list and
// the chrome-button list so the two cannot drift apart; the caller supplies the
// host, the items, the label map and the two writers.
function renderTopbarSegmentEditor(opts) {
  const host = document.getElementById(opts.hostId);
  if (!host) return;
  const items = Array.isArray(opts.items) ? opts.items : [];
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
    label.textContent = typeof opts.labelOf === 'function' ? opts.labelOf(it.id) : t(opts.labels[it.id] || it.id);

    const hidden = it.hidden === true;
    // A row may refuse to be hidden (Settings). The eye stays, disabled and
    // explained: a control that silently disappears reads as a fault, and the
    // user still needs to see that this one is deliberately always on.
    const locked = typeof opts.locked === 'function' && opts.locked(it.id);
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'island-edit-eye';
    eye.classList.toggle('is-hidden', hidden);
    eye.classList.toggle('is-locked', locked);
    eye.disabled = locked;
    eye.setAttribute('aria-pressed', String(!hidden));
    eye.title = locked ? t('topbar_btn_always_hint') : t(hidden ? 'topbar_el_show' : 'topbar_el_hide');
    eye.innerHTML = hidden ? EYE_OFF_SVG : EYE_OPEN_SVG; // static, trusted markup
    if (!locked) eye.addEventListener('click', () => opts.onToggle(it.id));

    row.append(handle, label);
    if (typeof opts.buildSide === 'function') {
      const side = opts.buildSide(it);
      if (side) row.append(side);
    }
    // Segments that carry their own options get a chevron. The open/closed state
    // is view-only (never persisted) but must survive the full re-render every
    // settings change triggers, or toggling the option inside the panel would
    // slam the panel shut.
    const sub = typeof opts.buildOptions === 'function' ? opts.buildOptions(it.id) : null;
    if (sub) {
      const caret = document.createElement('button');
      caret.type = 'button';
      caret.className = 'island-edit-caret';
      caret.title = t('topbar_el_options');
      caret.setAttribute('aria-expanded', String(_islandOpenRows.has(it.id)));
      caret.innerHTML = CARET_SVG; // static, trusted markup
      caret.addEventListener('click', () => {
        const open = !_islandOpenRows.has(it.id);
        if (open) _islandOpenRows.add(it.id); else _islandOpenRows.delete(it.id);
        row.classList.toggle('is-open', open);
        sub.hidden = !open;
        caret.setAttribute('aria-expanded', String(open));
      });
      row.append(caret, eye, sub);
      row.classList.toggle('is-open', _islandOpenRows.has(it.id));
      sub.hidden = !_islandOpenRows.has(it.id);
    } else {
      row.append(eye);
    }
    host.appendChild(row);
  });
  initTopbarIslandDrag(host, opts.onReorder);
}

function renderTopbarIslandEditor() {
  renderTopbarSegmentEditor({
    hostId: 'topbar-island-editor',
    items: (hubSettings.topbarClock && Array.isArray(hubSettings.topbarClock.items))
      ? hubSettings.topbarClock.items : [],
    labels: TOPBAR_ISLAND_LABELS,
    onToggle: toggleTopbarIslandItem,
    onReorder: reorderTopbarIslandItem,
    buildOptions: islandItemOptions,
  });
}

// The chrome buttons. Same component, plus a left/right control per row: unlike
// an island segment, a button lives in one of two containers and the user gets to
// say which. Ordering is within the side it ends up on.
// Drawn in Settings → Top bar and, while it is open, in the bar panel of
// Layout mode (js/topbar-layout-panel.js): two views of the same list.
function renderTopbarActionsEditor() {
  ['topbar-actions-editor', 'tbp-actions-editor'].forEach(renderTopbarActionsEditorIn);
}

function renderTopbarActionsEditorIn(hostId) {
  renderTopbarSegmentEditor({
    hostId,
    items: _topbarActionItems(),
    labels: TOPBAR_ACTION_LABELS,
    labelOf: topbarActionLabel,
    locked: (id) => id === 'settings' || id === 'layout',
    onToggle: toggleTopbarActionItem,
    onReorder: reorderTopbarActionItem,
    buildSide: buildTopbarActionSide,
    // Each button's own icon, label and colours (js/topbar-button-options.js).
    buildOptions: (id) => (window.TopbarButtonOptions ? TopbarButtonOptions.panel(id) : null),
  });
}

// Left/right segmented control for one button row.
function buildTopbarActionSide(item) {
  const wrap = document.createElement('div');
  wrap.className = 'island-edit-side';
  [['left', 'topbar_btn_side_left'], ['right', 'topbar_btn_side_right']].forEach(([side, key]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'island-edit-side-btn' + (item.side === side ? ' active' : '');
    btn.textContent = t(key);
    btn.setAttribute('aria-pressed', String(item.side === side));
    btn.addEventListener('click', () => setTopbarActionSide(item.id, side));
    wrap.appendChild(btn);
  });
  return wrap;
}

// Build the options panel for a segment, or null when it has none.
function islandItemOptions(id) {
  if (id !== 'media' && id !== 'dots') return null;
  const cfg = hubSettings.topbarClock || {};
  const media = id === 'media';
  const sub = document.createElement('div');
  sub.className = 'island-edit-sub';
  const row = document.createElement('label');
  row.className = 'settings-toggle-row full';
  const input = document.createElement('input');
  input.className = 'settings-check';
  input.type = 'checkbox';
  input.checked = media ? cfg.mediaTakeover === true : cfg.pageLabels === true;
  input.addEventListener('change', () => (media
    ? updateIslandMediaTakeover(input.checked)
    : updateIslandPageLabels(input.checked)));
  const line = document.createElement('span');
  line.className = 'settings-label-line';
  const name = document.createElement('span');
  name.textContent = t(media ? 'topbar_el_media_full' : 'topbar_el_dots_labels');
  const hint = document.createElement('span');
  hint.className = 'settings-hint';
  hint.textContent = t(media ? 'topbar_el_media_full_hint' : 'topbar_el_dots_labels_hint');
  line.append(name, hint);
  row.append(input, line);
  sub.append(row);
  return sub;
}

// Page dots carry the page names instead of being anonymous circles. The option
// is filed under the island's "Page dots" row because that is where the element
// is configured, but it applies to BOTH chromes — the dots host lives in the
// topbar and Minimal only carries it into the pill.
function updateIslandPageLabels(checked) {
  hubSettings = normalizeSettings({
    ...hubSettings,
    topbarClock: { ...(hubSettings.topbarClock || {}), pageLabels: checked === true },
  });
  saveHubSettings();
  if (window.DashboardPager && typeof DashboardPager.renderDots === 'function') DashboardPager.renderDots();
  // Circles become pills, so the dots row changes width — and in Minimal that row
  // is INSIDE the island pill, whose width is what every top-row tile was tucked
  // clear of. Without this the pill grows over tile headers that keep their stale
  // inset until some unrelated event happens to reflow. Same rule sdk-badges.js
  // follows when a chip appears: a structural change re-runs the island layout.
  applyTopbarClockSettings();
  setSettingsStatus('settings_saved', 'ok');
}

// While a track plays, hand the whole capsule to the player and step the other
// segments aside; they come back the moment it pauses or stops. The capsule
// keeps its own natural size either way — it hugs the player exactly as it hugs
// the clock, and never stretches to the width of the screen.
function updateIslandMediaTakeover(checked) {
  hubSettings = normalizeSettings({
    ...hubSettings,
    topbarClock: { ...(hubSettings.topbarClock || {}), mediaTakeover: checked === true },
  });
  saveHubSettings();
  if (window.TopbarMedia && typeof TopbarMedia.apply === 'function') TopbarMedia.apply();
  setSettingsStatus('settings_saved', 'ok');
}

// Pointer-based vertical reorder for the island editor, delegated once on the
// list host. touch-action:none on the grip (CSS) lets the drag own the gesture
// without the settings panel scrolling. Same tap-vs-drag shape as app favorites.
// Bound once PER HOST — the two lists are separate elements with separate
// writers, so a single module-level flag would arm whichever rendered first and
// leave the other permanently undraggable.
const _islandDragBound = new WeakSet();
function initTopbarIslandDrag(host, onReorder) {
  if (_islandDragBound.has(host)) return;
  _islandDragBound.add(host);
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
    onReorder(fromIndex, insert);
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

// Move a chrome button to a new position. Order is a single list; which side a
// button ends up on is its own field, so a reorder never changes a side.
function reorderTopbarActionItem(fromIndex, toIndex) {
  const items = _topbarActionItems();
  if (fromIndex < 0 || fromIndex >= items.length) return;
  const [moved] = items.splice(fromIndex, 1);
  items.splice(Math.max(0, Math.min(items.length, toIndex)), 0, moved);
  _saveTopbarActions(items);
}

// Show/hide a chrome button. The two doors back in — Settings and Layout — are
// refused here as well as in the normalizer: the editor disables their eyes, but
// this is the function a future caller would reach for.
function toggleTopbarActionItem(id) {
  if (id === 'settings' || id === 'layout') return;
  _saveTopbarActions(_topbarActionItems().map(it => (
    it.id === id ? { ...it, hidden: it.hidden !== true } : it
  )));
}

function setTopbarActionSide(id, side) {
  if (side !== 'left' && side !== 'right') return;
  _saveTopbarActions(_topbarActionItems().map(it => (it.id === id ? { ...it, side } : it)));
}

// The saved list plus any widget button on screen that is not in it yet (it
// sits at the end of the left side until then), so the editor's indices match
// the list it saves and moving such a button saves it.
function _topbarActionItems() {
  const saved = (hubSettings.topbarClock && Array.isArray(hubSettings.topbarClock.actions))
    ? hubSettings.topbarClock.actions.map(it => ({ ...it })) : [];
  const live = window.SdkTopbarButton ? SdkTopbarButton.live() : [];
  for (const b of live) {
    if (!saved.some(it => it.id === b.id)) saved.push({ id: b.id, side: 'left', hidden: false });
  }
  return saved;
}

// A removed package takes its bar button with it: its place in the list and the
// look the user gave it. Returns the two keys to merge, unchanged when there is
// nothing to drop.
function withoutSdkTopbarButtons(settings, pkgIds) {
  const gone = new Set((Array.isArray(pkgIds) ? pkgIds : []).map(id => 'sdk:' + id));
  const clock = (settings && settings.topbarClock) || {};
  const look = (settings && settings.topbarLook) || {};
  const buttons = { ...(look.buttons || {}) };
  for (const id of gone) delete buttons[id];
  return {
    topbarClock: { ...clock, actions: (Array.isArray(clock.actions) ? clock.actions : []).filter(it => !(it && gone.has(it.id))) },
    topbarLook: { ...look, buttons },
  };
}

// A built-in button by its translated name; a widget's by the label it shows,
// or its package id while the widget is not running.
function topbarActionLabel(id) {
  if (typeof id === 'string' && id.startsWith('sdk:')) {
    const live = window.SdkTopbarButton ? SdkTopbarButton.live().find(b => b.id === id) : null;
    return live ? live.label : id.slice(4);
  }
  return t(TOPBAR_ACTION_LABELS[id] || id);
}

function _saveTopbarActions(actions) {
  hubSettings = normalizeSettings({
    ...hubSettings,
    topbarClock: { ...(hubSettings.topbarClock || {}), actions },
  });
  saveHubSettings();
  syncTopbarClockControls();
  applyTopbarClockSettings();
  setSettingsStatus('settings_saved', 'ok');
}

function _saveTopbarIslandItems(items) {
  const hidden = new Map(items.map((item) => [item.id, item.hidden === true]));
  hubSettings = normalizeSettings({
    ...hubSettings,
    topbarClock: { ...(hubSettings.topbarClock || {}), items },
    // Keep the old feature-local flags in sync for runtimes predating the
    // centralized editor. normalizeTopbarClock v2 owns migration thereafter.
    claudeWidget: { ...(hubSettings.claudeWidget || {}), topbar: !hidden.get('claude') },
    vitals: { ...(hubSettings.vitals || {}), topbar: !hidden.get('vitals') },
  });
  saveHubSettings();
  syncTopbarClockControls();
  applyTopbarClockSettings();
  setSettingsStatus('settings_saved', 'ok');
}

// Push visibility onto both chromes and ordering/anchor onto Minimal.
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
    if (window.TopbarMinimal && window.TopbarMinimal.applyIslandLayout) window.TopbarMinimal.applyIslandLayout();
  }
}

const ISLAND_SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

function dynamicIslandHiddenSources() {
  const list = hubSettings.topbarClock && hubSettings.topbarClock.hiddenSources;
  return Array.isArray(list) ? list.slice() : [];
}

// Installed packages are the source of truth: an uninstalled Vanguard/Claude/
// Teleprompter contribution never leaves a stale switch behind in Settings.
async function renderDynamicIslandSources() {
  const host = $('settings-island-sources');
  if (!host || !window.CustomWidget || typeof CustomWidget.getPackages !== 'function') return;
  host.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'island-source-empty';
  loading.textContent = t('settings_island_loading');
  host.appendChild(loading);
  let payload;
  try { payload = await CustomWidget.getPackages(); }
  catch { payload = { packages: [] }; }
  if (!host.isConnected) return;
  const packages = (payload && Array.isArray(payload.packages) ? payload.packages : [])
    .filter((pkg) => pkg && (pkg.island === true || pkg.islandDynamic === true || pkg.badge === true || pkg.mini === true || pkg.topbarButton === true))
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  host.replaceChildren();
  if (!packages.length) {
    const empty = document.createElement('div');
    empty.className = 'island-source-empty';
    empty.textContent = t('settings_island_empty');
    host.appendChild(empty);
    return;
  }
  const hidden = new Set(dynamicIslandHiddenSources());
  packages.forEach((pkg) => {
    const row = document.createElement('label');
    row.className = 'island-source-row';

    const copy = document.createElement('span');
    copy.className = 'island-source-copy';
    const title = document.createElement('strong');
    title.textContent = String(pkg.name || pkg.id);
    const capabilities = document.createElement('span');
    capabilities.className = 'island-source-capabilities';
    const keys = [];
    if (pkg.islandFull === true) keys.push('island_source_full');
    else if (pkg.islandDynamic === true) keys.push('island_source_dynamic');
    else if (pkg.island === true) keys.push('island_source_live');
    if (pkg.badge === true) keys.push('island_source_badge');
    if (pkg.mini === true) keys.push('island_source_mini');
    capabilities.textContent = keys.map((key) => t(key)).join(' · ');
    copy.append(title, capabilities);

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'settings-check';
    toggle.checked = !hidden.has(pkg.id);
    toggle.setAttribute('aria-label', String(pkg.name || pkg.id));
    toggle.addEventListener('change', () => toggleDynamicIslandSource(pkg.id, toggle.checked));
    row.append(copy, toggle);
    host.appendChild(row);
  });
}

function toggleDynamicIslandSource(pkgId, enabled) {
  if (typeof pkgId !== 'string' || !ISLAND_SOURCE_ID_RE.test(pkgId)) return;
  const hidden = new Set(dynamicIslandHiddenSources());
  if (enabled) hidden.delete(pkgId);
  else hidden.add(pkgId);
  hubSettings = normalizeSettings({
    ...hubSettings,
    topbarClock: { ...(hubSettings.topbarClock || {}), hiddenSources: Array.from(hidden) },
  });
  saveHubSettings();
  ['SdkIsland', 'SdkBadges', 'SdkMini', 'SdkTopbarButton'].forEach((name) => { if (window[name]) window[name].apply(); });
  // Switched off there, a package also gives up its hidden background frame.
  if (window.CustomWidget && CustomWidget.syncBackground) CustomWidget.syncBackground();
  setSettingsStatus('settings_saved', 'ok');
}

function updateDynamicIslandTakeovers(checked) {
  hubSettings = normalizeSettings({
    ...hubSettings,
    topbarClock: { ...(hubSettings.topbarClock || {}), takeovers: checked === true },
  });
  saveHubSettings();
  syncTopbarClockControls();
  if (window.SdkIsland) window.SdkIsland.apply();
  setSettingsStatus('settings_saved', 'ok');
}

// Puts the WHOLE bar back to how it shipped: chrome style, island position,
// island elements, the button layout (hidden/order/side), the rails, the clock
// format and every per-package opt-out. It asks first — since v4.11.4 this throws
// away an arrangement the user may have spent real time on, and there is no undo.
async function resetDynamicIslandSettings() {
  if (typeof settingsPrompt === 'function') {
    const ok = await settingsPrompt({
      type: 'confirm',
      title: t('settings_island_reset'),
      message: t('settings_island_reset_confirm'),
      okLabel: t('settings_island_reset'),
    });
    if (ok !== true) return;
  }
  const items = DEFAULT_HUB_SETTINGS.topbarClock.items.map((item) => ({ ...item }));
  const actions = DEFAULT_HUB_SETTINGS.topbarClock.actions.map((item) => ({ ...item }));
  hubSettings = normalizeSettings({
    ...hubSettings,
    topbarStyle: DEFAULT_HUB_SETTINGS.topbarStyle,
    topbarRails: { ...DEFAULT_HUB_SETTINGS.topbarRails },
    topbarRailsAutoHide: DEFAULT_HUB_SETTINGS.topbarRailsAutoHide,
    topbarLook: DEFAULT_HUB_SETTINGS.topbarLook,
    clockFormat: DEFAULT_HUB_SETTINGS.clockFormat,
    topbarClock: { version: 2, align: 'center', takeovers: true, mediaTakeover: false, pageLabels: false, hiddenSources: [], items, actions },
    dashboardLayout: { ...getDashboardLayout(), topbarHidden: false },
    claudeWidget: { ...(hubSettings.claudeWidget || {}), topbar: true },
    vitals: { ...(hubSettings.vitals || {}), topbar: false },
  });
  saveHubSettings();
  syncTopbarStyleControls();
  syncTopbarClockControls();
  syncClockFormatControls();
  if (window.TopbarLook) TopbarLook.apply(hubSettings.topbarLook);
  if (window.TopbarMinimal) window.TopbarMinimal.apply();
  applyTopbarClockSettings();
  if (typeof tickClock === 'function') tickClock();
  if (typeof renderLockClock === 'function') renderLockClock();
  if (window.CustomWidget && typeof window.CustomWidget.refreshTheme === 'function') window.CustomWidget.refreshTheme();
  if (window.SdkIsland) window.SdkIsland.apply();
  if (window.SdkBadges) window.SdkBadges.apply();
  if (window.SdkMini) window.SdkMini.apply();
  if (window.SdkTopbarButton) window.SdkTopbarButton.apply();
  renderDynamicIslandSources();
  if (typeof applyDashboardLayoutWithTransition === 'function') applyDashboardLayoutWithTransition();
  setSettingsStatus('settings_saved', 'ok');
}

window.addEventListener('xenon:sdk-packages', () => {
  if (_settingsCat === 'island') renderDynamicIslandSources();
});

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

// How many upcoming events the Calendar tile lists, and how far ahead it looks.
// Display-only, like the first-day-of-week beside them: repaint immediately so
// the change is visible without waiting for the next calendar refresh.
function updateUpcomingCount(value) {
  const n = Number(value);
  if (![3, 5, 8, 10].includes(n)) return;
  hubSettings = normalizeSettings({ ...hubSettings, upcomingCount: n });
  saveHubSettings();
  syncUpcomingControls();
  if (typeof renderUpcoming === 'function') renderUpcoming();
  setSettingsStatus('settings_saved', 'ok');
}

function updateUpcomingDays(value) {
  const n = Number(value);
  if (![0, 7, 14, 30].includes(n)) return;
  hubSettings = normalizeSettings({ ...hubSettings, upcomingDays: n });
  saveHubSettings();
  syncUpcomingControls();
  if (typeof renderUpcoming === 'function') renderUpcoming();
  setSettingsStatus('settings_saved', 'ok');
}

function updateUpcomingColumns(value) {
  const n = Number(value);
  if (![0, 1, 2].includes(n)) return;
  hubSettings = normalizeSettings({ ...hubSettings, upcomingColumns: n });
  saveHubSettings();
  syncUpcomingControls();
  if (typeof renderUpcoming === 'function') renderUpcoming();
  setSettingsStatus('settings_saved', 'ok');
}

function syncUpcomingControls() {
  for (const [id, value] of [['settings-upcoming-count', hubSettings.upcomingCount],
    ['settings-upcoming-days', hubSettings.upcomingDays],
    ['settings-upcoming-cols', hubSettings.upcomingColumns]]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.value = String(value);
    // The native <select> is hidden behind the custom dropdown, so setting
    // .value alone leaves the visible label on the old option.
    if (typeof el._csSync === 'function') el._csSync();
  }
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
  repaintTempUnits();
  setSettingsStatus('settings_weather_saved', 'ok');
}

// The unit for hardware readings: 'auto' follows the weather unit above, 'c' and
// 'f' pin it, for people who read the forecast in °F and their CPU in °C.
function updateHwTempUnit(unit) {
  if (!['auto', 'c', 'f'].includes(unit)) return;
  hubSettings = normalizeSettings({ ...hubSettings, hwTempUnit: unit });
  saveHubSettings();
  syncWeatherSettingsControls();
  repaintTempUnits();
  setSettingsStatus('settings_saved', 'ok');
}

// Either unit can change what the CPU/GPU headers say (hardware 'auto' follows
// the weather one), so both setters repaint them and tell installed widgets.
function repaintTempUnits() {
  if (typeof applySystem === 'function' && typeof lastSystemData !== 'undefined' && lastSystemData) applySystem(lastSystemData);
  // Widgets draw temperatures too (a monitor tile, a weather tile). Tell them,
  // the same way a theme or language change is told — see refreshTempUnit.
  if (window.CustomWidget && typeof window.CustomWidget.refreshTempUnit === 'function') {
    window.CustomWidget.refreshTempUnit();
  }
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

// Footer "Riavvia Xenon" (feature request): a clean restart to clear transient /
// stuck state — a widget that got wedged, a background probe that stalled — WITHOUT
// losing anything. Settings, dashboard layout, backgrounds and widgets are all
// persisted (settings.json + localStorage) and re-hydrate on launch, so nothing
// personal is touched. Native → full app relaunch (app.restart via native-bridge);
// a plain browser → dashboard reload. Confirmed first, since it interrupts the
// session.
function restartXenon() {
  const msg = t('settings_restart_confirm', 'Riavviare Xenon? Le tue impostazioni, i widget e gli sfondi restano: serve solo a ripulire eventuali blocchi.');
  if (typeof window.confirm === 'function' && !window.confirm(msg)) return;
  setSettingsStatus('settings_restart_running', 'ok');
  if (typeof window.restartXenonApp === 'function') window.restartXenonApp();
  else { try { window.location.reload(); } catch (e) { /* nothing else to try */ } }
}

// Footer "Ripristina tutte le impostazioni": a full reset of every preference to
// its default. Only the dashboard layout and the external calendar feed
// subscriptions are preserved (they're structural/personal, not "settings" the
// user is trying to reset). Server-only secrets (Gemini key, integration
// passwords/tokens) are preserved server-side on save, so they survive this too.
// Confirmed, since v4.11.7, and the confirmation names what goes. This button
// used to fire on a single click — no dialog — from the accent-coloured PRIMARY
// slot at the bottom of the panel, directly under "Restart Xenon", whose own
// hint promises that nothing will be lost. Reported on Discord by a supporter
// who pressed it by mistake: "i resetted xenon by error and lost everything".
//
// "Settings" undersells it, which is the other half of the problem. The layout
// and the calendar feeds survive; every widget tile's ASSIGNMENT and permission
// grant, every install receipt, every saved page preset, every custom theme,
// background and Ambient scene do not. The packages stay on disk — nothing is
// uninstalled — but the dashboard comes back empty, which is what "everything"
// means to the person looking at it.
async function resetAllSettings() {
  const title = t('settings_reset_all', 'Reset all settings');
  const msg = t('settings_reset_all_confirm',
    'Reset every setting to its defaults? Your dashboard layout stays, but each tile loses the widget assigned to it, along with its permissions, your install list, your saved page presets, and your custom themes, backgrounds and Ambient scenes. Installed widgets stay on your PC and can be assigned again. This cannot be undone.');
  const ok = (typeof settingsPrompt === 'function')
    ? await settingsPrompt({ type: 'confirm', danger: true, title, message: msg, okLabel: title })
    : (typeof window.confirm !== 'function' || window.confirm(msg));
  if (!ok) return;
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
  // The key never comes back from the server, so the field shows a "saved"
  // placeholder rather than the value — same treatment as the other providers.
  const keyInput = $('settings-gemini-key');
  if (keyInput) {
    keyInput.value = hubSettings.geminiApiKey || '';
    keyInput.placeholder = hubSettings.geminiApiKeySet ? t('settings_key_saved') : t('settings_ai_key_placeholder');
  }
  const keyReset = $('settings-gemini-reset');
  if (keyReset) keyReset.hidden = !hubSettings.geminiApiKeySet;
  const sdkAiCap = $('settings-sdk-ai-cap');
  if (sdkAiCap) {
    sdkAiCap.replaceChildren(...SDK_AI_DAILY_CAPS.map((n) => {
      const o = document.createElement('option');
      o.value = String(n);
      o.textContent = t('settings_sdk_ai_cap_n').replace('{n}', String(n));
      return o;
    }));
    sdkAiCap.value = String(hubSettings.sdkAiDailyCap);
  }
  const ttsToggle = $('settings-ai-tts');
  if (ttsToggle) ttsToggle.checked = hubSettings.aiTtsEnabled !== false;
  const proToggle = $('settings-ai-pro');
  if (proToggle) proToggle.checked = hubSettings.aiProReasoning === true;
  const liveToggle = $('settings-ai-live');
  if (liveToggle) liveToggle.checked = hubSettings.aiLiveVoice === true;
  const ambientToggle = $('settings-ai-voice-ambient');
  if (ambientToggle) ambientToggle.checked = hubSettings.aiVoiceAmbient === true;
  syncAiEdgeGlowControl();
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

// Settings sections that cannot exist on this platform, removed rather than
// left to fail when tapped.
//
// The README's promise is that anything unavailable is HIDDEN, not offered and
// then failed — and these two were the exceptions. Remote Control installs
// Sunshine and Tailscale through winget and drives them as Windows services;
// Second screen needs a Windows Indirect Display Driver. On Linux and macOS
// both panels rendered in full and every button led to a spawn failure, which
// reads as a broken feature rather than an absent one.
//
// Marked in the markup with data-settings-win-only so the list lives next to
// the panels themselves, and applied to the nav button and the pane together —
// hiding only one leaves either a dead button or an unreachable pane.
function applyPlatformGating(platform) {
  // Published for the parts of the dashboard that are NOT settings panes and so
  // cannot be gated by markup — the widget palette is the one that matters, since
  // a widget offered there is a promise the tile then has to break. Anything
  // reading it must treat undefined as "not known yet" and offer the widget: a
  // late answer is better than one wrong on Windows.
  window.XenonPlatform = platform || '';
  renderPlatformBeta(platform);
  syncAudioCommsControl();   // a Windows-only row inside a shared pane
  if (platform === 'win32') return;
  document.querySelectorAll('[data-settings-win-only]').forEach((el) => {
    const cat = el.dataset.settingsCat || el.dataset.settingsWinOnly;
    el.hidden = true;
    if (cat) {
      document.querySelectorAll(`.settings-nav-btn[data-settings-cat="${cat}"]`)
        .forEach((b) => { b.hidden = true; });
    }
  });
}

// macOS and Linux are beta, and the honest place to say so is where the build
// already names itself: next to the version, at the bottom of the Settings
// sidebar. It states what beta means here — the dashboard is the same, the part
// that reads the machine is what differs — and links to the table that says
// exactly what works where, so nobody has to discover a gap by hitting it.
// Windows renders nothing: a badge on the platform Xenon started on would be
// noise, and the box is only built when it has something true to say.
const PLATFORM_BETA_NAME = { darwin: 'macOS', linux: 'Linux' };
const PLATFORM_BETA_DOC = {
  darwin: 'https://github.com/marcimastro98/Xenon#macos',
  linux: 'https://github.com/marcimastro98/Xenon#linux',
};
function renderPlatformBeta(platform) {
  const box = document.getElementById('settings-platform-beta');
  if (!box) return;
  const name = PLATFORM_BETA_NAME[platform];
  box.textContent = '';
  box.hidden = !name;
  if (!name) return;

  const head = document.createElement('div');
  head.className = 'settings-platform-beta-head';
  const chip = document.createElement('span');
  chip.className = 'settings-platform-beta-chip';
  chip.textContent = (typeof t === 'function' ? t('settings_platform_beta') : 'Beta');
  const os = document.createElement('span');
  os.className = 'settings-platform-beta-os';
  os.textContent = name;
  head.append(chip, os);

  const note = document.createElement('p');
  note.className = 'settings-platform-beta-note';
  const tpl = (typeof t === 'function' ? t('settings_platform_beta_note') : '');
  note.textContent = (tpl || '{os} support is in beta.').replace('{os}', name);

  const link = document.createElement('a');
  link.className = 'settings-platform-beta-link';
  link.href = PLATFORM_BETA_DOC[platform];
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = (typeof t === 'function' ? t('settings_platform_beta_link') : 'What works where');

  box.append(head, note, link);
}

// Show the running build version at the bottom of the Settings sidebar. Read
// from the server (which sources it from package.json) so it always matches the
// shipped build; stays empty and unobtrusive if the request fails.
// The native app's own version, only when it differs from the dashboard's. The
// two update through separate channels, and a bare "Xenon v4.11.12" over an app
// still on 4.11.7 hid exactly the half that had not updated.
function shellVersionSuffix(version) {
  const caps = window.__XENON_NATIVE_CAPS__ || {};
  const shell = String(caps.shellVersion || '').replace(/^v/i, '');
  if (!shell || shell === String(version).replace(/^v/i, '')) return '';
  return ' · ' + t('settings_version_app').replace('{v}', shell);
}

// The mirror needs a reader and not every system has one: the server says which.
// Where there is none, its two switches have nothing to turn on.
async function syncNotifMirrorSupport() {
  const d = await apiJson('/notifications/windows');
  if (!d || d.supported !== false) return;
  for (const id of ['settings-winnotif-row', 'settings-winnotif-hide-row']) {
    const row = $(id);
    if (row) row.hidden = true;
  }
}

async function initSettingsVersion() {
  const out = document.getElementById('settings-version');
  if (!out) return;
  try {
    const { version, platform } = await (await fetch('/version')).json();
    if (version) out.textContent = `Xenon v${version}${shellVersionSuffix(version)}`;
    if (platform) applyPlatformGating(platform);
  } catch { /* leave blank — no version indicator is better than a broken one */ }
  syncNotifMirrorSupport();
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

// Server writes the backup to disk and returns the path. Used as the
// embedded-view path and as a fallback when a browser download is blocked.
// `pick`: the system folder dialog on the PC first (where the capture engine
// runs), Downloads when there is no dialog.
async function exportBackupToDisk(pick = false) {
  const res = await fetch('/backup/save', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pick }),
  });
  const out = await res.json().catch(() => null);
  if (out && out.ok === true && out.cancelled === true) return;
  if (out && out.error === 'picking') { backupToast('settings_folder_busy'); return; }
  if (!out || out.ok !== true) throw new Error((out && out.error) || 'save_failed');
  backupToast('settings_backup_saved', out.path || '');
}

async function exportBackup() {
  const btn = document.querySelector('[onclick="exportBackup()"]');
  try {
    if (btn) btn.disabled = true;
    // Embedded WebView: no download manager, no save dialog — the server asks
    // where on the PC and saves the file there.
    if (isEmbeddedView()) { await exportBackupToDisk(true); return; }
    // Real browser: "Save as" where it has one (js/save-file.js), else a download.
    const make = async () => {
      const res = await fetch('/backup/export');
      if (!res.ok) throw new Error('export_failed');
      return res.blob();
    };
    const name = 'xenon-backup-' + window.XenonSaveFile.today() + '.json';
    const how = await window.XenonSaveFile.save({ name, types: [window.XenonSaveFile.JSON_TYPE], make });
    if (how !== 'cancelled') backupToast('settings_backup_exported');
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

// Models the site's curated list offers for download — [{tag,label,sizeGB,…}].
// Kept separate from the installed list: one says what you have, the other what
// you could have. Empty until the fetch lands, and empty is a valid state (the
// four preset tiers and the custom field work exactly as before without it).
let _ollamaCatalog = [];

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

  // The download catalog is fetched AFTER the list above is on screen, and never
  // awaited in front of it. It crosses the internet (the file lives on the site
  // so it can carry a model published after this release), and putting that in
  // front of the local list meant the models you already have appeared only once
  // a request to another machine had finished — on the first open after a
  // restart, long enough to open the dropdown and find them missing. An empty
  // catalog is a normal state, not an error: the list simply stays as it was.
  try {
    const cat = await (await fetch('/api/ai/models?provider=ollama')).json();
    _ollamaCatalog = Array.isArray(cat && cat.catalog) ? cat.catalog : [];
  } catch {
    _ollamaCatalog = [];
  }
  if (_ollamaCatalog.length) {
    _populateCatalogModelOptions();
    _reflectModelSelection();
  }
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
  _populateCatalogModelOptions();
  _reflectModelSelection();
}

// Models from the site's curated list that are NOT installed yet, so the
// dropdown can offer a model published after this release instead of only the
// four tiers written into the app. Selecting one leaves it un-installed; the
// Download button below the list is what fetches it, and the hardware gate on
// the server still has the last word on whether it may.
function _populateCatalogModelOptions() {
  const modelSel = $('ai-model-select');
  if (!modelSel) return;
  const prev = $('ai-model-catalog-group');
  if (prev) prev.remove();
  const already = new Set([...AI_KNOWN_MODELS, ..._ollamaInstalledModels]);
  const extras = _ollamaCatalog.filter(m => m && m.tag && !already.has(m.tag) && !_isModelInstalled(m.tag));
  if (!extras.length) return;
  const group = document.createElement('optgroup');
  group.id = 'ai-model-catalog-group';
  group.label = t('ai_model_catalog_group');
  for (const m of extras) {
    const opt = document.createElement('option');
    opt.value = m.tag;
    // The size is the thing worth knowing before picking: these are gigabytes.
    opt.textContent = m.sizeGB ? `${m.label || m.tag} (${m.sizeGB} GB)` : (m.label || m.tag);
    group.appendChild(opt);
  }
  const customOpt = modelSel.querySelector('option[value="__custom__"]');
  modelSel.insertBefore(group, customOpt);
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
  // The select is a data-custom-select: assigning .value fires no event, so the
  // visible trigger would keep the previous label.
  if (typeof modelSel._csSync === 'function') modelSel._csSync();
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
      ? `${t('ai_model_in_use')} ${tag}`
      : `${tag}, ${t('ai_model_not_installed')}`;
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
  show('settings-localapi-panel', provider === 'localapi');
  show('settings-gemini-setup', provider === 'gemini');
  // Live voice is Gemini Live; on any other provider voice is turn-based.
  show('settings-ai-live-row', provider === 'gemini');
  show('settings-gemini-key-row', provider === 'gemini');
  show('settings-gemini-models', provider === 'gemini');
  show('settings-openai-panel', provider === 'openai');
  show('settings-anthropic-panel', provider === 'anthropic');
  show('settings-cli-panel', AI_CLI_PROVIDERS.includes(provider));
  show('settings-xenon-panel', provider === 'xenon');
}

// Reflect the persisted provider settings into the AI controls. Safe to call
// repeatedly (it only reads hubSettings and writes control state).
function syncAiProviderControls() {
  const panel = $('ai-local-panel');
  const modelSel = $('ai-model-select');
  if (!panel || !modelSel) return;

  const cfg = hubSettings || {};
  const provider = AI_PROVIDER_IDS.includes(cfg.aiProvider) ? cfg.aiProvider : 'gemini';
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
  if (provider === 'openai' || provider === 'anthropic' || provider === 'gemini' || provider === 'localapi') _aiLoadProviderModels(provider);
  if (window.LocalServerSettings) window.LocalServerSettings.sync();
  if (AI_CLI_PROVIDERS.includes(provider)) aiCliRefresh(provider, false);
  // The credits card at the top shows the balance on Xenon AI and the offer
  // otherwise, so it is painted for every provider.
  if (window.XenonCreditsSettings) window.XenonCreditsSettings.refresh();

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
  hwStats.textContent = `RAM ${scan.ram} GB · VRAM ${scan.vram} GB · ${scan.cores} core · ${scan.tier}`;
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
    aiProvider: (checked && AI_PROVIDER_IDS.includes(checked.value)) ? checked.value : 'gemini',
    ollamaModel: model,
    ollamaUrl: (urlInput && urlInput.value.trim()) || 'http://localhost:11434',
  });
  saveHubSettings();
  // Bit's roast row says what this provider spends.
  syncVitalsAiBank();
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
    const { enabled, supported } = await (await fetch('/api/ai-local/ollama-autostart')).json();
    cb.checked = !!enabled;
    // On Linux Ollama's own installer sets up the service: nothing for Xenon to switch.
    cb.closest('.ai-autostart-row').hidden = supported === false;
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
      else if (AI_CLI_PROVIDERS.includes(r.value)) aiCliRefresh(r.value, true);
      else if (r.value === 'xenon') { if (window.XenonCreditsSettings) window.XenonCreditsSettings.refresh(); }
      else _aiLoadProviderModels(r.value);
      if (window.XenonCreditsSettings) window.XenonCreditsSettings.render();
      if (window.XenonCredits) window.XenonCredits.renderChips();
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

// THE answer to "is a Gemini key configured", for every surface that used to
// test `hubSettings.geminiApiKey` directly. Since the key is redacted on the
// wire, that truthiness test is false on a freshly loaded page even when a key
// has been saved for months — it would have turned every AI surface into
// "invalid key", which is exactly the failure the old comment in server.js
// predicted and used as the reason not to redact. The value is still checked
// first so the gate opens the instant the user finishes typing one, before the
// save has round-tripped.
function geminiKeyReady(settingsObj) {
  const s = settingsObj || (typeof hubSettings === 'object' ? hubSettings : null);
  return !!(s && (String(s.geminiApiKey || '').trim() || s.geminiApiKeySet === true));
}

function updateAiKey(value) {
  const v = String(value || '').trim().slice(0, 200);
  // Keep *Set true through the redacted round-trip (the server answers with
  // key:'' once it has stored it); an explicit removal goes through resetAiKey.
  hubSettings = normalizeSettings({ ...hubSettings, geminiApiKey: v, geminiApiKeySet: v.length > 0 || hubSettings.geminiApiKeySet === true });
  saveHubSettings();
  // Notify ai.js if wake word state needs to change
  if (typeof onAiKeyUpdated === 'function') onAiKeyUpdated();
  // Refresh the Media-tile chat (show input once a key is present, hide notice)
  if (typeof updateMediaChatKeyState === 'function') updateMediaChatKeyState();
}

// The only way to actually remove a stored key: a save carrying key:'' WITHOUT
// the flag, which is what `preserveAiProviderCreds` reads as "the user cleared
// it" instead of "this is the redacted copy coming back".
function resetAiKey() {
  hubSettings = normalizeSettings({ ...hubSettings, geminiApiKey: '', geminiApiKeySet: false });
  saveHubSettings();
  if (typeof onAiKeyUpdated === 'function') onAiKeyUpdated();
  if (typeof updateMediaChatKeyState === 'function') updateMediaChatKeyState();
  syncAiSettingsControls();
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
  updateAiModelChoice('openaiModel', value);
}
function updateAnthropicKey(value) {
  const v = String(value || '').trim().slice(0, 200);
  hubSettings = normalizeSettings({ ...hubSettings, anthropicApiKey: v, anthropicApiKeySet: v.length > 0 || hubSettings.anthropicApiKeySet === true });
  saveHubSettings();
  if (typeof updateMediaChatKeyState === 'function') updateMediaChatKeyState();
  if (v.length > 8) _aiScheduleModelRefresh('anthropic'); // a real key was entered → refresh the model list once it's saved
}
function updateAnthropicModel(value) {
  updateAiModelChoice('anthropicModel', value);
}

// ── AI model pickers (Gemini / ChatGPT / Claude) ─────────────────────────────
// Every dropdown is filled LIVE from the provider's own models API (via
// /api/ai/models), so it always reflects what that provider offers today — no
// hardcoded list to keep current. Each one carries two kinds of choice:
//
//   • "Auto", optionally per family ("Auto — Flash"): stored as the `auto` /
//     `auto:<family>` sentinel and resolved server-side on every request, so a
//     model released tomorrow is in use tomorrow. The line under the dropdown
//     names the id it currently resolves to, because a setting whose effect you
//     cannot read is a setting you cannot reason about.
//   • A concrete model: a pin, honoured until the user changes it.
//
// "Custom…" stays as the fallback for a model the list does not carry (or when
// offline), and a saved value is always kept selectable even if the API omits it.
const AI_MODEL_CONTROLS = [
  { provider: 'gemini', role: 'chat', key: 'geminiModel', sel: 'settings-gemini-model' },
  { provider: 'gemini', role: 'chatPro', key: 'geminiModelPro', sel: 'settings-gemini-model-pro' },
  { provider: 'gemini', role: 'tts', key: 'geminiModelTts', sel: 'settings-gemini-model-tts' },
  { provider: 'gemini', role: 'live', key: 'geminiModelLive', sel: 'settings-gemini-model-live' },
  { provider: 'openai', role: 'chat', key: 'openaiModel', sel: 'settings-openai-model' },
  { provider: 'openai', role: 'stt', key: 'openaiSttModel', sel: 'settings-openai-stt-model' },
  { provider: 'openai', role: 'tts', key: 'openaiTtsModel', sel: 'settings-openai-tts-model' },
  { provider: 'anthropic', role: 'chat', key: 'anthropicModel', sel: 'settings-anthropic-model' },
  // A local server's names carry slashes and colons no cloud id has.
  { provider: 'localapi', role: 'chat', key: 'localApiModel', sel: 'settings-localapi-model', normalize: LocalServerFields.sanitizeModel },
];

// Last answer per provider, so re-rendering one row does not re-fetch the list.
const _aiModelCatalog = Object.create(null);

function _aiControlsFor(provider) { return AI_MODEL_CONTROLS.filter(c => c.provider === provider); }

// NOTE the key: `ai_model_auto` is already taken by the Ollama tier dropdown
// ("Auto (consigliato)"), and a duplicate key in the same dictionary silently
// wins over the first — which would have retitled that control too.
function _aiAutoLabel(family) {
  if (!family) return t('ai_model_auto_latest');
  // "Auto — Flash Lite": the family name is the provider's own word for the tier
  // and is not translated; only the "Auto" part is.
  const pretty = family.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return t('ai_model_auto_latest') + ' — ' + pretty;
}

function _aiPopulateModelSelect(ctl, data) {
  const sel = $(ctl.sel);
  if (!sel) return;
  const cust = $(ctl.sel + '-custom');
  const used = $(ctl.sel + '-used');
  const saved = (ctl.normalize || normalizeModelChoice)(hubSettings[ctl.key]);
  const spec = (data && data.roles && data.roles[ctl.role]) || { kind: 'chat', family: '' };
  const all = (data && Array.isArray(data.models)) ? data.models : [];
  const list = all.filter(m => m && m.kind === spec.kind);

  sel.innerHTML = '';
  const autoGroup = document.createElement('optgroup');
  autoGroup.label = t('ai_model_auto_group');
  const addOpt = (parent, value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    parent.appendChild(o);
  };
  addOpt(autoGroup, 'auto', _aiAutoLabel(''));
  const families = [];
  for (const m of list) if (m.family && !families.includes(m.family)) families.push(m.family);
  for (const f of families) addOpt(autoGroup, 'auto:' + f, _aiAutoLabel(f));
  sel.appendChild(autoGroup);

  if (list.length) {
    const pinGroup = document.createElement('optgroup');
    pinGroup.label = t('ai_model_pin_group');
    // A pinned id the API no longer returns must stay selectable, or opening
    // Settings would silently re-point the user's choice at something else.
    if (saved && !saved.startsWith('auto') && !list.some(m => m.id === saved)) addOpt(pinGroup, saved, saved);
    for (const m of list) addOpt(pinGroup, m.id, m.label || m.id);
    sel.appendChild(pinGroup);
  } else if (saved && !saved.startsWith('auto')) {
    addOpt(sel, saved, saved);
  }
  addOpt(sel, '__custom__', t('ai_model_custom'));

  const known = Array.from(sel.options).some(o => o.value === saved);
  sel.value = known ? saved : '__custom__';
  if (cust) {
    cust.hidden = known;
    if (!known) cust.value = saved;
  }
  if (typeof sel._csSync === 'function') sel._csSync(); // .value assignment fires no event

  // The resolved id, shown only when it differs from what the dropdown says.
  if (used) {
    const resolved = (data && data.resolved && data.resolved[ctl.role]) || '';
    const show = resolved && saved.startsWith('auto');
    used.hidden = !show;
    used.textContent = show ? t('ai_model_resolved').replace('{model}', resolved) : '';
  }
}

function _aiRenderProviderControls(provider) {
  const data = _aiModelCatalog[provider] || null;
  for (const ctl of _aiControlsFor(provider)) _aiPopulateModelSelect(ctl, data);
}

async function _aiLoadProviderModels(provider, opts) {
  if (!_aiControlsFor(provider).some(c => $(c.sel))) return;
  // Render from what we already have (or from nothing) first, so the panel is
  // never empty while the request is in flight.
  _aiRenderProviderControls(provider);
  const keySet = provider === 'localapi' ? true // its key is optional
    : provider === 'openai' ? hubSettings.openaiApiKeySet
      : provider === 'anthropic' ? hubSettings.anthropicApiKeySet
        : hubSettings.geminiApiKeySet;
  if (!keySet) return; // no key yet → nothing to fetch
  try {
    const r = await fetch('/api/ai/models?provider=' + provider + ((opts && opts.force) ? '&refresh=1' : ''));
    const d = await r.json();
    if (d && Array.isArray(d.models)) {
      _aiModelCatalog[provider] = d;
      _aiRenderProviderControls(provider);
      if (provider === 'localapi' && window.LocalServerSettings) window.LocalServerSettings.showState(d.state || 'offline', d.models.length, d.found);
    }
  } catch {
    // offline — keep whatever the last render showed
    if (provider === 'localapi' && window.LocalServerSettings) window.LocalServerSettings.showState('offline');
  }
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

// One handler for every dropdown: persist the choice, then re-render so the
// "in use" line follows immediately instead of waiting for the next hydrate.
function updateAiModelChoice(key, value) {
  const ctl = AI_MODEL_CONTROLS.find(c => c.key === key);
  const next = ((ctl && ctl.normalize) || normalizeModelChoice)(value);
  hubSettings = normalizeSettings({ ...hubSettings, [key]: next });
  saveHubSettings();
  if (ctl) _aiRenderProviderControls(ctl.provider);
}

function onAiModelSelect(key, value) {
  const ctl = AI_MODEL_CONTROLS.find(c => c.key === key);
  const cust = ctl ? $(ctl.sel + '-custom') : null;
  if (value === '__custom__') { if (cust) { cust.hidden = false; cust.value = ''; cust.focus(); } return; }
  if (cust) cust.hidden = true;
  updateAiModelChoice(key, value);
}

function onOpenaiModelSelect(v) { onAiModelSelect('openaiModel', v); }

// ── Claude Code / Codex (the user's own subscription) ───────────────────────
// One panel for both. It says whether the program is installed and signed in,
// with what to run when it is not, and offers the models the program itself
// lists. Nothing here handles a credential: sign-in happens in the program.
const AI_CLI_INFO = {
  claudecode: { app: 'Claude Code', login: 'claude auth login', guide: 'https://code.claude.com/docs/en/setup', key: 'claudeCodeModel' },
  codex: { app: 'Codex', login: 'codex login', guide: 'https://developers.openai.com/codex/cli', key: 'codexModel' },
};
let _aiCliSeq = 0;
function _aiCliText(k, info, extra) {
  let s = t(k).replace(/\{app\}/g, info.app).replace(/\{cmd\}/g, info.login);
  if (extra && extra.version != null) s = s.replace(/\{ver\}/g, extra.version ? ' ' + extra.version : '');
  return s;
}
async function aiCliRefresh(provider, fresh) {
  const info = AI_CLI_INFO[provider];
  if (!info) return;
  const seq = ++_aiCliSeq;
  const intro = $('settings-cli-intro');
  if (intro) intro.textContent = _aiCliText('settings_cli_intro', info);
  const guide = $('settings-cli-guide');
  if (guide) { guide.href = info.guide; guide.textContent = _aiCliText('settings_cli_guide', info); }
  const statusEl = $('settings-cli-status');
  const detailEl = $('settings-cli-detail');
  if (statusEl) { statusEl.textContent = t('settings_cli_checking'); statusEl.dataset.state = 'checking'; }
  if (detailEl) { detailEl.textContent = ''; detailEl.hidden = true; }
  _aiCliRenderModels(provider, null);   // "loading" until the program answers
  const q = (fresh ? '&fresh=1' : '');
  // Independent: the list shows as soon as it arrives, whatever the status does.
  const getJson = (url) => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
  getJson('/api/ai/cli/models?provider=' + provider + q).then((list) => {
    if (seq !== _aiCliSeq) return;
    _aiCliRenderModels(provider, (list && Array.isArray(list.models)) ? list.models : []);
  });
  const st = await getJson('/api/ai/cli/status?provider=' + provider + q);
  if (seq !== _aiCliSeq) return;   // the user switched provider meanwhile
  if (!statusEl) return;
  let k = 'settings_cli_unknown', state = 'warn', detail = '';
  if (!st || st.ok === false) {
    // No answer at all: most often a dashboard newer than the Xenon running it.
    k = 'settings_cli_no_server';
  } else if (!st.installed) { k = 'settings_cli_not_installed'; state = 'bad'; }
  else if (st.loggedIn === false) { k = 'settings_cli_not_logged_in'; state = 'bad'; }
  else if (st.loggedIn === true && /api.?key/i.test(String(st.method || ''))) { k = 'settings_cli_api_key'; state = 'warn'; }
  else if (st.loggedIn === true) { k = 'settings_cli_ready'; state = 'ok'; }
  else if (st.detail) detail = t('settings_cli_detail').replace('{detail}', String(st.detail));
  if (st && st.loggedIn === true && st.plan) detail = t('settings_cli_plan').replace('{plan}', String(st.plan));
  statusEl.textContent = _aiCliText(k, info, { version: (st && st.version) || '' });
  statusEl.dataset.state = state;
  if (guide) guide.hidden = state === 'ok';
  if (detailEl) { detailEl.textContent = detail; detailEl.hidden = !detail; }
}
// `models` null = still loading. Each entry is { id, label, version?, resolved? }
// exactly as the program described it; nothing here invents a model.
let _aiCliModels = [];
function _aiCliRenderModels(provider, models) {
  const info = AI_CLI_INFO[provider];
  const sel = $('settings-cli-model');
  if (!sel || !info) return;
  const cur = normalizeCliModel(hubSettings && hubSettings[info.key]);
  sel.replaceChildren();
  const add = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; sel.appendChild(o); return o; };
  if (models === null) {
    add(cur, t('settings_cli_models_loading')).disabled = true;
    sel.value = cur;
    _aiCliShowUsed(null);
    return;
  }
  _aiCliModels = models.filter(m => m && typeof m.id === 'string');
  const ids = new Set();
  // "Opus" + "Opus 5.5" reads as "Opus 5.5"; the default keeps its own name.
  const withVersion = (label, version) => {
    const l = String(label), v = String(version || '');
    if (!v || v.toLowerCase() === l.toLowerCase()) return l;
    return v.toLowerCase().startsWith(l.toLowerCase()) ? v : l + ' · ' + v;
  };
  // The program's own "default" (Claude Code lists it) reads as ours, localized.
  const def = _aiCliModels.find(m => m.id === 'default');
  add('default', withVersion(t('settings_cli_model_default'), def && def.version));
  ids.add('default');
  for (const m of _aiCliModels) {
    if (ids.has(m.id)) continue;
    ids.add(m.id);
    add(m.id, withVersion(m.label || m.id, m.version));
  }
  // A saved model the program no longer lists stays selectable, marked as such.
  if (!ids.has(cur)) add(cur, t('settings_cli_model_saved').replace('{model}', cur));
  sel.value = cur;
  _aiCliShowUsed(cur);
}
// "In use: claude-opus-5-5": the exact model the chosen entry resolves to today.
function _aiCliShowUsed(id) {
  const el = $('settings-cli-model-used');
  if (!el) return;
  const m = id ? _aiCliModels.find(x => x.id === id) : null;
  const resolved = m && m.resolved && m.resolved !== m.id ? m.resolved : '';
  el.textContent = resolved ? t('ai_model_resolved').replace('{model}', resolved) : '';
  el.hidden = !resolved;
}
function onAiCliModelSelect(value) {
  const provider = hubSettings && hubSettings.aiProvider;
  const info = AI_CLI_INFO[provider];
  if (!info) return;
  hubSettings = normalizeSettings({ ...hubSettings, [info.key]: normalizeCliModel(value) });
  saveHubSettings();
  _aiCliShowUsed(normalizeCliModel(value));
}
function aiCliRecheck() {
  const provider = hubSettings && hubSettings.aiProvider;
  if (AI_CLI_PROVIDERS.includes(provider)) aiCliRefresh(provider, true);
}
function onAnthropicModelSelect(v) { onAiModelSelect('anthropicModel', v); }

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
  if (window.AiEdgeGlow) window.AiEdgeGlow.refresh();
}

// Why the native app cannot draw the edge glow here: it draws it wherever it
// draws widget layers (layers/linux.rs `probe`), so the reason is the same.
const AI_EDGE_GLOW_WHY_KEYS = { wayland: 'settings_ai_edge_glow_why_wayland', no_compositor: 'settings_ai_edge_glow_why_compositor' };

// The edge glow is drawn by the native app: elsewhere the row is hidden, and
// where the app cannot draw it a line says why instead.
function syncAiEdgeGlowControl() {
  const row = $('settings-ai-edge-glow-row');
  const caps = window.__XENON_NATIVE_CAPS__ || {};
  const native = window.__XENON_NATIVE__ === true;
  if (row) row.hidden = !(native && caps.aiGlow === true);
  const whyKey = native && caps.aiGlow !== true ? AI_EDGE_GLOW_WHY_KEYS[caps.layersWhy] || '' : '';
  const whyRow = $('settings-ai-edge-glow-why-row');
  const whyLine = $('settings-ai-edge-glow-why');
  if (whyRow) whyRow.hidden = !whyKey;
  if (whyLine && whyKey) {
    whyLine.dataset.i18n = whyKey;
    whyLine.textContent = t(whyKey);
  }
  const el = $('settings-ai-edge-glow');
  if (!el) return;
  el.value = hubSettings.aiEdgeGlow || 'auto';
  if (typeof el._csSync === 'function') el._csSync();
}

function updateAiEdgeGlow(value) {
  hubSettings = normalizeSettings({ ...hubSettings, aiEdgeGlow: value });
  saveHubSettings();
  syncAiEdgeGlowControl();
  if (window.AiEdgeGlow) window.AiEdgeGlow.refresh();
}

// Why the native app cannot draw widget layers here (layers/linux.rs `probe`):
// the i18n key of the reason, or '' when it can or the shell does not say.
const LAYERS_WHY_KEYS = { wayland: 'settings_layers_why_wayland', no_compositor: 'settings_layers_why_compositor' };

function syncLayersWhy(caps) {
  const group = $('settings-layers-why-group');
  const line = $('settings-layers-why');
  const key = window.__XENON_NATIVE__ === true && caps.layers !== true ? LAYERS_WHY_KEYS[caps.layersWhy] || '' : '';
  // A category switch shows every group of its category: these two stay out of
  // it through `unavailable`, not just `hidden`.
  setSettingsCardAvailable(group, !!key);
  if (line && key) {
    line.dataset.i18n = key;
    line.textContent = t(key);
  }
}

// How this PC uses Xenon (js/usage-mode.js). Only the native app can drop the
// dashboard window for the widgets, so elsewhere the row is hidden; where the
// app cannot draw them, a line says why instead.
function syncMenuKeyHint() {
  const el = $('settings-menu-key');
  if (!el || !window.DeckShortcuts) return;
  const key = window.DeckShortcuts.formatShortcut(window.LayersModel.normalize(hubSettings.layers).menuKey);
  el.textContent = t('xmenu_key_opens').replace('{key}', key);
}

function syncUsageModeControl() {
  const group = $('settings-usage-mode-group');
  const caps = window.__XENON_NATIVE_CAPS__ || {};
  setSettingsCardAvailable(group, window.__XENON_NATIVE__ === true && caps.layers === true);
  syncLayersWhy(caps);
  syncMenuKeyHint();
  const el = $('settings-usage-mode');
  if (!el) return;
  el.value = window.UsageMode.normalize(hubSettings.usageMode) || 'dashboard';
  if (typeof el._csSync === 'function') el._csSync();
}

// The row sits beside the mode above, so it exists only where the app draws the menu.
function openXenonMenu() {
  fetch(SERVER + '/screen-menu', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ open: true }),
  }).catch((e) => console.warn('[settings] the Xenon menu did not open', e));
}

async function updateUsageMode(value) {
  hubSettings = normalizeSettings({ ...hubSettings, usageMode: value });
  saveHubSettings();
  syncUsageModeControl();
  // The window trades itself for the driver page through the server (route
  // `/`), so the save has to land first; the settings stream retries anyway.
  try { await flushHubSettingsToServer(); } catch { /* retried by the stream */ }
  if (window.LayersShell) window.LayersShell.sync();
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
  const clear = $('settings-ai-memory-clear');
  if (clear) clear.hidden = facts.length === 0;
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
    if (window.XenonToast) window.XenonToast.show({ type: 'success', title: t('settings_ai_memory_cleared', 'Memory cleared'), important: true });
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

// ── "Hey Bit" wake word (Settings → Xenon AI) ────────────────────────────
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
      ? t('wake_status_listening', 'In ascolto: di\' «Hey Bit» per aprire la chat vocale.')
      : t('wake_status_starting', 'Attivo: l\'ascolto parte quando il dashboard è aperto.');
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
  let failure = '';
  try {
    await _streamWhisperInstall(p => {
      if (p.error) failure = String(p.error);
      if (!out) return;
      if (p.error) out.textContent = '⚠ ' + String(p.error);
      else if (p.status || typeof p.percent === 'number') {
        out.textContent = String(p.status || '') + (typeof p.percent === 'number' ? ` ${Math.round(p.percent)}%` : '');
      }
    });
  } catch (e) {
    failure = String((e && e.message) || e);
  } finally {
    if (btn) btn.disabled = false;
    // The status refresh rewrites this line with "Whisper is needed", which used
    // to wipe the reason a download failed the instant it appeared. Put it back.
    await refreshWakeWordStatus();
    if (failure && out) out.textContent = '⚠ ' + failure;
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
  // A save re-renders this block: an open expander stays open.
  const opened = new Set(Array.from(container.querySelectorAll('details[open]')).map(d => d.dataset.help));
  container.textContent = '';

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
    // The server keeps the link itself (it is the calendar's password) and only
    // sends its host + `urlSet`. A blank field therefore means "keep the saved
    // link"; typing a new one replaces it.
    urlInput.placeholder = feed.urlSet && !feed.url
      ? (feed.host ? feed.host + ', ' : '') + t('settings_key_saved')
      : t('feed_url');
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
    remCb.className = 'settings-check';
    remCb.checked = feed.reminders !== false;
    remCb.addEventListener('change', () => { feed.reminders = remCb.checked; commit(); });
    remLabel.append(remCb, t('feed_reminders'));

    const enLabel = document.createElement('label');
    enLabel.className = 'feed-toggle';
    const enCb = document.createElement('input');
    enCb.type = 'checkbox';
    enCb.className = 'settings-check';
    enCb.checked = feed.enabled !== false;
    enCb.addEventListener('change', () => { feed.enabled = enCb.checked; commit(); });
    enLabel.append(enCb, t('feed_enabled'));

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
  addBtn.className = 'settings-btn';
  addBtn.textContent = t('add_feed');
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
  refreshBtn.className = 'settings-btn feed-refresh';
  refreshBtn.textContent = t('refresh_feeds');
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

  // How to get the link, and what to expect: read once, so closed until asked for.
  const helpBlock = (titleKey, keys) => {
    const box = document.createElement('details');
    box.className = 'settings-expander';
    box.dataset.help = titleKey;
    box.open = opened.has(titleKey);
    const title = document.createElement('summary');
    title.textContent = t(titleKey);
    const lines = document.createElement('ul');
    lines.className = 'settings-expander-list';
    keys.forEach(key => appendFeedHelpLine(lines, key));
    box.append(title, lines);
    return box;
  };
  container.append(
    helpBlock('feed_help_title', ['feed_help_google', 'feed_help_outlook']),
    helpBlock('feed_warn_title', ['feed_warn_readonly', 'feed_warn_lag', 'feed_warn_dupes', 'feed_warn_privacy', 'feed_warn_recurrence']),
  );

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
  btnLabel.setAttribute('data-i18n', 'settings_calendar'); // live-retranslates on language switch
  btnLabel.textContent = t('settings_calendar');
  btn.appendChild(btnLabel);
  // In the "Widget" sidebar section, after the feeds, so the calendar sits with the other widget categories
  // instead of dangling at the bottom of the list.
  const navScroll = document.getElementById('settings-nav-scroll') || nav;
  const next = navScroll.querySelector('.settings-nav-btn[data-settings-cat="slideshow"]');
  if (next) navScroll.insertBefore(btn, next);
  else navScroll.appendChild(btn);

  // Section container (matches existing settings-group pattern)
  const section = document.createElement('div');
  section.className = 'settings-group';
  section.dataset.settingsCat = 'calendar';
  section.hidden = true; // settingsSetCategory controls visibility
  const head = document.createElement('div');
  head.className = 'settings-group-head';
  const title = document.createElement('span');
  title.dataset.i18n = 'external_calendars';
  title.textContent = t('external_calendars');
  const desc = document.createElement('span');
  desc.className = 'settings-hint';
  desc.dataset.i18n = 'external_calendars_desc';
  desc.textContent = t('external_calendars_desc');
  head.append(title, desc);
  const hub = document.createElement('div');
  hub.id = 'settings-calendar-feeds-hub';
  section.append(head, hub);
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
if (typeof MutationObserver === 'function') {
  new MutationObserver(syncBackgroundVideoHold).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
