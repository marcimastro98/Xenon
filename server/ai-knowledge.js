// Xenon AI app-knowledge base — makes the assistant an expert on Xenon ITSELF,
// not just an operator of its tools. Two grounding surfaces, both read-only:
//
//   lookup(query)          → curated topic cards (setup, features, troubleshooting)
//   getSdkReference(section) → the Widget SDK reference, parsed live from
//                              docs/WIDGET_SDK.md + the code-authoritative enums
//                              in sdk-widgets.js (so it can never drift from the
//                              real allowlists).
//
// Topic bodies are written in English on purpose: the system prompt already
// orders the model to answer in the user's language, and one language keeps the
// cards reviewable. Keep each body a compact paragraph — the card is grounding
// for the model, not text to be read aloud verbatim.

const fs = require('fs');
const path = require('path');

const SDK_DOC = path.join(__dirname, '..', 'docs', 'WIDGET_SDK.md');
const SECTION_MAX_CHARS = 12000;   // per-section cap when returning doc text
const RESULT_TOPICS_MAX = 2;       // lookup returns at most this many full cards

// ── Curated topics ───────────────────────────────────────────────────────────
// id: stable slug; keywords: EN + IT match terms (lowercase); body: the facts.
// When a feature changes in a user-visible way, update its card in the same
// change (CHANGELOG discipline applies here too).
const TOPICS = [
  {
    id: 'sensors',
    title: 'Hardware sensors (CPU temp, fans, watts) and administrator rights',
    keywords: ['sensor', 'sensori', 'fan', 'ventole', 'watt', 'power draw', 'cpu temp', 'temperatura', 'librehardwaremonitor', 'admin', 'amministratore', 'elevated', 'permission', 'permessi', 'zero', 'empty', 'vuoto'],
    body: 'CPU temperature, fan RPM and power draw (watts) are read through LibreHardwareMonitor, and Windows only exposes those sensors to a process with administrator rights. Without that permission the values stay empty forever: it is not a bug. Fix: the "Enable sensors" button (on the Fans/Energy widgets\' hint, or Settings → Performance → Hardware sensors): one click + one Windows confirmation marks Xenon\'s startup task to run elevated and restarts the backend so the sensors come alive immediately. Edge case: if a banner says rights are already enabled but the backend is still running without them, the running process predates the fix, close Xenon fully and start it from its startup task (or an administrator terminal). If the startup task is missing entirely, re-run INSTALL.bat with right-click → "Run as administrator". Regular CPU/GPU load and RAM never need admin rights.',
  },
  {
    id: 'install-update',
    title: 'Installing, starting at logon, and self-update',
    keywords: ['install', 'installazione', 'setup', 'update', 'aggiornamento', 'aggiornare', 'version', 'versione', 'uninstall', 'disinstalla', 'scheduled task', 'avvio', 'startup', 'boot', 'rollback', 'installer'],
    body: 'Xenon installs with INSTALL.bat (or the full Xenon-Setup-x64.exe installer, which also bundles the native app). It registers a per-logon scheduled task named "Xenon Edge Widget" that starts the backend hidden at logon: deliberately NOT a Windows service, because a service cannot reach media info, hotkeys, audio or the microphone. The dashboard is served locally at http://127.0.0.1:3030. Updates: Settings shows when a new release is available; the self-updater downloads from GitHub Releases, verifies an Ed25519 signature before extracting anything (fail-closed), and if anything goes wrong it restores the previous version exactly and keeps the download so you can retry. User data lives in server/data and survives updates.',
  },
  {
    id: 'helper',
    title: 'Xenon Helper (optional native companion)',
    keywords: ['helper', 'xenon-helper', 'exe', 'companion', 'media host', 'smtc', 'game detection', 'presentmon'],
    body: 'xenon-helper.exe is an optional compiled companion the installer downloads automatically. It makes now-playing media reads and the game-detection probe faster and cheaper. It is never required: when it is missing or misbehaves, Xenon falls back to the built-in PowerShell path transparently and permanently, the user never sees a hard failure. Hardware sensors intentionally do NOT run in the helper (they stay on the PowerShell worker). PresentMon is a separate optional download used only to show real in-game FPS; game mode itself works without it. The Media tile wave (Minimal or Wave) is the one feature with no fallback: it needs the helper. If the helper is missing, too old or keeps stopping, Settings → Media tile shows why under the wave buttons, with an Install Xenon Helper button that downloads the verified helper for this version. On the setup .exe the engine lives in %LOCALAPPDATA%\\Programs\\Xenon, so the helper is at %LOCALAPPDATA%\\Programs\\Xenon\\server\\helper\\xenon-helper.exe.',
  },
  {
    id: 'ai',
    title: 'Xenon AI: providers, voice, wake word, opt-in features',
    keywords: ['ai', 'assistant', 'assistente', 'gemini', 'claude', 'anthropic', 'openai', 'ollama', 'claude code', 'codex', 'abbonamento', 'subscription', 'local', 'locale', 'api key', 'chiave', 'voice', 'voce', 'wake word', 'hey bit', 'hey xenon', 'bit', 'whisper', 'tts', 'genesis', 'guardian', 'pc control', 'controllo pc', 'memoria', 'memory', 'live', 'nircmd', 'screen vision'],
    body: 'Bit, Xenon\'s assistant, runs on the provider chosen in Settings → Bit: Sparks (Xenon\'s own credits, bought in the Store\'s Sparks tab, no API key needed), Google Gemini (default), Anthropic Claude, OpenAI, the user\'s own Claude or ChatGPT subscription through the official Claude Code or Codex program installed on the PC (no API key; same dashboard tools, a few seconds slower per answer), or a fully local stack (Ollama for chat, Whisper.cpp for speech-to-text, Edge neural voices for speech): cloud providers need an API key, the local stack needs no internet for chat. Voice: tap the mic, or enable the local "Hey Bit" wake word; Voce Live (opt-in) is full-duplex realtime voice on Gemini. Screen vision needs the small NirCmd utility (the installer fetches it). Opt-in extras in Settings → Funzioni AI: Genesis (composes dashboard pages), Guardian (long-term hardware-health history), PC Control (proposes Windows commands that run ONLY after you approve each one on a confirmation card), advanced reasoning, and persistent memory (on by default, stored locally, can be turned off). State-changing AI actions offer an Undo chip.',
  },
  {
    id: 'mcp-widgets',
    title: 'Writing your own widget in Claude Code, Codex or another coding assistant (xenon-mcp)',
    keywords: ['mcp', 'xenon-mcp', 'xenon-widgets', 'claude code', 'codex', 'cursor', 'coding assistant', 'assistente di codice', 'write a widget', 'scrivere un widget', 'my own widget', 'widget mio', 'developer', 'sviluppatore', 'sdk', 'vscode', 'terminal', 'terminale'],
    body: 'Someone who writes widget code in Claude Code, Codex or any MCP client can connect it to Xenon: Settings → Widgets & sharing → "Build widgets with Claude Code or Codex" has a Connect button for each (it adds the xenon-widgets MCP server to that program), or by hand `claude mcp add --scope user xenon-widgets -- npx -y xenon-mcp` / `codex mcp add xenon-widgets -- npx -y xenon-mcp`; Claude Code can also install the xenon-widgets plugin, which adds a build-widget skill. The first time the assistant uses it, the dashboard asks "Let this tool build widgets?"; connected tools are listed in that same card with a Remove button. The assistant can then read the Widget SDK, write a starter widget in a folder, check it, install it and put it on the page, read the errors and blocked requests it hits while running, and take a picture of its tile, then fix it. It never approves a widget\'s permissions (the person still does, on the dashboard), can only change the person\'s own widgets, and works only from this PC, never from a paired phone. Thrown errors in widget code show as "Script error." because of the sandbox; console.error messages arrive in full. Screenshots do not work on Linux under Wayland. Bit itself can also make a widget from a sentence; the MCP is for people who want to write the code with their own assistant.',
  },
  {
    id: 'marketplace',
    title: 'Community marketplace: discover, install, rate, update, publish',
    keywords: ['marketplace', 'catalog', 'catalogo', 'community', 'gallery', 'galleria', 'scopri', 'discover', 'install', 'installare', 'theme', 'tema', 'widget', 'preset', 'code', 'codice', 'rating', 'stelle', 'stars', 'publish', 'pubblicare', 'submit', 'creator', 'creatore', 'icon pack', 'icone', 'sound pack', 'suoni', 'update badge', 'version', 'crea', 'create'],
    body: 'The Scopri/Discover gallery lists community content by kind: themes, backgrounds, dashboard pages, Deck profiles, widgets, Ambient scenes, bundles, icon packs and sound packs. Every install (from the gallery, a pasted share code, or the AI) goes through the same import review dialog that shows exactly what will be applied and which permissions/actions it contains; nothing is ever applied silently. Entries carry a version: when a newer one is published, an update badge appears and re-importing updates cleanly. Ratings are anonymous 1-5 stars per install (no account); the public average shows once an entry has at least 3 votes. Publishing your own creation: export it as a share code in the app, then submit it on xenon-app.com/submit: a human reviews every submission before it appears in the catalog. The AI can also create any kind of creation itself (theme, background, page, Deck profile, top bar, icon pack, widget, Ambient scene, package) and opens it in the same import window for review; it cannot make sound packs, which are audio files.',
  },
  {
    id: 'supporter',
    title: 'Supporter codes and locked catalog entries',
    keywords: ['supporter', 'sostenitore', 'code', 'codice', 'locked', 'bloccato', 'unlock', 'sbloccare', 'redeem', 'riscatta', 'xs', 'xl', 'premium', 'donation', 'donazione', 'limited', 'drop'],
    body: 'Some catalog entries are locked and unlock with a supporter code, redeemed directly on the entry inside the gallery. Codes start with XS (a supporter pass for pass-tier entries) or XL (a per-item code issued for one specific limited/purchased entry: an XS pass does not open limited drops and vice versa). Each code activates on up to 3 devices. Redemption talks only to the author\'s own hub service and sends nothing but the code and an anonymous per-install id. Previously unlocked content keeps working offline.',
  },
  {
    id: 'ai-credits',
    title: 'Sparks, Bit\'s credits: models, reasoning level, costs and buying more',
    keywords: ['sparks', 'scintille', 'scintilla', 'spark', 'credits', 'crediti', 'credit', 'costo', 'cost', 'costa', 'prezzo', 'price', 'ragionamento', 'reasoning', 'effort', 'sonnet', 'opus', 'haiku', 'ricarica', 'top up', 'saldo', 'balance'],
    body: 'Sparks are Xenon\'s credits; always use the app\'s name for them in the user\'s language (Scintille, Chispas, Étincelles, Funken, Faíscas, Искры, Vonken, スパーク, 스파크, 火花), never "credits" alone. Supporters pick the provider Sparks in Settings → Bit assistant: Claude through the supporter code, no API key. Each month of support includes 300 Sparks, reset at the start of the month; more on Buy Me a Coffee (500 Sparks for 5 USD, 1,050 for 10 USD, 2,200 for 20 USD), and bought Sparks never expire. Pay with the supporter code\'s email (Settings shows it): they arrive within a minute, at most a day. Questions, commands and voice always run on Haiku, for less than one Spark an answer. For creations the user picks the model: Haiku (a widget costs about 3 Sparks), Sonnet (balanced, about 80) or Opus (the most accurate, about 150), at the Normal level. The app calls them Fast, Smart and Smartest (Veloce, Bravo, Il più bravo): use those names with the user. Reasoning sets how much the model thinks: Light suits simple requests (Sparks close to Normal), Normal is the recommended balance, Thorough gives a more polished result for about twice the Sparks and the time. The creation arrives at every level. The assistant changes both when asked ("use the smartest", "think more") with set_creation_model, and a creation asked in the same message already uses the new choice. The balance shows in Settings, in the Store and at the top of the chat, where a tap opens Ricarica and the model. When the assistant asks a question, it can offer one-tap answers under it, and in voice it reads them out.',
  },
  {
    id: 'widgets-sdk',
    title: 'Custom community widgets and the Widget SDK sandbox',
    keywords: ['sdk', 'custom widget', 'widget personalizzato', 'sandbox', 'iframe', 'manifest', 'streams', 'actions', 'hosts', 'userhosts', 'fetch proxy', 'nas', 'docker', 'plex', 'ip', 'porta', 'port', 'indirizzo', 'address', 'storage', 'secrets', 'island', 'isola', 'teleprompter', 'create widget', 'crea widget', 'html', 'javascript', 'permessi widget'],
    body: 'Community widgets are HTML/CSS/JS packages rendered in a locked-down sandboxed iframe: no direct network and no access to the dashboard page. Every capability is declared in manifest.json and approved by the user: data streams, low-risk actions, external API hosts reached only through Xenon\'s fetch proxy, storage and a write-only secrets vault. For a user-owned LAN service (NAS, Docker, Plex), declare a `userHosts` slot instead of hard-coding the author\'s address; the approved value arrives at init.userHosts[id].base and loopback stays unreachable. The AI can write and install a widget on request, or open it as a share code in the import window; either way it gets no permission until the user approves it; add it from + → Custom widget. `"island": true` keeps the v4.6 short host-rendered text line. `"island": { "dynamic": true }` requests a separate advanced grant for Full/Minimal Live Activities made from Xenon-drawn text, icons, progress, playback bars, time/date/weather and up to two buttons. A live activity persists; a 1.2–30 second takeover animates in for a goal/result/track, exits and restores the previous content. Settings → Dynamic Island lists installed contributing packages and lets the user disable each source or all takeovers. System notifications take priority. `"accent": true` is a separate grant to tint the dashboard accent at runtime, for players Windows never reports (Plex): accent only, never saved, released when the widget is removed or paused. Full developer docs live in docs/WIDGET_SDK.md and are available through sdk_reference.',
  },
  {
    id: 'deck',
    title: 'Deck (stream-deck keys): profiles, actions, sliders, icon & sound packs',
    keywords: ['deck', 'stream deck', 'tasti', 'keys', 'profile', 'profilo', 'macro', 'slider', 'fader', 'smart profiles', 'virtual deck', 'soundboard', 'suoni', 'icone tasti', 'hold', 'double tap', 'hotkey'],
    body: 'The Deck widget is a programmable touch key grid (up to 8×8 per profile). Keys support tap / double-tap / hold actions from a large typed catalog (apps, media, audio mixer, OBS, Twitch, Spotify, Home Assistant, hotkeys, webhooks…), live state bindings (a key lights while e.g. Discord is muted), live value badges (timers, sensors), and touch sliders for volumes and lights. Smart Profiles auto-switch the visible profile when a chosen app gains focus. Virtual Deck opens the grid as an always-on-top window on the main PC monitor. Icon packs installed from the marketplace appear in the key icon picker; sound packs add clips to the Soundboard action category and survive profile export/import. The AI can build full profiles on request: configure_deck edits a profile directly, and a bigger profile with folders and its own look can arrive as a code that opens in the import window for review.',
  },
  {
    id: 'ambient',
    title: 'Ambient mode (screensaver scenes)',
    keywords: ['ambient', 'screensaver', 'salvaschermo', 'lock screen', 'focus', 'scene', 'scena', 'idle', 'clock', 'orologio fullscreen'],
    body: 'Ambient mode shows a fullscreen scene: the built-in one has a clock, now-playing media, weather and upcoming events, with configurable widgets. It can start on demand (voice command or button) and auto-start after an idle timeout. Community Ambient scenes from the marketplace are SDK packages rendered with the exact same sandbox and permission rules as widget tiles, just fullscreen. Tap to exit.',
  },
  {
    id: 'appearance',
    title: 'Themes, skins, colors, backgrounds',
    keywords: ['theme', 'tema', 'skin', 'aspetto', 'appearance', 'colore', 'colors', 'dark', 'light', 'scuro', 'chiaro', 'background', 'sfondo', 'wallpaper', 'retro', 'comic', 'glass', 'contrast', 'shape', 'forma', 'trasparente', 'transparent', 'blur', 'sfocatura', 'ombra', 'shadow', 'esagono', 'hexagon'],
    body: 'Appearance layers: named theme presets (xenon, ocean, ember, violet, mono), Light/Dark/Auto mode, and a base skin, glass (the default Liquid Glass look), retro (Pixel Retro) or comic. Beyond presets, every semantic color (canvas, panels, controls, text, borders, accent, state colors) can be set to an exact hex value, with automatic contrast repair so text never becomes unreadable. Custom background images can be uploaded, and themes can also be installed from the marketplace. The AI applies any of this on request, live, or builds a whole theme (also with separate light and dark palettes) that opens in the import window first. A SINGLE TILE is dressed separately and the AI cannot do it for the user, only explain it: in layout edit mode press the tile\'s 🎨 button. Colours gives that tile its own palette; Effects (v4.11) holds panel opacity down to 0 (no card at all, just the widget over the background), corner radius, glass blur and saturation, border, shadow, and the tile SHAPE. A tile need not be a rectangle: eleven silhouettes (squircle, circle, hexagon, diamond, cut-corner, parallelogram, ticket, arch, shield, wave, blob) or a custom closed SVG path in a 0-to-1 square, with the content kept clear of the cut edges automatically. Blur is only visible through a translucent panel, so lower the opacity too. A community widget can ship a shape for its own tile; the user\'s choice wins. Background pictures, frames and overlays are the other two tabs. All of it saves with the layout and travels in a shared page or preset code.',
  },
  {
    id: 'lighting',
    title: 'RGB lighting: iCUE devices, the motherboard, WLED, OpenRGB, Hue, Nanoleaf',
    keywords: ['rgb', 'lighting', 'luci', 'illuminazione', 'icue', 'corsair', 'wled', 'openrgb', 'hue', 'philips', 'nanoleaf', 'led', 'effetti', 'effects', 'animation', 'animazione', 'colore luci', 'ventole', 'ventola', 'fan', 'pompa', 'pump', 'per led', 'singoli led', 'scheda madre', 'motherboard', 'gigabyte', 'aorus', 'rgb fusion', 'argb', 'striscia', 'strip', 'uscita', 'header'],
    body: 'The lighting bridge drives Corsair devices through iCUE and, optionally, WLED, OpenRGB, Philips Hue and Nanoleaf (found on the LAN from the Lighting page). It offers manual colours, reactions (CPU-temperature gradient, album-cover colour, flashes for timers/notifications/reminders) and animations (breathing, rainbow, wave, aurora, candle, your own palette). The Lighting page has four tabs: Devices, Effects, Reactions, Connections. On Devices each light has a card; a Corsair device (iCUE LINK or Commander hub, AIO, RAM, keyboard) shows its real parts, every fan as a ring of LEDs, and a fan, a LED or a part can get its own colour or effect while untouched LEDs follow Xenon. On Windows, Xenon can also drive the RGB controller of a GIGABYTE or AORUS motherboard (RGB Fusion 2) over USB, no vendor app: turn on Motherboard in Connections, after closing RGB Fusion / GIGABYTE Control Center and removing the board from iCUE. ARGB lights cannot say how many LEDs they have, so each output on the device card has Count the LEDs: the user presses + until everything plugged in is white, then each LED can be coloured or animated on its own; Split into pieces (optional, All the same for identical fans) makes each chained fan or strip a part of its own. Fans on a splitter all mirror the same LEDs. A Deck key can colour one part (Colour one part), and widgets can too. Deck keys can flash the lights, and the AI controls all of it by voice or text.',
  },
  {
    id: 'integrations',
    title: 'Integrations: Spotify, OBS, Twitch, YouTube, Streamer.bot, Wave Link, Discord, Home Assistant, UniFi, calendars',
    keywords: ['integration', 'integrazioni', 'spotify', 'obs', 'twitch', 'youtube', 'streamerbot', 'streamer.bot', 'wave link', 'wavelink', 'discord', 'home assistant', 'domotica', 'unifi', 'protect', 'camera', 'calendar', 'calendario', 'ics', 'google calendar', 'collegare', 'connect'],
    body: 'Each integration is connected from Settings and unlocks matching widgets, Deck actions and AI tools: Spotify (full playback + play-by-name), OBS Studio (record/stream/scenes), Twitch (clips, title/category, chat, markers, ads), YouTube live broadcasts, Streamer.bot actions, Elgato Wave Link mixing, Discord voice (mute/deafen/join channels), Home Assistant (lights, climate, covers, energy readings and more), UniFi Protect cameras, and external calendars via Google or any .ics feed. When an integration is not connected, its tools simply do not appear.',
  },
  {
    id: 'performance',
    title: 'Performance Mode and game mode',
    keywords: ['performance', 'prestazioni', 'game mode', 'gioco', 'fps', 'optimize', 'ottimizza', 'boost', 'priority', 'priorità', 'presentmon'],
    body: 'Performance Mode frees resources for gaming or heavy work: it shows a confirmation sheet listing exactly what it will do (power plan, pausing animations, optionally closing background apps) and applies nothing until confirmed; everything is restorable with one action. Game mode detects a fullscreen game automatically and adapts the dashboard; with the optional PresentMon component it shows real in-game FPS.',
  },
  {
    id: 'vitals',
    title: 'Vitals self-care meters and Bit the pet',
    keywords: ['vitals', 'vitali', 'pet', 'bit', 'acqua', 'water', 'hydration', 'idratazione', 'stretch', 'pausa', 'break', 'posture', 'postura', 'streak', 'serie', 'snooze', 'self-care'],
    body: 'Vitals are five self-care meters (hydration, energy, stamina = stretch or walk, focus = a screen break, posture, off by default) that drain only while the user is at the computer: after 5 minutes away they freeze and resume where they were. Each meter has its own interval in Settings, Bit. A tap on the bar, a Deck key (Refill a vital; a key can also show a meter live: configure_deck live source "vitals", name a meter or "lowest") or telling you ("I drank water", use refill_vital) refills it, gives +25 XP toward a self-care level and keeps a daily streak; one missed day does not end the streak, two do. With natural breaks on (the default), coming back after time away refills stamina and focus by itself. Bit the pet (off by default) lives in a corner of the dashboard or in the top bar and reacts when a meter sits at zero: lines, then a GAME OVER card, and only if the user turned each one on, a popup on the computer screen, hiding the windows, and locking the computer, each after a delay they choose, only while they are at the computer. Bit sleeps in the hours the user picks (23 to 7 unless changed) and stays quiet during games, unless the user turns that off. On macOS and Linux the popup shows on the main screen through the Xenon app (else a system notification), hiding the windows works on macOS, on Linux X11 and on KDE, not on GNOME Wayland. The user can snooze Bit for 30 minutes, quiet it for today, change its tone (soft, spicy, savage), choose its sleeping hours or turn natural breaks off: set_vitals does all of that by voice. get_vitals reads the meters.',
  },
  {
    id: 'remote',
    title: 'Remote PC control (Sunshine / Tailscale / Moonlight)',
    keywords: ['remote', 'remoto', 'sunshine', 'tailscale', 'moonlight', 'stream pc', 'controllo remoto', 'desktop remoto', 'fuori casa'],
    body: 'Remote control is opt-in and built on standard tools Xenon helps install and wire together: Sunshine streams the PC, Tailscale provides the private network, and any Moonlight client (phone, tablet, another PC) connects to use the machine remotely. Setup and status live in Settings; nothing listens remotely until the user enables it. Deck keys exist to disconnect or block remote sessions instantly.',
  },
  {
    id: 'privacy',
    title: 'Privacy and security model',
    keywords: ['privacy', 'security', 'sicurezza', 'dati', 'data', 'telemetry', 'telemetria', 'account', 'cloud', 'local', 'locale', 'tracking', 'install id', 'anonimo'],
    body: 'Xenon is local-first: the backend listens only on 127.0.0.1 (loopback), nothing on the LAN or internet can reach it, and there are no accounts and no telemetry. Outbound connections happen only for features you actively use: weather, stocks/news, your chosen AI provider, the community catalog, and integrations you connect. The install id used for ratings and supporter activations is a random anonymous UUID, not an identity. AI memory and all user data stay in local files (server/data). Community widgets run in a no-network sandbox and only get the permissions you approve; server-side secrets (API keys, passwords) are never sent back to the browser.',
  },
  {
    id: 'troubleshooting',
    title: 'Common issues: settings not saving, empty tiles, port conflicts',
    keywords: ['problem', 'problema', 'issue', 'bug', 'not working', 'non funziona', 'settings not saving', 'impostazioni', 'reset', 'refresh', 'port 3030', 'porta', 'duplicate', 'doppio server', 'media vuoto', 'non salva', 'errore'],
    body: 'Frequent fixes: (1) Settings/theme reverting after a refresh usually means TWO backend processes are running and the stale one is holding the settings file, close Xenon fully (or end the duplicate node process) and start it once from its startup task. (2) Fans/watts empty → the hardware-sensors permission flow (see the sensors topic). (3) Now-playing tile empty → the playing app may not report media to Windows (SMTC); most players and browsers do. (4) "Port 3030 in use" → another Xenon instance is already running; the dashboard is at http://127.0.0.1:3030. (5) After an update something looks off → check the What\'s New/CHANGELOG first; the updater restores the previous version automatically if the update itself failed.',
  },
  {
    // The id and the keywords keep the hardware terms — someone WITH an Edge asks
    // about it by name, and the card has to be findable. What changed is the answer:
    // it used to describe the Edge as the place Xenon goes and everything else as an
    // afterthought, which is what the assistant then repeated back to people who
    // have never owned one.
    id: 'screens',
    title: 'Which screens Xenon can run on',
    keywords: ['xeneon', 'edge', 'corsair', 'display', 'schermo', 'touchscreen', 'touch', 'monitor', 'second screen', 'secondo schermo', 'phone', 'telefono', 'tablet', 'kiosk', 'native app', 'browser'],
    body: 'The dashboard is a local web app, so any screen can render it: the native Xenon app (a fullscreen kiosk shell of the same dashboard, bundled with the installer) on whichever display you point it at, http://127.0.0.1:3030 in any browser, your phone or tablet over your own Wi-Fi once paired in Settings → Remote control (beta), or the iCUE widget package. A CORSAIR Xeneon Edge (14.5", 2560×720, touch) is one of those screens and the UI is tuned for its proportions, but nothing requires one. The same instance can be open on several screens at once: pages, settings and the Deck stay in sync live across all of them, and the Deck can also pop out as the Virtual Deck window on the main monitor.',
  },
];

