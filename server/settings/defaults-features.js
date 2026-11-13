// What a new install starts with, sixth part: the opt-in features, notifications, calls and
// phone, the wake word, search, disk, backgrounds, lighting and calendar feeds.

const os = require('node:os');
const { POWERSHELL_SUPPORTED } = require('../powershell/supported.js');

const HUB_DEFAULTS_FEATURES = Object.freeze({
  // Opt-in advanced AI features (Settings → Funzioni AI) — all OFF by default.
  aiFeatures: Object.freeze({ enabled: false, genesis: false, gameCompanion: false, guardian: false, ambient: false }),
  // Opt-in local sensor history (CPU/GPU load+temp, RAM over time). OFF by
  // default; independent of the AI Guardian feature (which also consumes it).
  // When on, collection runs even without any AI; the data never leaves the PC.
  sensorHistory: Object.freeze({ enabled: false, everyMin: 5 }),
  // Game sessions (Settings → Performance → Partite giocate): average FPS and
  // lows of each game played, kept on this PC to compare. ON by default: it
  // costs a counter per frame only while a game runs, and stores ~100 lines.
  gameSessions: Object.freeze({ enabled: true }),
  // Proactive moments (Settings → Performance → Momenti proattivi). Deterministic,
  // bounded, individually toggleable: sustained-thermal alerts, game-session
  // recaps, and the morning-agenda briefing inside the greeting splash.
  proactive: Object.freeze({ thermal: true, recap: true, morning: true, anomaly: true }),
  // Master notifications switch (Settings → Notifiche). ON by default, but the
  // individual sources below are still OFF by default — this just lets the user
  // silence EVERYTHING (pop-ups + feeds) and stop the background watchers in one
  // place. `popups` alone keeps the feeds but suppresses the on-screen toasts;
  // `sounds` alone silences the per-pop-up cue (client-played, WebAudio).
  notifications: Object.freeze({ enabled: true, popups: true, sounds: true, quiet: 'auto' }),
  // Discord notification mirroring (Settings → Streaming → Discord). OFF by
  // default — it's privacy-touching, and enabling it requests the extra
  // rpc.notifications.read scope, which means a one-time Discord re-link.
  // Notifications are read from the local desktop client and never leave the PC.
  discordNotifications: Object.freeze({ enabled: false, hide: false }),
  windowsNotifications: Object.freeze({ enabled: false, hide: false, toast: true, excluded: Object.freeze([]) }),
  calls: Object.freeze({ enabled: false, push: true, sound: true, disabledApps: Object.freeze([]), apps: Object.freeze([]) }),
  // The paired phone. OFF by default (privacy) — switching it on reads the
  // user's whole address book off their phone over Bluetooth and keeps it in
  // this process. `ring` is separate because wanting the phonebook on a second
  // screen is not the same as wanting that screen to take itself over on every
  // incoming call.
  phone: Object.freeze({ enabled: false, ring: true, hide: true }),
  // Local "Hey Bit" wake word. OFF by default (privacy) — when on, the mic is
  // read locally via ffmpeg + whisper.cpp while a dashboard is open; nothing
  // leaves the PC.
  wakeWord: Object.freeze({ enabled: false }),
  // indexRoots defaults per platform for the reason spelled out in
  // normalizeSearchSettings: "C:\" is not a path off Windows, and a default the
  // validator there would reject leaves the index permanently off.
  searchSettings: Object.freeze({ indexRoots: Object.freeze([POWERSHELL_SUPPORTED ? 'C:\\' : os.homedir()]), hotkeyEnabled: false, hotkeyCombo: 'alt+space', aiFullContext: false, recentInTile: false }),
  pageHotkeys: Object.freeze([]),
  diskSettings: Object.freeze({ devFolders: Object.freeze([]), installerAgeDays: 30 }),
  bgAurora: Object.freeze({ enabled: false, intensity: 55, speed: 50 }),
  bgGrid: Object.freeze({ enabled: false, color: '#6ee787', intensity: 45, speed: 50 }),
  // Static premium background (0 animations). style: none|nebulosa|prisma|halo|dusk.
  bgStatic: Object.freeze({ style: 'dusk', intensity: 100 }),
  // Code-defined animated background (sandboxed iframe on the client). Off by default.
  bgCustom: Object.freeze({ enabled: false, name: '', code: '', assets: Object.freeze({}), fps: 30 }),
  lighting: Object.freeze({
    enabled: false,            // master OFF by default — explicit opt-in, zero cost
    brightness: 1.0,
    pauseDuringGame: true,
    devices: {},               // deviceId → bool opt-in (absent/true = on)
    // All OFF by default — each effect is opt-in and independent of the master.
    effects: Object.freeze({
      temperature: false,      // CPU-temp colour
      volume: false,           // flash on volume change
      musicAlbum: false,       // tint from the now-playing cover
      timer:        Object.freeze({ enabled: false, color: '#ff0000', style: 'blink', durationMs: 1800 }),
      notification: Object.freeze({ enabled: false, color: '#ff0000', style: 'blink', durationMs: 1800 }),
      reminder:     Object.freeze({ enabled: false, color: '#ff0000', style: 'blink', durationMs: 1800 }),
      // Bit's rage flash — not surfaced in the lighting page; its ON/OFF control is
      // the `vitals.pet.lighting` toggle, so this stays enabled and the client only
      // fires it when the user opted in. Redder + longer for a dramatic burst.
      vitals:       Object.freeze({ enabled: true, color: '#ff2b2b', style: 'blink', durationMs: 4000 }),
    }),
    // Ambient anim: none|solid|breathing|cycle|wave|aurora|candle|palette.
    animation: Object.freeze({ style: 'none', color: '#1ed760', speed: 50, palette: Object.freeze(['#1ed760', '#0066ff']) }),
    manualColor: '',               // persisted manual fixed colour ('' = none)
    providers: Object.freeze({}),  // external (non-iCUE) providers → { providerId: { devices: [...] } }
    deviceModes: Object.freeze({}), // per-device override → { deviceId: { mode, color?, anim? } }
    // Controllers Xenon drives itself over USB (opt-in) and what hangs on each of
    // their outputs, told once in the guided setup → { deviceId: { h0: { parts } } }.
    native: Object.freeze({ enabled: false, layouts: Object.freeze({}) }),
  }),
  calendarFeeds: [],
});

module.exports = { HUB_DEFAULTS_FEATURES };
