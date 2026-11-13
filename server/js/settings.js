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

window.addEventListener('xenon:sdk-packages', () => {
  if (_settingsCat === 'island') renderDynamicIslandSources();
});

document.addEventListener('DOMContentLoaded', initSettingsVersion, { once: true });

document.addEventListener('DOMContentLoaded', showPendingBackupSummary, { once: true });

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

window.SETTINGS_STORAGE_KEY = SETTINGS_STORAGE_KEY;
applyHubSettings();
hydrateHubSettingsFromServer();
window.addEventListener('pagehide', sendHubSettingsBeacon);
document.addEventListener('visibilitychange', () => ensureBackgroundVideoPlayback());
window.addEventListener('focus', () => ensureBackgroundVideoPlayback());
document.addEventListener('pointerdown', () => ensureBackgroundVideoPlayback(), { passive: true });
if (typeof MutationObserver === 'function') {
  new MutationObserver(syncBackgroundVideoHold).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