// ── Topic lookup ─────────────────────────────────────────────────────────────
// Lowercase + strip combining diacritics (u0300-u036f) so "perché" matches "perche".
const norm = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

function topicIndex() {
  return TOPICS.map((t) => ({ topic: t.id, title: t.title }));
}

// Score a topic against normalized query words: exact-id and keyword hits weigh
// most, then title words, then body words. Deterministic, no fuzzing.
function scoreTopic(topic, qWords) {
  let score = 0;
  const title = norm(topic.title);
  const body = norm(topic.body);
  for (const w of qWords) {
    if (w.length < 3) continue;
    if (topic.id === w) score += 10;
    if (topic.keywords.some((k) => k === w)) score += 6;
    else if (topic.keywords.some((k) => k.includes(w) || w.includes(k))) score += 3;
    if (title.includes(w)) score += 2;
    if (body.includes(w)) score += 1;
  }
  return score;
}

function lookup(query) {
  const q = norm(query).trim();
  // Bare call or unmatchable query → give the model the map so it can re-ask.
  if (!q) return { ok: true, topics: topicIndex(), note: 'Call again with a topic id or a more specific query to get the full card.' };
  const exact = TOPICS.find((t) => t.id === q);
  if (exact) return { ok: true, results: [{ topic: exact.id, title: exact.title, body: exact.body }] };
  const qWords = q.split(/[^a-z0-9]+/).filter(Boolean);
  const scored = TOPICS
    .map((t) => ({ t, score: scoreTopic(t, qWords) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, RESULT_TOPICS_MAX);
  if (!scored.length) {
    return { ok: true, results: [], topics: topicIndex(), note: 'No topic matched. Pick the closest topic id from the list, or answer from general knowledge and say when you are unsure.' };
  }
  return { ok: true, results: scored.map(({ t }) => ({ topic: t.id, title: t.title, body: t.body })) };
}

// ── Widget SDK reference (docs/WIDGET_SDK.md + code enums) ──────────────────
// The doc is the authority for prose/protocol, sdk-widgets.js for the enums —
// same split the sdk-docs-sync test already enforces, so nothing here can drift.
let _docCache = null; // { mtimeMs, sections: [{ id, title, level, text }] }

function parseSections(md) {
  // The doc may carry CRLF line endings — strip the \r or headings never match.
  const lines = md.split('\n').map((l) => l.replace(/\r$/, ''));
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+)$/.exec(line);
    if (m) {
      current = { title: m[2].trim(), level: m[1].length, text: '' };
      current.id = norm(current.title).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
      sections.push(current);
      continue;
    }
    if (current) current.text += line + '\n';
  }
  return sections;
}

