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
    body: 'CPU temperature, fan RPM and power draw (watts) are read through LibreHardwareMonitor, and Windows only exposes those sensors to a process with administrator rights. Without that permission the values stay empty forever — it is not a bug. Fix: the "Enable sensors" button (on the Fans/Energy widgets\' hint, or Settings → Performance → Hardware sensors): one click + one Windows confirmation marks Xenon\'s startup task to run elevated and restarts the backend so the sensors come alive immediately. Edge case: if a banner says rights are already enabled but the backend is still running without them, the running process predates the fix — close Xenon fully and start it from its startup task (or an administrator terminal). If the startup task is missing entirely, re-run INSTALL.bat with right-click → "Run as administrator". Regular CPU/GPU load and RAM never need admin rights.',
  },
  {
    id: 'install-update',
    title: 'Installing, starting at logon, and self-update',
    keywords: ['install', 'installazione', 'setup', 'update', 'aggiornamento', 'aggiornare', 'version', 'versione', 'uninstall', 'disinstalla', 'scheduled task', 'avvio', 'startup', 'boot', 'rollback', 'installer'],
    body: 'Xenon installs with INSTALL.bat (or the full Xenon-Setup-x64.exe installer, which also bundles the native app). It registers a per-logon scheduled task named "Xenon Edge Widget" that starts the backend hidden at logon — deliberately NOT a Windows service, because a service cannot reach media info, hotkeys, audio or the microphone. The dashboard is served locally at http://127.0.0.1:3030. Updates: Settings shows when a new release is available; the self-updater downloads from GitHub Releases, verifies an Ed25519 signature before extracting anything (fail-closed), and if anything goes wrong it restores the previous version exactly and keeps the download so you can retry. User data lives in server/data and survives updates.',
  },
  {
    id: 'helper',
    title: 'Xenon Helper (optional native companion)',
    keywords: ['helper', 'xenon-helper', 'exe', 'companion', 'media host', 'smtc', 'game detection', 'presentmon'],
    body: 'xenon-helper.exe is an optional compiled companion the installer downloads automatically. It makes now-playing media reads and the game-detection probe faster and cheaper. It is never required: when it is missing or misbehaves, Xenon falls back to the built-in PowerShell path transparently and permanently — the user never sees a hard failure. Hardware sensors intentionally do NOT run in the helper (they stay on the PowerShell worker). PresentMon is a separate optional download used only to show real in-game FPS; game mode itself works without it.',
  },
  {
    id: 'ai',
    title: 'Xenon AI: providers, voice, wake word, opt-in features',
    keywords: ['ai', 'assistant', 'assistente', 'gemini', 'claude', 'anthropic', 'openai', 'ollama', 'local', 'locale', 'api key', 'chiave', 'voice', 'voce', 'wake word', 'hey xenon', 'whisper', 'tts', 'genesis', 'guardian', 'pc control', 'controllo pc', 'memoria', 'memory', 'live', 'nircmd', 'screen vision'],
    body: 'Xenon AI runs on the provider chosen in Settings → Xenon AI: Google Gemini (default), Anthropic Claude, OpenAI, or a fully local stack (Ollama for chat, Whisper.cpp for speech-to-text, Edge neural voices for speech) — cloud providers need an API key, the local stack needs no internet for chat. Voice: tap the mic, or enable the local "Hey Xenon" wake word; Voce Live (opt-in) is full-duplex realtime voice on Gemini. Screen vision needs the small NirCmd utility (the installer fetches it). Opt-in extras in Settings → Funzioni AI: Genesis (composes dashboard pages), Guardian (long-term hardware-health history), PC Control (proposes Windows commands that run ONLY after you approve each one on a confirmation card), advanced reasoning, and persistent memory (on by default, stored locally, can be turned off). State-changing AI actions offer an Undo chip.',
  },
  {
    id: 'marketplace',
    title: 'Community marketplace: discover, install, rate, update, publish',
    keywords: ['marketplace', 'catalog', 'catalogo', 'community', 'gallery', 'galleria', 'scopri', 'discover', 'install', 'installare', 'theme', 'tema', 'widget', 'preset', 'code', 'codice', 'rating', 'stelle', 'stars', 'publish', 'pubblicare', 'submit', 'creator', 'creatore', 'icon pack', 'icone', 'sound pack', 'suoni', 'update badge', 'version'],
    body: 'The Scopri/Discover gallery lists community content by kind: themes, backgrounds, dashboard pages, Deck profiles, widgets, Ambient scenes, bundles, icon packs and sound packs. Every install — from the gallery, a pasted share code, or the AI — goes through the same import review dialog that shows exactly what will be applied and which permissions/actions it contains; nothing is ever applied silently. Entries carry a version: when a newer one is published, an update badge appears and re-importing updates cleanly. Ratings are anonymous 1-5 stars per install (no account); the public average shows once an entry has at least 3 votes. Publishing your own creation: export it as a share code in the app, then submit it on xenon-app.com/submit — a human reviews every submission before it appears in the catalog.',
  },
  {
    id: 'supporter',
    title: 'Supporter codes and locked catalog entries',
    keywords: ['supporter', 'sostenitore', 'code', 'codice', 'locked', 'bloccato', 'unlock', 'sbloccare', 'redeem', 'riscatta', 'xs', 'xl', 'premium', 'donation', 'donazione', 'limited', 'drop'],
    body: 'Some catalog entries are locked and unlock with a supporter code, redeemed directly on the entry inside the gallery. Codes start with XS (a supporter pass for pass-tier entries) or XL (a per-item code issued for one specific limited/purchased entry — an XS pass does not open limited drops and vice versa). Each code activates on up to 3 devices. Redemption talks only to the author\'s own hub service and sends nothing but the code and an anonymous per-install id. Previously unlocked content keeps working offline.',
  },
  {
    id: 'widgets-sdk',
    title: 'Custom community widgets and the Widget SDK sandbox',
    keywords: ['sdk', 'custom widget', 'widget personalizzato', 'sandbox', 'iframe', 'manifest', 'streams', 'actions', 'hosts', 'userhosts', 'fetch proxy', 'nas', 'docker', 'plex', 'ip', 'porta', 'port', 'indirizzo', 'address', 'storage', 'secrets', 'island', 'isola', 'teleprompter', 'create widget', 'crea widget', 'html', 'javascript', 'permessi widget'],
    body: 'Community widgets are HTML/CSS/JS packages rendered in a locked-down sandboxed iframe: no direct network and no access to the dashboard page. Every capability is declared in manifest.json and approved by the user: data streams, low-risk actions, external API hosts reached only through Xenon\'s fetch proxy, storage and a write-only secrets vault. For a user-owned LAN service (NAS, Docker, Plex), declare a `userHosts` slot instead of hard-coding the author\'s address; the approved value arrives at init.userHosts[id].base and loopback stays unreachable. The AI can write and install a widget on request, but it still gets no permission until the user approves it; add it from + → Custom widget. `"island": true` keeps the v4.6 short host-rendered text line. `"island": { "dynamic": true }` requests a separate advanced grant for Full/Minimal Live Activities made from Xenon-drawn text, icons, progress, playback bars, time/date/weather and up to two buttons. A live activity persists; a 1.2–30 second takeover animates in for a goal/result/track, exits and restores the previous content. Settings → Dynamic Island lists installed contributing packages and lets the user disable each source or all takeovers. System notifications take priority. `"accent": true` is a separate grant to tint the dashboard accent at runtime, for players Windows never reports (Plex): accent only, never saved, released when the widget is removed or paused. Full developer docs live in docs/WIDGET_SDK.md and are available through sdk_reference.',
  },
  {
    id: 'deck',
    title: 'Deck (stream-deck keys): profiles, actions, sliders, icon & sound packs',
    keywords: ['deck', 'stream deck', 'tasti', 'keys', 'profile', 'profilo', 'macro', 'slider', 'fader', 'smart profiles', 'virtual deck', 'soundboard', 'suoni', 'icone tasti', 'hold', 'double tap', 'hotkey'],
    body: 'The Deck widget is a programmable touch key grid (up to 8×8 per profile). Keys support tap / double-tap / hold actions from a large typed catalog (apps, media, audio mixer, OBS, Twitch, Spotify, Home Assistant, hotkeys, webhooks…), live state bindings (a key lights while e.g. Discord is muted), live value badges (timers, sensors), and touch sliders for volumes and lights. Smart Profiles auto-switch the visible profile when a chosen app gains focus. Virtual Deck opens the grid as an always-on-top window on the main PC monitor. Icon packs installed from the marketplace appear in the key icon picker; sound packs add clips to the Soundboard action category and survive profile export/import. The AI can build full profiles on request (it uses deck_action_catalog + configure_deck).',
  },
  {
    id: 'ambient',
    title: 'Ambient mode (screensaver scenes)',
    keywords: ['ambient', 'screensaver', 'salvaschermo', 'lock screen', 'focus', 'scene', 'scena', 'idle', 'clock', 'orologio fullscreen'],
    body: 'Ambient mode shows a fullscreen scene — the built-in one has a clock, now-playing media, weather and upcoming events, with configurable widgets. It can start on demand (voice command or button) and auto-start after an idle timeout. Community Ambient scenes from the marketplace are SDK packages rendered with the exact same sandbox and permission rules as widget tiles, just fullscreen. Tap to exit.',
  },
  {
    id: 'appearance',
    title: 'Themes, skins, colors, backgrounds',
    keywords: ['theme', 'tema', 'skin', 'aspetto', 'appearance', 'colore', 'colors', 'dark', 'light', 'scuro', 'chiaro', 'background', 'sfondo', 'wallpaper', 'retro', 'comic', 'glass', 'contrast'],
    body: 'Appearance layers: named theme presets (xenon, ocean, ember, violet, mono), Light/Dark/Auto mode, and a base skin — glass (the default Liquid Glass look), retro (Pixel Retro) or comic. Beyond presets, every semantic color (canvas, panels, controls, text, borders, accent, state colors) can be set to an exact hex value, with automatic contrast repair so text never becomes unreadable. Custom background images can be uploaded, and themes can also be installed from the marketplace. The AI applies any of this on request, live.',
  },
  {
    id: 'lighting',
    title: 'RGB lighting: iCUE devices + WLED, OpenRGB, Hue, Nanoleaf',
    keywords: ['rgb', 'lighting', 'luci', 'illuminazione', 'icue', 'corsair', 'wled', 'openrgb', 'hue', 'philips', 'nanoleaf', 'led', 'effetti', 'effects', 'animation', 'animazione', 'colore luci'],
    body: 'The lighting bridge drives Corsair devices through iCUE and, optionally, external systems: WLED, OpenRGB, Philips Hue and Nanoleaf (discovered on the LAN from the Lighting page). It offers manual colors, reactive effects (CPU-temperature gradient, album-cover color following the music, event flashes for timers/notifications/reminders) and ambient animations (solid, breathing, rainbow cycle, wave, aurora, candle, or a palette of your own colors). The master switch hands control back to iCUE when off. Deck keys can flash the lights when pressed, and the AI controls all of it by voice or text.',
  },
  {
    id: 'integrations',
    title: 'Integrations: Spotify, OBS, Twitch, YouTube, Streamer.bot, Wave Link, Discord, Home Assistant, UniFi, calendars',
    keywords: ['integration', 'integrazioni', 'spotify', 'obs', 'twitch', 'youtube', 'streamerbot', 'streamer.bot', 'wave link', 'wavelink', 'discord', 'home assistant', 'domotica', 'unifi', 'protect', 'camera', 'calendar', 'calendario', 'ics', 'google calendar', 'collegare', 'connect'],
    body: 'Each integration is connected from Settings and unlocks matching widgets, Deck actions and AI tools: Spotify (full playback + play-by-name), OBS Studio (record/stream/scenes), Twitch (clips, title/category, chat, markers, ads), YouTube live broadcasts, Streamer.bot actions, Elgato Wave Link mixing, Discord voice (mute/deafen/join channels), Home Assistant (lights, climate, covers, energy readings and more), UniFi Protect cameras, and external calendars via Google or any .ics feed. When an integration is not connected, its tools simply do not appear.',
  },
  {
    id: 'performance',
    title: 'Performance Mode, game mode and the Bit guardian pet',
    keywords: ['performance', 'prestazioni', 'game mode', 'gioco', 'fps', 'optimize', 'ottimizza', 'boost', 'priority', 'priorità', 'bit', 'pet', 'vitals', 'presentmon'],
    body: 'Performance Mode frees resources for gaming or heavy work: it shows a confirmation sheet listing exactly what it will do (power plan, pausing animations, optionally closing background apps) and applies nothing until confirmed; everything is restorable with one action. Game mode detects a fullscreen game automatically and adapts the dashboard; with the optional PresentMon component it shows real in-game FPS. Bit is the little guardian pet that reflects the PC\'s vitals — it reacts to temperature, load and your usage habits.',
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
    body: 'Xenon is local-first: the backend listens only on 127.0.0.1 (loopback) — nothing on the LAN or internet can reach it — and there are no accounts and no telemetry. Outbound connections happen only for features you actively use: weather, stocks/news, your chosen AI provider, the community catalog, and integrations you connect. The install id used for ratings and supporter activations is a random anonymous UUID, not an identity. AI memory and all user data stay in local files (server/data). Community widgets run in a no-network sandbox and only get the permissions you approve; server-side secrets (API keys, passwords) are never sent back to the browser.',
  },
  {
    id: 'troubleshooting',
    title: 'Common issues: settings not saving, empty tiles, port conflicts',
    keywords: ['problem', 'problema', 'issue', 'bug', 'not working', 'non funziona', 'settings not saving', 'impostazioni', 'reset', 'refresh', 'port 3030', 'porta', 'duplicate', 'doppio server', 'media vuoto', 'non salva', 'errore'],
    body: 'Frequent fixes: (1) Settings/theme reverting after a refresh usually means TWO backend processes are running and the stale one is holding the settings file — close Xenon fully (or end the duplicate node process) and start it once from its startup task. (2) Fans/watts empty → the hardware-sensors permission flow (see the sensors topic). (3) Now-playing tile empty → the playing app may not report media to Windows (SMTC); most players and browsers do. (4) "Port 3030 in use" → another Xenon instance is already running; the dashboard is at http://127.0.0.1:3030. (5) After an update something looks off → check the What\'s New/CHANGELOG first; the updater restores the previous version automatically if the update itself failed.',
  },
  {
    id: 'xeneon-edge',
    title: 'Showing Xenon on the CORSAIR Xeneon Edge (and other screens)',
    keywords: ['xeneon', 'edge', 'corsair', 'display', 'schermo', 'touchscreen', 'touch', 'monitor', 'second screen', 'secondo schermo', 'kiosk', 'native app', 'browser'],
    body: 'The dashboard is a local web app, so any surface can render it: open http://127.0.0.1:3030 in a browser placed on the Xeneon Edge (14.5", 2560×720, touch — the UI is designed touch-first for it), use the native Xenon app (a fullscreen kiosk shell of the same dashboard, bundled with the full installer), or the iCUE widget package. The same instance can be open on several screens at once — pages, settings and the Deck stay in sync live across all of them, and the Deck can also pop out as the Virtual Deck window on the main monitor.',
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