async function readDocSections() {
  try {
    const st = await fs.promises.stat(SDK_DOC);
    if (_docCache && _docCache.mtimeMs === st.mtimeMs) return _docCache.sections;
    const md = await fs.promises.readFile(SDK_DOC, 'utf8');
    _docCache = { mtimeMs: st.mtimeMs, sections: parseSections(md) };
    return _docCache.sections;
  } catch {
    return null;
  }
}

async function getSdkReference(section) {
  // The enums come from the code so they are correct even if the doc is absent.
  const { SDK_STREAMS, SDK_ACTION_CATEGORIES } = require('./sdk-widgets.js');
  const base = { ok: true, streams: SDK_STREAMS, actionCategories: SDK_ACTION_CATEGORIES };
  const sections = await readDocSections();
  const want = norm(section).trim();
  if (!want) {
    return {
      ...base,
      sections: sections ? sections.map((s) => ({ id: s.id, title: s.title })) : [],
      note: 'Call again with a section id/title for the full text of that part of the SDK docs (protocol messages, manifest fields, storage, secrets, fetch proxy…).',
    };
  }
  if (!sections) return { ...base, error: 'docs_unavailable', note: 'docs/WIDGET_SDK.md is missing; the streams/actionCategories enums above are still authoritative.' };
  const hit = sections.find((s) => s.id === want)
    || sections.find((s) => norm(s.title).includes(want) || s.id.includes(want.replace(/[^a-z0-9]+/g, '-')));
  if (!hit) {
    return { ...base, error: 'section_not_found', sections: sections.map((s) => ({ id: s.id, title: s.title })) };
  }
  return { ...base, section: { id: hit.id, title: hit.title, text: hit.text.trim().slice(0, SECTION_MAX_CHARS) } };
}

module.exports = { TOPICS, lookup, topicIndex, getSdkReference, _parseSections: parseSections };
