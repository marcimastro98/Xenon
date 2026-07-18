/*
 * Xenon — Copyright (c) 2026 Marcello Mastroeni (marcimastro98).
 * Custom non-commercial license. Personal use only; no commercial use or
 * redistribution as your own. Attribution required. See LICENSE for terms.
 */
const http = require('http');
const { execFile: _execFileReal, spawn } = require('child_process');
// On Linux, transparently route SoundVolumeView.exe calls to PipeWire (wpctl)
// via linuxCollectors.svvShim; every other execFile call is forwarded verbatim.
// SVV and linuxCollectors are defined below but resolved at call time.
function execFile(...callArgs) {
  // try/catch guards the (rare) case of an execFile call during early module
  // load, before the SVV / linuxCollectors consts below are initialized (TDZ).
  try {
    if (linuxCollectors && callArgs[0] === SVV) return linuxCollectors.svvShim(callArgs);
  } catch { /* consts not ready yet, fall through to the real execFile */ }
  return _execFileReal(...callArgs);
}
const fs = require('fs');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
// Linux native collectors (GPU/disk/CPU-temp/network). Windows keeps the
// PowerShell path; on Linux those spawns fail (powershell.exe ENOENT) so the
// system tiles fall back to these. See linux-collectors.js.
const linuxCollectors = process.platform === 'linux' ? require('./linux-collectors') : null;
const fpsMonitor = require('./fpsmon');
const gameDetect = require('./gamedetect');
const winNotif = require('./winnotif');
const wakeWord = require('./wakeword');
const sdkWidgets = require('./sdk-widgets');
const sdkProxy = require('./sdk-proxy');
const sdkStore = require('./sdk-store');
const signalrgb = require('./signalrgb');
// Windowed-game detection: the fullscreen heuristic misses borderless/windowed
// titles, so the game detector also gets PresentMon's busiest flip-model
// presenter as a hint — when it matches the focused window, that's a game.
gameDetect.setGameHint(() => fpsMonitor.getGamingProcess());
const lighting = require('./lighting');
const deckStore = require('./js/deck-store'); // pure per-instance Deck merge helpers (shared with the client + tests)
const vitalsPetCore = require('./js/vitals-pet-core'); // Bit's pure core: durable pet-state merge helpers (shared with the client + tests)
const { sanitizeBgAssets, sanitizeBgFps } = require('./js/custom-bg'); // single owner of the bg image-asset + frame-cap rules (shared with the client + sandbox)
const { sanitizeSlideshow } = require('./js/slideshow-widget'); // single owner of the slideshow image rules (shared with the client)
const contentInstalls = require('./js/content-installs'); // validated import receipts shared with Settings
const themePalette = require('./js/theme-palette.js'); // single owner of the semantic-palette rules (shared with the client + tests)
const aiLocal = require('./ai-local');
const aiOpenai = require('./ai-openai');
const aiAnthropic = require('./ai-anthropic');
const { preserveAiProviderCreds, redactAiProviderCreds } = require('./ai-provider-creds');
const { createGuardian } = require('./guardian');
const { createBatteryMonitor } = require('./battery');
const { createAiMemory } = require('./ai-memory');
const { createAiActionLog } = require('./ai-action-log');
const aiLive = require('./ai-live');
const { splitSentences } = require('./tts-chunks');
const { createBriefingEngine } = require('./briefing');
const icsFeeds = require('./ics-feeds.js');
const { createRegistry } = require('./actions/registry');
const { createPerfRegistry } = require('./actions/perf-registry');
const { createObs, scenePreviewRequest } = require('./actions/obs');
const { createStreamerbot } = require('./actions/streamerbot');
const { createHomeAssistant, normalizeHomeAssistant, preserveHaToken, redactHaToken } = require('./actions/home-assistant');
const { createChroma } = require('./actions/chroma');
const { createWaveLink } = require('./actions/wavelink');
const { createEmbeddedBrowser } = require('./embedded-browser');
const browserAdblock = require('./embedded-browser-adblock');
const { createBrowserSurfaceSync } = require('./browser-surface-sync');
const { createSecondScreen } = require('./second-screen');
const { createScreenCapture } = require('./screen-capture');
const obsLaunch = require('./actions/obs-launch');
const { normalizeRemoteControl, preserveRemoteCreds, redactRemoteCreds } = require('./remote-control/settings');
const { preserveStreamCreds, redactStreamCreds } = require('./stream-creds');
const { createUnifiProtect, normalizeUnifi, preserveUnifiCreds, redactUnifiCreds } = require('./actions/unifi');
const { createUnifiEvents } = require('./unifi-events');
const stocks = require('./stocks');
const { preserveStockCreds, redactStockCreds } = require('./stocks-creds');
const football = require('./football');
const { preserveFootballCreds, redactFootballCreds } = require('./football-creds');
const news = require('./news');
const { preserveNewsCreds, redactNewsCreds } = require('./news-creds');
const claudeUsage = require('./claude-usage');
const communityCatalog = require('./community-catalog');
const supporterRedeem = require('./supporter-redeem');
const iconPacks = require('./icon-packs');
const soundPacks = require('./sound-packs');
const communityRatings = require('./community-ratings');
const communityLimited = require('./community-limited');
const { createRemoteControl } = require('./remote-control');
const { createSelfUpdate } = require('./self-update');
const { createHelperUpdate } = require('./helper-update');
const { createTwitchProvider } = require('./stream-twitch');
const { createDiscordProvider } = require('./discord-rpc');
const { createYouTubeProvider } = require('./stream-youtube');
const { createSpotifyProvider } = require('./stream-spotify');

// App version — read once from package.json so the in-app indicator always
// matches the shipped build. Falls back gracefully if the file is unreadable.
let APP_VERSION = '';
// Normalize away a stray leading "v" so the reported version is always plain
// semver (e.g. "3.2.6"). A "v"-prefixed package.json version once shipped and
// broke self-update: the staged build's "v3.2.6" never equalled the normalized
// release tag "3.2.6", so prepare failed with version_mismatch (and the modal
// showed "from vv3.2.4"). Stripping here keeps /version and /update/check clean
// regardless of what package.json holds.
try { APP_VERSION = String(require('../package.json').version || '').trim().replace(/^v/i, ''); } catch {}

// Local backend port. Overridable via XENON_PORT for side-by-side debugging;
// any invalid/out-of-range value falls back to the canonical 3030 so a typo in
// the env var can never strand the server on a random port with a broken host allowlist.
const PORT = (() => {
  const raw = parseInt(process.env.XENON_PORT, 10);
  return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : 3030;
})();

// ── Update check ──────────────────────────────────────────────────────────────
// Soft probe of the latest GitHub release so the dashboard can show a discreet
// "update available" hint in Settings. No token, never auto-downloads, and
// fail-silent: any network/API problem just means "no hint" until the next
// probe window. One probe serves every open dashboard.
const UPDATE_REPO = 'marcimastro98/Xenon';
const UPDATE_CHECK_TTL = 24 * 60 * 60 * 1000;   // reuse a successful probe for a day
const UPDATE_CHECK_RETRY = 60 * 60 * 1000;      // a failed probe retries after an hour
const UPDATE_NOTES_MAX = 8000;                  // cap the release-notes body we keep/serve
const UPDATE_MEDIA_MAX = 6;                     // at most this many bare URLs get a content-type probe
let _updateCache = { at: 0, ok: false, latest: '', tag: '', url: '', notes: '', name: '', publishedAt: '', mediaTypes: {} };
const { parseSemver, semverNewer } = require('./semver');

// ── Release-notes media (screenshots + videos) ──────────────────────────────
// The modal renders images/videos embedded in the GitHub release body. Because
// that body is untrusted text, media is restricted to GitHub-hosted URLs only
// (no arbitrary hosts → no tracking-pixel / IP-leak on open). Markdown images
// `![](url)` are unambiguously images; GitHub embeds *videos* as a bare URL on
// their own line (a UUID with no extension), so those are classified by a
// bounded content-type probe. Result: a `{ url: 'image' | 'video' }` map the
// client uses to pick <img> vs <video>. All of this rides the daily update-check
// cache — it runs at most once a day, never on a request hot path.
function isAllowedMediaUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== 'https:') return false;
    const h = url.hostname.toLowerCase();
    if (h === 'github.com') return url.pathname.startsWith('/user-attachments/assets/');
    return h === 'githubusercontent.com' || h.endsWith('.githubusercontent.com');
  } catch { return false; }
}

// Probe a bare media URL's content-type. Tries HEAD, then a 2-byte ranged GET
// (some GitHub asset redirects only surface the type on GET). Fail-silent.
async function classifyMediaContentType(url) {
  const read = async (method, extra) => {
    const res = await fetch(url, {
      method,
      headers: { 'User-Agent': 'XenonEdgeHub', ...(extra || {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(4000),
    });
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch {}
    if (!res.ok && res.status !== 206) return '';
    return ct;
  };
  let ct = '';
  try { ct = await read('HEAD'); } catch {}
  if (!ct) { try { ct = await read('GET', { Range: 'bytes=0-1' }); } catch {} }
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('image/')) return 'image';
  return '';
}

async function resolveReleaseMedia(body) {
  const md = String(body || '');
  const types = {};
  // Markdown images — trust the syntax, just enforce the host allowlist (no probe).
  const imgRe = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = imgRe.exec(md)) !== null) {
    if (isAllowedMediaUrl(m[1])) types[m[1]] = 'image';
  }
  // Bare URLs alone on a line — GitHub's video-embed shape (also occasionally an
  // image). Classify by content-type, bounded and in parallel so the daily probe
  // never stalls on a slow host.
  const bare = [];
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (/^https?:\/\/\S+$/.test(line) && isAllowedMediaUrl(line) && !types[line] && !bare.includes(line)) {
      bare.push(line);
    }
  }
  const probed = await Promise.all(
    bare.slice(0, UPDATE_MEDIA_MAX).map(async (url) => [url, await classifyMediaContentType(url).catch(() => '')])
  );
  for (const [url, t] of probed) if (t) types[url] = t;
  return types;
}

// Probe the latest GitHub release. `force` bypasses the cache (the manual
// "check now" button); otherwise a successful probe is reused for a day.
async function checkLatestRelease(force) {
  const now = Date.now();
  const ttl = _updateCache.ok ? UPDATE_CHECK_TTL : UPDATE_CHECK_RETRY;
  if (!force && _updateCache.at && now - _updateCache.at < ttl) return _updateCache;
  _updateCache = { at: now, ok: false, latest: '', tag: '', url: '', notes: '', name: '', publishedAt: '', mediaTypes: {} };
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'XenonEdgeHub', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const rel = await res.json();
      const tag = String((rel && rel.tag_name) || '');
      if (parseSemver(tag)) {
        _updateCache = {
          at: now, ok: true, latest: tag.replace(/^v/i, ''), tag,
          url: String((rel && rel.html_url) || `https://github.com/${UPDATE_REPO}/releases/latest`),
          notes: String((rel && rel.body) || '').slice(0, UPDATE_NOTES_MAX),
          name: String((rel && rel.name) || tag),
          publishedAt: String((rel && rel.published_at) || ''),
          mediaTypes: {},
        };
        // Resolve embedded screenshots/videos (GitHub-hosted only). Best-effort —
        // a failed probe simply means those items render as links in the modal.
        try { _updateCache.mediaTypes = await resolveReleaseMedia(_updateCache.notes); } catch { /* keep {} */ }
      }
    }
  } catch { /* offline / rate-limited — retry next window */ }
  return _updateCache;
}

// ── What's New (curated highlights for the RUNNING version) ─────────────────
// Distinct from the update-available modal (which nags users who are BEHIND with
// the remote release notes). This announces the headline features of the version
// the user is ALREADY on. Content is authored by hand in server/whatsnew.json and
// shipped with the build, so it always matches the running version and works
// offline. The client shows it at every startup until the user dismisses its
// `id`, and it only reappears when a later build ships a NEW `id` — a pure bugfix
// release keeps the previous `id` (or empties it) and so never re-nags. Text
// fields may be a plain string OR a { <lang>: string } map; the client picks the
// UI language with an English fallback. Media is GitHub-hosted only (same
// allowlist as the release-notes media).
const WHATSNEW_FILE = path.join(__dirname, 'whatsnew.json');
const WHATSNEW_TEXT_MAX = 2000;
let _whatsNewCache = null;   // { at, data } — re-read from disk at most once a minute

function normalizeWhatsNewText(v) {
  if (typeof v === 'string') return v.slice(0, WHATSNEW_TEXT_MAX);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const out = {};
    for (const [k, s] of Object.entries(v)) {
      if (/^[a-z]{2}$/i.test(k) && typeof s === 'string') out[k.toLowerCase()] = s.slice(0, WHATSNEW_TEXT_MAX);
    }
    return Object.keys(out).length ? out : '';
  }
  return '';
}

// Rebuild from known keys only (never spread untrusted input — prototype-pollution
// safe, and drops anything unrecognised like the "_note" author comment).
function normalizeWhatsNew(raw) {
  if (!raw || typeof raw !== 'object') return { id: '', title: '', url: '', footer: '', highlights: [] };
  const highlights = (Array.isArray(raw.highlights) ? raw.highlights : []).slice(0, 20).map((h) => {
    const media = (h && typeof h.media === 'string' && isAllowedMediaUrl(h.media)) ? h.media : '';
    let mediaType = String((h && h.mediaType) || '').toLowerCase();
    if (mediaType !== 'image' && mediaType !== 'video') mediaType = media ? 'image' : '';
    return {
      title: normalizeWhatsNewText(h && h.title),
      body: normalizeWhatsNewText(h && h.body),
      media,
      mediaType: media ? mediaType : '',
    };
  }).filter((h) => h.title || h.body || h.media);
  return {
    id: String(raw.id || '').slice(0, 64),
    title: normalizeWhatsNewText(raw.title),
    url: (typeof raw.url === 'string' && /^https:\/\//i.test(raw.url)) ? raw.url : '',
    footer: normalizeWhatsNewText(raw.footer),
    highlights,
  };
}

// Read + parse a JSON marker file written by a PowerShell script, stripping the
// UTF-8 BOM Windows PowerShell's `-Encoding UTF8` prepends (JSON.parse rejects
// a BOM'd payload — the documented "permanently idle" trap). Returns null when
// the file is absent or unparsable. Use this for every PS-written JSON file.
async function readPwshJson(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch { return null; }
}

async function loadWhatsNew() {
  const now = Date.now();
  if (_whatsNewCache && now - _whatsNewCache.at < 60 * 1000) return _whatsNewCache.data;
  let data = { id: '', title: '', url: '', footer: '', highlights: [] };
  try {
    data = normalizeWhatsNew(JSON.parse(await fs.promises.readFile(WHATSNEW_FILE, 'utf8')));
  } catch { /* missing/invalid → empty: the modal simply won't show */ }
  _whatsNewCache = { at: now, data };
  return data;
}

let isMuted = false;
let cachedSpeakerId   = null; // full CLI ID — for SetDefault
let cachedSpeakerName = null; // short endpoint name — for SetVolume/ToggleMute
let cachedMicId       = null;
let cachedMicLabel    = null; // friendly name (F.NAME) used to match DirectShow devices
let _lastSpeakerVolume = 50;  // updated by getAudioInfo — used for duck/restore
let _duckActive        = false;
let _duckSavedVolume   = null;
let _aiFocusedScreen   = null; // last monitor the AI captured — its "focus" for follow-ups

// ── AI model ids ─────────────────────────────────────────────────────────────
// Centralized so a model upgrade is a one-line change instead of a hunt through
// the file. `chat` is the default Gemini model for chat / function-calling / STT
// / web-search; `chatPro` is the opt-in stronger model for hard reasoning
// (Settings → Funzioni AI → "Ragionamento avanzato"); `tts` is the speech model.
const AI_MODELS = Object.freeze({
  chat: 'gemini-3.5-flash',
  chatPro: 'gemini-3.5-pro',
  tts: 'gemini-3.1-flash-tts-preview',
  // Realtime full-duplex voice (Voce Live). Preview model — if a key lacks Live
  // access the session closes on connect and we fall back to the turn-based path.
  live: 'gemini-3.1-flash-live-preview',
});

// Core Xenon AI function declarations — the always-available tools (dashboard,
// media, audio, system, timers, notes/tasks/calendar, lighting, deck, memory,
// stocks/football/news, web/vision). Hoisted so BOTH the /api/ai turn-based
// handler (which appends integration-conditional tools) and the realtime Voce
// Live endpoint share one identical, drift-free source. Returns a fresh array
// each call so callers can push without mutating a shared const.
function buildCoreAiFunctions() {
  return [
        // ── Microphone ──
        { name: 'toggle_mic', description: 'Toggle microphone mute/unmute', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'mute_mic', description: 'Mute the microphone', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'unmute_mic', description: 'Unmute the microphone', parameters: { type: 'OBJECT', properties: {} } },
        // ── Media ──
        { name: 'media_playpause', description: 'Play or pause current media playback', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'media_next', description: 'Skip to the next track', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'media_previous', description: 'Go to the previous track', parameters: { type: 'OBJECT', properties: {} } },
        // ── Volume / Audio ──
        { name: 'set_volume', description: 'Set master speaker volume (0-100)', parameters: { type: 'OBJECT', properties: { level: { type: 'NUMBER', description: 'Volume level 0-100' } }, required: ['level'] } },
        { name: 'toggle_speaker_mute', description: 'Toggle the speaker/audio output mute on or off', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'set_mic_volume', description: 'Set microphone input volume (0-100)', parameters: { type: 'OBJECT', properties: { level: { type: 'NUMBER', description: 'Mic volume 0-100' } }, required: ['level'] } },
        { name: 'app_audio', description: 'Adjust the audio of a SPECIFIC running application (per-app mixer) — turn one app up or down, or mute/unmute it, without touching the master volume. e.g. "lower Spotify", "mute Chrome".', parameters: { type: 'OBJECT', properties: {
          app: { type: 'STRING', description: 'The application name or process, e.g. "Spotify", "chrome", "Discord"' },
          action: { type: 'STRING', description: 'One of: volume_up, volume_down, mute, unmute, toggle_mute' },
        }, required: ['app', 'action'] } },
        // ── System ──
        { name: 'lock_pc', description: 'Lock the Windows workstation', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'get_system_info', description: 'Get current CPU, GPU, RAM and disk usage stats, plus fan speeds (fans[]) and power draw in watts (power.cpu/gpu/psu/total)', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'get_battery_status', description: 'Get the battery level of the user\'s wireless peripherals (mouse, keyboard, headset — Corsair via iCUE and Bluetooth devices). Use for "how\'s my mouse battery", "batteria del mouse".', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'get_energy_status', description: 'Get the full energy picture: the PC\'s power draw in watts (CPU/GPU/PSU) plus the user\'s Home Assistant power/energy readings (solar production, smart plugs, home meter, UPS). Use for "how much power is the PC using", "quanto sta producendo il fotovoltaico", "consumo di casa".', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'get_weather', description: 'Get current weather conditions and forecast', parameters: { type: 'OBJECT', properties: {} } },
        // ── Stock market (Borsa) ──
        { name: 'get_stock_quote', description: 'Get the current price and day change for one or more stock, index, crypto or FX symbols (e.g. "AAPL", "FTSEMIB.MI", "BTC-EUR", "^GSPC"). Use for "how is Apple doing", "price of Bitcoin", "how is the FTSE MIB today".', parameters: { type: 'OBJECT', properties: { symbols: { type: 'STRING', description: 'One symbol, or several comma-separated (e.g. "AAPL, MSFT"). Use the ticker symbol; for Borsa Italiana add .MI (e.g. ENI.MI).' } }, required: ['symbols'] } },
        { name: 'get_stock_watchlist', description: 'Get the current prices and day changes for every stock in the user\'s watchlist (their saved favorites). Use for "how are my stocks", "read my watchlist", "any big movers today".', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'add_stock_favorite', description: 'Add a stock/index/crypto symbol to the user\'s watchlist so it shows in the Borsa widget and ticker. Use for "add Tesla to my stocks", "watch ENI.MI".', parameters: { type: 'OBJECT', properties: { symbol: { type: 'STRING', description: 'The ticker symbol to add (e.g. "TSLA", "ENI.MI", "BTC-EUR").' } }, required: ['symbol'] } },
        // ── Football (Calcio) ──
        { name: 'get_football_scores', description: 'Get the next fixture and latest result for the user\'s favorite football (soccer) teams — the teams saved in their Calcio widget. Use for "how did Napoli do", "any football results", "when does Inter play next", "my teams".', parameters: { type: 'OBJECT', properties: { team: { type: 'STRING', description: 'Optional team name to filter to one of their favorites (e.g. "Napoli"). Omit for all favorites.' } } } },
        { name: 'get_league_standings', description: 'Get the current league table / standings for a football competition. Give a competition name ("Serie A", "Premier League", "Champions League", "World Cup") or a team the user follows (its league is used). Use for "Serie A table", "Champions League standings", "where is Napoli in the table".', parameters: { type: 'OBJECT', properties: { team: { type: 'STRING', description: 'A competition name (e.g. "Serie A", "Champions League") or a followed team name (e.g. "Napoli" → Serie A).' } }, required: ['team'] } },
        // ── News ──
        { name: 'get_news_headlines', description: 'Get the latest news headlines — either about a specific topic, or the top headlines from the feeds the user follows in the News widget. Use for "what\'s in the news", "any news about AI", "latest headlines", "news about Milan".', parameters: { type: 'OBJECT', properties: { topic: { type: 'STRING', description: 'Optional topic/keyword to fetch headlines about (e.g. "artificial intelligence", "elezioni"). Omit for the user\'s followed feeds.' } } } },
        // ── Web search ──
        { name: 'web_search', description: 'Search the internet for current, recent, or real-time information you are not certain about (news, prices, sports scores, release dates, live facts, anything after your training cutoff). Returns a grounded summary with sources. Use it instead of guessing whenever freshness matters.', parameters: { type: 'OBJECT', properties: {
          query: { type: 'STRING', description: 'The search query, phrased clearly (e.g. "EUR USD exchange rate today", "latest iPhone model 2026")' },
        }, required: ['query'] } },
        // ── Screen vision ──
        { name: 'capture_screen', description: 'Capture a fresh screenshot of the user\'s screen so you can see what is currently displayed. Use it whenever the user asks about what is on their screen, asks you to read/look at/check something visual, or references on-screen content. The capture is always live (current moment). On multi-monitor setups, pass the 1-based monitor number; if the user did not say which monitor and there are several, omit it to receive the monitor list and then ask which one to focus on.', parameters: { type: 'OBJECT', properties: { monitor: { type: 'NUMBER', description: '1-based monitor index to capture (e.g. 1, 2). Omit on single-monitor setups or to list monitors first.' } } } },
        // ── Notes ──
        { name: 'read_notes', description: 'Read the current notes/scratchpad content', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'write_notes', description: 'Replace the notes content with new text', parameters: { type: 'OBJECT', properties: { content: { type: 'STRING', description: 'New notes content' } }, required: ['content'] } },
        // ── Tasks ──
        { name: 'list_tasks', description: 'List all tasks in the task list', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'create_task', description: 'Create a new task in the task list', parameters: { type: 'OBJECT', properties: {
          text: { type: 'STRING', description: 'Task description' },
          priority: { type: 'STRING', description: 'Priority: high, medium, or low (default: medium)' },
        }, required: ['text'] } },
        { name: 'delete_task', description: 'Delete a specific task by its id. Use list_tasks first to get the id if not known.', parameters: { type: 'OBJECT', properties: {
          id: { type: 'STRING', description: 'Task id to delete' },
        }, required: ['id'] } },
        { name: 'clear_all_tasks', description: 'Delete ALL tasks at once. Use only when the user explicitly asks to clear or delete all tasks.', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'complete_task', description: 'Mark a task as completed or uncompleted. Use list_tasks first if you do not know the id.', parameters: { type: 'OBJECT', properties: {
          id: { type: 'STRING', description: 'Task id to mark' },
          completed: { type: 'BOOLEAN', description: 'true to mark done, false to unmark (default true)' },
        }, required: ['id'] } },
        // ── Calendar ──
        { name: 'list_calendar_events', description: 'List upcoming calendar events', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'create_calendar_event', description: 'Create a new calendar event', parameters: { type: 'OBJECT', properties: {
          title: { type: 'STRING', description: 'Event title' },
          starts_at: { type: 'STRING', description: 'Start datetime in ISO 8601, e.g. 2026-05-25T14:00:00' },
          notes: { type: 'STRING', description: 'Optional notes' },
          reminder_at: { type: 'STRING', description: 'Optional reminder datetime in ISO 8601' },
        }, required: ['title', 'starts_at'] } },
        { name: 'delete_calendar_event', description: 'Delete a calendar event by its id. Use list_calendar_events first if you do not know the id.', parameters: { type: 'OBJECT', properties: {
          id: { type: 'STRING', description: 'Event id to delete' },
        }, required: ['id'] } },
        { name: 'clear_all_calendar_events', description: 'Delete ALL calendar events at once. Use only when the user explicitly asks to clear or delete all events.', parameters: { type: 'OBJECT', properties: {} } },
        // ── Dashboard UI ──
        { name: 'open_weather_panel', description: 'Open the weather details panel', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'open_settings', description: 'Open the settings panel', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'open_app_switcher', description: 'Open the app switcher panel', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'start_ambient_mode', description: 'Open the Ambient/screensaver mode (fullscreen scene with clock, media, weather — the old focus lock screen)', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'stop_ambient_mode', description: 'Close the Ambient/screensaver mode if it is showing', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'change_theme', description: 'Change the dashboard color theme (xenon, ocean, ember, violet, mono)', parameters: { type: 'OBJECT', properties: { preset: { type: 'STRING', description: 'Theme name' } }, required: ['preset'] } },
        { name: 'close_ai_panel', description: 'Close the Xenon AI chat panel', parameters: { type: 'OBJECT', properties: {} } },
        // ── Performance Mode ──
        { name: 'optimize_performance', description: 'Open Performance Mode optimization (shows the confirmation sheet listing what will be done). Use when the user asks to optimize performance, free up resources, or boost the PC for gaming/work. It never applies anything without the user confirming on the sheet.', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'restore_performance', description: 'Undo Performance Mode: restore the previous power plan, resume animations, and reopen any apps that were closed. Use when the user asks to restore performance settings or undo the optimization.', parameters: { type: 'OBJECT', properties: {} } },
        // ── Timers ──
        { name: 'start_timer', description: 'Start a new countdown timer. Use for user requests like "set a timer for 5 minutes", "remind me in 30 seconds", etc.', parameters: { type: 'OBJECT', properties: {
          label: { type: 'STRING', description: 'Short label for the timer, e.g. "Pasta", "Break", "Meeting"' },
          duration_secs: { type: 'NUMBER', description: 'Duration in seconds (e.g. 300 for 5 minutes, 3600 for 1 hour)' },
        }, required: ['duration_secs'] } },
        { name: 'list_timers', description: 'List all active timers and their remaining time', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'delete_timer', description: 'Delete a timer by its id', parameters: { type: 'OBJECT', properties: {
          id: { type: 'STRING', description: 'Timer id to delete' },
        }, required: ['id'] } },
        // ── System launcher ──
        { name: 'open_application', description: 'Open an app, website, or file on the user\'s Windows PC. For well-known apps use their plain name (spotify, chrome, notepad, obs, vlc…). For Steam use exactly "steam", for Discord use "discord". Full URLs (https://…) and absolute file paths also work.', parameters: { type: 'OBJECT', properties: {
          target: { type: 'STRING', description: 'App name (e.g. "spotify", "steam", "discord"), full URL, or absolute file path' },
        }, required: ['target'] } },
        { name: 'close_application', description: 'Close / terminate a running application on the user\'s Windows PC. Use the plain app name (e.g. "spotify", "chrome", "notepad", "discord", "steam", "obs", "vlc"). Works for any process.', parameters: { type: 'OBJECT', properties: {
          target: { type: 'STRING', description: 'App name to close, e.g. "spotify", "chrome", "discord"' },
        }, required: ['target'] } },
        // ── RGB Lighting (Corsair / iCUE bridge) ──
        { name: 'set_lights', description: 'Set a manual RGB colour on the Corsair devices (overrides reactive effects until cleared). Accepts a colour name (EN or IT, e.g. "red"/"rosso") or a #RRGGBB hex. Use "off"/"spento" to turn them dark.', parameters: { type: 'OBJECT', properties: {
          color: { type: 'STRING', description: 'Colour name or #RRGGBB, e.g. "red", "rosso", "#00ff88", "off"' },
        }, required: ['color'] } },
        { name: 'clear_lights', description: 'Clear the manual colour override so reactive effects (CPU temperature, album colour, event flashes) resume.', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'set_effect', description: 'Enable or disable a lighting effect: temperature (CPU temp → colour), musicAlbum (album cover → LEDs), timer, notification, reminder.', parameters: { type: 'OBJECT', properties: {
          effect: { type: 'STRING', description: 'One of: temperature, musicAlbum, timer, notification, reminder' },
          enabled: { type: 'BOOLEAN', description: 'true to enable, false to disable' },
        }, required: ['effect', 'enabled'] } },
        { name: 'set_event_effect', description: 'Configure an event flash effect (timer, notification, reminder): its colour and animation style, and optionally enable it.', parameters: { type: 'OBJECT', properties: {
          effect: { type: 'STRING', description: 'One of: timer, notification, reminder' },
          color: { type: 'STRING', description: 'Colour name or #RRGGBB (e.g. "red", "rosso", "#00ff88")' },
          style: { type: 'STRING', description: 'Animation style: blink, pulse, or solid' },
          enabled: { type: 'BOOLEAN', description: 'Optional: enable/disable the effect' },
        }, required: ['effect'] } },
        { name: 'set_animation', description: 'Set the ambient RGB lighting animation. Styles: none, solid (fixed colour), breathing, cycle (rainbow), wave (scrolling rainbow), aurora (northern-lights drift), candle (warm flicker), palette (cycles the user\'s own 2-5 colours). Optionally set the colour (breathing/candle), the speed, and the palette colours. The lighting master must be on for the animation to show (use set_lighting_bridge).', parameters: { type: 'OBJECT', properties: {
          style: { type: 'STRING', description: 'One of: none, solid, breathing, cycle, wave, aurora, candle, palette' },
          color: { type: 'STRING', description: 'Optional colour name or #RRGGBB (used by breathing and candle)' },
          speed: { type: 'NUMBER', description: 'Optional speed 1-100 (higher = faster)' },
          palette: { type: 'STRING', description: 'Optional comma-separated 2-5 colours for the palette style, e.g. "#ff0000,#0000ff" or "rosso,blu,verde"' },
        } } },
        { name: 'set_lighting_bridge', description: 'Turn the whole RGB lighting bridge on or off (master switch). When off, control returns to iCUE.', parameters: { type: 'OBJECT', properties: {
          enabled: { type: 'BOOLEAN', description: 'true to enable the bridge, false to disable' },
        }, required: ['enabled'] } },
        { name: 'show_sensor', description: 'Read a current sensor value to report to the user (e.g. CPU temperature, fan speed, power draw).', parameters: { type: 'OBJECT', properties: {
          sensor: { type: 'STRING', description: 'Sensor to read: cpuTemp, gpuTemp, cpu, gpu, cpuFan, gpuFan, cpuWatts, gpuWatts, totalWatts, psuWatts' },
        }, required: ['sensor'] } },
        { name: 'go_to_page', description: 'Navigate the dashboard to a page: "dashboard" (page 1) or "lighting" (page 2, RGB controls).', parameters: { type: 'OBJECT', properties: {
          page: { type: 'STRING', description: 'Page id: dashboard or lighting' },
        }, required: ['page'] } },
        { name: 'switch_deck_profile', description: 'Switch the Deck widget (a Stream Deck-style key grid) to one of its profiles. Use the EXACT profile name from the list of available deck profiles given in the system context. Only call this when the user asks to change/switch the deck profile.', parameters: { type: 'OBJECT', properties: {
          profile: { type: 'STRING', description: 'The exact name of the deck profile to activate' },
        }, required: ['profile'] } },
        // ── Appearance & preferences (fine-grained dashboard customization) ──
        { name: 'customize_appearance', description: 'Change the dashboard look in detail. Pass any subset: a named theme preset, the light/dark/auto mode, the base skin (glass/retro/comic), or exact semantic colours for the app canvas, panels, nested surfaces, controls, text, borders, accent and UI states. Use this (not change_theme) for any specific-colour request. Applies live, contrast-checks by default and persists.', parameters: { type: 'OBJECT', properties: {
          preset: { type: 'STRING', description: 'Optional named theme: xenon, ocean, ember, violet, mono' },
          style: { type: 'STRING', description: 'Optional base skin: "glass" (Liquid Glass), "retro" (Pixel Retro CRT), or "comic" (Comic Book)' },
          appearance: { type: 'STRING', description: 'Optional UI mode: light, dark, or auto' },
          accent: { type: 'STRING', description: 'Optional accent colour as #RRGGBB (the highlight/brand colour)' },
          background: { type: 'STRING', description: 'Optional app canvas/background colour as #RRGGBB' },
          surface: { type: 'STRING', description: 'Optional main panel/widget/modal surface colour as #RRGGBB' },
          surface_alt: { type: 'STRING', description: 'Optional secondary row/card/tab surface colour as #RRGGBB' },
          control_color: { type: 'STRING', description: 'Optional input/menu/button surface colour as #RRGGBB' },
          text: { type: 'STRING', description: 'Optional primary text colour as #RRGGBB' },
          muted_text: { type: 'STRING', description: 'Optional secondary text colour as #RRGGBB' },
          line_color: { type: 'STRING', description: 'Optional border/divider colour as #RRGGBB' },
          accent_text: { type: 'STRING', description: 'Optional text/icon colour used on accent-filled controls as #RRGGBB' },
          success_color: { type: 'STRING', description: 'Optional success state colour as #RRGGBB' },
          warning_color: { type: 'STRING', description: 'Optional warning state colour as #RRGGBB' },
          danger_color: { type: 'STRING', description: 'Optional danger/error state colour as #RRGGBB' },
          info_color: { type: 'STRING', description: 'Optional informational state colour as #RRGGBB' },
          contrast_guard: { type: 'BOOLEAN', description: 'Automatically repair unsafe text/control contrast (default true)' },
        } } },
        { name: 'create_dashboard_style', description: 'Build a COMPLETE custom dashboard theme from a description, apply it live, and save it as a named card in the Temi gallery so the user can switch back to it. Pass any subset — every field defaults to the current look. Use this when the user asks for a whole vibe/aesthetic rather than one colour ("crea un tema cyberpunk viola", "make me a warm minimalist theme", "un look pastello morbido e arrotondato").', parameters: { type: 'OBJECT', properties: {
          name: { type: 'STRING', description: 'Short theme name for the gallery card (e.g. "Cyberpunk Viola")' },
          skin: { type: 'STRING', description: 'Base skin: "glass" (Liquid Glass), "retro" (Pixel Retro CRT), or "comic" (Comic Book)' },
          base_appearance: { type: 'STRING', description: 'Base mode: "light" or "dark"' },
          accent: { type: 'STRING', description: 'Accent/brand colour #RRGGBB' },
          background: { type: 'STRING', description: 'App canvas/background colour #RRGGBB' },
          surface: { type: 'STRING', description: 'Main panel/widget/modal surface colour #RRGGBB' },
          surface_alt: { type: 'STRING', description: 'Secondary row/card/tab surface colour #RRGGBB' },
          control_color: { type: 'STRING', description: 'Input/menu/button surface colour #RRGGBB' },
          text: { type: 'STRING', description: 'Primary text colour #RRGGBB' },
          muted_text: { type: 'STRING', description: 'Secondary/muted text colour #RRGGBB' },
          line_color: { type: 'STRING', description: 'Dividers/borders colour #RRGGBB' },
          accent_text: { type: 'STRING', description: 'Text/icon colour on accent-filled controls #RRGGBB' },
          success_color: { type: 'STRING', description: 'Success state colour #RRGGBB' },
          warning_color: { type: 'STRING', description: 'Warning state colour #RRGGBB' },
          danger_color: { type: 'STRING', description: 'Danger/error state colour #RRGGBB' },
          info_color: { type: 'STRING', description: 'Informational state colour #RRGGBB' },
          contrast_guard: { type: 'BOOLEAN', description: 'Automatically repair unsafe text/control contrast (default true)' },
          panel_opacity: { type: 'NUMBER', description: 'Panel opacity 0.05–1 (lower = more translucent)' },
          corner_radius: { type: 'NUMBER', description: 'Corner roundness 0–2 (0 = square, 1 = default, 2 = very round)' },
          glass_blur: { type: 'NUMBER', description: 'Glass blur in px 0–40 (default 22)' },
          glass_saturation: { type: 'NUMBER', description: 'Glass colour saturation % 100–220 (default 160)' },
          border_strength: { type: 'NUMBER', description: 'Panel border strength 0–2 (1 = default)' },
          shadow_strength: { type: 'NUMBER', description: 'Panel shadow strength 0–2 (1 = default)' },
        } } },
        { name: 'create_animated_background', description: 'Write and apply a custom ANIMATED BACKGROUND for the dashboard from the user\'s description. YOU author the code: define a JavaScript function draw(ctx, t, w, h) that paints ONE frame — ctx is a canvas 2D context, t is elapsed seconds (float), w and h are the pixel size. It is called ~60×/second on a full-screen canvas behind the dashboard. Keep it self-contained (declare any particles/state with const or let ABOVE the draw function so it persists across frames), efficient, and tasteful behind a UI (avoid a pure-white fill or harsh strobing). The code runs in an isolated sandbox with NO network, DOM, storage or dashboard access, so use only the canvas 2D API, Math and Date. Use for requests like "crea uno sfondo animato con particelle blu", "make me a drifting starfield background", "sfondo tipo nebulosa viola". Applies live and persists.', parameters: { type: 'OBJECT', properties: {
          name: { type: 'STRING', description: 'Short name for this background (e.g. "Nebulosa viola")' },
          code: { type: 'STRING', description: 'The full JavaScript source defining function draw(ctx, t, w, h). May declare helper state/constants above draw. No imports, no network, no DOM.' },
        }, required: ['code'] } },
        { name: 'configure_preferences', description: 'Adjust dashboard preferences: 12h/24h clock, temperature unit, interface language, weather location, and which widgets appear on the focus lock screen. Pass only the fields the user asked to change. Applies live and persists.', parameters: { type: 'OBJECT', properties: {
          clock_format: { type: 'STRING', description: 'Clock format: auto, 12, or 24' },
          temp_unit: { type: 'STRING', description: 'Temperature unit: c or f' },
          language: { type: 'STRING', description: 'UI language code: en, it, ko, ja, zh, es, fr, de, pt, ru, or nl' },
          weather_mode: { type: 'STRING', description: 'Weather location mode: auto (geolocate) or manual' },
          weather_city: { type: 'STRING', description: 'City name — sets weather_mode to manual automatically' },
          lock_widgets: { type: 'OBJECT', description: 'Focus lock-screen widgets to show/hide', properties: {
            clock: { type: 'BOOLEAN' }, weather: { type: 'BOOLEAN' }, media: { type: 'BOOLEAN' }, calendar: { type: 'BOOLEAN' },
          } },
        } } },
        { name: 'set_media_source', description: 'Choose which media app the Now Playing tile follows when several are playing: pass the app/source name (e.g. "Spotify", "YouTube") or "auto" to follow whatever is active. Use when the user says "show Spotify", "segui YouTube", "torna automatico".', parameters: { type: 'OBJECT', properties: {
          source: { type: 'STRING', description: 'Media source name (e.g. "Spotify", "YouTube") or "auto"' },
        }, required: ['source'] } },
        { name: 'list_audio_devices', description: 'List the available speaker/output and microphone/input devices (and which are current). Use before set_audio_device when you do not know the exact device names, or to answer "what speakers/mics do I have?".', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'set_audio_device', description: 'Switch the default audio output (speaker) or input (microphone) device by name. If the name does not match, you get the list of available devices back — then ask the user which one. Use for "switch to my headphones", "usa le casse", "cambia microfono".', parameters: { type: 'OBJECT', properties: {
          kind: { type: 'STRING', description: 'Which device to switch: "speaker" (output) or "mic" (input)' },
          name: { type: 'STRING', description: 'The device name or a distinctive part of it, e.g. "Headphones", "Realtek", "USB microphone"' },
        }, required: ['kind', 'name'] } },
        // ── Deck composer + creator ecosystem (v4.4) ──
        { name: 'deck_action_catalog', description: 'Read-only: the FULL Deck action catalog (every action type + its params/options), the live-state sources, live-value sources and slider targets. Call this BEFORE configure_deck when you are unsure of an exact action type or its parameters.', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'configure_deck', description: 'Create or extend a Deck (stream-deck) profile with FULL power: any action type from deck_action_catalog (typed actions with their exact params, e.g. {type:"obsScene",scene:"Live"} or {type:"typeText",text:"brb"}), per-key tap/double/hold, live state bindings, live value badges, touch sliders and Smart-Profiles auto-switch rules. Prefer this over genesis_setup_deck when the user asks for anything beyond its basic action list. Every action is re-validated by the app before it is stored or runs.', parameters: { type: 'OBJECT', properties: {
          profileName: { type: 'STRING', description: 'Short profile name in the user\'s language, e.g. "Streaming Pro"' },
          cols: { type: 'NUMBER', description: 'Grid columns (1-8)' },
          rows: { type: 'NUMBER', description: 'Grid rows (1-8)' },
          keys: { type: 'ARRAY', description: 'The keys (max 32). Each: title, one emoji icon, optional hex color; then EITHER actions (array of typed action objects, run in order on tap; optional double/hold arrays for those gestures) OR kind:"slider" + slider target.', items: { type: 'OBJECT', properties: {
            title: { type: 'STRING' },
            icon: { type: 'STRING', description: 'One emoji' },
            color: { type: 'STRING', description: 'Hex accent, e.g. #ff3b30' },
            kind: { type: 'STRING', description: '"action" (default) or "slider" (a touch fader)' },
            actions: { type: 'ARRAY', description: 'Tap: typed action objects, e.g. [{"type":"micMute","mode":"toggle"}]. Each may carry delayMs.', items: { type: 'OBJECT', properties: { type: { type: 'STRING' } } } },
            double: { type: 'ARRAY', description: 'Optional double-tap actions (same shape)', items: { type: 'OBJECT', properties: { type: { type: 'STRING' } } } },
            hold: { type: 'ARRAY', description: 'Optional press-and-hold actions (same shape)', items: { type: 'OBJECT', properties: { type: { type: 'STRING' } } } },
            state: { type: 'OBJECT', description: 'Optional live-state binding, e.g. {"source":"discordMuted"} or {"source":"haEntity","entity":"light.desk"} — the key lights while ON', properties: { source: { type: 'STRING' } } },
            live: { type: 'OBJECT', description: 'Optional live value ON the face, e.g. {"source":"timer","name":"Pasta"} for a ticking countdown, or {"source":"sensor","name":"cpuWatts"} for a hardware reading (cpu, gpu, cpuTemp, gpuTemp, cpuFan, gpuFan, cpuWatts, gpuWatts, totalWatts, psuWatts, battery:<device name>)', properties: { source: { type: 'STRING' } } },
            stateStyle: { type: 'OBJECT', description: 'Optional alternate face while the state is ON: {"icon":"🔴","label":"LIVE","color":"#ff3355"}', properties: { icon: { type: 'STRING' }, label: { type: 'STRING' }, color: { type: 'STRING' } } },
            slider: { type: 'OBJECT', description: 'kind:"slider" only. target: volume|appVolume|spotifyVolume|obsInput|haLight|discordInput|discordOutput (+ app/entity/source when the target needs one); orient: "v"|"h"', properties: { target: { type: 'STRING' }, app: { type: 'STRING' }, entity: { type: 'STRING' }, source: { type: 'STRING' }, orient: { type: 'STRING' } } },
          }, required: ['title'] } },
          autoSwitch: { type: 'OBJECT', description: 'Optional Smart Profiles: auto-show a profile when an app is focused. {"enabled":true,"revert":"default"|"stay","rules":[{"exe":"obs64","profile":"Streaming"}]} (exe = process name, lowercase, no .exe)', properties: { enabled: { type: 'BOOLEAN' }, revert: { type: 'STRING' }, rules: { type: 'ARRAY', items: { type: 'OBJECT', properties: { exe: { type: 'STRING' }, profile: { type: 'STRING' } }, required: ['exe', 'profile'] } } } },
        } } },
        { name: 'create_widget', description: 'Create and install a COMMUNITY WIDGET from code you write: a sandboxed HTML/CSS/JS package rendered in a dashboard tile. Use when the user asks for a widget that does not exist ("make me a widget that shows X"). Write self-contained files (no external URLs in markup — the sandbox has NO direct network). files MUST include manifest.json ({"api":1,"name":...,"streams":[...],"actions":[...]}) and index.html. Data arrives via postMessage: send {"xenonSdk":1,"type":"hello"} to window.parent, then listen for {"type":"data","stream",...} messages. Optional manifest capabilities, each opt-in and user-approved: "hosts":[...] to call up to 8 external APIs via the fetch proxy (type:"fetch"); "storage":true for a persistent key/value store that survives updates (type:"store" with op get/set/delete/keys/clear) — use it to remember the user\'s settings; "storageGroup":"id" to share that store across sibling widgets; "secrets":true for a write-only API-key vault (type:"secret" op set/delete/names/has) used via {{secret:NAME}} placeholders inside a fetch (never hardcode a key). Map/radar tiles load as <img>/Leaflet layers from "/sdk/tile/<id>?u=<encoded tile url>" (host must be in "hosts"). Call sdk_reference FIRST when you are unsure of a stream name, an action category, a manifest field or a protocol message — it returns the exact allowlists and the full SDK docs by section. The user still approves every permission before the widget can see or do anything.', parameters: { type: 'OBJECT', properties: {
          id: { type: 'STRING', description: 'Package id: lowercase letters/digits/dashes, 2-40 chars, e.g. "cpu-ring"' },
          files: { type: 'ARRAY', description: 'The package files as plain text (manifest.json + index.html + any .js/.css)', items: { type: 'OBJECT', properties: {
            path: { type: 'STRING', description: 'Relative path, e.g. "manifest.json", "index.html", "widget.js"' },
            content: { type: 'STRING', description: 'The file\'s full text content' },
          }, required: ['path', 'content'] } },
        }, required: ['id', 'files'] } },
        { name: 'marketplace_search', description: 'Search the Xenon community catalog (themes, backgrounds, pages, Deck profiles, widgets, Ambient scenes, bundles, icon packs, sound packs) by text and/or kind. Use when the user asks what is available, e.g. "c\'è un tema cyberpunk?".', parameters: { type: 'OBJECT', properties: {
          query: { type: 'STRING', description: 'Free-text search (name, author, tags)' },
          kind: { type: 'STRING', description: 'Optional filter: theme|bg|page|deck|widget|ambient|bundle|icons|sounds' },
        } } },
        { name: 'marketplace_install', description: 'Start installing a community catalog entry by its id (from marketplace_search). This OPENS THE IMPORT REVIEW DIALOG — the user always confirms there; nothing is applied silently. Locked (supporter) entries cannot be installed this way.', parameters: { type: 'OBJECT', properties: {
          id: { type: 'STRING', description: 'The catalog entry id' },
        }, required: ['id'] } },
        { name: 'open_virtual_deck', description: 'Open the Deck as its own always-on-top window on the user\'s main monitor (Virtual Deck). Use for "apri il deck sul PC", "voglio i tasti sullo schermo principale".', parameters: { type: 'OBJECT', properties: {
          instance: { type: 'STRING', description: 'Optional deck instance id (default: the primary deck)' },
        } } },
        // ── App knowledge (grounding, read-only) ──
        { name: 'xenon_knowledge', description: 'Read-only: your OWN documentation about Xenon itself. Call this BEFORE answering any question about how Xenon works, its setup, features, requirements, or troubleshooting — e.g. why sensors/fans read empty, how updates or the marketplace work, what supporter codes are, how to publish content, privacy, integrations setup. Pass the user\'s question (or a topic id) as query; call with no query to list all topic ids. Base your answer on the returned card and answer in the user\'s language.', parameters: { type: 'OBJECT', properties: {
          query: { type: 'STRING', description: 'The user\'s question in a few words, or a topic id (e.g. "sensors", "marketplace", "troubleshooting"). Omit to list all topics.' },
        } } },
        { name: 'sdk_reference', description: 'Read-only: the Widget SDK reference — the EXACT data streams and action categories a widget may request (from the code, always current) plus the full SDK docs by section (bridge protocol, manifest fields, storage, secrets, fetch proxy, ambient scenes…). Call this BEFORE create_widget to ground the manifest and the postMessage protocol, and when the user asks how to develop a widget. No section → enums + section list; then call again with a section id for its full text.', parameters: { type: 'OBJECT', properties: {
          section: { type: 'STRING', description: 'Optional docs section id or title fragment, e.g. "manifest-json", "data", "persistent-storage", "secrets".' },
        } } },
  ];
}

// Persistent-memory tool declarations (remember/forget a durable fact). Gated on
// the aiMemory setting at BOTH callers — the /api/ai turn-based handler and the
// Voce Live endpoint — so "remember this" works by voice in either mode. Fresh
// array each call.
function buildMemoryFunctions() {
  return [
    { name: 'remember_fact', description: 'Save a durable fact about the USER to your persistent memory so you recall it in future conversations (their name, hardware, preferences, favourite teams, routines, how they like things). Write it as a short third-person statement, e.g. "The user\'s name is Marcello", "The user has an RTX 4090", "The user supports Napoli". Call this whenever the user shares something worth remembering. Do NOT store secrets/passwords or one-off task details, and do NOT store something you already remember.', parameters: { type: 'OBJECT', properties: {
      fact: { type: 'STRING', description: 'The fact to remember, as a short third-person statement.' },
    }, required: ['fact'] } },
    { name: 'forget_fact', description: 'Remove something from your persistent memory when the user asks you to forget it or corrects an outdated fact. Pass the fact text (or a distinctive part of it) to remove.', parameters: { type: 'OBJECT', properties: {
      fact: { type: 'STRING', description: 'The fact (or a distinctive part of it) to forget.' },
    }, required: ['fact'] } },
  ];
}

const SVV = path.join(__dirname, 'soundvolumeview-x64', 'SoundVolumeView.exe');
const MEDIA_SCRIPT = path.join(__dirname, 'media.ps1');
// Xenon Helper — optional native companion exe (built from helper/, or shipped
// with the release). When present it replaces the persistent PowerShell hosts
// module by module; when absent everything runs on the PS scripts as before.
const HELPER_EXE = path.join(__dirname, 'helper', 'xenon-helper.exe');
const CPU_TEMP_SCRIPT = path.join(__dirname, 'cpu-temp.ps1');
// Raises the startup task to RunLevel Highest via UAC — the repair for
// sensorAccess: 'needs_admin'. Elevates itself; never runs on the pwsh worker.
const ENABLE_SENSORS_SCRIPT = path.join(__dirname, 'enable-sensors.ps1');
const GPU_SCRIPT = path.join(__dirname, 'gpu.ps1');
const NETWORK_SCRIPT = path.join(__dirname, 'network.ps1');
const WINDOWS_SCRIPT = path.join(__dirname, 'windows.ps1');
const DECK_ACTIONS_SCRIPT = path.join(__dirname, 'deck-actions.ps1');
const DECK_HOTKEY_SCRIPT = path.join(__dirname, 'deck-hotkey.ps1');
const DECK_WINDOW_SCRIPT = path.join(__dirname, 'deck-window.ps1');
const PERFORMANCE_SCRIPT = path.join(__dirname, 'performance.ps1');
const PERF_PRIORITY_SCRIPT = path.join(__dirname, 'perf-priority.ps1');
const ICUE_SHARPEN_SCRIPT = path.join(__dirname, 'icue-sharpen.ps1');
let lastIcueSharpenAt = 0; // cooldown for /api/icue/sharpen
const IDLE_SCRIPT = path.join(__dirname, 'idle.ps1');
const VITALS_NAG_SCRIPT = path.join(__dirname, 'vitals-nag.ps1');
// All runtime user data (settings, notes, calendar, tasks, timers, deck, uploads,
// streaming config/tokens) lives in a single DATA_DIR instead of being scattered
// loose in server/. Tool binaries (presentmon/, whisper/, vendor/, …) stay put.
const DATA_DIR = path.join(__dirname, 'data');
// Deck soundboard library: uploaded clips live here under server-generated
// names; the extension set mirrors the /deck/sound streaming allowlist.
const DECK_SOUNDS_DIR = path.join(DATA_DIR, 'sounds');
const DECK_SOUND_MAX_BYTES = 15 * 1024 * 1024;
const DECK_SOUND_EXTS = new Set(['.mp3', '.wav', '.ogg', '.oga', '.m4a', '.aac', '.flac', '.opus', '.weba']);
const DECK_SOUND_NAME_RE = /^sound-[0-9]+-[0-9a-f]+\.[a-z0-9]+$/;
// Installed Deck icon packs (the 'icons' preset kind): one validated folder per
// pack, written/served only through icon-packs.js (see that module's boundary
// notes). The JSON install body cap covers the 2MB decoded pack in base64.
const ICON_PACKS_DIR = path.join(DATA_DIR, 'icon-packs');
const ICON_PACK_BODY_MAX = 4 * 1024 * 1024;
const iconPackStore = iconPacks.createIconPacks({ dir: ICON_PACKS_DIR });
// Installed soundboard packs (the 'sounds' preset kind): validated folders
// under the sounds library, written only through sound-packs.js. Their clips
// play through the existing /deck/sound reader via pack-relative refs.
const SOUND_PACKS_DIR = path.join(DECK_SOUNDS_DIR, 'packs');
const SOUND_PACK_BODY_MAX = 4 * 1024 * 1024;
const soundPackStore = soundPacks.createSoundPacks({ dir: SOUND_PACKS_DIR });
// Virtual Deck popup: Edge app-mode children we spawned (closed on shutdown)
// and the one-shot always-on-top helper script.
const _deckPopupPids = new Set();
const DECK_POPUP_TOP_SCRIPT = path.join(__dirname, 'deck-popup-top.ps1');

// Open the Virtual Deck as an Edge app-mode window on the main PC. Argv array
// only; the instance id is charset-validated before it enters the URL. Edge's
// dedicated profile dir remembers the window's size/position across launches,
// so no geometry needs persisting. The child is tracked and closed in
// _gracefulShutdown (stop-what-you-start). Shared by POST /deck/popup/open and
// the AI's open_virtual_deck tool.
function openDeckPopupWindow(instanceRaw, topmost) {
  const instRaw = String(instanceRaw || '').trim();
  const instance = /^deck(~[a-z0-9]+)?$/.test(instRaw) ? instRaw : '';
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
    .find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!edge) return { ok: false, error: 'edge_not_found' };
  const url = 'http://127.0.0.1:' + PORT + '/deck-popup' + (instance ? '?instance=' + encodeURIComponent(instance) : '');
  const args = [
    '--app=' + url,
    '--user-data-dir=' + path.join(DATA_DIR, 'deck-popup-profile'),
    '--no-first-run', '--no-default-browser-check',
    '--window-size=460,560',
  ];
  let popupPid = 0;
  try {
    const child = spawn(edge, args, { detached: true, stdio: 'ignore' });
    child.unref();
    popupPid = child.pid || 0;
    _deckPopupPids.add(child.pid);
    child.on('exit', () => _deckPopupPids.delete(child.pid));
  } catch { return { ok: false, error: 'popup_failed' }; }
  if (topmost !== false) {
    // One-shot: after the window settles, pin it above other windows. No loop,
    // no lingering process — the script exits after one SetWindowPos. The pin
    // targets the spawned PID (exact title + msedge.exe is only the fallback),
    // so a browser tab that merely CONTAINS "Xenon Deck" can never be pinned.
    setTimeout(() => {
      try { runPowerShellScript(DECK_POPUP_TOP_SCRIPT, ['-ProcessId', String(popupPid), '-Title', 'Xenon Deck'], 8000).catch(() => {}); }
      catch { /* best-effort */ }
    }, 1800).unref();
  }
  return { ok: true };
}
// Legacy single-blob notes store. Kept only as a migration source: readNotes()
// promotes it to the structured notes.json on first read. The plain-text /notes
// API (iCUE widget, AI, backup) now derives from the structured store.
const NOTES_FILE = path.join(DATA_DIR, 'notes.txt');
const NOTES_JSON = path.join(DATA_DIR, 'notes.json');
const NOTES_MAX = 50;                // max distinct notes
const NOTE_BODY_MAX = 100_000;       // per-note character cap
const NOTES_TOTAL_MAX = 1_000_000;   // aggregate character cap (disk-use bound)
const NOTES_TEXT_SEP = '\n\n───\n\n'; // separator when flattening notes to one text
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const TASKS_MAX = 100;
const TIMERS_FILE = path.join(DATA_DIR, 'timers.json');
const TIMERS_MAX = 20;
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
// Xenon's persistent memory of the user (data/ai-memory.json). Local, private,
// injected into the AI system prompt so the assistant remembers across sessions.
const aiMemory = createAiMemory({ dataDir: DATA_DIR });
// Recent AI state-mutating actions, so the user can undo a regrettable one (notes
// overwrite, bulk clear, a just-created item). In-memory only (short-term undo).
const aiActionLog = createAiActionLog();

// ── Voce Live (Gemini Live realtime, opt-in beta) ────────────────────────────
// At most one full-duplex Live session at a time (it owns the single mic). While
// active the wake word stays suspended and the one-shot STT recorder is refused,
// since dshow cannot share the capture device. See _handleLiveClient below.
let _liveActive = false;
let _liveSession = null; // { session, capture, timer, teardown }

// Apply the undo descriptor recorded for an AI action. Returns { ok, refresh }
// where `refresh` is the client action the caller should trigger to re-render.
async function performAiUndo(entry) {
  if (!entry || !entry.undo || entry.undone) return { ok: false, error: 'not_undoable' };
  const u = entry.undo;
  try {
    if (u.kind === 'restore_notes') {
      // prev is a full notes state (current) or a legacy text blob (older entry).
      await writeNotes(u.prev && typeof u.prev === 'object' ? u.prev : textToNotesState(String(u.prev || '')));
      return { ok: true, refresh: 'refresh_notes' };
    }
    if (u.kind === 'delete_task') {
      const tasks = await readTasks();
      await writeTasks(tasks.filter((t) => t.id !== u.id));
      return { ok: true, refresh: 'refresh_tasks' };
    }
    if (u.kind === 'restore_tasks') {
      await writeTasks(Array.isArray(u.prev) ? u.prev : []);
      return { ok: true, refresh: 'refresh_tasks' };
    }
    if (u.kind === 'restore_events') {
      await writeEvents(Array.isArray(u.prev) ? u.prev : []);
      return { ok: true, refresh: 'refresh_calendar' };
    }
    return { ok: false, error: 'unknown_undo' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
const DECK_FILE = path.join(DATA_DIR, 'deck.json');
const STREAM_CONFIG_FILE = path.join(DATA_DIR, 'stream-config.json');
const STREAM_TOKENS_FILE = path.join(DATA_DIR, 'stream-tokens.json');
// Deck configs hold image-icon data URLs (up to ~1.5 MB each), so the store can
// run to several MB across many keys; cap generously to bound disk use.
const DECK_MAX_BYTES = 8 * 1024 * 1024;
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
// Third-party widget packages (sandboxed SDK widgets): one folder per package.
// Served ONLY through the dedicated /sdk/widget/ handler (strict path + CSP);
// the generic static handler never reaches into DATA_DIR.
const SDK_WIDGETS_DIR = path.join(DATA_DIR, 'widgets');
// Bundled reference widgets installable via POST /sdk/widgets/example — id ->
// folder name under server/sdk-example/. Fixed allowlist so the requested id
// is a lookup key, never interpolated into a filesystem path.
const EXAMPLE_WIDGETS = {
  'hello-xenon': 'hello-xenon',
  'teleprompter': 'teleprompter',
  'github-stars': 'github-stars',
};

// Short-lived cache of the validated package scan, shared by the hot SDK paths
// (fetch proxy, webhook ingress, deck macros) so they don't re-read manifests
// from disk per request. GET /sdk/widgets always rescans and refreshes it.
let _sdkScanCache = { at: 0, packages: [], invalid: [] };
async function sdkPackagesCached() {
  // Long TTL on purpose: installs and Rescan both go through refreshSdkScan(),
  // and a widget's hot paths (fetch/hook/macro) only run for a package that was
  // already scanned to mount it — so this fallback re-read almost never fires,
  // and a busy hook source can't turn it into a per-event disk rescan.
  if (Date.now() - _sdkScanCache.at < 30000) return _sdkScanCache;
  return refreshSdkScan();
}
async function refreshSdkScan() {
  const scan = await sdkWidgets.listPackages(SDK_WIDGETS_DIR);
  _sdkScanCache = { at: Date.now(), packages: scan.packages, invalid: scan.invalid };
  return _sdkScanCache;
}

// ── Package origin store (redistribution policy) ────────────────────────────
// Records WHERE each installed package came from, so exports are limited to the
// user's OWN creations: 'import' arrived via a share code / bundle / gallery,
// 'creator' via the Widget Creator or the AI tool, 'builtin' is the bundled
// example. No record = a developer-dropped folder ('local') → the user's own
// work. This is policy, not a security boundary — but GET /sdk/export enforces
// it server-side, so an imported package can never round-trip into a new code.
// The merge rules (mergeOrigin/originExportable) are pure in sdk-widgets.js.
const WIDGET_ORIGINS_FILE = path.join(DATA_DIR, 'widget-origins.json');
const _widgetOrigins = (() => {   // one small read at startup, never on a request
  try {
    const raw = JSON.parse(fs.readFileSync(WIDGET_ORIGINS_FILE, 'utf8'));
    const out = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const id of Object.keys(raw)) {
        const rec = raw[id];
        if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) continue;
        if (!rec || !['import', 'creator', 'builtin', 'local'].includes(rec.origin)) continue;
        out[id] = { origin: rec.origin, at: typeof rec.at === 'string' ? rec.at.slice(0, 32) : '' };
      }
    }
    return out;
  } catch { return {}; }   // missing/corrupt → everything defaults to 'unknown'
})();
// No record → 'unknown': we can't prove it's the user's own work (it could be a
// dev folder OR an install from before this tracking existed), so it is treated
// as NOT exportable — fail-closed, never risk redistributing someone else's
// widget. A developer claims their own folder via POST /sdk/claim → 'local'.
function widgetOriginOf(id) {
  const rec = _widgetOrigins[id];
  return rec ? rec.origin : 'unknown';
}
function widgetExportable(id) {
  return sdkWidgets.originExportable(widgetOriginOf(id));
}
// origin: 'import' | 'creator' | 'builtin' | 'local' to set a record, or
// 'forget' to drop it (on package removal). Advisory store — a write failure
// never fails an install.
async function recordWidgetOrigin(id, origin) {
  const prev = _widgetOrigins[id];
  if (origin === 'forget') { if (!prev) return; delete _widgetOrigins[id]; }
  else { if (prev && prev.origin === origin) return; _widgetOrigins[id] = { origin, at: new Date().toISOString() }; }
  try { await writeFileAtomic(WIDGET_ORIGINS_FILE, JSON.stringify(_widgetOrigins, null, 2)); }
  catch { /* origin records are advisory — never fail an install over them */ }
}

// Per-package gate for the fetch proxy: a floor between requests plus a small
// concurrency cap, so one chatty widget can't turn the server into a scraper.
const _sdkFetchGate = new Map();   // pkgId → { last, inflight }
function sdkFetchGateAcquire(pkgId) {
  const g = _sdkFetchGate.get(pkgId) || { last: 0, inflight: 0 };
  if (g.inflight >= 2 || Date.now() - g.last < 250) return null;
  g.last = Date.now();
  g.inflight++;
  _sdkFetchGate.set(pkgId, g);
  return () => { g.inflight = Math.max(0, g.inflight - 1); };
}

// Per-hook rate floor: a local script POSTing a hook in a tight loop can't turn
// one webhook into an SSE flood across every surface. Bounded (~64 keys) — hook
// ids come from validated manifests (≤32 packages × ≤8 hooks).
const _sdkHookGate = new Map();   // "pkg/hookId" → last accept ts
function sdkHookGateOk(key) {
  const now = Date.now();
  if (now - (_sdkHookGate.get(key) || 0) < 250) return false;
  if (_sdkHookGate.size > 512) _sdkHookGate.clear();   // hard bound against churn
  _sdkHookGate.set(key, now);
  return true;
}

// Whether the third-party widget SDK is enabled at all. The master toggle is the
// kill-switch: with it off, no SDK ingress (fetch proxy, webhooks, deck macros)
// may act, even if stale grants linger in settings.json.
function sdkFeatureEnabled() {
  const sw = _serverHubSettings && _serverHubSettings.sdkWidgets;
  return !!(sw && sw.enabled === true);
}

// The user's per-package SDK grants (client-owned schema, round-tripped through
// settings). Read defensively — a malformed blob collapses to "nothing granted".
// A disabled SDK grants nothing, so every server-side consent check fails closed.
function sdkGrantsFor(pkgId) {
  if (!sdkFeatureEnabled()) return { actions: [], hosts: [], hooks: [], handlers: [], userHosts: {} };
  const sw = _serverHubSettings && _serverHubSettings.sdkWidgets;
  const g = sw && sw.grants && typeof sw.grants === 'object' ? sw.grants[pkgId] : null;
  return {
    actions: (g && Array.isArray(g.actions)) ? g.actions : [],
    hosts: (g && Array.isArray(g.hosts)) ? g.hosts : [],
    hooks: (g && Array.isArray(g.hooks)) ? g.hooks : [],
    handlers: (g && Array.isArray(g.handlers)) ? g.handlers : [],
    storage: !!(g && g.storage === true),
    secrets: !!(g && g.secrets === true),
    // Raw addresses the user typed into the manifest's userHosts slots. Passed
    // to sdkWidgets.resolveUserHosts, which is what validates them — never read
    // as an allowlist directly.
    userHosts: (g && g.userHosts && typeof g.userHosts === 'object' && !Array.isArray(g.userHosts)) ? g.userHosts : {},
  };
}

// ── SDK persistent store + secret vault (per-package, host-mediated) ─────────
// The sandbox denies widgets localStorage/cookies (opaque origin), so these two
// on-disk stores are their ONLY persistence — and they live OUTSIDE the package
// folder (server/data/widget-store, /widget-secrets), so the updater that
// overwrites server/data/widgets/<id>/ never touches user data, and an exported
// package (readPackagePayload only walks the package folder) can never ship a
// stored key. sdk-store.js holds the pure validation; here we add the fs +
// grant/rate gates. Small in-memory caches keep the hot get/set paths off disk;
// writes are atomic + change-driven.
const SDK_STORE_DIR = path.join(DATA_DIR, 'widget-store');
const SDK_SECRETS_DIR = path.join(DATA_DIR, 'widget-secrets');
const _sdkStoreCache = new Map();     // namespace → map (lazy, kept in sync on write)
const _sdkSecretCache = new Map();    // pkgId → map
// A namespace ('g:<group>' or '<pkgId>') → a Windows-safe filename. The colon in
// a group namespace is illegal on NTFS, so map by kind; both id halves are the
// [a-z0-9-] package-id charset, so the result is always a safe leaf name.
function sdkStoreFile(ns) {
  const s = String(ns || '');
  const leaf = s.startsWith('g:') ? 'group_' + s.slice(2) : 'pkg_' + s;
  return path.join(SDK_STORE_DIR, leaf + '.json');
}
function readJsonMapSync(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch { return {}; }
}
function sdkStoreLoad(ns) {
  if (_sdkStoreCache.has(ns)) return _sdkStoreCache.get(ns);
  const map = readJsonMapSync(sdkStoreFile(ns));
  _sdkStoreCache.set(ns, map);
  return map;
}
async function sdkStoreSave(ns, map) {
  _sdkStoreCache.set(ns, map);
  try { await fs.promises.mkdir(SDK_STORE_DIR, { recursive: true }); await writeFileAtomic(sdkStoreFile(ns), JSON.stringify(map)); }
  catch { /* store is best-effort local data — never throw into the bridge */ }
}
function sdkSecretsLoad(pkgId) {
  if (_sdkSecretCache.has(pkgId)) return _sdkSecretCache.get(pkgId);
  const map = readJsonMapSync(path.join(SDK_SECRETS_DIR, pkgId + '.json'));
  _sdkSecretCache.set(pkgId, map);
  return map;
}
async function sdkSecretsSave(pkgId, map) {
  _sdkSecretCache.set(pkgId, map);
  try { await fs.promises.mkdir(SDK_SECRETS_DIR, { recursive: true, mode: 0o700 }); await writeFileAtomic(path.join(SDK_SECRETS_DIR, pkgId + '.json'), JSON.stringify(map)); }
  catch { /* best-effort */ }
}

// Per-package write-rate floor for the store/secret bridges — same shape as the
// fetch/hook gates: a chatty widget can't turn set() into a disk-write flood.
const _sdkStoreGate = new Map();   // pkgId → last-accept ts
function sdkStoreGateOk(pkgId) {
  const now = Date.now();
  if (now - (_sdkStoreGate.get(pkgId) || 0) < 100) return false;
  if (_sdkStoreGate.size > 512) _sdkStoreGate.clear();
  _sdkStoreGate.set(pkgId, now);
  return true;
}

// ── SDK map-tile cache (GET /sdk/tile/<pkg>?u=…) ────────────────────────────
// A radar/map widget needs many small image tiles from a tile server — over the
// postMessage fetch bridge that means base64 round-trips at ~1 req/s, unusable
// for a slippy map. Instead the widget points an <img>/Leaflet layer straight at
// the SAME-ORIGIN /sdk/tile route, which the CSP already allows (`img-src
// 'self'`) with NO relaxation. The route re-uses the exact proxy trust boundary
// (allowlisted + granted host, guardedLookup SSRF block, size cap) and adds a
// bounded LRU + coalescing so panning a map doesn't re-hammer the origin. Only
// image/* responses are cached/served — the tile route is images, not a second
// data channel. Secrets are NEVER injected here (that's the fetch bridge only).
const SDK_TILE_CACHE_MAX = 256;         // ~a few screenfuls of tiles
const SDK_TILE_TTL_MS = 10 * 60 * 1000; // radar frames refresh on the order of minutes
const _sdkTileCache = new Map();        // url → { at, contentType, buffer }
const _sdkTileInflight = new Map();     // url → Promise (coalesce concurrent misses)
function sdkTileCacheGet(url) {
  const hit = _sdkTileCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > SDK_TILE_TTL_MS) { _sdkTileCache.delete(url); return null; }
  // LRU touch: re-insert so eviction drops the least-recently used.
  _sdkTileCache.delete(url);
  _sdkTileCache.set(url, hit);
  return hit;
}
function sdkTileCachePut(url, contentType, buffer) {
  _sdkTileCache.set(url, { at: Date.now(), contentType, buffer });
  while (_sdkTileCache.size > SDK_TILE_CACHE_MAX) {
    const oldest = _sdkTileCache.keys().next().value;
    if (oldest === undefined) break;
    _sdkTileCache.delete(oldest);
  }
}
// Per-package tile gate — a miss costs an outbound fetch, so bound both live
// concurrency and a rolling rate so a widget can't turn the tile route into a
// scraper. Cache HITS are free and never gated. Returns a release fn, or null
// when over budget (→ 429). Maps are bounded by the ≤32-package install cap.
const _sdkTileConc = new Map();   // pkgId → inflight miss count
const _sdkTileRate = new Map();   // pkgId → { windowStart, count }
function sdkTileGate(pkgId) {
  const conc = _sdkTileConc.get(pkgId) || 0;
  if (conc >= 6) return null;
  const now = Date.now();
  let r = _sdkTileRate.get(pkgId);
  if (!r || now - r.windowStart > 10000) { r = { windowStart: now, count: 0 }; _sdkTileRate.set(pkgId, r); }
  if (r.count >= 120) return null;
  r.count++;
  _sdkTileConc.set(pkgId, conc + 1);
  return () => { _sdkTileConc.set(pkgId, Math.max(0, (_sdkTileConc.get(pkgId) || 1) - 1)); };
}

// Fetch (or coalesce onto an in-flight fetch of) one tile through the hardened
// proxy. Resolves { contentType, buffer } for an image, or throws.
function sdkTileFetch(url) {
  const inflight = _sdkTileInflight.get(url);
  if (inflight) return inflight;
  const p = (async () => {
    const r = await sdkProxy.proxyFetch({ url, method: 'GET', headers: {}, body: '' });
    const ct = String(r.contentType || '');
    if ((r.status || 0) >= 400 || !/^image\//i.test(ct)) { const e = new Error('not_a_tile'); e.status = r.status; throw e; }
    sdkTileCachePut(url, ct, r.buffer);
    return { contentType: ct, buffer: r.buffer };
  })().finally(() => { _sdkTileInflight.delete(url); });
  _sdkTileInflight.set(url, p);
  return p;
}

// ── SDK handler actions (deck keys answered by widget code) ─────────────────
// A pressed sdkHandler key broadcasts `sdk_handler` and parks its /actions/run
// response here until a dashboard frame acks it (POST /sdk/handler-ack) or the
// timeout fires — so a key with no live frame flashes an honest error instead
// of pretending success. Bounded + cleaned on shutdown.
const SDK_HANDLER_TIMEOUT_MS = 3000;
const SDK_HANDLER_PENDING_MAX = 32;
const _sdkHandlerPending = new Map();   // callId → { resolve, timer }

function sdkHandlerDispatch(pkg, handler, args) {
  // Nobody listening → fail fast; a broadcast to zero clients can never be
  // acked, so parking the call would only burn the timeout. This also keeps
  // the invariant simple: every _sdkHandlerPending entry has a live listener
  // window at creation time.
  if (sseClients.size === 0) return Promise.resolve({ ok: false, error: 'no_frame' });
  if (_sdkHandlerPending.size >= SDK_HANDLER_PENDING_MAX) {
    return Promise.resolve({ ok: false, error: 'busy' });
  }
  const callId = 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      _sdkHandlerPending.delete(callId);
      resolve({ ok: false, error: 'no_frame' });
    }, SDK_HANDLER_TIMEOUT_MS);
    timer.unref();
    _sdkHandlerPending.set(callId, { resolve, timer });
    broadcastSSE('sdk_handler', { pkg, handler, args, callId });
  });
}

function sdkHandlerAck(callId, ok, error) {
  const entry = _sdkHandlerPending.get(String(callId || ''));
  if (!entry) return false;   // late/duplicate ack — first one already won
  _sdkHandlerPending.delete(String(callId));
  clearTimeout(entry.timer);
  entry.resolve(ok ? { ok: true } : { ok: false, error: String(error || 'handler_failed').slice(0, 80) });
  return true;
}

function sdkHandlerShutdown() {
  for (const [, entry] of _sdkHandlerPending) {
    clearTimeout(entry.timer);
    entry.resolve({ ok: false, error: 'shutdown' });
  }
  _sdkHandlerPending.clear();
}

// ── SDK deck states relay ────────────────────────────────────────────────────
// Widget-published deck states live in the DASHBOARD page (postMessage bridge in
// custom-widget.js) — but the Virtual Deck popup hosts no widget frames, so the
// host page mirrors each change here (POST /sdk/deck-states) and the server
// re-broadcasts it as the `sdk_states` SSE event + seeds it on connect. Values
// are re-validated and re-built key-by-key (never spread), bounded, and carry
// only projected state — no widget code, no secrets. In-memory only.
// 256 = the true client-side bound (32 packages × 8 declared states); the
// per-value cap MUST match onBridgeState's 200-char cap in custom-widget.js or
// a value-equality sdkState binding matches on the dashboard but not in the popup.
const SDK_DECK_STATES_MAX = 256;
const _sdkDeckStates = { states: {}, meta: {} };
let _sdkDeckStatesLast = '';   // change guard: identical relays don't rebroadcast
function acceptSdkDeckStates(body) {
  if (!body || typeof body !== 'object') return false;
  const states = {};
  const meta = {};
  let count = 0;
  const rawStates = (body.states && typeof body.states === 'object') ? body.states : {};
  const rawMeta = (body.meta && typeof body.meta === 'object') ? body.meta : {};
  for (const key of Object.keys(rawStates)) {
    if (count >= SDK_DECK_STATES_MAX) break;
    if (typeof key !== 'string' || !key || key.length > 120) continue;
    count++;
    states[key] = String(rawStates[key] == null ? '' : rawStates[key]).slice(0, 200);
    const m = rawMeta[key];
    if (m && typeof m === 'object') {
      const clean = {};
      if (typeof m.label === 'string' && m.label) clean.label = m.label.slice(0, 24);
      if (typeof m.icon === 'string' && m.icon) clean.icon = m.icon.slice(0, 8);
      if (typeof m.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(m.color.trim())) clean.color = m.color.trim();
      if (Object.keys(clean).length) meta[key] = clean;
    }
  }
  _sdkDeckStates.states = states;
  _sdkDeckStates.meta = meta;
  const sig = JSON.stringify(_sdkDeckStates);
  if (sig === _sdkDeckStatesLast) return false;
  _sdkDeckStatesLast = sig;
  broadcastSSE('sdk_states', _sdkDeckStates);
  return true;
}

// THE single writer for widget-package installs: POST /sdk/install and the AI's
// create_widget tool both land here, so validateWidgetPayload stays the one
// trust boundary in front of the filesystem. Never grants, never assigns.
// `origin` ('import' | 'creator') feeds the redistribution-policy record above:
// imports default fail-closed, and mergeOrigin keeps ownership sticky BOTH ways —
// own work is never demoted, and an already-imported id can't be relabelled
// 'creator' by a replayed install (no laundering someone else's widget).
async function installWidgetPayload(payload, origin) {
  const v = sdkWidgets.validateWidgetPayload(payload);
  if (!v.ok) return { ok: false, error: v.reason };
  try {
    const dest = path.join(SDK_WIDGETS_DIR, v.id);
    // Capture BEFORE writing: "no folder yet" means a brand-new id, so a plain
    // import records 'import' instead of inheriting the local-folder default.
    const existed = await fs.promises.access(dest).then(() => true, () => false);
    await fs.promises.mkdir(dest, { recursive: true });
    for (const f of v.files) {
      const abs = path.join(dest, ...f.relPath.split('/'));
      // Defense in depth: relPath is already traversal-proof, assert anyway.
      if (abs !== dest && !abs.startsWith(dest + path.sep)) continue;
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, f.bytes);
    }
    await recordWidgetOrigin(v.id, sdkWidgets.mergeOrigin(existed ? widgetOriginOf(v.id) : null, origin));
    await refreshSdkScan();
    return { ok: true, id: v.id, name: v.manifest.name, actions: v.manifest.actions, streams: v.manifest.streams, hosts: v.manifest.hosts };
  } catch {
    return { ok: false, error: 'install_failed' };
  }
}

// One-time migration: earlier versions stored runtime data loose in server/.
// Move any legacy files/dirs into DATA_DIR so existing installs keep their data.
// Runs synchronously at startup, before anything reads these paths. Skips a file
// when the new copy already exists, so it never clobbers current data.
(function migrateLegacyData() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  // SDK widget packages dir: created up-front so "drop a folder into
  // server/data/widgets" always has somewhere to drop into.
  try { fs.mkdirSync(SDK_WIDGETS_DIR, { recursive: true }); } catch {}
  const moves = [
    [path.join(__dirname, 'notes.txt'), NOTES_FILE],
    [path.join(__dirname, 'events.json'), EVENTS_FILE],
    [path.join(__dirname, 'tasks.json'), TASKS_FILE],
    [path.join(__dirname, 'timers.json'), TIMERS_FILE],
    [path.join(__dirname, 'settings.json'), SETTINGS_FILE],
    [path.join(__dirname, 'deck.json'), DECK_FILE],
    [path.join(__dirname, 'stream-config.json'), STREAM_CONFIG_FILE],
    [path.join(__dirname, 'stream-tokens.json'), STREAM_TOKENS_FILE],
    [path.join(__dirname, 'uploads'), UPLOADS_DIR],
  ];
  for (const [oldPath, newPath] of moves) {
    try {
      if (!fs.existsSync(oldPath) || fs.existsSync(newPath)) continue;
      fs.renameSync(oldPath, newPath);
    } catch {
      // Locked file or cross-device move: fall back to copy + best-effort remove.
      try {
        fs.cpSync(oldPath, newPath, { recursive: true });
        fs.rmSync(oldPath, { recursive: true, force: true });
      } catch (copyErr) {
        console.error(`[data-migration] could not move ${oldPath}:`, copyErr.message);
      }
    }
  }
})();

// Shared-code bridge: expose packages/core to the browser under server/shared so
// the existing static handler can serve /shared/* without reaching outside
// __dirname. Normally created by `npm run link:shared` (postinstall); we re-create
// it here best-effort so a fresh checkout or a self-update that skipped postinstall
// still serves the shared modules. The client also keeps inline fallbacks, so a
// failure here never breaks the dashboard.
(function ensureSharedLink() {
  const sharedDir = path.join(__dirname, 'shared');
  const coreDir = path.join(__dirname, '..', 'packages', 'core');
  try {
    if (fs.existsSync(sharedDir) || !fs.existsSync(coreDir)) return;
    fs.symlinkSync(coreDir, sharedDir, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    console.warn('[shared-link] could not create server/shared:', err.message);
  }
})();

// Durable stores (settings/deck/tasks/timers/events/notes/lighting) are written
// with a temp-file + fsync + atomic rename so a crash or power-loss mid-write
// can never leave a truncated file behind. The shared primitive lives in
// atomic-write.js so every module (stream-common, ai-memory, guardian) writes
// with the exact same discipline — one serialized queue per path, no ad-hoc
// temp+rename copies that can race each other.
const { writeFileAtomic } = require('./atomic-write');

const BACKGROUND_MAX_BYTES = 200 * 1024 * 1024;
const BACKGROUND_TRANSCODE_TIMEOUT_MS = 10 * 60 * 1000;
const SETTINGS_MIN_PANEL_ALPHA = 0.18;
const BACKGROUND_MIME_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
]);
const BACKGROUND_EXT_BY_MIME = new Map([...BACKGROUND_MIME_BY_EXT.entries()].map(([ext, mime]) => [mime, ext]));

// Custom UI font upload. Fonts are tiny next to backgrounds (a full TTF/OTF is a
// few MB at most), so a modest cap is plenty and keeps them small enough to embed
// in a full backup and a shared theme code.
const FONT_MAX_BYTES = 8 * 1024 * 1024;
const FONT_MIME_BY_EXT = new Map([
  ['.woff2', 'font/woff2'], ['.woff', 'font/woff'], ['.ttf', 'font/ttf'], ['.otf', 'font/otf'],
]);
const FONT_EXT_BY_MIME = new Map([...FONT_MIME_BY_EXT.entries()].map(([ext, mime]) => [mime, ext]));

// Per-tile decoration image upload (widget backgrounds / frames / overlays).
// Images only (no video). Unlike backgrounds/fonts there is NO one-live-file
// policy — many tiles hold many pictures — so orphans are swept by a
// reference-counted GC on every dashboard-layout save (see below).
const TILE_ASSET_MAX_BYTES = 10 * 1024 * 1024;
const TILE_ASSET_MIME_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'],
]);
const TILE_ASSET_EXT_BY_MIME = new Map([...TILE_ASSET_MIME_BY_EXT.entries()].map(([ext, mime]) => [mime, ext]));

// CSV column indices for SoundVolumeView /scomma (no header row)
const F = { NAME: 0, TYPE: 1, DIR: 2, DEVICE_NAME: 3, DEFAULT: 4, STATE: 7, MUTED: 8, VOL_PCT: 10, CLI_ID: 18, PROC_PATH: 19, PROC_ID: 20, WINDOW_TITLE: 21 };

// Persistent icon cache keyed by process exe path — avoids repeated PowerShell spawns.
// Bounded LRU (oldest evicted past the cap) so a long-running session that sees
// many distinct executables can't grow it without limit — mirrors artworkCache.
const appIconCache = new Map();
const APP_ICON_CACHE_MAX = 200;
function setAppIcon(key, value) {
  if (appIconCache.size >= APP_ICON_CACHE_MAX && !appIconCache.has(key)) {
    appIconCache.delete(appIconCache.keys().next().value);
  }
  appIconCache.set(key, value);
}

function parseJsonOutput(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON output');
  return JSON.parse(stdout.slice(start, end + 1));
}

function powerShellUtf8Command(command) {
  return `$utf8NoBom = New-Object System.Text.UTF8Encoding $false; [Console]::OutputEncoding = $utf8NoBom; $OutputEncoding = $utf8NoBom; ${command}`;
}

function runPowerShellScript(script, args = [], timeout = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let resolvedEarly = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    // Resolve the promise as soon as we have valid JSON, but DO NOT kill the
    // PowerShell process — let it exit on its own so WinRT/COM handles (SMTC
    // session, thumbnail stream, DataReader, …) get released cleanly. Killing
    // mid-flight is what leaks broker handles and eventually wedges Windows
    // shutdown.
    const finishOk = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const finishErr = err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed && child.exitCode === null) child.kill();
      reject(err);
    };

    const resolveIfJsonReady = () => {
      if (resolvedEarly) return;
      if (!stdout.trimEnd().endsWith('}')) return;
      try {
        const value = parseJsonOutput(stdout);
        resolvedEarly = true;
        finishOk(value);
      } catch { }
    };

    const timer = setTimeout(() => {
      try { finishOk(parseJsonOutput(stdout)); }
      catch { finishErr(new Error(stderr || `PowerShell timeout: ${path.basename(script)}`)); }
    }, timeout);

    child.stdout.on('data', chunk => { stdout += chunk; resolveIfJsonReady(); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', e => finishErr(e));
    child.on('close', code => {
      if (settled) return;
      try { finishOk(parseJsonOutput(stdout)); }
      catch (e) { finishErr(new Error(stderr || e.message || `PowerShell exited with ${code}`)); }
    });
  });
}

// One-shot run of the native helper (e.g. `xenon-helper windows list`). Unlike
// the persistent media/foreground hosts this spawns per request — the trimmed
// native exe starts in tens of ms, versus ~1s of PowerShell engine start plus
// an Add-Type C# compile for windows.ps1 — which is what makes the Apps panel
// open near-instantly. Resolves the parsed JSON from stdout, rejects on any
// problem so the caller can fall back to the PowerShell path.
function runHelperOneShot(args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(HELPER_EXE, args, { windowsHide: true }); }
    catch (e) { reject(e); return; }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      try { if (!child.killed) child.kill(); } catch { }
      finish(reject, new Error('helper timeout'));
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', e => finish(reject, e));
    child.on('close', code => {
      if (code !== 0) { finish(reject, new Error(stderr || `helper exited with ${code}`)); return; }
      try { finish(resolve, parseJsonOutput(stdout)); }
      catch (e) { finish(reject, e); }
    });
  });
}

// App-switcher windows tool: prefer the native helper when the exe exists, fall
// back to windows.ps1 transparently on ANY helper problem (missing, crashed,
// bad output) — the PowerShell path is the permanent safety net.
async function runWindowsTool(args, timeout) {
  if (linuxCollectors) return linuxCollectors.windows(args[0], args[1]);
  if (fs.existsSync(HELPER_EXE)) {
    try { return await runHelperOneShot(['windows', ...args], timeout); }
    catch { /* fall through to the PowerShell path */ }
  }
  return runPowerShellScript(WINDOWS_SCRIPT, args, timeout);
}

function runPowerShellCommand(command, timeout = 5000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', powerShellUtf8Command(command)], {
      timeout,
      windowsHide: true,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr || err.message)); return; }
      try { resolve(parseJsonOutput(stdout)); }
      catch (e) { reject(e); }
    });
  });
}

// ── "Open dashboard in browser at logon" task ────────────────────────────────
// A per-user Scheduled Task ("Xenon Edge Dashboard") that runs open-dashboard.vbs
// at logon. The server already auto-starts at logon via its own task; this one
// just opens the browser tab for people who use the dashboard in a real browser
// (Xeneon Edge loads the iframe itself, so it never wants this). Registered on
// demand from the client and reflected back so the toggle shows the true state.
const BROWSER_TASK_NAME = 'Xenon Edge Dashboard';
const OPEN_DASHBOARD_VBS = path.join(__dirname, 'open-dashboard.vbs');
const AUTO_OPEN_SUPPORTED = process.platform === 'win32';

function psSingleQuote(value) {
  return String(value).replace(/'/g, "''");
}

// Returns { enabled } reflecting whether the logon task currently exists.
async function getBrowserAutoOpenState() {
  if (!AUTO_OPEN_SUPPORTED) return { enabled: false };
  const cmd =
    `$t = Get-ScheduledTask -TaskName '${psSingleQuote(BROWSER_TASK_NAME)}' -ErrorAction SilentlyContinue; ` +
    `Write-Output (@{ ok = $true; enabled = [bool]$t } | ConvertTo-Json -Compress)`;
  try {
    const out = await runPowerShellCommand(cmd, 8000);
    return { enabled: out && out.enabled === true };
  } catch {
    return { enabled: false };
  }
}

// Registers (enabled) or removes the logon task. Returns { enabled }.
async function setBrowserAutoOpen(enabled) {
  if (!AUTO_OPEN_SUPPORTED) return { enabled: false };
  let cmd;
  if (enabled) {
    const vbs = psSingleQuote(OPEN_DASHBOARD_VBS);
    cmd =
      `$ErrorActionPreference = 'Stop'; ` +
      `try { ` +
        `$wscript = Join-Path $env:WINDIR 'System32\\wscript.exe'; ` +
        `$user = "$env:USERDOMAIN\\$env:USERNAME"; ` +
        `$action = New-ScheduledTaskAction -Execute $wscript -Argument ('"' + '${vbs}' + '"'); ` +
        `$trigger = New-ScheduledTaskTrigger -AtLogon -User $user; ` +
        // Interactive + Limited so the browser opens in the user's visible session
        // (a SYSTEM/Highest task would open invisibly in session 0).
        `$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited; ` +
        `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero); ` +
        `Register-ScheduledTask -TaskName '${psSingleQuote(BROWSER_TASK_NAME)}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null; ` +
        `Write-Output '{"ok":true,"enabled":true}' ` +
      `} catch { Write-Output (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress) }`;
  } else {
    cmd =
      `try { Unregister-ScheduledTask -TaskName '${psSingleQuote(BROWSER_TASK_NAME)}' -Confirm:$false -ErrorAction SilentlyContinue } catch { }; ` +
      `Write-Output '{"ok":true,"enabled":false}'`;
  }
  const out = await runPowerShellCommand(cmd, 12000);
  if (out && out.ok === false) throw new Error(out.error || 'Task registration failed');
  return { enabled: enabled === true };
}

// ── Persistent PowerShell collector worker ───────────────────────────────────
// Spawning powershell.exe per poll (~150ms CLR+engine startup) is the server's
// dominant steady-state CPU cost. This long-lived host runs the read-only sensor
// collectors (gpu / cpu-temp / network) in one process, paying that cost once.
// Only exit-free, SMTC-free scripts go through it — media.ps1 has its own
// dedicated persistent host below (it holds WinRT broker handles and needs
// graceful retirement, while this worker may be hard-killed when wedged).
// Any worker problem falls back transparently to runPowerShellScript, so
// behaviour degrades to the one-shot model and never breaks.
const PWSH_WORKER_SCRIPT = path.join(__dirname, 'pwsh-worker.ps1');
const _worker = { proc: null, buf: '', nextId: 1, pending: new Map() };

function _workerReject(id, err) {
  const p = _worker.pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  _worker.pending.delete(id);
  p.reject(err);
}

function _killWorker(reason) {
  const proc = _worker.proc;
  _worker.proc = null;
  _worker.buf = '';
  for (const id of [..._worker.pending.keys()]) _workerReject(id, new Error(reason || 'worker down'));
  if (proc) { try { proc.kill(); } catch {} }
}

function _ensureWorker() {
  if (_worker.proc) return _worker.proc;
  let proc;
  try {
    proc = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PWSH_WORKER_SCRIPT],
      { windowsHide: true });
  } catch { return null; }
  _worker.proc = proc;
  _worker.buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    _worker.buf += chunk;
    let nl;
    while ((nl = _worker.buf.indexOf('\n')) !== -1) {
      const line = _worker.buf.slice(0, nl).trim();
      _worker.buf = _worker.buf.slice(nl + 1);
      if (!line.startsWith('XEHWK ')) continue; // ignore any stray output
      let env;
      try { env = JSON.parse(Buffer.from(line.slice(6), 'base64').toString('utf8')); }
      catch { continue; }
      const p = _worker.pending.get(env.id);
      if (!p) continue;
      clearTimeout(p.timer);
      _worker.pending.delete(env.id);
      if (env.ok) p.resolve(env.out || '');
      else p.reject(new Error(env.err || 'worker error'));
    }
  });
  proc.stderr.on('data', () => {}); // collectors trap their own errors; ignore
  proc.on('error', () => _killWorker('worker spawn error'));
  proc.on('exit', () => { if (_worker.proc === proc) _killWorker('worker exited'); });
  proc.unref(); // never keep the event loop alive on the worker's account
  return proc;
}

function runPowerShellWorker(scriptPath, args = [], timeout = 8000) {
  return new Promise((resolve, reject) => {
    const proc = _ensureWorker();
    if (!proc) { reject(new Error('worker unavailable')); return; }
    const id = _worker.nextId++;
    const timer = setTimeout(() => {
      // The worker processes requests serially; a timeout means it is wedged on
      // this one. Reject and kill so the next call gets a fresh host — safe here
      // because these collectors hold no SMTC/WinRT handles (OS reclaims theirs
      // on process death).
      _workerReject(id, new Error('worker timeout'));
      _killWorker('worker timeout');
    }, timeout);
    _worker.pending.set(id, { resolve, reject, timer });
    try {
      proc.stdin.write(JSON.stringify({ id, script: path.basename(scriptPath), args }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      _worker.pending.delete(id);
      reject(e);
    }
  });
}

// Run a read-only collector through the persistent worker, falling back to a
// one-shot spawn on any worker problem. Returns the same parsed-JSON object as
// runPowerShellScript, so call sites are unchanged.
async function runCollector(scriptPath, args = [], timeout = 8000) {
  try {
    return parseJsonOutput(await runPowerShellWorker(scriptPath, args, timeout));
  } catch {
    return runPowerShellScript(scriptPath, args, timeout);
  }
}

// Wireless peripheral battery (Corsair via the iCUE bridge + Bluetooth via the
// battery.ps1 PnP collector). TTL-cached inside the monitor; consumed by
// GET /api/battery, the SSE 'battery' tick and the get_battery_status AI tool.
const batteryMonitor = createBatteryMonitor({ runScript: runPowerShellScript, lighting });

// ── Persistent SMTC media host ────────────────────────────────────────────────
// media.ps1 used to be spawned one-shot for EVERY media poll (the SSE stream
// broadcasts media every 2s), paying ~150-300ms of CLR + WinRT startup each
// time — the single largest source of steady-state CPU/temp churn, visible to
// users as powershell.exe popping in and out of Task Manager. `media.ps1 -Serve`
// keeps ONE process alive holding the SMTC session manager, answers polls
// in-proc and caches the album-art stream per track. Protocol mirrors the
// sensor worker ("XEMED " + base64 frames), but it gets its OWN process: media
// holds WinRT broker handles, so unlike the sensor worker it is retired
// GRACEFULLY — stdin close lets the serve loop exit and release its handles
// cleanly; a hard kill only fires 3s later if the process refuses to die.
// Any problem falls back to the unchanged one-shot spawn path.
const _mediaHost = {
  proc: null, buf: '', nextId: 1, pending: new Map(), diedAt: 0, isHelper: false, bornAt: 0, helperBadUntil: 0,
  // Blind-helper detection (issue #80): a helper that answers fine but always
  // reports an empty session list, while the OS actually has one, never trips
  // the death/timeout fallback. These track a run of empties so a persistent
  // one can be cross-checked against the PowerShell host. Reset on each spawn,
  // and again whenever the helper proves it can see a session.
  emptyStreak: 0, crossChecks: 0, lastCrossCheck: 0,
};
const MEDIA_HOST_RETRY_MS = 10000; // after a host death, poll one-shot for a while instead of respawn-storming
const MEDIA_HELPER_BAD_MS = 10 * 60 * 1000; // a helper exe that dies young (or is blind) is pinned out in favour of the PS host
const MEDIA_BLIND_STREAK = 3;          // consecutive empty helper polls before a PS cross-check
const MEDIA_CROSSCHECK_BASE_MS = 60000;   // first cross-checks: at most one PS spawn per minute
const MEDIA_CROSSCHECK_MAX_MS = 5 * 60000; // …backing off to no more than one every 5 min while idle

function _mediaHostReject(id, err) {
  const p = _mediaHost.pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  _mediaHost.pending.delete(id);
  p.reject(err);
}

function _retireMediaHost(reason) {
  const proc = _mediaHost.proc;
  _mediaHost.proc = null;
  _mediaHost.buf = '';
  _mediaHost.diedAt = Date.now();
  // A helper exe that dies or misbehaves within seconds of spawning is likely
  // broken (corrupt download, AV block): pin the PS host for a while instead
  // of ping-ponging between the two on every retry window.
  if (_mediaHost.isHelper && reason !== 'shutdown' && Date.now() - _mediaHost.bornAt < 15000) {
    _mediaHost.helperBadUntil = Date.now() + MEDIA_HELPER_BAD_MS;
  }
  for (const id of [..._mediaHost.pending.keys()]) _mediaHostReject(id, new Error(reason || 'media host down'));
  if (!proc) return;
  // Closing stdin ends the serve loop → clean process exit → SMTC/WinRT broker
  // handles released the safe way (killing mid-flight is what wedges the broker).
  try { proc.stdin.end(); } catch {}
  const force = setTimeout(() => { try { proc.kill(); } catch {} }, 3000);
  force.unref();
  proc.once('exit', () => clearTimeout(force));
}

function _ensureMediaHost() {
  if (_mediaHost.proc) return _mediaHost.proc;
  if (Date.now() - _mediaHost.diedAt < MEDIA_HOST_RETRY_MS) return null;
  let useHelper = false;
  if (Date.now() >= _mediaHost.helperBadUntil) {
    try { useHelper = fs.existsSync(HELPER_EXE); } catch { useHelper = false; }
  }
  let proc;
  try {
    proc = useHelper
      ? spawn(HELPER_EXE, ['media-serve'], { windowsHide: true })
      : spawn('powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', MEDIA_SCRIPT, '-Serve'],
          { windowsHide: true });
  } catch { return null; }
  _mediaHost.proc = proc;
  _mediaHost.isHelper = useHelper;
  _mediaHost.bornAt = Date.now();
  _mediaHost.buf = '';
  // Fresh host → fresh blind-detection state (a re-downloaded helper after an
  // update deserves a clean chance to prove it can see sessions).
  _mediaHost.emptyStreak = 0;
  _mediaHost.crossChecks = 0;
  _mediaHost.lastCrossCheck = 0;
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    _mediaHost.buf += chunk;
    let nl;
    while ((nl = _mediaHost.buf.indexOf('\n')) !== -1) {
      const line = _mediaHost.buf.slice(0, nl).trim();
      _mediaHost.buf = _mediaHost.buf.slice(nl + 1);
      if (!line.startsWith('XEMED ')) continue; // ignore any stray output
      let env;
      try { env = JSON.parse(Buffer.from(line.slice(6), 'base64').toString('utf8')); }
      catch { continue; }
      const p = _mediaHost.pending.get(env.id);
      if (!p) {
        // Unsolicited frame: the native helper pushes {event:"media-changed"}
        // when the OS reports a track/playback change.
        if (env.event === 'media-changed') _onMediaChangedPush();
        continue;
      }
      clearTimeout(p.timer);
      _mediaHost.pending.delete(env.id);
      if (env.ok) p.resolve(env.out || '');
      else p.reject(new Error(env.err || 'media host error'));
    }
  });
  proc.stderr.on('data', () => {}); // the host traps its own errors; ignore
  proc.on('error', () => _retireMediaHost('media host spawn error'));
  proc.on('exit', () => { if (_mediaHost.proc === proc) _retireMediaHost('media host exited'); });
  proc.unref(); // never keep the event loop alive on the host's account
  return proc;
}

function runMediaHostRequest(action, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const proc = _ensureMediaHost();
    if (!proc) { reject(new Error('media host unavailable')); return; }
    const id = _mediaHost.nextId++;
    const timer = setTimeout(() => {
      _mediaHostReject(id, new Error('media host timeout'));
      _retireMediaHost('media host timeout');
    }, timeout);
    _mediaHost.pending.set(id, { resolve, reject, timer });
    try {
      proc.stdin.write(JSON.stringify({ id, action, preferredSource: mediaPreferredSource || '' }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      _mediaHost.pending.delete(id);
      reject(e);
    }
  });
}

// Track/playback changed at the OS level (pushed by the native helper):
// invalidate the cache and broadcast right away instead of waiting for the
// next 2s poll tick. The tiny debounce coalesces bursts into one refresh.
let _mediaPushTimer = null;
function _onMediaChangedPush() {
  if (_mediaPushTimer) return;
  _mediaPushTimer = setTimeout(async () => {
    _mediaPushTimer = null;
    mediaCache.updatedAt = 0;
    try { await broadcastMediaNow(); } catch {}
  }, 150);
  _mediaPushTimer.unref();
}

// A helper that answers fine but reports an empty session list on EVERY poll —
// while the OS actually has an active SMTC session — leaves the Media panel
// blank with no error, so the death/timeout fallback never trips (issue #80:
// a broken / AV-mangled helper on some machines; the user's own fix was to
// hard-disable the helper). Cross-check a persistent empty against the
// PowerShell host: if PS sees a session the helper is blind on this machine, so
// pin the helper out and hand back what PS found. Heavily gated so an idle
// machine pays almost nothing — only the helper, only after a streak of
// empties, at most once a minute, only until the helper first proves it can see
// a session, and only a few times per host lifetime.
async function _guardHelperMediaBlindSpot(out) {
  const empty = !out || (out.active === false && (!Array.isArray(out.sessions) || out.sessions.length === 0));
  // A session (playing OR paused) proves the helper can see SMTC on this machine
  // and reopens the detection budget: if it later goes blind mid-session (broker
  // wedge), the next run of empties is cross-checked again rather than trusted.
  if (!empty) { _mediaHost.emptyStreak = 0; _mediaHost.crossChecks = 0; return out; }
  if (++_mediaHost.emptyStreak < MEDIA_BLIND_STREAK) return out;
  // Rate-limit the PS cross-check with an escalating interval instead of a hard
  // lifetime cap. A hard cap (the old MEDIA_CROSSCHECK_MAX) was exhausted by the
  // agreed-empty cross-checks a machine racks up while merely idle at startup, so
  // a helper that only goes blind AFTER playback finally starts was never
  // cross-checked again and the Media panel stayed stuck on "Nothing playing" for
  // the rest of the host's lifetime. Backing off (1 min → capped at 5 min) keeps a
  // truly idle machine cheap while still catching a blind helper within one
  // interval once music actually plays; the moment the helper sees any session the
  // `!empty` branch above resets the interval to the 1-minute floor.
  const interval = Math.min(MEDIA_CROSSCHECK_BASE_MS * (2 ** _mediaHost.crossChecks), MEDIA_CROSSCHECK_MAX_MS);
  if (Date.now() - _mediaHost.lastCrossCheck < interval) return out;
  _mediaHost.lastCrossCheck = Date.now();
  let ps;
  // Count a failed cross-check against the budget too, so an unusable PS reader
  // can't make us spawn one every minute forever.
  try { ps = await runPowerShellScript(MEDIA_SCRIPT, mediaScriptArgs('info'), 8000); }
  catch { _mediaHost.crossChecks++; return out; }
  // The helper reported ZERO sessions; the blindness signal is simply that PS can
  // see a session the helper can't — in ANY playback state. Comparing the raw
  // session list (not ps.active) is what catches a PAUSED track: media.ps1 only
  // sets active:true while Playing, so the old ps.active check treated a blind
  // helper next to a paused-but-visible session as "agreed empty" and never
  // retired it. Both empty → genuinely nothing playing.
  const psSaw = ps && Array.isArray(ps.sessions) && ps.sessions.length > 0;
  if (!psSaw) { _mediaHost.crossChecks++; return out; }     // both agree: nothing is playing
  _mediaHost.helperBadUntil = Date.now() + MEDIA_HELPER_BAD_MS;
  _retireMediaHost('helper media blind');                   // drop to the PS host for a while
  return ps;
}

// Run a media request through the persistent host, falling back to the original
// one-shot spawn on any host problem. Same parsed-JSON result either way.
async function runMediaRequest(action, timeout = 8000) {
  try {
    const out = parseJsonOutput(await runMediaHostRequest(action, timeout));
    // Only 'info' carries sessions, and the guard only applies to the helper.
    return (action === 'info' && _mediaHost.isHelper) ? _guardHelperMediaBlindSpot(out) : out;
  } catch {
    return runPowerShellScript(MEDIA_SCRIPT, mediaScriptArgs(action), timeout);
  }
}

// ── DDC/CI display control host ─────────────────────────────────────────────
// ddc.ps1 -Serve reads/writes a monitor's hardware brightness/contrast/RGB gains
// over DDC/CI, so the dashboard can dim the Xeneon Edge (or any DDC-capable
// monitor Xenon is shown on) without iCUE. Like the media host it is ONE
// persistent process — enumerating monitors and opening physical handles costs
// real time, so we hold it open while the display panel is in use — but unlike
// media it is demand-only: spawned on the first /display request and retired
// after a minute of silence (or at shutdown), since nobody polls it. Values are
// read on demand ('list') and written one VCP at a time ('set'); no periodic work.
const DDC_SCRIPT = path.join(__dirname, 'ddc.ps1');
const DDC_IDLE_MS = 60 * 1000;      // retire the worker after a minute of no display requests
const DDC_FEATURES = new Set(['brightness', 'backlight', 'contrast', 'red', 'green', 'blue']);
const _ddcHost = { proc: null, buf: '', nextId: 1, pending: new Map(), idleTimer: null };

function _retireDdcHost(reason) {
  const proc = _ddcHost.proc;
  _ddcHost.proc = null;
  _ddcHost.buf = '';
  if (_ddcHost.idleTimer) { clearTimeout(_ddcHost.idleTimer); _ddcHost.idleTimer = null; }
  for (const p of _ddcHost.pending.values()) {
    clearTimeout(p.timer);
    try { p.reject(new Error(reason || 'ddc host down')); } catch {}
  }
  _ddcHost.pending.clear();
  if (!proc) return;
  // Closing stdin ends the serve loop → the worker releases its monitor handles
  // (DestroyPhysicalMonitors) cleanly; a hard kill only fires if it lingers.
  try { proc.stdin.end(); } catch {}
  const force = setTimeout(() => { try { proc.kill(); } catch {} }, 2000);
  force.unref();
  proc.once('exit', () => clearTimeout(force));
}

function _ensureDdcHost() {
  if (_ddcHost.proc) return _ddcHost.proc;
  let proc;
  try {
    proc = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', DDC_SCRIPT, '-Serve'],
      { windowsHide: true });
  } catch { return null; }
  _ddcHost.proc = proc;
  _ddcHost.buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    _ddcHost.buf += chunk;
    let nl;
    while ((nl = _ddcHost.buf.indexOf('\n')) !== -1) {
      const line = _ddcHost.buf.slice(0, nl).trim();
      _ddcHost.buf = _ddcHost.buf.slice(nl + 1);
      if (!line.startsWith('XEDDC ')) continue; // ignore any stray output
      let env;
      try { env = JSON.parse(Buffer.from(line.slice(6), 'base64').toString('utf8')); }
      catch { continue; }
      const p = _ddcHost.pending.get(env.id);
      if (!p) continue;
      clearTimeout(p.timer);
      _ddcHost.pending.delete(env.id);
      p.resolve(env);
    }
  });
  proc.stderr.on('data', () => {}); // the host traps its own errors; ignore
  proc.on('error', () => _retireDdcHost('ddc host spawn error'));
  proc.on('exit', () => { if (_ddcHost.proc === proc) _retireDdcHost('ddc host exited'); });
  proc.unref(); // never keep the event loop alive on the host's account
  return proc;
}

function _ddcArmIdle() {
  if (_ddcHost.idleTimer) clearTimeout(_ddcHost.idleTimer);
  _ddcHost.idleTimer = setTimeout(() => _retireDdcHost('idle'), DDC_IDLE_MS);
  _ddcHost.idleTimer.unref();
}

function runDdcRequest(payload, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const proc = _ensureDdcHost();
    if (!proc) { reject(new Error('ddc host unavailable')); return; }
    const id = _ddcHost.nextId++;
    const timer = setTimeout(() => {
      _ddcHost.pending.delete(id);
      _retireDdcHost('ddc host timeout');
      reject(new Error('ddc host timeout'));
    }, timeout);
    _ddcHost.pending.set(id, { resolve, reject, timer });
    _ddcArmIdle();
    try { proc.stdin.write(JSON.stringify({ ...payload, id }) + '\n'); }
    catch (e) { clearTimeout(timer); _ddcHost.pending.delete(id); reject(e); }
  });
}

function cpuSnapshot() {
  return os.cpus().map(cpu => {
    const times = cpu.times;
    const total = times.user + times.nice + times.sys + times.idle + times.irq;
    return { idle: times.idle, total };
  });
}

let lastCpu = cpuSnapshot();
let cachedCpuUsage = 0;
// Continuous CPU sampler — avoids 0% sampling artifacts when /system is polled less often than CPU times update.
setInterval(() => {
  const now = cpuSnapshot();
  let idle = 0, total = 0;
  now.forEach((cpu, i) => {
    idle  += cpu.idle  - lastCpu[i].idle;
    total += cpu.total - lastCpu[i].total;
  });
  lastCpu = now;
  if (total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round(100 - (idle / total * 100))));
    cachedCpuUsage = pct;
  }
}, 1500).unref();
// A collector reading → number, or null when the sensor reported nothing.
// Number(null) and Number('') are BOTH 0, so a bare Number.isFinite(Number(v))
// turns an absent sensor into a real "0 W" reading — the widgets would render
// a phantom 0 instead of their empty state.
const collectorNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// The GPU collector's per-fan RPM list → a clean [{name, rpm}], or null when the
// collector sent no `gpuFans` key at all (a failed/legacy read — the caller keeps
// whatever it had). An EMPTY array is a real answer, not a gap: it means the card
// reported no fan sensor, and it must clear the previous list rather than freeze
// stale RPM on screen forever. 0 RPM is likewise a real reading — a card in idle
// zero-RPM mode has genuinely stopped its fans — so it is kept.
function normalizeGpuFans(raw) {
  if (raw === null || raw === undefined) return null;
  // Windows PowerShell 5.1 unwraps a single-element array on serialize, so a
  // one-fan card arrives as a bare object.
  const list = Array.isArray(raw) ? raw : (typeof raw === 'object' ? [raw] : []);
  return list
    .filter(f => f && typeof f === 'object' && collectorNum(f.rpm) !== null)
    .map(f => ({ name: String(f.name || 'GPU Fan').slice(0, 48), rpm: Math.round(collectorNum(f.rpm)) }));
}

let gpuCache = { gpu: null, gpuName: null, gpuTemp: null, vramUsed: null, vramTotal: null, gpuWatts: null, gpuFanRpm: null, gpuFanPct: null, gpuFans: [], updatedAt: 0 };
let cpuTempCache = { cpuTemp: null, fans: [], cpuWatts: null, psuWatts: null, sensorAccess: null, updatedAt: 0 };
// Why the LHM-backed sensors (fan RPM, CPU/PSU watts) are unavailable, so the
// widgets can give the one hint that helps instead of guessing.
const SENSOR_ACCESS = new Set(['ok', 'needs_admin', 'missing']);
let mediaCache = { data: null, updatedAt: 0 };
// Weather responses cached per (lang|provider|mode|city). Different surfaces —
// and the server's own AI calls — can ask with different languages; a single
// shared slot would let them evict each other on every request, hammering the
// providers and handing two surfaces two different snapshots of the same place
// for up to a refresh cycle (#72). Bounded: oldest entry evicted past the cap.
const WEATHER_CACHE_MAX_ENTRIES = 16;
const weatherCache = new Map();   // cacheKey → { data, updatedAt }
const weatherPending = new Map(); // cacheKey → in-flight promise
let gpuPending = null;
let cpuTempPending = null;
let mediaPending = null;
let audioPending = null;
// STT via ffmpeg — WASAPI preferred (fast init), dshow fallback
let _sttDeviceReady = false;
let _sttUseWasapi   = false;
let _sttDshowDevice = null;
let _boundMicLabel  = null; // mic label we last bound to. Drives re-init on device changes.
const _sttDeviceWaiters = [];
const _sttPending = new Map(); // id → { ffmpegProc, wavPath, recordingStarted, resolveRecording, recordingSaved, resolveSaved }

// A recorder is normally reaped within seconds — the silence detector ends it or
// the client POSTs /api/stt/stop. If the client dies mid-recording (a crashed tab,
// or the dashboard closing right after a hands-free wake), the entry would live
// forever: ffmpeg keeps writing to %TEMP%, every later /api/stt/start answers 409,
// and wakeWord.isBusy() stays true so the resumed listener drops every segment —
// wake word is dead until restart. This periodic sweep reaps any over-age entry,
// kills its ffmpeg, unlinks the wav and lets the wake word recover. Zero cost when
// there is nothing recording (the common case).
const STT_MAX_AGE_MS = 5 * 60 * 1000;
function _sweepStaleStt() {
  if (_sttPending.size === 0) return;
  const now = Date.now();
  for (const [id, rec] of _sttPending) {
    if (now - (rec.startedAt || 0) < STT_MAX_AGE_MS) continue;
    _sttPending.delete(id);
    try { rec.ffmpegProc.kill(); } catch { /* already gone */ }
    if (rec.wavPath) fs.promises.unlink(rec.wavPath).catch(() => {});
    process.stdout.write(`[STT] Reaped stale recording id=${id}\n`);
  }
  if (_sttPending.size === 0) wakeWord.resumeSoon();
}
setInterval(_sweepStaleStt, 60000).unref();

const STT_SPEECH_MIN         = 420;
const STT_START_SILENCE_GRACE_MS       = 3200;
const STT_AFTER_SPEECH_SILENCE_GRACE_MS = 2500;

function _pcmRms(pcm) {
  if (!pcm || pcm.length < 2) return 0;
  const n = pcm.length - (pcm.length % 2);
  let sum = 0;
  for (let i = 0; i < n; i += 2) sum += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(sum / (n / 2));
}

function _pcmRmsStats(pcm, sampleRate = 16000, frameMs = 80) {
  const full = _pcmRms(pcm);
  const n = pcm ? pcm.length - (pcm.length % 2) : 0;
  const frameBytes = Math.max(2, Math.floor(sampleRate * frameMs / 1000) * 2);
  let peak = 0;
  for (let offset = 0; offset < n; offset += frameBytes) {
    const end = Math.min(n, offset + frameBytes);
    const frame = pcm.slice(offset, end - ((end - offset) % 2));
    if (frame.length >= 2) peak = Math.max(peak, _pcmRms(frame));
  }
  return { rms: full, peak: Math.max(peak, full) };
}

function _dbFromRms(rms) {
  if (!Number.isFinite(rms) || rms <= 0) return -60;
  return 20 * Math.log10(Math.max(1, rms) / 32768);
}

// End-of-speech silence threshold (raw input, BEFORE the gain boost is applied).
// Kept lenient so a quiet mic — e.g. a Bluetooth headset in hands-free mode,
// whose speech sits well below a normal mic's — is not mistaken for silence and
// cut off mid-sentence. Noisy mics whose idle hum exceeds this just fall back to
// the client-side auto-stop timer, which is the safe degradation.
function _sttSilenceDb() {
  return -42;
}

// Input gain applied to the captured audio. A Bluetooth hands-free mic produces
// a very low signal (the browser's getUserMedia hides this with automatic gain
// control; our raw ffmpeg capture does not), so we boost it both for end-of-
// speech detection and so Gemini receives an audible clip. The "Microphone
// sensitivity" slider drives the amount: 0 → 1.5×, 50 → ~3.25×, 100 → 5×.
function _sttGain() {
  const s = (_serverHubSettings && Number.isFinite(_serverHubSettings.aiMicSensitivity))
    ? _serverHubSettings.aiMicSensitivity : 50;
  return Math.round((1.5 + (s / 100) * 3.5) * 10) / 10;
}

// Speech gate runs on the gain-boosted clip. The boost lifts real speech above
// the floor while idle noise — proportionally lower — stays beneath it, so this
// still rejects near-silent clips before they reach Gemini.
function _sttLooksLikeSpeech(stats) {
  if (!stats) return false;
  if (stats.rms >= STT_SPEECH_MIN) return true;
  return stats.rms >= 330 && stats.peak >= 620;
}


let mediaPreferredSource = '';
const MEDIA_CACHE_MS = 1200;
const WEATHER_CACHE_MS = 10 * 60 * 1000;
// The forecast cache must stay STRICTLY below the shortest client refresh the user
// can pick (Settings → Meteo → 10 min). If it equals the poll interval, the small
// server-side fetch latency means every other client poll lands just inside the
// cache window and returns stale data — halving the effective refresh (a 10-min
// setting behaved like ~20 min). Kept separate from WEATHER_CACHE_MS so geocoding /
// IP-location caches (which change rarely) still coalesce for the full 10 min.
const WEATHER_FORECAST_CACHE_MS = 5 * 60 * 1000;
// Max days the "next days" forecast can request/return. The forecast is cached
// per-location and doesn't know the per-client day preference, so the server
// always fetches up to this many and the client trims to the user's choice (1–7).
// Open-Meteo/met.no cover 7 easily; wttr.in only exposes 3 (harmless — slicing a
// shorter list is a no-op and the UI just shows what's available).
const WEATHER_FORECAST_MAX_DAYS = 7;
const WEATHER_LANGS = new Set(['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']);
const artworkCache = new Map();
const weatherLocationCache = new Map();

function sanitizeMediaSourcePreference(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240);
}

function setMediaPreferredSource(value) {
  const next = sanitizeMediaSourcePreference(value);
  if (next !== mediaPreferredSource) {
    mediaPreferredSource = next;
    mediaCache.updatedAt = 0;
  }
  return mediaPreferredSource;
}

function mediaScriptArgs(action) {
  const args = [action];
  if (mediaPreferredSource) args.push(mediaPreferredSource);
  return args;
}

function makeCsvPath() {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(os.tmpdir(), `xenonedge-svv-${stamp}.csv`);
}

function readSoundVolumeRows() {
  if (linuxCollectors) return linuxCollectors.audioRows();
  return new Promise((resolve, reject) => {
    const csv = makeCsvPath();
    execFile(SVV, ['/scomma', csv, '/AvoidPrompts'], { timeout: 6000 }, err => {
      if (err) return reject(err);
      setTimeout(async () => {
        try {
          const raw = await fs.promises.readFile(csv, 'latin1');
          const rows = raw
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .map(parseCsvLine);
          fs.unlink(csv, () => {});
          resolve(rows);
        } catch (e) {
          fs.unlink(csv, () => {});
          reject(e);
        }
      }, 250);
    });
  });
}

async function resolveAppIcons(appPaths) {
  // Extract the associated exe icon for each process path, exactly like windows.ps1
  // does for the app switcher. Keyed by path so each app resolves once and is cached.
  const keys = appPaths.map(p => (p || '').toLowerCase());
  const uncached = [...new Set(keys)].filter(k => k && !appIconCache.has(k));
  if (uncached.length) {
    const psArr = uncached.map(p => `'${p.replace(/'/g, "''")}'`).join(',');
    const psCmd = `
      $paths = @(${psArr})
      $out = @{}
      try { Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue } catch {}
      foreach ($p in $paths) {
        $key = $p
        try {
          if ($p -and (Test-Path -LiteralPath $p)) {
            $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($p)
            if ($ico) {
              $bmp = New-Object System.Drawing.Bitmap(32, 32)
              $g = [System.Drawing.Graphics]::FromImage($bmp)
              $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
              $g.DrawImage($ico.ToBitmap(), 0, 0, 32, 32)
              $g.Dispose()
              $ms = New-Object System.IO.MemoryStream
              $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
              $out[$key] = 'data:image/png;base64,' + [Convert]::ToBase64String($ms.ToArray())
              $bmp.Dispose(); $ms.Dispose(); $ico.Dispose()
            }
          }
        } catch {}
        if (-not $out.ContainsKey($key)) { $out[$key] = $null }
      }
      $out | ConvertTo-Json -Compress
    `;
    try {
      const result = await runPowerShellCommand(psCmd, 10000);
      if (result && typeof result === 'object') {
        for (const [k, v] of Object.entries(result)) {
          setAppIcon(k.toLowerCase(), v || null);
        }
      }
    } catch {}
    for (const k of uncached) {
      if (!appIconCache.has(k)) setAppIcon(k, null);
    }
  }
  return keys.map(k => appIconCache.get(k) || null);
}

// Extract a Store/UWP app's own tile logo from its installed package manifest, so
// a Deck "open Store app" key can use the app's real icon with no external image.
// Store apps have no classic exe for ExtractAssociatedIcon — they launch by AUMID
// (PackageFamilyName!AppId) — so we read the Square logo asset declared in
// AppxManifest.xml straight off disk (best-scaled variant), yielding a clean PNG
// with proper transparency. Cached in appIconCache under a 'store:' namespace so
// it can't collide with exe-path keys. Returns a PNG data URL or null.
async function resolveStoreAppIcon(aumid) {
  const id = String(aumid || '').trim();
  // Defence in depth: the endpoint already charset-checks the AUMID, but re-assert
  // here so the two halves can never carry anything but [\w.-] into PowerShell.
  if (!/^[\w.-]+![\w.-]+$/.test(id)) return null;
  const cacheKey = 'store:' + id.toLowerCase();
  if (appIconCache.has(cacheKey)) return appIconCache.get(cacheKey);
  const [pfn, appId] = id.split('!');
  const psCmd = `
    $pfn = '${pfn}'
    $appId = '${appId}'
    $out = @{ icon = $null }
    try {
      $name = ($pfn -split '_')[0]
      $pkg = Get-AppxPackage -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.PackageFamilyName -eq $pfn } | Select-Object -First 1
      if (-not $pkg) { $pkg = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.PackageFamilyName -eq $pfn } | Select-Object -First 1 }
      if ($pkg -and $pkg.InstallLocation) {
        $loc = $pkg.InstallLocation
        $manifest = Join-Path $loc 'AppxManifest.xml'
        if (Test-Path -LiteralPath $manifest) {
          [xml]$m = Get-Content -LiteralPath $manifest
          $logo = $null
          foreach ($app in $m.SelectNodes("//*[local-name()='Application']")) {
            if ($app.GetAttribute('Id') -eq $appId) {
              $ve = $app.SelectSingleNode(".//*[local-name()='VisualElements']")
              if ($ve) { $logo = $ve.GetAttribute('Square44x44Logo'); if (-not $logo) { $logo = $ve.GetAttribute('Square150x150Logo') } }
              break
            }
          }
          if (-not $logo) {
            $ve = $m.SelectSingleNode("//*[local-name()='VisualElements']")
            if ($ve) { $logo = $ve.GetAttribute('Square44x44Logo'); if (-not $logo) { $logo = $ve.GetAttribute('Square150x150Logo') } }
          }
          if ($logo) {
            $baseName = [System.IO.Path]::GetFileNameWithoutExtension($logo.Replace('/', '\\'))
            $ext = [System.IO.Path]::GetExtension($logo)
            if (-not $ext) { $ext = '.png' }
            # The manifest logo path is LOGICAL (resource-resolved); the real scaled
            # assets live elsewhere in the package under the same base filename, so
            # search the package and prefer the standard full-colour variant near a
            # crisp size, falling back to any non-themed then the largest available.
            $all = @(Get-ChildItem -LiteralPath $loc -Recurse -Filter ($baseName + '*' + $ext) -File -ErrorAction SilentlyContinue)
            $file = $null
            foreach ($tag in @('scale-200','targetsize-48','targetsize-64','scale-150','targetsize-96','scale-100','targetsize-32')) {
              $cand = $all | Where-Object { $_.Name -eq ($baseName + '.' + $tag + $ext) } | Select-Object -First 1
              if ($cand) { $file = $cand.FullName; break }
            }
            if (-not $file) {
              $cand = $all | Where-Object { $_.Name -notmatch 'altform' } | Sort-Object Length -Descending | Select-Object -First 1
              if ($cand) { $file = $cand.FullName }
            }
            if (-not $file -and $all.Count) { $file = ($all | Sort-Object Length -Descending | Select-Object -First 1).FullName }
            if ($file) {
              $bytes = [System.IO.File]::ReadAllBytes($file)
              $out.icon = 'data:image/png;base64,' + [Convert]::ToBase64String($bytes)
            }
          }
        }
      }
    } catch {}
    $out | ConvertTo-Json -Compress
  `;
  let icon = null;
  try {
    const out = await runPowerShellCommand(psCmd, 10000);
    if (out && typeof out.icon === 'string' && out.icon) icon = out.icon;
  } catch {}
  setAppIcon(cacheKey, icon);
  return icon;
}

function fetchJson(url, timeout = 2500, extraHeaders) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'Xenon/1.0', ...(extraHeaders || {}) };
    const req = https.get(url, { timeout, headers }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Artwork lookup timeout')); });
    req.on('error', reject);
  });
}

async function hydrateArtwork(data) {
  if (!data || !data.active || data.thumbnail) return data;
  const title = (data.title || '').trim();
  const artist = (data.artist || '').trim();
  if (!title || !artist) return data;

  const key = `${artist}::${title}`.toLowerCase();
  if (artworkCache.has(key)) {
    data.thumbnail = artworkCache.get(key);
    return data;
  }

  try {
    const term = encodeURIComponent(`${artist} ${title}`);
    const result = await fetchJson(`https://itunes.apple.com/search?term=${term}&entity=song&limit=1`, 2500);
    const art = result && result.results && result.results[0] && result.results[0].artworkUrl100;
    const bigArt = art ? art.replace('100x100bb', '600x600bb') : null;
    // LRU eviction: cap cache at 200 entries to prevent unbounded growth.
    if (artworkCache.size >= 200) artworkCache.delete(artworkCache.keys().next().value);
    artworkCache.set(key, bigArt);
    data.thumbnail = bigArt;
  } catch {
    if (artworkCache.size >= 200) artworkCache.delete(artworkCache.keys().next().value);
    artworkCache.set(key, null);
  }

  return data;
}

function firstWeatherValue(value) {
  if (Array.isArray(value) && value[0] && typeof value[0].value === 'string') return value[0].value;
  return '';
}

function normalizeWeatherCode(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function sanitizeWeatherCity(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>`"'\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normalizeWeatherLocation(value) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = source.mode === 'manual' ? 'manual' : 'auto';
  return {
    mode,
    city: sanitizeWeatherCity(source.city),
  };
}

function resolveWeatherLocation(value) {
  const location = normalizeWeatherLocation(value);
  if (location.mode === 'manual' && location.city) return location;
  return { mode: 'auto', city: '' };
}

function normalizeWeatherCityKey(value) {
  return sanitizeWeatherCity(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function pickWeatherLocationResult(results, requestedCity) {
  if (!Array.isArray(results) || !results.length) return null;
  const requestedKey = normalizeWeatherCityKey(requestedCity);
  return results.find(item => normalizeWeatherCityKey(item && item.name) === requestedKey)
    || results.find(item => requestedKey.startsWith(normalizeWeatherCityKey(item && item.name)))
    || results.find(item => normalizeWeatherCityKey(item && item.name).startsWith(requestedKey))
    || results[0];
}

function splitWeatherDisplayLocation(value) {
  const parts = String(value || '').split(',').map(part => part.trim()).filter(Boolean);
  return {
    location: parts[0] || '',
    region: parts[1] || '',
    country: parts.slice(2).join(', '),
  };
}

// Recover real coordinates for a manual city that open-meteo's structured
// geocoder rejected — a full address or place name like
// "Bücherei Wien Hütteldorfer Straße 130d". The user must never have to know or
// type coordinates: wttr.in's geocoder is far more lenient (it resolves freeform
// strings the structured one won't) and its response carries the matched point's
// lat/lon. Reusing those coordinates lets the coordinate-only providers
// (MET Norway / Open-Meteo — the full 7-day forecast) run, instead of the widget
// silently degrading to wttr's own 3-day feed. Language-independent, unlike
// matching localized city names ("Wien" vs "Vienna"). Returns a place or null.
async function recoverWeatherPlaceViaWttr(requestedCity, lang) {
  let raw;
  // wttr answers plain text ("Unknown location…") for a real miss, so a JSON
  // parse failure here just means "not found" — fall through to null, never throw.
  try { raw = await fetchJson(`https://wttr.in/${encodeURIComponent(requestedCity)}?format=j1&lang=${lang}`, 3500); }
  catch { return null; }
  const area = raw && Array.isArray(raw.nearest_area) && raw.nearest_area[0] || null;
  const lat = Number(area && area.latitude);
  const lon = Number(area && area.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // Keep the user's own text as the displayed name (what they typed) and just
  // attach the recovered coordinates so the richer providers can run.
  return { placePath: `/${lat.toFixed(4)},${lon.toFixed(4)}`, resolvedCity: requestedCity, lat, lon };
}

async function resolveManualWeatherPlace(city, lang) {
  const requestedCity = sanitizeWeatherCity(city);
  if (!requestedCity) return { placePath: '', resolvedCity: '' };

  const cacheKey = `${lang}|${requestedCity.toLowerCase()}`;
  const cached = weatherLocationCache.get(cacheKey);
  if (cached && (Date.now() - cached.updatedAt) < WEATHER_CACHE_MS) return cached.value;

  let value = {
    placePath: `/${encodeURIComponent(requestedCity)}`,
    resolvedCity: requestedCity,
    lat: NaN,
    lon: NaN,
  };

  try {
    const query = encodeURIComponent(requestedCity);
    const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${query}&count=10&language=${lang}&format=json`, 3000);
    const match = pickWeatherLocationResult(geo && geo.results, requestedCity);
    const latitude = Number(match && match.latitude);
    const longitude = Number(match && match.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      value = {
        placePath: `/${latitude.toFixed(4)},${longitude.toFixed(4)}`,
        resolvedCity: [match.name, match.admin1, match.country].filter(Boolean).join(', ') || requestedCity,
        lat: latitude,
        lon: longitude,
      };
    }
  } catch {
    // Fall back to the raw city name when geocoding is unavailable.
  }

  // The exact string didn't resolve to coordinates (a full address / place
  // name). Try to recover the intended city from its words so MET Norway /
  // Open-Meteo can still run (7-day forecast) instead of the widget quietly
  // dropping to wttr.in's 3 days — without asking the user for coordinates.
  if (!Number.isFinite(value.lat) || !Number.isFinite(value.lon)) {
    try {
      const recovered = await recoverWeatherPlaceViaWttr(requestedCity, lang);
      if (recovered) value = recovered;
    } catch { /* keep the raw-name value; wttr can still self-geolocate */ }
  }

  weatherLocationCache.set(cacheKey, { value, updatedAt: Date.now() });
  return value;
}

function weatherDescription(item, lang) {
  if (!item) return '';
  return firstWeatherValue(item[`lang_${lang}`]) || firstWeatherValue(item.weatherDesc) || '';
}

function normalizeWeatherHour(hour, lang, date) {
  const rawTime = String(hour && hour.time || '0').padStart(4, '0');
  const time = `${rawTime.slice(0, -2).padStart(2, '0')}:${rawTime.slice(-2)}`;
  const tempC = Number(hour && hour.tempC);
  const feelsC = Number(hour && hour.FeelsLikeC);
  const rain = Number(hour && hour.chanceofrain);
  const windKph = Number(hour && hour.windspeedKmph);
  return {
    date,
    time,
    code: normalizeWeatherCode(hour && hour.weatherCode),
    tempC: Number.isFinite(tempC) ? Math.round(tempC) : null,
    feelsC: Number.isFinite(feelsC) ? Math.round(feelsC) : null,
    rain: Number.isFinite(rain) ? Math.round(rain) : null,
    windKph: Number.isFinite(windKph) ? Math.round(windKph) : null,
    condition: weatherDescription(hour, lang),
  };
}

function normalizeWeatherDay(day, lang) {
  const astronomy = day && day.astronomy && day.astronomy[0] || {};
  const noon = day && Array.isArray(day.hourly) ? (day.hourly.find(h => String(h.time) === '1200') || day.hourly[0]) : null;
  return {
    date: String(day && day.date || ''),
    code: normalizeWeatherCode(noon && noon.weatherCode),
    minC: Number.isFinite(Number(day && day.mintempC)) ? Math.round(Number(day.mintempC)) : null,
    maxC: Number.isFinite(Number(day && day.maxtempC)) ? Math.round(Number(day.maxtempC)) : null,
    avgC: Number.isFinite(Number(day && day.avgtempC)) ? Math.round(Number(day.avgtempC)) : null,
    uv: Number.isFinite(Number(day && day.uvIndex)) ? Number(day.uvIndex) : null,
    sunHour: Number.isFinite(Number(day && day.sunHour)) ? Number(day.sunHour) : null,
    sunrise: String(astronomy.sunrise || ''),
    sunset: String(astronomy.sunset || ''),
    moonPhase: String(astronomy.moon_phase || ''),
    condition: weatherDescription(noon, lang),
  };
}

function normalizeWeather(raw, lang) {
  const current = raw && raw.current_condition && raw.current_condition[0] || {};
  const area = raw && raw.nearest_area && raw.nearest_area[0] || {};
  const tempC = Number(current.temp_C);
  const feelsC = Number(current.FeelsLikeC);
  const humidity = Number(current.humidity);
  const windKph = Number(current.windspeedKmph);
  const pressure = Number(current.pressure);
  const visibility = Number(current.visibility);
  const uv = Number(current.uvIndex);
  const cloudCover = Number(current.cloudcover);
  const precipMM = Number(current.precipMM);
  const lat = Number(area.latitude);
  const lon = Number(area.longitude);
  const condition = weatherDescription(current, lang);
  const location = firstWeatherValue(area.areaName) || firstWeatherValue(area.region) || firstWeatherValue(area.country) || '';
  const region = firstWeatherValue(area.region);
  const country = firstWeatherValue(area.country);
  const days = Array.isArray(raw && raw.weather) ? raw.weather : [];
  const nowHour = new Date().getHours();
  const hourly = days.flatMap(day => (Array.isArray(day.hourly) ? day.hourly : [])
    .map(hour => normalizeWeatherHour(hour, lang, String(day.date || ''))))
    .filter(hour => !hour.date || hour.date !== days[0]?.date || Number(hour.time.slice(0, 2)) >= nowHour)
    .slice(0, 8);
  const todayAstro = days[0] && days[0].astronomy && days[0].astronomy[0] || {};

  return {
    ok: Number.isFinite(tempC),
    code: normalizeWeatherCode(current.weatherCode),
    tempC: Number.isFinite(tempC) ? Math.round(tempC) : null,
    feelsC: Number.isFinite(feelsC) ? Math.round(feelsC) : null,
    humidity: Number.isFinite(humidity) ? humidity : null,
    windKph: Number.isFinite(windKph) ? Math.round(windKph) : null,
    windDir: String(current.winddir16Point || ''),
    pressure: Number.isFinite(pressure) ? pressure : null,
    visibility: Number.isFinite(visibility) ? visibility : null,
    uv: Number.isFinite(uv) ? uv : null,
    cloudCover: Number.isFinite(cloudCover) ? cloudCover : null,
    precipMM: Number.isFinite(precipMM) ? precipMM : null,
    condition,
    location,
    region,
    country,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    sunrise: String(todayAstro.sunrise || ''),
    sunset: String(todayAstro.sunset || ''),
    hourly,
    forecast: days.slice(0, WEATHER_FORECAST_MAX_DAYS).map(day => normalizeWeatherDay(day, lang)),
    updatedAt: Date.now(),
    aqi: null, pm25: null, pm10: null, no2: null, pollen: null,
  };
}

// ── Weather providers ───────────────────────────────────────────────
// The dashboard can draw weather from more than one free, no-key source, so an
// outage or a bad reading from one never leaves the widget blank or wrong.
// Every provider maps its native payload onto the SAME normalized shape as
// normalizeWeather() (wttr.in), so the client renders any of them identically.
//   • open-meteo — api.open-meteo.com (WMO codes, very reliable, complete)
//   • metno      — api.met.no / yr.no (needs an identifying User-Agent)
//   • wttr       — wttr.in (self-geolocates by IP; the original source)
// 'auto' tries them in that order and returns the first that answers.
const WEATHER_PROVIDERS = new Set(['auto', 'open-meteo', 'metno', 'wttr']);

// The met.no terms of service require an identifying User-Agent with contact.
const METNO_HEADERS = { 'User-Agent': 'XenonEdgeHub/3.3 (github.com/marcimastro98/Xenon)' };

// Canonical condition buckets → a representative wttr (WWO) code the client's
// classifier already understands, plus a localized label. Providers map their
// own codes to a bucket, so icons, day/night and colours work with no client
// change. Labels cover every UI language in WEATHER_LANGS (fallback: English) —
// keep the two in step when adding a language, or that language's users get
// mixed-language conditions (#72).
const WEATHER_BUCKET_CODE = Object.freeze({
  clear: 113, partly: 116, cloud: 119, fog: 248,
  drizzle: 266, rain: 302, showers: 356, snow: 338, storm: 200,
});
const WEATHER_BUCKET_LABELS = Object.freeze({
  it: { clear: 'Sereno', partly: 'Poco nuvoloso', cloud: 'Nuvoloso', fog: 'Nebbia', drizzle: 'Pioviggine', rain: 'Pioggia', showers: 'Rovesci', snow: 'Neve', storm: 'Temporale' },
  en: { clear: 'Clear', partly: 'Partly cloudy', cloud: 'Cloudy', fog: 'Fog', drizzle: 'Drizzle', rain: 'Rain', showers: 'Showers', snow: 'Snow', storm: 'Thunderstorm' },
  ko: { clear: '맑음', partly: '구름 조금', cloud: '흐림', fog: '안개', drizzle: '이슬비', rain: '비', showers: '소나기', snow: '눈', storm: '뇌우' },
  ja: { clear: '快晴', partly: '晴れ時々曇り', cloud: '曇り', fog: '霧', drizzle: '霧雨', rain: '雨', showers: 'にわか雨', snow: '雪', storm: '雷雨' },
  zh: { clear: '晴', partly: '多云', cloud: '阴', fog: '雾', drizzle: '毛毛雨', rain: '雨', showers: '阵雨', snow: '雪', storm: '雷暴' },
  es: { clear: 'Despejado', partly: 'Parcialmente nublado', cloud: 'Nublado', fog: 'Niebla', drizzle: 'Llovizna', rain: 'Lluvia', showers: 'Chubascos', snow: 'Nieve', storm: 'Tormenta' },
  fr: { clear: 'Dégagé', partly: 'Partiellement nuageux', cloud: 'Nuageux', fog: 'Brouillard', drizzle: 'Bruine', rain: 'Pluie', showers: 'Averses', snow: 'Neige', storm: 'Orage' },
  de: { clear: 'Klar', partly: 'Teilweise bewölkt', cloud: 'Bewölkt', fog: 'Nebel', drizzle: 'Nieselregen', rain: 'Regen', showers: 'Schauer', snow: 'Schnee', storm: 'Gewitter' },
  pt: { clear: 'Céu limpo', partly: 'Parcialmente nublado', cloud: 'Nublado', fog: 'Nevoeiro', drizzle: 'Chuvisco', rain: 'Chuva', showers: 'Aguaceiros', snow: 'Neve', storm: 'Trovoada' },
  ru: { clear: 'Ясно', partly: 'Переменная облачность', cloud: 'Облачно', fog: 'Туман', drizzle: 'Морось', rain: 'Дождь', showers: 'Ливни', snow: 'Снег', storm: 'Гроза' },
  nl: { clear: 'Helder', partly: 'Gedeeltelijk bewolkt', cloud: 'Bewolkt', fog: 'Mist', drizzle: 'Motregen', rain: 'Regen', showers: 'Buien', snow: 'Sneeuw', storm: 'Onweer' },
});
function weatherBucketLabel(bucket, lang) {
  const table = WEATHER_BUCKET_LABELS[lang] || WEATHER_BUCKET_LABELS.en;
  return table[bucket] || WEATHER_BUCKET_LABELS.en[bucket] || '';
}
function degToCompass(deg) {
  const n = Number(deg);
  if (!Number.isFinite(n)) return '';
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return points[Math.round(((n % 360) + 360) % 360 / 22.5) % 16];
}
// ISO8601 local time (e.g. "2026-07-01T05:38") → "HH:MM" for display + the
// client's night detector (parseSunTime also accepts 24h times).
function isoToClock(iso) {
  const m = String(iso || '').match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}
function isoDatePart(iso) {
  const m = String(iso || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

// WMO weather interpretation code (open-meteo) → canonical bucket.
function wmoBucket(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return 'cloud';
  if (c === 0) return 'clear';
  if (c === 1 || c === 2) return 'partly';
  if (c === 3) return 'cloud';
  if (c === 45 || c === 48) return 'fog';
  if (c >= 51 && c <= 57) return 'drizzle';
  if (c >= 61 && c <= 67) return 'rain';
  if (c >= 71 && c <= 77) return 'snow';
  if (c >= 80 && c <= 82) return 'showers';
  if (c === 85 || c === 86) return 'snow';
  if (c >= 95) return 'storm';
  return 'cloud';
}
// met.no symbol_code (e.g. "partlycloudy_night", "lightrainshowers_day") → bucket.
function metnoBucket(symbol) {
  const s = String(symbol || '').replace(/_(day|night|polartwilight)$/, '');
  if (!s) return 'cloud';
  if (s.includes('thunder')) return 'storm';
  if (s.includes('sleet')) return 'snow';
  if (s.includes('snow')) return 'snow';
  if (s.includes('showers')) return 'showers';
  if (s.includes('rain')) return 'rain';
  if (s.includes('drizzle')) return 'drizzle';
  if (s === 'fog') return 'fog';
  if (s === 'cloudy') return 'cloud';
  if (s === 'partlycloudy') return 'partly';
  if (s === 'fair') return 'partly';
  if (s === 'clearsky') return 'clear';
  return 'cloud';
}

// Free, no-key IP geolocation (https). Coordinate-based providers need lat/lon
// for AUTO mode; wttr self-geolocates so it doesn't. Cached like the forecast,
// and the last good answer is persisted to DATA_DIR: the backend restarts at
// every boot (native-app nudge), so an in-memory-only value is gone exactly
// when it's needed most — if ipwho.is is then down or slow, one surface gets
// coordinates (open-meteo) and another gets none (wttr's own IP guess), i.e.
// two different forecasts for the same PC until the next refresh (#72). Stale
// coordinates beat no coordinates.
const WEATHER_GEO_FILE = path.join(DATA_DIR, 'weather-geo.json');
let weatherAutoLocation = { value: null, updatedAt: 0 };
let weatherGeoLoad = null; // shared promise — concurrent boot fetches read the file once
async function loadPersistedAutoLocation() {
  try {
    const raw = JSON.parse(await fs.promises.readFile(WEATHER_GEO_FILE, 'utf8'));
    const lat = Number(raw && raw.lat);
    const lon = Number(raw && raw.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      weatherAutoLocation = {
        value: {
          lat, lon,
          location: String(raw.location || ''),
          region: String(raw.region || ''),
          country: String(raw.country || ''),
        },
        updatedAt: Number(raw.updatedAt) || 0,
      };
    }
  } catch { /* first run or unreadable — resolve fresh below */ }
}
let weatherGeoRefresh = null; // in-flight ipwho.is lookup, shared across concurrent callers
let weatherGeoFailAt = 0;     // last failed lookup — skip retrying for a cooldown
const WEATHER_GEO_FAIL_COOLDOWN_MS = 60 * 1000;
async function resolveAutoLocation() {
  if (!weatherGeoLoad) weatherGeoLoad = loadPersistedAutoLocation();
  await weatherGeoLoad;
  if (weatherAutoLocation.value && (Date.now() - weatherAutoLocation.updatedAt) < WEATHER_CACHE_MS) {
    return weatherAutoLocation.value;
  }
  // After a failed lookup, don't pay the fetch timeout again on every forecast
  // refresh — serve the last known place immediately and retry after a cooldown.
  if (Date.now() - weatherGeoFailAt < WEATHER_GEO_FAIL_COOLDOWN_MS) {
    return weatherAutoLocation.value || null;
  }
  // Concurrent misses (several surfaces/languages refreshing at the same tick)
  // share one lookup: ipwho.is is a free, rate-limited service, and a burst of
  // parallel requests is exactly what gets throttled.
  if (!weatherGeoRefresh) {
    weatherGeoRefresh = (async () => {
      try {
        const geo = await fetchJson('https://ipwho.is/', 3000);
        const lat = Number(geo && geo.latitude);
        const lon = Number(geo && geo.longitude);
        if (geo && geo.success !== false && Number.isFinite(lat) && Number.isFinite(lon)) {
          const value = {
            lat, lon,
            location: String(geo.city || ''),
            region: String(geo.region || ''),
            country: String(geo.country || ''),
          };
          weatherAutoLocation = { value, updatedAt: Date.now() };
          writeFileAtomic(WEATHER_GEO_FILE, JSON.stringify({ ...value, updatedAt: weatherAutoLocation.updatedAt }))
            .catch(() => { /* best-effort — memory copy still serves this run */ });
          return value;
        }
      } catch { /* fall through to the last known place */ }
      weatherGeoFailAt = Date.now();
      return null;
    })().finally(() => { weatherGeoRefresh = null; });
  }
  const fresh = await weatherGeoRefresh;
  // Lookup failed: reuse the last known coordinates even past their TTL, so the
  // forecast stays pinned to one place instead of drifting to wttr's IP guess.
  return fresh || weatherAutoLocation.value || null;
}

// Map an open-meteo /v1/forecast payload onto the shared normalized shape.
function normalizeOpenMeteo(raw, ctx) {
  const cur = raw && raw.current;
  if (!cur || !Number.isFinite(Number(cur.temperature_2m))) return null;
  const bucket = wmoBucket(cur.weather_code);
  const daily = raw.daily || {};
  const dDates = Array.isArray(daily.time) ? daily.time : [];
  const sunrise = isoToClock(Array.isArray(daily.sunrise) ? daily.sunrise[0] : '');
  const sunset = isoToClock(Array.isArray(daily.sunset) ? daily.sunset[0] : '');
  const round = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

  const forecast = dDates.slice(0, WEATHER_FORECAST_MAX_DAYS).map((date, i) => {
    const b = wmoBucket(daily.weather_code && daily.weather_code[i]);
    return {
      date: String(date || ''),
      code: WEATHER_BUCKET_CODE[b],
      minC: round(daily.temperature_2m_min && daily.temperature_2m_min[i]),
      maxC: round(daily.temperature_2m_max && daily.temperature_2m_max[i]),
      avgC: null,
      uv: Number.isFinite(Number(daily.uv_index_max && daily.uv_index_max[i])) ? Number(daily.uv_index_max[i]) : null,
      sunHour: null,
      sunrise: isoToClock(daily.sunrise && daily.sunrise[i]),
      sunset: isoToClock(daily.sunset && daily.sunset[i]),
      moonPhase: '',
      condition: weatherBucketLabel(b, ctx.lang),
    };
  });

  const h = raw.hourly || {};
  const hTimes = Array.isArray(h.time) ? h.time : [];
  const nowMs = Date.now();
  const hourly = [];
  for (let i = 0; i < hTimes.length && hourly.length < 8; i++) {
    if (new Date(hTimes[i]).getTime() < nowMs - 60 * 60 * 1000) continue;
    const b = wmoBucket(h.weather_code && h.weather_code[i]);
    hourly.push({
      date: isoDatePart(hTimes[i]),
      time: isoToClock(hTimes[i]),
      code: WEATHER_BUCKET_CODE[b],
      tempC: round(h.temperature_2m && h.temperature_2m[i]),
      feelsC: null,
      rain: round(h.precipitation_probability && h.precipitation_probability[i]),
      windKph: round(h.wind_speed_10m && h.wind_speed_10m[i]),
      condition: weatherBucketLabel(b, ctx.lang),
    });
  }

  const visM = Number(cur.visibility);
  return {
    ok: true,
    code: WEATHER_BUCKET_CODE[bucket],
    tempC: round(cur.temperature_2m),
    feelsC: round(cur.apparent_temperature),
    humidity: round(cur.relative_humidity_2m),
    windKph: round(cur.wind_speed_10m),
    windDir: degToCompass(cur.wind_direction_10m),
    pressure: round(cur.pressure_msl),
    visibility: Number.isFinite(visM) ? Math.round(visM / 1000) : null,
    uv: Number.isFinite(Number(cur.uv_index)) ? Math.round(Number(cur.uv_index)) : null,
    cloudCover: round(cur.cloud_cover),
    precipMM: Number.isFinite(Number(cur.precipitation)) ? Math.round(Number(cur.precipitation) * 10) / 10 : null,
    condition: weatherBucketLabel(bucket, ctx.lang),
    location: ctx.location || '',
    region: ctx.region || '',
    country: ctx.country || '',
    lat: ctx.lat, lon: ctx.lon,
    sunrise, sunset,
    hourly,
    forecast,
    updatedAt: Date.now(),
    aqi: null, pm25: null, pm10: null, no2: null, pollen: null,
    source: 'open-meteo',
  };
}

// "Feels like" for providers that don't supply it (met.no). Wind chill when cold
// and windy, heat index when warm and humid, else the air temperature — the same
// bands weather services use. Inputs °C / km/h / %.
function computeFeelsLike(tempC, windKph, humidity) {
  if (!Number.isFinite(tempC)) return null;
  if (tempC <= 10 && Number.isFinite(windKph) && windKph >= 4.8) {
    const w = Math.pow(windKph, 0.16);
    return Math.round(13.12 + 0.6215 * tempC - 11.37 * w + 0.3965 * tempC * w);
  }
  if (tempC >= 27 && Number.isFinite(humidity) && humidity >= 40) {
    const T = tempC * 9 / 5 + 32, R = humidity;
    const hi = -42.379 + 2.04901523 * T + 10.14333127 * R - 0.22475541 * T * R
      - 0.00683783 * T * T - 0.05481717 * R * R + 0.00122874 * T * T * R
      + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
    return Math.round((hi - 32) * 5 / 9);
  }
  return Math.round(tempC);
}

// Approximate local sunrise/sunset ("HH:MM") for a date, to fill providers that
// omit them (met.no compact). NOAA low-precision algorithm (~1-2 min accuracy —
// ample for the day/night visual and the forecast sun line). Uses the server's
// local timezone, which is the user's own location in auto mode.
function computeSunTimes(lat, lon, dateStr) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { sunrise: '', sunset: '' };
  const d = dateStr ? new Date(`${dateStr}T12:00:00`) : new Date();
  if (!Number.isFinite(d.getTime())) return { sunrise: '', sunset: '' };
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const start = new Date(d.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((d - start) / 86400000);
  const zenith = 90.833;
  const calc = (isSunrise) => {
    const lngHour = lon / 15;
    const tApprox = dayOfYear + ((isSunrise ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * tApprox - 3.289;
    let L = M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634;
    L = ((L % 360) + 360) % 360;
    let RA = deg * Math.atan(0.91764 * Math.tan(L * rad));
    RA = ((RA % 360) + 360) % 360;
    RA += (Math.floor(L / 90) - Math.floor(RA / 90)) * 90;
    RA /= 15;
    const sinDec = 0.39782 * Math.sin(L * rad);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(zenith * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
    if (cosH > 1 || cosH < -1) return '';
    let H = isSunrise ? 360 - deg * Math.acos(cosH) : deg * Math.acos(cosH);
    H /= 15;
    const T = H + RA - 0.06571 * tApprox - 6.622;
    const UT = ((T - lngHour) % 24 + 24) % 24;
    const local = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) + UT * 3600000);
    return `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
  };
  return { sunrise: calc(true), sunset: calc(false) };
}

// Map a met.no locationforecast/2.0/compact payload onto the shared shape.
// The compact product has no sunrise/sunset, UV or feels-like; those stay null
// (the UI already shows "--" for missing metrics). Daily min/max are aggregated
// from the time series; wind is m/s → km/h.
function normalizeMetno(raw, ctx) {
  const series = raw && raw.properties && Array.isArray(raw.properties.timeseries) ? raw.properties.timeseries : [];
  if (!series.length) return null;
  const first = series[0];
  const inst = first.data && first.data.instant && first.data.instant.details;
  if (!inst || !Number.isFinite(Number(inst.air_temperature))) return null;
  const round = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  const symbolOf = (entry) => {
    const d = entry && entry.data;
    return (d && ((d.next_1_hours && d.next_1_hours.summary && d.next_1_hours.summary.symbol_code)
      || (d.next_6_hours && d.next_6_hours.summary && d.next_6_hours.summary.symbol_code))) || '';
  };
  const precipOf = (entry) => {
    const d = entry && entry.data;
    const p = d && ((d.next_1_hours && d.next_1_hours.details) || (d.next_6_hours && d.next_6_hours.details));
    return p && Number.isFinite(Number(p.precipitation_amount)) ? Number(p.precipitation_amount) : null;
  };
  const curBucket = metnoBucket(symbolOf(first));

  // Next 8 hourly points.
  const hourly = series.slice(0, 8).map(entry => {
    const det = entry.data && entry.data.instant && entry.data.instant.details || {};
    const b = metnoBucket(symbolOf(entry));
    return {
      date: isoDatePart(entry.time),
      time: isoToClock(entry.time),
      code: WEATHER_BUCKET_CODE[b],
      tempC: round(det.air_temperature),
      feelsC: null,
      rain: null,
      windKph: Number.isFinite(Number(det.wind_speed)) ? Math.round(Number(det.wind_speed) * 3.6) : null,
      condition: weatherBucketLabel(b, ctx.lang),
    };
  });

  // Daily aggregation: group instants by local date, take min/max; the day's
  // symbol is the entry nearest local noon.
  const byDate = new Map();
  series.forEach(entry => {
    const date = isoDatePart(entry.time);
    if (!date) return;
    const temp = Number(entry.data && entry.data.instant && entry.data.instant.details && entry.data.instant.details.air_temperature);
    if (!byDate.has(date)) byDate.set(date, { min: Infinity, max: -Infinity, noon: null, noonDiff: Infinity });
    const rec = byDate.get(date);
    if (Number.isFinite(temp)) { rec.min = Math.min(rec.min, temp); rec.max = Math.max(rec.max, temp); }
    const hour = Number((isoToClock(entry.time) || '00:00').slice(0, 2));
    const diff = Math.abs(hour - 12);
    if (diff < rec.noonDiff) { rec.noonDiff = diff; rec.noon = symbolOf(entry); }
  });
  const forecast = [...byDate.entries()].slice(0, WEATHER_FORECAST_MAX_DAYS).map(([date, rec]) => {
    const b = metnoBucket(rec.noon);
    const sun = computeSunTimes(ctx.lat, ctx.lon, date);
    return {
      date,
      code: WEATHER_BUCKET_CODE[b],
      minC: Number.isFinite(rec.min) ? Math.round(rec.min) : null,
      maxC: Number.isFinite(rec.max) ? Math.round(rec.max) : null,
      avgC: null, uv: null, sunHour: null, sunrise: sun.sunrise, sunset: sun.sunset, moonPhase: '',
      condition: weatherBucketLabel(b, ctx.lang),
    };
  });

  const windKph = Number.isFinite(Number(inst.wind_speed)) ? Math.round(Number(inst.wind_speed) * 3.6) : null;
  const humidity = round(inst.relative_humidity);
  const tempC = round(inst.air_temperature);
  const todaySun = computeSunTimes(ctx.lat, ctx.lon, isoDatePart(first.time));
  return {
    ok: true,
    code: WEATHER_BUCKET_CODE[curBucket],
    tempC,
    feelsC: computeFeelsLike(tempC, windKph, humidity),
    humidity,
    windKph,
    windDir: degToCompass(inst.wind_from_direction),
    pressure: round(inst.air_pressure_at_sea_level),
    visibility: null,
    uv: null,
    cloudCover: round(inst.cloud_area_fraction),
    precipMM: precipOf(first),
    condition: weatherBucketLabel(curBucket, ctx.lang),
    location: ctx.location || '',
    region: ctx.region || '',
    country: ctx.country || '',
    lat: ctx.lat, lon: ctx.lon,
    sunrise: todaySun.sunrise, sunset: todaySun.sunset,
    hourly,
    forecast,
    updatedAt: Date.now(),
    aqi: null, pm25: null, pm10: null, no2: null, pollen: null,
    source: 'metno',
  };
}

// Provider fetchers — each resolves to a normalized object or null (never throws),
// so getWeather() can fall through to the next source.
async function fetchWttrWeather(ctx) {
  try {
    const raw = await fetchJson(`https://wttr.in${ctx.placePath}?format=j1&lang=${ctx.lang}`, 3500);
    const data = normalizeWeather(raw, ctx.lang);
    if (!data.ok) return null;
    data.source = 'wttr';
    return data;
  } catch { return null; }
}
async function fetchOpenMeteoWeather(ctx) {
  if (!Number.isFinite(ctx.lat) || !Number.isFinite(ctx.lon)) return null;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${ctx.lat}&longitude=${ctx.lon}`
      + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,precipitation,visibility,uv_index'
      + '&hourly=temperature_2m,weather_code,precipitation_probability,wind_speed_10m'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max'
      + `&timezone=auto&forecast_days=${WEATHER_FORECAST_MAX_DAYS}`;
    const raw = await fetchJson(url, 3500);
    return normalizeOpenMeteo(raw, ctx);
  } catch { return null; }
}
async function fetchMetnoWeather(ctx) {
  if (!Number.isFinite(ctx.lat) || !Number.isFinite(ctx.lon)) return null;
  try {
    const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${ctx.lat.toFixed(4)}&lon=${ctx.lon.toFixed(4)}`;
    const raw = await fetchJson(url, 3500, METNO_HEADERS);
    return normalizeMetno(raw, ctx);
  } catch { return null; }
}

const WEATHER_FETCHERS = {
  'open-meteo': fetchOpenMeteoWeather,
  'metno': fetchMetnoWeather,
  'wttr': fetchWttrWeather,
};
// Provider attempt order for a given preference. A specific choice is tried
// first, then the others as fallbacks, so a single source's outage never blanks
// the widget. wttr sits last in 'auto' (least reliable) but is the only one that
// works without coordinates, covering the case where IP geolocation fails.
function weatherProviderOrder(pref) {
  const base = ['open-meteo', 'metno', 'wttr'];
  if (pref && pref !== 'auto' && base.includes(pref)) {
    return [pref, ...base.filter(p => p !== pref)];
  }
  return base;
}

// Newest cached forecast for a location regardless of UI language. The cache key
// is `lang|provider|mode|city`, so a language change misses the per-lang slot and,
// if the providers are momentarily unavailable (e.g. rate-limited by rapid
// switching), the widget would blank to "no data" (#88). Bridging to the last
// known conditions for the same place — served stale, no extra provider request —
// keeps the tile populated until the correct-language fetch succeeds.
function newestWeatherForLocation(provider, mode, city) {
  const suffix = `|${provider}|${mode}|${String(city).toLowerCase()}`;
  let best = null;
  for (const [key, entry] of weatherCache) {
    if (!key.endsWith(suffix)) continue;
    if (!best || entry.updatedAt > best.updatedAt) best = entry;
  }
  return best ? best.data : null;
}

async function getWeather(lang = 'en', requestedLocation = null) {
  // Unsupported/missing language falls back to English (neutral), never to a
  // specific locale — a client on a language the server doesn't know must not
  // get Italian conditions on an otherwise-translated UI (#72).
  const safeLang = WEATHER_LANGS.has(lang) ? lang : 'en';
  const settings = await readHubSettings().catch(() => null);
  const hasRequestLocation = requestedLocation && (requestedLocation.mode !== undefined || requestedLocation.city !== undefined);
  const location = resolveWeatherLocation(hasRequestLocation ? requestedLocation : settings && settings.weather);
  const provider = settings && settings.weather && WEATHER_PROVIDERS.has(settings.weather.provider)
    ? settings.weather.provider : 'auto';
  const cacheKey = `${safeLang}|${provider}|${location.mode}|${location.city.toLowerCase()}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && (Date.now() - cached.updatedAt) < WEATHER_FORECAST_CACHE_MS) return cached.data;
  const pending = weatherPending.get(cacheKey);
  if (pending) return pending;

  const promise = (async () => {
    // Build the location context. Coordinate-based providers (open-meteo, metno)
    // need lat/lon: from geocoding in manual mode, from IP geolocation in auto.
    const ctx = { lang: safeLang, mode: location.mode, city: location.city, lat: NaN, lon: NaN, placePath: '', location: '', region: '', country: '' };
    if (location.mode === 'manual') {
      const manualPlace = await resolveManualWeatherPlace(location.city, safeLang);
      ctx.placePath = manualPlace.placePath;
      if (Number.isFinite(manualPlace.lat) && Number.isFinite(manualPlace.lon)) { ctx.lat = manualPlace.lat; ctx.lon = manualPlace.lon; }
      if (manualPlace.resolvedCity) {
        const d = splitWeatherDisplayLocation(manualPlace.resolvedCity);
        ctx.location = d.location || ''; ctx.region = d.region || ''; ctx.country = d.country || '';
      }
    } else {
      const auto = await resolveAutoLocation();
      if (auto) { ctx.lat = auto.lat; ctx.lon = auto.lon; ctx.location = auto.location; ctx.region = auto.region; ctx.country = auto.country; }
    }

    // Try providers in order; the first that answers wins. A single source being
    // down or coordinate-less never blanks the widget.
    let data = null;
    for (const name of weatherProviderOrder(provider)) {
      data = await WEATHER_FETCHERS[name](ctx);
      if (data && data.ok) break;
    }
    if (!data || !data.ok) {
      // Prefer the exact-language snapshot; otherwise bridge to the newest
      // cached forecast for this place in any language, so a language change
      // never blanks the tile while the providers recover (#88).
      const bridge = cached ? cached.data : newestWeatherForLocation(provider, location.mode, location.city);
      if (bridge) return { ...bridge, stale: true };
      throw new Error('Weather unavailable from all providers');
    }

    data.locationMode = location.mode;
    data.requestedCity = location.city;
    // A resolved display name (geocode in manual, IP-geo in auto) wins over a
    // provider's own — and is the only name coordinate providers have.
    if (ctx.location) data.location = ctx.location;
    if (ctx.region) data.region = ctx.region;
    if (ctx.country) data.country = ctx.country;

    // Air quality is a shared post-step for every provider (needs coordinates).
    if (Number.isFinite(Number(data.lat)) && Number.isFinite(Number(data.lon))) {
      try {
        const aqiRaw = await fetchJson(
          `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${data.lat}&longitude=${data.lon}&current=european_aqi,pm2_5,pm10,nitrogen_dioxide,grass_pollen,birch_pollen,alder_pollen,ragweed_pollen,mugwort_pollen,olive_pollen`,
          4000
        );
        const cur = aqiRaw && aqiRaw.current || {};
        data.aqi  = Number.isFinite(Number(cur.european_aqi))     ? Math.round(Number(cur.european_aqi))           : null;
        data.pm25 = Number.isFinite(Number(cur.pm2_5))            ? Math.round(Number(cur.pm2_5) * 10) / 10        : null;
        data.pm10 = Number.isFinite(Number(cur.pm10))             ? Math.round(Number(cur.pm10))                   : null;
        data.no2  = Number.isFinite(Number(cur.nitrogen_dioxide)) ? Math.round(Number(cur.nitrogen_dioxide) * 10) / 10 : null;
        // Pollen (grains/m³) is Europe-only; surface the highest active type as a
        // single glanceable value (null outside coverage → the tile hides it).
        const pollenTypes = ['grass_pollen', 'birch_pollen', 'alder_pollen', 'ragweed_pollen', 'mugwort_pollen', 'olive_pollen'];
        const pollenVals = pollenTypes.map((k) => Number(cur[k])).filter((n) => Number.isFinite(n));
        data.pollen = pollenVals.length ? Math.round(Math.max(...pollenVals)) : null;
      } catch { }
    }
    weatherCache.set(cacheKey, { data, updatedAt: Date.now() });
    if (weatherCache.size > WEATHER_CACHE_MAX_ENTRIES) {
      weatherCache.delete(weatherCache.keys().next().value); // oldest insert
    }
    return data;
  })()
    .finally(() => { weatherPending.delete(cacheKey); });

  weatherPending.set(cacheKey, promise);
  return promise;
}

function splitMediaTitle(rawTitle, appName) {
  const title = (rawTitle || '').trim();
  if (!title) return { title: '', artist: '' };
  if (/spotify/i.test(appName) && title.includes(' - ')) {
    const parts = title.split(' - ');
    if (parts.length >= 2) {
      return { artist: parts.shift().trim(), title: parts.join(' - ').trim() };
    }
  }
  return { title, artist: '' };
}

function displayAppName(name) {
  if (/spotify/i.test(name || '')) return 'Spotify';
  if (/chrome|edge|firefox|brave|opera|youtube/i.test(name || '')) return 'YouTube';
  if (/zunemusic|zunevideo|microsoftmediaplayer|windowsmediaplayer/i.test(name || '')) return 'Lettore Multimediale';
  if (!name) return 'Media';
  // Strip Windows package format: Publisher.Name_hash!AppId → Name
  const pkg = (name || '').match(/^(?:[^.]+\.)+([^._!]+)[_!]/);
  if (pkg) return pkg[1];
  return name;
}

function liveMediaSnapshot(data, ageMs) {
  if (!data) return data;
  const snapshot = { ...data };
  if (snapshot.playbackStatus === 'Playing' && snapshot.duration) {
    const position = Number(snapshot.position) || 0;
    const duration = Number(snapshot.duration) || 0;
    snapshot.position = Math.min(duration, position + Math.floor(ageMs / 1000));
  }
  return snapshot;
}

function getCpuUsage() {
  return cachedCpuUsage;
}

function getCpuName() {
  try {
    const cpus = os.cpus();
    if (cpus && cpus.length && cpus[0].model) {
      return cpus[0].model.replace(/\s+/g, ' ').replace(/\(R\)|\(TM\)|CPU\s+@.*$/g, '').trim();
    }
  } catch { }
  return null;
}

async function getCpuTemp() {
  const age = Date.now() - cpuTempCache.updatedAt;
  if (age < 5000) return cpuTempCache.cpuTemp;
  if (cpuTempPending) return cpuTempPending;

  cpuTempPending = (async () => {
    try {
      const data = linuxCollectors ? linuxCollectors.cpuTemp() : await runCollector(CPU_TEMP_SCRIPT, [], 10000);
      // Windows PowerShell 5.1 can unwrap a single-element array on serialize.
      let fans = data.fans;
      if (fans && !Array.isArray(fans)) fans = [fans];
      cpuTempCache = {
        cpuTemp: data.cpuTemp === null || data.cpuTemp === undefined ? null : Number(data.cpuTemp),
        fans: (Array.isArray(fans) ? fans : [])
          .filter(f => f && typeof f === 'object' && collectorNum(f.rpm) !== null)
          // `kind` says where the fan physically is ('psu' = the PSU's own fan,
          // 'ctrl' = an AIO/fan-hub controller); anything the collector doesn't
          // vouch for falls back to a motherboard header.
          .map(f => ({
            name: String(f.name || 'Fan').slice(0, 48),
            rpm: Math.round(collectorNum(f.rpm)),
            kind: f.kind === 'psu' || f.kind === 'ctrl' ? f.kind : 'mb',
          })),
        cpuWatts: collectorNum(data.cpuWatts),
        psuWatts: collectorNum(data.psuWatts),
        sensorAccess: SENSOR_ACCESS.has(data.sensorAccess) ? data.sensorAccess : null,
        updatedAt: Date.now(),
      };
    } catch {
      cpuTempCache.updatedAt = Date.now();
    }
    cpuTempPending = null;
    return cpuTempCache.cpuTemp;
  })();

  return cpuTempPending;
}

async function getGpuInfo() {
  const age = Date.now() - gpuCache.updatedAt;
  if (age < 5000) return gpuCache;
  if (gpuPending) return gpuPending;
  gpuPending = (async () => {
  try {
    const data = linuxCollectors ? await linuxCollectors.gpu() : await runCollector(GPU_SCRIPT, [], 12000);
    gpuCache = {
      gpu: data.gpu === null || data.gpu === undefined ? gpuCache.gpu : data.gpu,
      gpuName: data.gpuName || gpuCache.gpuName || null,
      gpuTemp: (data.gpuTemp === null || data.gpuTemp === undefined) ? gpuCache.gpuTemp : data.gpuTemp,
      vramUsed: (data.vramUsed === null || data.vramUsed === undefined) ? gpuCache.vramUsed : data.vramUsed,
      vramTotal: (data.vramTotal === null || data.vramTotal === undefined) ? gpuCache.vramTotal : data.vramTotal,
      gpuWatts: collectorNum(data.gpuWatts) ?? gpuCache.gpuWatts,
      gpuFanRpm: collectorNum(data.gpuFanRpm) === null ? gpuCache.gpuFanRpm : Math.round(collectorNum(data.gpuFanRpm)),
      gpuFanPct: collectorNum(data.gpuFanPct) === null ? gpuCache.gpuFanPct : Math.round(collectorNum(data.gpuFanPct)),
      // Per-fan RPM straight from the card's tachometers. `null` means the read
      // carried no answer at all (keep the last list); an empty array means the
      // card reported no fans (drop it) — see normalizeGpuFans.
      gpuFans: normalizeGpuFans(data.gpuFans) ?? gpuCache.gpuFans,
      updatedAt: Date.now(),
    };
  } catch {
    gpuCache.updatedAt = Date.now();
  }
  gpuPending = null;
  return gpuCache;
  })();
  return gpuPending;
}

// Labels/filesystem/type only — free space is read live via statfs on every
// cycle. Volumes change only on plug/unplug, so 10 minutes is plenty: at 60s
// this was the last recurring powershell.exe spawn left on an idle server.
const DISK_DETAILS_TTL_MS = 10 * 60 * 1000;
let diskDetailsCache = { data: null, updatedAt: 0 };
async function getDiskDetails() {
  if (diskDetailsCache.data && Date.now() - diskDetailsCache.updatedAt < DISK_DETAILS_TTL_MS) return diskDetailsCache.data;
  const command = `
    $ErrorActionPreference = 'Stop'
    try {
      $volumes = @(Get-Volume -ErrorAction Stop | Where-Object { $_.DriveLetter } | ForEach-Object {
        [pscustomobject]@{
          drive = ([string]$_.DriveLetter + ':')
          label = ([string]$_.FileSystemLabel).Trim()
          fileSystem = ([string]$_.FileSystem).Trim()
          driveType = ([string]$_.DriveType).Trim()
        }
      })
    } catch {
      $volumes = @(Get-CimInstance Win32_LogicalDisk -ErrorAction Stop | Where-Object { $_.DeviceID } | ForEach-Object {
        [pscustomobject]@{
          drive = ([string]$_.DeviceID).Trim()
          label = ([string]$_.VolumeName).Trim()
          fileSystem = ([string]$_.FileSystem).Trim()
          driveType = ([string]$_.Description).Trim()
        }
      })
    }
    [pscustomobject]@{ volumes = $volumes } | ConvertTo-Json -Depth 4 -Compress
  `;

  try {
    const data = await runPowerShellCommand(command, 5000);
    const map = {};
    const volumes = Array.isArray(data.volumes) ? data.volumes : (data.volumes ? [data.volumes] : []);
    volumes.forEach(volume => {
      if (volume && volume.drive) map[String(volume.drive).toUpperCase()] = volume;
    });
    diskDetailsCache = { data: map, updatedAt: Date.now() };
    return map;
  } catch {
    diskDetailsCache = { data: {}, updatedAt: Date.now() };
    return {};
  }
}

let _diskLettersCache = { letters: null, at: 0 };
const DISK_LETTERS_TTL = 60 * 1000;

async function getAllDisksInfo() {
  if (linuxCollectors) return linuxCollectors.disks();
  const drives = [];
  const details = await getDiskDetails();
  // Probing all 24 letters with statfs every cycle (~7s) is wasteful — valid
  // letters change rarely. Cache the set that resolved for 60s and probe only
  // those; a stale (or empty) cache triggers a full A–Z re-scan so a newly
  // mounted/removed drive still appears within a minute. Free-space is still
  // read live on each call — only the dead letters are skipped.
  const now = Date.now();
  const fresh = _diskLettersCache.letters && _diskLettersCache.letters.length &&
                (now - _diskLettersCache.at) < DISK_LETTERS_TTL;
  const letters = fresh ? _diskLettersCache.letters : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const valid = [];
  for (const letter of letters) {
    try {
      if (typeof fs.promises.statfs === 'function') {
        const s = await fs.promises.statfs(letter + ':\\');
        const total = Number(s.blocks) * Number(s.bsize);
        const free = Number(s.bfree) * Number(s.bsize);
        if (total > 0) {
          valid.push(letter);
          const drive = letter + ':';
          const detail = details[drive.toUpperCase()] || {};
          drives.push({
            drive,
            total,
            used: total - free,
            free,
            percent: Math.round(((total - free) / total) * 100),
            label: detail.label || '',
            fileSystem: detail.fileSystem || '',
            driveType: detail.driveType || '',
          });
        }
      }
    } catch { }
  }
  // Only refresh the cache after a full scan, and never store an empty result
  // (a transient failure must not pin us to "no drives" for 60s).
  if (!fresh && valid.length) _diskLettersCache = { letters: valid, at: now };
  return drives.length ? drives : null;
}

let ramInfoCache = null;
async function getRamInfo() {
  if (ramInfoCache) return ramInfoCache;
  const command = `
    $types = @{ 20='DDR'; 21='DDR2'; 22='DDR2 FB'; 24='DDR3'; 26='DDR4'; 34='DDR5' }
    $modules = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop | ForEach-Object {
      $smbios = 0
      try { $smbios = [int]$_.SMBIOSMemoryType } catch { }
      $type = $types[$smbios]
      $speed = 0
      if ($_.ConfiguredClockSpeed) { $speed = [int]$_.ConfiguredClockSpeed }
      elseif ($_.Speed) { $speed = [int]$_.Speed }
      [pscustomobject]@{
        type = $type
        speed = $speed
        capacity = [uint64]$_.Capacity
        manufacturer = ([string]$_.Manufacturer).Trim()
        partNumber = ([string]$_.PartNumber).Trim()
      }
    })
    if ($modules.Count -eq 0) {
      [pscustomobject]@{ ram = $null } | ConvertTo-Json -Depth 4 -Compress
      exit 0
    }
    $type = ($modules | Where-Object { $_.type } | Select-Object -First 1 -ExpandProperty type)
    $speed = ($modules | Measure-Object -Property speed -Maximum).Maximum
    $total = ($modules | Measure-Object -Property capacity -Sum).Sum
    $moduleCount = $modules.Count
    $moduleGb = if ($moduleCount -gt 0 -and $total) { [Math]::Round(($total / $moduleCount) / 1GB, 0) } else { 0 }
    $manufacturer = ($modules | Where-Object { $_.manufacturer -and $_.manufacturer -notmatch '^(Unknown|Undefined|Default|string|To Be Filled)' } | Select-Object -First 1 -ExpandProperty manufacturer)
    $partNumber = ($modules | Where-Object { $_.partNumber -and $_.partNumber -notmatch '^(Unknown|Undefined|Default|string|To Be Filled)' } | Select-Object -First 1 -ExpandProperty partNumber)
    $labelParts = @()
    if ($type) { $labelParts += $type }
    if ($speed) { $labelParts += (([int]$speed).ToString() + ' MHz') }
    $layout = if ($moduleCount -gt 0 -and $moduleGb -gt 0) { $moduleCount.ToString() + 'x' + $moduleGb.ToString() + ' GB' } else { $null }
    $detailParts = @()
    if ($labelParts.Count -gt 0) { $detailParts += ($labelParts -join ' ') }
    if ($layout) { $detailParts += $layout }
    $nameParts = @()
    if ($manufacturer) { $nameParts += $manufacturer }
    if ($partNumber) { $nameParts += $partNumber }
    [pscustomobject]@{
      ram = [pscustomobject]@{
        name = ($labelParts -join ' ')
        detail = ($detailParts -join ' - ')
        moduleName = ($nameParts -join ' ')
        modules = $moduleCount
        speed = $speed
        type = $type
      }
    } | ConvertTo-Json -Depth 4 -Compress
  `;

  try {
    const data = await runPowerShellCommand(command, 5000);
    ramInfoCache = data.ram || null;
  } catch {
    ramInfoCache = null;
  }
  return ramInfoCache;
}

async function getSystemInfo() {
  const [gpu, disks, ramInfo, cpuTemp] = await Promise.all([getGpuInfo(), getAllDisksInfo(), getRamInfo(), getCpuTemp()]);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // Fans: motherboard/CPU headers from the cpu collector (RPM), plus the GPU's
  // own fans — LHM gives RPM, nvidia-smi only a percent, so a fan entry carries
  // either `rpm` or `pct` and the client renders unit-aware.
  // `kind` is the typed discriminator clients key on ('mb' = a motherboard fan
  // header, 'psu' = the power supply's own fan, 'gpu' = on the graphics card) —
  // `name` is pure presentation, so a motherboard header literally named "GPU"
  // must never match.
  //
  // Only fans wired to a motherboard header report a tachometer here: fans on an
  // AIO pump, a Corsair Commander or any fan hub are invisible to the board, and
  // fans daisy-chained onto one header report as a single reading. The list is
  // therefore "what the hardware exposes", never "every fan in the case".
  const fans = cpuTempCache.fans.map(f => ({ ...f }));
  // Prefer each fan's real tachometer over nvidia-smi's fan.speed, which is the
  // curve's TARGET: an idle card in zero-RPM mode reports a percent while the
  // fans are stopped. The percent stays the fallback for cards LHM can't read.
  if (Array.isArray(gpu.gpuFans) && gpu.gpuFans.length) {
    gpu.gpuFans.forEach(f => fans.push({ name: f.name, kind: 'gpu', rpm: f.rpm }));
  } else if (gpu.gpuFanRpm !== null && gpu.gpuFanRpm !== undefined) fans.push({ name: 'GPU', kind: 'gpu', rpm: gpu.gpuFanRpm });
  else if (gpu.gpuFanPct !== null && gpu.gpuFanPct !== undefined) fans.push({ name: 'GPU', kind: 'gpu', pct: gpu.gpuFanPct });

  // Power draw in watts. `total` is strictly CPU+GPU (labelled as such client-
  // side — never a whole-system estimate); `psu` appears only when a digital
  // PSU (Corsair HXi/RMi & co.) is visible to LHM.
  const cpuWatts = cpuTempCache.cpuWatts;
  const gpuWatts = gpu.gpuWatts === undefined ? null : gpu.gpuWatts;
  const power = {
    cpu: cpuWatts,
    gpu: gpuWatts,
    psu: cpuTempCache.psuWatts,
    total: (cpuWatts !== null && gpuWatts !== null) ? Math.round((cpuWatts + gpuWatts) * 10) / 10 : null,
  };

  return {
    now: new Date().toISOString(),
    hostname: os.hostname(),
    uptime: Math.round(os.uptime()),
    cpu: getCpuUsage(),
    cpuTemp,
    cpuName: getCpuName(),
    // Why the LHM-backed readings (cpuTemp, `fans`, power.cpu/psu) may be empty:
    // 'ok' | 'needs_admin' (LHM installed but unelevated → no kernel driver) |
    // 'missing'. Lets the widgets name the actual fix instead of guessing.
    sensorAccess: cpuTempCache.sensorAccess,
    memory: {
      used: usedMem,
      total: totalMem,
      percent: Math.round((usedMem / totalMem) * 100),
    },
    ramName: ramInfo && ramInfo.name ? ramInfo.name : null,
    ramDetail: ramInfo,
    gpu: gpu.gpu,
    gpuName: gpu.gpuName,
    gpuTemp: gpu.gpuTemp,
    vramUsed: gpu.vramUsed,
    vramTotal: gpu.vramTotal,
    fans,
    power,
    disks,
  };
}

// --- Network info: bandwidth requires a delta between two readings ---
let _netPrev = null; // { rx, tx, t }
let _netPending = null;
async function getNetworkInfo() {
  // In-flight dedup: with two dashboards open the 3s polls interleave, and two
  // concurrent runs would both rewrite _netPrev — corrupting the bandwidth
  // delta — while doubling the collector work. Latecomers share the result.
  if (_netPending) return _netPending;
  _netPending = _getNetworkInfoRaw().finally(() => { _netPending = null; });
  return _netPending;
}
async function _getNetworkInfoRaw() {
  // PresentMon's FPS wins anyway when it is available, so tell the collector to
  // skip its own FPS sampling — the DWM fallback sleeps 600ms inside the serial
  // worker, delaying every other queued sensor read.
  let skipFps = false;
  try { skipFps = fpsMonitor.isAvailable(); } catch { skipFps = false; }
  const data = linuxCollectors ? await linuxCollectors.network() : await runCollector(NETWORK_SCRIPT, skipFps ? ['-SkipFps'] : [], 8000);
  const now = Date.now();
  const rx = Number(data.rxBytes) || 0;
  const tx = Number(data.txBytes) || 0;

  let downBps = null, upBps = null;
  if (_netPrev && now > _netPrev.t) {
    const dt = (now - _netPrev.t) / 1000; // seconds
    const dRx = rx - _netPrev.rx;
    const dTx = tx - _netPrev.tx;
    if (dt > 0 && dRx >= 0 && dTx >= 0) {
      downBps = Math.round(dRx / dt);
      upBps   = Math.round(dTx / dt);
    }
  }
  _netPrev = { rx, tx, t: now };

  // Prefer PresentMon's real in-game FPS (works in exclusive fullscreen);
  // fall back to the PowerShell DWM/LHM reading when it isn't available.
  let fps = null;
  try { fps = fpsMonitor.getCurrentFps(); } catch { fps = null; }
  if (fps == null) fps = data.fps ?? null;

  return {
    ping: data.ping ?? null,
    latency: data.latency ?? null,
    fps,
    gpuLatency: data.gpuLatency ?? null,
    downloadBps: downBps,
    uploadBps: upBps,
  };
}

// Sticky per-track album art. SMTC — browser/YouTube sessions especially —
// often reports a track's metadata a beat before (or, after an idle/reconnect,
// briefly without) its artwork stream. The client backfills a missing cover
// from its own `_lastThumb`, but a client that connects in that window (a
// reload, an iCUE restart mid-playback, a second surface) has an empty
// `_lastThumb` and shows the "no media" placeholder even though the cover was
// available seconds earlier. Remember the last non-empty thumbnail keyed by
// track and backfill it whenever a later read of the SAME track comes back
// without one, so every consumer (SSE connect-seed, GET /media, the 2s
// broadcast, lockscreen, mini-player, deck, SDK relay) keeps the art through a
// transient null read or a reconnect. Keyed by track, so a genuine track change
// (new key) never inherits the previous cover — it clears to the placeholder
// until the new track's artwork arrives, exactly like the client's `_lastThumb`.
let _lastGoodThumb = { title: '', artist: '', album: '', value: '' };
// Is this read plausibly the SAME track as the remembered one? A single naive
// key would force a choice between two failure modes, because SMTC routinely
// drops the artist (and/or album) on a transient read while keeping the title —
// so the very read we want to backfill looks like `title|''`:
//   • key on title+artist+album → the transient drop changes the key → no
//     backfill exactly when the cover flickers (the bug we're fixing);
//   • key on title alone → two different untagged tracks that share a title
//     collide and inherit each other's cover.
// So match tolerantly: the title must match, and each of artist/album must
// either match or be ABSENT on the incoming read (an empty field carries no new
// info — treat it as "unchanged", not "different"). A DIFFERING non-empty
// artist or album is a real other track and blocks the backfill, so covers never
// bleed between two songs that merely share a title AND carry any distinguishing
// tag. The one irreducible case — two fully-untagged tracks with byte-identical
// titles back to back — is indistinguishable from a single read; we favour the
// common flicker fix over that rare collision.
function _sameStickyTrack(data, ref) {
  const title = (data && data.title) || '';
  if (!title || title !== ref.title) return false;
  const artist = (data && data.artist) || '';
  const album = (data && data.album) || '';
  if (artist && ref.artist && artist !== ref.artist) return false;
  if (album && ref.album && album !== ref.album) return false;
  return true;
}
function applyStickyThumb(data) {
  if (!data || !data.active) return data;
  const title = (data && data.title) || '';
  if (!title) return data; // no reliable track identity → don't stick
  if (data.thumbnail) {
    _lastGoodThumb = { title, artist: data.artist || '', album: data.album || '', value: data.thumbnail };
  } else if (_lastGoodThumb.value && _sameStickyTrack(data, _lastGoodThumb)) {
    data.thumbnail = _lastGoodThumb.value;
  }
  return data;
}

async function getMediaInfo(force = false) {
  const age = Date.now() - mediaCache.updatedAt;
  if (!force && mediaCache.data && age < MEDIA_CACHE_MS) return liveMediaSnapshot(mediaCache.data, age);
  if (mediaPending) return mediaPending;
  mediaPending = (async () => {
  try {
    const data = await runMediaRequest('info', 12000);
    const hydrated = applyStickyThumb(await hydrateArtwork(data));
    mediaCache = { data: hydrated, updatedAt: Date.now() };
    mediaPending = null;
    return hydrated;
  } catch (e) {
    if (mediaCache.data) {
      mediaPending = null;
      return mediaCache.data;
    }
    const fallback = applyStickyThumb(await hydrateArtwork(await getMediaFallback(e.message)));
    mediaCache = { data: fallback, updatedAt: Date.now() };
    mediaPending = null;
    return fallback;
  }
  })();
  return mediaPending;
}

// The album-art thumbnail is a ~50-100KB base64 data URI. Re-sending it on every
// 2s 'media' broadcast is pure waste once the client holds it: the client caches
// the last thumbnail per track (media.js `_lastThumb`) and reuses it whenever a
// payload omits one for the same track. So strip the thumbnail from BROADCASTS
// while the track is unchanged — the SSE connect-seed and GET /media still carry
// it in full so a fresh or reconnecting client always gets the art. The key
// mirrors the client's `trackKey` so we re-send whenever the client would clear.
let _lastBroadcastThumbKey = null;
function mediaForBroadcast(info) {
  if (!info) return info;
  if (!info.thumbnail) {
    if (!info.active) _lastBroadcastThumbKey = null; // reset so the next track re-sends
    return info;
  }
  const key = `${info.title || ''}|${info.artist || info.album || ''}`;
  if (key === _lastBroadcastThumbKey) {
    const { thumbnail, ...rest } = info;             // same track → drop the heavy payload
    return rest;
  }
  _lastBroadcastThumbKey = key;
  return info;
}

function getMediaFallback(error) {
  return new Promise(resolve => {
    readSoundVolumeRows().then(rows => {
        try {
          const app = rows.find(f =>
            f[F.TYPE] === 'Application' &&
            f[F.DIR] === 'Render' &&
            f[F.STATE] === 'Active' &&
            f[F.NAME] &&
            !/windows|system sounds|operating system/i.test(`${f[F.NAME]} ${f[F.WINDOW_TITLE] || ''}`) &&
            (f[F.WINDOW_TITLE] || /spotify|chrome|edge|firefox|browser|youtube/i.test(f[F.NAME]))
          );

          if (!app) {
            resolve({ active: false, app: '', source: '', title: '', artist: '', album: '', playbackStatus: 'Unavailable', thumbnail: null, position: 0, duration: 0, error });
            return;
          }

          const appName = displayAppName(app[F.NAME]);
          const rawTitle = app[F.WINDOW_TITLE] || app[F.NAME] || 'Media attivo';
          const split = splitMediaTitle(rawTitle, appName);

          resolve({
            active: true,
            app: appName,
            source: appName,
            title: split.title || rawTitle,
            artist: split.artist || '',
            album: '',
            playbackStatus: 'Unknown',
            thumbnail: null,
            position: 0,
            duration: 0,
            fallback: true,
            error,
          });
        } catch {
          resolve({ active: false, app: '', source: '', title: '', artist: '', album: '', playbackStatus: 'Unavailable', thumbnail: null, position: 0, duration: 0, error });
        }
      }).catch(() => {
        resolve({ active: false, app: '', source: '', title: '', artist: '', album: '', playbackStatus: 'Unavailable', thumbnail: null, position: 0, duration: 0, error });
      });
    });
}

async function mediaAction(action) {
  const data = await runMediaRequest(action, 5000);
  mediaCache.updatedAt = 0;
  return data;
}

function parseCsvLine(line) {
  const fields = [];
  let cur = '', inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { fields.push(cur); cur = ''; }
    else { cur += ch; }
  }
  fields.push(cur);
  return fields;
}

async function _getAudioInfoRaw() {
  const allRows = await readSoundVolumeRows();

  // ── Device-level (master) ────────────────────────────────────
  const deviceRows = allRows.filter(f => f[F.TYPE] === 'Device' && f[F.STATE] === 'Active');
  const speakers   = deviceRows.filter(f => f[F.DIR] === 'Render');
  const mics       = deviceRows.filter(f => f[F.DIR] === 'Capture');

  const defSpk = speakers.find(f => f[F.DEFAULT] === 'Render') || speakers[0];
  const defMic = mics.find(f => f[F.DEFAULT] === 'Capture')    || mics[0];

  if (defSpk) { cachedSpeakerId = defSpk[F.CLI_ID]; cachedSpeakerName = defSpk[F.NAME]; _lastSpeakerVolume = parseInt(defSpk[F.VOL_PCT]) || _lastSpeakerVolume; }
  if (defMic) { cachedMicId = defMic[F.CLI_ID]; cachedMicLabel = defMic[F.NAME]; _maybeRebindSttDevice(); }

  const toDevice = (f, isDefault) => ({
    name:      f[F.DEVICE_NAME],
    label:     f[F.NAME],
    id:        f[F.CLI_ID],
    isDefault,
    volume:    parseInt(f[F.VOL_PCT]) || 0,
    muted:     f[F.MUTED] === 'Yes',
  });

  // ── Application-level sessions ───────────────────────────────
  // Show only sessions that are currently Active — this mirrors the Windows 11
  // Volume Mixer, which lists an app while it actually holds an audio stream and
  // drops it otherwise. Keeping Inactive sessions surfaced apps that Windows
  // hides (e.g. RtkUWP, Explorer), so we filter them out here. Requiring a real
  // exe path also excludes the "System Sounds" pseudo-sessions (empty Process
  // Path). Dedupe per process path (an app can open one session per tab/stream).
  // The exe basename (e.g. "spotify", "icue") is the most reliable label: the
  // client runs it through prettyAppName for friendly names, sidestepping bad
  // session metadata like "Qt6" that some apps report in the NAME column.
  const procName = f => ((f[F.PROC_PATH] || '').split('\\').pop() || '').replace(/\.exe$/i, '');

  // Browser processes whose audio-session window title reveals the actual site
  // (Twitch / YouTube / SoundCloud …). SMTC only reports the host browser, so we
  // forward this title — for browser sessions only — and the client resolves the
  // real source from it. Non-browser titles are never sent (keeps the payload
  // lean and avoids surfacing unrelated window titles).
  const BROWSER_PROC_RE = /^(?:chrome|msedge|firefox|brave|opera|vivaldi)$/i;

  const collectApps = dir => {
    const sessions = allRows.filter(f =>
      f[F.TYPE] === 'Application' &&
      f[F.DIR]  === dir &&
      f[F.PROC_PATH] &&
      f[F.STATE] === 'Active'
    );
    const byPath = new Map();
    for (const f of sessions) {
      const key = f[F.PROC_PATH].toLowerCase();
      const existing = byPath.get(key);
      // Prefer an Active session over an Inactive one for the visible row.
      if (!existing || (f[F.STATE] === 'Active' && existing[F.STATE] !== 'Active')) {
        byPath.set(key, f);
      }
    }
    return [...byPath.values()].map(f => {
      const proc = procName(f);
      return {
        name:   f[F.NAME] || f[F.WINDOW_TITLE] || proc || 'App',
        proc,
        id:     f[F.CLI_ID],
        path:   f[F.PROC_PATH],
        volume: parseInt(f[F.VOL_PCT]) || 0,
        muted:  f[F.MUTED] === 'Yes',
        icon:   null,
        win:    BROWSER_PROC_RE.test(proc) ? (f[F.WINDOW_TITLE] || '') : '',
      };
    });
  };

  const speakerApps = collectApps('Render');
  const micApps     = collectApps('Capture');

  // Resolve icons from the exe path (cached; only slow on first appearance).
  const allPaths = [...speakerApps, ...micApps].map(a => a.path);
  if (allPaths.length) {
    const icons = await resolveAppIcons(allPaths);
    let i = 0;
    speakerApps.forEach(a => { a.icon = icons[i++]; delete a.path; });
    micApps.forEach(a => { a.icon = icons[i++]; delete a.path; });
  }

  return {
    speaker:     defSpk ? toDevice(defSpk, true) : null,
    mic:         defMic ? toDevice(defMic, true)  : null,
    speakers:    speakers.map(f => toDevice(f, f === defSpk)),
    mics:        mics.map(f => toDevice(f, f === defMic)),
    speakerApps,
    micApps,
  };
}

async function getAudioInfo() {
  if (audioPending) return audioPending;
  const p = _getAudioInfoRaw();
  audioPending = p;
  try { return await p; } finally { if (audioPending === p) audioPending = null; }
}

function setMicMute(mute) {
  const action = mute ? '/Mute' : '/Unmute';
  // Use the cached mic CLI ID (resolved from SoundVolumeView output) so the call works
  // regardless of the Windows display language. Falls back silently if the cache is empty.
  if (cachedMicId) {
    execFile(SVV, [action, cachedMicId], err => { if (err) console.error(err.message); });
  } else if (cachedSpeakerName) {
    // Last-resort: try the generic 'DefaultCaptureDevice' selector understood by SVV
    execFile(SVV, [action, 'DefaultCaptureDevice'], err => { if (err) console.error(err.message); });
  }
}

// Promise wrapper around a single SoundVolumeView call.
function svvExec(args) {
  return new Promise((resolve, reject) => execFile(SVV, args, e => (e ? reject(e) : resolve())));
}

// Normalise a per-app audio target for SoundVolumeView: a bare process name with
// a .exe suffix (the durable identifier the Deck stores, vs. the volatile CLI id).
function appAudioTarget(app) {
  const base = String(app || '').split(/[\\/]/).pop().trim();
  return /\.exe$/i.test(base) ? base : base + '.exe';
}

// Lazy OBS WebSocket client — reads live settings on each new connection so
// changes in Settings take effect without a server restart.
const deckObs = createObs(async () => {
  const s = (await readHubSettings().catch(() => null)) || {};
  return { host: s.obsHost, port: s.obsPort, password: s.obsPassword };
});

// Lazy Streamer.bot WebSocket client — same on-demand/idle-close model as OBS, so
// a closed dashboard or an unconfigured streamer.bot keeps zero sockets open.
// Reads live settings on each new connection (no restart needed after Settings).
const deckSb = createStreamerbot(async () => {
  const s = (await readHubSettings().catch(() => null)) || {};
  return { host: s.streamerbotHost, port: s.streamerbotPort, password: s.streamerbotPassword };
});

// Lazy Home Assistant WebSocket client — same on-demand/idle-close/watch model as
// OBS. Holds ONE live socket only while the Smart Home tile is on screen AND HA is
// configured; reads the base URL + long-lived token from live settings on each
// connection, so saving them in Settings takes effect with no restart.
const deckHa = createHomeAssistant(async () => {
  const s = (await readHubSettings().catch(() => null)) || {};
  return { baseUrl: (s.homeAssistant && s.homeAssistant.url) || '', token: (s.homeAssistant && s.homeAssistant.token) || '' };
});

// Lazy UniFi Protect client — logs into the user's UniFi OS console on demand and
// pulls camera JPEG snapshots for the Cameras tile. No persistent socket: an
// unused/hidden tile pulls nothing, so it costs nothing. The console password is
// read fresh from live settings and never leaves the server (only the projected
// camera list + JPEG bytes reach the browser, via the loopback snapshot proxy).
const deckUnifi = createUnifiProtect(async () => {
  const s = (await readHubSettings().catch(() => null)) || {};
  const u = (s && s.unifi) || {};
  return { host: u.host || '', username: u.username || '', password: u.password || '' };
});

// UniFi Protect realtime-events client. UNLIKE the snapshot pulls above, this holds
// ONE live WebSocket to the console's updates stream — but only while a Cameras tile
// is on screen (SSE clients > 0) AND the user turned notifications on. It reuses
// deckUnifi's authenticated session (password stays server-side) and surfaces
// smart-detections (person/vehicle/…), motion and doorbell rings as `unifi_event`.
const deckUnifiEvents = createUnifiEvents(deckUnifi);

// Lazy Razer Chroma client — opens the local Chroma SDK session on demand, holds
// it with a heartbeat ONLY while lighting is active, and uninitializes after idle
// (Synapse then resumes the user's own lighting). One session serves both the
// direct Deck/SDK actions AND the ambient `chroma` lighting-provider. Enabled via
// Settings → chroma.enabled (opt-in, so it never probes localhost otherwise).
const deckChroma = createChroma();
// Lazy Elgato Wave Link client — scans ws://127.0.0.1:1824..1834 on demand, mirrors
// mixer state while a tile/Deck key is on screen (SSE `wavelink`), idle-closes
// otherwise. Reads enabled/port from live settings each connection (no restart).
const deckWaveLink = createWaveLink(async () => {
  const s = (await readHubSettings().catch(() => null)) || {};
  const wl = (s && s.wavelink) || {};
  return { enabled: wl.enabled === true, port: wl.port };
});

// Embedded-browser host for the "Browser" dashboard widget. Launches ONE headless
// Edge on demand (when a tile opens) and kills it when the last tile closes, so an
// unused widget costs nothing. Frames/input are relayed over a loopback WebSocket
// (see the /embedded-browser/ws upgrade handler near the bottom of this file).
const embeddedBrowser = createEmbeddedBrowser({
  dataDir: DATA_DIR,
  // Opt-in ad-blocker: load the unpacked uBOL extension only when the user enabled
  // it AND it is installed. Read fresh at each Edge launch, so toggling the setting
  // (which tears Edge down — see POST /settings) takes effect on the next open.
  getExtensionDirs: () => {
    try {
      if (_serverHubSettings && _serverHubSettings.browserAdblock === true) {
        const ext = browserAdblock.extensionDir(DATA_DIR);
        if (ext) return [ext];
      }
    } catch (e) { /* never block the browser on an extension-resolver fault */ }
    return [];
  },
});
// Cross-surface Browser-widget coordination: keep two dashboard surfaces (desktop
// browser + XENON) in step after a login, since they drive independent headless
// pages over one shared cookie jar (see browser-surface-sync.js / GitHub #96).
const browserSync = createBrowserSurfaceSync();
// Second-screen prerequisite check + one-click VDD install (UI not wired yet).
const secondScreen = createSecondScreen();
// Second-screen capture host: spawns the Xenon Helper `screen-serve` mode on
// demand and relays its JPEG frames over the /second-screen/ws loopback socket.
const screenCapture = createScreenCapture({ helperExe: HELPER_EXE });

// Apply a resolution to the virtual display. Fast path: commit the advertised mode
// live via the helper (no UAC, no device churn) — this is what actually makes the
// chosen resolution stick (a new VDD monitor sits at a stale 800x600 default until
// a mode is committed). Fallback: if the mode isn't advertised yet (display missing
// or created by an older single-mode config), (re)create it with the full preset
// config — which is elevated but idempotent (remove-then-install one, never spam) —
// then commit again.
async function applySecondScreenMode(mode, opts) {
  const soft = !!(opts && opts.soft);
  let width = mode && mode.width;
  let height = mode && mode.height;
  // Soft auto-restore (the tile re-asserting the saved resolution on every load):
  // trust the *persisted* resolution from settings.json, not the client-sent one.
  // On a fresh page load the tile may fire this before its hubSettings is populated
  // and would otherwise send the 1080p default — silently clobbering the user's
  // saved mode, which is exactly the "I have to re-apply every time" bug. The server
  // always has the authoritative saved value, so resolve it here.
  if (soft) {
    try {
      const s = await readHubSettings();
      const ss = s && s.secondScreen;
      if (ss && ss.width > 0 && ss.height > 0) { width = ss.width; height = ss.height; }
    } catch (e) { /* fall back to the client-sent mode */ }
  }
  const m = { monitor: 'virtual', width, height };
  if (!(m.width > 0 && m.height > 0)) return { ok: false, code: 'bad_args' };

  try {
    const r = await screenCapture.setMode(m);
    if (r && r.ok) return { ok: true, code: 'mode_applied', width: r.width, height: r.height };
  } catch (e) { /* fall through to (re)create */ }

  // Silent auto-restore path (tile re-asserting the saved resolution on load): never
  // fall back to the elevated device (re)create — a UAC prompt on every restart is
  // exactly what we're avoiding. The user can re-apply manually from Settings.
  if (soft) return { ok: false, code: 'needs_apply' };

  const created = await secondScreen.createDisplay(mode);
  if (!(created && created.ok)) return created;
  if (created.code === 'display_needs_reboot') return created;

  try {
    const r2 = await screenCapture.setMode(m);
    if (r2 && r2.ok) return { ok: true, code: 'mode_applied', width: r2.width, height: r2.height };
  } catch (e) { /* display exists; mode may settle after a reboot */ }
  return { ok: true, code: 'display_ready' };
}

// Live OBS state pushed to the dashboard while it's open and OBS is configured.
// The persistent OBS connection is held only when both are true, so a closed
// dashboard or an unconfigured OBS keeps zero sockets open.
let obsState = { obsRecording: false, obsStreaming: false, obsScene: '', obsMutes: {}, obsVolumes: {}, obsInputs: [] };
let obsStopWatch = null;
// Live thumbnail of the OBS program (on-air) scene, pushed on its own SSE event so
// the (larger) image never rides the frequent small `obs` state updates.
let obsPreview = { scene: '', image: '' };
let obsPreviewTimer = null;
// The OBS widget signals local-OBS intent by successfully probing /obs/scenes: a
// blank host still connects to 127.0.0.1, so a reachable LOCAL OBS should light up
// the live watch + preview WITHOUT the user having to type a host. Held true only
// while a dashboard is open (reset when the last SSE client leaves), so a non-OBS
// user — who never adds the widget and never hits /obs/scenes — keeps zero OBS
// sockets. An explicit `obsHost` in settings arms the watch on its own regardless.
let obsLocalWanted = false;

function applyObsPartial(partial) {
  if (!partial) return;
  const sceneChanged = ('obsScene' in partial) && partial.obsScene !== obsState.obsScene;
  if (partial.obsMutes) obsState.obsMutes = Object.assign({}, obsState.obsMutes, partial.obsMutes);
  if (partial.obsVolumes) obsState.obsVolumes = Object.assign({}, obsState.obsVolumes, partial.obsVolumes);
  if (Array.isArray(partial.obsInputs)) obsState.obsInputs = partial.obsInputs;
  for (const k of ['obsRecording', 'obsStreaming', 'obsScene']) if (k in partial) obsState[k] = partial[k];
  broadcastSSE('obs', obsState);
  if (sceneChanged && obsPreviewTimer) captureScenePreview(); // refresh the preview instantly on a scene switch
}

async function captureScenePreview() {
  const scene = obsState.obsScene;
  if (!scene) return;                         // no program scene yet
  try {
    const r = scenePreviewRequest(scene);
    const resp = await deckObs.request(r.requestType, r.requestData);
    if (resp && resp.imageData) {
      // Skip the rebroadcast when the frame is byte-identical to the last one — a
      // static program scene otherwise re-pushes the same base64 image every 5s.
      if (resp.imageData !== obsPreview.image || scene !== obsPreview.scene) {
        obsPreview = { scene, image: resp.imageData };
        broadcastSSE('obs_preview', obsPreview);
      }
    }
  } catch (e) { /* keep the last image on a failed/again-later capture */ }
}

async function refreshObsWatch() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const want = (!!s.obsHost || obsLocalWanted) && sseClients.size > 0;
  if (want && !obsStopWatch) {
    obsStopWatch = deckObs.watch(applyObsPartial);
    if (!obsPreviewTimer) obsPreviewTimer = setInterval(captureScenePreview, 5000);
    captureScenePreview();                    // one immediate capture so the thumbnail appears fast
  } else if (!want && obsStopWatch) {
    obsStopWatch(); obsStopWatch = null;
    if (obsPreviewTimer) { clearInterval(obsPreviewTimer); obsPreviewTimer = null; }
    obsState = { obsRecording: false, obsStreaming: false, obsScene: '', obsMutes: {}, obsVolumes: {}, obsInputs: [] };
    obsPreview = { scene: '', image: '' };
    broadcastSSE('obs', obsState);            // clear stale record/stream/scene indicators
    broadcastSSE('obs_preview', obsPreview);  // clear the client thumbnail
  }
}

// ── Home Assistant live state ────────────────────────────────────────────────
// A compact snapshot of the user's SELECTED entities is pushed to the Smart Home
// tile over the `homeassistant` SSE event. The persistent HA socket is held only
// while a dashboard is open (SSE clients > 0) AND HA is configured, so a closed
// dashboard or an unconfigured HA keeps zero sockets open. The token never leaves
// the server — only this projected state does.
let haStopWatch = null;
let haNotifyTimer = null;
// Entity ids Deck keys are bound to (haEntity state bindings / haLight sliders).
// Posted by each SURFACE (dashboard, Virtual Deck popup, second browser) after
// its deck renders — kept PER CLIENT and broadcast as the union, so a surface
// posting a narrower set (a popup showing one folder) can never clobber another
// surface's watch list. Bounded + TTL-pruned; the shared HA watch already
// receives every state_changed, so this only widens what gets BROADCAST.
const _haDeckWatchClients = new Map();   // clientId → { ids, at }
const HA_DECK_WATCH_MAX = 32;
const HA_DECK_WATCH_CLIENTS_MAX = 8;
const HA_DECK_WATCH_TTL_MS = 15 * 60 * 1000;   // a vanished surface stops mattering
const HA_ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;

function haDeckWatchUnion() {
  const now = Date.now();
  const ids = new Set();
  for (const [client, entry] of _haDeckWatchClients) {
    if (now - entry.at > HA_DECK_WATCH_TTL_MS) { _haDeckWatchClients.delete(client); continue; }
    for (const id of entry.ids) {
      if (ids.size >= HA_DECK_WATCH_MAX) break;
      ids.add(id);
    }
  }
  return Array.from(ids);
}

// Compact { id: { state, brightness? } } map for the deck-bound entities.
function buildHaDeckStates() {
  const states = {};
  for (const ent of deckHa.snapshot(haDeckWatchUnion())) {
    const item = { state: ent.state };
    if (typeof ent.brightness === 'number') item.brightness = ent.brightness;
    states[ent.id] = item;
  }
  return { states };
}

// Build the payload for the selected entities (from settings) plus connection flag.
// `energy` carries the Energy widget's own selection (power/energy sensors) so
// the two surfaces share one SSE event without sharing one entity list.
async function buildHaState() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const ha = (s && s.homeAssistant) || {};
  const configured = !!(ha.url && ha.token);
  return {
    configured,
    connected: configured && deckHa.isConnected(),
    entities: configured ? deckHa.snapshot(ha.entities || []) : [],
    energy: configured ? deckHa.snapshot(ha.energyEntities || []) : [],
  };
}

// Change guard for the ha_states deck broadcast: the shared HA watch fires on
// EVERY state_changed of the whole instance (one chatty power sensor is enough),
// while the ≤32 deck-bound entities rarely move — comparing the serialized
// payload keeps idle churn off the wire and off the clients' DOM passes.
let _haDeckStatesLast = '';
function broadcastHaDeckStates(force) {
  if (!_haDeckWatchClients.size) return;
  const payload = buildHaDeckStates();
  const sig = JSON.stringify(payload);
  if (!force && sig === _haDeckStatesLast) return;
  _haDeckStatesLast = sig;
  broadcastSSE('ha_states', payload);
}

// Coalesce bursts of state_changed events into at most one broadcast per ~250ms —
// a single HA scene can flip a dozen entities at once, and the tile only needs the
// settled result. Keeps SSE traffic tiny even in a busy home.
function scheduleHaBroadcast() {
  if (haNotifyTimer) return;
  haNotifyTimer = setTimeout(async () => {
    haNotifyTimer = null;
    try { broadcastSSE('homeassistant', await buildHaState()); } catch (e) { /* ignore */ }
    // Same coalesced beat feeds the deck-bound entity states (separate event so
    // the deck snapshot stays tiny and independent of the tile's selection).
    try { broadcastHaDeckStates(false); } catch (e) { /* ignore */ }
  }, 250);
}

// Signature of the HA config the broadcasts depend on — refreshHaWatch runs on
// every SSE connect/close and every settings save, and must NOT rebroadcast a
// full snapshot when none of this changed.
let _haConfigSig = null;
async function refreshHaWatch() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const ha = (s && s.homeAssistant) || {};
  const want = !!(ha.url && ha.token) && sseClients.size > 0;
  const sig = want ? [ha.url, ha.token, JSON.stringify(ha.entities || []), JSON.stringify(ha.energyEntities || [])].join(' ') : '';
  if (want && !haStopWatch) {
    haStopWatch = deckHa.watch(scheduleHaBroadcast);
  } else if (!want && haStopWatch) {
    haStopWatch(); haStopWatch = null;
    if (haNotifyTimer) { clearTimeout(haNotifyTimer); haNotifyTimer = null; }
    _haDeckStatesLast = '';   // a future watcher must get a fresh seed
    try { broadcastSSE('homeassistant', await buildHaState()); } catch (e) { /* ignore */ }
  } else if (want && haStopWatch && sig !== _haConfigSig) {
    // Already watching AND the config/selection actually changed (the user picked
    // different devices) — push a fresh snapshot so the tile reflects the new
    // selection immediately instead of waiting for the next HA state change.
    scheduleHaBroadcast();
  }
  _haConfigSig = sig;
}

// ── Streamer.bot live global variables ───────────────────────────────────────
// A snapshot of Streamer.bot's global variables is pushed to the client over the
// `streamerbot` SSE event, so a Deck key can REFLECT a global (its on/off follows
// the real value) — the "stateful key" of phase 2. The socket subscribes to
// GlobalVariable* events (push, no polling) and is held open only while a dashboard
// is open (SSE clients > 0) AND Streamer.bot is configured, mirroring OBS/HA. The
// password never leaves the server — only the projected globals do.
let sbStopWatch = null;
let sbNotifyTimer = null;
// Recent Streamer.bot activity (follows/subs/raids/cheers/redemptions…) for the
// Streamer.bot widget's live feed — a bounded ring buffer so it can't grow. Each
// new event is pushed live over the `streamerbot_event` SSE event AND kept here so
// a just-added tile seeds its feed from GET /streamerbot/activity. (Phase 3.)
const SB_ACTIVITY_MAX = 40;
let sbActivity = [];
let sbActivitySeq = 0;

function pushActivity(a) {
  if (!a || typeof a !== 'object') return;
  const item = Object.assign({ id: ++sbActivitySeq, at: Date.now() }, a);
  sbActivity.push(item);
  if (sbActivity.length > SB_ACTIVITY_MAX) sbActivity = sbActivity.slice(-SB_ACTIVITY_MAX);
  broadcastSSE('streamerbot_event', item);
}

async function buildSbState() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const configured = !!s.streamerbotHost;
  return { configured, connected: configured && deckSb.isConnected(), globals: configured ? deckSb.globalsSnapshot() : {} };
}

// Coalesce bursts of global changes into at most one broadcast per ~250ms (one
// Streamer.bot action can flip several globals at once). Keeps SSE traffic tiny.
function scheduleSbBroadcast() {
  if (sbNotifyTimer) return;
  sbNotifyTimer = setTimeout(async () => {
    sbNotifyTimer = null;
    try { broadcastSSE('streamerbot', await buildSbState()); } catch (e) { /* ignore */ }
  }, 250);
}

async function refreshSbWatch() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const want = !!s.streamerbotHost && sseClients.size > 0;
  if (want && !sbStopWatch) {
    sbStopWatch = deckSb.watch(scheduleSbBroadcast, pushActivity);
  } else if (!want && sbStopWatch) {
    sbStopWatch(); sbStopWatch = null;
    if (sbNotifyTimer) { clearTimeout(sbNotifyTimer); sbNotifyTimer = null; }
    try { broadcastSSE('streamerbot', await buildSbState()); } catch (e) { /* ignore */ }
  }
}

// ── Elgato Wave Link live mixer state ────────────────────────────────────────
// While a Wave Link tile/Deck key is on screen AND the integration is enabled,
// hold ONE live socket that mirrors the mixer and pushes it over the `wavelink`
// SSE event. Idle-closes otherwise (mirrors OBS/HA). Opt-in (enabled=false by
// default) so a dashboard never probes localhost:1824 for users who don't use it.
let wlStopWatch = null;
let wlNotifyTimer = null;

async function buildWlState() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const enabled = !!(s.wavelink && s.wavelink.enabled === true);
  if (!enabled) return { enabled: false, connected: false, inputs: [], output: {}, monitorMix: '', switchState: '', micConnected: false };
  return Object.assign({ enabled: true }, deckWaveLink.snapshot());
}

// Coalesce bursts of mixer changes (a single fader move fires several
// inputMixerChanged pushes) into at most one broadcast per ~200ms.
function scheduleWlBroadcast() {
  if (wlNotifyTimer) return;
  wlNotifyTimer = setTimeout(async () => {
    wlNotifyTimer = null;
    try { broadcastSSE('wavelink', await buildWlState()); } catch (e) { /* ignore */ }
  }, 200);
}

async function refreshWlWatch() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const want = !!(s.wavelink && s.wavelink.enabled === true) && sseClients.size > 0;
  if (want && !wlStopWatch) {
    wlStopWatch = deckWaveLink.watch(scheduleWlBroadcast);
  } else if (!want && wlStopWatch) {
    wlStopWatch(); wlStopWatch = null;
    if (wlNotifyTimer) { clearTimeout(wlNotifyTimer); wlNotifyTimer = null; }
    try { broadcastSSE('wavelink', await buildWlState()); } catch (e) { /* ignore */ }
  }
}

// ── UniFi Protect camera notifications (person/vehicle/motion/ring) ───────────
// While a Cameras tile is on screen (SSE clients > 0) AND notifications are enabled,
// hold ONE live WebSocket to the console's updates stream and surface each new
// detection as a `unifi_event` SSE → a dashboard toast (gated by the master Notifiche
// switch on the client). Idle-closes otherwise, mirroring OBS/HA/Wave Link. The
// per-camera+kind cooldown lives here so one person lingering can't spam the screen.
let unifiEventsStopWatch = null;
let _unifiNotifyConfigSig = null;
let _unifiNotifySnapshot = null;          // { enabled, types, cooldownMs } — refreshed by refreshUnifiEventsWatch
const _unifiNotifyCooldown = new Map();   // "camId|kind" -> last-broadcast ms
const UNIFI_COOLDOWN_MAX = 200;           // bound the map (many cameras × kinds)

// Handle one decoded detection: fan its kinds out to individual toasts, each gated
// by the user's per-kind toggle and the per-camera+kind cooldown. Reads the notify
// snapshot cached by refreshUnifiEventsWatch (which runs on every settings save and
// SSE membership change) — a busy camera must not cost a settings read per event.
function _onUnifiDetection(det) {
  if (!det || !det.camId || !Array.isArray(det.kinds)) return;
  const notify = _unifiNotifySnapshot;
  if (!notify || notify.enabled !== true) return;
  const types = notify.types;
  const cooldownMs = notify.cooldownMs;
  const now = Date.now();
  for (const kind of det.kinds) {
    if (types[kind] !== true) continue;
    const key = det.camId + '|' + kind;
    const last = _unifiNotifyCooldown.get(key) || 0;
    if (now - last < cooldownMs) continue;
    _unifiNotifyCooldown.set(key, now);
    // Bound the cooldown map: drop the oldest entries if it grows too large.
    if (_unifiNotifyCooldown.size > UNIFI_COOLDOWN_MAX) {
      const drop = _unifiNotifyCooldown.size - UNIFI_COOLDOWN_MAX;
      let i = 0;
      for (const k of _unifiNotifyCooldown.keys()) { if (i++ >= drop) break; _unifiNotifyCooldown.delete(k); }
    }
    broadcastSSE('unifi_event', { camId: det.camId, name: det.name || det.camId, kind, at: det.at || now });
  }
}

async function refreshUnifiEventsWatch() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const u = (s && s.unifi) || {};
  const notify = u.notify || {};
  _unifiNotifySnapshot = {
    enabled: notify.enabled === true,
    types: (notify.types && typeof notify.types === 'object') ? notify.types : {},
    cooldownMs: Math.max(5, Math.min(600, Number(notify.cooldownSec) || 45)) * 1000,
  };
  const configured = !!(u.host && u.username && u.password);
  const want = configured && notify.enabled === true && sseClients.size > 0;
  // Reconnect if the console credentials changed under an active watch (the socket
  // is bound to the old session); a mere toggle of the type checkboxes doesn't need it.
  const sig = want ? [u.host, u.username, u.password].join(' ') : '';
  if (want && !unifiEventsStopWatch) {
    unifiEventsStopWatch = deckUnifiEvents.watch(_onUnifiDetection);
  } else if (!want && unifiEventsStopWatch) {
    unifiEventsStopWatch(); unifiEventsStopWatch = null;
    _unifiNotifyCooldown.clear();
  } else if (want && unifiEventsStopWatch && sig !== _unifiNotifyConfigSig) {
    unifiEventsStopWatch(); unifiEventsStopWatch = deckUnifiEvents.watch(_onUnifiDetection);
  }
  _unifiNotifyConfigSig = sig;
}

// ── OBS auto-launch: open OBS when an OBS action is clicked while it's closed,
// then run the action once it connects. ──────────────────────────────────────
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let obsLaunching = false;

// Read OBS's install dir from the registry (HKLM\SOFTWARE\OBS Studio default).
// Returns the path string or null; never throws.
function readObsInstallDir() {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-Command', "$ErrorActionPreference='SilentlyContinue'; (Get-ItemProperty 'HKLM:\\SOFTWARE\\OBS Studio').'(default)'"],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const dir = String(stdout || '').trim();
        resolve(dir || null);
      });
  });
}

// Launch obs64.exe with its required working directory (bin\64bit). Best-effort.
function launchObs(exe) {
  try { spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false }).unref(); }
  catch (e) { console.error('OBS launch failed:', e.message); }
}

function _finishObsLaunch(ok) {
  if (!obsLaunching) return;
  obsLaunching = false;
  broadcastSSE('obs_launching', { launching: false, ok: !!ok });
}

// Run an OBS request; if it fails because OBS is unreachable AND auto-launch is on
// AND OBS is found, launch OBS and retry the SAME request until it connects (≤25s).
async function ensureObsRun(runFn) {
  try { return await runFn(); }
  catch (err) {
    if (!obsLaunch.isConnError(err)) throw err;                 // a real request error: surface it
    const s = (await readHubSettings().catch(() => null)) || {};
    if (s.obsAutoLaunch === false) throw err;                   // user opted out
    const exe = await obsLaunch.findObsExe({ readInstallDir: readObsInstallDir, fileExists: (p) => { try { return fs.existsSync(p); } catch { return false; } } });
    if (!exe) throw err;                                        // OBS not installed / not found
    if (!obsLaunching) { obsLaunching = true; broadcastSSE('obs_launching', { launching: true }); launchObs(exe); }
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await _sleep(3000);
      try { const r = await runFn(); _finishObsLaunch(true); return r; }
      catch (e2) { if (!obsLaunch.isConnError(e2)) { _finishObsLaunch(true); throw e2; } } // OBS is up; the action itself failed
    }
    _finishObsLaunch(false);                                    // OBS never came up in time
    throw err;
  }
}

// Sort 'app-1.2.3'-style names newest-first by their numeric parts.
function _compareAppDirDesc(a, b) {
  const va = (a.match(/\d+/g) || []).map(Number);
  const vb = (b.match(/\d+/g) || []).map(Number);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const diff = (vb[i] || 0) - (va[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

// Resolve a FOLDER the user pointed an "open app" key at to the executable that
// should actually launch — so pointing at an app's install directory just works.
// Handled shapes (newest version first; re-resolved on every tap so updates don't
// break the key):
//   1. Squirrel layout (Discord/Slack/Teams classic): a dir with Update.exe and
//      'app-X.Y.Z' subfolders → newest app-*/<Name>.exe.
//   2. A versioned dir itself (…/Discord/app-1.2.3) → an exe named after the parent.
//   3. A plain app dir holding exactly one executable.
// Returns '' when the path isn't a directory or no single clear target exists.
function resolveExecInDir(dir) {
  try {
    const d = String(dir || '').trim();
    if (!d) return '';
    let st;
    try { st = fs.statSync(d); } catch { return ''; }
    if (!st.isDirectory()) return '';
    const names = fs.readdirSync(d);
    const exes = names.filter((n) => /\.exe$/i.test(n));
    const leaf = path.basename(d).toLowerCase();
    const parentLeaf = path.basename(path.dirname(d)).toLowerCase();

    // 1) Squirrel: Update.exe + app-* subfolders → newest version's <leaf>.exe.
    if (exes.some((n) => n.toLowerCase() === 'update.exe')) {
      const appDirs = names
        .filter((n) => { try { return /^app-[\d.]+$/i.test(n) && fs.statSync(path.join(d, n)).isDirectory(); } catch { return false; } })
        .sort(_compareAppDirDesc);
      for (const ad of appDirs) {
        const inner = path.join(d, ad);
        let innerExes;
        try { innerExes = fs.readdirSync(inner).filter((n) => /\.exe$/i.test(n) && n.toLowerCase() !== 'update.exe'); }
        catch { continue; }                                    // unreadable; try next version
        const match = innerExes.find((n) => n.toLowerCase() === leaf + '.exe');  // e.g. Discord/app-*/Discord.exe
        if (match) return path.join(inner, match);
        if (innerExes.length === 1) return path.join(inner, innerExes[0]);
      }
    }

    // 2) An exe named after this folder, or after its parent (versioned-dir case).
    const named = exes.find((n) => n.toLowerCase() === leaf + '.exe')
      || exes.find((n) => n.toLowerCase() === parentLeaf + '.exe');
    if (named) return path.join(d, named);

    // 3) Exactly one launchable executable → unambiguous.
    const launchable = exes.filter((n) => n.toLowerCase() !== 'update.exe');
    if (launchable.length === 1) return path.join(d, launchable[0]);
    return '';
  } catch { return ''; }
}

// Lock the Windows session. Single source of truth for the LockWorkStation call,
// shared by the Deck lockWorkstation action, the AI lock_pc tool, the /lock
// endpoint and the idle auto-lock flow. execFile with an argv array — never a
// shell string.
function lockWorkstation() {
  return new Promise((resolve, reject) => {
    execFile('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

// The Deck action dispatcher. Effects are injected here; security/validation
// lives inside the registry. This is the only place key actions execute.
// deckRegistryDeps is kept mutable so that deps created after this point
// (e.g. remoteControl, which is initialised below) can be injected lazily
// by assigning to the object — the registry closes over the same reference.
const deckRegistryDeps = {
  fileExists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
  lockWorkstation: () => lockWorkstation().then(() => ({ ok: true }), (err) => ({ ok: false, error: String(err) })),
  // Apply a named SignalRGB scene (scene switcher, not a colour provider — see
  // signalrgb.js). Gated on the user enabling SignalRGB in Settings → Lighting,
  // so a stale Deck key can't drive it after the integration is turned off.
  signalRgbEffect: (effect) => {
    if (!(_serverHubSettings && _serverHubSettings.signalrgb && _serverHubSettings.signalrgb.enabled === true)) {
      return Promise.resolve({ ok: false, error: 'disabled' });
    }
    return signalrgb.applyEffect(effect);
  },
  openExternal: (p) => runPowerShellScript(DECK_ACTIONS_SCRIPT, ['open', p], 8000),
  // Run a user-configured .bat/.cmd/.ps1/.py (the runScript action), in a visible
  // or hidden window. The path is validated to a real script in the registry
  // before it reaches here.
  runScript: (p, hidden) => runPowerShellScript(DECK_ACTIONS_SCRIPT, ['runscript', p, hidden ? 'hidden' : 'visible'], 8000),
  // Resolve a folder target (the app's install dir) to its launch executable, so
  // a Deck "open app" key pointed at a folder (e.g. Discord's) still launches.
  resolveAppDir: (p) => resolveExecInDir(p),
  // Launch a Store/UWP app by AppUserModelID (shell:AppsFolder\<aumid>). The AUMID is
  // validated in the registry before reaching this dep.
  openStoreApp: (aumid) => runPowerShellScript(DECK_ACTIONS_SCRIPT, ['openapp', aumid], 8000),
  mediaAction: (cmd) => mediaAction(cmd),
  micMute: async (mode) => {
    if (mode === 'mute') isMuted = true;
    else if (mode === 'unmute') isMuted = false;
    else isMuted = !isMuted;          // 'toggle'
    setMicMute(isMuted);
    return { muted: isMuted };
  },
  volume: async (mode, value) => {
    if (!cachedSpeakerId) throw new Error('Cache not ready');
    if (mode === 'mute') return svvExec(['/Switch', cachedSpeakerId]);
    if (mode === 'up') return svvExec(['/ChangeVolume', cachedSpeakerId, '5']);
    if (mode === 'down') return svvExec(['/ChangeVolume', cachedSpeakerId, '-5']);
    // 'set': absolute 0–100 (already clamped by the registry) — slider keys.
    if (mode === 'set') return svvExec(['/SetVolume', cachedSpeakerId, String(value)]);
  },
  appVolume: async (app, mode, value) => {
    const target = appAudioTarget(app);
    if (mode === 'set') return svvExec(['/SetVolume', target, String(value)]);
    return svvExec(['/ChangeVolume', target, mode === 'down' ? '-5' : '5']);
  },
  appMute: async (app, mode) => {
    const target = appAudioTarget(app);
    const verb = mode === 'mute' ? '/Mute' : mode === 'unmute' ? '/Unmute' : '/Switch';
    return svvExec([verb, target]);
  },
  // Task-list mutations (the `tasks` action category). All go through writeTasks,
  // which normalises (assigns id/createdAt, caps text to 200, drops empties) and
  // broadcasts the updated `tasks` stream — so the Tasks tile and every granted
  // SDK widget (e.g. TTY // TODO) repaint together. Text/id are already trimmed +
  // length-capped by the registry's validateAction before we get here.
  taskAdd: async (text) => {
    const tasks = await readTasks();
    tasks.push({ text: String(text || '') });
    await writeTasks(tasks);   // normalize assigns a fresh id + createdAt
    return { ok: true };
  },
  taskToggle: async (id) => {
    const tasks = await readTasks();
    const task = tasks.find(t => t.id === id);
    if (!task) return { ok: false, error: 'not_found' };
    task.completed = !task.completed;
    task.completedAt = task.completed ? new Date().toISOString() : null;
    await writeTasks(tasks);
    return { ok: true };
  },
  taskDelete: async (id) => {
    const tasks = await readTasks();
    const next = tasks.filter(t => t.id !== id);
    if (next.length === tasks.length) return { ok: false, error: 'not_found' };
    await writeTasks(next);
    return { ok: true };
  },
  // Countdown timers from a Deck key — the SAME list the Timers tile and
  // /api/timers manage, addressed by label (case-insensitive). Each mutation
  // persists atomically and broadcasts `timer_update`, so tile, key faces and
  // other dashboards stay in sync. secs is already clamped by the registry.
  timers: {
    start: async (label, secs) => {
      const idx = _timers.findIndex((t) => t.label.toLowerCase() === label.toLowerCase());
      if (idx >= 0) {
        // Same label → restart it with the requested duration (a deck key is a
        // "start my 5-minute tea timer" button, not an endless duplicate mill).
        _timers[idx] = { ..._timers[idx], durationSecs: secs, startedAt: Date.now(), pausedElapsed: 0, status: 'running' };
      } else {
        if (_timers.length >= TIMERS_MAX) return { ok: false, error: 'max_timers' };
        _timers.push(_normalizeTimer({ label, durationSecs: secs, status: 'running', startedAt: Date.now(), pausedElapsed: 0 }));
      }
      await _saveTimers();
      broadcastSSE('timer_update', { timers: _timers });
      return { ok: true };
    },
    toggle: async (label) => {
      const t = _timers.find((x) => x.label.toLowerCase() === label.toLowerCase());
      if (!t) return { ok: false, error: 'not_found' };
      if (t.status === 'running') {
        t.pausedElapsed += (Date.now() - t.startedAt) / 1000;
        t.status = 'paused';
      } else {
        // paused → resume; done → restart from the top (a natural key re-tap).
        if (t.status === 'done') t.pausedElapsed = 0;
        t.startedAt = Date.now();
        t.status = 'running';
      }
      await _saveTimers();
      broadcastSSE('timer_update', { timers: _timers });
      return { ok: true };
    },
    cancel: async (label) => {
      const before = _timers.length;
      _timers = _timers.filter((t) => t.label.toLowerCase() !== label.toLowerCase());
      if (_timers.length === before) return { ok: false, error: 'not_found' };
      await _saveTimers();
      broadcastSSE('timer_update', { timers: _timers });
      return { ok: true };
    },
  },
  // Send a keyboard shortcut to the app the user was last using. Tapping the
  // touchscreen gives focus to the dashboard, so the runner finds the window
  // beneath it in the Z-order and targets that (covers Zoom, Meet, Slack, …).
  // `keys` is already normalised by the registry to a safe token set.
  sendHotkey: async (keys) => {
    try {
      const r = await runPowerShellScript(DECK_HOTKEY_SCRIPT, ['-Keys', keys], 6000);
      return (r && r.ok === false) ? { ok: false, error: r.error || 'hotkey_failed' } : { ok: true };
    } catch { return { ok: false, error: 'hotkey_failed' }; }
  },
  // Type a literal snippet into that same target app (KEYEVENTF_UNICODE). The
  // text travels BASE64-encoded in a discrete argv value: PowerShell -File
  // binding treats a value that starts with '-' as a new parameter name, so a
  // snippet like "--force" or "- item" would otherwise break binding. Base64
  // can never start with '-' and round-trips newlines/quotes exactly. Longer
  // timeout: typing is paced per character.
  typeText: async (text) => {
    try {
      const b64 = Buffer.from(String(text), 'utf8').toString('base64');
      const r = await runPowerShellScript(DECK_HOTKEY_SCRIPT, ['-TypeTextB64', b64], 15000);
      return (r && r.ok === false) ? { ok: false, error: r.error || 'type_failed' } : { ok: true };
    } catch { return { ok: false, error: 'type_failed' }; }
  },
  obs: (requestType, requestData) => ensureObsRun(() => deckObs.request(requestType, requestData)),
  obsNext: () => ensureObsRun(() => deckObs.nextScene()),
  // Fire a Streamer.bot request over its WebSocket (DoAction / SendMessage /
  // ExecuteCodeTrigger). The whole validated payload is forwarded — `request` names
  // the type, the rest are its fields (action/args, platform/message/bot,
  // triggerName/args). The connection is lazy/idle-closed; an unreachable
  // streamer.bot surfaces as a clean {ok:false} via run().
  streamerbot: (r) => { const { request, ...payload } = r; return deckSb.request(request, payload); },
  // Deck LED reaction: drive the lighting hub via a TRANSIENT overlay that never
  // touches the user's persisted manual colour or animation. 'restore' removes the
  // overlay so the LEDs return to the user's own configured lighting (not a blank
  // default). No-op-safe: if lighting is disabled nothing renders. color/style are
  // already validated by the catalog.
  lighting: async (action) => {
    if (action.mode === 'restore') { lighting.clearDeckReaction(); return true; }
    return lighting.setDeckReaction(action.color, action.style);
  },
  // Whole-system lighting control from a Deck key / SDK action: master on/off,
  // fixed colour, ambient effect, per-device mode — the exact primitives the
  // Illuminazione settings use. Unlike the transient deck-reaction above, these
  // PERSIST (debounced) so a key that sets the rig purple survives a restart,
  // exactly like changing it in Settings. Never throws — degrades to {ok:false}.
  lightingControl: async (action) => {
    try {
      switch (action.type) {
        case 'lightPower': {
          const on = action.state === 'on' ? true : action.state === 'off' ? false : !lighting.getStatus().enabled;
          lighting.setEnabled(on);
          if (on) { try { await lighting.ensureConnected(); } catch {} }
          break;
        }
        case 'lightColor':  if (lighting.setManualColor(action.color) === false) return { ok: false, error: 'bad_color' }; break;
        case 'lightAuto':   lighting.clearManual(); break;
        case 'lightEffect': if (lighting.setAnimation({ style: action.style, color: action.color }) === false) return { ok: false, error: 'bad_effect' }; break;
        case 'lightDevice': {
          const patch = { mode: action.mode };
          if (action.color) patch.color = action.color;
          if (lighting.setDeviceMode(action.device, patch) === false) return { ok: false, error: 'bad_device' };
          break;
        }
        default: return { ok: false, error: 'bad_lighting' };
      }
      _persistLighting();
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  // Home Assistant device control (toggle/scene/call_service). The provider owns
  // the lazy WS socket and re-validates the entity/service; an unreachable or
  // unconfigured HA surfaces as a clean {ok:false} via run().
  homeAssistant: (action) => deckHa.runAction(action),
  // Razer Chroma per-device lighting. Gated on the opt-in flag so a disabled
  // integration never opens a Chroma session; the provider degrades to {ok:false}
  // when Synapse/Chroma isn't running.
  chroma: async (action) => {
    const s = (await readHubSettings().catch(() => null)) || {};
    if (!(s.chroma && s.chroma.enabled === true)) return { ok: false, error: 'chroma_disabled' };
    return deckChroma.runAction(action);
  },
  // Elgato Wave Link mixer control. The provider's connect() reads the enabled
  // flag from live settings and rejects when off, so a disabled integration
  // surfaces as a clean {ok:false} (no localhost probe) via run().
  waveLink: (action) => deckWaveLink.runAction(action),
  // Move/snap/minimise the foreground window (a discrete allowlisted verb passed
  // as a single argv element to the window helper — never a shell string).
  windowAction: async (verb) => {
    try {
      const r = await runPowerShellScript(DECK_WINDOW_SCRIPT, [verb], 6000);
      return (r && r.ok === false) ? { ok: false, error: r.error || 'window_failed' } : { ok: true };
    } catch { return { ok: false, error: 'window_failed' }; }
  },
  // SDK widget macro resolver: "pkg/macroId" → the macro's validated steps, or
  // null. Steps come from the NORMALIZED manifest (rebuilt through the shared
  // catalog validator, restricted to the SDK's low-risk action types) and are
  // released only when the user granted the package every category the macro
  // touches — the same consent surface as the bridge actions.
  sdkMacro: async (pkgId, macroId) => {
    const scan = await sdkPackagesCached();
    const pkg = scan.packages.find(p => p.id === pkgId);
    const macro = pkg && pkg.deck && pkg.deck.actions.find(a => a.id === macroId);
    if (!macro) return null;
    const granted = sdkGrantsFor(pkgId).actions;
    if (!sdkWidgets.macroCategories(macro).every(cat => granted.includes(cat))) return null;
    // Defense in depth: re-filter to the SDK type allowlist even though the
    // manifest normalizer already enforced it.
    return macro.steps.filter(s => sdkWidgets.SDK_ACTION_TYPES.includes(s.action.type));
  },
  // SDK handler action: "pkg/handlerId" pressed on a deck key → validate the
  // declaration + per-handler grant, coerce the key's stored args against the
  // handler's declared params, then broadcast to the package's live frames and
  // wait for the first ack (or time out with an honest no_frame error). Rate
  // gate shared with hooks: one dispatch per pkg/handler per 250ms.
  sdkHandler: async (pkgId, handlerId, argsJson) => {
    if (!sdkFeatureEnabled()) return { ok: false, error: 'sdk_disabled' };
    const scan = await sdkPackagesCached();
    const pkg = scan.packages.find(p => p.id === pkgId);
    const handler = pkg && pkg.deck && Array.isArray(pkg.deck.handlers) && pkg.deck.handlers.find(h => h.id === handlerId);
    if (!handler) return { ok: false, error: 'handler_unavailable' };
    if (!sdkGrantsFor(pkgId).handlers.includes(handlerId)) return { ok: false, error: 'not_granted' };
    if (!sdkHookGateOk('handler:' + pkgId + '/' + handlerId)) return { ok: false, error: 'rate_limited' };
    const args = sdkWidgets.validateHandlerArgs(handler, argsJson);
    if (args === null) return { ok: false, error: 'bad_args' };
    return sdkHandlerDispatch(pkgId, handlerId, args);
  },
  // remote: injected below once remoteControl is created (see createRemoteControl call)
};
const deckRegistry = createRegistry(deckRegistryDeps);

// Performance Mode runner: guided, reversible app management. Side-effects are
// injected so the allowlist/validation stays the only execution path. The
// window helper does the graceful close and protected-process refusal.
const perfRegistry = createPerfRegistry({
  closeWindow: (id) => runWindowsTool(['close', id], 8000),
  openExternal: (p) => runPowerShellScript(DECK_ACTIONS_SCRIPT, ['open', p], 8000),
  fileExists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
  setPriority: (name, level) => runPowerShellScript(PERF_PRIORITY_SCRIPT, ['set', name, level === 'high' ? 'high' : 'normal'], 6000),
});

// Default body cap for JSON/text routes. Generous enough for the largest legit
// payload (AI chat carries base64 screenshots, a few MB) while bounding memory
// against a buggy/looping local client that would otherwise grow the string
// without limit. Mirrors the reject pattern of readBodyBuffer; every caller is
// try/catch-wrapped, so the rejection surfaces as a normal 500.
const READ_BODY_MAX_BYTES = 64 * 1024 * 1024;
function readBody(req, maxBytes = READ_BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('Payload too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end',  () => resolve(body));
    req.on('error', reject);
  });
}

function readBodyBuffer(req, maxBytes = BACKGROUND_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('Payload too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipartBackground(req, body, fieldName = 'background') {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/boundary=(?:(?:"([^"]+)")|([^;]+))/i);
  if (!match) throw new Error('Missing multipart boundary');

  const boundaryText = match[1] || match[2];
  const boundary = Buffer.from(`--${boundaryText}`);
  const separator = Buffer.from('\r\n\r\n');
  const nextBoundaryPrefix = Buffer.from(`\r\n--${boundaryText}`);
  let offset = body.indexOf(boundary);

  while (offset !== -1) {
    let partStart = offset + boundary.length;
    if (body[partStart] === 45 && body[partStart + 1] === 45) break;
    if (body[partStart] === 13 && body[partStart + 1] === 10) partStart += 2;

    const headerEnd = body.indexOf(separator, partStart);
    if (headerEnd === -1) break;
    const headers = body.slice(partStart, headerEnd).toString('latin1');
    const dataStart = headerEnd + separator.length;
    const dataEnd = body.indexOf(nextBoundaryPrefix, dataStart);
    if (dataEnd === -1) break;

    const disposition = headers.match(/content-disposition:\s*([^\r\n]+)/i);
    const name = disposition && disposition[1].match(/name="([^"]+)"/i);
    const filename = disposition && disposition[1].match(/filename="([^"]*)"/i);
    if (name && name[1] === fieldName && filename && filename[1]) {
      const typeMatch = headers.match(/content-type:\s*([^\r\n;]+)/i);
      return {
        originalName: path.basename(filename[1]).replace(/[^A-Za-z0-9._ -]/g, '').slice(0, 120) || fieldName,
        contentType: typeMatch ? typeMatch[1].trim().toLowerCase() : '',
        data: body.slice(dataStart, dataEnd),
      };
    }
    offset = body.indexOf(boundary, dataEnd);
  }
  throw new Error(`Missing ${fieldName} file`);
}

function cleanupOldBackgrounds(keepName) {
  fs.promises.readdir(UPLOADS_DIR).then(files => Promise.all(files
    .filter(file => file.startsWith('background-') && file !== keepName)
    .map(file => fs.promises.unlink(path.join(UPLOADS_DIR, file)).catch(() => {}))
  )).catch(() => {});
}

// Same one-live-file policy as backgrounds: a fresh upload/restore leaves exactly
// one `font-*` in UPLOADS_DIR, so orphaned fonts never accumulate.
function cleanupOldFonts(keepName) {
  fs.promises.readdir(UPLOADS_DIR).then(files => Promise.all(files
    .filter(file => file.startsWith('font-') && file !== keepName)
    .map(file => fs.promises.unlink(path.join(UPLOADS_DIR, file)).catch(() => {}))
  )).catch(() => {});
}

// Per-tile decoration assets have no one-live-file policy (many tiles, many
// pictures), so they are reference-counted instead: every dashboard layout that
// is persisted names the `tileasset-*` files still in use, and the rest are swept.
function _collectTileAssetRefsFromStyle(style, set) {
  const d = style && style.decor;
  if (!d) return;
  const add = (src) => {
    if (typeof src !== 'string') return;
    const m = src.match(/^\/uploads\/(tileasset-[A-Za-z0-9._-]+)$/);
    if (m) set.add(m[1]);
  };
  if (d.bg) add(d.bg.src);
  if (d.frame) add(d.frame.src);
  if (Array.isArray(d.overlays)) d.overlays.forEach(o => add(o && o.src));
}
function collectTileAssetRefs(layout, presets) {
  const set = new Set();
  if (layout && typeof layout === 'object') {
    const scan = (coll) => { if (coll && typeof coll === 'object') Object.keys(coll).forEach(k => _collectTileAssetRefsFromStyle(coll[k] && coll[k].style, set)); };
    scan(layout.widgets);
    scan(layout.groups);
    if (Array.isArray(layout.copies)) layout.copies.forEach(c => _collectTileAssetRefsFromStyle(c && c.style, set));
  }
  // Saved "My presets" keep tile styles too (widget/group/page items, already
  // bounded to 200 KB by sanitizeDashboardPresets) — a deep string scan keeps
  // their assets alive without chasing every nesting shape.
  if (Array.isArray(presets) && presets.length) {
    try {
      const json = JSON.stringify(presets);
      for (const m of json.matchAll(/\/uploads\/(tileasset-[A-Za-z0-9._-]+)/g)) set.add(m[1]);
    } catch { /* unserializable presets — nothing to protect */ }
  }
  return set;
}
// A fresh upload lands before the layout that references it is saved, so a grace
// window protects any `tileasset-*` touched in the last 10 minutes from the sweep.
const TILE_ASSET_GC_GRACE_MS = 10 * 60 * 1000;
// Sweep throttle: settings persist on every tweak (250 ms client debounce), and
// each sweep costs a readdir — with an unchanged reference set a re-sweep only
// matters once more files age past the grace window, so 5 minutes is plenty.
const TILE_ASSET_GC_MIN_INTERVAL_MS = 5 * 60 * 1000;
let _tileAssetGcSig = null;
let _tileAssetGcAt = 0;
function cleanupUnreferencedTileAssets(layout, presets) {
  const referenced = collectTileAssetRefs(layout, presets);
  const sig = [...referenced].sort().join('|');
  const now = Date.now();
  if (sig === _tileAssetGcSig && (now - _tileAssetGcAt) < TILE_ASSET_GC_MIN_INTERVAL_MS) return;
  _tileAssetGcSig = sig;
  _tileAssetGcAt = now;
  const cutoff = now - TILE_ASSET_GC_GRACE_MS;
  fs.promises.readdir(UPLOADS_DIR).then(files => Promise.all(files
    .filter(f => f.startsWith('tileasset-') && !referenced.has(f))
    .map(async (f) => {
      try {
        const p = path.join(UPLOADS_DIR, f);
        const st = await fs.promises.stat(p);
        if (st.mtimeMs < cutoff) await fs.promises.unlink(p).catch(() => {});
      } catch { /* file vanished mid-sweep — fine */ }
    })
  )).catch(() => {});
}

// ── Screen enumeration + capture (shared by /api/screens, /api/screenshot,
//    and the AI capture_screen function) ───────────────────────────────────
async function listScreens() {
  const psScript = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.Bounds.X)|$($_.Bounds.Y)|$($_.Bounds.Width)|$($_.Bounds.Height)|$($_.Primary)|$($_.DeviceName)" }';
  try {
    const stdout = await new Promise((resolve, reject) =>
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { maxBuffer: 64 * 1024, windowsHide: true },
        (err, out) => err ? reject(err) : resolve(out)
      )
    );
    return stdout.trim().split(/\r?\n/).filter(Boolean).map((line, i) => {
      const [x, y, w, h, primary, dev] = line.trim().split('|');
      const label = (dev || '').replace(/^\\\\.\\/, '').trim() || `DISPLAY${i + 1}`;
      return { index: i, x: parseInt(x) || 0, y: parseInt(y) || 0, width: parseInt(w) || 1920, height: parseInt(h) || 1080, primary: primary === 'True', name: label };
    });
  } catch {
    return [{ index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true, name: 'DISPLAY1' }];
  }
}

// Capture a screenshot; `monitor` is an optional {x,y,width,height} region.
// Returns base64 JPEG.
async function captureScreenshot(monitor) {
  const tmpPath = path.join(os.tmpdir(), `xenon_ss_${Date.now()}.jpg`);
  try {
    const ffmpeg = getFfmpegPath();
    const ffmpegArgs = ['-y', '-f', 'gdigrab', '-framerate', '1'];
    if (monitor && monitor.width > 0 && monitor.height > 0) {
      ffmpegArgs.push('-offset_x', String(monitor.x), '-offset_y', String(monitor.y), '-video_size', `${monitor.width}x${monitor.height}`);
    }
    ffmpegArgs.push('-i', 'desktop', '-vframes', '1', '-q:v', '3', '-vf', 'scale=\'min(1920,iw)\':-2', tmpPath);
    await execFilePromise(ffmpeg, ffmpegArgs, { timeout: 15000 });
    const imgBuffer = await fs.promises.readFile(tmpPath);
    return imgBuffer.toString('base64');
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}

// ── Server-side audio output (voice + chimes) ──────────────────────────────
// Plays through the system default device so audio works regardless of which
// window has focus (the browser WebView blocks autoplay without a user gesture).
let _speakProc = null;
let _speakGenToken = 0; // incremented on each stopServerSpeak to abort in-flight generation

// Duck/restore helpers — lower device volume so music quiets while Xenon speaks,
// then restore to the saved level. Safe to call multiple times (guarded by flag).
function _duckSpeakerVolume() {
  if (!_duckActive && cachedSpeakerId) {
    _duckSavedVolume = _lastSpeakerVolume;
    _duckActive = true;
    execFile(SVV, ['/SetVolume', cachedSpeakerId, '30'], () => {});
    process.stdout.write(`[Duck] volume ${_duckSavedVolume} → 30\n`);
  }
}
function _restoreSpeakerVolume() {
  if (_duckActive && cachedSpeakerId) {
    const vol = _duckSavedVolume != null ? _duckSavedVolume : 70;
    _duckActive = false;
    _duckSavedVolume = null;
    execFile(SVV, ['/SetVolume', cachedSpeakerId, String(vol)], () => {});
    process.stdout.write(`[Duck] restored → ${vol}\n`);
  }
}

function stopServerSpeak() {
  _speakGenToken++;
  if (_speakProc) { try { _speakProc.kill(); } catch {} _speakProc = null; }
  _restoreSpeakerVolume(); // restore if ducked during interrupted TTS
}

// Gemini native TTS (prebuilt neural voice). Returns a Promise<Buffer> with WAV
// audio, or rejects on error (quota, offline, no audio). Voice names are
// language-agnostic — the model speaks whatever language the text is in.
function _geminiTtsToWav(text, apiKey, voice = 'Charon') {
  return new Promise((resolve, reject) => {
    const safeVoice = String(voice || 'Charon').replace(/[^A-Za-z]/g, '').slice(0, 30) || 'Charon';
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: String(text || '').slice(0, 1000) }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: safeVoice } } },
      },
    });
    const t0 = Date.now();
    const ttsReq = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${AI_MODELS.tts}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
    }, (ttsRes) => {
      let d = '';
      ttsRes.on('data', c => { d += c; });
      ttsRes.on('end', () => {
        process.stdout.write(`[TTS] Gemini HTTP ${ttsRes.statusCode} in ${Date.now() - t0}ms\n`);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return reject(new Error(parsed.error.message || 'gemini tts error'));
          const part = parsed?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
          if (!part || !part.data) return reject(new Error('no audio data'));
          const pcmBytes = Buffer.from(part.data, 'base64');
          const rateMatch = String(part.mimeType || '').match(/rate=(\d+)/);
          const sampleRate = rateMatch ? parseInt(rateMatch[1]) : 24000;
          resolve(pcmToWav(pcmBytes, sampleRate));
        } catch (e) { reject(e); }
      });
    });
    ttsReq.on('error', reject);
    ttsReq.setTimeout(20000, () => { ttsReq.destroy(); reject(new Error('gemini tts timeout')); });
    ttsReq.write(payload);
    ttsReq.end();
  });
}

// One-shot Gemini text generation (no tools, no history). Used by the opt-in
// advanced features (Game Companion, Guardian) for single fire-and-forget
// analyses. `parts` follows the Gemini content-part shape (text / inlineData).
function _geminiOneShot(apiKey, parts, systemText, maxTokens = 512) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      ...(systemText ? { system_instruction: { parts: [{ text: String(systemText) }] } } : {}),
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens, candidateCount: 1, thinkingConfig: { thinkingBudget: 0 } },
    });
    const gReq = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${AI_MODELS.chat}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
    }, (gRes) => {
      let d = '';
      gRes.on('data', c => { d += c; });
      gRes.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return reject(new Error(parsed.error.message || 'gemini error'));
          const text = (parsed?.candidates?.[0]?.content?.parts || [])
            .filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim();
          if (!text) return reject(new Error('empty response'));
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    gReq.on('error', reject);
    gReq.setTimeout(30000, () => { gReq.destroy(); reject(new Error('gemini timeout')); });
    gReq.write(payload);
    gReq.end();
  });
}

// Play a WAV file via Windows SoundPlayer (synchronous, focus-independent).
// Resolves when playback finishes or is cancelled. Honours the cancel token.
// `duck`/`broadcast`/`restore` let the chunked path duck the media volume and
// announce speak_start ONCE (first chunk) and restore ONCE (after the last),
// instead of flapping the volume on every sentence.
function _playWavFile(wavPath, myToken, { duck = true, broadcast = true, restore = true } = {}) {
  return new Promise((resolve) => {
    if (_speakGenToken !== myToken) { fs.promises.unlink(wavPath).catch(() => {}); return resolve(); }
    if (duck) _duckSpeakerVolume(); // lower music/media volume while Xenon speaks
    if (broadcast) broadcastSSE('speak_start', {}); // tell the UI the voice is actually starting now
    const ps = `(New-Object System.Media.SoundPlayer -ArgumentList '${wavPath}').PlaySync();` +
               `try { Remove-Item -LiteralPath '${wavPath}' -Force -EA SilentlyContinue } catch {}`;
    const psProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    _speakProc = psProc;
    let _settled = false;
    const done = () => {
      if (_settled) return;
      _settled = true;
      clearTimeout(_guard);
      if (_speakProc === psProc) _speakProc = null;
      // The PowerShell one-liner only deletes the wav on a CLEAN PlaySync() exit;
      // a barge-in / guard kill terminates it first, so always unlink here too
      // (a no-op if the script already removed it) — otherwise every tap-to-
      // interrupt leaks one temp wav.
      fs.promises.unlink(wavPath).catch(() => {});
      if (restore) _restoreSpeakerVolume(); // bring music back when Xenon finishes speaking
      resolve();
    };
    // Playback cap (safety net against a stuck SoundPlayer). Kept below the
    // client's _aiSpeak guard so the client never races ahead and re-opens the
    // mic before this resolves. Raise both together if you change one.
    const _guard = setTimeout(() => { try { psProc.kill(); } catch {} done(); }, 40000);
    psProc.on('exit', done);
    psProc.on('error', done);
  });
}

// Speak text server-side using Gemini neural TTS (voice: Charon).
// Playback is server-side so it works regardless of window focus or WebView quirks.
// Resolves when speech finishes (or is stopped). Silently resolves on TTS error.
function speakOnServer(text, langPrefix, apiKey, provider) {
  return new Promise(async (resolve) => {
    stopServerSpeak();
    const myToken = _speakGenToken;
    const clean = String(text || '').slice(0, 2000);
    if (!clean) return resolve();

    // Voice output per provider: Ollama and Claude (no speech API) use the free
    // local Edge neural TTS; ChatGPT uses OpenAI TTS (its server-only key comes
    // from settings); Gemini uses Gemini TTS with the request's key.
    const useLocal = provider === 'ollama' || provider === 'anthropic';
    const useOpenai = provider === 'openai';
    let openaiKey = '';
    if (useOpenai) { const s = await readHubSettings().catch(() => null); openaiKey = String((s && s.openaiApiKey) || '').trim(); }
    const key = String(apiKey || '').trim();
    if (useOpenai && !openaiKey) return resolve();
    if (!useLocal && !useOpenai && !key) return resolve();
    const synth = (t) => useLocal
      ? aiLocal.localTts(t, langPrefix, getFfmpegPath())
      : useOpenai
        ? aiOpenai.tts({ apiKey: openaiKey, text: t })
        : _geminiTtsToWav(t, key, 'Charon');

    const chunks = splitSentences(clean);

    // Single sentence → the original one-shot path (no pipelining overhead).
    if (chunks.length <= 1) {
      const gWavPath = path.join(os.tmpdir(), `xenon-gtts-${Date.now()}-${myToken}.wav`);
      try {
        const wavBuf = await synth(clean);
        if (_speakGenToken !== myToken) return resolve();
        if (!wavBuf || wavBuf.length === 0) return resolve();
        await fs.promises.writeFile(gWavPath, wavBuf);
        if (_speakGenToken !== myToken) { fs.promises.unlink(gWavPath).catch(() => {}); return resolve(); }
        await _playWavFile(gWavPath, myToken);
      } catch (e) {
        process.stdout.write(`[TTS] ${useLocal ? 'Edge' : 'Gemini'} failed (${e.message})\n`);
        fs.promises.unlink(gWavPath).catch(() => {});
      }
      return resolve();
    }

    // Multi-sentence → synth the NEXT sentence while the current one plays, so
    // the user hears the first sentence after one synth, not after the whole
    // reply. speak_start + ducking fire on the first played chunk; the media
    // volume is restored once, after the last (or on a barge-in cancel).
    const writeChunk = async (t, idx) => {
      const buf = await synth(t);
      if (_speakGenToken !== myToken || !buf || !buf.length) return null;
      const p = path.join(os.tmpdir(), `xenon-gtts-${Date.now()}-${myToken}-${idx}.wav`);
      await fs.promises.writeFile(p, buf);
      return p;
    };
    let started = false;
    let nextPath = null;
    try {
      nextPath = await writeChunk(chunks[0], 0).catch(() => null);
      for (let i = 0; i < chunks.length; i++) {
        if (_speakGenToken !== myToken) break;
        const curPath = nextPath;
        nextPath = null; // consumed below (played wavs are unlinked by _playWavFile)
        // Kick off the next sentence's synth BEFORE playing the current one.
        const prefetch = (i + 1 < chunks.length)
          ? writeChunk(chunks[i + 1], i + 1).catch(() => null)
          : Promise.resolve(null);
        if (curPath) {
          await _playWavFile(curPath, myToken, { duck: !started, broadcast: !started, restore: false });
          started = true;
        }
        nextPath = await prefetch;
      }
    } catch (e) {
      process.stdout.write(`[TTS] ${useLocal ? 'Edge' : 'Gemini'} chunked failed (${e.message})\n`);
    } finally {
      // A prefetched-but-never-played chunk (loop broke on barge-in) would leak.
      if (nextPath) fs.promises.unlink(nextPath).catch(() => {});
      if (started) _restoreSpeakerVolume(); // restore once, after the last chunk
    }
    resolve();
  });
}

// Provider-agnostic tool dispatch shared by the Gemini and Ollama chat loops.
// `deps` carries the per-request context the handlers need.
// Persist the bridge's current lighting config into settings.json so AI-driven
// (and endpoint-driven) changes survive a restart. Best-effort; never throws.
// Coalesced: a burst of lighting tweaks (slider drags, AI sweeps, effect
// toggles) used to rewrite the whole settings.json — the largest store — once
// per call; now at most once per window. The config written is read fresh from
// the bridge at flush time, so the last state always wins. Flushed on shutdown.
let _lightingPersistTimer = null;
const LIGHTING_PERSIST_DEBOUNCE_MS = 800;
async function _flushLightingPersist() {
  if (!_lightingPersistTimer) return;
  clearTimeout(_lightingPersistTimer);
  _lightingPersistTimer = null;
  // Serialized with every other settings writer: the base is spread from
  // _serverHubSettings, so a concurrent POST /settings could otherwise commit a
  // vitals refill that this flush then overwrites with its pre-refill copy.
  try { await withHubSettingsLock(async () => { _serverHubSettings = await writeHubSettings({ ..._serverHubSettings, lighting: lighting.getConfig() }); }); }
  catch (e) { console.error('Lighting persist failed:', e.message); }
}
async function _persistLighting() {
  if (_lightingPersistTimer) return;   // a flush is already scheduled — it reads the latest config
  _lightingPersistTimer = setTimeout(() => { _flushLightingPersist(); }, LIGHTING_PERSIST_DEBOUNCE_MS);
  _lightingPersistTimer.unref();
}

// Returns { fnResult, clientActions, pendingScreenImage }.
// ── Consent-gated PC commands (Xenon AI "run_pc_command") ─────────────────
// The AI never runs a shell command directly. It PROPOSES one; we store the
// exact command under a single-use, unguessable nonce and surface a confirmation
// card to the user. The command runs ONLY after the user approves it
// (POST /ai/pc-run) and is looked up by nonce server-side, so the browser can
// never tamper with what actually executes. Gated behind the off-by-default
// aiFeatures.pcControl flag and re-checked on both issue and run.
const PC_ACTION_TTL_MS = 5 * 60 * 1000;
const PC_ACTION_TIMEOUT_MS = 60 * 1000;
const _pcActions = new Map(); // nonce -> { command, purpose, ts }
function _pcControlEnabled() {
  const f = _serverHubSettings && _serverHubSettings.aiFeatures;
  return !!(f && f.enabled === true && f.pcControl === true);
}
function issuePcAction(command, purpose) {
  const now = Date.now();
  for (const [k, v] of _pcActions) if (now - v.ts > PC_ACTION_TTL_MS) _pcActions.delete(k);
  const nonce = crypto.randomBytes(18).toString('hex');
  _pcActions.set(nonce, { command, purpose, ts: now });
  return nonce;
}

async function executeAiTool(fnName, fnArgs, deps) {
  const {
    apiKey, uiLang, latestUserText,
    latestLooksLikeClothingWeather, latestExplicitlyWantsScreen,
    provider,
  } = deps;
  const clientActions = [];
  let pendingScreenImage = null;
  let fnResult;

  // show_lock_screen is the pre-v4.4 name for start_ambient_mode — kept as an
  // alias so old AI memories/prompts keep working.
  const CLIENT_ACTIONS = new Set(['open_weather_panel', 'open_settings', 'open_app_switcher', 'show_lock_screen', 'start_ambient_mode', 'stop_ambient_mode', 'change_theme', 'close_ai_panel', 'refresh_tasks', 'refresh_calendar', 'refresh_timers', 'go_to_page', 'switch_deck_profile', 'optimize_performance', 'restore_performance', 'customize_appearance', 'create_dashboard_style', 'create_animated_background', 'configure_preferences', 'set_media_source', 'genesis_compose_page', 'genesis_add_widgets', 'genesis_duplicate_widget', 'genesis_remove_page', 'genesis_setup_deck', 'configure_deck']);

  if (CLIENT_ACTIONS.has(fnName)) {
    clientActions.push({ action: fnName, args: fnArgs });
    fnResult = { ok: true };
    return { fnResult, clientActions, pendingScreenImage };
  }

  try {
    if (fnName === 'create_widget') {
      // AI-authored community widget: files arrive as plain text, get base64-
      // encoded into the EXACT /sdk/install payload and pass through the same
      // validateWidgetPayload boundary (installWidgetPayload is the ONE writer).
      // Never grants, never assigns — the user approves permissions on first use.
      if (!sdkFeatureEnabled()) {
        fnResult = { ok: false, error: 'sdk_disabled', hint: 'Ask the user to enable Community widgets in Settings → Widget e condivisione first.' };
      } else {
        const files = Array.isArray(fnArgs.files) ? fnArgs.files.slice(0, 40) : [];
        const payload = {
          id: String(fnArgs.id || ''),
          files: files.map(f => ({ path: String(f && f.path || ''), data: Buffer.from(String(f && f.content || ''), 'utf8').toString('base64') })),
        };
        // 'creator': an AI-authored widget is the user's own build, so it stays
        // exportable/shareable — unlike packages that arrive via import.
        const r = await installWidgetPayload(payload, 'creator');
        fnResult = r.ok
          ? { ok: true, id: r.id, name: r.name, note: 'Installed. Tell the user to add a "Custom widget" tile from the + palette and pick it — its permissions are approved there, never automatically.' }
          : { ok: false, error: r.error };
      }
    } else if (fnName === 'deck_action_catalog') {
      // Read-only grounding for configure_deck: the full typed-action catalog
      // (compact), the live-state sources and the slider targets.
      const catalog = require('./js/deck-actions.js').ACTION_CATALOG
        .filter(a => !a.hidden)
        .map(a => ({ type: a.type, params: a.params.map(p => p.kind === 'select' ? { name: p.name, options: p.options } : { name: p.name }) }));
      const dm = require('./js/deck-model.js');
      fnResult = { ok: true, actions: catalog, stateSources: dm.DECK_STATE_SOURCES, liveSources: dm.DECK_LIVE_SOURCES, sensorMetrics: dm.DECK_SENSOR_METRICS, sliderTargets: dm.SLIDER_TARGETS };
    } else if (fnName === 'xenon_knowledge') {
      // Read-only grounding about Xenon itself (setup, features, troubleshooting)
      // so app questions get answered from curated facts, not guesses.
      fnResult = require('./ai-knowledge.js').lookup(fnArgs.query || fnArgs.topic || '');
    } else if (fnName === 'sdk_reference') {
      // Read-only grounding for create_widget: the code-authoritative SDK
      // allowlists plus docs/WIDGET_SDK.md by section.
      fnResult = await require('./ai-knowledge.js').getSdkReference(fnArgs.section || '');
    } else if (fnName === 'marketplace_search') {
      const out = await communityCatalog.fetchVisibleCatalog(false);
      if (!out.ok) {
        fnResult = { ok: false, error: 'catalog_unreachable' };
      } else {
        const q = String(fnArgs.query || '').toLowerCase();
        const kind = String(fnArgs.kind || '');
        const list = out.entries
          .filter(e => (!kind || e.kind === kind))
          .filter(e => !q || [e.name, e.author, e.description, e.publisher && e.publisher.handle, ...(e.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(q))
          .slice(0, 20)
          .map(e => ({ id: e.id, kind: e.kind, name: e.name, author: (e.publisher && e.publisher.handle) || e.author || '', version: e.version || '', description: e.description || '', locked: !!e.locked }));
        fnResult = { ok: true, results: list };
      }
    } else if (fnName === 'marketplace_install') {
      // Resolve the entry's share code, then hand it to the CLIENT import flow:
      // the user always sees the normal per-kind review dialog — never a silent
      // apply, exactly like pasting the code by hand.
      const out = await communityCatalog.fetchVisibleCatalog(false);
      const entry = out.ok ? out.entries.find(e => e.id === String(fnArgs.id || '')) : null;
      if (!entry) {
        fnResult = { ok: false, error: 'not_found' };
      } else if (entry.locked) {
        fnResult = { ok: false, error: 'locked', hint: 'This entry is protected with access codes — the user needs one (usually a supporter perk) and can import it from the community gallery.' };
      } else {
        const code = entry.code ? { ok: true, code: entry.code } : await communityCatalog.fetchCode(entry.id);
        if (!code.ok) {
          fnResult = { ok: false, error: 'code_unreachable' };
        } else {
          clientActions.push({ action: 'marketplace_open_import', args: { code: code.code } });
          fnResult = { ok: true, note: 'The import review dialog is now open — the user confirms what gets applied/installed there.' };
        }
      }
    } else if (fnName === 'open_virtual_deck') {
      fnResult = await openDeckPopupWindow(String(fnArgs.instance || ''), fnArgs.topmost !== false);
    } else if (fnName === 'guardian_report') {
      // Guardian (opt-in): deterministic local digest of the sensor history —
      // the model turns it into a human health report. Zero extra API calls.
      fnResult = await guardian.getDigest();
    } else if (fnName === 'query_sensor_history') {
      // Guardian (opt-in): targeted per-metric history so the model can compare
      // days / find peaks / read the trend. Deterministic, zero API cost.
      fnResult = await guardian.queryHistory(fnArgs.metric || '');
    } else if (fnName === 'remember_fact') {
      // Persistent memory: store a durable fact about the user (local only).
      fnResult = await aiMemory.add(fnArgs.fact || fnArgs.text || '');
    } else if (fnName === 'forget_fact') {
      fnResult = await aiMemory.remove(fnArgs.fact || fnArgs.text || fnArgs.query || '');
    } else if (fnName === 'toggle_mic') {
      isMuted = !isMuted; setMicMute(isMuted);
      fnResult = { ok: true, muted: isMuted };
    } else if (fnName === 'mute_mic') {
      isMuted = true; setMicMute(true);
      fnResult = { ok: true, muted: true };
    } else if (fnName === 'unmute_mic') {
      isMuted = false; setMicMute(false);
      fnResult = { ok: true, muted: false };
    } else if (fnName === 'media_playpause') {
      fnResult = await mediaAction('playpause');
    } else if (fnName === 'media_next') {
      fnResult = await mediaAction('next');
    } else if (fnName === 'media_previous') {
      fnResult = await mediaAction('previous');
    } else if (fnName === 'set_volume') {
      const vol = Math.max(0, Math.min(100, parseInt(fnArgs.level || 50)));
      if (cachedSpeakerId) {
        await new Promise((resolve, reject) => {
          execFile(SVV, ['/SetVolume', cachedSpeakerId, String(vol)], e => e ? reject(e) : resolve());
        });
      }
      fnResult = { ok: true, level: vol };
    } else if (fnName === 'toggle_speaker_mute') {
      if (!cachedSpeakerId) { fnResult = { error: 'audio not ready' }; }
      else {
        await new Promise((resolve, reject) => {
          execFile(SVV, ['/Switch', cachedSpeakerId], e => e ? reject(e) : resolve());
        });
        fnResult = { ok: true };
      }
    } else if (fnName === 'set_mic_volume') {
      const micVol = Math.max(0, Math.min(100, parseInt(fnArgs.level || 50)));
      if (!cachedMicId) { fnResult = { error: 'mic not ready' }; }
      else {
        await new Promise((resolve, reject) => {
          execFile(SVV, ['/SetVolume', cachedMicId, String(micVol)], e => e ? reject(e) : resolve());
        });
        fnResult = { ok: true, level: micVol };
      }
    } else if (fnName === 'lock_pc') {
      await lockWorkstation();
      fnResult = { ok: true };
    } else if (fnName === 'capture_screen') {
      if (latestLooksLikeClothingWeather && !latestExplicitlyWantsScreen) {
        const weatherForAdvice = await getWeather(uiLang, null).catch(e => ({ error: e.message }));
        fnResult = {
          error: 'screen_capture_not_requested',
          instruction: 'The latest request is about weather/clothing, not screen vision. Do not ask which monitor. Use the included weather data and answer what the user should wear.',
          weather: weatherForAdvice,
          latest_user_text: latestUserText,
        };
      } else {
        const screens = await listScreens();
        const reqMon = fnArgs.monitor != null ? parseInt(fnArgs.monitor) - 1 : -1;
        if (screens.length > 1 && (reqMon < 0 || reqMon >= screens.length)) {
          // Ambiguous on a multi-monitor setup — show a clickable picker in the UI
          // and let Gemini inform the user verbally at the same time.
          clientActions.push({
            action: 'show_monitor_picker',
            args: {
              screens: screens.map((s, i) => ({
                index: i + 1, primary: s.primary,
                width: s.width, height: s.height,
                x: s.x, y: s.y,
              })),
            },
          });
          fnResult = {
            needs_monitor_choice: true,
            monitor_count: screens.length,
            monitors: screens.map((s, i) => ({ number: i + 1, primary: s.primary, resolution: `${s.width}x${s.height}` })),
          };
        } else {
          const target = screens.length === 1 ? screens[0]
            : (reqMon >= 0 ? screens[reqMon] : (screens.find(s => s.primary) || screens[0]));
          _aiFocusedScreen = target;
          try {
            pendingScreenImage = await captureScreenshot(target);
            fnResult = { ok: true, captured: true, monitor: screens.indexOf(target) + 1, resolution: `${target.width}x${target.height}` };
          } catch (capErr) {
            fnResult = { error: 'capture failed: ' + capErr.message };
          }
        }
      }
    } else if (fnName === 'get_system_info') {
      fnResult = await getSystemInfo();
    } else if (fnName === 'set_lights') {
      const ok = lighting.setManualColor(fnArgs.color);
      fnResult = ok ? { ok: true, color: String(fnArgs.color || '') }
                    : { error: 'unknown_colour', hint: 'use a colour name or #RRGGBB' };
    } else if (fnName === 'clear_lights') {
      lighting.clearManual();
      fnResult = { ok: true };
    } else if (fnName === 'set_effect') {
      const eff = String(fnArgs.effect || '');
      let ok = false;
      if (eff === 'volume') {
        // The volume-flash effect was removed — be honest instead of confirming a no-op.
        fnResult = { error: 'effect_removed', hint: 'the volume flash effect no longer exists; available: temperature, musicAlbum, timer, notification, reminder' };
      } else {
        if (['temperature', 'musicAlbum'].includes(eff)) {
          lighting.applyConfig({ effects: { [eff]: !!fnArgs.enabled } }); ok = true;
        } else if (['timer', 'notification', 'reminder'].includes(eff)) {
          lighting.applyConfig({ effects: { [eff]: { enabled: !!fnArgs.enabled } } }); ok = true;
        }
        if (ok) await _persistLighting();
        fnResult = ok ? { ok: true, effect: eff, enabled: !!fnArgs.enabled }
                      : { error: 'unknown_effect', hint: 'one of: temperature, musicAlbum, timer, notification, reminder' };
      }
    } else if (fnName === 'set_event_effect') {
      const eff = String(fnArgs.effect || '');
      if (!['timer', 'notification', 'reminder'].includes(eff)) {
        fnResult = { error: 'unknown_effect', hint: 'one of: timer, notification, reminder' };
      } else {
        const patch = {};
        if (fnArgs.color != null) {
          const c = lighting._fx.parseColorName(fnArgs.color);
          if (c) patch.color = lighting._fx.rgbToHex(c);
        }
        if (['blink', 'pulse', 'solid'].includes(fnArgs.style)) patch.style = fnArgs.style;
        if (typeof fnArgs.enabled === 'boolean') patch.enabled = fnArgs.enabled;
        lighting.applyConfig({ effects: { [eff]: patch } });
        await _persistLighting();
        fnResult = { ok: true, effect: eff, config: lighting.getConfig().effects[eff] };
      }
    } else if (fnName === 'set_animation') {
      const patch = {};
      if (typeof fnArgs.style === 'string') patch.style = fnArgs.style.trim();
      if (fnArgs.color != null) {
        const c = lighting._fx.parseColorName(fnArgs.color);
        if (c) patch.color = lighting._fx.rgbToHex(c);
      }
      if (fnArgs.speed != null) patch.speed = Number(fnArgs.speed);
      if (typeof fnArgs.palette === 'string' && fnArgs.palette.trim()) {
        patch.palette = fnArgs.palette.split(',').map(s => s.trim()).filter(Boolean);
      }
      // setAnimation silently ignores unknown styles — validate here so the AI
      // hears "invalid" instead of confirming a change that didn't happen.
      if (patch.style && !LIGHTING_ANIM_STYLES.includes(patch.style)) {
        fnResult = { error: 'invalid_animation', hint: 'style must be one of: ' + LIGHTING_ANIM_STYLES.join(', ') };
      } else {
        lighting.setAnimation(patch);
        await _persistLighting();
        fnResult = { ok: true, animation: lighting.getConfig().animation, hint: lighting.getConfig().enabled ? undefined : 'lighting master is OFF — call set_lighting_bridge to make the animation visible' };
      }
    } else if (fnName === 'set_lighting_bridge') {
      lighting.setEnabled(!!fnArgs.enabled);
      if (fnArgs.enabled) { try { await lighting.ensureConnected(); } catch {} }
      await _persistLighting();
      fnResult = { ok: true, enabled: !!fnArgs.enabled, status: lighting.getStatus() };
    } else if (fnName === 'show_sensor') {
      const sys = await getSystemInfo().catch(() => null);
      // One flat metric map over the assembled system payload — the same
      // projections the Deck's live 'sensor' keys use.
      let value = null;
      if (sys) {
        const p = sys.power || {};
        const fans = Array.isArray(sys.fans) ? sys.fans : [];
        // Same discriminator + spinning-fan preference as the Deck's live
        // 'sensor' projection (deck-model.js sensorsFromSystem) — the AI and a
        // Deck key bound to the same metric must report the same fan.
        const gpuFan = fans.find(f => f && f.kind === 'gpu');
        const cpuFan = fans.find(f => f && f.kind !== 'gpu' && Number(f.rpm) > 0) || fans.find(f => f && f.kind !== 'gpu');
        const metrics = {
          cpuTemp: sys.cpuTemp, gpuTemp: sys.gpuTemp, cpu: sys.cpu, gpu: sys.gpu,
          cpuFan: cpuFan ? cpuFan.rpm : null,
          gpuFan: gpuFan ? (gpuFan.rpm != null ? gpuFan.rpm + ' RPM' : (gpuFan.pct != null ? gpuFan.pct + '%' : null)) : null,
          cpuWatts: p.cpu, gpuWatts: p.gpu, totalWatts: p.total, psuWatts: p.psu,
        };
        value = Object.prototype.hasOwnProperty.call(metrics, fnArgs.sensor) ? metrics[fnArgs.sensor] : null;
      }
      fnResult = { sensor: fnArgs.sensor, value, lightingAvailable: lighting.getStatus().available };
    } else if (fnName === 'get_battery_status') {
      const bat = await batteryMonitor.getDevices().catch(() => null);
      fnResult = bat || { devices: [], sources: { corsair: false, bluetooth: false } };
    } else if (fnName === 'get_energy_status') {
      const sys = await getSystemInfo().catch(() => null);
      const ha = await buildHaState().catch(() => null);
      fnResult = {
        pc: (sys && sys.power) || { cpu: null, gpu: null, psu: null, total: null },
        home: (ha && Array.isArray(ha.energy)) ? ha.energy.map(e => ({ name: e.name, value: e.state, unit: e.unit || '', deviceClass: e.deviceClass || '' })) : [],
        homeConfigured: !!(ha && ha.configured),
      };
    } else if (fnName === 'get_weather') {
      fnResult = await getWeather(uiLang, null);
    } else if (fnName === 'get_stock_quote') {
      const syms = String(fnArgs.symbols || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
      const quotes = await stocks.fetchQuotes(syms, _stocksProviderOpts());
      fnResult = quotes.length
        ? { quotes: quotes.map(q => ({ symbol: q.symbol, name: q.name, price: q.price, changePct: Number(q.changePct.toFixed(2)), currency: q.currency })) }
        : { error: 'no data for those symbols — check the ticker (Borsa Italiana needs .MI, e.g. ENI.MI)' };
    } else if (fnName === 'get_stock_watchlist') {
      const fresh = await refreshStocks();
      fnResult = { quotes: (fresh.quotes || []).map(q => ({ symbol: q.symbol, name: q.name, price: q.price, changePct: Number(q.changePct.toFixed(2)), currency: q.currency })) };
    } else if (fnName === 'add_stock_favorite') {
      const sym = stocks.cleanSymbol(fnArgs.symbol);
      if (!sym) { fnResult = { error: 'invalid symbol' }; }
      else {
        await withHubSettingsLock(async () => {        // serialized with every other settings writer
          const cur = (await readHubSettings().catch(() => null)) || { ...DEFAULT_HUB_SETTINGS };
          const wl = Array.isArray(cur.stocks && cur.stocks.watchlist) ? cur.stocks.watchlist.slice() : [];
          if (!wl.some(w => w.symbol === sym)) wl.push({ symbol: sym });
          const saved = await writeHubSettings({ ...cur, stocks: { ...cur.stocks, watchlist: wl } });
          _serverHubSettings = saved;
        });
        refreshStocks().catch(() => {});
        fnResult = { ok: true, symbol: sym };
      }
    } else if (fnName === 'get_football_scores') {
      const fresh = await refreshFootball();
      const wanted = String(fnArgs.team || '').trim().toLowerCase();
      const teams = (fresh.teams || []).filter(td => !wanted || String(td.name || '').toLowerCase().includes(wanted));
      const fmt = (ev) => {
        if (!ev) return null;
        const both = ev.homeScore != null && ev.awayScore != null;
        return {
          match: both ? `${ev.home} ${ev.homeScore}-${ev.awayScore} ${ev.away}` : `${ev.home} vs ${ev.away}`,
          status: ev.status, when: ev.ts || (ev.date + ' ' + ev.time), league: ev.league,
        };
      };
      fnResult = teams.length
        ? { teams: teams.map(td => ({ team: td.name, next: fmt(td.next), last: fmt(td.last) })) }
        : { error: wanted ? 'that team is not in the favorites' : 'no favorite teams yet' };
    } else if (fnName === 'get_league_standings') {
      const wanted = String(fnArgs.team || '').trim().toLowerCase();
      const fresh = await refreshFootball();
      // Match a followed favorite (team → its league; league → itself) by name,
      // then fall back to the curated competitions so "Serie A"/"Champions" work
      // even when not followed. An empty query is rejected (would match anything).
      const fav = wanted ? (fresh.teams || []).find(x => String(x.name || '').toLowerCase().includes(wanted)) : null;
      let leagueId = fav ? (fav.type === 'league' ? fav.id : fav.leagueId) : '';
      let season = fav ? fav.season : '';
      if (!leagueId && wanted) { const L = football.searchLeagues(wanted)[0]; if (L) leagueId = L.id; }
      if (!leagueId) { fnResult = { error: 'no league found — name a competition (e.g. "Serie A", "Champions League") or a team you follow' }; }
      else {
        const table = await football.fetchStandings(leagueId, season, _footballOpts());
        fnResult = table
          ? { league: table.league, standings: table.rows.slice(0, 20).map(r => ({ rank: r.rank, team: r.team, played: r.played, points: r.points, gd: r.gd })) }
          : { error: 'standings unavailable for that league right now' };
      }
    } else if (fnName === 'get_news_headlines') {
      const topic = String(fnArgs.topic || '').trim();
      if (topic) {
        // A specific topic → fetch it fresh (doesn't need to be a followed feed).
        const data = await news.fetchHeadlines([{ type: 'topic', name: topic, query: topic }], _newsOpts());
        fnResult = data.items.length
          ? { headlines: data.items.slice(0, 8).map(it => ({ title: it.title, source: it.source })) }
          : { error: 'no headlines found for that topic' };
      } else {
        const fresh = await refreshNews();
        fnResult = (fresh.items || []).length
          ? { headlines: fresh.items.slice(0, 8).map(it => ({ title: it.title, source: it.source })) }
          : { error: 'no followed news feeds yet' };
      }
    } else if (fnName === 'web_search') {
      // Only Gemini has a built-in grounded search. Every other provider (local
      // Ollama, and the server-only ChatGPT/Claude, whose Gemini key is absent)
      // searches key-free via DuckDuckGo. Use an explicit non-Gemini allowlist:
      // the Gemini main tool loop calls executeAiTool WITHOUT a `provider` dep, so
      // `provider` is undefined there and must fall to the grounded branch.
      const searchRes = (provider === 'ollama' || provider === 'openai' || provider === 'anthropic')
        ? await aiLocal.localWebSearch(fnArgs.query)
        : await _geminiWebSearch(fnArgs.query, apiKey);
      fnResult = searchRes.error
        ? { error: searchRes.error, note: 'web search unavailable — answer from your own knowledge and say it may not be up to date' }
        : { query: String(fnArgs.query || ''), result: searchRes.answer, sources: searchRes.sources, note: 'Search results may be in another language — answer in the user\'s language.' };
    } else if (fnName === 'read_notes') {
      const state = await readNotes().catch(() => ({ v: 1, activeId: '', notes: [] }));
      fnResult = { notes: notesToText(state) };
    } else if (fnName === 'write_notes') {
      const safe = String(fnArgs.content || '').slice(0, NOTE_BODY_MAX);
      // Guard: never silently erase the notes with an empty string.
      // The model must use clear_all_tasks-style explicit intent for destructive ops.
      if (safe.trim() === '') { fnResult = { error: 'content is empty — to clear notes, send a single space or ask the user to confirm' }; }
      else {
        const prevState = await readNotes().catch(() => ({ v: 1, activeId: '', notes: [] }));
        // Write into the active note (preserving the user's other notes); create
        // one if the store is empty. The model's mental model is a single notepad.
        const next = normalizeNotesState(prevState);
        let active = next.notes.find((n) => n.id === next.activeId);
        if (!active) {
          active = { id: _noteId(), body: '', pinned: false, updatedAt: Date.now() };
          next.notes.unshift(active);
          next.activeId = active.id;
        }
        active.body = safe;
        active.updatedAt = Date.now();
        await writeNotes(next);
        clientActions.push({ action: 'refresh_notes', args: {} });
        aiActionLog.record({ name: 'write_notes', label: 'Note aggiornate', undo: { kind: 'restore_notes', prev: prevState } });
        fnResult = { ok: true };
      }
    } else if (fnName === 'list_tasks') {
      const tasks = await readTasks();
      fnResult = { tasks: tasks.map(t => ({ id: t.id, text: t.text, priority: t.priority, completed: t.completed })) };
    } else if (fnName === 'create_task') {
      const taskText = String(fnArgs.text || '').trim();
      if (!taskText) { fnResult = { error: 'empty text' }; }
      else {
        const tasks = await readTasks();
        const newTask = normalizeTask({
          text: taskText,
          priority: TASK_PRIORITIES.includes(fnArgs.priority) ? fnArgs.priority : 'medium',
          recurrence: 'never',
        });
        tasks.push(newTask);
        await writeTasks(tasks);
        clientActions.push({ action: 'refresh_tasks', args: {} });
        aiActionLog.record({ name: 'create_task', label: `Task creato: "${newTask.text}"`, undo: { kind: 'delete_task', id: newTask.id } });
        fnResult = { ok: true, task: { id: newTask.id, text: newTask.text, priority: newTask.priority } };
      }
    } else if (fnName === 'delete_task') {
      const delId = String(fnArgs.id || '').trim();
      if (!delId) { fnResult = { error: 'missing id' }; }
      else {
        const tasks = await readTasks();
        const before = tasks.length;
        const remaining = tasks.filter(t => t.id !== delId);
        if (remaining.length === before) { fnResult = { error: 'task not found', id: delId }; }
        else {
          await writeTasks(remaining);
          clientActions.push({ action: 'refresh_tasks', args: {} });
          fnResult = { ok: true, deleted: delId };
        }
      }
    } else if (fnName === 'clear_all_tasks') {
      const prevTasks = await readTasks();
      await writeTasks([]);
      clientActions.push({ action: 'refresh_tasks', args: {} });
      aiActionLog.record({ name: 'clear_all_tasks', label: 'Tutti i task cancellati', undo: { kind: 'restore_tasks', prev: prevTasks } });
      fnResult = { ok: true, deleted: 'all' };
    } else if (fnName === 'complete_task') {
      const taskId = String(fnArgs.id || '').trim();
      const makeCompleted = fnArgs.completed !== false; // defaults to true
      if (!taskId) { fnResult = { error: 'missing id' }; }
      else {
        const tasks = await readTasks();
        const task = tasks.find(t => t.id === taskId);
        if (!task) { fnResult = { error: 'task not found', id: taskId }; }
        else {
          task.completed = makeCompleted;
          task.completedAt = makeCompleted ? new Date().toISOString() : null;
          await writeTasks(tasks);
          clientActions.push({ action: 'refresh_tasks', args: {} });
          fnResult = { ok: true, id: taskId, completed: makeCompleted };
        }
      }
    } else if (fnName === 'list_calendar_events') {
      // Return ALL events (past included): the model needs every event to be
      // able to delete or reference them. Past events were previously filtered
      // out, which made "delete all events" wrongly report an empty calendar.
      const events = await readEvents();
      const sorted = events
        .slice()
        .sort((a, b) => (a.startsAt || '').localeCompare(b.startsAt || ''))
        .slice(0, 50);
      fnResult = { count: events.length, events: sorted.map(e => ({ id: e.id, title: e.title, startsAt: e.startsAt, notes: e.notes })) };
    } else if (fnName === 'create_calendar_event') {
      const evTitle = String(fnArgs.title || '').trim();
      if (!evTitle) { fnResult = { error: 'empty title' }; }
      else {
        const events = await readEvents();
        const newEvent = {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          title: evTitle.slice(0, 120),
          notes: String(fnArgs.notes || '').trim().slice(0, 600),
          startsAt: String(fnArgs.starts_at || '').trim(),
          reminderAt: String(fnArgs.reminder_at || '').trim(),
          notifiedAt: '',
          createdAt: new Date().toISOString(),
        };
        events.push(newEvent);
        await writeEvents(events);
        clientActions.push({ action: 'refresh_calendar', args: {} });
        fnResult = { ok: true, event: { id: newEvent.id, title: newEvent.title, startsAt: newEvent.startsAt } };
      }
    } else if (fnName === 'delete_calendar_event') {
      const evId = String(fnArgs.id || '').trim();
      if (!evId) { fnResult = { error: 'missing id' }; }
      else {
        const events = await readEvents();
        const before = events.length;
        const remaining = events.filter(e => e.id !== evId);
        if (remaining.length === before) { fnResult = { error: 'event not found', id: evId }; }
        else {
          await writeEvents(remaining);
          clientActions.push({ action: 'refresh_calendar', args: {} });
          fnResult = { ok: true, deleted: evId };
        }
      }
    } else if (fnName === 'clear_all_calendar_events') {
      const events = await readEvents();
      const removed = events.length;
      await writeEvents([]);
      clientActions.push({ action: 'refresh_calendar', args: {} });
      aiActionLog.record({ name: 'clear_all_calendar_events', label: 'Tutti gli eventi cancellati', undo: { kind: 'restore_events', prev: events } });
      fnResult = { ok: true, deleted: 'all', count: removed };
    } else if (fnName === 'open_application') {
      const rawTarget = String(fnArgs.target || '').trim();
      if (!rawTarget) { fnResult = { error: 'target mancante' }; }
      else {
        // Some apps are more reliably opened via their registered URI protocol
        // than via App Paths name lookup (e.g. Steam doesn't always resolve by
        // name). Use canonical deep links that actually open a window — a bare
        // "steam://" invokes the handler but opens nothing visible.
        const PROTOCOL_MAP = {
          'steam': 'steam://open/main', 'steam client': 'steam://open/main',
          'discord': 'discord://',
          'whatsapp': 'whatsapp://',
          'slack': 'slack://',
          'zoom': 'zoommtg://',
          'epic': 'com.epicgames.launcher://apps',
          'epic games': 'com.epicgames.launcher://apps',
        };
        const resolved = PROTOCOL_MAP[rawTarget.toLowerCase()] || rawTarget;
        // Escape single quotes for PowerShell single-quoted strings
        const psEscaped = resolved.replace(/'/g, "''");
        // Use ShellExecute (UseShellExecute=true) for reliable App Paths & protocol lookup.
        // Unlike `cmd /c start`, this gives a real exception on failure → detectable error.
        const ps = `try{[void][System.Diagnostics.Process]::Start([System.Diagnostics.ProcessStartInfo]@{FileName='${psEscaped}';UseShellExecute=$true})}catch{exit 1}`;
        try {
          await new Promise((resolve, reject) =>
            execFile('powershell.exe',
              ['-NoProfile', '-NonInteractive', '-Command', ps],
              { windowsHide: true, timeout: 10000 },
              (err) => err ? reject(new Error(`"${rawTarget}" non trovato o non installato`)) : resolve()
            )
          );
          fnResult = { ok: true, opened: rawTarget };
        } catch (launchErr) {
          fnResult = { error: launchErr.message };
        }
      }
    } else if (fnName === 'close_application') {
      const rawTarget = String(fnArgs.target || '').trim();
      if (!rawTarget) { fnResult = { error: 'target mancante' }; }
      else {
        // Map friendly names → common process names (without .exe)
        const CLOSE_MAP = {
          'spotify': 'spotify', 'chrome': 'chrome', 'google chrome': 'chrome',
          'firefox': 'firefox', 'edge': 'msedge', 'microsoft edge': 'msedge',
          'notepad': 'notepad', 'vlc': 'vlc', 'discord': 'discord',
          'steam': 'steam', 'obs': 'obs64', 'obs studio': 'obs64',
          'word': 'winword', 'excel': 'excel', 'powerpoint': 'powerpnt',
          'teams': 'teams', 'zoom': 'zoom', 'slack': 'slack',
          'whatsapp': 'whatsapp',
        };
        const procName = (CLOSE_MAP[rawTarget.toLowerCase()] || rawTarget).replace(/\.exe$/i, '');
        const psEsc = procName.replace(/'/g, "''");
        const ps = `$p=Get-Process -Name '*${psEsc}*' -EA SilentlyContinue; if($p){$p|Stop-Process -Force;exit 0}else{exit 1}`;
        try {
          await new Promise((resolve, reject) =>
            execFile('powershell.exe',
              ['-NoProfile', '-NonInteractive', '-Command', ps],
              { windowsHide: true, timeout: 10000 },
              (err) => {
                if (!err) resolve();
                else if (err.code === 1) reject(new Error(`"${rawTarget}" not found or already closed`));
                else reject(err);
              }
            )
          );
          fnResult = { ok: true, closed: rawTarget };
        } catch (closeErr) {
          fnResult = { error: closeErr.message };
        }
      }
    } else if (fnName === 'start_timer') {
      const durSecs = Math.max(1, Math.round(Number(fnArgs.duration_secs) || 60));
      const timerLabel = String(fnArgs.label || 'Timer').trim().slice(0, 40);
      if (_timers.length >= TIMERS_MAX) {
        fnResult = { error: 'Too many timers active' };
      } else {
        const newTimer = _normalizeTimer({ label: timerLabel, durationSecs: durSecs, status: 'running', startedAt: Date.now(), pausedElapsed: 0 });
        _timers.push(newTimer);
        await _saveTimers();
        clientActions.push({ action: 'refresh_timers', args: {} });
        broadcastSSE('timer_update', { timers: _timers });
        const mins = Math.floor(durSecs / 60), secs = durSecs % 60;
        const durationLabel = mins > 0 ? (secs > 0 ? `${mins}m ${secs}s` : `${mins} min`) : `${secs}s`;
        fnResult = { ok: true, id: newTimer.id, label: timerLabel, duration: durationLabel };
      }
    } else if (fnName === 'list_timers') {
      fnResult = {
        timers: _timers.map(t => ({
          id: t.id, label: t.label, status: t.status,
          remaining_secs: Math.ceil(_getTimerRemaining(t)),
          duration_secs: t.durationSecs,
        })),
      };
    } else if (fnName === 'delete_timer') {
      const delId = String(fnArgs.id || '').trim();
      const before = _timers.length;
      _timers = _timers.filter(t => t.id !== delId);
      if (_timers.length < before) {
        await _saveTimers();
        clientActions.push({ action: 'refresh_timers', args: {} });
        broadcastSSE('timer_update', { timers: _timers });
        fnResult = { ok: true };
      } else {
        fnResult = { error: 'timer not found' };
      }
    } else if (fnName === 'app_audio') {
      // Per-app mixer via the same allowlisted registry the Deck uses.
      const app = String(fnArgs.app || '').trim();
      const action = String(fnArgs.action || '');
      const map = {
        volume_up: { type: 'appVolume', app, mode: 'up' },
        volume_down: { type: 'appVolume', app, mode: 'down' },
        mute: { type: 'appMute', app, mode: 'mute' },
        unmute: { type: 'appMute', app, mode: 'unmute' },
        toggle_mute: { type: 'appMute', app, mode: 'toggle' },
      };
      const act = map[action];
      fnResult = !app ? { error: 'no_app' } : (act ? await deckRegistry.run(act) : { error: 'bad_action' });
    } else if (fnName === 'obs_control') {
      // Route through the same allowlisted deck registry that Deck keys use, so
      // validation/normalisation lives in one place. A missing OBS connection
      // comes back as {error:'obs_unavailable'} — the model tells the user.
      const map = {
        start_recording: { type: 'obsRecord', mode: 'start' },
        stop_recording: { type: 'obsRecord', mode: 'stop' },
        toggle_recording: { type: 'obsRecord', mode: 'toggle' },
        start_streaming: { type: 'obsStream', mode: 'start' },
        stop_streaming: { type: 'obsStream', mode: 'stop' },
        toggle_streaming: { type: 'obsStream', mode: 'toggle' },
        switch_scene: { type: 'obsScene', scene: String(fnArgs.scene || '') },
        next_scene: { type: 'obsSceneNext' },
      };
      const action = map[String(fnArgs.action || '')];
      fnResult = action ? await deckRegistry.run(action) : { error: 'bad_action' };
    } else if (fnName === 'twitch_action') {
      const value = String(fnArgs.value || '');
      const map = {
        create_clip: { type: 'twitchClip' },
        set_title: { type: 'twitchTitle', title: value },
        set_game: { type: 'twitchGame', game: value },
        send_chat: { type: 'twitchChat', message: value },
        marker: { type: 'twitchMarker', description: value },
        shoutout: { type: 'twitchShoutout', login: value },
        chat_mode: { type: 'twitchChatMode', mode: value },
        run_ad: { type: 'twitchAd', length: value || '60' },
      };
      const action = map[String(fnArgs.action || '')];
      fnResult = action ? await deckRegistry.run(action) : { error: 'bad_action' };
    } else if (fnName === 'youtube_broadcast') {
      fnResult = await deckRegistry.run({ type: 'ytBroadcast', mode: String(fnArgs.mode || 'toggle') });
    } else if (fnName === 'streamerbot_action') {
      const act = String(fnArgs.action || '').trim();
      fnResult = act ? await deckRegistry.run({ type: 'sbDoAction', action: act }) : { error: 'no_action' };
    } else if (fnName === 'spotify_control') {
      // Full Spotify control. Transport/shuffle/repeat/like/volume/seek/device
      // route through the allowlisted registry; play/queue-by-name and the status
      // read use the provider directly (search resolves the concrete URI).
      const action = String(fnArgs.action || '');
      const query = String(fnArgs.query || '');
      const value = String(fnArgs.value || '');
      if (action === 'status') {
        const [player, devices] = await Promise.all([
          streamSpotify.getPlayer().catch(() => null),
          streamSpotify.getDevices().catch(() => null),
        ]);
        fnResult = { ok: true, nowPlaying: player, devices: (devices && devices.devices) || [] };
      } else if (action === 'play_song') {
        fnResult = await streamSpotify.playSearch(query);
      } else if (action === 'queue_song') {
        fnResult = await streamSpotify.queueSearch(query);
      } else {
        const seekMs = Math.max(0, Math.round((parseFloat(value) || 0) * 1000));
        const map = {
          play: { type: 'spotifyPlay', mode: 'play' },
          pause: { type: 'spotifyPlay', mode: 'pause' },
          next: { type: 'spotifyNext' },
          previous: { type: 'spotifyPrev' },
          shuffle_on: { type: 'spotifyShuffle', mode: 'on' },
          shuffle_off: { type: 'spotifyShuffle', mode: 'off' },
          repeat: { type: 'spotifyRepeat', mode: ['off', 'context', 'track'].includes(value) ? value : 'toggle' },
          like: { type: 'spotifyLike', mode: 'like' },
          unlike: { type: 'spotifyLike', mode: 'unlike' },
          volume: { type: 'spotifyVolume', mode: 'set', value },
          seek: { type: 'spotifySeek', value: seekMs },
          play_playlist: { type: 'spotifyPlaylist', playlist: query },
          device: { type: 'spotifyDevice', device: query },
        };
        const act = map[action];
        fnResult = act ? await deckRegistry.run(act) : { error: 'bad_action' };
      }
    } else if (fnName === 'home_assistant') {
      // Smart-home control. `list` reads the entity roster (so the model can match
      // a friendly name → entity_id); everything else goes through the registry's
      // validated HA actions (the provider re-validates entity_id/service).
      const action = String(fnArgs.action || '');
      const entity = String(fnArgs.entity_id || '').trim();
      if (action === 'list') {
        const ents = await deckHa.listEntities().catch(() => []);
        fnResult = {
          ok: true,
          entities: (Array.isArray(ents) ? ents : []).slice(0, 80).map(e => ({
            id: e.id, name: e.name, domain: e.domain, area: e.area || null, state: e.state, unit: e.unit || undefined,
          })),
        };
      } else {
        const map = {
          turn_on: { type: 'haToggle', entity, mode: 'on' },
          turn_off: { type: 'haToggle', entity, mode: 'off' },
          toggle: { type: 'haToggle', entity, mode: 'toggle' },
          scene: { type: 'haScene', entity },
          service: { type: 'haCallService', service: String(fnArgs.service || ''), entity, data: String(fnArgs.data || '') },
        };
        const act = map[action];
        fnResult = act ? await deckRegistry.run(act) : { error: 'bad_action' };
      }
    } else if (fnName === 'discord_voice') {
      // Discord voice control. `status` reads the live voice state + joinable
      // channels; `join` resolves a channel NAME → snowflake before the registry
      // call; the rest map straight onto the allowlisted Discord actions.
      const action = String(fnArgs.action || '');
      if (action === 'status') {
        const [st, chans] = await Promise.all([
          discordRpc.voiceState().catch(() => null),
          discordRpc.listVoiceChannels().catch(() => []),
        ]);
        fnResult = { ok: true, voice: st, channels: (Array.isArray(chans) ? chans : []).slice(0, 60) };
      } else if (action === 'join') {
        const name = String(fnArgs.channel || '').trim().toLowerCase();
        if (!name) { fnResult = { error: 'no_channel' }; }
        else {
          const chans = await discordRpc.listVoiceChannels().catch(() => []);
          const match = (Array.isArray(chans) ? chans : []).find(c => String(c.name || '').toLowerCase() === name)
            || (Array.isArray(chans) ? chans : []).find(c => String(c.name || '').toLowerCase().includes(name));
          fnResult = match ? await deckRegistry.run({ type: 'discordJoin', channel: match.id }) : { error: 'channel_not_found' };
        }
      } else {
        const mode = String(fnArgs.mode || '') === 'down' ? 'down' : 'up';
        const map = {
          mute: { type: 'discordMute', mode: 'mute' },
          unmute: { type: 'discordMute', mode: 'unmute' },
          deafen: { type: 'discordDeafen', mode: 'deafen' },
          undeafen: { type: 'discordDeafen', mode: 'undeafen' },
          ptt: { type: 'discordPtt', mode: 'ptt' },
          vad: { type: 'discordPtt', mode: 'vad' },
          leave: { type: 'discordLeave' },
          input_volume: { type: 'discordInputVol', mode },
          output_volume: { type: 'discordOutputVol', mode },
          audio_toggle: { type: 'discordAudioToggle', feature: String(fnArgs.feature || '') },
        };
        const act = map[action];
        fnResult = act ? await deckRegistry.run(act) : { error: 'bad_action' };
      }
    } else if (fnName === 'list_audio_devices') {
      // Report the available output/input devices so the model can pick one by
      // name (and answer "what speakers do I have?").
      const info = await getAudioInfo().catch(() => null);
      if (!info) { fnResult = { error: 'audio_unavailable' }; }
      else {
        const trim = (arr) => (Array.isArray(arr) ? arr : []).map(d => ({ name: d.label || d.name, current: !!d.isDefault })).slice(0, 24);
        fnResult = { ok: true, speakers: trim(info.speakers), microphones: trim(info.mics),
          current: { speaker: info.speaker && (info.speaker.label || info.speaker.name) || null, microphone: info.mic && (info.mic.label || info.mic.name) || null } };
      }
    } else if (fnName === 'set_audio_device') {
      // Switch the default output/input device by (fuzzy) name. Reuses the exact
      // SoundVolumeView path the manual picker uses.
      const kind = String(fnArgs.kind || '').toLowerCase();
      const wanted = String(fnArgs.name || '').trim().toLowerCase();
      if (!['speaker', 'mic', 'microphone'].includes(kind)) { fnResult = { error: 'bad_kind', message: 'kind must be "speaker" or "mic"' }; }
      else if (!wanted) { fnResult = { error: 'no_name' }; }
      else {
        const info = await getAudioInfo().catch(() => null);
        const list = info ? (kind === 'speaker' ? info.speakers : info.mics) : null;
        if (!Array.isArray(list) || !list.length) { fnResult = { error: 'audio_unavailable' }; }
        else {
          const hay = (d) => `${d.label || ''} ${d.name || ''}`.toLowerCase();
          const match = list.find(d => hay(d) === wanted)
            || list.find(d => hay(d).includes(wanted))
            || list.find(d => wanted.includes((d.name || '').toLowerCase()) && (d.name || '').length > 2);
          if (!match || !match.id) {
            fnResult = { error: 'not_found', available: list.map(d => d.label || d.name).slice(0, 24) };
          } else {
            await new Promise((resolve, reject) => execFile(SVV, ['/SetDefault', match.id, 'all'], e => e ? reject(e) : resolve()));
            if (kind === 'speaker') cachedSpeakerId = match.id;
            else { cachedMicId = match.id; if (isMuted) setMicMute(true); }
            fnResult = { ok: true, kind: kind === 'speaker' ? 'speaker' : 'microphone', device: match.label || match.name };
          }
        }
      }
    } else if (fnName === 'run_pc_command') {
      // Consent-gated generic PC control. NEVER executes here — proposes a
      // command that runs only after the user approves the confirmation card.
      if (!_pcControlEnabled()) {
        fnResult = { error: 'pc_control_disabled', message: 'PC command control is off. Tell the user to enable "Controllo PC" in Settings → Funzioni AI first.' };
      } else {
        const command = String(fnArgs.command || '').trim().slice(0, 2000);
        const purpose = String(fnArgs.description || fnArgs.purpose || '').trim().slice(0, 300);
        if (!command) { fnResult = { error: 'no_command' }; }
        else {
          const nonce = issuePcAction(command, purpose);
          clientActions.push({ action: 'confirm_pc_command', args: { nonce, command, description: purpose } });
          fnResult = { status: 'pending_confirmation', message: 'The command has NOT run yet — a confirmation card is shown to the user and it will run only if they approve. Do NOT claim it executed; tell the user to confirm on the card.' };
        }
      }
    } else {
      fnResult = { error: 'unknown_function' };
    }
  } catch (fnErr) {
    fnResult = { error: fnErr.message };
  }

  return { fnResult, clientActions, pendingScreenImage };
}

// Build a short two-note chime WAV in memory (sine + decay envelope).
let _chimeCache = {};
function _buildChimeWav(kind) {
  const rate = 24000, dur = 0.6;
  const notes = kind === 'close' ? [[660, 0], [440, 0.13]] : [[784, 0], [1046, 0.13]];
  const total = Math.floor(rate * dur);
  const buf = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    const t = i / rate;
    let s = 0;
    for (const [freq, start] of notes) {
      if (t >= start) {
        const lt = t - start;
        const env = Math.exp(-lt * 4) * (1 - Math.exp(-lt * 80));
        s += Math.sin(2 * Math.PI * freq * lt) * env;
      }
    }
    s = Math.max(-1, Math.min(1, s * 0.08));
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return pcmToWav(buf, rate, 1, 16);
}

function playChimeOnServer(kind) {
  const k = kind === 'close' ? 'close' : 'wake';
  if (!_chimeCache[k]) {
    try { _chimeCache[k] = _buildChimeWav(k); } catch { return; }
  }
  const wavPath = path.join(os.tmpdir(), `xenon-chime-${k}.wav`);
  fs.promises.writeFile(wavPath, _chimeCache[k]).then(() => {
    const ps = "(New-Object System.Media.SoundPlayer -ArgumentList '" + wavPath + "').PlaySync();";
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    proc.on('error', () => {});
  }).catch(() => {});
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function getFfmpegPath() {
  if (process.env.XEH_FFMPEG) return process.env.XEH_FFMPEG;
  const localCandidates = [
    path.join(__dirname, 'ffmpeg.exe'),
    path.join(__dirname, 'ffmpeg', 'bin', 'ffmpeg.exe'),
  ];
  const local = localCandidates.find(candidate => fs.existsSync(candidate));
  if (local) return local;

  if (process.env.LOCALAPPDATA) {
    const wingetPackages = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    const wingetFfmpeg = findFirstFile(wingetPackages, 'ffmpeg.exe', 5);
    if (wingetFfmpeg) return wingetFfmpeg;
  }

  return 'ffmpeg.exe';
}

function findFirstFile(root, fileName, maxDepth) {
  if (!root || maxDepth < 0 || !fs.existsSync(root)) return null;
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const direct = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase());
    if (direct) return path.join(root, direct.name);

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = findFirstFile(path.join(root, entry.name), fileName, maxDepth - 1);
      if (found) return found;
    }
  } catch {}
  return null;
}

function isFfmpegMissing(error) {
  return error && (error.code === 'ENOENT' || /not recognized|ENOENT|cannot find/i.test(String(error.message || '')));
}

async function transcodeMp4BackgroundToWebm(sourcePath, targetPath) {
  const ffmpeg = getFfmpegPath();
  await execFilePromise(ffmpeg, [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', sourcePath,
    '-vf', 'fps=30,scale=1920:-2',
    '-an',
    '-c:v', 'libvpx',
    '-deadline', 'good',
    '-cpu-used', '4',
    '-b:v', '6M',
    '-maxrate', '8M',
    '-bufsize', '12M',
    '-auto-alt-ref', '0',
    targetPath,
  ], { timeout: BACKGROUND_TRANSCODE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });

  const stat = await fs.promises.stat(targetPath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('Converted WebM is empty');
  return stat;
}

const DashboardInstances = require('./js/dashboard-instances.js');

const DASHBOARD_WIDGET_IDS = Object.freeze(['media', 'agenda', 'mic', 'audio', 'system', 'notes', 'tasks', 'calendar', 'timer', 'chat', 'deck', 'remote', 'twitch', 'obs', 'youtube', 'discord', 'spotify', 'browser', 'secondscreen', 'weather', 'smarthome', 'streamerbot', 'wavelink', 'lighting', 'notifications', 'stocks', 'football', 'news', 'claude', 'vitals', 'unifi', 'slideshow', 'fans', 'power', 'battery', 'custom']);
const DASHBOARD_PAGE_IDS = Object.freeze(['dashboard']);
const DASHBOARD_TAB_IDS = Object.freeze(['main', 'net']);
const CALENDAR_TAB_IDS = Object.freeze(['calendar', 'tasks', 'timer']);
const MEDIA_VIEW_IDS = Object.freeze(['media', 'calendar']);
const DASHBOARD_CARD_IDS = Object.freeze({
  main: ['cpu', 'gpu', 'ram', 'disk'],
  net: ['ping', 'fps', 'latency', 'bandwidth'],
  audio: ['volume', 'speaker', 'microphone'],
  twitch: ['info', 'actions', 'chat'],
  obs: ['preview', 'controls', 'scenes', 'audio'],
  youtube: ['info', 'actions'],
});
const DASHBOARD_WIDGET_SIZES = Object.freeze(['compact', 'normal', 'wide', 'tall', 'large', 'full']);
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
    youtube:  Object.freeze({ x: 16, y: 22, w: 8, h: 4, visible: false, page: 'dashboard' }),
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
    vitals:   Object.freeze({ x: 8, y: 38, w: 8, h: 8, visible: false, page: 'dashboard' }),
    unifi:    Object.freeze({ x: 8, y: 18, w: 8, h: 8, visible: false, page: 'dashboard' }),
    slideshow: Object.freeze({ x: 0, y: 48, w: 8, h: 8, visible: false, page: 'dashboard' }),
    fans:     Object.freeze({ x: 16, y: 38, w: 8, h: 8, visible: false, page: 'dashboard' }),
    power:    Object.freeze({ x: 16, y: 46, w: 8, h: 8, visible: false, page: 'dashboard' }),
    battery:  Object.freeze({ x: 0, y: 56, w: 8, h: 8, visible: false, page: 'dashboard' }),
    custom:   Object.freeze({ x: 0, y: 28, w: 8, h: 8, visible: false, page: 'dashboard' }),
  }),
  groups: Object.freeze({
    'media-group': Object.freeze({ id: 'media-group', members: Object.freeze(['media', 'chat']), active: 'media', x: 0, y: 0, w: 8, h: 8, page: 'dashboard', seeded: true, autoTabByMedia: true }),
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
    youtube: Object.freeze({
      info: Object.freeze({ order: 0, size: 'normal', visible: true }),
      actions: Object.freeze({ order: 1, size: 'normal', visible: true }),
    }),
  }),
  tabs: Object.freeze({ order: ['main', 'net'], active: 'main' }),
  calendarTabs: Object.freeze({ order: ['calendar', 'tasks', 'timer'], active: 'calendar' }),
  mediaView: Object.freeze({ active: 'media' }),
  topbarHidden: false,
});

const CALENDAR_FEED_PALETTE = Object.freeze(['#1ed760', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6']);

// Individually toggleable weather fields (hero chips + detail metrics); mirror of
// the client list. Hiding one removes it from both the tile and the modal.
const WEATHER_FIELD_IDS = Object.freeze([
  'feels', 'wind', 'rain',
  'aqi', 'humidity', 'pm25', 'pm10', 'no2', 'pollen', 'pressure', 'visibility', 'uv', 'clouds',
]);
const WEATHER_FIELDS_ALL_ON = Object.freeze(
  WEATHER_FIELD_IDS.reduce((acc, id) => { acc[id] = true; return acc; }, {}),
);

const DEFAULT_HUB_SETTINGS = Object.freeze({
  appearance: 'dark',
  autoPalette: false,
  styleMode: 'glass', // 'glass' | 'retro' | 'comic' — dashboard style language (Pixel Retro / Comic Book skins)
  retroScanlines: true, // retro-only CRT scanline overlay sub-toggle
  accent: '#1ed760',
  dynamicAlbumTheme: true, // tint the accent from the now-playing album art
  background: '#070808',
  surface: null,
  surfaceAlt: null,
  controlColor: null,
  text: '#f0f3f1',
  accentText: null,
  successColor: null,
  warningColor: null,
  dangerColor: null,
  infoColor: null,
  contrastGuard: true,
  panelAlpha: 0.94,
  bgDim: 0.48,
  bgBlur: 0,
  idleAnimationPause: true, // pause ambient FX + decorative loops when idle (client-applied)
  // Extended theme tokens (full Aspetto editor). Defaults reproduce the stock
  // Liquid Glass look; the client applies them (glass-only). Mirror of settings.js.
  uiRoundness: 1,
  glassBlur: 22,
  glassSaturate: 160,
  panelBorderStrength: 1,
  panelShadowStrength: 1,
  mutedText: null,
  lineColor: null,
  backgroundMedia: null,
  uiFont: null,
  lockWidgets: Object.freeze({ clock: true, weather: true, media: true, calendar: true }),
  // Ambient / Screensaver mode (client mirror in js/settings.js — keep in step).
  ambientMode: Object.freeze({ enabled: true, idleMinutes: 0, sceneId: 'builtin' }),
  // Native canvas Ambient scenes (client-owned, like customThemes).
  ambientScenes: Object.freeze([]),
  contentInstalls: Object.freeze([]),
  weather: Object.freeze({ mode: 'auto', city: '', provider: 'auto', refreshMin: 30, forecastDays: 3, tile: Object.freeze({ metrics: true, hourly: true, forecast: true, fields: WEATHER_FIELDS_ALL_ON }) }),
  tempUnit: 'c', // 'c' | 'f' — weather temperature display unit
  clockFormat: 'auto', // 'auto' | '12' | '24' — auto follows the UI language
  topbarStyle: 'full', // 'full' | 'minimal' — minimal docks the topbar actions into collapsible edge rails
  // Minimal-mode edge-rail drawer positions (true = collapsed). Persisted here —
  // not browser-local — so the kiosk remembers the choice across launches and a
  // WebView storage reset; both default closed so the rails never open on their own.
  topbarRails: Object.freeze({ left: true, right: true }),
  // Minimal-mode edge rails auto-hide after ~10s of no interaction, revealed again
  // by a touch at the screen edge. Default on; off keeps them always on screen.
  topbarRailsAutoHide: true,
  // Minimal-island personalization (Settings → Aspetto → Barra superiore).
  // align: island anchor (centre/left/right). items: the island segments in
  // display order, each with a hidden flag. Full-bar mode ignores this entirely.
  // Defaults reproduce the classic centred island with every segment shown.
  topbarClock: Object.freeze({
    align: 'center',
    items: Object.freeze([
      Object.freeze({ id: 'time', hidden: false }),
      Object.freeze({ id: 'date', hidden: false }),
      Object.freeze({ id: 'weather', hidden: false }),
      Object.freeze({ id: 'vitals', hidden: false }),
      Object.freeze({ id: 'dots', hidden: false }),
    ]),
  }),
  weekStart: 'mon', // 'mon' | 'sun' — calendar first day of week
  swipeNavigation: true, // drag / finger-swipe to change dashboard page
  // Native app only: quick up-swipe from the bottom of the screen collapses the
  // kiosk to a slim strip and reveals the Windows desktop (native-bridge.js).
  swipeHomeGesture: true,
  // Native app only: interface scale (in-page CSS zoom) applied by native-bridge.js,
  // independent of the Windows display scale. 1 = 100%.
  nativeZoom: 1,
  // Native app only: hide the kiosk window while the machine is used over RDP
  // (monitor.rs watches SM_REMOTESESSION; native-bridge.js relays the toggle).
  hideOnRdp: false,
  // Open the dashboard in the default browser at Windows logon. The user's
  // intent (default on); the actual scheduled task is registered/removed by
  // /startup/auto-open and only ever for real-browser use, never Xeneon Edge.
  autoOpenBrowser: true,
  // Opt-in ad-blocker for the Browser tile (Settings → Browser). OFF by default;
  // when on, the server loads an unpacked uBOL MV3 extension into the tile's Edge.
  browserAdblock: false,
  dashboardLayout: DEFAULT_DASHBOARD_LAYOUT,
  dashboardLayoutVersion: DASHBOARD_LAYOUT_VERSION,
  geminiApiKey: '',
  obsHost: '',
  obsPort: 4455,
  obsPassword: '',
  obsAutoLaunch: true,
  streamerbotHost: '',
  streamerbotPort: 8080,
  streamerbotPassword: '',
  aiProvider: 'gemini', // 'gemini' | 'ollama' | 'openai' | 'anthropic' — selected AI backend
  ollamaModel: 'auto',  // 'auto' | whitelist key | custom model tag
  ollamaUrl: 'http://localhost:11434',
  // ChatGPT (OpenAI) + Claude (Anthropic): server-mediated cloud providers. Keys
  // are SERVER-ONLY (redacted on the wire; see ai-provider-creds.js), unlike the
  // browser-shipped geminiApiKey. Models are user-overridable.
  openaiApiKey: '',
  openaiModel: aiOpenai.DEFAULT_CHAT_MODEL,
  anthropicApiKey: '',
  anthropicModel: aiAnthropic.DEFAULT_CHAT_MODEL,
  hardwareScan: null,   // { ram, vram, cores, tier, recommended } — populated by /api/ai-local/scan
  aiTtsEnabled: true,
  aiMicSensitivity: 50, // 0..100 slider — maps to the STT input gain (see _sttGain)
  aiChatHidden: false,
  // Persistent AI memory — durable facts Xenon remembers about the user across
  // sessions (data/ai-memory.json). ON by default; fully local, viewable and
  // clearable in Settings → Funzioni AI.
  aiMemory: true,
  // Advanced reasoning — route TEXT chat turns to the stronger (slower) model.
  // OFF by default; voice turns always stay on the fast model.
  aiProReasoning: false,
  // Voce Live (Gemini Live realtime, full-duplex voice) — OFF by default (beta;
  // uses more Gemini quota, needs a Live-capable key). The turn-based voice path
  // stays the default + fallback.
  aiLiveVoice: false,
  // Voice chat presentation: false = full opaque "room" (default); true = ambient
  // (dashboard stays visible, only the screen edge glows, captions in a glass strip).
  aiVoiceAmbient: false,
  // Opt-in advanced AI features (Settings → Funzioni AI) — all OFF by default.
  aiFeatures: Object.freeze({ enabled: false, genesis: false, gameCompanion: false, guardian: false, ambient: false }),
  // Opt-in local sensor history (CPU/GPU load+temp, RAM over time). OFF by
  // default; independent of the AI Guardian feature (which also consumes it).
  // When on, collection runs even without any AI; the data never leaves the PC.
  sensorHistory: Object.freeze({ enabled: false }),
  // Proactive moments (Settings → Performance → Momenti proattivi). Deterministic,
  // bounded, individually toggleable: sustained-thermal alerts, game-session
  // recaps, and the morning-agenda briefing inside the greeting splash.
  proactive: Object.freeze({ thermal: true, recap: true, morning: true, anomaly: true }),
  // Master notifications switch (Settings → Notifiche). ON by default, but the
  // individual sources below are still OFF by default — this just lets the user
  // silence EVERYTHING (pop-ups + feeds) and stop the background watchers in one
  // place. `popups` alone keeps the feeds but suppresses the on-screen toasts;
  // `sounds` alone silences the per-pop-up cue (client-played, WebAudio).
  notifications: Object.freeze({ enabled: true, popups: true, sounds: true }),
  // Discord notification mirroring (Settings → Streaming → Discord). OFF by
  // default — it's privacy-touching, and enabling it requests the extra
  // rpc.notifications.read scope, which means a one-time Discord re-link.
  // Notifications are read from the local desktop client and never leave the PC.
  discordNotifications: Object.freeze({ enabled: false, hide: false }),
  windowsNotifications: Object.freeze({ enabled: false, hide: false, toast: true, excluded: Object.freeze([]) }),
  // Local "Hey Xenon" wake word. OFF by default (privacy) — when on, the mic is
  // read locally via ffmpeg + whisper.cpp while a dashboard is open; nothing
  // leaves the PC.
  wakeWord: Object.freeze({ enabled: false }),
  bgAurora: Object.freeze({ enabled: true, intensity: 55, speed: 50 }),
  bgGrid: Object.freeze({ enabled: true, color: '#1ed760', intensity: 45, speed: 50 }),
  // Static premium background (0 animations). style: none|nebulosa|prisma|halo.
  bgStatic: Object.freeze({ style: 'none', intensity: 70 }),
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
  }),
  calendarFeeds: [],
  // Stock-market (Borsa) widget + ticker. Watchlist/provider/refresh are
  // client-visible; the optional provider API keys below are server-only secrets.
  stocks: stocks.DEFAULT_STOCKS,
  twelveDataKey: '',   // optional Twelve Data key (server-only; preserve+redact)
  finnhubKey: '',      // optional Finnhub key (server-only; preserve+redact)
  // Football (Calcio) widget + ticker. teams/refresh are client-visible; the
  // optional TheSportsDB Premium key below is a server-only secret.
  football: football.DEFAULT_FOOTBALL,
  sportsDbKey: '',     // optional TheSportsDB Premium key (server-only; preserve+redact)
  // News widget + ticker. feeds/refresh are client-visible; the optional
  // NewsData.io key below is a server-only secret.
  news: news.DEFAULT_NEWS,
  newsDataKey: '',     // optional NewsData.io key (server-only; preserve+redact)
  // Claude Code usage ("Xenon Pulse") widget. Reads local ~/.claude transcripts;
  // no keys, no network. Only the plan/budget config is persisted here.
  claude: claudeUsage.DEFAULT_CLAUDE,
  // Scrolling ticker bar (news/stocks/football). Bottom edge by default,
  // configurable to the top or hidden. Freezes automatically in game/perf mode.
  ticker: Object.freeze({ enabled: false, position: 'bottom', speed: 50, sources: Object.freeze({ stocks: true, football: true, news: true }) }),
  // Home Assistant Smart Home bridge. url/entities are client-visible; `token`
  // (a long-lived access token) is a server-only secret (preserve-on-save +
  // redact-on-wire). `entities` = the entity_ids the Smart Home tile shows.
  homeAssistant: Object.freeze({ url: '', token: '', entities: [] }),
  // UniFi Protect cameras. host/username/cameras (the selection to display) are
  // client-managed; the console `password` is a server-only secret (redacted on
  // the wire, restored on save). Mirror of settings.js.
  unifi: Object.freeze({ host: '', username: '', password: '', cameras: [], columns: 0, fit: 'cover', aspect: '16:9', order: [], refreshMs: 1500, angles: {}, notify: Object.freeze({ enabled: false, types: Object.freeze({ person: true, vehicle: true, package: false, animal: false, motion: false, ring: true }), cooldownSec: 45 }) }),
  remoteControl: Object.freeze({ enabled: false, sunshineInstalled: false, tailscaleInstalled: false, sunshineUser: '', sunshinePass: '', selectedMonitors: [], selectedScreen: '' }),
  language: '', // '' = follow the browser; a WEATHER_LANGS code persists the user's chosen UI language across browser-storage resets
});

// In-memory mirror of the hub settings — the wake loop reads it on every clip and
// must not hit the disk that often. Populated at startup and on every POST.
let _serverHubSettings = { ...DEFAULT_HUB_SETTINGS };

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeHex(value, fallback) {
  const raw = String(value || '').trim();
  const short = raw.match(/^#?([0-9a-f]{3})$/i);
  if (short) return '#' + short[1].split('').map(ch => ch + ch).join('').toLowerCase();
  const full = raw.match(/^#?([0-9a-f]{6})$/i);
  return full ? '#' + full[1].toLowerCase() : fallback;
}

// Mirror of the client sanitizeBackgroundMedia. A pasted-SVG wallpaper is stored
// inline as a bounded base64 data:image/svg+xml URI (rendered only as an <img>
// source — secure static mode, no scripts); anything else must be a
// server-generated /uploads/ path.
const BG_SVG_DATA_RE = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/;
const BG_SVG_MAX_CHARS = 512 * 1024;
function sanitizeSettingsBackgroundMedia(value) {
  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || '').trim();
  const name = String(value.name || '').trim().slice(0, 120);
  const type = String(value.type || '').trim().slice(0, 60);
  const version = String(value.version || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  if (url.startsWith('data:')) {
    if (url.length > BG_SVG_MAX_CHARS || !BG_SVG_DATA_RE.test(url)) return null;
    return { url, name: name || 'svg', type: 'image/svg+xml', version };
  }
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return null;
  if (!/^(image|video)\//.test(type)) return null;
  return { url, name: name || url.split('/').pop(), type, version };
}

// The custom UI font reference mirrors backgroundMedia: only a server-generated
// /uploads/ path with a known font extension is kept; anything else resets to
// "use the default typeface". The binary itself lives in UPLOADS_DIR.
function sanitizeSettingsUiFont(value) {
  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || '').trim();
  const name = String(value.name || '').trim().slice(0, 120);
  const version = String(value.version || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return null;
  const ext = url.slice(url.lastIndexOf('.')).toLowerCase();
  if (!FONT_MIME_BY_EXT.has(ext)) return null;
  return { url, name: name || url.split('/').pop(), version };
}

function normalizeLockWidgets(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.lockWidgets;
  return {
    clock: source.clock !== undefined ? !!source.clock : defaults.clock,
    weather: source.weather !== undefined ? !!source.weather : defaults.weather,
    media: source.media !== undefined ? !!source.media : defaults.media,
    calendar: source.calendar !== undefined ? !!source.calendar : defaults.calendar,
  };
}

// Ambient / Screensaver mode — mirror of normalizeAmbientMode in js/settings.js.
const AMBIENT_IDLE_MINUTES = new Set([0, 1, 2, 5, 10, 15, 30]);
const AMBIENT_SCENE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const AMBIENT_CANVAS_REF_RE = /^canvas:[a-z0-9][a-z0-9-]{1,40}$/;
function normalizeAmbientMode(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.ambientMode;
  const idle = Number(source.idleMinutes);
  // sceneId is 'builtin', an SDK package id, or a "canvas:<id>" reference into
  // ambientScenes — anything else resets to the default.
  const raw = typeof source.sceneId === 'string' ? source.sceneId : '';
  const sceneId = (raw === 'builtin' || AMBIENT_SCENE_ID_RE.test(raw) || AMBIENT_CANVAS_REF_RE.test(raw))
    ? raw : defaults.sceneId;
  return {
    enabled: source.enabled !== undefined ? !!source.enabled : defaults.enabled,
    idleMinutes: AMBIENT_IDLE_MINUTES.has(idle) ? idle : defaults.idleMinutes,
    sceneId,
  };
}

// Native canvas Ambient scenes — client-owned array (like customThemes). The
// server round-trips a bounded copy so scenes survive a restart; the client
// deep-normalizes through the shared AmbientScene module on hydrate (the
// security edge — text→textContent, image-src allowlist, SDK grants), so here
// we only cap the count and per-scene byte size against a hostile blob.
function sanitizeAmbientScenes(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const scene of value) {
    if (out.length >= 64) break;
    if (!scene || typeof scene !== 'object') continue;
    try {
      const json = JSON.stringify(scene);
      if (!json || json.length > 400000) continue;   // ~400KB/scene ceiling
      out.push(JSON.parse(json));
    } catch { /* unserializable → drop */ }
  }
  return out;
}

function normalizeSettingsWeather(value) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = source.mode === 'manual' ? 'manual' : DEFAULT_HUB_SETTINGS.weather.mode;
  const provider = WEATHER_PROVIDERS.has(source.provider) ? source.provider : DEFAULT_HUB_SETTINGS.weather.provider;
  const refreshMin = [10, 15, 30, 60, 120, 180].includes(Number(source.refreshMin))
    ? Number(source.refreshMin) : DEFAULT_HUB_SETTINGS.weather.refreshMin;
  const forecastDays = [1, 2, 3, 4, 5, 6, 7].includes(Number(source.forecastDays))
    ? Number(source.forecastDays) : DEFAULT_HUB_SETTINGS.weather.forecastDays;
  const srcTile = source.tile && typeof source.tile === 'object' ? source.tile : {};
  const defTile = DEFAULT_HUB_SETTINGS.weather.tile;
  const tile = {};
  ['metrics', 'hourly', 'forecast'].forEach(k => { tile[k] = typeof srcTile[k] === 'boolean' ? srcTile[k] : defTile[k]; });
  const srcFields = srcTile.fields && typeof srcTile.fields === 'object' ? srcTile.fields : {};
  const fields = {};
  WEATHER_FIELD_IDS.forEach(id => { fields[id] = typeof srcFields[id] === 'boolean' ? srcFields[id] : true; });
  tile.fields = fields;
  return {
    mode,
    city: sanitizeWeatherCity(source.city),
    provider,
    refreshMin,
    forecastDays,
    tile,
  };
}

function normalizeBgAurora(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.bgAurora;
  return {
    enabled: source.enabled !== false,
    intensity: clampNumber(source.intensity, 0, 100, defaults.intensity),
    speed: clampNumber(source.speed, 0, 100, defaults.speed),
  };
}

const BG_STATIC_STYLES = ['none', 'nebulosa', 'prisma', 'halo'];
function normalizeBgStatic(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.bgStatic;
  return {
    style: BG_STATIC_STYLES.includes(source.style) ? source.style : defaults.style,
    intensity: clampNumber(source.intensity, 0, 100, defaults.intensity),
  };
}

// Code-defined animated background. The code is a client-only, sandboxed-iframe
// concern (see server/js/custom-bg.js) — the server just stores it as a bounded
// string, never executes it. It may bundle its own images as data: URIs
// (assets), so a shared background is self-contained: the sandbox CSP still
// blocks every remote load. Asset validation is the required custom-bg.js
// sanitizeBgAssets — the SAME code the browser and the sandbox use, so the
// rules cannot drift between the two sides.
const BG_CUSTOM_CODE_MAX = 60000; // keep in step with CODE_MAX in js/custom-bg.js
function normalizeBgCustom(value) {
  const source = value && typeof value === 'object' ? value : {};
  const code = typeof source.code === 'string' ? source.code.slice(0, BG_CUSTOM_CODE_MAX) : '';
  const out = {
    enabled: !!source.enabled && !!code,
    name: typeof source.name === 'string' ? source.name.trim().slice(0, 60) : '',
    code,
    assets: sanitizeBgAssets(source.assets),
    // Frame-rate cap (paints per second) — rule owner is custom-bg.js, exactly
    // like the assets above, so client/server/sandbox can never drift.
    fps: sanitizeBgFps(source.fps),
  };
  // Redistribution marker: set when the background arrived via a share code, so
  // exports can be limited to the user's own creations. Cleared client-side when
  // the user replaces the code with their own.
  if (source.imported === true && code) out.imported = true;
  if (out.imported && contentInstalls.INSTALL_ID_RE.test(String(source.installId || ''))) {
    out.installId = String(source.installId);
  }
  return out;
}

// Slideshow widget config. Rules (MIME allowlist + caps + interval clamp + fit)
// are owned by js/slideshow-widget.js and shared with the client, so the two can
// never drift — exactly like sanitizeBgAssets above.
function normalizeSlideshow(value) {
  return sanitizeSlideshow(value);
}

function normalizeBgGrid(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.bgGrid;
  return {
    enabled: source.enabled !== false,
    color: normalizeHex(source.color, defaults.color),
    intensity: clampNumber(source.intensity, 0, 100, defaults.intensity),
    speed: clampNumber(source.speed, 0, 100, defaults.speed),
  };
}

function cloneDashboardLayout(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeDashboardOrder(value, fallback, maxOrder) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return fallback;
  return Math.max(0, Math.min(maxOrder, numeric));
}

function normalizeDashboardSize(value, allowedSizes, fallback) {
  return allowedSizes.includes(value) ? value : fallback;
}

// Grid geometry for a widget (drag&drop model): {x,y,w,h,visible} in cells.
// A missing fallbackItem (a widget id present in DASHBOARD_WIDGET_IDS but not in
// DEFAULT_DASHBOARD_LAYOUT.widgets) must NOT 500 the whole settings endpoint —
// degrade to a safe hidden default so the id is still normalized cleanly.
const DASHBOARD_GEOM_FALLBACK = Object.freeze({ x: 0, y: 0, w: 8, h: 8, visible: false });
function normalizeDashboardGeom(sourceItem, fallbackItem) {
  const s = sourceItem && typeof sourceItem === 'object' ? sourceItem : {};
  const fb = fallbackItem && typeof fallbackItem === 'object' ? fallbackItem : DASHBOARD_GEOM_FALLBACK;
  const intIn = (v, min, max, dfl) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dfl; };
  const out = {
    x: intIn(s.x, 0, DASHBOARD_GRID_COLUMNS - 1, fb.x),
    y: intIn(s.y, 0, DASHBOARD_GRID_MAX_ROW, fb.y),
    w: intIn(s.w, 1, DASHBOARD_GRID_COLUMNS, fb.w),
    h: intIn(s.h, 1, DASHBOARD_GRID_MAX_ROW, fb.h),
    visible: s.visible === undefined ? fb.visible : s.visible !== false,
  };
  const style = DashboardInstances.normalizeTileStyle(s.style);
  if (style) out.style = style;
  return out;
}

function normalizeDashboardItem(sourceItem, fallbackItem, maxOrder, allowedSizes) {
  const source = sourceItem && typeof sourceItem === 'object' ? sourceItem : {};
  return {
    order: normalizeDashboardOrder(source.order, fallbackItem.order, maxOrder),
    size: normalizeDashboardSize(source.size, allowedSizes, fallbackItem.size),
    visible: source.visible === undefined ? true : source.visible !== false,
  };
}

function sortDashboardIds(collection) {
  return Object.keys(collection).sort((left, right) => {
    const diff = collection[left].order - collection[right].order;
    return diff || left.localeCompare(right);
  });
}

function reindexDashboardCollection(collection) {
  sortDashboardIds(collection).forEach((id, index) => { collection[id].order = index; });
}

const DASHBOARD_PAGES_MAX = 8;
function normalizeDashboardPages(value) {
  const seed = cloneDashboardLayout(DEFAULT_DASHBOARD_LAYOUT.pages);
  if (!Array.isArray(value)) return seed;
  const out = [];
  const seen = new Set();
  value.forEach(p => {
    if (!p || typeof p !== 'object') return;
    const id = String(p.id || '').trim().slice(0, 64);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const page = { id, name: String(p.name == null ? '' : p.name).trim().slice(0, 40) };
    if (p.nameKey) page.nameKey = String(p.nameKey).slice(0, 64);
    if (p.imported === true) page.imported = true;   // arrived via a shared preset → not re-exportable
    if (page.imported && contentInstalls.INSTALL_ID_RE.test(String(p.installId || ''))) page.installId = String(p.installId);
    out.push(page);
  });
  return out.length ? out.slice(0, DASHBOARD_PAGES_MAX) : seed;
}

function normalizeDashboardGroups(value, widgets, pageIds, copies) {
  const copyIds = new Set((Array.isArray(copies) ? copies : []).map(c => c.id));
  const isInstance = (m) => (widgets && widgets[m]) || copyIds.has(m);
  const out = {};
  const src = value && typeof value === 'object' ? value : {};
  const used = new Set();
  Object.keys(src).forEach(gid => {
    const g = src[gid] && typeof src[gid] === 'object' ? src[gid] : {};
    let members = Array.isArray(g.members) ? g.members.filter(m => isInstance(m) && !used.has(m)) : [];
    members = members.filter((m, i) => members.indexOf(m) === i);
    if (members.length < 2) return;
    members.forEach(m => used.add(m));
    const id = String(gid).slice(0, 64);
    out[id] = {
      id, members,
      active: members.includes(g.active) ? g.active : members[0],
      x: Math.max(0, Math.round(Number(g.x)) || 0),
      y: Math.max(0, Math.round(Number(g.y)) || 0),
      w: Math.max(1, Math.round(Number(g.w)) || 8),
      h: Math.max(1, Math.round(Number(g.h)) || 8),
      page: pageIds.includes(g.page) ? g.page : pageIds[0],
      seeded: g.seeded === true,
      autoTabByMedia: g.autoTabByMedia === true,
    };
    const style = DashboardInstances.normalizeTileStyle(g.style);
    if (style) out[id].style = style;
  });
  return out;
}

function normalizeDashboardTabs(sourceTabs) {
  const source = sourceTabs && typeof sourceTabs === 'object' ? sourceTabs : {};
  const sourceOrder = Array.isArray(source.order) ? source.order : DEFAULT_DASHBOARD_LAYOUT.tabs.order;
  const order = sourceOrder.filter(tab => DASHBOARD_TAB_IDS.includes(tab));
  DASHBOARD_TAB_IDS.forEach(tab => { if (!order.includes(tab)) order.push(tab); });
  return {
    order,
    active: ['main', 'net', 'volume', 'mic'].includes(source.active) ? source.active : DEFAULT_DASHBOARD_LAYOUT.tabs.active,
  };
}

function normalizeCalendarTabs(source) {
  const src = source && typeof source === 'object' ? source : {};
  const srcOrder = Array.isArray(src.order) ? src.order : DEFAULT_DASHBOARD_LAYOUT.calendarTabs.order;
  const order = srcOrder.filter(tab => CALENDAR_TAB_IDS.includes(tab));
  CALENDAR_TAB_IDS.forEach(tab => { if (!order.includes(tab)) order.push(tab); });
  return {
    order,
    active: ['calendar', 'tasks', 'timer', 'notes'].includes(src.active) ? src.active : DEFAULT_DASHBOARD_LAYOUT.calendarTabs.active,
  };
}

function normalizeMediaView(source) {
  const src = source && typeof source === 'object' ? source : {};
  return {
    active: MEDIA_VIEW_IDS.includes(src.active) ? src.active : DEFAULT_DASHBOARD_LAYOUT.mediaView.active,
  };
}

// One-time unit migration: layouts saved before the 24-column grid carry no
// gridCols flag and are in 12-column units — double every geometry (widgets,
// groups, copies) so each tile keeps its exact position and size on the finer
// grid. Idempotent: the flag is stamped on the normalized output, and until the
// layout is re-saved the scaling always re-derives from the raw 12-unit source.
// Mirrors the client normalizer (js/settings.js) — keep both in sync. If the
// grid resolution ever changes again, branch on the STORED gridCols value
// (absent = 12-column) and derive the factor per source unit — never reuse
// this blanket ×2.
function scaleDashboardLayoutUnits(source) {
  if (Number(source.gridCols) === DASHBOARD_GRID_COLUMNS) return source;
  const scaleBox = (o) => {
    if (!o || typeof o !== 'object') return o;
    const out = Object.assign({}, o);
    ['x', 'y', 'w', 'h'].forEach(k => {
      const n = Number(out[k]);
      if (Number.isFinite(n)) out[k] = Math.round(n * 2);
    });
    return out;
  };
  const out = Object.assign({}, source);
  if (source.widgets && typeof source.widgets === 'object') {
    out.widgets = {};
    Object.keys(source.widgets).forEach(id => { out.widgets[id] = scaleBox(source.widgets[id]); });
  }
  if (source.groups && typeof source.groups === 'object') {
    out.groups = {};
    Object.keys(source.groups).forEach(id => { out.groups[id] = scaleBox(source.groups[id]); });
  }
  if (Array.isArray(source.copies)) out.copies = source.copies.map(scaleBox);
  return out;
}

function normalizeDashboardLayout(value) {
  const source = scaleDashboardLayoutUnits(value && typeof value === 'object' ? value : {});
  const layout = cloneDashboardLayout(DEFAULT_DASHBOARD_LAYOUT);
  const sourceWidgets = source.widgets && typeof source.widgets === 'object' ? source.widgets : {};

  DASHBOARD_WIDGET_IDS.forEach(widgetId => {
    const fb = DEFAULT_DASHBOARD_LAYOUT.widgets[widgetId];
    const geom = normalizeDashboardGeom(sourceWidgets[widgetId], fb);
    const srcPage = sourceWidgets[widgetId] && sourceWidgets[widgetId].page;
    // Keep ANY saved page id (incl. user-created pages); it's clamped to a real
    // page below against the actual page list. Validating here against the static
    // default ids would wrongly reset widgets added to a user page back to their
    // default page — making "+ add" land on the wrong page.
    geom.page = (typeof srcPage === 'string' && srcPage) ? srcPage : ((fb && fb.page) || 'dashboard');
    layout.widgets[widgetId] = geom;
  });

  Object.keys(DASHBOARD_CARD_IDS).forEach(groupId => {
    const sourceCards = source.cards && source.cards[groupId] && typeof source.cards[groupId] === 'object'
      ? source.cards[groupId]
      : {};
    DASHBOARD_CARD_IDS[groupId].forEach(cardId => {
      layout.cards[groupId][cardId] = normalizeDashboardItem(
        sourceCards[cardId],
        DEFAULT_DASHBOARD_LAYOUT.cards[groupId][cardId],
        DASHBOARD_CARD_IDS[groupId].length - 1,
        DASHBOARD_CARD_SIZES,
      );
    });
    reindexDashboardCollection(layout.cards[groupId]);
  });

  layout.pages = normalizeDashboardPages(source.pages);
  const pageIds = layout.pages.map(p => p.id);
  const firstPage = pageIds[0];
  DASHBOARD_WIDGET_IDS.forEach(widgetId => {
    if (!pageIds.includes(layout.widgets[widgetId].page)) layout.widgets[widgetId].page = firstPage;
  });

  // Extra placements (duplicated widgets). Validated against known widgets/pages.
  layout.copies = DashboardInstances.normalizeCopies(source.copies, layout.widgets, pageIds);

  // Fall back to the seeded default groups when the source has none (e.g. reset,
  // or a pre-groups saved layout) — otherwise the welcome media-group is lost.
  layout.groups = normalizeDashboardGroups(
    source.groups !== undefined ? source.groups : DEFAULT_DASHBOARD_LAYOUT.groups,
    layout.widgets, pageIds, layout.copies);

  layout.tabs = normalizeDashboardTabs(source.tabs);
  layout.calendarTabs = normalizeCalendarTabs(source.calendarTabs);
  layout.mediaView = normalizeMediaView(source.mediaView);
  layout.topbarHidden = source.topbarHidden === true;
  layout.gridCols = DASHBOARD_GRID_COLUMNS;  // units flag — see scaleDashboardLayoutUnits
  return layout;
}

// Hardware scan result is server-generated; when echoed back from the client we
// keep only the known numeric/string fields and drop anything unexpected.
function normalizeHardwareScan(value) {
  if (!value || typeof value !== 'object') return null;
  const tiers = ['incompatible', 'minimum', 'recommended', 'optimal'];
  const tier = tiers.includes(value.tier) ? value.tier : 'incompatible';
  return {
    ram: clampNumber(value.ram, 0, 4096, 0),
    vram: clampNumber(value.vram, 0, 4096, 0),
    cores: clampNumber(value.cores, 0, 512, 0),
    tier,
    recommended: aiLocal.sanitizeModel(value.recommended),
  };
}

// Mirrors the client-side normalizeAiFeatures: every flag must be exactly
// `true` to count — anything else collapses to false (opt-in by design).
function normalizeServerAiFeatures(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    enabled: v.enabled === true,
    genesis: v.genesis === true,
    gameCompanion: v.gameCompanion === true,
    guardian: v.guardian === true,
    ambient: v.ambient === true,
    pcControl: v.pcControl === true,
  };
}

// Local sensor-history opt-in (Settings → Performance). A tiny known-key rebuild
// so an unknown/malformed value collapses to the safe default (off).
function normalizeSensorHistory(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { enabled: v.enabled === true };
}

function normalizeProactive(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    thermal: v.thermal !== false,
    recap: v.recap !== false,
    morning: v.morning !== false,
    anomaly: v.anomaly !== false,
  };
}

// Master notifications switch. `enabled` (default ON) is the global gate that can
// silence every source at once and stop the background watchers; `popups` (default
// ON) keeps the feeds but suppresses on-screen toasts; `sounds` (default ON)
// toggles the client-played pop-up cue. All round-trip as booleans.
function normalizeNotifications(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { enabled: v.enabled !== false, popups: v.popups !== false, sounds: v.sounds !== false };
}

// Vitals — game-style self-care meters. Known-key rebuild, identical to the
// client normalizer (settings.js): per-vital enable + interval, plus the
// client-owned state (last-refill timestamps, XP, daily fill counter).
const VITALS_IDS = Object.freeze(['hydration', 'energy', 'stamina', 'focus', 'posture']);
const VITALS_DEFAULT_MIN = Object.freeze({ hydration: 45, energy: 180, stamina: 60, focus: 25, posture: 45 });
const VITALS_DEFAULT_ON = Object.freeze({ hydration: true, energy: true, stamina: true, focus: true, posture: false });
// Bit's escalation ladder — minutes at zero before each rung (mirror of the
// client VITALS_PET_DEFAULT_THR / core.STAGE_AT; user-tunable in Settings → Bit).
const VITALS_PET_STAGES = Object.freeze(['decay', 'gameover', 'overlay', 'minimize', 'lock']);
const VITALS_PET_DEFAULT_THR = Object.freeze({ decay: 5, gameover: 8, overlay: 10, minimize: 15, lock: 20 });
function normalizeVitals(value) {
  const v = value && typeof value === 'object' ? value : {};
  const itemsSrc = v.items && typeof v.items === 'object' ? v.items : {};
  const stateSrc = v.state && typeof v.state === 'object' ? v.state : {};
  const lastSrc = stateSrc.last && typeof stateSrc.last === 'object' ? stateSrc.last : {};
  const items = {};
  const last = {};
  VITALS_IDS.forEach((id) => {
    const it = itemsSrc[id] && typeof itemsSrc[id] === 'object' ? itemsSrc[id] : {};
    items[id] = {
      on: typeof it.on === 'boolean' ? it.on : VITALS_DEFAULT_ON[id],
      min: Math.round(clampNumber(it.min, 5, 480, VITALS_DEFAULT_MIN[id])),
    };
    const ts = Number(lastSrc[id]);
    last[id] = Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : 0;
  });
  // Bit, the pixel guardian pet. Each rung of the nag ladder is strict opt-in:
  // the PC-invading actions (monitor popups, minimize-all, workstation lock)
  // require `=== true` — the /api/vitals/nag endpoint enforces these
  // server-side, so a forged client request can never act beyond the opt-ins.
  const petSrc = v.pet && typeof v.pet === 'object' ? v.pet : {};
  const thrSrc = petSrc.thresholds && typeof petSrc.thresholds === 'object' ? petSrc.thresholds : {};
  const thresholds = {};
  VITALS_PET_STAGES.forEach((stage) => {
    thresholds[stage] = Math.round(clampNumber(thrSrc[stage], 1, 480, VITALS_PET_DEFAULT_THR[stage]));
  });
  const pet = {
    enabled: petSrc.enabled === true,
    tone: ['soft', 'spicy', 'savage'].includes(petSrc.tone) ? petSrc.tone : 'spicy',
    effects: petSrc.effects !== false,
    sounds: petSrc.sounds !== false,
    lighting: petSrc.lighting === true,
    monitors: petSrc.monitors === true,
    minimize: petSrc.minimize === true,
    lock: petSrc.lock === true,
    quietInGame: petSrc.quietInGame !== false,
    // Where Bit lives: the floating corner sprite, a mini chip in the topbar
    // clock cluster, or both. AI roasts (Xenon AI-generated lines with offline
    // bank fallback) are strict opt-in; night quiet (23–07: Bit sleeps, never
    // escalates past decay) is on by default.
    position: ['floating', 'topbar', 'both'].includes(petSrc.position) ? petSrc.position : 'floating',
    aiRoasts: petSrc.aiRoasts === true,
    nightQuiet: petSrc.nightQuiet !== false,
    thresholds,
  };
  // Bit's durable bookkeeping (state.pet): truce (snooze/mute-today) and the
  // per-episode escalation flags, persisted so a reload can't re-fire GAME
  // OVER/minimize/lock and a truce granted on one surface holds on the others.
  // Episodes are keyed by z = the episode's zeroAt instant (a stable identity
  // across reloads and surfaces). Known-key rebuild — never spread.
  const petStSrc = stateSrc.pet && typeof stateSrc.pet === 'object' ? stateSrc.pet : {};
  const epSrc = petStSrc.ep && typeof petStSrc.ep === 'object' ? petStSrc.ep : {};
  const ep = {};
  VITALS_IDS.forEach((id) => {
    const e = epSrc[id];
    if (!e || typeof e !== 'object') return;
    const z = Number(e.z);
    if (!Number.isFinite(z) || z <= 0) return;
    ep[id] = {
      z: Math.floor(z),
      goAt: Math.max(0, Math.floor(Number(e.goAt) || 0)),
      ovAt: Math.max(0, Math.floor(Number(e.ovAt) || 0)),
      min: e.min === true,
      lock: e.lock === true,
    };
  });
  const statePet = {
    snoozeUntil: Math.round(clampNumber(petStSrc.snoozeUntil, 0, Date.now() + 24 * 3600000, 0)),
    muteDay: typeof petStSrc.muteDay === 'string' ? petStSrc.muteDay.slice(0, 10) : '',
    ep,
  };
  // Bit's long-term memory: daily self-care streak + grow-only lifetime
  // counters (fuel for contextual/AI roasts and streak praise).
  const memSrc = stateSrc.mem && typeof stateSrc.mem === 'object' ? stateSrc.mem : {};
  const mem = {
    streak: Math.round(clampNumber(memSrc.streak, 0, 100000, 0)),
    bestStreak: Math.round(clampNumber(memSrc.bestStreak, 0, 100000, 0)),
    lastFillDay: typeof memSrc.lastFillDay === 'string' ? memSrc.lastFillDay.slice(0, 10) : '',
    locksTotal: Math.round(clampNumber(memSrc.locksTotal, 0, 1e6, 0)),
    gameoversTotal: Math.round(clampNumber(memSrc.gameoversTotal, 0, 1e6, 0)),
  };
  return {
    enabled: v.enabled !== false,
    topbar: v.topbar === true,
    reminders: v.reminders !== false,
    // Freeze the meters while the user is away from the PC (no real input for
    // 5+ min, via the server idle probe) and resume exactly where they were.
    awayPause: v.awayPause !== false,
    pet,
    items,
    state: {
      last,
      xp: Math.round(clampNumber(stateSrc.xp, 0, 1e9, 0)),
      day: typeof stateSrc.day === 'string' ? stateSrc.day.slice(0, 10) : '',
      fills: Math.round(clampNumber(stateSrc.fills, 0, 100000, 0)),
      // Today's refills in order (the widget's "combo ribbon"); bounded.
      log: Array.isArray(stateSrc.log) ? stateSrc.log.filter(x => VITALS_IDS.includes(x)).slice(-40) : [],
      // freezeStart identity of the last credited away period (see
      // vitals-pet-core.awayCredit) — merged as max server-side.
      awayCreditAt: Math.max(0, Math.floor(Number(stateSrc.awayCreditAt) || 0)),
      pet: statePet,
      mem,
    },
  };
}

// Discord notification mirroring — privacy-touching, so OFF by default (unknown/
// malformed collapses to off). `hide` masks each notification's text until tapped.
function normalizeDiscordNotifications(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { enabled: v.enabled === true, hide: v.hide === true };
}

// Windows notification mirroring — same privacy posture as the Discord feed
// (off by default, unknown collapses to off). `excluded` is the per-app mute
// list: {id, name} entries where id is the app's AUMID (or its display name
// when the toast carries no AUMID) — a bounded known-key rebuild, never a
// spread of persisted input.
function normalizeWindowsNotifications(value) {
  const v = value && typeof value === 'object' ? value : {};
  const excluded = [];
  if (Array.isArray(v.excluded)) {
    for (const e of v.excluded.slice(0, 100)) {
      const id = String((e && e.id) || '').slice(0, 200).trim();
      if (!id) continue;
      excluded.push({ id, name: String((e && e.name) || '').slice(0, 200) });
    }
  }
  // `toast` (default on) is client-presentation only — round-tripped so it
  // survives a restart; the server never acts on it.
  return { enabled: v.enabled === true, hide: v.hide === true, toast: v.toast !== false, excluded };
}

// Local "Hey Xenon" wake word — strict opt-in (privacy: enabling means the
// server keeps the microphone open while a dashboard is on screen).
function normalizeWakeWord(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { enabled: v.enabled === true };
}

// Minimal-mode edge-rail drawer state (true = collapsed). Both sides default
// collapsed (closed) so a fresh install / storage reset never opens them on its
// own — an explicit `false` (the user opened that rail) is what re-opens it.
function normalizeTopbarRails(value) {
  const v = value && typeof value === 'object' ? value : {};
  return { left: v.left !== false, right: v.right !== false };
}

// Minimal-island personalization: anchor + ordered segment list with hidden
// flags. Rebuild from the canonical id set (drop unknown/dupes, append missing
// in default order) — never spread untrusted input. Migrates the earlier
// {date,weather} booleans onto their items when `items` is absent.
const TOPBAR_ISLAND_IDS = ['time', 'date', 'weather', 'vitals', 'dots', 'badges'];
function normalizeTopbarClock(value) {
  const v = value && typeof value === 'object' ? value : {};
  const align = ['center', 'left', 'right'].includes(v.align) ? v.align : 'center';
  const legacyHidden = {};
  if (!Array.isArray(v.items)) {
    if (v.date === false) legacyHidden.date = true;
    if (v.weather === false) legacyHidden.weather = true;
  }
  const seen = new Set();
  const items = [];
  if (Array.isArray(v.items)) {
    for (const it of v.items) {
      const id = it && typeof it === 'object' ? it.id : null;
      if (!TOPBAR_ISLAND_IDS.includes(id) || seen.has(id)) continue;
      seen.add(id);
      items.push({ id, hidden: it.hidden === true });
    }
  }
  for (const id of TOPBAR_ISLAND_IDS) {
    if (seen.has(id)) continue;
    items.push({ id, hidden: legacyHidden[id] === true });
  }
  return { align, items };
}

// Scrolling ticker bar config: enabled, edge position, marquee speed and which
// data sources feed it. Known-key rebuild (no untrusted spread).
function normalizeTicker(value) {
  const v = value && typeof value === 'object' ? value : {};
  const src = v.sources && typeof v.sources === 'object' ? v.sources : {};
  return {
    enabled: v.enabled === true,
    position: v.position === 'top' ? 'top' : 'bottom',
    speed: clampNumber(v.speed, 10, 100, 50),
    sources: {
      stocks: src.stocks !== false,
      football: src.football !== false,
      news: src.news !== false,
    },
  };
}

// Elgato Wave Link config: opt-in enable + optional pinned port (0 = auto-scan
// the 1824..1834 range). No secrets — the local WS is unauthenticated.
function normalizeWaveLinkSettings(v) {
  const s = v && typeof v === 'object' ? v : {};
  const port = parseInt(s.port, 10);
  return { enabled: s.enabled === true, port: (port >= 1 && port <= 65535) ? port : 0 };
}

function normalizeHubSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  // One-time migration: saved layouts older than the current version are
  // replaced with the new default on upgrade (other settings preserved).
  const layoutVersion = Number(source.dashboardLayoutVersion) || 0;
  const resetLayout = layoutVersion < DASHBOARD_LAYOUT_VERSION;
  return {
    appearance: ['light', 'dark', 'auto'].includes(source.appearance) ? source.appearance : DEFAULT_HUB_SETTINGS.appearance,
    autoPalette: source.autoPalette === true || (source.autoPalette == null && source.appearance === 'auto'),
    styleMode: ['glass', 'retro', 'comic'].includes(source.styleMode) ? source.styleMode : 'glass',
    retroScanlines: source.retroScanlines !== false,
    accent: normalizeHex(source.accent, DEFAULT_HUB_SETTINGS.accent),
    // Album-art accent toggle. Must be round-tripped here (mirrors the client's
    // normalizeSettings): without it the known-key rebuild strips a saved `false`,
    // so the feature re-enabled itself on every restart. Default ON via !== false.
    dynamicAlbumTheme: source.dynamicAlbumTheme !== false,
    background: normalizeHex(source.background, DEFAULT_HUB_SETTINGS.background),
    surface: normalizeHex(source.surface, null),
    surfaceAlt: normalizeHex(source.surfaceAlt, null),
    controlColor: normalizeHex(source.controlColor, null),
    text: normalizeHex(source.text, DEFAULT_HUB_SETTINGS.text),
    accentText: normalizeHex(source.accentText, null),
    successColor: normalizeHex(source.successColor, null),
    warningColor: normalizeHex(source.warningColor, null),
    dangerColor: normalizeHex(source.dangerColor, null),
    infoColor: normalizeHex(source.infoColor, null),
    // Dual-palette theme ({ light, dark }). Both sides persist the field, so both
    // rebuild it through the same engine — otherwise a restart, another surface or
    // a backup restore would strip or corrupt the pair.
    paletteVariants: themePalette.normalizeVariants(source.paletteVariants),
    contrastGuard: source.contrastGuard !== false,
    panelAlpha: clampNumber(source.panelAlpha, SETTINGS_MIN_PANEL_ALPHA, 1, DEFAULT_HUB_SETTINGS.panelAlpha),
    bgDim: clampNumber(source.bgDim, 0.05, 0.9, DEFAULT_HUB_SETTINGS.bgDim),
    bgBlur: clampNumber(source.bgBlur, 0, 24, DEFAULT_HUB_SETTINGS.bgBlur),
    idleAnimationPause: source.idleAnimationPause !== false,
    uiRoundness: clampNumber(source.uiRoundness, 0, 2, DEFAULT_HUB_SETTINGS.uiRoundness),
    glassBlur: clampNumber(source.glassBlur, 0, 40, DEFAULT_HUB_SETTINGS.glassBlur),
    glassSaturate: clampNumber(source.glassSaturate, 100, 220, DEFAULT_HUB_SETTINGS.glassSaturate),
    panelBorderStrength: clampNumber(source.panelBorderStrength, 0, 2, DEFAULT_HUB_SETTINGS.panelBorderStrength),
    panelShadowStrength: clampNumber(source.panelShadowStrength, 0, 2, DEFAULT_HUB_SETTINGS.panelShadowStrength),
    mutedText: normalizeHex(source.mutedText, null),
    lineColor: normalizeHex(source.lineColor, null),
    backgroundMedia: sanitizeSettingsBackgroundMedia(source.backgroundMedia),
    uiFont: sanitizeSettingsUiFont(source.uiFont),
    lockWidgets: normalizeLockWidgets(source.lockWidgets),
    ambientMode: normalizeAmbientMode(source.ambientMode),
    weather: normalizeSettingsWeather(source.weather),
    tempUnit: source.tempUnit === 'f' ? 'f' : 'c',
    clockFormat: ['auto', '12', '24'].includes(source.clockFormat) ? source.clockFormat : 'auto',
    topbarStyle: source.topbarStyle === 'minimal' ? 'minimal' : 'full',
    topbarRails: normalizeTopbarRails(source.topbarRails),
    topbarRailsAutoHide: source.topbarRailsAutoHide !== false,
    topbarClock: normalizeTopbarClock(source.topbarClock),
    weekStart: ['mon', 'sun'].includes(source.weekStart) ? source.weekStart : 'mon',
    swipeNavigation: source.swipeNavigation !== false,
    swipeHomeGesture: source.swipeHomeGesture !== false,
    nativeZoom: clampNumber(source.nativeZoom, 0.6, 1.6, DEFAULT_HUB_SETTINGS.nativeZoom),
    hideOnRdp: source.hideOnRdp === true,
    autoOpenBrowser: source.autoOpenBrowser !== false,
    browserAdblock: source.browserAdblock === true,
    dashboardLayout: resetLayout
      ? cloneDashboardLayout(DEFAULT_DASHBOARD_LAYOUT)
      : normalizeDashboardLayout(source.dashboardLayout),
    dashboardLayoutVersion: DASHBOARD_LAYOUT_VERSION,
    // Client-owned saved presets (widget/tab-group/page templates). Re-validated
    // by the client (DashboardPresets); the server just round-trips a bounded
    // array so they survive a restart instead of being stripped.
    dashboardPresets: sanitizeDashboardPresets(source.dashboardPresets),
    // Client-owned imported themes (Aspetto → Temi gallery). Re-validated on the
    // client (normalizeCustomThemes); the server just round-trips a bounded array
    // so they survive a restart instead of being stripped.
    customThemes: sanitizeCustomThemes(source.customThemes),
    ambientScenes: sanitizeAmbientScenes(source.ambientScenes),
    contentInstalls: contentInstalls.normalizeContentInstalls(source.contentInstalls),
    geminiApiKey: String(source.geminiApiKey || '').trim().slice(0, 200),
    obsHost: String(source.obsHost || '').trim().slice(0, 200),
    obsPort: Math.max(1, Math.min(65535, parseInt(source.obsPort, 10) || 4455)),
    obsPassword: String(source.obsPassword || '').slice(0, 200),
    obsAutoLaunch: typeof source.obsAutoLaunch === 'boolean' ? source.obsAutoLaunch : true,
    streamerbotHost: String(source.streamerbotHost || '').trim().slice(0, 200),
    streamerbotPort: Math.max(1, Math.min(65535, parseInt(source.streamerbotPort, 10) || 8080)),
    streamerbotPassword: String(source.streamerbotPassword || '').slice(0, 200),
    // Per-instance Browser-widget URLs (client-owned). Round-tripped so they
    // survive a browser-storage reset; the relay re-validates before navigating.
    browserTiles: normalizeServerBrowserTiles(source.browserTiles),
    // Global Browser-widget favorites (client-owned). Round-tripped so the shared
    // quick-access list survives a browser-storage reset; the relay re-validates
    // http/https before navigating.
    browserFavorites: normalizeServerBrowserFavorites(source.browserFavorites),
    // App-switcher favorites (client-owned). Round-tripped so starred apps survive a
    // browser-storage reset; /windows/launch re-validates the path before launching.
    appFavorites: normalizeServerAppFavorites(source.appFavorites),
    aiProvider: aiLocal.sanitizeProvider(source.aiProvider),
    ollamaModel: aiLocal.sanitizeModel(source.ollamaModel),
    ollamaUrl: aiLocal.sanitizeOllamaUrl(source.ollamaUrl),
    // ChatGPT (OpenAI) + Claude (Anthropic). Keys are server-only secrets
    // (preserve-on-save + redact-on-wire, see the secrets chain below); models
    // are validated by each provider module.
    openaiApiKey: String(source.openaiApiKey || '').trim().slice(0, 200),
    openaiModel: aiOpenai.sanitizeModel(source.openaiModel),
    anthropicApiKey: String(source.anthropicApiKey || '').trim().slice(0, 200),
    anthropicModel: aiAnthropic.sanitizeModel(source.anthropicModel),
    hardwareScan: normalizeHardwareScan(source.hardwareScan),
    aiTtsEnabled: source.aiTtsEnabled !== false,
    aiMicSensitivity: clampNumber(source.aiMicSensitivity, 0, 100, DEFAULT_HUB_SETTINGS.aiMicSensitivity),
    aiChatHidden: source.aiChatHidden === true,
    aiMemory: source.aiMemory !== false, // persistent AI memory — ON unless explicitly disabled
    aiProReasoning: source.aiProReasoning === true, // advanced reasoning — OFF unless explicitly enabled
    aiLiveVoice: source.aiLiveVoice === true, // Voce Live realtime — OFF unless explicitly enabled
    aiVoiceAmbient: source.aiVoiceAmbient === true, // ambient voice presentation — OFF (full room) unless enabled

    aiFeatures: normalizeServerAiFeatures(source.aiFeatures),
    sensorHistory: normalizeSensorHistory(source.sensorHistory),
    // User fan names for the Fans widget ("mb|Fan #3" → "Radiatore alto").
    // Client-owned but flat enough to validate explicitly at this boundary.
    fanLabels: normalizeServerFanLabels(source.fanLabels),
    proactive: normalizeProactive(source.proactive),
    notifications: normalizeNotifications(source.notifications),
    vitals: normalizeVitals(source.vitals),
    discordNotifications: normalizeDiscordNotifications(source.discordNotifications),
    windowsNotifications: normalizeWindowsNotifications(source.windowsNotifications),
    wakeWord: normalizeWakeWord(source.wakeWord),
    bgAurora: normalizeBgAurora(source.bgAurora),
    bgGrid: normalizeBgGrid(source.bgGrid),
    bgStatic: normalizeBgStatic(source.bgStatic),
    bgCustom: normalizeBgCustom(source.bgCustom),
    slideshow: normalizeSlideshow(source.slideshow),
    lighting: normalizeLighting(source.lighting),
    calendarFeeds: icsFeeds.normalizeCalendarFeeds(source.calendarFeeds, CALENDAR_FEED_PALETTE),
    stocks: stocks.normalizeStocks(source.stocks),
    twelveDataKey: String(source.twelveDataKey || '').trim().slice(0, 120),
    finnhubKey: String(source.finnhubKey || '').trim().slice(0, 120),
    football: football.normalizeFootball(source.football),
    sportsDbKey: String(source.sportsDbKey || '').trim().slice(0, 60),
    news: news.normalizeNews(source.news),
    newsDataKey: String(source.newsDataKey || '').trim().slice(0, 120),
    claude: claudeUsage.normalizeClaude(source.claude),
    ticker: normalizeTicker(source.ticker),
    homeAssistant: normalizeHomeAssistant(source.homeAssistant),
    unifi: normalizeUnifi(source.unifi),
    // Razer Chroma / Elgato Wave Link — local hardware SDKs, opt-in (no secrets,
    // just an enable flag; Wave Link optionally pins a port, 0 = auto-scan).
    chroma: { enabled: !!(source.chroma && source.chroma.enabled === true) },
    // SignalRGB scene switcher — opt-in enable flag (Windows-only; no secrets).
    signalrgb: { enabled: !!(source.signalrgb && source.signalrgb.enabled === true) },
    wavelink: normalizeWaveLinkSettings(source.wavelink),
    remoteControl: normalizeRemoteControl(source.remoteControl),
    // Client-managed settings (the client owns their full schema and re-validates
    // on load): round-trip them so they survive a server restart instead of being
    // stripped. A bounded passthrough keeps settings.json safe.
    gameMode: typeof source.gameMode === 'boolean' ? source.gameMode : true,
    performance: sanitizeServerPassthrough(source.performance),
    // Smart context profiles (client-owned schema; the client re-validates on load).
    contextProfiles: sanitizeServerPassthrough(source.contextProfiles),
    // Second-screen capture prefs (client-owned; the client re-validates on load).
    secondScreen: sanitizeServerPassthrough(source.secondScreen),
    // Third-party widget SDK: feature flag + per-tile package assignments + the
    // per-package permission grants (client-owned schema; the client re-validates
    // on load, and the bridge enforces grants before any action is dispatched).
    sdkWidgets: sanitizeServerPassthrough(source.sdkWidgets),
    // Monotonic save revision (client-owned): round-tripped so the client's
    // boot-time merge can compare it against the local copy and avoid clobbering
    // a newer local layout with a stale server one.
    rev: Number.isFinite(source.rev) && source.rev > 0 ? Math.floor(source.rev) : 0,
    // First-run tutorial state (client-owned): round-tripped so a Xeneon Edge
    // WebView localStorage wipe can't make the tour reappear every boot.
    onboarding: normalizeServerOnboarding(source.onboarding),
    // Persisted UI language ('' = follow the browser). Round-tripped so the
    // user's choice survives a browser-storage reset (e.g. a Windows restart).
    language: WEATHER_LANGS.has(source.language) ? source.language : '',
  };
}

// Mirror of the client's normalizeFanLabels (settings.js): explicit bounded
// rebuild of the flat { "<kind>|<sensor name>": "label" } rename map.
function normalizeServerFanLabels(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  let n = 0;
  for (const key of Object.keys(v)) {
    if (n >= 64) break;
    if (typeof key !== 'string' || key.length > 60 || !key.includes('|')) continue;
    const label = typeof v[key] === 'string' ? v[key].trim().slice(0, 32) : '';
    if (!label) continue;
    out[key] = label;
    n++;
  }
  return out;
}

function normalizeServerBrowserTiles(value) {
  const v = value && typeof value === 'object' ? value : {};
  const out = {};
  let n = 0;
  for (const key of Object.keys(v)) {
    if (n >= 32) break;
    if (!/^browser(~[a-z0-9]+)?$/.test(key)) continue;
    const entry = v[key];
    if (!entry || typeof entry !== 'object') continue;
    const norm = normalizeServerBrowserTileEntry(entry);
    if (!norm) continue;
    out[key] = norm;
    n++;
  }
  return out;
}

// A tile persists either the current multi-tab shape { tabs:[{url}], active } or
// the legacy single-URL shape { url }. Round-trip whichever it is — dropping the
// multi-tab shape here (keeping only { url }) wiped every tab on a settings save.
// URLs are re-validated by the relay before navigating.
function normalizeServerBrowserTileEntry(entry) {
  // chromeHidden (toolbar hidden) is a per-tile UI pref that MUST round-trip so a
  // "hide toolbar" set on one surface syncs to the others (this is the authoritative
  // copy other surfaces hydrate). It was dropped here, so the Edge kept its toolbar
  // out of step with the browser (GitHub #101).
  const chromeHidden = !!entry.chromeHidden;
  if (Array.isArray(entry.tabs)) {
    const tabs = entry.tabs.slice(0, 6).map((tb) => ({ url: String((tb && tb.url) || '').slice(0, 2048) }));
    if (!tabs.length) return null;
    if (tabs.length === 1 && !tabs[0].url && !chromeHidden) return null;
    const active = Math.max(0, Math.min(tabs.length - 1, parseInt(entry.active, 10) || 0));
    return { tabs, active, chromeHidden };
  }
  const url = String(entry.url || '').slice(0, 2048);
  return (url || chromeHidden) ? { url, chromeHidden } : null;
}

function normalizeServerBrowserFavorites(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    if (out.length >= 16) break;
    if (!entry || typeof entry !== 'object') continue;
    const url = String(entry.url || '').trim().slice(0, 2048);
    if (!url) continue;
    out.push({ label: String(entry.label || '').slice(0, 40), url });
  }
  return out;
}

// App-switcher favorites (client-owned). Round-tripped so a starred app survives a
// browser-storage reset (PC restart / new WebView profile) — the same reason the
// UI language is persisted here. Keyed by the stable app (process) NAME, one entry
// per app, keeping a cached icon + the exe path so a favorite for a CLOSED app can
// be launched (the /windows/launch endpoint re-validates the path through the
// allowlisted openApp runner before spawning). Array order IS the dock order.
function normalizeServerAppFavorites(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (out.length >= 12) break;
    if (!entry || typeof entry !== 'object') continue;
    const app = String(entry.app || '').trim().slice(0, 120);
    const key = String(entry.key || app).trim().toLowerCase().slice(0, 120);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      app,
      title: String(entry.title || '').slice(0, 200),
      // Cached window icon as a small data: URI (48px PNG ≈ a few KB); bounded so a
      // malformed payload can't bloat settings.json.
      icon: /^data:image\//.test(String(entry.icon || '')) ? String(entry.icon).slice(0, 60000) : '',
      path: String(entry.path || '').slice(0, 400),
    });
  }
  return out;
}

function normalizeServerOnboarding(value) {
  const v = value && typeof value === 'object' ? value : {};
  const seen = Number(v.seenVersion);
  return { seenVersion: Number.isFinite(seen) && seen > 0 ? Math.floor(seen) : 0 };
}

// Bounded passthrough for the client-owned saved presets array. Templates are
// small (base widget ids + geometry, no image data), so a generous size cap is
// plenty; anything bigger or malformed is dropped to an empty list.
function sanitizeDashboardPresets(value) {
  if (!Array.isArray(value)) return [];
  try {
    const json = JSON.stringify(value);
    if (json.length > 200000) return [];
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.slice(0, 60) : [];
  } catch { return []; }
}

// Client-owned imported themes: bounded round-trip (the client is authoritative
// and re-validates every field on load). A theme may embed a small font ref but
// not the font bytes, so the cap can stay tight.
function sanitizeCustomThemes(value) {
  if (!Array.isArray(value)) return [];
  try {
    const json = JSON.stringify(value);
    // A theme can carry a code-defined animated background (bgCustom.code, up to
    // 20 KB client-side) and, since assets landed, its bundled images (up to
    // ~900 KB per card). Size the cap for the 24-card ceiling with a few
    // asset-heavy cards; past it, DEGRADE by stripping the images (keeping every
    // theme + its code) instead of dropping the whole gallery on the round-trip.
    const CAP = 4000000;
    const cards = JSON.parse(json).slice(0, 24);
    if (json.length <= CAP) return cards;
    const slim = cards.map((card) => {
      if (card && typeof card === 'object' && card.bgCustom && typeof card.bgCustom === 'object') {
        // bgCustom rebuilt with known keys only (assets dropped); the rest of
        // the card stays the client-owned passthrough it always was.
        const cb = card.bgCustom;
        return {
          ...card,
          bgCustom: {
            enabled: !!cb.enabled,
            name: typeof cb.name === 'string' ? cb.name : '',
            code: typeof cb.code === 'string' ? cb.code : '',
            assets: {},
            fps: sanitizeBgFps(cb.fps),
            ...(cb.imported === true ? { imported: true } : {}),
            ...(contentInstalls.INSTALL_ID_RE.test(String(cb.installId || '')) ? { installId: String(cb.installId) } : {}),
          },
        };
      }
      return card;
    });
    // Re-check against the SAME cap — codes alone can't legitimately exceed it.
    return JSON.stringify(slim).length > CAP ? [] : slim;
  } catch { return []; }
}

// Defensive passthrough for a client-owned settings object: keep it only if it's
// a plain object that serializes within a sane size, returning a clean copy.
function sanitizeServerPassthrough(value) {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const json = JSON.stringify(value);
    if (json.length > 8000) return undefined;
    return JSON.parse(json);
  } catch { return undefined; }
}

// RGB lighting bridge config. Mirrors the client default (master OFF). Accepts
// the legacy effect-booleans and the new {enabled,color,style} event objects.
const LIGHTING_STYLES = ['blink', 'pulse', 'solid'];
const LIGHTING_ANIM_STYLES = ['none', 'solid', 'breathing', 'cycle', 'wave', 'aurora', 'candle', 'palette'];
// User palette for the 'palette' ambient style: 2–5 hex colours.
function normalizeLightingPalette(value, fallback) {
  const hexes = (Array.isArray(value) ? value : []).slice(0, 5)
    .map(h => (/^#?[0-9a-f]{6}$/i.test(String(h)) ? normalizeHex(h, null) : null))
    .filter(Boolean);
  return hexes.length >= 2 ? hexes : fallback.slice();
}
const LIGHTING_PROVIDER_IDS = ['govee', 'lifx', 'wled', 'hue', 'nanoleaf', 'openrgb', 'homeassistant', 'yeelight'];
function normalizeLightingAnimation(value, fallback) {
  const f = fallback || { style: 'none', color: '#1ed760', speed: 50, palette: ['#1ed760', '#0066ff'] };
  const v = value && typeof value === 'object' ? value : {};
  return {
    style: LIGHTING_ANIM_STYLES.includes(v.style) ? v.style : f.style,
    color: normalizeHex(v.color, f.color),
    speed: clampNumber(v.speed, 1, 100, f.speed),
    palette: normalizeLightingPalette(v.palette, f.palette || ['#1ed760', '#0066ff']),
  };
}
function normalizeLightingProviders(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const id of LIGHTING_PROVIDER_IDS) {
    const p = value[id];
    if (!p || typeof p !== 'object' || !Array.isArray(p.devices)) continue;
    const devices = p.devices.map(d => {
      const host = String(d && d.host || '').trim().slice(0, 120);
      if (!host) return null;
      const dev = {
        id: String(d.id || `${id}:${host}`).slice(0, 160),
        name: String(d && d.name || id).slice(0, 80),
        host,
        optedIn: !(d && d.optedIn === false),
      };
      if (d && d.token) dev.token = String(d.token).slice(0, 256); // pairing token (Hue/Nanoleaf)
      return dev;
    }).filter(Boolean).slice(0, 32);
    if (devices.length) out[id] = { devices };
  }
  return out;
}
const LIGHTING_DEVICE_MODES = ['follow', 'color', 'animation', 'temperature', 'album', 'off'];
// Per-device styles: no 'palette' (its colour list lives on the global animation)
// and no 'wave' (per-device renders uniform = identical to 'cycle').
const LIGHTING_ANIM_SUB = ['solid', 'breathing', 'cycle', 'aurora', 'candle'];
function normalizeLightingDeviceModes(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [id, v] of Object.entries(value)) {
    if (!v || typeof v !== 'object') continue;
    const key = String(id).slice(0, 160);
    const e = { mode: LIGHTING_DEVICE_MODES.includes(v.mode) ? v.mode : 'follow' };
    if (typeof v.color === 'string' && /^#?[0-9a-f]{6}$/i.test(v.color)) e.color = normalizeHex(v.color, '#1ed760');
    if (v.anim && typeof v.anim === 'object') {
      e.anim = {
        style: LIGHTING_ANIM_SUB.includes(v.anim.style) ? v.anim.style : 'cycle',
        color: normalizeHex(v.anim.color, '#1ed760'),
        speed: clampNumber(v.anim.speed, 1, 100, 50),
      };
    }
    out[key] = e;
  }
  return out;
}
function normalizeLightingEvent(value, fallback) {
  const f = fallback || { enabled: true, color: '#ff0000', style: 'blink', durationMs: 1800 };
  const fDur = clampNumber(f.durationMs, 500, 10000, 1800);
  if (typeof value === 'boolean') return { enabled: value, color: f.color, style: f.style, durationMs: fDur }; // legacy
  const v = value && typeof value === 'object' ? value : {};
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : f.enabled,
    color: normalizeHex(v.color, f.color),
    style: LIGHTING_STYLES.includes(v.style) ? v.style : f.style,
    durationMs: clampNumber(v.durationMs, 500, 10000, fDur),
  };
}
function normalizeLighting(value) {
  const v = value && typeof value === 'object' ? value : {};
  const d = DEFAULT_HUB_SETTINGS.lighting;
  const fx = v.effects && typeof v.effects === 'object' ? v.effects : {};
  const devices = {};
  if (v.devices && typeof v.devices === 'object') {
    for (const [k, on] of Object.entries(v.devices)) devices[String(k).slice(0, 128)] = on === true;
  }
  return {
    enabled: v.enabled === true,
    brightness: clampNumber(v.brightness, 0, 1, d.brightness),
    pauseDuringGame: v.pauseDuringGame !== false,
    devices,
    effects: {
      temperature: fx.temperature === true,
      volume: fx.volume === true,
      musicAlbum: fx.musicAlbum === true,
      timer: normalizeLightingEvent(fx.timer, d.effects.timer),
      notification: normalizeLightingEvent(fx.notification, d.effects.notification),
      reminder: normalizeLightingEvent(fx.reminder, d.effects.reminder),
      vitals: normalizeLightingEvent(fx.vitals, d.effects.vitals),
    },
    animation: normalizeLightingAnimation(v.animation, d.animation),
    manualColor: /^#[0-9a-f]{6}$/i.test(String(v.manualColor)) ? v.manualColor : '',
    providers: normalizeLightingProviders(v.providers),
    deviceModes: normalizeLightingDeviceModes(v.deviceModes),
  };
}

async function readHubSettings() {
  try {
    const raw = await fs.promises.readFile(SETTINGS_FILE, 'utf8');
    return normalizeHubSettings(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeHubSettings(settings) {
  const safe = normalizeHubSettings(settings);
  await writeFileAtomic(SETTINGS_FILE, JSON.stringify(safe, null, 2));
  // Reclaim any per-tile decoration images no surviving tile references (grace-
  // windowed so a just-uploaded asset isn't swept before its layout save lands).
  // Saved presets count as references too — inserting one must still find its images.
  cleanupUnreferencedTileAssets(safe.dashboardLayout, safe.dashboardPresets);
  return safe;
}

// ── settings store: serialized read-modify-write ────────────────────────────
// writeFileAtomic serializes the file WRITE, but every settings mutator runs
// `read prev → merge → write` as separate awaits. Two saves arriving close
// together from different surfaces (the Xeneon Edge screen, a desktop browser,
// the native app, an embedded iframe) could both read the SAME prev and the
// last writer would clobber the other's change — even the merge that keeps the
// newest per-vital timestamp only defends against a stale INCOMING, not against
// a stale PREV read during the interleave. That was the "Bit / Vitals out of
// sync across surfaces" bug (measured: 4 of 5 concurrent refills were lost, and
// two concurrent saves could even assign the same rev, breaking the monotonic
// rev the SSE cross-surface sync relies on). Run every settings mutation through
// this promise-chain mutex so each one observes the previous one's committed
// result. fn runs after the previous settles (fulfilled OR rejected), and a
// rejected run never poisons the chain.
let _hubSettingsWriteChain = Promise.resolve();
function withHubSettingsLock(fn) {
  const run = _hubSettingsWriteChain.then(fn, fn);
  _hubSettingsWriteChain = run.then(() => {}, () => {});
  return run;
}

// The Deck widget's keys live in the browser's localStorage, which the Xeneon
// Edge WebView can wipe on some restarts/updates — silently losing the user's
// programmed keys. We keep a durable server-side backup here. The store is held
// opaquely: { configs: { [instanceId]: deckConfig }, rev }. The server never
// edits the config shape (the client owns normalization via DeckModel); it only
// trusts the monotonic `rev` to resolve which copy is newer (last-writer-wins).
function normalizeDeckStore(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const configs = (src.configs && typeof src.configs === 'object' && !Array.isArray(src.configs)) ? src.configs : {};
  const rev = Number.isFinite(src.rev) ? Math.max(0, Math.floor(src.rev)) : 0;
  const savedAt = Number.isFinite(src.savedAt) ? src.savedAt : 0;
  // Per-instance revisions: a lightweight diagnostic counter applyDeckOps bumps on
  // every write. No longer used to decide a winner (the server is authoritative).
  const instanceRevs = deckStore.sanitizeInstanceRevs(src.instanceRevs);
  // Saved profile + single-key presets (client-owned shape, like configs):
  // bounded arrays round-tripped so reusable profiles/keys survive a WebView
  // storage wipe / restart.
  const presets = Array.isArray(src.presets) ? src.presets.slice(0, 60) : [];
  const keyPresets = Array.isArray(src.keyPresets) ? src.keyPresets.slice(0, 120) : [];
  return { configs, rev, savedAt, instanceRevs, presets, keyPresets };
}

async function readDeckStore() {
  try {
    const raw = await fs.promises.readFile(DECK_FILE, 'utf8');
    return normalizeDeckStore(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return { configs: {}, rev: 0, savedAt: 0, instanceRevs: {}, presets: [], keyPresets: [] };
    throw e;
  }
}

async function writeDeckStore(store) {
  const safe = normalizeDeckStore(store);
  safe.savedAt = Date.now();
  await writeFileAtomic(DECK_FILE, JSON.stringify(safe));
  return safe;
}

// ── Settings secrets — one composed helper per direction ─────────────────────
// Every server-only secret must be redacted at EVERY settings→browser exit
// (GET /settings, POST /settings response, backup export) and preserved on
// every settings write path (POST /settings, backup import). These composed
// helpers are the single place a future secret gets added — the stock/football/
// news keys were once wiped on import precisely because one hand-built chain
// missed them.
function redactSettingsSecrets(settings) {
  return redactAiProviderCreds(redactLightingTokens(redactUnifiCreds(redactNewsCreds(redactFootballCreds(redactStockCreds(redactStreamCreds(redactHaToken(redactRemoteCreds(settings)))))))));
}
function preserveSettingsSecrets(incoming, prev) {
  return preserveAiProviderCreds(preserveUnifiCreds(preserveNewsCreds(preserveFootballCreds(preserveStockCreds(preserveStreamCreds(preserveHaToken(preserveRemoteCreds(incoming, prev), prev), prev), prev), prev), prev), prev), prev);
}

// Hue/Nanoleaf pairing tokens live inside lighting.providers[].devices[].token.
// They are bridge-owned server-only secrets: blank them on the wire (a
// `tokenSet` flag keeps "paired" visible). No preserve half is needed — the
// server refills lighting.providers from the live bridge on every settings
// write (POST /settings and backup import), so a token-less round-trip can
// never wipe a pairing.
function redactLightingTokens(settings) {
  const providers = settings && settings.lighting && settings.lighting.providers;
  if (!providers || typeof providers !== 'object') return settings;
  let changed = false;
  const safe = {};
  for (const [id, p] of Object.entries(providers)) {
    if (!p || !Array.isArray(p.devices)) { safe[id] = p; continue; }
    safe[id] = {
      ...p,
      devices: p.devices.map((d) => {
        if (!d || !d.token) return d;
        changed = true;
        const { token, ...rest } = d;
        return { ...rest, tokenSet: true };
      }),
    };
  }
  return changed ? { ...settings, lighting: { ...settings.lighting, providers: safe } } : settings;
}

function hasLightingProviderTokens(settings) {
  const providers = settings && settings.lighting && settings.lighting.providers;
  if (!providers || typeof providers !== 'object') return false;
  return Object.values(providers).some((p) => p && Array.isArray(p.devices) && p.devices.some((d) => d && d.token));
}

// ── Configuration backup ──────────────────────────────────────────────────────
// Export/import of the user's configuration as ONE portable JSON file (layout,
// Deck, calendar, tasks, timers, notes, settings, AI memory, Guardian history,
// custom background). Secrets (API keys, Sunshine credentials, OBS password,
// streaming tokens) are deliberately excluded: a backup file must be safe to
// keep on a cloud drive or hand to someone. What travels instead is
// `secretsConfigured` — boolean flags only — so the import can tell the user
// exactly which services need re-configuring on the new machine. On import,
// every section goes through the same normalizers as its normal save path, so
// a tampered file can't smuggle bad shapes in. Installed third-party widget /
// Ambient-scene PACKAGES are likewise excluded (they live in DATA_DIR/widgets,
// not settings) — a lightweight `widgetsInstalled` list travels instead, driving
// a "re-import these from their codes" report (`needsWidgets`) after a restore.
const BACKUP_FORMAT = 2;             // v2: + aiMemory, guardian, background, secretsConfigured
const BACKUP_MIN_FORMAT = 1;         // v1 bundles (pre-4.0 exports) still import
const BACKUP_MAX_BYTES = 64 * 1024 * 1024;              // deck icons + an embedded background
const BACKUP_BACKGROUND_MAX_BYTES = 12 * 1024 * 1024;   // embed background images; skip large videos
const BACKUP_SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/;        // upload filenames (no slash → no traversal)

// Raw parse of the server-only OAuth token store; used ONLY to derive boolean
// "is this provider connected" flags. Token values never enter the backup.
async function _readStreamTokensSnapshot() {
  try { return JSON.parse(await fs.promises.readFile(STREAM_TOKENS_FILE, 'utf8')) || {}; }
  catch { return {}; }
}

// Which secret-backed services are configured — booleans only. Exported with
// the bundle so the import side can report "these need re-setup" precisely.
function _backupSecretFlags(settings, tokens) {
  const s = settings && typeof settings === 'object' ? settings : {};
  const tok = (name) => { const t = tokens && tokens[name]; return !!(t && (t.refreshToken || t.accessToken)); };
  return {
    gemini: !!s.geminiApiKey,
    openai: !!s.openaiApiKey,
    anthropic: !!s.anthropicApiKey,
    obs: !!s.obsPassword,
    streamerbot: !!s.streamerbotPassword,
    homeAssistant: !!(s.homeAssistant && s.homeAssistant.token),
    unifi: !!(s.unifi && s.unifi.password),
    sunshine: !!(s.remoteControl && (s.remoteControl.sunshineUser || s.remoteControl.sunshinePass)),
    twelveData: !!s.twelveDataKey,
    finnhub: !!s.finnhubKey,
    sportsDb: !!s.sportsDbKey,
    newsData: !!s.newsDataKey,
    lightingProviders: hasLightingProviderTokens(s),
    spotify: tok('spotify'),
    twitch: tok('twitch'),
    youtube: tok('youtube'),
    discord: tok('discord'),
  };
}

// The custom background binary, embedded as base64 when it is small enough
// (images; a 200MB video would dwarf the bundle — skipped, and the import then
// clears the dangling reference instead of leaving a broken background).
async function _buildBackupBackground(settings) {
  const bg = settings && settings.backgroundMedia;
  if (!bg || typeof bg !== 'object' || typeof bg.url !== 'string') return null;
  const fileName = bg.url.split('/').pop() || '';
  if (!BACKUP_SAFE_NAME_RE.test(fileName)) return null;
  try {
    const abs = path.join(UPLOADS_DIR, fileName);
    const st = await fs.promises.stat(abs);
    if (!st.isFile() || st.size > BACKUP_BACKGROUND_MAX_BYTES) return null;
    return { file: fileName, data: (await fs.promises.readFile(abs)).toString('base64') };
  } catch { return null; }
}

// The custom UI font binary, embedded as base64 (fonts are small — always well
// under FONT_MAX_BYTES — so, unlike large video backgrounds, they always travel).
async function _buildBackupFont(settings) {
  const font = settings && settings.uiFont;
  if (!font || typeof font !== 'object' || typeof font.url !== 'string') return null;
  const fileName = font.url.split('/').pop() || '';
  if (!BACKUP_SAFE_NAME_RE.test(fileName)) return null;
  try {
    const abs = path.join(UPLOADS_DIR, fileName);
    const st = await fs.promises.stat(abs);
    if (!st.isFile() || st.size > FONT_MAX_BYTES) return null;
    return { file: fileName, data: (await fs.promises.readFile(abs)).toString('base64') };
  } catch { return null; }
}

// The installed third-party widget / Ambient-scene packages, as a LIGHTWEIGHT
// manifest — id + name + origin + surface only, never the package code/assets.
// Those packages live in DATA_DIR/widgets and do NOT travel in the backup (only
// their placement in the layout does); embedding them would bloat the file and
// re-distribute other people's work. Instead this list drives a "re-install
// these from their codes" report on import (mirrors secretsConfigured →
// needsSetup). Builtin examples ship with the app, so they're skipped. This is
// informational only, so it deliberately does NOT bump BACKUP_FORMAT: an older
// importer safely ignores it, and a bundle without it yields an empty report.
async function _buildBackupWidgetList() {
  try {
    const scan = await refreshSdkScan();
    return (scan.packages || [])
      .map((p) => ({ id: p.id, name: p.name || p.id, origin: widgetOriginOf(p.id), surface: p.surface === 'ambient' ? 'ambient' : 'tile' }))
      .filter((w) => w.origin !== 'builtin');
  } catch { return []; }
}

async function buildBackup() {
  const settings = (await readHubSettings().catch(() => null)) || { ...DEFAULT_HUB_SETTINGS };
  const safeSettings = redactSettingsSecrets({ ...settings, geminiApiKey: '' });
  const notesState = await readNotes().catch(() => ({ v: 1, activeId: '', notes: [] }));
  return {
    xenonBackup: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    secretsConfigured: _backupSecretFlags(settings, await _readStreamTokensSnapshot()),
    widgetsInstalled: await _buildBackupWidgetList(),
    data: {
      settings: safeSettings,
      deck: await readDeckStore().catch(() => null),
      events: await readEvents().catch(() => []),
      tasks: await readTasks().catch(() => []),
      timers: _timers,
      // `notes` stays a flat text blob so older Xenon builds can restore this
      // backup; `notesData` carries the full multi-note structure for current builds.
      notes: notesToText(notesState),
      notesData: notesState,
      aiMemory: aiMemory.list(),
      guardian: await guardian.exportStore().catch(() => null),
      background: await _buildBackupBackground(settings),
      font: await _buildBackupFont(settings),
    },
  };
}

// Write the backup bundle to a file on disk and return its absolute path.
// Targets the user's Downloads folder (the natural place for an export); falls
// back to the home dir, then DATA_DIR, if Downloads doesn't exist. The filename
// carries date + time so repeated exports never overwrite one another.
async function saveBackupToDisk() {
  const bundle = await buildBackup();
  const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const fileName = `xenon-backup-${stamp}.json`;

  const home = os.homedir();
  const candidates = [path.join(home, 'Downloads'), home, DATA_DIR];
  let dir = DATA_DIR;
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isDirectory()) { dir = c; break; } }
    catch { /* try the next candidate */ }
  }

  const dest = path.join(dir, fileName);
  // Atomic + compact: a crash mid-export must not leave a truncated backup that
  // only fails when the user tries to restore it, and pretty-printing a bundle
  // that can embed a multi-MB background roughly doubles the work and the size.
  await writeFileAtomic(dest, JSON.stringify(bundle));
  return { ok: true, path: dest, fileName };
}

// Services the imported configuration uses whose secrets could NOT travel in
// the backup and are also absent on THIS machine — surfaced to the user after
// the import ("re-connect Spotify, re-enter the TwelveData key, …") instead of
// each feature silently failing later. v1 bundles carry no flags → empty list.
function _backupNeedsSetup(flags, settings, tokens) {
  if (!flags || typeof flags !== 'object') return [];
  const local = _backupSecretFlags(settings, tokens);
  return Object.keys(local).filter((k) => flags[k] === true && !local[k]);
}

async function applyBackup(bundle) {
  const fmt = bundle ? Number(bundle.xenonBackup) : 0;
  if (!Number.isInteger(fmt) || fmt < BACKUP_MIN_FORMAT || fmt > BACKUP_FORMAT
      || !bundle.data || typeof bundle.data !== 'object') {
    return { ok: false, error: 'bad_format' };
  }
  const d = bundle.data;
  const restored = [];
  const failed = [];
  // Each section restores independently: one bad section must not abort the
  // rest mid-sequence (the old behavior left a silent half-import), and the
  // caller gets an exact per-section report either way.
  const apply = async (name, fn) => {
    try { await fn(); restored.push(name); }
    catch (e) { console.error(`Backup restore failed for ${name}:`, e.message); failed.push(name); }
  };

  // Background binary FIRST, so the settings section below can re-point its
  // backgroundMedia reference at the restored file.
  let backgroundFile = '';      // server-generated name written on THIS machine
  let backgroundSrcName = '';   // the name the bundle's settings reference
  if (d.background && typeof d.background === 'object'
      && typeof d.background.file === 'string' && BACKUP_SAFE_NAME_RE.test(d.background.file)
      && typeof d.background.data === 'string') {
    await apply('background', async () => {
      // Same constraints as POST /background: allowlisted extension, bounded
      // size, and a SERVER-generated destination name — the name inside the
      // bundle never reaches the filesystem (the durable-upload invariant).
      const ext = ('.' + (d.background.file.split('.').pop() || '')).toLowerCase();
      if (!BACKGROUND_MIME_BY_EXT.has(ext)) throw new Error('background_type');
      const buf = Buffer.from(d.background.data, 'base64');
      if (!buf.length || buf.length > BACKUP_BACKGROUND_MAX_BYTES) throw new Error('background_too_large');
      const destName = `background-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
      await writeFileAtomic(path.join(UPLOADS_DIR, destName), buf);
      backgroundSrcName = d.background.file;
      backgroundFile = destName;
    });
  }

  // Custom UI font binary — same server-generated-name discipline as the
  // background, so the settings section can re-point uiFont at the restored file.
  let fontFile = '';       // server-generated name written on THIS machine
  let fontSrcName = '';    // the name the bundle's settings reference
  if (d.font && typeof d.font === 'object'
      && typeof d.font.file === 'string' && BACKUP_SAFE_NAME_RE.test(d.font.file)
      && typeof d.font.data === 'string') {
    await apply('font', async () => {
      const ext = ('.' + (d.font.file.split('.').pop() || '')).toLowerCase();
      if (!FONT_MIME_BY_EXT.has(ext)) throw new Error('font_type');
      const buf = Buffer.from(d.font.data, 'base64');
      if (!buf.length || buf.length > FONT_MAX_BYTES) throw new Error('font_too_large');
      const destName = `font-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
      await writeFileAtomic(path.join(UPLOADS_DIR, destName), buf);
      // Deliberately no cleanupOldFonts here (unlike POST /font): the settings
      // section below may keep an already-present font, which a sweep would delete.
      fontSrcName = d.font.file;
      fontFile = destName;
    });
  }

  if (d.settings && typeof d.settings === 'object' && !Array.isArray(d.settings)) {
    await apply('settings', async () => {
      const prev = await readHubSettings().catch(() => null);
      // Backups never carry secrets — keep EVERY one configured on THIS machine
      // (the same composed preserve helper as POST /settings; a hand-built chain
      // here once missed the stock/football/news keys and wiped them on import).
      const incoming = preserveSettingsSecrets({ ...d.settings }, prev);
      if (!incoming.geminiApiKey && prev && prev.geminiApiKey) incoming.geminiApiKey = prev.geminiApiKey;
      // lighting.providers / deviceModes are bridge-owned (and the backup's copy
      // is token-less by design) — refill from the live bridge exactly like
      // POST /settings, so an import can never wipe this machine's pairings.
      incoming.lighting = {
        ...(incoming.lighting && typeof incoming.lighting === 'object' ? incoming.lighting : {}),
        providers: lighting.getExternalConfig(),
        deviceModes: lighting.getConfig().deviceModes,
      };
      // Re-point the background reference at the file restored above, or keep it
      // only when its binary already exists here — never a broken background.
      const bgUrl = incoming.backgroundMedia && typeof incoming.backgroundMedia === 'object'
        ? String(incoming.backgroundMedia.url || '') : '';
      if (bgUrl) {
        const bgName = bgUrl.split('/').pop() || '';
        if (backgroundFile && bgName === backgroundSrcName) {
          incoming.backgroundMedia = { ...incoming.backgroundMedia, url: `/uploads/${backgroundFile}` };
        } else if (!(BACKUP_SAFE_NAME_RE.test(bgName) && fs.existsSync(path.join(UPLOADS_DIR, bgName)))) {
          incoming.backgroundMedia = null;
        }
      }
      // Same re-pointing for the custom font: adopt the restored file, keep an
      // already-present one, otherwise drop to the default typeface (never a
      // dangling font reference).
      const fontUrl = incoming.uiFont && typeof incoming.uiFont === 'object'
        ? String(incoming.uiFont.url || '') : '';
      if (fontUrl) {
        const fontName = fontUrl.split('/').pop() || '';
        if (fontFile && fontName === fontSrcName) {
          incoming.uiFont = { ...incoming.uiFont, url: `/uploads/${fontFile}` };
        } else if (!(BACKUP_SAFE_NAME_RE.test(fontName) && fs.existsSync(path.join(UPLOADS_DIR, fontName)))) {
          incoming.uiFont = null;
        }
      }
      // Bump rev past the current copy so every client's hydrate (which keeps the
      // newer rev) adopts the imported settings instead of clobbering them back.
      incoming.rev = Math.max(Number(incoming.rev) || 0, (prev && prev.rev) || 0) + 1;
      const settings = await writeHubSettings(incoming);
      _serverHubSettings = settings;
      // Same post-save hooks as POST /settings; none of them may fail the import.
      try { lighting.applyConfig(settings.lighting); }
      catch (e) { console.error('Backup lighting apply failed:', e.message); }
      refreshExternalFeeds().catch(() => {});
      refreshObsWatch();
      refreshHaWatch();
      refreshSbWatch();
      refreshUnifiEventsWatch();
      broadcastSSE('settings', { rev: settings.rev });   // other open surfaces adopt the import live
    });
  }
  if (d.deck && typeof d.deck === 'object' && !Array.isArray(d.deck)) {
    await apply('deck', async () => {
      // Bump rev past the current store so every client (including one holding a
      // newer localStorage copy) adopts the imported deck on its next hydrate.
      const cur = await readDeckStore().catch(() => null);
      const store = normalizeDeckStore(d.deck);
      store.rev = Math.max(store.rev, (cur && cur.rev) || 0) + 1;
      const saved = await writeDeckStore(store);
      broadcastSSE('deck', { rev: saved.rev });   // open dashboards re-sync the imported decks live
    });
  }
  if (Array.isArray(d.events)) await apply('events', () => writeEvents(d.events));
  if (Array.isArray(d.tasks))  await apply('tasks',  () => writeTasks(d.tasks));
  if (Array.isArray(d.timers)) {
    await apply('timers', async () => {
      _timers = d.timers.slice(0, TIMERS_MAX).map(_normalizeTimer);
      await _saveTimers();
    });
  }
  if (d.notesData && typeof d.notesData === 'object' && !Array.isArray(d.notesData)) {
    await apply('notes', () => writeNotes(d.notesData));         // structured multi-note backup
  } else if (typeof d.notes === 'string' && d.notes) {
    await apply('notes', () => writeNotes(textToNotesState(d.notes)));   // legacy flat-text backup
  }
  if (Array.isArray(d.aiMemory)) await apply('aiMemory', () => aiMemory.importFacts(d.aiMemory));
  if (d.guardian && typeof d.guardian === 'object') await apply('guardian', () => guardian.importStore(d.guardian));

  // _serverHubSettings is the maintained in-memory mirror (just updated when the
  // settings section applied) — no need to re-read the file from disk.
  const needsSetup = _backupNeedsSetup(
    bundle.secretsConfigured,
    _serverHubSettings || {},
    await _readStreamTokensSnapshot()
  );
  // SDK widget / Ambient-scene packages live in DATA_DIR/widgets and don't travel
  // in the backup — only their placement in the restored layout does. Report the
  // ones the backup listed that are NOT installed on THIS machine, so the user
  // knows to re-import them from their gallery / share codes. Absent list (a v1/v2
  // bundle, or a code-free export) → empty report.
  const listed = Array.isArray(bundle.widgetsInstalled) ? bundle.widgetsInstalled : [];
  let needsWidgets = [];
  if (listed.length) {
    let localIds = new Set();
    try { localIds = new Set((await refreshSdkScan()).packages.map((p) => p.id)); }
    catch { /* scan failure → report everything listed as missing */ }
    needsWidgets = listed
      .filter((w) => w && typeof w.id === 'string' && !localIds.has(w.id))
      .map((w) => ({
        id: String(w.id).slice(0, 60),
        name: String(w.name || w.id).slice(0, 80),
        origin: ['import', 'creator', 'local', 'builtin'].includes(w.origin) ? w.origin : 'unknown',
        surface: w.surface === 'ambient' ? 'ambient' : 'tile',
      }))
      .slice(0, 200);
  }
  const result = { ok: restored.length > 0 && failed.length === 0, restored, failed, needsSetup, needsWidgets };
  // Nothing restored at all → give the client a real error code (it shows the
  // generic import error for ok:false; without this it would be a blank reason).
  if (!restored.length) result.error = failed.length ? 'restore_failed' : 'empty_backup';
  return result;
}

// Remote Control orchestrator — getSettings reads the in-memory mirror so
// currentCreds() stays synchronous; saveSettings persists and normalises via
// writeHubSettings (which updates _serverHubSettings on the next settings read).
const remoteControl = createRemoteControl({
  getSettings: () => _serverHubSettings,
  saveSettings: (s) => withHubSettingsLock(() => writeHubSettings(s).then(safe => { _serverHubSettings = safe; return safe; })),
});
// Wire remoteControl into the Deck action dispatcher now that the orchestrator
// is available. The registry closes over deckRegistryDeps by reference, so this
// assignment is immediately visible to subsequent deckRegistry.run() calls.
deckRegistryDeps.remote = remoteControl;

// Self-update (safe two-step): prepare downloads+validates a new release into
// DATA_DIR without touching the live install; apply hands off to an external
// elevated applier. Disabled on a git checkout.
const selfUpdate = createSelfUpdate({ root: path.join(__dirname, '..'), dataDir: DATA_DIR });

// Guardian — opt-in hardware-health history. The interval only does real work
// while the user has enabled the feature in Settings → Funzioni AI; collection
// is local and free, the AI reads the digest via the guardian_report tool.
const guardian = createGuardian({
  dataDir: DATA_DIR,
  getSystemInfo,
  isEnabled: () => {
    const s = _serverHubSettings;
    // Collect when EITHER the dedicated sensor-history opt-in is on, OR the AI
    // Guardian feature is on (which reads the same history via guardian_report).
    // So existing AI-Guardian users keep collecting, and history is available on
    // its own without the AI.
    const history = !!(s && s.sensorHistory && s.sensorHistory.enabled === true);
    const f = s && s.aiFeatures;
    const aiGuardian = !!(f && f.enabled === true && f.guardian === true);
    return history || aiGuardian;
  },
  onAlert: ({ type, value }) => broadcastSSE('guardian_alert', { type, value }),
  // Foreground-app usage ("PC Screen Time"): the game detector already tracks the
  // focused process cheaply — reuse it, don't add a second probe.
  getForegroundApp: () => { try { return gameDetect.getForegroundProcess(); } catch { return ''; } },
  isForegroundGame: () => { try { return gameDetect.isGaming(); } catch { return false; } },
});

// Briefing — proactive moments (sustained-thermal alerts, game-session recaps).
// Passive: fed from the existing status/system SSE ticks below, so it does no
// work while no dashboard is connected and needs no shutdown handling. Each
// moment type is individually toggleable (Settings → Momenti proattivi).
const briefing = createBriefingEngine({
  emit: (type, data) => broadcastSSE('briefing', Object.assign({ type }, data)),
  isTypeEnabled: (type) => {
    const p = _serverHubSettings && _serverHubSettings.proactive;
    return !p || p[type] !== false;
  },
  getFps: () => fpsMonitor.getCurrentFps(),
});

// A streaming app client_id is CONFIGURATION, not committed source: resolve it
// from an env var first, then a gitignored `server/stream-config.json`, so the
// id (tied to the owner's personal Twitch/Google app) never lives in the public
// repo. Empty when unconfigured → the provider reports `configured:false`.
function readStreamClientId(configKey, envName) {
  if (process.env[envName]) return String(process.env[envName]).trim();
  try {
    const cfg = JSON.parse(fs.readFileSync(STREAM_CONFIG_FILE, 'utf8'));
    return String((cfg && cfg[configKey]) || '').trim();
  } catch { return ''; }
}

// Twitch + YouTube live integrations. Tokens persist to a server-only file
// (stream-tokens.json). `let` (not const) so the providers can be RE-CREATED when
// the user pastes/saves their app credentials in Settings → Streaming, picking up
// the new client_id/secret without a server restart (see saveStreamConfig).
let streamTwitch = createTwitchProvider({ clientId: readStreamClientId('twitchClientId', 'TWITCH_CLIENT_ID'), tokensFile: STREAM_TOKENS_FILE });
let streamYouTube = createYouTubeProvider({
  clientId: readStreamClientId('youtubeClientId', 'YOUTUBE_CLIENT_ID'),
  clientSecret: readStreamClientId('youtubeClientSecret', 'YOUTUBE_CLIENT_SECRET'),
  tokensFile: STREAM_TOKENS_FILE,
});
// Twitch Deck actions (Phase 2). These arrow deps read `streamTwitch` at call
// time, so a re-created provider is picked up automatically.
deckRegistryDeps.twitchClip = () => streamTwitch.createClip();
deckRegistryDeps.twitchMarker = (description) => streamTwitch.createMarker(description);
deckRegistryDeps.twitchAd = (length) => streamTwitch.runAd(length);
deckRegistryDeps.twitchTitle = (title) => streamTwitch.setTitle(title);
deckRegistryDeps.twitchGame = (game) => streamTwitch.setGame(game);
deckRegistryDeps.twitchChat = (message) => streamTwitch.sendChat(message);
deckRegistryDeps.twitchShoutout = (login) => streamTwitch.shoutout(login);
deckRegistryDeps.twitchChatMode = (mode) => streamTwitch.setChatMode(mode);
// YouTube Deck action: start/stop/toggle the live broadcast.
deckRegistryDeps.ytBroadcast = (mode) => streamYouTube.transitionBroadcast(mode);

// Spotify integration (Authorization Code + PKCE — no client secret). `let` so it
// can be re-created when the user saves a Client ID in Settings → Streaming (see
// saveStreamConfig). Tokens persist to the same server-only stream-tokens.json.
let streamSpotify = createSpotifyProvider({ clientId: readStreamClientId('spotifyClientId', 'SPOTIFY_CLIENT_ID'), tokensFile: STREAM_TOKENS_FILE });
// All Spotify Deck actions funnel through the provider. Reads `streamSpotify` at
// call time so a re-created provider is picked up automatically.
deckRegistryDeps.spotify = (action) => streamSpotify.runAction(action);

// Discord voice integration via the local RPC/IPC channel (needs the Discord
// desktop client + the user's own app credentials). `let` so it can be re-created
// when the user saves credentials in Settings → Streaming (see saveStreamConfig).
// Tokens persist to the same server-only stream-tokens.json.
// Read at authorize/subscribe time, so the login consent and the live watch both
// follow the current Settings toggle without re-creating the provider.
// The master switch (Settings → Notifiche). When OFF, every notification source is
// silenced and its background watcher stops — one place to kill it all.
function notificationsEnabled() {
  const n = _serverHubSettings && _serverHubSettings.notifications;
  return !n || n.enabled !== false;   // default ON
}
function discordNotifWanted() {
  const dn = _serverHubSettings && _serverHubSettings.discordNotifications;
  return notificationsEnabled() && !!(dn && dn.enabled);
}
let discordRpc = createDiscordProvider({
  clientId: readStreamClientId('discordClientId', 'DISCORD_CLIENT_ID'),
  clientSecret: readStreamClientId('discordClientSecret', 'DISCORD_CLIENT_SECRET'),
  tokensFile: STREAM_TOKENS_FILE,
  wantNotifications: discordNotifWanted,
});
// All Discord Deck actions funnel through the provider (it owns the RPC socket and
// the current-state reads). Reads `discordRpc` at call time so a re-created
// provider is picked up automatically.
deckRegistryDeps.discord = (action) => discordRpc.runAction(action);

// Live Discord voice state pushed to the dashboard widget over SSE. The provider
// SUBSCRIBEs to voice events and calls us on each change (mute/deaf/volume, channel
// join/leave, who's speaking). Like the OBS watch, the persistent RPC socket is
// held only while the dashboard is open (SSE clients > 0) AND Discord is linked, so
// a closed dashboard or an unlinked account keeps zero sockets open.
let discordStopWatch = null;
let discordLogin = '';
let discordWatchArming = false;   // serialize refreshes (status() is async)
let discordWatchDirty = false;    // a refresh arrived mid-flight → re-evaluate

// Recent Discord notifications for the widget's feed — a bounded ring buffer,
// mirroring the Streamer.bot activity feed. Each item is already projected to a
// client-safe shape by the provider (title/body text + https-only icon); it's
// pushed live over the `discord_notification` SSE event AND kept here so a
// just-added tile seeds from GET /stream/discord/notifications. Cleared on
// logout and when the feature is toggled off — never grows past the cap.
const DISCORD_NOTIF_MAX = 30;
let discordNotifs = [];
let discordNotifSeq = 0;
function pushDiscordNotification(n) {
  if (!n || typeof n !== 'object') return;
  if (!discordNotifWanted()) return;   // toggled off mid-watch → drop until re-arm
  const item = Object.assign({ id: ++discordNotifSeq, at: Date.now() }, n);
  discordNotifs.push(item);
  if (discordNotifs.length > DISCORD_NOTIF_MAX) discordNotifs = discordNotifs.slice(-DISCORD_NOTIF_MAX);
  broadcastSSE('discord_notification', item);
  // Fire the "notification" RGB event effect (no-op unless the user enabled it in
  // Settings → Illuminazione → Effetti evento). Same entry point as timer/reminder.
  try { lighting.onEvent('notification'); } catch { /* lighting optional */ }
}
// ── Windows notification mirror (the Notifications tile) ────────────────────
// Same lifecycle discipline as the Discord/HA watches: the notifications-serve
// child (native helper or notifications.ps1) runs only while the feature is
// enabled AND a dashboard is open. winnotif.js owns the child + feed buffer.
function winNotifWanted() {
  if (!notificationsEnabled()) return false;   // master switch off → no mirror child
  const wn = _serverHubSettings && _serverHubSettings.windowsNotifications;
  return !!(wn && wn.enabled);
}
winNotif.init({
  // Per-app mute: match the AUMID when the toast has one, the display name
  // otherwise (some Win32 toasts carry no AUMID). Read live from settings so
  // a just-saved mute applies without restarting the child.
  isExcluded(item) {
    const wn = _serverHubSettings && _serverHubSettings.windowsNotifications;
    const list = (wn && Array.isArray(wn.excluded)) ? wn.excluded : [];
    if (!list.length) return false;
    const key = String((item && (item.aumid || item.app)) || '');
    return key !== '' && list.some(e => e && e.id === key);
  },
  onItem(item) {
    broadcastSSE('windows_notification', item);
    // A mirrored Windows toast counts as a "notification" for the RGB event effect
    // (no-op unless enabled in Settings → Illuminazione → Effetti evento).
    try { lighting.onEvent('notification'); } catch { /* lighting optional */ }
  },
  onFeed() {
    // State change or feed replacement (seed / stop / exclusion prune): push the
    // whole picture so every open tile repaints without a fetch.
    broadcastSSE('windows_notifications', {
      enabled: winNotifWanted(),
      state: winNotif.getState(),
      items: winNotif.getFeed(),
    });
  },
});
function refreshWinNotifWatch() {
  winNotif.sync(winNotifWanted() && sseClients.size > 0);
}

// ── Local "Hey Xenon" wake word ─────────────────────────────────────────────
// Same lifecycle discipline as the notification mirror: the ffmpeg capture
// child runs only while the toggle is on, whisper.cpp is installed AND a
// dashboard is open. wakeword.js owns the child, the VAD and the matcher; the
// mic is read with the exact same device selection as the STT recorder.
let _whisperReadyVal = false;
let _whisperProbedAt = 0;
function _whisperReady() {
  // Cached: this runs on the SSE connect/close path, which must never do sync
  // FS. A positive result is sticky (whisper doesn't uninstall itself); a
  // negative probe is cached for 10 s (and reset by the install handler).
  if (_whisperReadyVal) return true;
  const now = Date.now();
  if (now - _whisperProbedAt < 10000) return false;
  _whisperProbedAt = now;
  try { _whisperReadyVal = !!aiLocal.whisperExe(__dirname) && fs.existsSync(aiLocal.whisperPaths(__dirname).model); }
  catch { _whisperReadyVal = false; }
  return _whisperReadyVal;
}
function wakeWordWanted() {
  const w = _serverHubSettings && _serverHubSettings.wakeWord;
  return !!(w && w.enabled) && _whisperReady();
}
// Single source of truth for the STT/wake microphone input argv — the wake
// listener must always open the same device the STT recorder binds.
function _sttInputArgs() {
  if (_sttUseWasapi) return ['-f', 'wasapi', '-i', 'default'];
  return _sttDshowDevice ? ['-f', 'dshow', '-i', `audio=${_sttDshowDevice}`] : null;
}
wakeWord.init({
  getFfmpegPath,
  getInputArgs: () => (_sttDeviceReady ? _sttInputArgs() : null),
  // Whisper hint follows the persisted UI language ('' → auto-detect); the
  // matcher is fuzzy enough to catch accented renderings either way.
  transcribe: (wav) => aiLocal.localStt(wav, (_serverHubSettings && _serverHubSettings.language) || 'auto', __dirname),
  isBusy: () => _sttPending.size > 0,
  // Every open dashboard gets the event; the /api/stt/start 409 guard already
  // prevents two tabs from double-starting a voice session.
  onWake: () => broadcastSSE('wake', { at: Date.now() }),
});
function refreshWakeWordWatch() {
  // Listener count first: it short-circuits the (cached) whisper probe away
  // whenever nobody is connected. A live voice session owns the mic (dshow can't
  // share it), so the wake word stays down for its whole duration.
  wakeWord.sync(!_liveActive && sseClients.size > 0 && wakeWordWanted());
}

async function refreshDiscordWatch() {
  // This is called from several async triggers that can overlap (SSE connect/close,
  // the /voice mount read, login/logout). Serialize them: without the guard two
  // concurrent calls could both pass `!discordStopWatch` and start two watches,
  // orphaning one socket. The dirty flag re-evaluates once against fresh state so a
  // transition (e.g. logout) that lands mid-flight is never lost.
  if (discordWatchArming) { discordWatchDirty = true; return; }
  discordWatchArming = true;
  try {
    do {
      discordWatchDirty = false;
      const st = await discordRpc.status().catch(() => null);
      const want = !!(st && st.configured && st.connected) && sseClients.size > 0;
      if (want && !discordStopWatch) {
        discordLogin = (st && st.login) || '';
        discordStopWatch = discordRpc.watchVoice((voice) => {
          // Derive `connected` (account linked) from the pushed state, not a hardcoded
          // true — otherwise a token revoked mid-watch would leave the widget stuck
          // looking linked. A dropped pipe still reports connected:true (linked, just
          // offline); a token failure reports connected:false (→ "connect" notice).
          // `notif` tells the widget's Notifications tab whether the feed is live or
          // the token needs a re-link ('scope_missing').
          broadcastSSE('discord', { connected: !!(voice && voice.connected), login: discordLogin, voice, notif: discordRpc.notifStatus() });
        }, pushDiscordNotification);
      } else if (!want && discordStopWatch) {
        discordStopWatch(); discordStopWatch = null;
        // Clear the widget's live state so it reflects the linked-but-idle / unlinked view.
        broadcastSSE('discord', { connected: !!(st && st.connected), login: (st && st.login) || '', voice: null, notif: 'off' });
      }
    } while (discordWatchDirty);
  } finally { discordWatchArming = false; }
}

// Persist the streaming app credentials (from the Settings → Streaming inputs) to
// the gitignored stream-config.json and re-create the providers so they take
// effect immediately. Only the known credential keys are accepted.
// The Spotify OAuth redirect target. Pinned to the loopback IP (Spotify rejects
// `localhost` redirect URIs) with the server's actual port taken from the — already
// loopback-verified — Host header. This exact string must be registered in the
// user's Spotify app (see docs/streaming-setup.md); it's the same for every install
// on the default port: http://127.0.0.1:3030/stream/spotify/callback.
function spotifyRedirectUri(req) {
  const host = String((req && req.headers && req.headers.host) || '').trim();
  const port = (host.match(/:(\d+)$/) || [])[1] || '3030';
  return 'http://127.0.0.1:' + port + '/stream/spotify/callback';
}

// The minimal page shown after Spotify redirects back — the Settings poll detects
// the connected state, so this only needs to reassure the user and self-close.
function spotifyCallbackPage(ok) {
  const title = ok ? 'Spotify connected' : 'Spotify connection failed';
  const body = ok
    ? 'You can close this window and return to the dashboard.'
    : 'Something went wrong. Close this window and try Connect again.';
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>'
    + '<style>html{color-scheme:dark}body{margin:0;height:100vh;display:flex;flex-direction:column;'
    + 'align-items:center;justify-content:center;gap:10px;background:#0b0f0e;color:#e7e9ee;'
    + 'font:600 15px/1.5 system-ui,Segoe UI,sans-serif;text-align:center;padding:24px}'
    + '.d{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;'
    + 'font-size:26px;background:' + (ok ? 'rgba(30,215,96,.16);color:#1ed760' : 'rgba(237,66,69,.16);color:#ed4245') + '}'
    + 'p{margin:0;opacity:.75;font-weight:500;max-width:320px}</style></head><body>'
    + '<div class="d">' + (ok ? '✓' : '✕') + '</div><div>' + title + '</div><p>' + body + '</p>'
    + '<script>setTimeout(function(){window.close()},2500)</script></body></html>';
}

const STREAM_CONFIG_KEYS = ['twitchClientId', 'youtubeClientId', 'youtubeClientSecret', 'discordClientId', 'discordClientSecret', 'spotifyClientId'];
async function saveStreamConfig(patch) {
  let cfg = {};
  try { cfg = JSON.parse(await fs.promises.readFile(STREAM_CONFIG_FILE, 'utf8')) || {}; } catch { cfg = {}; }
  for (const k of STREAM_CONFIG_KEYS) {
    if (patch && typeof patch[k] === 'string') cfg[k] = patch[k].trim().slice(0, 200);
  }
  await writeFileAtomic(STREAM_CONFIG_FILE, JSON.stringify(cfg, null, 2));
  streamTwitch = createTwitchProvider({ clientId: readStreamClientId('twitchClientId', 'TWITCH_CLIENT_ID'), tokensFile: STREAM_TOKENS_FILE });
  streamYouTube = createYouTubeProvider({
    clientId: readStreamClientId('youtubeClientId', 'YOUTUBE_CLIENT_ID'),
    clientSecret: readStreamClientId('youtubeClientSecret', 'YOUTUBE_CLIENT_SECRET'),
    tokensFile: STREAM_TOKENS_FILE,
  });
  streamSpotify = createSpotifyProvider({ clientId: readStreamClientId('spotifyClientId', 'SPOTIFY_CLIENT_ID'), tokensFile: STREAM_TOKENS_FILE });
  // Stop any live watch on the OLD provider first — closing it with a watcher
  // still attached would spin up a reconnect loop against the stale socket.
  if (discordStopWatch) { discordStopWatch(); discordStopWatch = null; }
  try { discordRpc.close(); } catch { /* ignore */ }
  discordRpc = createDiscordProvider({
    clientId: readStreamClientId('discordClientId', 'DISCORD_CLIENT_ID'),
    clientSecret: readStreamClientId('discordClientSecret', 'DISCORD_CLIENT_SECRET'),
    tokensFile: STREAM_TOKENS_FILE,
    wantNotifications: discordNotifWanted,
  });
  refreshDiscordWatch();   // re-arm the watch if the new creds are linked and a dashboard is open
}

function normalizeEvents(value) {
  const source = Array.isArray(value) ? value : (Array.isArray(value && value.events) ? value.events : []);
  return source.slice(0, 250).map(item => {
    const title = String(item && item.title || '').trim().slice(0, 120);
    const notes = String(item && item.notes || '').trim().slice(0, 600);
    const startsAt = String(item && item.startsAt || '').trim();
    const endsAt = String(item && item.endsAt || '').trim();
    const reminderAt = String(item && item.reminderAt || '').trim();
    const id = String(item && item.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 80);
    // endsAt is optional (multi-day events): keep it only when it parses and is
    // not before the start, otherwise drop it so the event stays single-day.
    const endValid = Number.isFinite(Date.parse(endsAt)) &&
      (!Number.isFinite(Date.parse(startsAt)) || Date.parse(endsAt) >= Date.parse(startsAt));
    return {
      id,
      title,
      notes,
      startsAt: Number.isFinite(Date.parse(startsAt)) ? startsAt : '',
      endsAt: endValid ? endsAt : '',
      reminderAt: Number.isFinite(Date.parse(reminderAt)) ? reminderAt : '',
      notifiedAt: item && item.notifiedAt ? String(item.notifiedAt).slice(0, 40) : '',
      createdAt: item && item.createdAt ? String(item.createdAt).slice(0, 40) : new Date().toISOString(),
    };
  }).filter(item => item.title || item.startsAt || item.notes);
}

async function readEvents() {
  try {
    const raw = await fs.promises.readFile(EVENTS_FILE, 'utf8');
    return normalizeEvents(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeEvents(events) {
  const safe = normalizeEvents(events);
  await writeFileAtomic(EVENTS_FILE, JSON.stringify(safe, null, 2));
  broadcastSSE('agenda', { events: safe });   // live-sync the SDK `agenda` stream (no-op with no listeners)
  return safe;
}

const TASK_PRIORITIES = Object.freeze(['high', 'medium', 'low']);
const TASK_RECURRENCES = Object.freeze(['never', 'daily', 'weekly', 'custom']);

function normalizeTask(item) {
  const text = String(item && item.text || '').trim().slice(0, 200);
  const id = String(item && item.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 80);
  const priority = TASK_PRIORITIES.includes(item && item.priority) ? item.priority : 'medium';
  const recurrence = TASK_RECURRENCES.includes(item && item.recurrence) ? item.recurrence : 'never';
  const recurrenceDays = (recurrence === 'custom' && Number.isFinite(Number(item && item.recurrenceDays)) && Number(item.recurrenceDays) >= 1)
    ? Math.round(Number(item.recurrenceDays)) : 1;
  const completed = Boolean(item && item.completed);
  const completedAt = completed && item.completedAt ? String(item.completedAt).slice(0, 40) : null;
  const createdAt = item && item.createdAt ? String(item.createdAt).slice(0, 40) : new Date().toISOString();
  return { id, text, priority, recurrence, recurrenceDays, completed, completedAt, createdAt };
}

function normalizeTasks(value) {
  const source = Array.isArray(value) ? value : [];
  return source.slice(0, TASKS_MAX).map(normalizeTask).filter(t => t.text.length > 0);
}

async function readTasks() {
  try {
    const raw = await fs.promises.readFile(TASKS_FILE, 'utf8');
    return normalizeTasks(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeTasks(tasks) {
  const safe = normalizeTasks(tasks);
  await writeFileAtomic(TASKS_FILE, JSON.stringify(safe, null, 2));
  broadcastSSE('tasks', { tasks: safe });   // live-sync the SDK `tasks` stream (no-op with no listeners)
  return safe;
}

// ── Notes ─────────────────────────────────────────────────────────────────────
// Structured multi-note store (notes.json). The plain-text /notes API, the AI
// read/write functions and the backup bundle all speak a flattened text view so
// existing consumers (iCUE widget, older backups) keep working unchanged.

function _noteId() {
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// Rebuild a trusted notes state from arbitrary persisted/wire input — explicit
// known-key copy (never a spread of untrusted data), with caps applied.
function normalizeNotesState(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const notes = [];
  const seen = new Set();
  let total = 0;
  for (const n of Array.isArray(src.notes) ? src.notes : []) {
    if (notes.length >= NOTES_MAX) break;
    if (!n || typeof n !== 'object') continue;
    let body = typeof n.body === 'string' ? n.body : '';
    if (body.length > NOTE_BODY_MAX) body = body.slice(0, NOTE_BODY_MAX);
    total += body.length;
    if (total > NOTES_TOTAL_MAX) break;
    let id = String(n.id || '').slice(0, 64) || _noteId();
    while (seen.has(id)) id = _noteId();
    seen.add(id);
    notes.push({
      id,
      body,
      pinned: !!n.pinned,
      updatedAt: Number.isFinite(Number(n.updatedAt)) ? Number(n.updatedAt) : Date.now(),
    });
  }
  let activeId = String(src.activeId || '').slice(0, 64);
  if (!notes.some((n) => n.id === activeId)) activeId = notes.length ? notes[0].id : '';
  return { v: 1, activeId, notes };
}

// Flatten all notes to a single plain-text document (order preserved).
function notesToText(state) {
  return (state && Array.isArray(state.notes) ? state.notes : [])
    .map((n) => n.body).join(NOTES_TEXT_SEP);
}

// Build a one-note state from a plain-text blob (legacy save / migration / old backup).
function textToNotesState(text) {
  const body = String(text == null ? '' : text);
  if (!body) return { v: 1, activeId: '', notes: [] };
  const id = _noteId();
  return normalizeNotesState({ activeId: id, notes: [{ id, body, pinned: false, updatedAt: Date.now() }] });
}

// Monotonic notes revision — every write bumps it and every read/broadcast
// carries it. A save posts the rev it was based on (baseRev), so a stale
// surface (one that missed newer broadcasts — dead SSE, or the beforeunload
// beacon of a long-idle page) can't clobber fresher content (GitHub #72).
// Lazily seeded from the persisted store so it survives restarts. Tasks and
// calendar events keep last-writer-wins on purpose: only notes had the
// reported cross-surface clobber, and their edits are append-mostly.
let _notesRev = -1; // -1 = not yet loaded from disk

function _notesRevOf(parsed) {
  const n = Number(parsed && parsed.rev);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function _ensureNotesRev() {
  if (_notesRev >= 0) return _notesRev;
  try {
    _notesRev = _notesRevOf(JSON.parse(await fs.promises.readFile(NOTES_JSON, 'utf8')));
  } catch {
    _notesRev = 0;
  }
  return _notesRev;
}

async function readNotes() {
  try {
    const raw = await fs.promises.readFile(NOTES_JSON, 'utf8');
    const parsed = JSON.parse(raw);
    if (_notesRev < 0) _notesRev = _notesRevOf(parsed);
    const state = normalizeNotesState(parsed);
    state.rev = _notesRev;
    return state;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (_notesRev < 0) _notesRev = 0;
  // First run after upgrade: promote the legacy single-blob notes.txt to one note.
  try {
    const legacy = await fs.promises.readFile(NOTES_FILE, 'utf8');
    if (legacy && legacy.trim()) {
      return await writeNotes(textToNotesState(legacy));
    }
  } catch (e) {
    if (e.code !== 'ENOENT') { /* unreadable legacy file → start empty rather than fail */ }
  }
  return { v: 1, activeId: '', notes: [], rev: _notesRev };
}

async function writeNotes(state) {
  const safe = normalizeNotesState(state);
  await _ensureNotesRev();
  safe.rev = ++_notesRev;
  await writeFileAtomic(NOTES_JSON, JSON.stringify(safe, null, 2));
  // Live-sync: the dashboard notes widgets on every surface + granted SDK streams.
  broadcastSSE('notes', safe);
  return safe;
}

// Guarded save, serialized: the baseRev check and the rev bump inside
// writeNotes must not interleave across awaits, or two concurrent saves with
// the same baseRev would BOTH pass the guard and one silently clobber the
// other — the exact lost update the guard exists to refuse.
let _notesSaveChain = Promise.resolve();
function saveNotesGuarded(body) {
  const run = _notesSaveChain.then(async () => {
    const baseRev = Number(body && body.baseRev);
    if (Number.isFinite(baseRev) && baseRev < await _ensureNotesRev()) {
      return { ok: false, stale: true, ...(await readNotes()) };
    }
    const saved = await writeNotes({ notes: body.notes, activeId: body.activeId });
    return { ok: true, ...saved };
  });
  _notesSaveChain = run.catch(() => {}); // a failed save must never wedge the chain
  return run;
}

// ── Timers ────────────────────────────────────────────────────────────────────

let _timers = []; // in-memory timer list; persisted to TIMERS_FILE
let _timerCheckInterval = null;

function _normalizeTimer(item) {
  const id          = String(item && item.id || `t${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 80);
  const label       = String(item && item.label || 'Timer').trim().slice(0, 40);
  const durationSecs = Math.max(1, Math.round(Number(item && item.durationSecs) || 60));
  const status      = ['running', 'paused', 'done'].includes(item && item.status) ? item.status : 'running';
  const startedAt   = Number.isFinite(Number(item && item.startedAt)) ? Number(item.startedAt) : Date.now();
  const pausedElapsed = Math.max(0, Number(item && item.pausedElapsed) || 0);
  const createdAt   = item && item.createdAt ? String(item.createdAt).slice(0, 40) : new Date().toISOString();
  return { id, label, durationSecs, status, startedAt, pausedElapsed, createdAt };
}

function _getTimerRemaining(t) {
  if (t.status === 'done')   return 0;
  if (t.status === 'paused') return Math.max(0, t.durationSecs - t.pausedElapsed);
  const elapsed = t.pausedElapsed + (Date.now() - t.startedAt) / 1000;
  return Math.max(0, t.durationSecs - elapsed);
}

async function _saveTimers() {
  try {
    await writeFileAtomic(TIMERS_FILE, JSON.stringify(_timers, null, 2));
  } catch {}
}

function _checkTimers() {
  let changed = false;
  for (const t of _timers) {
    if (t.status === 'running' && _getTimerRemaining(t) <= 0) {
      t.status = 'done';
      changed = true;
      broadcastSSE('timer_done', { id: t.id, label: t.label });
      try { lighting.onEvent('timer'); } catch {}
    }
  }
  if (changed) {
    _saveTimers();
    broadcastSSE('timer_update', { timers: _timers });
  }
}

async function _initTimers() {
  try {
    const raw = await fs.promises.readFile(TIMERS_FILE, 'utf8');
    const loaded = JSON.parse(raw);
    _timers = (Array.isArray(loaded) ? loaded : []).slice(0, TIMERS_MAX).map(_normalizeTimer);
  } catch (e) {
    if (e.code !== 'ENOENT') process.stdout.write(`[timers] load error: ${e.message}\n`);
    _timers = [];
  }
  if (_timerCheckInterval) clearInterval(_timerCheckInterval);
  _timerCheckInterval = setInterval(_checkTimers, 1000);
  _timerCheckInterval.unref();
}

// ── External calendar feeds (read-only ICS subscriptions) ──────────────────
// In-memory only: parsed feed events are never written to disk.
let _externalFeedCache = { feeds: [], events: [], refreshedAt: 0 };
let _externalRefreshing = false;

async function refreshExternalFeeds() {
  if (_externalRefreshing) return _externalFeedCache;
  _externalRefreshing = true;
  try {
    const settings = await readHubSettings().catch(() => null);
    const feeds = (settings && Array.isArray(settings.calendarFeeds)) ? settings.calendarFeeds : [];
    const results = await Promise.all(feeds.map(f => icsFeeds.loadFeed(f)));
    const events = [];
    const status = [];
    for (let i = 0; i < feeds.length; i++) {
      const r = results[i];
      status.push({ id: feeds[i].id, name: feeds[i].name, status: r.status, error: r.error, count: r.count, reminders: feeds[i].reminders });
      if (r.events && r.events.length) events.push(...r.events);
    }
    _externalFeedCache = { feeds: status, events, refreshedAt: Date.now() };
  } catch (e) {
    // Keep last good cache; record nothing sensitive.
  } finally {
    _externalRefreshing = false;
  }
  return _externalFeedCache;
}

// Warm shortly after boot, then every 15 minutes — but only while a dashboard
// is connected (SSE-timer gating invariant: no network/disk work with nobody
// listening). A stale cache is refreshed on demand from the /events handler, so
// the first client after an idle stretch still gets fresh feeds. unref() so
// these timers never keep the process alive on shutdown.
const EXTERNAL_FEEDS_INTERVAL_MS = 15 * 60 * 1000;
setTimeout(() => { if (sseClients.size) refreshExternalFeeds().catch(() => {}); }, 4000).unref();
setInterval(() => {
  if (sseClients.size === 0) return;
  refreshExternalFeeds().catch(() => {});
}, EXTERNAL_FEEDS_INTERVAL_MS).unref();

// ── Server-Sent Events infrastructure ────────────────────────────────────────
// Clients connect to GET /sse and receive named events instead of polling.
// Each event carries the same JSON payload the old poll endpoints returned,
// so the client-side render functions need no changes — only the fetch trigger
// changes from setInterval to EventSource.

const sseClients = new Set();

// PresentMon runs an admin ETW tracing session, so it should only run while a
// dashboard is actually connected (nobody watches FPS / game-mode with no client
// open). Tie its lifecycle to the SSE client set, matching the SSE-timer gating
// pattern. A short grace before pausing survives quick page reloads on the
// Xeneon Edge (its WebView reconnects almost immediately), so the ETW session
// isn't torn down and rebuilt on every refresh.
let _fpsPauseTimer = null;
const FPS_PAUSE_GRACE_MS = 45000;
function _syncFpsMonitor() {
  if (sseClients.size > 0) {
    if (_fpsPauseTimer) { clearTimeout(_fpsPauseTimer); _fpsPauseTimer = null; }
    try { fpsMonitor.resumeFpsMonitor(); } catch { /* PresentMon absent → no-op */ }
  } else if (!_fpsPauseTimer) {
    _fpsPauseTimer = setTimeout(() => {
      _fpsPauseTimer = null;
      if (sseClients.size === 0) { try { fpsMonitor.pauseFpsMonitor(); } catch { /* no-op */ } }
    }, FPS_PAUSE_GRACE_MS);
    _fpsPauseTimer.unref();
  }
}

function broadcastSSE(event, data) {
  if (sseClients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); }
    catch { sseClients.delete(res); }
  }
}

// A display-only feed is worth fetching only if someone can actually see it:
// its widget is on the dashboard (visible, duplicated as a copy, or merged into
// a tab-group) or the ticker streams that source. Any unexpected/legacy layout
// shape fails OPEN (fetch) — this gate may only ever save work, never hide data.
// Used for news + claude; stocks/football are deliberately NOT gated because
// their fetch also drives user-facing alerts (price moves, goals) that must
// keep working with the widget hidden.
function _feedWidgetInUse(widgetId, tickerSource) {
  const s = _serverHubSettings;
  if (!s || typeof s !== 'object') return true;
  if (tickerSource) {
    const t = s.ticker;
    if (t && t.enabled === true && t.sources && t.sources[tickerSource] !== false) return true;
  }
  const layout = s.dashboardLayout;
  if (!layout || typeof layout !== 'object') return true;
  const w = layout.widgets && layout.widgets[widgetId];
  if (!w || typeof w !== 'object') return true;
  if (w.visible === true) return true;
  if (Array.isArray(layout.copies) && layout.copies.some(c => c && c.widget === widgetId)) return true;
  const groups = layout.groups && typeof layout.groups === 'object' ? layout.groups : {};
  for (const gid of Object.keys(groups)) {
    const members = groups[gid] && Array.isArray(groups[gid].members) ? groups[gid].members : [];
    if (members.some(m => m === widgetId || (typeof m === 'string' && m.indexOf(widgetId + '~') === 0))) return true;
  }
  return false;
}

// ── Stock market (Borsa) ─────────────────────────────────────────────────────
// In-memory only. Quotes are pulled from a free provider (Yahoo keyless by
// default; optional Twelve Data/Finnhub keys) on a client-gated timer whose
// cadence follows the user's refreshSec, then pushed over SSE ('stocks'). When a
// watched symbol crosses ±alertPercent an 'stocks_alert' event fires (→ client
// toast + LED, gated by the master Notifiche switch).
let _stocksCache = { quotes: [], provider: 'yahoo', refreshedAt: 0 };
let _stocksRefreshing = false;
let _stocksLastFetch = 0;
let _stocksSig = null;

// Push only when the data actually changed (refreshedAt excluded): a closed
// market re-fetch then costs the clients zero repaints and zero SSE traffic.
function _pushStocks() {
  const sig = JSON.stringify(_stocksCache.quotes) + '|' + _stocksCache.provider;
  if (sig === _stocksSig) return;
  _stocksSig = sig;
  broadcastSSE('stocks', _stocksCache);
}
const _stocksAlerts = stocks.createAlertTracker();
const _stocksChartCache = new Map(); // bounded LRU: `${symbol}|${range}` → { at, data }
const _stocksSearchCache = new Map(); // bounded LRU: `query` → { at, results }

function _stocksSettings() {
  const s = _serverHubSettings && _serverHubSettings.stocks;
  return (s && typeof s === 'object') ? s : stocks.DEFAULT_STOCKS;
}
function _stocksProviderOpts() {
  return {
    provider: _stocksSettings().provider,
    twelveDataKey: (_serverHubSettings && _serverHubSettings.twelveDataKey) || '',
    finnhubKey: (_serverHubSettings && _serverHubSettings.finnhubKey) || '',
  };
}

async function refreshStocks() {
  if (_stocksRefreshing) return _stocksCache;
  _stocksLastFetch = Date.now();
  const cfg = _stocksSettings();
  if (!Array.isArray(cfg.watchlist) || !cfg.watchlist.length) {
    _stocksCache = { quotes: [], provider: 'yahoo', refreshedAt: Date.now() };
    _pushStocks();
    return _stocksCache;
  }
  _stocksRefreshing = true;
  try {
    const opts = _stocksProviderOpts();
    const quotes = await stocks.fetchQuotes(cfg.watchlist, opts);
    if (quotes.length) _stocksCache = { quotes, provider: stocks.resolveProvider(opts), refreshedAt: Date.now() };
    // Alerts: one per symbol per direction per day (the tracker dedupes on dayKey).
    const dayKey = new Date().toISOString().slice(0, 10);
    const alerts = _stocksAlerts.evaluate(quotes, cfg.alertPercent, dayKey);
    for (const a of alerts) broadcastSSE('stocks_alert', a);
    // LED reaction (same lighting notification effect the other feeds use),
    // gated by the master Notifiche switch — mirrors the client toast gating.
    if (alerts.length) {
      const master = _serverHubSettings && _serverHubSettings.notifications;
      if (!(master && master.enabled === false)) { try { lighting.onEvent('notification'); } catch {} }
    }
    _pushStocks();
  } catch { /* keep last good cache */ }
  finally { _stocksRefreshing = false; }
  return _stocksCache;
}

// Client-gated cadence: a light 10s heartbeat that only fetches once the user's
// refreshSec has elapsed and a dashboard is actually open. Zero cost at rest.
setTimeout(() => { if (sseClients.size) refreshStocks().catch(() => {}); }, 5000).unref();
setInterval(() => {
  if (sseClients.size === 0) return;
  const period = Math.max(30, Number(_stocksSettings().refreshSec) || 60) * 1000;
  if (Date.now() - _stocksLastFetch < period) return;
  refreshStocks().catch(() => {});
}, 10000).unref();

// ── Football (Calcio) ────────────────────────────────────────────────────────
// In-memory only. Each favorite team's next fixture + last result (with live
// scores when a Premium key is set) is pulled from TheSportsDB on a client-gated
// timer, then pushed over SSE ('football'). A followed team's goal / final whistle
// fires a 'football_alert' event (→ client toast + LED, gated by Notifiche).
let _footballCache = { teams: [], live: false, refreshedAt: 0 };
let _footballRefreshing = false;
let _footballLastFetch = 0;
let _footballSig = null;

function _pushFootball() {
  const sig = JSON.stringify(_footballCache.teams) + '|' + _footballCache.live;
  if (sig === _footballSig) return;
  _footballSig = sig;
  broadcastSSE('football', _footballCache);
}
const _footballAlerts = football.createAlertTracker();
const _footballStandingsCache = new Map(); // bounded LRU: `${leagueId}|${season}` → { at, data }
const _footballSearchCache = new Map();    // bounded LRU: `query` → { at, results }

function _footballSettings() {
  const s = _serverHubSettings && _serverHubSettings.football;
  return (s && typeof s === 'object') ? s : football.DEFAULT_FOOTBALL;
}
function _footballOpts() {
  return { sportsDbKey: (_serverHubSettings && _serverHubSettings.sportsDbKey) || '' };
}

async function refreshFootball() {
  if (_footballRefreshing) return _footballCache;
  _footballLastFetch = Date.now();
  const cfg = _footballSettings();
  if (!Array.isArray(cfg.teams) || !cfg.teams.length) {
    _footballCache = { teams: [], live: false, refreshedAt: Date.now() };
    _pushFootball();
    return _footballCache;
  }
  _footballRefreshing = true;
  try {
    const data = await football.fetchFixtures(cfg.teams, _footballOpts());
    if (data.teams.length) _footballCache = { teams: data.teams, live: data.live, refreshedAt: Date.now() };
    // Alerts: a goal or full-time transition for a followed team (deduped).
    const alerts = _footballAlerts.evaluate(_footballCache.teams, { alerts: cfg.alerts !== false });
    for (const a of alerts) broadcastSSE('football_alert', a);
    if (alerts.length) {
      const master = _serverHubSettings && _serverHubSettings.notifications;
      if (!(master && master.enabled === false)) { try { lighting.onEvent('notification'); } catch {} }
    }
    _pushFootball();
  } catch { /* keep last good cache */ }
  finally { _footballRefreshing = false; }
  return _footballCache;
}

// Client-gated cadence (mirrors stocks): a light heartbeat that only fetches once
// the user's refreshSec has elapsed and a dashboard is actually open.
setTimeout(() => { if (sseClients.size) refreshFootball().catch(() => {}); }, 6000).unref();
setInterval(() => {
  if (sseClients.size === 0) return;
  const period = Math.max(60, Number(_footballSettings().refreshSec) || 120) * 1000;
  if (Date.now() - _footballLastFetch < period) return;
  refreshFootball().catch(() => {});
}, 15000).unref();

// ── News ─────────────────────────────────────────────────────────────────────
// In-memory only. Headlines from the followed feeds are pulled on a client-gated
// timer, then pushed over SSE ('news'). Low cadence (feeds don't change fast).
let _newsCache = { items: [], refreshedAt: 0 };
let _newsRefreshing = false;
let _newsLastFetch = 0;
let _newsSig = null;

function _pushNews() {
  const sig = JSON.stringify(_newsCache.items);
  if (sig === _newsSig) return;
  _newsSig = sig;
  broadcastSSE('news', _newsCache);
}
const _newsSearchCache = new Map(); // bounded LRU: `query` → { at, results }

function _newsSettings() {
  const s = _serverHubSettings && _serverHubSettings.news;
  return (s && typeof s === 'object') ? s : news.DEFAULT_NEWS;
}
function _newsOpts() {
  return {
    lang: (_serverHubSettings && _serverHubSettings.language) || 'en',
    newsDataKey: (_serverHubSettings && _serverHubSettings.newsDataKey) || '',
  };
}

async function refreshNews() {
  if (_newsRefreshing) return _newsCache;
  _newsLastFetch = Date.now();
  const cfg = _newsSettings();
  if (!Array.isArray(cfg.feeds) || !cfg.feeds.length) {
    _newsCache = { items: [], refreshedAt: Date.now() };
    _pushNews();
    return _newsCache;
  }
  _newsRefreshing = true;
  try {
    const data = await news.fetchHeadlines(cfg.feeds, _newsOpts());
    if (data.items.length) _newsCache = { items: data.items, refreshedAt: Date.now() };
    _pushNews();
  } catch { /* keep last good cache */ }
  finally { _newsRefreshing = false; }
  return _newsCache;
}

// Display-only feed: also gated on the widget/ticker actually using it, so a
// user who never added the News widget pays zero network for it.
setTimeout(() => { if (sseClients.size && _feedWidgetInUse('news', 'news')) refreshNews().catch(() => {}); }, 8000).unref();
setInterval(() => {
  if (sseClients.size === 0) return;
  if (!_feedWidgetInUse('news', 'news')) return;
  const period = Math.max(120, Number(_newsSettings().refreshSec) || 600) * 1000;
  if (Date.now() - _newsLastFetch < period) return;
  refreshNews().catch(() => {});
}, 30000).unref();

// ── Claude Code usage ("Xenon Pulse") ────────────────────────────────────────
// In-memory only. Reads the user's LOCAL Claude Code transcripts (~/.claude), so
// there is NO network and NO key — the reader owns a small mtime-gated per-file
// cache so a refresh only re-parses the session being written right now. Pushed
// over SSE ('claude') on a client-gated cadence, and only when the aggregate
// actually changed (the reader hands us a signature). No alerts, no disk writes.
const _claudeReader = claudeUsage.createReader();
let _claudeCache = { data: null, sig: '', refreshedAt: 0 };
let _claudeRefreshing = false;
let _claudeLastFetch = 0;

function _claudeSettings() {
  const s = _serverHubSettings && _serverHubSettings.claude;
  return (s && typeof s === 'object') ? s : claudeUsage.DEFAULT_CLAUDE;
}

// Build the wire payload: the aggregate + the budget config the reactor needs to
// draw the "remaining" gauge (there is no official quota API, so the ceiling is
// whatever plan/budget the user picked).
function _claudePayload(usage) {
  const cfg = _claudeSettings();
  return {
    usage,
    budget: {
      weekly: claudeUsage.effectiveWeeklyBudget(cfg),
      plan: cfg.plan,
      weeklyTokenBudget: cfg.weeklyTokenBudget,
    },
    tile: cfg.tile,
    refreshedAt: Date.now(),
  };
}

async function refreshClaude() {
  if (_claudeRefreshing) return _claudeCache;
  _claudeRefreshing = true;
  _claudeLastFetch = Date.now();
  try {
    const usage = await _claudeReader.getUsage(Date.now());
    const payload = _claudePayload(usage);
    // Change detection folds in the budget so a settings edit repaints too, not
    // just new token activity.
    const fullSig = `${usage.sig}|${payload.budget.weekly}|${payload.budget.plan}`;
    const changed = fullSig !== _claudeCache.sig;
    _claudeCache = { data: payload, sig: fullSig, refreshedAt: payload.refreshedAt };
    if (changed) broadcastSSE('claude', payload);
  } catch { /* keep last good cache */ }
  finally { _claudeRefreshing = false; }
  return _claudeCache;
}

// Client-gated cadence (mirrors stocks/football): only scans the filesystem once a
// dashboard is open and the user's refreshSec has elapsed.
// Display-only feed: also gated on the widget actually being on the dashboard,
// so a user who never added the Claude widget pays zero filesystem scans for it.
setTimeout(() => { if (sseClients.size && _feedWidgetInUse('claude')) refreshClaude().catch(() => {}); }, 4000).unref();
setInterval(() => {
  if (sseClients.size === 0) return;
  if (!_feedWidgetInUse('claude')) return;
  const period = Math.max(20, Number(_claudeSettings().refreshSec) || 60) * 1000;
  if (Date.now() - _claudeLastFetch < period) return;
  refreshClaude().catch(() => {});
}, 10000).unref();

// Security: only accept connections from loopback addresses.
// Double-checked at both the TCP socket level (remoteAddress) and the HTTP Host header
// level, so DNS-rebinding / Host-spoofing attacks from non-loopback IPs are blocked.
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const ALLOWED_HOSTS = new Set([
  '127.0.0.1:' + PORT, 'localhost:' + PORT, '[::1]:' + PORT,
  '127.0.0.1:3030', 'localhost:3030', '[::1]:3030',
  '127.0.0.1', 'localhost', '[::1]',
]);

// JSONP responses are readable by any page that can inject a <script> tag:
// script loads send no Origin header, so the Origin layer below never sees
// them, and the request still comes from loopback (the user's own browser).
// Restrict callback wrapping to the endpoints the iCUE widget actually polls —
// settings (API keys), stream tokens and deck config must only ever ship as
// plain JSON, which cross-origin pages cannot read.
const JSONP_PATHS = new Set([
  '/system', '/network', '/notes', '/events', '/media', '/audio', '/status',
  '/toggle', '/mic/volume', '/volume/set', '/speaker/mute',
]);
function isJsonpAllowed(pathname) {
  return JSONP_PATHS.has(pathname) || pathname.startsWith('/media/');
}

// State-mutating endpoints that also accept GET so the iCUE widget can reach
// them via <script> JSONP (Qt WebEngine blocks fetch). That same shape is a
// CSRF vector: any visited web page can trigger them with a <script> tag, which
// sends no Origin, so the loopback/Origin checks below can't catch it. They are
// guarded by the Sec-Fetch-Site check in the request handler.
const CSRF_MUTATION_PATHS = new Set([
  // Raises a UAC prompt and changes the startup task's run level. POST-only, but
  // guarded here too: a cross-site drive-by must not be able to make the local
  // server throw an administrator prompt at the user.
  '/system/enable-sensors',
  '/toggle', '/mic/volume', '/volume/set', '/speaker/mute',
  '/audio/app/volume', '/audio/app/mute',
  // The iCUE widget saves notes via GET (?save=1&data=) over JSONP <script>. That
  // same shape is a cross-site drive-by that could REPLACE the whole notes store
  // with one note — so it must be Sec-Fetch-Site-guarded like the other controls.
  '/notes',
  '/media/source', '/media/playpause', '/media/next', '/media/previous',
  // GET but not purely read-only: ?refresh=1 busts the catalog TTL cache and
  // forces an outbound fetch (throttled to 1/min). Guarded here so a cross-site
  // <img>/<script> drive-by can't make the local server hit the network.
  '/api/community/catalog',
  // Same property, worse economics: every cache-missed id is an outbound HTTPS
  // request for codes/<id>.txt with no refresh throttle — a cross-site <img>
  // loop over ids would turn the local server into a request pump without this.
  '/api/community/code',
  // POST-only, but it triggers an outbound request to the supporter hub AND a
  // successful call consumes one of the code's device activations — a cross-site
  // drive-by (or a sandboxed iframe posting with Origin: null) must not be able
  // to burn a user's activations or pump the hub.
  '/api/community/redeem',
  // Automatic limited stock is a read, but a cache miss reaches the Hub.
  '/api/community/limited-status',
  // Ratings: the GET's cache miss triggers an outbound hub fetch (same rationale
  // as /api/community/catalog); the POST casts a vote under THIS install's id —
  // a drive-by must be able to do neither.
  '/api/community/ratings',
  '/api/community/rate',
  // POST-only pack installs (the 'icons' / 'sounds' preset kinds). Belt-and-
  // suspenders like /api/community/redeem: an Origin:null frame must not be
  // able to write a pack folder behind the user's back — installs go through
  // the import dialog.
  '/icon-pack',
  '/sound-pack',
]);

function isAllowedRequest(req) {
  // Layer 1: TCP source IP must be loopback (blocks LAN spoofing regardless of Host)
  const remoteAddr = req.socket.remoteAddress || '';
  if (!LOOPBACK_IPS.has(remoteAddr)) return false;

  // Layer 2: Host header must be a loopback address (protects against DNS rebinding)
  const host = (req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return false;

  // Layer 3: If an Origin header is present, it must also be loopback or opaque.
  // 'null' = opaque origin from Qt WebEngine (file:// or qrc:// page) — allowed.
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      // URL parsing strips the brackets from an IPv6 literal, so an
      // `http://[::1]:3030` Origin arrives here as hostname `::1`. Accept both
      // spellings; otherwise a legitimate loopback IPv6 page is rejected.
      const u = new URL(origin);
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' &&
          u.hostname !== '::1' && u.hostname !== '[::1]') return false;
    } catch { return false; }
  }
  return true;
}

// Enumerate DirectShow audio devices via ffmpeg. Returns an array of friendly device name strings.
async function _enumSttDevice() {
  const ffmpeg = getFfmpegPath();
  let stderr = '';
  try {
    await new Promise(resolve => {
      const p = spawn(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { windowsHide: true });
      p.stderr.setEncoding('utf8');
      p.stderr.on('data', d => { stderr += d; });
      p.on('exit', resolve);
      p.on('error', resolve);
      setTimeout(() => { try { p.kill(); } catch {} resolve(); }, 5000);
    });
  } catch {}

  const names = [];
  let inAudioSection = false; // for ffmpeg <7 (section-based format)

  for (const line of stderr.split('\n')) {
    if (/Alternative name/i.test(line)) continue;

    // ffmpeg 7+ format: [in#0 @ ...] "Device Name" (audio)
    const newFmt = line.match(/"([^"]+)"\s*\(audio\)/i);
    if (newFmt && !newFmt[1].startsWith('@device_')) { names.push(newFmt[1]); continue; }

    // ffmpeg <7 format: section header + [dshow @ ...] "Device Name"
    if (/DirectShow audio devices/i.test(line)) { inAudioSection = true; continue; }
    if (/DirectShow video devices/i.test(line)) { inAudioSection = false; continue; }
    if (inAudioSection) {
      const oldFmt = line.match(/"([^@][^"]+)"/);
      if (oldFmt) names.push(oldFmt[1]);
    }
  }
  return names;
}

async function _initSttDevice() {
  const ffmpeg = getFfmpegPath();

  // Probe WASAPI support — if ffmpeg knows the format, use it (fast init ~200ms)
  let wasapiOk = false;
  try {
    await new Promise(resolve => {
      let stderr = '';
      const p = spawn(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'wasapi', '-i', 'dummy'], { windowsHide: true });
      p.stderr.setEncoding('utf8');
      p.stderr.on('data', d => { stderr += d; });
      p.on('exit', () => { wasapiOk = !/Unknown input format/i.test(stderr); resolve(); });
      p.on('error', resolve);
      setTimeout(() => { try { p.kill(); } catch {} resolve(); }, 4000);
    });
  } catch {}

  if (wasapiOk) {
    _sttUseWasapi = true;
    process.stdout.write('[STT] WASAPI available — fast init\n');
  } else {
    // WASAPI not supported — enumerate DirectShow devices as fallback
    try {
      const names = await _enumSttDevice();
      if (names.length > 0) {
        let chosen = null;
        if (cachedMicLabel) {
          const lbl = cachedMicLabel.toLowerCase();
          chosen = names.find(d => d.toLowerCase().includes(lbl));
        }
        _sttDshowDevice = chosen || names[0];
        process.stdout.write(`[STT] WASAPI unavailable, dshow: "${_sttDshowDevice}"\n`);
      } else {
        process.stdout.write('[STT] No audio input method found\n');
      }
    } catch (e) {
      process.stdout.write('[STT] Device init error: ' + e.message + '\n');
    }
  }

  _sttDeviceReady = true;
  _boundMicLabel = cachedMicLabel || _sttDshowDevice || (wasapiOk ? '__wasapi_default__' : null);
  _sttDeviceWaiters.splice(0).forEach(cb => cb());
}

function _sttDeviceWhenReady() {
  return new Promise(resolve => {
    if (_sttDeviceReady) resolve();
    else _sttDeviceWaiters.push(resolve);
  });
}

// Re-bind the STT capture device when the user changes their default microphone.
// The dshow path pins a device name at startup, so without this, selecting a
// different mic (e.g. plugging in a headset) had no effect and recordings kept
// reading the old — often silent — device ("detected and active but doesn't hear
// me"). The WASAPI path uses "default" and already follows the change on its own,
// so we only rebind for dshow. Debounced and skipped while a recording is live.
let _sttRebindTimer = null;
function _maybeRebindSttDevice() {
  if (!_sttDeviceReady || _sttUseWasapi) return;          // wasapi follows "default" already
  if (!cachedMicLabel || cachedMicLabel === _boundMicLabel) return;
  if (_sttRebindTimer) return;
  _sttRebindTimer = setTimeout(async () => {
    _sttRebindTimer = null;
    if (_sttPending.size > 0) { _maybeRebindSttDevice(); return; } // try again after the current capture
    if (!cachedMicLabel || cachedMicLabel === _boundMicLabel) return;
    process.stdout.write(`[STT] Default mic changed to "${cachedMicLabel}" — rebinding capture device\n`);
    try {
      await _initSttDevice();
      // The wake listener pins the device at spawn time — bounce it so it
      // re-reads the rebound input args instead of listening to the old mic.
      wakeWord.bounce();
    } catch (e) { process.stdout.write('[STT] Rebind error: ' + e.message + '\n'); }
  }, 800);
}

function pcmToWav(pcmBytes, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const buf = Buffer.alloc(44 + pcmBytes.length);
  buf.write('RIFF', 0);         buf.writeUInt32LE(36 + pcmBytes.length, 4);
  buf.write('WAVE', 8);         buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);    buf.writeUInt16LE(1, 20);  // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  buf.writeUInt16LE(channels * bitsPerSample / 8, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);        buf.writeUInt32LE(pcmBytes.length, 40);
  pcmBytes.copy(buf, 44);
  return buf;
}

const STT_LANG_NAMES = { it: 'Italian', en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese' };

function _transcribeAudio(audioB64, mimeType, apiKey, lang) {
  const ALLOWED_AUDIO = new Set(['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/mp4', 'audio/wav']);
  const safeMime = ALLOWED_AUDIO.has(mimeType) ? mimeType : 'audio/webm';
  const safeLang = String(lang || 'en').toLowerCase().slice(0, 2);
  const langName = STT_LANG_NAMES[safeLang] || 'English';
  // Build a language-aware transcription prompt. The user may mix the UI language
  // with English proper nouns (app names, brand names) — keep them as separate words.
  const mixExample = safeLang === 'it'
    ? 'e.g. "apri Steam" not "apristim"; "apri Spotify" not "aprispot"'
    : 'e.g. "open Steam" not "opensteam"; "open Spotify" not "openspotify"';
  const sttPrompt = `Transcribe this audio exactly as spoken in ${langName}. Output only the transcribed text, nothing else — no explanations, no punctuation beyond what was said. The user may mix ${langName} commands with English proper nouns (app names, brand names): always output them as separate words with a space between them (${mixExample}). The recording may begin with a short notification chime or activation tone — ignore it completely and transcribe only human speech that follows. If the audio contains only silence, background noise, breathing, chimes, or music with no clear human speech, output exactly an empty string. Do NOT guess, invent, or output placeholder text.`;
  const payload = JSON.stringify({
    contents: [{ parts: [
      { text: sttPrompt },
      { inline_data: { mime_type: safeMime, data: audioB64 } },
    ] }],
    generationConfig: { temperature: 0, maxOutputTokens: 256, candidateCount: 1, thinkingConfig: { thinkingBudget: 0 } },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${AI_MODELS.chat}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
    }, (geminiRes) => {
      let d = '';
      geminiRes.on('data', c => { d += c; });
      geminiRes.on('end', () => {
        process.stdout.write(`[STT] Gemini status=${geminiRes.statusCode} body=${d.slice(0, 400)}\n`);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            return;
          }
          resolve(((parsed?.candidates?.[0]?.content?.parts) || []).filter(p => p.text && !p.thought).map(p => p.text).join('').trim() || '');
        } catch { reject(new Error('Gemini invalid JSON: ' + d.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// Recent Gemini models occasionally "leak" a tool call as plain text — e.g.
// `[call:default_api:genesis_compose_page{name:Studio,widgets:[notes,tasks]}]`
// — instead of emitting a structured functionCall part. Without this fallback
// the call is never executed and the raw text is shown/spoken to the user.
// Returns { name, args } when the text contains a leaked call to a known
// function, or null. Pseudo-JSON args (unquoted keys/values) are tolerated.
const LEAKED_CALL_RE = /\[?\s*(?:tool_code\s+|call\s*:\s*)(?:default_api[.:])?\s*([A-Za-z0-9_]+)\s*[{(]([\s\S]*?)[)}]\s*\]?/;
function _parseLeakedToolCall(text, validNames) {
  const m = String(text || '').match(LEAKED_CALL_RE);
  if (!m || !validNames.has(m[1])) return null;
  const raw = m[2].trim();
  if (!raw) return { name: m[1], args: {} };
  // Quote bare words (keys and string values) so the pseudo-JSON parses;
  // already-quoted strings, numbers, true/false/null pass through untouched.
  const fixed = ('{' + raw + '}').replace(
    /"[^"]*"|'[^']*'|([A-Za-z_][A-Za-z0-9_\- ]*)/g,
    (tok, bare) => {
      if (bare === undefined) return tok.startsWith("'") ? JSON.stringify(tok.slice(1, -1)) : tok;
      const t = bare.trim();
      return /^(true|false|null)$/.test(t) ? t : JSON.stringify(t);
    }
  );
  try {
    const args = JSON.parse(fixed);
    return (args && typeof args === 'object') ? { name: m[1], args } : null;
  } catch { return null; }
}

// Web search via Gemini grounding. Runs as a SEPARATE call from the main chat
// because the google_search grounding tool cannot be combined with
// functionDeclarations in the same request (doing so makes Gemini return empty
// responses). Returns a short grounded answer plus source URLs. On any failure
// resolves with an { error } object so the caller can degrade gracefully.
function _geminiWebSearch(query, apiKey) {
  return new Promise((resolve) => {
    const q = String(query || '').trim().slice(0, 500);
    if (!q) return resolve({ error: 'empty query' });
    const payload = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: q }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 700, candidateCount: 1, thinkingConfig: { thinkingBudget: 0 } },
    });
    const t0 = Date.now();
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${AI_MODELS.chat}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
    }, (r) => {
      let d = '';
      r.on('data', c => { d += c; });
      r.on('end', () => {
        process.stdout.write(`[WebSearch] Gemini HTTP ${r.statusCode} in ${Date.now() - t0}ms\n`);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return resolve({ error: parsed.error.message || 'search error' });
          const cand = parsed?.candidates?.[0];
          const text = (cand?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
          // Collect grounding source URLs/titles when present
          const chunks = cand?.groundingMetadata?.groundingChunks || [];
          const sources = chunks
            .map(c => c.web && { title: c.web.title || '', uri: c.web.uri || '' })
            .filter(Boolean).slice(0, 5);
          if (!text) return resolve({ error: 'no result' });
          resolve({ answer: text, sources });
        } catch { resolve({ error: 'invalid JSON' }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'search timeout' }); });
    req.write(payload);
    req.end();
  });
}

// ── Performance Mode AI planner ──────────────────────────────────────────
// Given the current activity and the list of open apps, ask the configured
// provider which BACKGROUND apps are worth closing for this activity, plus a
// one-sentence explanation. The AI only curates app selection and reasoning —
// the blanket levers (pause animations, power plan) stay governed by the user's
// own toggles, and the result is re-validated against the actually-open apps so
// the model can never name something that isn't there. Returns null on any
// failure so the client falls back to the deterministic (manual) flow.
const PERF_LANG_NAMES = { it: 'Italian', en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese' };

function _perfPlanPrompt(activity, appNames, opts, lang, stats) {
  const langName = PERF_LANG_NAMES[String(lang || 'en').slice(0, 2)] || 'English';
  const levers = [];
  if (opts.pauseAnimations) levers.push('pausing the dashboard animations');
  if (opts.powerPlan && opts.powerPlan !== 'none') levers.push('switching Windows to a high-performance power plan');
  const leverText = levers.length ? `The user has also enabled: ${levers.join(' and ')}. ` : '';
  // Real measurements (when the stats probe succeeded): per-app RAM/CPU and the
  // system memory pressure, so the model reasons about actual cost, not name vibes.
  const byProc = new Map((stats && Array.isArray(stats.apps) ? stats.apps : [])
    .map(a => [String(a.proc || '').toLowerCase(), a]));
  const appList = appNames.map(n => {
    const s = byProc.get(String(n).toLowerCase());
    return s ? { name: n, ramMB: s.memMB, cpuPct: s.cpuPct } : { name: n };
  });
  const memLine = (stats && stats.totalMB)
    ? `System memory: ${stats.totalMB - stats.freeMB} of ${stats.totalMB} MB in use (${Math.round((1 - stats.freeMB / stats.totalMB) * 100)}%). `
    : '';
  return [
    `You help optimize a desktop PC for the user's current activity: "${activity}".`,
    leverText, memLine,
    `Here are the currently-open background apps with their measured RAM/CPU where known: ${JSON.stringify(appList)}.`,
    'Choose ONLY the apps that are clearly NOT needed for this activity and worth closing to free RAM/CPU',
    '(e.g. music players, chat apps, game launchers, update helpers). Prefer the apps that actually cost the',
    'most RAM/CPU; closing a 40 MB tray app is not worth it. Be CONSERVATIVE:',
    'never choose the app central to the activity (the game itself while gaming, the code editor while coding,',
    'the writing app while writing, the streaming software while streaming, the conferencing app during a meeting),',
    'browsers, or anything you are unsure about. It is fine to choose none.',
    `Respond with ONLY a JSON object (no markdown, no prose) of the form:`,
    `{"explanation":"<one short sentence in ${langName} describing what will be optimized and why — cite the measured RAM when relevant>","closeApps":["<exact app name from the list>"]}`,
  ].join(' ');
}

function _geminiGenerateJSON(prompt, apiKey, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 500, candidateCount: 1, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
    });
    const r = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${AI_MODELS.chat}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
    }, (resp) => {
      let d = '';
      resp.on('data', c => { d += c; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return resolve(null);
          resolve((parsed?.candidates?.[0]?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('').trim() || null);
        } catch { resolve(null); }
      });
    });
    r.on('error', () => resolve(null));
    r.setTimeout(timeoutMs, () => { r.destroy(); resolve(null); });
    r.write(payload);
    r.end();
  });
}

// Parse + clamp the model's JSON against what's actually allowed: only apps that
// were in the open list (case-insensitive), unique, capped.
function _normalizePerfPlan(rawText, appNames) {
  if (!rawText) return null;
  let obj;
  try { obj = JSON.parse(String(rawText).replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const lower = new Map(appNames.map(n => [String(n).toLowerCase(), n]));
  const seen = new Set();
  const closeApps = (Array.isArray(obj.closeApps) ? obj.closeApps : [])
    .map(n => lower.get(String(n).toLowerCase()))
    .filter(n => n && !seen.has(n) && seen.add(n))
    .slice(0, 12);
  return {
    explanation: String(obj.explanation || '').slice(0, 300),
    closeApps,
  };
}

async function _aiPerformancePlan({ activity, appNames, opts, provider, key, model, ollamaUrl, hardwareScan, lang, stats }) {
  const names = Array.isArray(appNames) ? appNames.filter(n => typeof n === 'string').slice(0, 40) : [];
  const safeActivity = ['gaming', 'coding', 'writing', 'streaming', 'creating', 'meeting', 'other'].includes(activity) ? activity : 'other';
  const prompt = _perfPlanPrompt(safeActivity, names, opts || {}, lang, stats);
  try {
    if (provider === 'ollama') {
      const baseUrl = aiLocal.sanitizeOllamaUrl(ollamaUrl);
      const concreteModel = aiLocal.resolveModel(model, hardwareScan);
      const r = await aiLocal.localChat({
        baseUrl, model: concreteModel, geminiTools: [], history: [{ role: 'user', parts: [{ text: prompt }] }],
        systemText: 'You output only a single JSON object, never prose or markdown.',
        executeTool: async () => ({ fnResult: {}, clientActions: [] }),
      });
      return _normalizePerfPlan(r && r.text, names);
    }
    if (provider === 'openai' || provider === 'anthropic') {
      // Server-only key comes from settings, not the request (unlike Gemini).
      const settings = await readHubSettings().catch(() => null);
      const mod = provider === 'openai' ? aiOpenai : aiAnthropic;
      const provKey = provider === 'openai' ? (settings && settings.openaiApiKey) : (settings && settings.anthropicApiKey);
      const provModel = provider === 'openai' ? (settings && settings.openaiModel) : (settings && settings.anthropicModel);
      if (!provKey) return null;
      const text = await mod.oneShot({ apiKey: provKey, model: provModel, systemText: 'You output only a single JSON object, never prose or markdown.', userText: prompt, maxTokens: 500 });
      return _normalizePerfPlan(text, names);
    }
    if (!key) return null;
    const text = await _geminiGenerateJSON(prompt, key);
    return _normalizePerfPlan(text, names);
  } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  if (!isAllowedRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // CORS headers required for the iCUE widget WebView (opaque origin, qrc:// or file://).
  // Access-Control-Allow-Private-Network is required by Chrome 104+ (Private Network
  // Access spec) when a non-secure context (file://) fetches a private-network address.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // JSONP support: if ?cb=<name> is present, wrap the response in a JS callback.
  // Used by the iCUE widget where fetch() is blocked by Qt WebEngine's
  // LocalContentCanAccessRemoteUrls policy; <script> tag injection bypasses it.
  const urlObj  = new URL(req.url, 'http://localhost');
  const jsonpCb = urlObj.searchParams.get('cb');
  const json    = data => {
    const body = JSON.stringify(data);
    // Local API responses are live state — never let the browser/WebView cache them
    // (a cached /api/lighting/status was masking real changes during diagnosis).
    if (jsonpCb && /^[A-Za-z_$][\w$]*$/.test(jsonpCb) && isJsonpAllowed(urlObj.pathname)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(jsonpCb + '(' + body + ');');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
    }
  };
  const err500 = msg  => { res.writeHead(500); res.end(String(msg)); };

  const reqPath = urlObj.pathname;

  // CSRF guard: reject cross-site drive-by requests to state-mutating endpoints.
  // The browser stamps Sec-Fetch-Site and a page can't forge it — a cross-site
  // <script>/<img>/fetch is 'cross-site', while the same-origin dashboard's own
  // fetch is 'same-origin'. Only the cross-site case is blocked; an absent header
  // (non-browser caller / older WebView) is allowed, same as the /deck/sound gate.
  // The SDK proxy/webhook POST routes are state-touching ingress that, like the
  // GET mutators above, must NOT be reachable by a cross-site drive-by. They rely
  // only on the Origin layer otherwise, and isAllowedRequest() deliberately
  // accepts `Origin: null` (Qt WebEngine) — so a hostile page's sandboxed iframe
  // (opaque origin → Origin: null) could otherwise reach them. Prefix match:
  // /sdk/hook carries a /<pkg>/<id> tail. Loopback tools send no Sec-Fetch-Site.
  const isSdkSensitive = reqPath === '/sdk/fetch' || reqPath.startsWith('/sdk/hook/') || reqPath === '/sdk/handler-ack' || reqPath === '/sdk/deck-states' || reqPath === '/sdk/store' || reqPath === '/sdk/secret';
  // Pack DELETE carries a /<id> tail (not an exact CSRF_MUTATION_PATHS entry),
  // so guard it by prefix — the same belt-and-suspenders the POST installs get,
  // so an Origin:null iframe can never remove a user's installed packs even if
  // the CORS method allowlist ever widens.
  const isPackMutation = req.method === 'DELETE' && (reqPath.startsWith('/icon-pack/') || reqPath.startsWith('/sound-pack/'));
  if ((CSRF_MUTATION_PATHS.has(reqPath) || isSdkSensitive || isPackMutation) &&
      String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (reqPath === '/' && req.method === 'GET') {
    const html = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
    // Never let the WebView serve a stale entry document: index.html carries the
    // early boot-scale recovery script, so a cached copy would pin an old fix.
    // The doc is tiny and loopback-served, so no-store costs nothing. (CSS/JS
    // already revalidate via no-cache + ETag below.)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);

  } else if (reqPath === '/deck-popup' && req.method === 'GET') {
    // Virtual Deck popup document (main-PC window). Same loopback trust as '/';
    // no-store so the popup never boots from a stale entry document.
    const html = await fs.promises.readFile(path.join(__dirname, 'deck-popup.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);

  } else if (reqPath === '/deck/popup/open' && req.method === 'POST') {
    // Open the Virtual Deck as an Edge app-mode window on the main PC (shared
    // helper — the AI's open_virtual_deck tool uses the same code path).
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await openDeckPopupWindow(String(body.instance || ''), body.topmost !== false));
    } catch (e) { json({ ok: false, error: (e && e.message) || 'popup_failed' }); }

  } else if (reqPath === '/toggle' && (req.method === 'POST' || req.method === 'GET')) {
    isMuted = !isMuted;
    setMicMute(isMuted);
    json({ muted: isMuted });

  } else if (reqPath === '/ping' && req.method === 'GET') {
    // 1×1 transparent GIF — used by the iCUE widget to probe connectivity via
    // Image() instead of fetch(), bypassing Qt WebEngine's LocalContentCanAccessRemoteUrls block.
    const gif = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
    res.end(gif);

  } else if (reqPath === '/status' && req.method === 'GET') {
    // The exact app version stays off the JSONP-readable shape: ?cb= responses
    // are readable cross-site by design (script-tag transport), and the version
    // would make a drive-by fingerprint needlessly precise. The plain GET and
    // the SSE broadcast keep it (loopback/Origin-guarded) — it drives the
    // stale-page reload fence in main.js.
    const st = statusPayload();
    if (jsonpCb) delete st.version;
    json(st);

  } else if (reqPath === '/system/theme' && req.method === 'GET') {
    // Reliable OS theme for the "Auto" appearance: the embedded WebView's
    // prefers-color-scheme is unreliable, so read Windows' app theme from the
    // registry. AppsUseLightTheme: 0x0 = dark apps, 0x1 = light apps.
    execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'],
      { windowsHide: true, timeout: 4000 }, (e, stdout) => {
        let osDark = null;
        if (!e && stdout) {
          const m = stdout.match(/AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i);
          if (m) osDark = parseInt(m[1], 16) === 0;
        }
        json({ osDark });
      });

  } else if (reqPath === '/audio' && req.method === 'GET') {
    // On failure (SoundVolumeView missing/blocked) return an explicit
    // { unavailable } marker with 200 so the polling fallback can render the
    // Volume section's "audio unavailable" notice, matching the SSE path.
    try   { json(await getAudioInfo()); }
    catch { json({ unavailable: true }); }

  } else if (reqPath === '/system' && req.method === 'GET') {
    try   { json(await getSystemInfo()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/api/battery' && req.method === 'GET') {
    // Read-only seed for the battery widget / deck editor (SSE 'battery'
    // pushes updates afterwards). Never a JSONP candidate.
    try   { json(await batteryMonitor.getDevices()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/system/enable-sensors' && req.method === 'POST') {
    // One-tap repair for `sensorAccess: 'needs_admin'`: raise the startup task to
    // RunLevel Highest through a UAC prompt, so LHM can load its kernel driver and
    // CPU temperature / fan RPM / CPU watts start working. Fixed argv, no request
    // value ever reaches a command line; the UAC prompt is the real gate, so the
    // worst a drive-by achieves is a prompt the user declines. POST-only, never
    // JSONP, and listed in CSRF_MUTATION_PATHS.
    try {
      const out = await runPowerShellScript(ENABLE_SENSORS_SCRIPT, [], 120000);
      json(out && typeof out === 'object' ? out : { ok: false, status: 'failed', message: 'no result' });
    } catch (e) { json({ ok: false, status: 'failed', message: e.message }); }

  } else if (reqPath === '/network' && req.method === 'GET') {
    try   { json(await getNetworkInfo()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/api/gamemode/status' && req.method === 'GET') {
    // Game mode runs off foreground full-screen detection (no PresentMon needed).
    // PresentMon is reported only so Settings can offer the optional FPS-readout
    // install button. The foreground field is a live diagnostic for false positives.
    try {
      json({
        presentMonAvailable: fpsMonitor.isAvailable(),
        gaming: gameDetect.isGaming(),
        gameRunning: gameDetect.isGameRunning(),
        gameProcess: gameDetect.getGameProcess(),
        activity: gameDetect.getActivity(),
        foreground: gameDetect.getGamingWindow(),
        diag: (typeof gameDetect.getGameDiag === 'function') ? gameDetect.getGameDiag() : null,
        fps: fpsMonitor.getGamingProcess(),
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/performance/stats' && req.method === 'GET') {
    // Read-only system snapshot for Performance Mode: memory pressure + the top
    // processes by RAM with a CPU% estimate. Feeds the optimization sheet (per-app
    // memory chips), the deterministic preselect, and the AI planner.
    try   { json(await runPowerShellScript(PERFORMANCE_SCRIPT, ['stats'], 9000)); }
    catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/performance/powerplan' && req.method === 'GET') {
    // Performance Mode: read the active Windows power scheme so the client can
    // remember it before switching, then restore it on exit. Fully reversible.
    try   { json(await runPowerShellScript(PERFORMANCE_SCRIPT, ['get'], 6000)); }
    catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/performance/powerplan' && req.method === 'POST') {
    // Switch to a known high-performance plan ('high'/'ultimate') or restore a
    // previously-saved scheme by GUID. The .ps1 rejects anything else.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const value = String(body.value || '').trim();
      const isPreset = value === 'high' || value === 'ultimate';
      const isGuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
      if (!isPreset && !isGuid) { res.writeHead(400); res.end('Invalid power plan'); return; }
      json(await runPowerShellScript(PERFORMANCE_SCRIPT, ['set', value], 8000));
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/performance/plan' && req.method === 'POST') {
    // AI planner for Performance Mode: returns { explanation, closeApps } curated
    // for the current activity, or { ok:false } so the client falls back to the
    // deterministic flow. The AI only picks among the open apps it's given.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const settings = (await readHubSettings().catch(() => null)) || {};
      const provider = aiLocal.sanitizeProvider(body.provider);
      const opts = (body.opts && typeof body.opts === 'object') ? body.opts : {};
      // Measure here (server-side) so the plan reasons on real RAM/CPU numbers;
      // a failed probe degrades to the old name-only prompt.
      const stats = await runPowerShellScript(PERFORMANCE_SCRIPT, ['stats'], 9000).catch(() => null);
      const plan = await _aiPerformancePlan({
        activity: String(body.activity || 'other'),
        appNames: Array.isArray(body.apps) ? body.apps : [],
        opts,
        provider,
        key: String(body.key || settings.geminiApiKey || '').trim(),
        model: aiLocal.sanitizeModel(body.model || settings.ollamaModel),
        ollamaUrl: body.ollamaUrl || settings.ollamaUrl,
        hardwareScan: settings.hardwareScan,
        lang: String(body.lang || 'en'),
        stats: (stats && stats.ok) ? stats : null,
      });
      if (!plan) { json({ ok: false }); return; }
      json({ ok: true, plan });
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/lighting/status' && req.method === 'GET') {
    try {
      // If the session is up but the device list looks incomplete — empty, or a
      // device enumerated with 0 LEDs (the iCUE LINK hub reports 0 until iCUE
      // finishes registering the cooler/fans behind it, common right after a boot)
      // — kick a throttled, bounded re-enumeration so a follow-up status refresh
      // (and the next paint) see the real LED layout.
      if (lighting.isConnected()) {
        Promise.resolve(lighting.boundedReenumerate()).catch(() => {});
      }
      json(lighting.getStatus());
    }
    catch (e) { json({ available: false, reason: e.message }); }

  } else if (reqPath === '/api/lighting/devices' && req.method === 'GET') {
    // Flat device list for the Deck editor's per-device lighting picker:
    // [{ value: id, label }] — iCUE devices plus every external-provider device.
    try {
      const ls = lighting.getStatus();
      const out = [];
      (ls.devices || []).forEach((dv) => out.push({ value: dv.id, label: dv.name || dv.id }));
      (ls.providers || []).forEach((p) => (p.devices || []).forEach((dv) => out.push({ value: dv.id, label: (p.name ? p.name + ' · ' : '') + (dv.name || dv.id) })));
      json({ devices: out });
    } catch (e) { json({ devices: [] }); }

  } else if (reqPath === '/api/lighting/effects' && req.method === 'POST') {
    // Apply a partial config change immediately, then persist it so Lighting-page
    // (and AI-driven) toggles survive a server restart.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      lighting.applyConfig(body);
      // Enabling connects asynchronously — wait briefly so the response carries
      // the connected state and the freshly-enumerated device list.
      if (body && body.enabled === true) { try { await lighting.ensureConnected(); } catch {} }
      await _persistLighting();
      json(lighting.getStatus());
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/lighting/manual' && req.method === 'POST') {
    // Manual fixed colour — persisted so it survives a restart.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      let ok = true;
      if (body && body.clear) lighting.clearManual();
      else ok = lighting.setManualColor(body && body.color);
      await _persistLighting();
      json({ ok });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/lighting/album' && req.method === 'POST') {
    // Live now-playing cover colour from the client. Transient (not persisted),
    // like the manual override; the bridge ignores it when the effect is off.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      if (body && body.clear) { lighting.clearAlbum(); json({ ok: true }); }
      else json({ ok: lighting.setAlbumColor(body && body.color, body && body.palette) });
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/lighting/event' && req.method === 'POST') {
    // Client-originated event flash (reminder / notification). Timer is fired
    // server-side from _checkTimers. Never throws; unknown/disabled type = no-op.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      lighting.onEvent(String(body && body.type || ''));
      json({ ok: true });
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/vitals/nag' && req.method === 'POST') {
    // Bit's PC-side nag actions (vitals-pet.js). Defense in depth — each rung
    // re-checks its own strict opt-in from the SERVER settings mirror (a forged
    // loopback request can never exceed what the user enabled), respects the
    // in-game truce, requires FRESH real input for minimize/lock (never punish
    // an empty chair), and rate-limits itself. The overlay script is one-shot
    // and self-terminating (≤30s), so there is nothing to stop at shutdown.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const action = String(body && body.action || '');
      const pet = vitalsPetCfg();
      if (!pet) { json({ ok: false, error: 'pet_disabled' }); return; }
      let gaming = false;
      try { gaming = gameDetect.isGaming(); } catch { gaming = false; }
      if (gaming && pet.quietInGame !== false) { json({ ok: false, error: 'in_game' }); return; }
      const now = Date.now();
      const idleFresh = _idleProbe.at > 0 && (now - _idleProbe.at) < 60000 && typeof _idleProbe.sec === 'number';
      const presentNow = idleFresh && _idleProbe.sec < 240;
      const text = String(body && body.text || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
      const mood = ['angry', 'ghost', 'worried'].includes(body && body.mood) ? body.mood : 'angry';
      // Consolas (the popup's default) has no CJK glyphs, so Korean/Japanese/
      // Chinese would render as tofu boxes. Pick a script-capable Windows-bundled
      // font for those; everyone else keeps the crisp mono look. The .ps1 falls
      // back to Consolas if the named font can't be created.
      const NAG_FONTS = { ko: 'Malgun Gothic', ja: 'Yu Gothic UI', zh: 'Microsoft YaHei' };
      const langCode = String(body && body.lang || '').toLowerCase().replace('_', '-').slice(0, 2);
      const nagFont = NAG_FONTS[langCode] || 'Consolas';
      const spawnNag = (extra) => {
        const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', VITALS_NAG_SCRIPT,
          '-Text', text, '-Mood', mood, '-Duration', '9', '-Font', nagFont, ...extra];
        const child = spawn('powershell.exe', args, { windowsHide: true });
        child.on('error', () => {});
        child.unref();
      };
      if (action === 'overlay') {
        if (pet.monitors !== true) { json({ ok: false, error: 'not_enabled' }); return; }
        if (now - _vitalsNagLast.overlay < 40000) { json({ ok: false, error: 'cooldown' }); return; }
        _vitalsNagLast.overlay = now;
        spawnNag(body && body.all === true ? ['-AllScreens'] : []);
        json({ ok: true });
      } else if (action === 'minimize') {
        if (pet.minimize !== true) { json({ ok: false, error: 'not_enabled' }); return; }
        if (!presentNow) { json({ ok: false, error: 'away' }); return; }
        if (now - _vitalsNagLast.minimize < 4 * 60000) { json({ ok: false, error: 'cooldown' }); return; }
        _vitalsNagLast.minimize = now;
        spawnNag(['-Minimize']);
        json({ ok: true });
      } else if (action === 'lock') {
        if (pet.lock !== true) { json({ ok: false, error: 'not_enabled' }); return; }
        if (!presentNow) { json({ ok: false, error: 'away' }); return; }
        if (now - _vitalsNagLast.lock < 10 * 60000) { json({ ok: false, error: 'cooldown' }); return; }
        _vitalsNagLast.lock = now;
        // Make the attribution unmissable on the PC itself: flash Bit's "I'm
        // locking this" popup on every monitor FIRST, then lock a few seconds
        // later — otherwise the Windows lock screen swallows the message and the
        // user never learns it was Bit. Falls back to an immediate lock if the
        // client sent no text (older dashboards).
        if (text) spawnNag(['-AllScreens']);
        setTimeout(() => { lockWorkstation().catch(() => {}); }, text ? 3500 : 0);
        json({ ok: true });
      } else {
        json({ ok: false, error: 'unknown_action' });
      }
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/lighting/animation' && req.method === 'POST') {
    // Ambient animation (none|solid|breathing|cycle). Persisted so it survives a
    // restart. The render loop only spins while a dynamic style is actively painting.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      lighting.setAnimation(body);
      await _persistLighting();
      json(lighting.getStatus());
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/lighting/device-mode' && req.method === 'POST') {
    // Per-device override: { id, mode, color?, anim? }. Persisted.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const ok = lighting.setDeviceMode(String(body && body.id || ''), body || {});
      await _persistLighting();
      json({ ok, status: lighting.getStatus() });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/lighting/scan' && req.method === 'POST') {
    // On-demand LAN discovery for external providers (WLED, …). No background scan.
    try {
      const result = await lighting.scanExternal();
      await _persistLighting();
      json({ ok: true, found: result.found, status: lighting.getStatus() });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/lighting/device' && req.method === 'POST') {
    // Add / remove / opt-in an external device. body: { provider, action, host?, id?, optedIn? }
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const provider = String(body && body.provider || '');
      const action = String(body && body.action || '');
      let result = { ok: false };
      if (action === 'add') {
        const dev = await lighting.addExternalDevice(provider, String(body.host || ''));
        result = { ok: !!dev, device: dev || null };
      } else if (action === 'pair') {
        const r = await lighting.pairExternalDevice(provider, String(body.host || ''));
        result = { ok: !!(r && r.ok), needsButton: !!(r && r.needsButton) };
      } else if (action === 'remove') {
        result = { ok: lighting.removeExternalDevice(provider, String(body.id || '')) };
      } else if (action === 'optin') {
        result = { ok: lighting.setExternalDeviceOptIn(provider, String(body.id || ''), body.optedIn !== false) };
      }
      await _persistLighting();
      json({ ...result, status: lighting.getStatus() });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/lighting/open-download' && req.method === 'POST') {
    // Open a provider's official download page in the default browser. The URL is
    // resolved server-side from the provider catalogue, never taken from the client.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const provider = String(body && body.provider || '');
      const entry = lighting.getExternalStatus().providers.find(p => p.id === provider);
      const url = entry && entry.download;
      if (url && /^https:\/\//i.test(url)) {
        execFile('cmd', ['/c', 'start', '', url], () => {});
        json({ ok: true, url });
      } else {
        json({ ok: false, error: 'no download url' });
      }
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/guardian/history' && req.method === 'GET') {
    // Guardian hardware-health history for the dashboard charts (same local data
    // the AI digest summarises). Read-only; harmless when Guardian is disabled —
    // it just returns whatever buckets were collected while it was last on.
    try { json(await guardian.getHistory()); }
    catch (e) { json({ enabled: false, hours: [], days: [], error: e.message }); }

  } else if (reqPath === '/api/ai/memory' && req.method === 'GET') {
    // Persistent AI memory — list what Xenon remembers about the user (for the
    // Settings → Funzioni AI viewer). Local data; loopback-guarded like all routes.
    try {
      const s = await readHubSettings().catch(() => null);
      json({ enabled: !(s && s.aiMemory === false), facts: aiMemory.list() });
    } catch (e) { json({ enabled: true, facts: [], error: e.message }); }

  } else if (reqPath === '/api/ai/memory' && req.method === 'POST') {
    // Add a fact by hand from Settings (the AI adds facts via remember_fact).
    try {
      const raw = await readBodyBuffer(req, 4 * 1024);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      json(await aiMemory.add(String(body.text || body.fact || '')));
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/ai/memory' && req.method === 'DELETE') {
    // Remove one fact (by id) or clear everything ({ all: true }).
    try {
      const raw = await readBodyBuffer(req, 4 * 1024);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      json(body.all === true ? await aiMemory.clear() : await aiMemory.remove(String(body.id || body.text || '')));
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/ai/actions' && req.method === 'GET') {
    // Recent AI actions + the latest still-undoable one (for the chat's "undo"
    // affordance and a "what did you just do" view). Local, loopback-guarded.
    const last = aiActionLog.lastUndoable();
    json({ actions: aiActionLog.list(), last: last ? { id: last.id, label: last.label, name: last.name } : null });

  } else if (reqPath === '/api/ai/actions/undo' && req.method === 'POST') {
    // Undo an AI action by id, or the most recent undoable one when no id given.
    try {
      const raw = await readBodyBuffer(req, 4 * 1024);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const entry = body.id ? aiActionLog.get(String(body.id)) : aiActionLog.lastUndoable();
      if (!entry) { json({ ok: false, error: 'not_found' }); return; }
      const r = await performAiUndo(entry);
      if (r.ok) aiActionLog.markUndone(entry.id);
      json(r);
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/gamemode/install-presentmon' && req.method === 'POST') {
    // One-click download of the classic single-binary PresentMon CLI (the same
    // v1.10.0 asset install.ps1 fetches), placed in server/presentmon/.
    try {
      if (fpsMonitor.isAvailable()) { json({ ok: true, alreadyInstalled: true }); }
      else {
        const ps = [
          "$ErrorActionPreference='Stop';",
          "$dir=$env:PM_DIR; $exe=Join-Path $dir 'PresentMon.exe';",
          "if(-not(Test-Path $dir)){New-Item -ItemType Directory -Path $dir -Force | Out-Null};",
          '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;',
          "$h=@{'User-Agent'='XenonEdgeHub';'Accept'='application/vnd.github+json'};",
          "$rel=Invoke-RestMethod -Uri 'https://api.github.com/repos/GameTechDev/PresentMon/releases/tags/v1.10.0' -Headers $h -TimeoutSec 25;",
          "$a=$rel.assets | Where-Object { $_.name -match 'PresentMon.*x64.*\\.exe$' } | Select-Object -First 1;",
          "if(-not $a){$a=$rel.assets | Where-Object { $_.name -match '\\.exe$' } | Select-Object -First 1};",
          "if(-not $a){throw 'no PresentMon x64 executable in release assets'};",
          "Invoke-WebRequest -Uri $a.browser_download_url -OutFile $exe -Headers @{'User-Agent'='XenonEdgeHub'} -TimeoutSec 120 -UseBasicParsing;",
          "if(-not(Test-Path $exe)){throw 'download did not produce PresentMon.exe'}",
        ].join(' ');
        await new Promise((resolve, reject) =>
          execFile('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
            { windowsHide: true, timeout: 180000, env: { ...process.env, PM_DIR: path.join(__dirname, 'presentmon') } },
            (psErr) => psErr ? reject(psErr) : resolve()
          )
        );
        try { fpsMonitor.reload(); } catch { /* monitor will retry on its own */ }
        json({ ok: true, installed: true });
      }
    } catch (e) {
      err500('PresentMon non installato: ' + (e && e.message ? e.message : 'download fallito'));
    }

  } else if (reqPath === '/api/icue/sharpen' && req.method === 'POST') {
    // Fix for the blurry dashboard in iCUE widget mode (issue #53): nudge iCUE's
    // Xeneon Edge window by 1px and back so Qt re-reads which screen it is on and
    // pushes the correct device scale to the widget renderer (see icue-sharpen.ps1
    // for the full mechanism). Triggered by the dashboard itself when it detects
    // it is being rasterised at another monitor's scale. Cooldown guards against
    // a client retry loop; the wiggle is idempotent when the scale is already right.
    try {
      const now = Date.now();
      if (now - lastIcueSharpenAt < 3000) { json({ ok: false, error: 'cooldown' }); }
      else {
        lastIcueSharpenAt = now;
        json(await runPowerShellScript(ICUE_SHARPEN_SCRIPT, [], 15000));
      }
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/weather' && req.method === 'GET') {
    try {
      const requestedWeather = urlObj.searchParams.has('mode') || urlObj.searchParams.has('city')
        ? { mode: urlObj.searchParams.get('mode'), city: urlObj.searchParams.get('city') }
        : null;
      json(await getWeather(urlObj.searchParams.get('lang') || 'en', requestedWeather));
    }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media' && req.method === 'GET') {
    try {
      if (urlObj.searchParams.has('source')) setMediaPreferredSource(urlObj.searchParams.get('source'));
      json(await getMediaInfo());
    }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media/source' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let body = {};
      if (req.method === 'POST') body = JSON.parse(await readBody(req) || '{}');
      const source = body.source ?? urlObj.searchParams.get('source') ?? '';
      json({ ok: true, preferredSource: setMediaPreferredSource(source) });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/media/playpause' && (req.method === 'POST' || req.method === 'GET')) {
    try   { json(await mediaAction('playpause')); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media/next' && (req.method === 'POST' || req.method === 'GET')) {
    try   { json(await mediaAction('next')); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media/previous' && (req.method === 'POST' || req.method === 'GET')) {
    try   { json(await mediaAction('previous')); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/windows' && req.method === 'GET') {
    try   { json(await runWindowsTool(['list'], 12000)); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/windows/focus' && req.method === 'POST') {
    try {
      const { id } = JSON.parse(await readBody(req));
      if (!id || typeof id !== 'string' || !/^\d{1,24}$/.test(id)) {
        res.writeHead(400); res.end('Invalid window id'); return;
      }
      json(await runWindowsTool(['focus', id], 5000));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/windows/close' && req.method === 'POST') {
    // Gracefully close a window (WM_CLOSE; the helper refuses protected processes
    // and never force-kills). POST-only, so the loopback Origin/Sec-Fetch checks
    // guard it from a cross-site drive-by.
    try {
      const { id } = JSON.parse(await readBody(req));
      if (!id || typeof id !== 'string' || !/^\d{1,24}$/.test(id)) {
        res.writeHead(400); res.end('Invalid window id'); return;
      }
      json(await runWindowsTool(['close', id], 8000));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/windows/launch' && req.method === 'POST') {
    // Launch a favorited app that isn't currently open, by its stored exe path.
    // The path came from the server's own window enumeration, but it is re-validated
    // through the SAME allowlisted openApp runner the Deck uses (exe/.lnk only +
    // existence check) before anything spawns — never trusted blindly.
    try {
      const { path: appPath } = JSON.parse(await readBody(req));
      if (!appPath || typeof appPath !== 'string') {
        res.writeHead(400); res.end('Missing path'); return;
      }
      json(await deckRegistry.run({ type: 'openApp', path: appPath }));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/volume/set' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let level;
      if (req.method === 'GET') {
        level = parseInt(urlObj.searchParams.get('level'));
      } else {
        ({ level } = JSON.parse(await readBody(req)));
      }
      const vol = Math.max(0, Math.min(100, parseInt(level)));
      if (!cachedSpeakerId) { err500('Cache not ready'); return; }
      execFile(SVV, ['/SetVolume', cachedSpeakerId, String(vol)], e => {
        if (e) err500(e.message); else json({ ok: true, level: vol });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/mic/volume' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let level;
      if (req.method === 'GET') {
        level = parseInt(urlObj.searchParams.get('level'));
      } else {
        ({ level } = JSON.parse(await readBody(req)));
      }
      const vol = Math.max(0, Math.min(100, parseInt(level)));
      if (!cachedMicId) { err500('Cache not ready'); return; }
      // Natural behaviour: 0 = silent (muted), >0 = audible at that level.
      execFile(SVV, ['/SetVolume', cachedMicId, String(vol)], e1 => {
        if (e1) { err500(e1.message); return; }
        execFile(SVV, [vol === 0 ? '/Mute' : '/Unmute', cachedMicId], e => {
          if (e) err500(e.message); else json({ ok: true, level: vol });
        });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/speaker/mute' && (req.method === 'POST' || req.method === 'GET')) {
    if (!cachedSpeakerId) { err500('Cache not ready'); return; }
    execFile(SVV, ['/Switch', cachedSpeakerId], e => {
      if (e) err500(e.message); else json({ ok: true });
    });

  } else if (reqPath === '/audio/app/volume' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let id, level, proc;
      if (req.method === 'GET') {
        id = urlObj.searchParams.get('id');
        proc = urlObj.searchParams.get('proc');
        level = parseInt(urlObj.searchParams.get('level'));
      } else {
        ({ id, level, proc } = JSON.parse(await readBody(req)));
      }
      if (!id && !proc) { err500('Missing id'); return; }
      // Prefer the durable process-name target over the session CLI id, which
      // SoundVolumeView rotates across app restarts (a stale id is a silent miss).
      const target = proc ? appAudioTarget(proc) : id;
      const vol = Math.max(0, Math.min(100, parseInt(level)));
      // Natural behaviour: 0 = silent (muted) for that app, >0 = audible.
      execFile(SVV, ['/SetVolume', target, String(vol)], e1 => {
        if (e1) { err500(e1.message); return; }
        execFile(SVV, [vol === 0 ? '/Mute' : '/Unmute', target], e => {
          if (e) err500(e.message); else json({ ok: true, level: vol });
        });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/audio/app/mute' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let id, muted, proc;
      if (req.method === 'GET') {
        id = urlObj.searchParams.get('id');
        proc = urlObj.searchParams.get('proc');
        muted = urlObj.searchParams.get('muted');
      } else {
        ({ id, muted, proc } = JSON.parse(await readBody(req)));
      }
      if (!id && !proc) { err500('Missing id'); return; }
      // Prefer the durable process-name target over the volatile session CLI id.
      const target = proc ? appAudioTarget(proc) : id;
      // Explicit state (deterministic) when the client tells us; else toggle.
      const action = muted === undefined || muted === null
        ? '/Switch'
        : ((muted === true || muted === 'true' || muted === '1') ? '/Mute' : '/Unmute');
      execFile(SVV, [action, target], e => {
        if (e) err500(e.message); else json({ ok: true });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/audio/apps' && req.method === 'GET') {
    // Broader app list for the Deck editor's app picker: every application audio
    // session (active OR inactive) that has a real exe, deduped by process name.
    // Wider than /audio (which only surfaces apps currently producing sound) so a
    // key can be configured for an app that isn't playing right now.
    try {
      const rows = await readSoundVolumeRows();
      const SYS_RE = /^(audiodg|rtkuwp|system|dwm|explorer|searchhost|shellexperiencehost|startmenuexperiencehost|textinputhost|applicationframehost|nvcontainer)$/i;
      const procOf = f => ((f[F.PROC_PATH] || '').split('\\').pop() || '').replace(/\.exe$/i, '');
      const seen = new Map();
      for (const f of rows) {
        if (f[F.TYPE] !== 'Application' || !f[F.PROC_PATH]) continue;
        const proc = procOf(f);
        if (!proc || SYS_RE.test(proc)) continue;
        const key = proc.toLowerCase();
        if (!seen.has(key)) seen.set(key, { proc, name: f[F.NAME] || f[F.WINDOW_TITLE] || proc });
      }
      json({ ok: true, apps: [...seen.values()] });
    } catch (e) { json({ ok: false, apps: [], error: e.message }); }

  } else if (reqPath === '/deck/sound' && req.method === 'GET') {
    // Stream a user-chosen local audio file for the Deck soundboard. The browser
    // plays it; the file path comes from the user's own Deck config (same trust
    // level as the open-file/open-app actions). This is the only route that returns
    // raw file CONTENTS for a client-supplied path, so it is hardened two ways:
    //   1. Fetch Metadata gate — reject cross-site requests. The browser stamps
    //      `Sec-Fetch-Site` and a page can't forge it, so a malicious site can't
    //      point an <audio> at this route to read/play local files; only the
    //      same-origin dashboard can. (Absent header = non-browser caller, which
    //      already has direct filesystem access — no escalation.)
    //   2. Extension allowlist — only audio files, so it can't read documents/secrets.
    // Range is supported so <audio> seeking works.
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      res.writeHead(403); res.end(); return;
    }
    try {
      const SOUND_MIME = {
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
        '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/opus', '.weba': 'audio/webm',
      };
      // Two accepted shapes: an absolute local path (the user's own machine-
      // local clip — same trust level as open-file keys), or a PACK-RELATIVE
      // ref ('packs/<packId>/<clipId>.<ext>') resolved under the sounds dir.
      // The pack shape is what shared Deck profiles carry (machine-independent)
      // and is validated segment-by-segment + prefix-asserted in sound-packs.js
      // BEFORE path.resolve can ever see it.
      const rawPath = urlObj.searchParams.get('path') || '';
      const abs = soundPackStore.resolve(rawPath) || path.resolve(rawPath);
      const mime = SOUND_MIME[path.extname(abs).toLowerCase()];
      if (!mime) { res.writeHead(415); res.end(); return; }
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) { res.writeHead(404); res.end(); return; }

      const baseHeaders = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      const range = req.headers.range;
      if (range) {
        const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
        if (!match) { res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
        const suffixLength = match[1] === '' ? Number(match[2]) : null;
        const start = suffixLength !== null ? Math.max(0, stat.size - suffixLength) : Number(match[1]);
        const end = match[2] === '' || suffixLength !== null ? stat.size - 1 : Number(match[2]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= stat.size) {
          res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` }); res.end(); return;
        }
        res.writeHead(206, { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(end - start + 1) });
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { ...baseHeaders, 'Content-Length': String(stat.size) });
      fs.createReadStream(abs).pipe(res);
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') { res.writeHead(404); res.end(); }
      else err500(e.message);
    }

  } else if (reqPath === '/deck/sound-upload' && req.method === 'POST') {
    // Soundboard library upload: store the clip under DATA_DIR/sounds with a
    // SERVER-GENERATED name (the client filename never reaches the path — same
    // shape as /background). Playback still flows through /deck/sound?path=,
    // which stays the single extension-gated reader of audio contents.
    try {
      const body = await readBodyBuffer(req, DECK_SOUND_MAX_BYTES);
      const file = parseMultipartBackground(req, body, 'sound');
      const ext = path.extname(file.originalName).toLowerCase();
      if (!DECK_SOUND_EXTS.has(ext)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported file type' }));
        return;
      }
      // MIME consistency check, same shape as /background: a declared non-audio
      // content type must not land under an audio extension. Browsers report
      // audio types inconsistently, so only an explicit NON-audio type rejects
      // (octet-stream/empty pass — the extension allowlist stays the real gate).
      const ct = String(file.contentType || '').toLowerCase();
      if (ct && ct !== 'application/octet-stream' && !ct.startsWith('audio/') && ct !== 'video/webm') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File type mismatch' }));
        return;
      }
      await fs.promises.mkdir(DECK_SOUNDS_DIR, { recursive: true });
      const safeName = `sound-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
      const safePath = path.join(DECK_SOUNDS_DIR, safeName);
      await fs.promises.writeFile(safePath, file.data);
      json({ ok: true, path: safePath, name: file.originalName, size: file.data.length });
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }

  } else if (reqPath === '/deck/sounds' && req.method === 'GET') {
    // The uploaded soundboard library (for the editor's sound picker).
    try {
      let entries = [];
      try { entries = await fs.promises.readdir(DECK_SOUNDS_DIR, { withFileTypes: true }); } catch { /* none yet */ }
      const names = entries.filter((ent) => ent.isFile() && DECK_SOUND_NAME_RE.test(ent.name)).map((ent) => ent.name);
      // Stat in parallel — a large library shouldn't pay the sum of its stats.
      const stats = await Promise.all(names.map((n) => fs.promises.stat(path.join(DECK_SOUNDS_DIR, n)).catch(() => null)));
      const sounds = [];
      for (let i = 0; i < names.length; i++) {
        if (stats[i]) sounds.push({ name: names[i], path: path.join(DECK_SOUNDS_DIR, names[i]), size: stats[i].size, mtime: stats[i].mtimeMs });
      }
      sounds.sort((a, b) => b.mtime - a.mtime);
      json({ ok: true, sounds });
    } catch (e) { err500(e.message); }

  } else if (reqPath.startsWith('/deck/sounds/') && req.method === 'DELETE') {
    // Remove one library clip. The name must match the server-generated shape
    // (no separators survive the regex) and is unlinked under a prefix assert.
    try {
      const name = decodeURIComponent(reqPath.slice('/deck/sounds/'.length));
      if (!DECK_SOUND_NAME_RE.test(name)) { res.writeHead(400); res.end(); return; }
      const abs = path.join(DECK_SOUNDS_DIR, name);
      if (!abs.startsWith(DECK_SOUNDS_DIR + path.sep)) { res.writeHead(400); res.end(); return; }
      await fs.promises.unlink(abs);
      json({ ok: true });
    } catch (e) {
      if (e.code === 'ENOENT') json({ ok: true });
      else err500(e.message);
    }

  } else if (reqPath === '/apps/store' && req.method === 'GET') {
    // Installed Store/UWP apps for the Deck "open Store app" picker. Get-StartApps
    // lists every Start-menu entry; we keep only UWP ones (an AppID carrying the
    // PackageFamilyName!AppId separator) so a key can launch e.g. the Store Spotify,
    // which lives in a protected WindowsApps folder and can't be opened by path.
    try {
      const out = await new Promise((resolve) => {
        execFile('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
            "Get-StartApps | Where-Object { $_.AppID -like '*!*' } | Select-Object Name,AppID | ConvertTo-Json -Compress"],
          { timeout: 9000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
          (e, stdout) => resolve(e ? '' : String(stdout || '')));
      });
      const apps = [];
      if (out.trim()) {
        const parsed = JSON.parse(out);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        const seen = new Set();
        for (const a of arr) {
          const value = (a && a.AppID) ? String(a.AppID) : '';
          if (!value || !value.includes('!') || seen.has(value.toLowerCase())) continue;
          seen.add(value.toLowerCase());
          apps.push({ value, label: (a && a.Name) ? String(a.Name) : value });
        }
        apps.sort((x, y) => x.label.localeCompare(y.label));
      }
      json({ ok: true, apps });
    } catch (e) { json({ ok: false, apps: [], error: e.message }); }

  } else if (reqPath === '/deck/app-icon' && req.method === 'GET') {
    // The app's OWN icon for a Deck launch key, so "open app" / "open Store app"
    // keys need no external image. `path` → an exe/lnk's embedded icon (via
    // resolveAppIcons); `aumid` → a Store/UWP app's tile logo (via
    // resolveStoreAppIcon). Read-only — it extracts an icon and mutates nothing —
    // so the loopback boundary is the only guard needed; the exe path is
    // quote-escaped into PowerShell and the AUMID is charset-checked before use.
    try {
      const aumid = (urlObj.searchParams.get('aumid') || '').trim();
      const appPath = (urlObj.searchParams.get('path') || '').trim();
      let icon = null;
      if (aumid) {
        if (/^[\w.-]+![\w.-]+$/.test(aumid)) icon = await resolveStoreAppIcon(aumid);
      } else if (appPath) {
        const icons = await resolveAppIcons([appPath]);
        icon = icons[0] || null;
      }
      json({ ok: !!icon, icon });
    } catch (e) { json({ ok: false, icon: null, error: e.message }); }

  } else if (reqPath === '/speaker/set' && req.method === 'POST') {
    try {
      const { id } = JSON.parse(await readBody(req));
      execFile(SVV, ['/SetDefault', id, 'all'], e => {
        if (e) err500(e.message); else { cachedSpeakerId = id; json({ ok: true }); }
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/mic/set' && req.method === 'POST') {
    try {
      const { id } = JSON.parse(await readBody(req));
      execFile(SVV, ['/SetDefault', id, 'all'], e => {
        if (e) { err500(e.message); return; }
        cachedMicId = id;
        if (isMuted) setMicMute(true);
        json({ ok: true });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/actions/run' && req.method === 'POST') {
    try {
      const action = JSON.parse(await readBody(req) || '{}');
      json(await deckRegistry.run(action));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/ai/pc-run' && req.method === 'POST') {
    // Execute a PREVIOUSLY-PROPOSED, user-approved PC command. The command text
    // is looked up by nonce server-side (never taken from the request body), and
    // the feature flag is re-checked here — so this endpoint can only run
    // something the AI proposed AND the user confirmed on the card, and only
    // while PC Control is enabled.
    try {
      const { nonce } = JSON.parse(await readBody(req) || '{}');
      if (!_pcControlEnabled()) { json({ ok: false, error: 'pc_control_disabled' }); return; }
      const entry = nonce && _pcActions.get(String(nonce));
      if (!entry) { json({ ok: false, error: 'expired' }); return; }
      _pcActions.delete(String(nonce)); // single-use
      if (Date.now() - entry.ts > PC_ACTION_TTL_MS) { json({ ok: false, error: 'expired' }); return; }
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', entry.command],
        { timeout: PC_ACTION_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
        (e, stdout, stderr) => {
          const clip = (s) => String(s || '').slice(0, 4000);
          if (e && e.killed) { json({ ok: false, error: 'timeout', stdout: clip(stdout), stderr: clip(stderr) }); return; }
          json({ ok: !e, code: (e && typeof e.code === 'number') ? e.code : 0, stdout: clip(stdout), stderr: clip(stderr), errorMessage: (e && typeof e.code !== 'number') ? e.message : undefined });
        });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/ai/pc-cancel' && req.method === 'POST') {
    // Drop a pending proposal when the user declines the confirmation card.
    try {
      const { nonce } = JSON.parse(await readBody(req) || '{}');
      if (nonce) _pcActions.delete(String(nonce));
      json({ ok: true });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/actions/perf' && req.method === 'POST') {
    // Performance Mode system actions (guided app close/relaunch). Allowlisted
    // and validated inside perfRegistry — never an arbitrary command.
    try {
      const action = JSON.parse(await readBody(req) || '{}');
      json(await perfRegistry.run(action));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/actions/catalog' && req.method === 'GET') {
    try {
      const { ACTION_CATALOG } = require('./js/deck-actions.js');
      const s = (await readHubSettings().catch(() => null)) || {};
      const rc = (s.remoteControl && typeof s.remoteControl === 'object') ? s.remoteControl : {};
      // "configured" = la presenza delle credenziali Sunshine (le scrive
      // configureSunshine al termine del setup). I flag *Installed non vengono
      // mai persistiti, quindi non sono un segnale affidabile.
      const remoteConfigured = !!(rc.sunshineUser && rc.sunshinePass);
      // Twitch actions are only useful when logged in — surface that so the editor
      // can hide them until the user connects (mirrors obs/remote gating).
      const tw = await streamTwitch.status().catch(() => ({ connected: false }));
      const yt = await streamYouTube.status().catch(() => ({ connected: false }));
      const dc = await discordRpc.status().catch(() => ({ connected: false }));
      const sp = await streamSpotify.status().catch(() => ({ connected: false }));
      const haCfg = (s.homeAssistant && typeof s.homeAssistant === 'object') ? s.homeAssistant : {};
      // Lighting actions surface only when the user actually has controllable
      // lighting — the iCUE bridge, an external provider with devices, or Chroma.
      const ls = lighting.getStatus();
      const lightingConfigured = !!(ls.available || (ls.devices && ls.devices.length) || (ls.providers && ls.providers.some((p) => (p.devices || []).length)));
      json({ catalog: ACTION_CATALOG, capabilities: { powershell: true, soundVolumeView: fs.existsSync(SVV), obsConfigured: !!s.obsHost || obsLocalWanted, streamerbotConfigured: !!s.streamerbotHost, remoteConfigured, twitchConnected: !!tw.connected, youtubeConnected: !!yt.connected, discordConnected: !!dc.connected, spotifyConnected: !!sp.connected, homeAssistantConfigured: !!(haCfg.url && haCfg.token), chromaEnabled: !!(s.chroma && s.chroma.enabled === true), wavelinkEnabled: !!(s.wavelink && s.wavelink.enabled === true), signalrgbEnabled: !!(s.signalrgb && s.signalrgb.enabled === true), lightingConfigured } });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/wavelink/state' && req.method === 'GET') {
    // Current Wave Link mixer snapshot (for a tile's first paint before SSE ticks).
    try { json(await buildWlState()); } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/wavelink/channels' && req.method === 'GET') {
    // Channel list for the Deck editor's mixer picker: [{ value: mixId, label }].
    try { json({ channels: await deckWaveLink.listChannels() }); } catch (e) { json({ channels: [] }); }

  } else if (reqPath === '/api/wavelink/test' && req.method === 'POST') {
    // Settings "Test connection": open the socket once and report reachability.
    try { json(await deckWaveLink.test()); } catch (e) { json({ ok: false, error: 'wl_failed' }); }

  } else if (reqPath === '/api/chroma/status' && req.method === 'GET') {
    // Chroma reachability + fixed device list (no live stream — state is static).
    json(deckChroma.getStatus());

  } else if (reqPath === '/api/chroma/test' && req.method === 'POST') {
    // Settings "Test connection": init a Chroma session then release it.
    try { json(await deckChroma.test()); } catch (e) { json({ ok: false, error: 'chroma_failed' }); }

  } else if (reqPath === '/api/signalrgb/status' && req.method === 'GET') {
    // SignalRGB card in Settings → Lighting: whether the launcher is installed on
    // this PC and whether the user has enabled the integration. Windows-only;
    // elsewhere `installed` is simply false and the card shows the "not found" hint.
    const s = _serverHubSettings || {};
    json({ ok: true, installed: signalrgb.isInstalled(), enabled: !!(s.signalrgb && s.signalrgb.enabled === true) });

  } else if (reqPath === '/api/signalrgb/config' && req.method === 'POST') {
    // Toggle the SignalRGB integration on/off (persisted like the chroma flag).
    try {
      const body = JSON.parse(await readBody(req, 4096) || '{}');
      const enabled = body.enabled === true;
      await withHubSettingsLock(async () => {
        _serverHubSettings = await writeHubSettings({ ..._serverHubSettings, signalrgb: { enabled } });
      });
      signalrgb.clearCache();   // a fresh enable should re-scan, not serve a stale/empty list
      json({ ok: true, installed: signalrgb.isInstalled(), enabled });
    } catch (e) { json({ ok: false, error: (e && e.message) || 'save_failed' }); }

  } else if (reqPath === '/api/signalrgb/effects' && req.method === 'GET') {
    // Effect list for the Deck picker. Empty unless the integration is enabled AND
    // installed; the scan is async + cached in signalrgb.js so repeated opens of
    // the Deck editor don't re-walk the disk.
    try {
      const s = _serverHubSettings || {};
      const enabled = !!(s.signalrgb && s.signalrgb.enabled === true);
      const effects = (enabled && signalrgb.isInstalled()) ? await signalrgb.scanEffects() : [];
      json({ ok: true, effects });
    } catch (e) {
      json({ ok: false, effects: [], error: String((e && e.message) || e) });
    }

  } else if (reqPath === '/embedded-browser/available' && req.method === 'GET') {
    // Lets the Browser widget render a friendly "Edge not found" state instead of
    // silently failing when Microsoft Edge isn't installed.
    json({ available: embeddedBrowser.available() });

  } else if (reqPath === '/embedded-browser/adblock' && req.method === 'GET') {
    // Ad-blocker status for Settings → Browser: whether the extension is installed,
    // whether the user has it enabled, and whether a download is in flight.
    json({
      available: embeddedBrowser.available(),
      installed: browserAdblock.isInstalled(DATA_DIR),
      enabled: !!(_serverHubSettings && _serverHubSettings.browserAdblock),
      busy: browserAdblock.isBusy(),
    });

  } else if (reqPath === '/embedded-browser/adblock/install' && req.method === 'POST') {
    // One-click install: download + unpack uBOL. The enable/disable flag is a
    // normal setting saved via POST /settings; this only fetches the extension.
    try {
      const r = await browserAdblock.install(DATA_DIR);
      json({ ok: !!(r && r.ok), installed: browserAdblock.isInstalled(DATA_DIR) });
    } catch (e) {
      json({ ok: false, installed: browserAdblock.isInstalled(DATA_DIR), error: String((e && e.message) || e) });
    }

  } else if (reqPath === '/obs/scenes' && req.method === 'GET') {
    try {
      const d = await deckObs.request('GetSceneList', {});
      // A successful probe means the OBS widget is present AND local OBS answered —
      // arm the live watch + preview even when the host field was left blank.
      if (!obsLocalWanted) { obsLocalWanted = true; refreshObsWatch(); }
      json({ ok: true, current: d.currentProgramSceneName || '', scenes: (d.scenes || []).map((s) => s.sceneName).filter(Boolean) });
    } catch (e) {
      json({ ok: false, scenes: [], error: String((e && e.message) || e) });
    }

  } else if (reqPath === '/obs/sources' && req.method === 'GET') {
    try {
      const d = await deckObs.request('GetInputList', {});
      const inputs = Array.isArray(d.inputs) ? d.inputs : [];
      // Prefer audio inputs (mic / desktop / app audio); if the kind filter matches
      // none, fall back to every input so the user can still pick one.
      const audio = inputs.filter((i) => /audio|wasapi|coreaudio|pulse|sndio|alsa/i.test(i.inputKind || ''));
      const sources = (audio.length ? audio : inputs).map((i) => i.inputName).filter(Boolean);
      json({ ok: true, sources });
    } catch (e) {
      json({ ok: false, sources: [], error: String((e && e.message) || e) });
    }

  } else if (reqPath === '/streamerbot/actions' && req.method === 'GET') {
    // Live list of Streamer.bot actions for the Deck editor + Settings card. The
    // editor stores each key's action by id (stable across renames); the name is
    // only the label. Returns {ok:false} (not an error) when streamer.bot is off.
    try {
      const d = await deckSb.request('GetActions', {});
      const actions = (Array.isArray(d.actions) ? d.actions : [])
        .map((a) => ({ id: String(a.id || ''), name: String(a.name || '') }))
        .filter((a) => a.id);
      json({ ok: true, actions });
    } catch (e) {
      json({ ok: false, actions: [], error: String((e && e.message) || e) });
    }

  } else if (reqPath === '/streamerbot/codetriggers' && req.method === 'GET') {
    // Live list of Streamer.bot CODE triggers for the Deck editor picker. Stored on
    // a key by trigger name (what ExecuteCodeTrigger takes). Response shape varies by
    // build, so accept `triggers` or `codeTriggers`. {ok:false} when streamer.bot is off.
    try {
      const d = await deckSb.request('GetCodeTriggers', {});
      const raw = Array.isArray(d.triggers) ? d.triggers : (Array.isArray(d.codeTriggers) ? d.codeTriggers : []);
      const triggers = raw
        .map((a) => ({ name: String((a && (a.name || a.triggerName)) || ''), group: String((a && (a.category || a.group)) || '') }))
        .filter((a) => a.name);
      json({ ok: true, triggers });
    } catch (e) {
      json({ ok: false, triggers: [], error: String((e && e.message) || e) });
    }

  } else if (reqPath === '/streamerbot/globals' && req.method === 'GET') {
    // Live list of Streamer.bot global-variable NAMES for the Deck editor's
    // "reflect a global" picker. A key stores the name; its on/off then follows the
    // live value pushed over the `streamerbot` SSE event. {ok:false} when off.
    try {
      const globals = await deckSb.listGlobals();
      json({ ok: true, globals });
    } catch (e) {
      json({ ok: false, globals: [], error: String((e && e.message) || e) });
    }

  } else if (reqPath === '/streamerbot/activity' && req.method === 'GET') {
    // Seed for the Streamer.bot widget: connection flag, live globals and the recent
    // activity buffer. New events then stream live over the `streamerbot_event` SSE
    // event; connection/globals over `streamerbot`. No Streamer.bot call here — it's
    // all in-memory — so it's cheap and safe when Streamer.bot is offline.
    try {
      const st = await buildSbState();
      json(Object.assign({ ok: true, recent: sbActivity }, st));
    } catch (e) {
      json({ ok: false, recent: [], configured: false, connected: false, globals: {}, error: String((e && e.message) || e) });
    }

  } else if (reqPath === '/notes/list' && req.method === 'GET') {
    // Structured multi-note store — used by the web dashboard notes widget.
    readNotes()
      .then(state => json(state))
      .catch(e => err500(e.message));

  } else if (reqPath === '/notes/list' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      // Stale-write guard (serialized in saveNotesGuarded): a save carries the
      // rev it was based on. A surface that missed newer saves would clobber
      // fresher content — refuse it and hand back the authoritative state (the
      // client rebases or adopts it). Absent baseRev (legacy/SDK callers)
      // keeps last-writer-wins as before. normalizeNotesState (inside
      // writeNotes) rebuilds from known keys and caps sizes, so a tampered
      // payload can't smuggle bad shapes or exhaust disk.
      json(await saveNotesGuarded(body));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/notes' && req.method === 'GET' && !urlObj.searchParams.has('save')) {
    // Legacy flat-text read (iCUE widget, JSONP). Flatten the structured store.
    readNotes()
      .then(state => json({ notes: notesToText(state) }))
      .catch(e => err500(e.message));

  } else if (reqPath === '/notes' && (req.method === 'POST' || (req.method === 'GET' && urlObj.searchParams.has('save')))) {
    try {
      let notes;
      if (req.method === 'GET') {
        notes = urlObj.searchParams.get('data') || '';
      } else {
        const body = JSON.parse(await readBody(req));
        notes = typeof body.notes === 'string' ? body.notes : (typeof body.text === 'string' ? body.text : '');
      }
      // Legacy flat-text save (iCUE widget). Replaces the store with a single note.
      const safe = String(notes).slice(0, NOTE_BODY_MAX);
      writeNotes(textToNotesState(safe))
        .then(() => json({ ok: true, savedAt: Date.now() }))
        .catch(e => err500(e.message));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/display/monitors' && req.method === 'GET') {
    // DDC/CI: enumerate monitors and the hardware controls each one exposes.
    // Fail-soft — an empty list (worker missing / no DDC monitors) just hides
    // the panel rather than erroring.
    // Generous timeout: the FIRST list pays the host's whole cold start —
    // PowerShell launch + Add-Type C# compile + enumerating every monitor and
    // reading each VCP over DDC/CI (inherently slow, ~9s with several panels).
    // The 8s default tripped here and, because a timeout retires (kills) the
    // host, every retry re-paid the cold start and never warmed up. Once warm,
    // set/reset keep the fast default.
    try {
      const env = await runDdcRequest({ action: 'list' }, 25000);
      json({ ok: true, monitors: Array.isArray(env.monitors) ? env.monitors : [] });
    } catch (e) { json({ ok: false, error: e.message, monitors: [] }); }

  } else if (reqPath === '/display/set' && req.method === 'POST') {
    // DDC/CI: set one hardware control on one monitor. POST-only (Origin-guarded
    // by isAllowedRequest); the feature name is checked against a fixed allowlist
    // so no arbitrary VCP code can be written, and the worker re-clamps to the
    // monitor's own max.
    try {
      const body = JSON.parse(await readBody(req));
      const key = String(body.key || '');
      const feature = String(body.feature || '');
      const value = Number(body.value);
      if (!key || !DDC_FEATURES.has(feature) || !Number.isFinite(value)) {
        json({ ok: false, error: 'bad_request' }); return;
      }
      const env = await runDdcRequest({ action: 'set', key, feature, value: Math.round(value) });
      json(env.ok ? { ok: true, feature: env.feature, value: env.value }
                  : { ok: false, error: env.err || 'set_failed' });
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/display/reset' && req.method === 'POST') {
    // DDC/CI: restore one monitor's factory defaults (the safety net). Returns the
    // monitor's re-read values so the sliders snap back to what the panel applied.
    try {
      const body = JSON.parse(await readBody(req));
      const key = String(body.key || '');
      if (!key) { json({ ok: false, error: 'bad_request' }); return; }
      const env = await runDdcRequest({ action: 'reset', key });
      json(env.ok ? { ok: true, features: env.features || null }
                  : { ok: false, error: env.err || 'reset_failed' });
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/version' && req.method === 'GET') {
    json({ version: APP_VERSION });

  } else if (reqPath === '/whatsnew' && req.method === 'GET') {
    // Curated highlights for the running version (see loadWhatsNew). Static and
    // shipped with the build; the client gates display on the `id`.
    try { json(await loadWhatsNew()); } catch (e) { err500(e.message); }

  } else if (reqPath === '/update/check' && req.method === 'GET') {
    // Latest released version vs the running one (probed at most daily,
    // fail-silent — offline simply reports no update). `?force=1` bypasses the
    // cache for the manual "check now" button.
    try {
      const u = await checkLatestRelease(urlObj.searchParams.get('force') === '1');
      json({
        current: APP_VERSION,
        latest: u.ok ? u.latest : '',
        url: u.ok ? u.url : '',
        notes: u.ok ? u.notes : '',
        name: u.ok ? u.name : '',
        publishedAt: u.ok ? u.publishedAt : '',
        mediaTypes: u.ok ? (u.mediaTypes || {}) : {},
        updateAvailable: !!(u.ok && semverNewer(u.latest, APP_VERSION)),
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/update/self-status' && req.method === 'GET') {
    // Whether one-click self-update is possible here (not a git checkout, applier
    // present), and whether a validated build is already staged and ready to apply.
    // `lastResult` is the machine-readable outcome update-apply.ps1 persists to
    // DATA_DIR/update-result.json (success or rollback + reason), so the dashboard
    // can explain a failed apply instead of spinning to a blind timeout. Read
    // fresh per request — the applier writes it while we are down.
    try {
      let lastResult = null;
      // Absent (old applier or no update yet) → null; readPwshJson also strips
      // the PS5 UTF-8 BOM older applier builds wrote.
      const m = await readPwshJson(path.join(DATA_DIR, 'update-result.json'));
      if (m && typeof m.ok === 'boolean') {
        lastResult = {
          ok: m.ok,
          reason: String(m.reason || ''),
          rolledBack: m.rolledBack !== false,
          rollbackVerified: m.rollbackVerified !== false,
          from: String(m.from || ''),
          to: String(m.to || ''),
          at: String(m.at || ''),
        };
      }
      json({ supported: selfUpdate.supported(), staged: selfUpdate.staged(), lastResult });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/update/prepare' && req.method === 'POST') {
    // Non-destructive: download + extract + validate the latest release into
    // DATA_DIR. The live install is never touched here.
    try {
      await readBody(req);
      if (!selfUpdate.supported()) { json({ ok: false, error: 'unsupported' }); return; }
      const u = await checkLatestRelease(true);
      if (!u.ok || !semverNewer(u.latest, APP_VERSION)) { json({ ok: false, error: 'no_update' }); return; }
      const r = await selfUpdate.prepare({ tag: u.tag, version: u.latest });
      json(r);
    } catch (e) { json({ ok: false, error: String(e && e.message || e) }); }

  } else if (reqPath === '/update/apply' && req.method === 'POST') {
    // Hand off to the external applier (elevated, detached). Only valid once a
    // build is staged; from here the swap happens outside this process.
    try {
      await readBody(req);
      json(selfUpdate.apply());
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/native/status' && req.method === 'GET') {
    // Which surface the user set up (native kiosk vs iCUE), so the dashboard can
    // offer to install the native app when running on iCUE/browser. Reads the
    // installer's marker in DATA_DIR (never HTTP-reachable); absent => 'unknown'.
    try {
      let mode = 'unknown';
      try {
        const raw = await fs.promises.readFile(path.join(DATA_DIR, 'install-mode.json'), 'utf8');
        const m = JSON.parse(raw);
        if (m && (m.mode === 'native' || m.mode === 'icue')) mode = m.mode;
      } catch { /* no marker yet -> unknown */ }
      // 'installed' must reflect the app actually on disk, NOT just the chosen-
      // surface marker: uninstalling the native app leaves the marker as 'native',
      // so keying the promo off the marker alone kept it hidden after an uninstall.
      // The kiosk installs per-user to %LOCALAPPDATA%\Xenon\xenon-native.exe.
      let installed = false;
      if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
        try {
          await fs.promises.access(path.join(process.env.LOCALAPPDATA, 'Xenon', 'xenon-native.exe'));
          installed = true;
        } catch { /* exe absent -> not installed */ }
      }
      json({ mode, installed });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/native/install' && req.method === 'POST') {
    // One-click install of the native kiosk app from the dashboard (offered to
    // iCUE/browser users). Hands off to install-native.ps1, which downloads the
    // latest signed installer from the GitHub release and launches it in the
    // interactive user session (needed when we run as the LocalSystem service).
    // Fire-and-forget + fail-soft: the helper does the heavy lifting on its own.
    // Do NOT pass detached:true here — Windows PowerShell (powershell.exe) fails to
    // initialize its host when started with DETACHED_PROCESS (no console), so the
    // script silently never runs (the install button looked like it hung). stdio:
    // 'ignore' + unref() already detach enough: the child outlives the request.
    try {
      await readBody(req);
      if (process.platform !== 'win32') { json({ ok: false, error: 'windows_only' }); return; }
      const script = path.join(__dirname, 'install-native.ps1');
      try { await fs.promises.access(script); } catch { json({ ok: false, error: 'helper_missing' }); return; }
      // Reset the progress marker so the dashboard's poll starts clean and never
      // reads a stale 'error'/'done' from a previous attempt. The PS script then
      // advances it: downloading -> installing -> done/error.
      try {
        await fs.promises.writeFile(
          path.join(DATA_DIR, 'native-install-status.json'),
          JSON.stringify({ state: 'starting', error: '', at: new Date().toISOString() })
        );
      } catch { /* non-fatal: the poll just falls back to a timeout */ }
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      ], { windowsHide: true, stdio: 'ignore' });
      child.unref();
      json({ ok: true });
    } catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }

  } else if (reqPath === '/api/native/install-status' && req.method === 'GET') {
    // Progress of an in-flight native-app install (install-native.ps1 writes the
    // marker at each stage). Lets the dashboard show downloading -> installing ->
    // done/error instead of a single optimistic "launched". Absent marker => idle.
    try {
      let st = { state: 'idle', error: '', at: '' };
      // readPwshJson strips the PS5 UTF-8 BOM; absent marker → idle.
      const m = await readPwshJson(path.join(DATA_DIR, 'native-install-status.json'));
      if (m && typeof m.state === 'string') {
        st = { state: m.state, error: String(m.error || ''), at: String(m.at || '') };
      }
      json(st);
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/backup/export' && req.method === 'GET') {
    // One portable JSON file with the user's configuration (no secrets, no
    // uploaded binaries). Served as a download.
    try {
      const bundle = await buildBackup();
      const name = 'xenon-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      // Compact on purpose: pretty-printing a bundle that can embed a multi-MB
      // background stringifies tens of extra MB synchronously on the event loop.
      res.end(JSON.stringify(bundle));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/backup/import' && req.method === 'POST') {
    try {
      const raw = await readBody(req, BACKUP_MAX_BYTES);
      json(await applyBackup(JSON.parse(raw || '{}')));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/backup/save' && req.method === 'POST') {
    // Embedded-view fallback: the iCUE WebView (and some kiosk browsers) have no
    // download manager, so a blob/anchor download silently does nothing there.
    // Since the server runs on the same PC, write the backup straight to the
    // user's Downloads folder and report the path back for a confirmation toast.
    try { json(await saveBackupToDisk()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/settings' && req.method === 'GET') {
    // Redact ALL server-only secrets (remote-control creds, Home Assistant token,
    // OBS/Streamer.bot passwords, provider API keys, lighting pairing tokens)
    // before sending to the browser.
    try { json({ settings: redactSettingsSecrets(await readHubSettings()) }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/settings' && req.method === 'POST') {
    try {
      const body    = JSON.parse(await readBody(req));
      // No .catch(() => null) here: readHubSettings already maps ENOENT (no file
      // yet) to null, so any OTHER read failure is a real error. Flattening it to
      // null would silently skip every preserve-on-save merge below (secrets,
      // widget-owned stores, the grid-units guard) and accept the save as if the
      // store were empty — wiping data. Fail the request instead (fail-closed).
      // Serialized against every other settings writer — see withHubSettingsLock.
      const { prev, settings } = await withHubSettingsLock(async () => {
      const prev    = await readHubSettings();
      // The browser settings model doesn't carry the server-only remote-control
      // creds, so carry them over from the persisted copy — a client save must
      // never wipe them (that's what left Sunshine stuck at "Not ready").
      let incoming = preserveSettingsSecrets(body.settings || body, prev);
      // Server-guaranteed monotonic rev: two surfaces saving from the same base
      // send the SAME client rev — the content is still last-writer-wins (the
      // documented residual), but the assigned rev must be strictly higher than
      // the stored one, so the broadcast below always exceeds every stale local
      // rev and the losing surface re-hydrates instead of silently diverging.
      const prevRev = (prev && Number(prev.rev)) || 0;
      if (!(Number(incoming.rev) > prevRev)) incoming.rev = prevRev + 1;
      // Grid-units guard: a dashboard left open across the v4 update (typically
      // the Xeneon Edge screen or an iCUE-mode page) still runs pre-24-column
      // client JS — its normalizer strips layout.gridCols and clamps every tile
      // back to 12 columns before saving. Accepting that save would re-run the
      // ×2 unit migration on already-migrated data, blowing every tile up to
      // full width/height ("all widgets full screen"). Once the stored layout
      // is in 24-column units, only a save that also speaks them may replace
      // it; a flag-less save keeps the stored layout and presets (preset
      // entries carry the same per-entry units flag and would double the same
      // way). The same stale client also authored its blob with a normalizer
      // that drops every settings section it never knew about — so prev-fill
      // the whole object: any top-level key the old client omitted keeps its
      // stored value instead of resetting to defaults (the widget-owned merges
      // below then refine on top of the filled copy). The save is still
      // accepted (not rejected) on purpose: that keeps the client's rev in step
      // with the server's, so its localStorage can never later win a hydrate
      // merge and re-push the mangled geometry. Genuine 12-column data still
      // migrates: the settings-file load and the backup-import path don't pass
      // through this guard.
      if (prev && prev.dashboardLayout
          && Number(prev.dashboardLayout.gridCols) === DASHBOARD_GRID_COLUMNS
          && Number(incoming.dashboardLayout && incoming.dashboardLayout.gridCols) !== DASHBOARD_GRID_COLUMNS) {
        console.warn('[settings] Save from a pre-24-column (stale) client: keeping stored layout/presets and prev-filling sections it omitted. That page needs a reload to edit the layout again.');
        incoming = { ...prev, ...incoming, dashboardLayout: prev.dashboardLayout, dashboardPresets: prev.dashboardPresets, customThemes: prev.customThemes, ambientScenes: prev.ambientScenes, contentInstalls: prev.contentInstalls };
      }
      // lighting.providers / deviceModes are bridge-owned (set only via
      // /api/lighting/*) and the client mirror never carries them — refill them
      // from the live bridge so a client save can't wipe external devices and
      // their pairing tokens from settings.json.
      incoming.lighting = {
        ...(incoming.lighting && typeof incoming.lighting === 'object' ? incoming.lighting : {}),
        providers: lighting.getExternalConfig(),
        deviceModes: lighting.getConfig().deviceModes,
      };
      // The stocks watchlist is widget-owned (edited only via POST
      // /api/stocks/watchlist); the browser settings mirror can carry a stale
      // copy, so a plain /settings save would wipe symbols the user just added
      // from the Borsa widget. Keep the persisted watchlist; the rest of the
      // stocks config (provider, keys, alertPercent, tile) stays client-editable.
      if (prev && prev.stocks && Array.isArray(prev.stocks.watchlist)) {
        incoming.stocks = {
          ...(incoming.stocks && typeof incoming.stocks === 'object' ? incoming.stocks : {}),
          watchlist: prev.stocks.watchlist,
        };
      }
      // Same for the football favorite teams — widget-owned (edited only via POST
      // /api/football/teams); keep the persisted list so a settings save can't
      // wipe teams the user just added from the Calcio widget.
      if (prev && prev.football && Array.isArray(prev.football.teams)) {
        incoming.football = {
          ...(incoming.football && typeof incoming.football === 'object' ? incoming.football : {}),
          teams: prev.football.teams,
        };
      }
      // The Claude usage plan/budget is widget-owned (edited only via POST
      // /api/claude/budget); the browser settings model doesn't carry it, so keep
      // the persisted config so a settings save can't reset it to the default.
      if (prev && prev.claude && typeof prev.claude === 'object') {
        incoming.claude = prev.claude;
      }
      // Same for the News followed feeds — widget-owned (edited only via POST
      // /api/news/feeds); keep the persisted list so a settings save can't wipe
      // feeds the user just added from the News widget.
      if (prev && prev.news && Array.isArray(prev.news.feeds)) {
        incoming.news = {
          ...(incoming.news && typeof incoming.news === 'object' ? incoming.news : {}),
          feeds: prev.news.feeds,
        };
      }
      // Lighting is bridge-owned: every change goes through /api/lighting/* (or
      // the AI tools), which persist via _persistLighting WITHOUT bumping the
      // browser mirrors. A surface's mirror therefore holds whatever lighting
      // blob it hydrated at boot, and echoing it here reverted toggles flipped
      // on the lighting page since (empirically: "Album → LED" kept turning
      // itself back on, painting the LEDs with the cover colour while the
      // checkbox showed off). Keep the persisted copy.
      if (prev && prev.lighting && typeof prev.lighting === 'object') {
        incoming.lighting = prev.lighting;
      }
      // Vitals state is widget-owned and monotonic: a refill stamps "now", XP
      // only grows, the daily counter resets on a new day. A stale settings
      // mirror from another surface must never rewind a refill the user just
      // tapped elsewhere — keep the newest per-vital timestamp, the highest XP,
      // and the most recent day's counter.
      if (prev && prev.vitals && prev.vitals.state && typeof prev.vitals.state === 'object') {
        const inV = incoming.vitals && typeof incoming.vitals === 'object' ? incoming.vitals : {};
        const inState = inV.state && typeof inV.state === 'object' ? inV.state : {};
        const inLast = inState.last && typeof inState.last === 'object' ? inState.last : {};
        const prevState = prev.vitals.state;
        const prevLast = prevState.last && typeof prevState.last === 'object' ? prevState.last : {};
        const last = { ...inLast };
        for (const id of Object.keys(prevLast)) {
          if ((Number(prevLast[id]) || 0) > (Number(last[id]) || 0)) last[id] = prevLast[id];
        }
        let day = typeof inState.day === 'string' ? inState.day : '';
        let fills = Number(inState.fills) || 0;
        let log = Array.isArray(inState.log) ? inState.log : [];
        const prevDay = typeof prevState.day === 'string' ? prevState.day : '';
        const prevLog = Array.isArray(prevState.log) ? prevState.log : [];
        if (prevDay > day) { day = prevDay; fills = Number(prevState.fills) || 0; log = prevLog; } // YYYY-MM-DD sorts lexicographically
        else if (prevDay === day) {
          fills = Math.max(fills, Number(prevState.fills) || 0);
          // Refills only append within a day — the longer ribbon is the newer one.
          if (prevLog.length > log.length) log = prevLog;
        }
        incoming.vitals = {
          ...inV,
          state: {
            ...inState,
            last,
            xp: Math.max(Number(prevState.xp) || 0, Number(inState.xp) || 0),
            day,
            fills,
            log,
            // Away-pause credit marker: freezeStart of the last credited away
            // period — forward-only, so a stale surface can't re-credit a
            // period another surface already applied (vitals-pet-core.awayCredit).
            awayCreditAt: Math.max(Number(prevState.awayCreditAt) || 0, Number(inState.awayCreditAt) || 0),
            // Bit's durable bookkeeping + long-term memory: merged (never
            // last-writer-wins) so a truce/escalation flag set on one surface
            // holds on the other and lifetime counters only grow. Pure helpers
            // in vitals-pet-core.js, unit-tested; output re-clamped by
            // normalizeVitals on write.
            pet: vitalsPetCore.mergePetBookkeeping(prevState.pet, inState.pet),
            mem: vitalsPetCore.mergeVitalsMem(prevState.mem, inState.mem),
          },
        };
      }
      // Weather is edited only through the dedicated POST /api/weather/config
      // (which bumps rev + broadcasts so peer surfaces refetch the new location,
      // GitHub #72). Keep the persisted copy on the generic settings save so a
      // background whole-blob push — a Vitals/Bit heartbeat, or the unload beacon —
      // from a surface that still holds the OLD location can't clobber it via
      // last-writer-wins (the "XENON stays on the wrong weather location" bug,
      // GitHub #109). The backup-import path sets weather deliberately and does not
      // pass through this guard.
      if (prev && prev.weather && typeof prev.weather === 'object') {
        incoming.weather = prev.weather;
      }
      const settings = await writeHubSettings(incoming);
      _serverHubSettings = settings;
      return { prev, settings };
      });
      // Ad-blocker toggle changed → tear the headless Edge down so the next tile
      // open relaunches it with (or without) --load-extension. Open tiles re-open
      // via BrowserTile.restart() on the client right after this save resolves.
      if (!!(prev && prev.browserAdblock) !== !!settings.browserAdblock) {
        try { embeddedBrowser.shutdown(); } catch (e) { /* next open self-heals */ }
      }
      // The save itself succeeded; a lighting apply failure must not fail the
      // request, but it must be visible (log + flag) instead of a silent no-op.
      let lightingApplied = true;
      try { lighting.applyConfig(settings.lighting); }
      catch (e) { lightingApplied = false; console.error('Lighting apply failed:', e.message); }
      refreshExternalFeeds().catch(() => {}); // pick up feed add/remove immediately
      refreshObsWatch();                       // start/stop the live OBS watch if its config changed
      refreshHaWatch();                        // start/stop the live Home Assistant watch if its config changed
      refreshSbWatch();                        // start/stop the live Streamer.bot globals watch if its config changed
      refreshWlWatch();                        // start/stop the live Wave Link mixer watch if its config changed
      // UniFi Protect caches a login session — drop it so a changed
      // host/username/password takes effect on the next snapshot pull instead of
      // silently reusing the stale console (login re-runs lazily). Do this BEFORE
      // refreshing the events watch so it reconnects against the fresh session.
      try { deckUnifi.close(); } catch (e) { /* ignore */ }
      refreshUnifiEventsWatch();               // start/stop/reconnect the camera notifications socket
      // Chroma disabled → drop any held session so Synapse resumes immediately.
      if (!(settings.chroma && settings.chroma.enabled === true)) { try { deckChroma.release().catch(() => {}); } catch (e) { /* ignore */ } }
      // Discord notifications toggled — either its own switch OR the master
      // (Settings → Notifiche) — → restart the watch so the NOTIFICATION_CREATE
      // subscription (and its scope check) matches the new setting immediately.
      const masterPrev = !(prev && prev.notifications && prev.notifications.enabled === false);
      const masterNext = !(settings.notifications && settings.notifications.enabled === false);
      const dnPrev = masterPrev && !!(prev && prev.discordNotifications && prev.discordNotifications.enabled);
      const dnNext = masterNext && !!(settings.discordNotifications && settings.discordNotifications.enabled);
      if (dnPrev !== dnNext) {
        if (!dnNext) discordNotifs = [];       // feature off → drop the stored feed
        if (discordStopWatch) { discordStopWatch(); discordStopWatch = null; }
        refreshDiscordWatch();
      }
      // Windows notifications: start/stop the mirror child on toggle change
      // (sync() is idempotent) and re-filter the stored feed in case the
      // per-app mute list changed.
      refreshWinNotifWatch();
      winNotif.applyExclusions();
      // Wake word toggled → start/stop the mic listener (sync() is idempotent).
      refreshWakeWordWatch();
      refreshStocks().catch(() => {}); // pick up watchlist/provider/key changes immediately
      refreshFootball().catch(() => {}); // pick up team/refresh/key changes immediately
      refreshNews().catch(() => {});      // pick up feed/refresh/key changes immediately
      // Pick up plan/budget changes and a just-enabled News widget/ticker source
      // immediately (their timers are gated on the widget being in use).
      if (_feedWidgetInUse('claude')) refreshClaude().catch(() => {});
      if (_feedWidgetInUse('news', 'news') && Date.now() - _newsCache.refreshedAt > 60 * 1000) refreshNews().catch(() => {});
      // Tell every OTHER open surface (Xeneon Edge screen / browser / native app)
      // that the settings changed, so they re-hydrate live instead of clobbering
      // this save with their own stale copy on their next edit. Clients ignore
      // the event when the rev isn't newer than their local one (their own save).
      broadcastSSE('settings', { rev: settings.rev });
      // Slim ack on purpose — no settings echo. The client already holds the
      // exact blob it just posted (same normalizers both sides), nobody ever
      // read the echoed copy, and with imported themes the echo reached
      // multi-MB: a client that discarded it unread left the response stream
      // permanently backpressured, burning one pooled connection per save
      // until the page's 6-per-host pool starved and the dashboard went deaf
      // (the "app disconnected after importing a heavy theme" wedge).
      json({ ok: true, rev: settings.rev, savedAt: Date.now(), lightingApplied });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/community/catalog' && req.method === 'GET') {
    // Community gallery catalog — proxied from the project site with a TTL
    // cache + ETag revalidation (see server/community-catalog.js). Read-only
    // GET: not a CSRF_MUTATION_PATHS candidate, NEVER a JSONP candidate.
    try {
      const out = await communityCatalog.fetchVisibleCatalog(urlObj.searchParams.has('refresh'));
      // Annotate version gating server-side with the same semver helpers the
      // update checker uses, so the client never grows its own comparator.
      if (out && Array.isArray(out.entries)) {
        out.entries = out.entries.map(e => (e && e.appVersionMin)
          ? { ...e, needsNewerApp: semverNewer(e.appVersionMin, APP_VERSION) } : e);
      }
      json(out);
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/community/code' && req.method === 'GET') {
    // One entry's share code (codes/<id>.txt on the site). The id is validated
    // against a strict charset before it ever reaches the URL. The code itself
    // stays untrusted — the client feeds it to the normal import pipeline.
    try {
      const out = await communityCatalog.fetchCode(urlObj.searchParams.get('id'));
      json(out);
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/community/redeem' && req.method === 'POST') {
    // Supporter-code redemption for v2 remote-locked drops. This server only
    // validates shape, attaches the persisted install id and forwards to the
    // author-owned hub (see server/supporter-redeem.js) — the one-time /
    // 3-device policy is enforced hub-side. In CSRF_MUTATION_PATHS.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await supporterRedeem.redeem({
        entryId: body.entryId, code: body.code, dataDir: DATA_DIR,
      }));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/community/limited-status' && req.method === 'GET') {
    // Live stock for automatic limited drops. The local proxy pins the Hub
    // origin and validates every id; the browser never receives a configurable
    // backend URL from catalog data.
    try {
      json(await communityLimited.fetchStatus(urlObj.searchParams.get('ids')));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/community/ratings' && req.method === 'GET') {
    // Star-rating aggregates for gallery entries, proxied from the hub with a
    // TTL cache + in-flight dedup (community-ratings.js). ?mine=1 additionally
    // attaches THIS install's id server-side so the vote control can highlight
    // the current choice — the browser never supplies the id. In
    // CSRF_MUTATION_PATHS (a cache miss triggers an outbound fetch).
    try {
      json(await communityRatings.fetchRatings({
        ids: urlObj.searchParams.get('ids'),
        mine: urlObj.searchParams.has('mine'),
        dataDir: DATA_DIR,
      }));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/community/rate' && req.method === 'POST') {
    // Cast/replace this install's 1–5 star vote on a catalog entry. Shape is
    // validated here, the install id attached server-side, and the hub
    // re-validates + rate-limits. In CSRF_MUTATION_PATHS (drive-by pages must
    // not pump the hub or forge votes), never JSONP.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await communityRatings.submitRating({
        entryId: body.entryId, stars: body.stars, dataDir: DATA_DIR,
      }));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/stocks' && req.method === 'GET') {
    // Current quotes for the watchlist (+ the config the widget needs to render).
    try {
      if (urlObj.searchParams.has('refresh')) await refreshStocks();
      const cfg = _stocksSettings();
      json({ quotes: _stocksCache.quotes, provider: _stocksCache.provider, refreshedAt: _stocksCache.refreshedAt, watchlist: cfg.watchlist, tile: cfg.tile, alertPercent: cfg.alertPercent });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/stocks/chart' && req.method === 'GET') {
    // Chart candles for the detail view (on-demand, short-cached so range
    // toggles don't re-hit the provider every tap).
    try {
      const symbol = urlObj.searchParams.get('symbol') || '';
      const range = urlObj.searchParams.get('range') || '1d';
      const key = `${symbol}|${range}`;
      const now = Date.now();
      const hit = _stocksChartCache.get(key);
      if (hit && now - hit.at < 30000) { json(hit.data); }
      else {
        const data = await stocks.fetchChart(symbol, range, _stocksProviderOpts());
        if (!data) { res.writeHead(404); res.end('unknown symbol'); return; }
        if (_stocksChartCache.size > 40) _stocksChartCache.delete(_stocksChartCache.keys().next().value);
        _stocksChartCache.set(key, { at: now, data });
        json(data);
      }
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/stocks/search' && req.method === 'GET') {
    // Resolve free text ("apple", "ftse mib") to real tickers so the widget's
    // add box is a search, not a "know the exact symbol" field. Keyless (Yahoo),
    // briefly cached so typing doesn't hammer the endpoint on every keystroke.
    try {
      const q = (urlObj.searchParams.get('q') || '').trim();
      if (!q) { json({ results: [] }); return; }
      const key = q.toLowerCase();
      const now = Date.now();
      const hit = _stocksSearchCache.get(key);
      if (hit && now - hit.at < 60000) { json({ results: hit.results }); return; }
      const results = await stocks.searchSymbols(q);
      if (_stocksSearchCache.size > 40) _stocksSearchCache.delete(_stocksSearchCache.keys().next().value);
      _stocksSearchCache.set(key, { at: now, results });
      json({ results });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/stocks/watchlist' && req.method === 'POST') {
    // Add / remove a favorite symbol (or replace the whole list). Persisted in
    // settings.stocks.watchlist via the atomic writer, then a refresh is kicked.
    try {
      await withHubSettingsLock(async () => {          // serialized with every other settings writer
      const body = JSON.parse(await readBody(req));
      const cur = (await readHubSettings().catch(() => null)) || { ...DEFAULT_HUB_SETTINGS };
      let wl = Array.isArray(cur.stocks && cur.stocks.watchlist) ? cur.stocks.watchlist.slice() : [];
      const action = String(body.action || '').toLowerCase();
      if (action === 'set' && Array.isArray(body.watchlist)) {
        wl = body.watchlist;
      } else if (action === 'remove') {
        const sym = stocks.cleanSymbol(body.symbol);
        wl = wl.filter(w => w.symbol !== sym);
      } else { // add (default)
        const sym = stocks.cleanSymbol(body.symbol);
        if (!sym) { res.writeHead(400); res.end('bad symbol'); return; }
        if (!wl.some(w => w.symbol === sym)) wl.push({ symbol: sym, name: String(body.name || '').slice(0, 60) });
      }
      const next = { ...cur, stocks: { ...cur.stocks, watchlist: wl } };
      const saved = await writeHubSettings(next);
      _serverHubSettings = saved;
      refreshStocks().catch(() => {});
      json({ ok: true, watchlist: saved.stocks.watchlist });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/weather/config' && req.method === 'POST') {
    // Weather location/config, edited from Settings on any surface. It is
    // deliberately NOT persisted through the whole-settings blob: that transport
    // is shared with high-frequency automatic saves (a Vitals/Bit heartbeat) and
    // the unload beacon, either of which — coming from a surface that still holds
    // the OLD location — would clobber a change just made elsewhere via
    // last-writer-wins (the "XENON stays on the wrong weather location" bug,
    // GitHub #109). Persisted like the stocks watchlist: a dedicated writer the
    // generic POST /settings then preserves (keep-prev). Unlike the watchlist it
    // also bumps the settings rev and broadcasts, because a peer surface only
    // refetches the new location once its settings hydrate updates its own
    // hubSettings.weather (GitHub #72). writeHubSettings normalizes the whole
    // object, so the incoming weather block is validated server-side here.
    try {
      await withHubSettingsLock(async () => {          // serialized with every other settings writer
      const body = JSON.parse(await readBody(req));
      const cur = (await readHubSettings().catch(() => null)) || { ...DEFAULT_HUB_SETTINGS };
      const nextWeather = (body && body.weather && typeof body.weather === 'object') ? body.weather : {};
      const prevRev = Number(cur.rev) || 0;
      const saved = await writeHubSettings({ ...cur, weather: { ...(cur.weather || {}), ...nextWeather }, rev: prevRev + 1 });
      _serverHubSettings = saved;
      broadcastSSE('settings', { rev: saved.rev });   // peers re-hydrate → refetch the new location
      json({ ok: true, weather: saved.weather, rev: saved.rev });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/claude' && req.method === 'GET') {
    // Local Claude Code usage aggregate + the budget config the reactor renders.
    // No key, no network — reads ~/.claude transcripts. Ensures the cache is warm
    // (the widget can be opened before any SSE-gated refresh has run).
    try {
      if (urlObj.searchParams.has('refresh') || !_claudeCache.data) await refreshClaude();
      // Widget just (re)added after a gated-idle stretch: serve the cache now,
      // catch up in background; the SSE push repaints when it lands.
      else if (Date.now() - _claudeCache.refreshedAt > 5 * 60 * 1000) refreshClaude().catch(() => {});
      json(_claudeCache.data || _claudePayload(null));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/claude/budget' && req.method === 'POST') {
    // Widget-owned: set the plan / weekly token budget the reactor gauges against
    // (there is no official quota API, so the user picks the ceiling). Persisted in
    // settings.claude via the atomic writer, then a refresh repaints the reactor.
    try {
      await withHubSettingsLock(async () => {          // serialized with every other settings writer
      const body = JSON.parse(await readBody(req));
      const cur = (await readHubSettings().catch(() => null)) || { ...DEFAULT_HUB_SETTINGS };
      const patch = { ...(cur.claude && typeof cur.claude === 'object' ? cur.claude : {}) };
      if (body.plan !== undefined) patch.plan = body.plan;
      if (body.weeklyTokenBudget !== undefined) patch.weeklyTokenBudget = body.weeklyTokenBudget;
      const merged = claudeUsage.normalizeClaude(patch);
      const saved = await writeHubSettings({ ...cur, claude: merged });
      _serverHubSettings = saved;
      refreshClaude().catch(() => {});
      json({ ok: true, budget: { weekly: claudeUsage.effectiveWeeklyBudget(saved.claude), plan: saved.claude.plan, weeklyTokenBudget: saved.claude.weeklyTokenBudget }, tile: saved.claude.tile });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/football' && req.method === 'GET') {
    // Current fixtures/results for the favorite teams (+ the config the widget needs).
    try {
      if (urlObj.searchParams.has('refresh')) await refreshFootball();
      const cfg = _footballSettings();
      json({ teams: _footballCache.teams, live: _footballCache.live, refreshedAt: _footballCache.refreshedAt, favorites: cfg.teams, tile: cfg.tile });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/football/standings' && req.method === 'GET') {
    // League table for the detail view (on-demand, short-cached). `season` is
    // supplied by the widget from the team's own fixtures.
    try {
      const leagueId = urlObj.searchParams.get('league') || '';
      const season = urlObj.searchParams.get('season') || '';
      const key = `${leagueId}|${season}`;
      const now = Date.now();
      const hit = _footballStandingsCache.get(key);
      if (hit && now - hit.at < 5 * 60 * 1000) { json(hit.data || {}); return; }
      const data = await football.fetchStandings(leagueId, season, _footballOpts());
      if (!data) { res.writeHead(404); res.end('no standings'); return; }
      if (_footballStandingsCache.size > 40) _footballStandingsCache.delete(_footballStandingsCache.keys().next().value);
      _footballStandingsCache.set(key, { at: now, data });
      json(data);
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/football/search' && req.method === 'GET') {
    // Resolve free text ("napoli") to real teams so the add box is a search.
    try {
      const q = (urlObj.searchParams.get('q') || '').trim();
      if (!q) { json({ results: [] }); return; }
      const key = q.toLowerCase();
      const now = Date.now();
      const hit = _footballSearchCache.get(key);
      if (hit && now - hit.at < 60000) { json({ results: hit.results }); return; }
      // Competitions (curated, instant) first, then clubs (live search).
      const leagues = football.searchLeagues(q);
      const teams = await football.searchTeams(q, _footballOpts());
      const results = [...leagues, ...teams].slice(0, 12);
      if (_footballSearchCache.size > 40) _footballSearchCache.delete(_footballSearchCache.keys().next().value);
      _footballSearchCache.set(key, { at: now, results });
      json({ results });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/football/teams' && req.method === 'POST') {
    // Add / remove a favorite team (or replace the whole list). Persisted in
    // settings.football.teams via the atomic writer, then a refresh is kicked.
    try {
      await withHubSettingsLock(async () => {          // serialized with every other settings writer
      const body = JSON.parse(await readBody(req));
      const cur = (await readHubSettings().catch(() => null)) || { ...DEFAULT_HUB_SETTINGS };
      let teams = Array.isArray(cur.football && cur.football.teams) ? cur.football.teams.slice() : [];
      const action = String(body.action || '').toLowerCase();
      if (action === 'set' && Array.isArray(body.teams)) {
        teams = football.normalizeTeams(body.teams);
      } else if (action === 'remove') {
        const id = football.cleanId(body.id);
        const isLeague = body.type === 'league';
        teams = teams.filter(tm => !(tm.id === id && (tm.type === 'league') === isLeague));
      } else { // add (default)
        const id = football.cleanId(body.id);
        if (!id) { res.writeHead(400); res.end('bad team id'); return; }
        const type = body.type === 'league' ? 'league' : 'team';
        if (!teams.some(tm => tm.id === id && (tm.type === 'league') === (type === 'league'))) {
          teams.push(football.normalizeTeams([{ id, type, name: body.name, badge: body.badge, league: body.league, leagueId: body.leagueId }])[0] || { id });
        }
      }
      const next = { ...cur, football: { ...cur.football, teams } };
      const saved = await writeHubSettings(next);
      _serverHubSettings = saved;
      refreshFootball().catch(() => {});
      json({ ok: true, teams: saved.football.teams });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/news' && req.method === 'GET') {
    // Current merged headlines (+ the config the widget needs to render).
    try {
      if (urlObj.searchParams.has('refresh')) await refreshNews();
      // A GET is proof someone wants the data (widget just added, ticker source
      // just enabled) — the gated timers may not have run yet, so if the cache
      // is cold, refresh in background; the SSE push repaints when it lands.
      else if (!_newsCache.refreshedAt || Date.now() - _newsCache.refreshedAt > 15 * 60 * 1000) refreshNews().catch(() => {});
      const cfg = _newsSettings();
      json({ items: _newsCache.items, refreshedAt: _newsCache.refreshedAt, feeds: cfg.feeds, tile: cfg.tile });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/news/search' && req.method === 'GET') {
    // Resolve free text to curated sources (the caller can also add it as a topic).
    try {
      const q = (urlObj.searchParams.get('q') || '').trim();
      if (!q) { json({ results: [] }); return; }
      const key = q.toLowerCase();
      const now = Date.now();
      const hit = _newsSearchCache.get(key);
      if (hit && now - hit.at < 60000) { json({ results: hit.results }); return; }
      const results = news.searchSources(q);
      if (_newsSearchCache.size > 40) _newsSearchCache.delete(_newsSearchCache.keys().next().value);
      _newsSearchCache.set(key, { at: now, results });
      json({ results });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/news/feeds' && req.method === 'POST') {
    // Add / remove a followed source or topic (or replace the whole list).
    // Persisted in settings.news.feeds via the atomic writer, then a refresh.
    try {
      await withHubSettingsLock(async () => {          // serialized with every other settings writer
      const body = JSON.parse(await readBody(req));
      const cur = (await readHubSettings().catch(() => null)) || { ...DEFAULT_HUB_SETTINGS };
      let feeds = Array.isArray(cur.news && cur.news.feeds) ? cur.news.feeds.slice() : [];
      const action = String(body.action || '').toLowerCase();
      if (action === 'set' && Array.isArray(body.feeds)) {
        feeds = news.normalizeFeeds(body.feeds);
      } else if (action === 'remove') {
        const type = body.type === 'topic' ? 'topic' : (body.type === 'custom' ? 'custom' : 'source');
        // topic ids are slugged (idempotent); source/custom ids arrive verbatim from the chip.
        const id = type === 'topic' ? news.topicId(body.id || body.query || body.name) : String(body.id || '');
        feeds = feeds.filter(f => !(f.id === id && f.type === type));
      } else { // add (default)
        const type = body.type === 'topic' ? 'topic' : (body.type === 'custom' ? 'custom' : 'source');
        const entry = type === 'topic'
          ? { type: 'topic', name: body.name || body.query, query: body.query || body.name }
          : type === 'custom'
            ? { type: 'custom', url: body.url, name: body.name }
            : { type: 'source', id: body.id };
        const merged = news.normalizeFeeds([...feeds, entry]);
        if (merged.length === feeds.length) { res.writeHead(400); res.end('bad or duplicate feed'); return; }
        feeds = merged;
      }
      const next = { ...cur, news: { ...cur.news, feeds } };
      const saved = await writeHubSettings(next);
      _serverHubSettings = saved;
      refreshNews().catch(() => {});
      json({ ok: true, feeds: saved.news.feeds });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/homeassistant/state' && req.method === 'GET') {
    // Compact snapshot of the user's selected entities + connection flag (the same
    // shape the SSE `homeassistant` event pushes). Used as a fallback/first paint.
    try { json(await buildHaState()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/ha/deck-watch' && req.method === 'POST') {
    // A SURFACE tells the server which HA entities its deck keys are bound to;
    // the shared watch then includes the UNION across surfaces in the coalesced
    // `ha_states` broadcasts (per-client sets — a popup showing a narrow folder
    // can't clobber the dashboard's list). POST-only JSON → covered by the
    // loopback Origin layer; client id + entity ids re-validated.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const client = String(body.client || '').trim();
      if (!/^[a-z0-9]{4,24}$/.test(client)) { json({ ok: false, error: 'bad_client' }); return; }
      const raw = Array.isArray(body.entities) ? body.entities : [];
      const ids = [];
      for (const item of raw) {
        const id = String(item == null ? '' : item).trim().toLowerCase();
        if (HA_ENTITY_ID_RE.test(id) && !ids.includes(id)) ids.push(id);
        if (ids.length >= HA_DECK_WATCH_MAX) break;
      }
      if (!ids.length) {
        _haDeckWatchClients.delete(client);
      } else {
        // Bounded: a burst of new client ids evicts the stalest entry first.
        if (!_haDeckWatchClients.has(client) && _haDeckWatchClients.size >= HA_DECK_WATCH_CLIENTS_MAX) {
          let oldest = null;
          for (const [k, v] of _haDeckWatchClients) { if (!oldest || v.at < oldest.at) oldest = { k, at: v.at }; }
          if (oldest) _haDeckWatchClients.delete(oldest.k);
        }
        _haDeckWatchClients.set(client, { ids, at: Date.now() });
      }
      // Seed immediately so freshly-bound keys paint without waiting for the
      // next state_changed. FORCED past the change guard: the posting client
      // needs the snapshot even when it matches the last broadcast.
      try { broadcastHaDeckStates(true); } catch (e) { /* ignore */ }
      json({ ok: true, watching: haDeckWatchUnion().length });
    } catch (e) { json({ ok: false, error: (e && e.message) || 'bad_request' }); }

  } else if (reqPath === '/api/homeassistant/entities' && req.method === 'GET') {
    // Full compact entity list for the Settings device picker. Opens a live
    // connection on demand (idle-closes afterwards). Never leaks the token.
    try {
      const s = (await readHubSettings().catch(() => null)) || {};
      const ha = (s && s.homeAssistant) || {};
      if (!(ha.url && ha.token)) { json({ ok: false, error: 'not_configured' }); return; }
      const entities = await deckHa.listEntities();
      json({ ok: true, entities });
    } catch (e) { json({ ok: false, error: (e && e.message) || 'ha_failed' }); }

  } else if (reqPath === '/api/homeassistant/test' && req.method === 'POST') {
    // Settings "Connect" button: verify the URL + token by opening one connection.
    // Reads the just-typed url/token from the body so it works before a full save.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const prev = (await readHubSettings().catch(() => null)) || {};
      const prevHa = (prev && prev.homeAssistant) || {};
      const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : prevHa.url;
      // Empty/omitted token in the body → fall back to the saved one (write-only field).
      const token = typeof body.token === 'string' && body.token ? body.token : prevHa.token;
      const probe = createHomeAssistant(async () => ({ baseUrl: url, token }));
      const r = await probe.test();
      // On success, return the entity list from the SAME already-seeded probe, so
      // the Settings picker can populate immediately — the persisted settings save
      // is debounced, so a follow-up GET /entities could still read the old config.
      let entities = [];
      if (r && r.ok) {
        entities = await probe.listEntities().catch(() => []);
        // Persist url+token straight away so a green "Connected" ALWAYS means the
        // token reached settings.json. The client's own save is debounced +
        // fire-and-forget and can be lost to a hydrate/reconnect race (the redacted
        // server copy overwriting the just-typed token before it lands), which
        // strands the tile on "Connect Home Assistant" (configured=false) even
        // though the test passed. Writing here closes that window; the client mirror
        // save still runs and is reconciled by preserveHaToken. Read fail-closed: a
        // real read error must NOT lead to writing a defaults-only object over the
        // user's config (readHubSettings maps ENOENT → null on a fresh install).
        try {
          await withHubSettingsLock(async () => {       // serialized with every other settings writer
            const base = await readHubSettings();
            const cur = (base && typeof base === 'object') ? base : {};
            const curHa = (cur.homeAssistant && typeof cur.homeAssistant === 'object') ? cur.homeAssistant : {};
            const next = { ...cur, homeAssistant: { ...curHa, url, token }, rev: (Number(cur.rev) || 0) + 1 };
            const saved = await writeHubSettings(next);
            _serverHubSettings = saved;
            refreshHaWatch();                              // open the live socket now that we're configured
            broadcastSSE('settings', { rev: saved.rev });  // other open surfaces adopt the saved token
          });
        } catch (e) { /* non-fatal: the client's debounced save remains the fallback */ }
      }
      try { probe.close(); } catch (e) { /* ignore */ }
      json(Object.assign({ entities }, r));
    } catch (e) { json({ ok: false, error: (e && e.message) || 'ha_failed' }); }

  } else if (reqPath === '/api/homeassistant/service' && req.method === 'POST') {
    // Call a Home Assistant service (tile controls). POST-only, so the loopback
    // Origin/Sec-Fetch checks in isAllowedRequest guard it from cross-site drive-by.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const target = body.entityId ? { entity_id: String(body.entityId) } : null;
      const data = (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) ? body.data : {};
      json(await deckHa.callService(String(body.domain || ''), String(body.service || ''), target, data));
    } catch (e) { json({ ok: false, error: (e && e.message) || 'ha_failed' }); }

  } else if (reqPath === '/api/unifiprotect/state' && req.method === 'GET') {
    // First paint + periodic status poll for the Cameras tile: whether UniFi
    // Protect is configured and the compact camera list (id/name/connected). Opens
    // a login on demand (short-cached), never leaks the password.
    try {
      const s = (await readHubSettings().catch(() => null)) || {};
      const u = (s && s.unifi) || {};
      const configured = !!(u.host && u.username && u.password);
      if (!configured) { json({ configured: false, cameras: [] }); return; }
      try { json({ configured: true, cameras: await deckUnifi.cameras() }); }
      catch (e) { json({ configured: true, cameras: [], error: (e && e.message) || 'unifi_failed' }); }
    } catch (e) { err500(e.message); }

  } else if (reqPath.startsWith('/api/unifiprotect/snapshot/') && req.method === 'GET') {
    // Loopback JPEG proxy: fetch one camera's snapshot from the console (password
    // stays server-side) and stream it back. The id is strictly validated before
    // it reaches the console path. no-store so each ?ts= pull is a fresh frame.
    // decodeURIComponent must stay INSIDE the try: a malformed escape (e.g. a bare
    // "%") throws URIError, and an unhandled throw out of this async handler would
    // crash the process (Node's default unhandledRejection = throw). The other
    // decode routes (/api/timers, /uploads) guard their decode the same way.
    try {
      const id = decodeURIComponent(reqPath.slice('/api/unifiprotect/snapshot/'.length));
      if (!/^[A-Za-z0-9]{4,64}$/.test(id)) { res.writeHead(400); res.end('bad camera id'); return; }
      const s = (await readHubSettings().catch(() => null)) || {};
      const u = (s && s.unifi) || {};
      if (!(u.host && u.username && u.password)) { res.writeHead(404); res.end(); return; }
      const jpeg = await deckUnifi.snapshot(id);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': jpeg.length });
      res.end(jpeg);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('snapshot failed');
    }

  } else if (reqPath === '/api/ha/cameras' && req.method === 'GET') {
    // First paint + periodic status poll for the Cameras tile's Home Assistant
    // source: whether HA is configured and the compact camera list. Opens a live
    // WS on demand (idle-closes afterwards), never leaks the token. Mirrors the
    // /api/unifiprotect/state shape so the tile can merge both sources uniformly.
    try {
      const s = (await readHubSettings().catch(() => null)) || {};
      const ha = (s && s.homeAssistant) || {};
      const configured = !!(ha.url && ha.token);
      if (!configured) { json({ configured: false, cameras: [] }); return; }
      try { json({ configured: true, cameras: await deckHa.cameras() }); }
      catch (e) { json({ configured: true, cameras: [], error: (e && e.message) || 'ha_failed' }); }
    } catch (e) { err500(e.message); }

  } else if (reqPath.startsWith('/api/ha/camera/snapshot/') && req.method === 'GET') {
    // Loopback JPEG proxy for a Home Assistant camera: fetch the current frame from
    // HA's camera_proxy (token stays server-side) and stream it back. The entity id
    // is strictly validated before it reaches the HA path. decodeURIComponent stays
    // INSIDE the try — a malformed "%" escape throws URIError, and an unhandled
    // throw from this async handler would crash the process (mirrors the UniFi
    // snapshot proxy above). no-store so each ?ts= pull is a fresh frame.
    try {
      const entity = decodeURIComponent(reqPath.slice('/api/ha/camera/snapshot/'.length));
      if (!/^camera\.[a-z0-9_]+$/.test(entity)) { res.writeHead(400); res.end('bad camera id'); return; }
      // No settings pre-read here: cameraSnapshot reads the config itself and
      // throws ha_not_configured — a second full readHubSettings on this per-frame
      // hot path (default 1.5s per camera) would double the parse+normalize cost.
      const jpeg = await deckHa.cameraSnapshot(entity);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': jpeg.length });
      res.end(jpeg);
    } catch (e) {
      if (e && e.message === 'ha_not_configured') { res.writeHead(404); res.end(); return; }
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('snapshot failed');
    }

  } else if (reqPath === '/api/unifiprotect/test' && req.method === 'POST') {
    // Settings "Connect" button: verify host + credentials by logging in once and
    // listing cameras. Reads the just-typed values from the body so it works before
    // a full save; an empty/omitted password falls back to the saved one.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const prev = (await readHubSettings().catch(() => null)) || {};
      const prevU = (prev && prev.unifi) || {};
      const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : prevU.host;
      const username = typeof body.username === 'string' && body.username.trim() ? body.username.trim() : prevU.username;
      const password = typeof body.password === 'string' && body.password ? body.password : prevU.password;
      const probe = createUnifiProtect(async () => ({ host, username, password }));
      const r = await probe.test();
      try { probe.destroy(); } catch (e) { /* ignore */ }   // free its keep-alive sockets to the console
      json(r);
    } catch (e) { json({ ok: false, error: (e && e.message) || 'unifi_failed' }); }

  } else if (reqPath === '/startup/auto-open' && req.method === 'GET') {
    // Reports whether opening the dashboard in the browser at logon is supported
    // (Windows only) and whether the logon task currently exists.
    try {
      const state = await getBrowserAutoOpenState();
      json({ ok: true, supported: AUTO_OPEN_SUPPORTED, enabled: state.enabled });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/startup/auto-open' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const state = await setBrowserAutoOpen(body && body.enabled === true);
      json({ ok: true, supported: AUTO_OPEN_SUPPORTED, enabled: state.enabled });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/deck-config' && req.method === 'GET') {
    try {
      const store = await readDeckStore();
      json({ configs: store.configs, rev: store.rev, savedAt: store.savedAt, instanceRevs: store.instanceRevs, presets: store.presets, keyPresets: store.keyPresets });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/deck-config' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      if (raw.length > DECK_MAX_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Deck config too large' }));
        return;
      }
      const body = JSON.parse(raw);
      const current = await readDeckStore();

      // Current protocol: the client sends only the changes it actually made, as
      // precise ops ({ ops: [...] }). The server owns the store and assigns every
      // revision, so two clients' uncoordinated local counters can never fight —
      // a stale open dashboard simply has no ops to send and can't overwrite or
      // delete decks it never touched (the "edit reverted / second deck wiped
      // after a reboot" loss).
      if (Array.isArray(body.ops)) {
        const applied = deckStore.applyDeckOps(current, body.ops);
        if (!applied.changed) {
          json({ ok: true, rev: current.rev, savedAt: current.savedAt });
          return;
        }
        applied.store.rev = current.rev + 1;
        const saved = await writeDeckStore(applied.store);
        // Nudge every other open dashboard to re-sync its decks right away.
        broadcastSSE('deck', { rev: saved.rev });
        json({ ok: true, rev: saved.rev, savedAt: saved.savedAt });
        return;
      }

      // LEGACY whole-blob push (a client still running the previous deck.js, or an
      // old queued beacon). Made strictly ADDITIVE: it can RESTORE an instance the
      // server is missing entirely, but it never overwrites one the server already
      // has. The server is authoritative — its decks got there via precise ops from
      // up-to-date clients — so a stale dashboard can no longer revert a key edit by
      // racing its beacon after a reboot (the reported "my button reverted" loss).
      const incoming = normalizeDeckStore(body);
      const applied = deckStore.applyLegacyBlob(current, incoming);
      if (!applied.changed) {
        json({ ok: true, rev: current.rev, savedAt: current.savedAt });
        return;
      }
      applied.store.rev = current.rev + 1;   // revs are server-assigned — never adopt a client counter
      const saved = await writeDeckStore(applied.store);
      broadcastSSE('deck', { rev: saved.rev });
      json({ ok: true, rev: saved.rev, savedAt: saved.savedAt });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/events' && req.method === 'GET' && !urlObj.searchParams.has('save')) {
    try { json({ events: await readEvents() }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/events' && (req.method === 'POST' || (req.method === 'GET' && urlObj.searchParams.has('save')))) {
    try {
      let body;
      if (req.method === 'GET') {
        body = JSON.parse(urlObj.searchParams.get('data') || '[]');
      } else {
        body = JSON.parse(await readBody(req));
      }
      const events = await writeEvents(body.events || body);
      json({ ok: true, events, savedAt: Date.now() });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/external-events' && req.method === 'GET') {
    try {
      // The periodic refresh is gated on connected clients, so after boot or an
      // idle stretch the cache can be cold: never-filled → fetch now (there is
      // nothing to serve anyway); merely stale → serve it, refresh in background.
      if (urlObj.searchParams.has('refresh') || _externalFeedCache.refreshedAt === 0) await refreshExternalFeeds();
      else if (Date.now() - _externalFeedCache.refreshedAt > EXTERNAL_FEEDS_INTERVAL_MS) {
        refreshExternalFeeds().catch(() => {});
      }
      json({ feeds: _externalFeedCache.feeds, events: _externalFeedCache.events, refreshedAt: _externalFeedCache.refreshedAt });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/external-events/refresh' && req.method === 'POST') {
    try { await refreshExternalFeeds(); json({ ok: true, feeds: _externalFeedCache.feeds, refreshedAt: _externalFeedCache.refreshedAt }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/tasks' && req.method === 'GET') {
    try { json({ tasks: await readTasks() }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/tasks' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const tasks = await writeTasks(body.tasks || body);
      json({ ok: true, tasks, savedAt: Date.now() });
    } catch (e) { err500(e.message); }

  // ── Timers API ────────────────────────────────────────────────────────────
  } else if (reqPath === '/api/timers' && req.method === 'GET') {
    json({ timers: _timers });

  } else if (reqPath === '/api/timers' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (_timers.length >= TIMERS_MAX) { res.writeHead(400); res.end(JSON.stringify({ error: 'max timers reached' })); return; }
      const timer = _normalizeTimer({
        label: String(body.label || 'Timer').trim(),
        durationSecs: Math.max(1, Math.round(Number(body.duration_secs) || 60)),
        status: 'running',
        startedAt: Date.now(),
        pausedElapsed: 0,
      });
      _timers.push(timer);
      await _saveTimers();
      broadcastSSE('timer_update', { timers: _timers });
      json({ timer });
    } catch (e) { err500(e.message); }

  } else if (reqPath.startsWith('/api/timers/') && req.method === 'PATCH') {
    try {
      const tid = decodeURIComponent(reqPath.slice('/api/timers/'.length));
      const body = JSON.parse(await readBody(req));
      const action = String(body.action || '').trim();
      const idx = _timers.findIndex(t => t.id === tid);
      if (idx < 0) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
      const t = { ..._timers[idx] };
      if (action === 'pause' && t.status === 'running') {
        t.pausedElapsed += (Date.now() - t.startedAt) / 1000;
        t.status = 'paused';
      } else if (action === 'resume' && t.status === 'paused') {
        t.startedAt = Date.now();
        t.status = 'running';
      } else if (action === 'reset') {
        t.startedAt = Date.now();
        t.pausedElapsed = 0;
        t.status = 'running';
      }
      _timers[idx] = t;
      await _saveTimers();
      broadcastSSE('timer_update', { timers: _timers });
      json({ timer: t });
    } catch (e) { err500(e.message); }

  } else if (reqPath.startsWith('/api/timers/') && req.method === 'DELETE') {
    try {
      const tid = decodeURIComponent(reqPath.slice('/api/timers/'.length));
      _timers = _timers.filter(t => t.id !== tid);
      await _saveTimers();
      broadcastSSE('timer_update', { timers: _timers });
      json({ ok: true });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/lock' && req.method === 'POST') {
    lockWorkstation().then(() => json({ ok: true }), e => err500(e.message));

  } else if (reqPath === '/api/companion/insight' && req.method === 'POST') {
    // Game Companion (opt-in, Settings → Funzioni AI): capture the primary
    // screen and ask Gemini for a short in-game insight. Each call costs one
    // vision request, so the client only calls it on demand (overlay opened
    // or manual refresh) — never on a background timer while hidden.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const apiKey = String(body.key || '').trim().slice(0, 200);
      if (!apiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_key' })); return;
      }
      const LANG_NAMES = { it: 'Italian', en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese' };
      const langName = LANG_NAMES[String(body.lang || '').toLowerCase().slice(0, 2)] || 'English';
      const question = String(body.question || '').trim().slice(0, 300);
      let fgProc = '';
      try { fgProc = gameDetect.getForegroundProcess() || ''; } catch {}
      const screens = await listScreens();
      const primary = screens.find(s => s.primary) || screens[0];
      const shot = await captureScreenshot(primary);
      const sysText = 'You are Xenon\'s Game Companion, shown on a small secondary touchscreen next to the user\'s main monitor while they play. You receive a live screenshot of their game.';
      const task = question
        ? `The user asks: «${question}». Answer their question, grounded in what you see on screen. Reply in ${langName}: short plain sentences, no markdown, no preamble.`
        : `Identify the game and the current in-game situation, then give ONE concrete, immediately useful tip (strategy, mechanic, objective, build…). Reply in ${langName}: 2-3 short plain sentences, no markdown, no preamble. If the screen is clearly not a game, briefly say what you see instead.`;
      const userParts = [
        { text: `Live screenshot of the user's primary monitor${fgProc ? ` (foreground process: "${fgProc}")` : ''}. ${task}` },
        { inlineData: { mimeType: 'image/jpeg', data: shot } },
      ];
      const text = await _geminiOneShot(apiKey, userParts, sysText, 512);
      let fps = null;
      try { fps = fpsMonitor.getCurrentFps(); } catch { fps = null; }
      json({ text, process: fgProc, fps });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/ai' && req.method === 'POST') {
    try {
      const aiRaw = await readBodyBuffer(req, 10 * 1024 * 1024); // 10 MB — accommodate base64 images
      const aiBody = JSON.parse(aiRaw.toString('utf8') || '{}');
      const apiKey = String(aiBody.key || '').trim().slice(0, 200);
      const messages = Array.isArray(aiBody.messages) ? aiBody.messages.slice(0, 50) : [];
      const isVoice = aiBody.voice === true;
      // Rolling summary of earlier turns the client folded out of its window
      // (see /api/ai/summarize). Injected into the system prompt so the model
      // keeps the thread of a long conversation. Bounded defensively.
      const convSummary = String(aiBody.summary || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
      // The UI language. Used to force the reply language — without it Gemini tends
      // to answer in English when the turn carries an image or audio (little text to
      // infer from), which breaks an otherwise Italian conversation.
      const _uiLang2 = String(aiBody.lang || '').toLowerCase().slice(0, 2);
      const LANG_NAMES = { it: 'Italian', en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese' };
      const langName = LANG_NAMES[_uiLang2] || '';

      const provider = aiLocal.sanitizeProvider(aiBody.provider);
      const ollModel = aiLocal.sanitizeModel(aiBody.model);

      if (provider === 'gemini' && !apiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_key' })); return;
      }
      if (!messages.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no_messages' })); return;
      }

      const AI_FUNCTIONS = buildCoreAiFunctions();

      // Validate and sanitise attachment parts sent by the client. Gemini accepts
      // images, PDFs and plain text inline; documents are sent as text/plain.
      const ALLOWED_ATTACH_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain']);
      const rawImageParts = Array.isArray(aiBody.imageParts) ? aiBody.imageParts.slice(0, 4) : [];
      const safeImageParts = rawImageParts
        .filter(p => p && ALLOWED_ATTACH_TYPES.has(p.mimeType) && typeof p.data === 'string' && p.data.length > 0)
        .map(p => ({ mimeType: p.mimeType, data: p.data.slice(0, 8 * 1024 * 1024) }));

      // Validate and sanitise an optional audio clip sent by the client. When
      // present, Gemini transcribes AND answers the spoken request in this single
      // call — no separate speech-to-text round-trip needed.
      const ALLOWED_AUDIO_TYPES = new Set(['audio/wav', 'audio/webm', 'audio/ogg', 'audio/mp4']);
      const rawAudioParts = Array.isArray(aiBody.audioParts) ? aiBody.audioParts.slice(0, 1) : [];
      const safeAudioParts = rawAudioParts
        .filter(p => p && ALLOWED_AUDIO_TYPES.has(p.mimeType) && typeof p.data === 'string' && p.data.length > 0)
        .map(p => ({ mimeType: p.mimeType, data: p.data.slice(0, 12 * 1024 * 1024) }));
      const hasAudio = safeAudioParts.length > 0;

      // Inject images + audio into the last user message (current turn only — not stored in history)
      let currentMessages = messages.slice();
      const extraParts = [
        ...safeImageParts.map(p => ({ inlineData: p })),
        ...safeAudioParts.map(p => ({ inlineData: p })),
      ];
      if (extraParts.length > 0 && currentMessages.length > 0) {
        const last = currentMessages[currentMessages.length - 1];
        if (last.role === 'user') {
          currentMessages[currentMessages.length - 1] = {
            role: 'user',
            parts: [...(last.parts || []), ...extraParts],
          };
        }
      }

      const _latestUserText = (() => {
        for (let i = currentMessages.length - 1; i >= 0; i--) {
          const msg = currentMessages[i];
          if (!msg || msg.role !== 'user' || !Array.isArray(msg.parts)) continue;
          return msg.parts.map(p => typeof p.text === 'string' ? p.text : '').join(' ').trim();
        }
        return '';
      })();
      const _latestLooksLikeClothingWeather = /\b(vestit|vesti|vestir|indoss|mettermi|mettere|temperatur|meteo|weather|temperature|wear|outfit|clothes|jacket|giacca|felpa|maglione|cappotto)\b/i.test(_latestUserText);
      const _latestExplicitlyWantsScreen = /\b(schermo|monitor|screenshot|display|desktop|finestra|immagine|foto|screen|look|see|read|guarda|vedi|leggi|analizza|mostrato|visualizzato)\b/i.test(_latestUserText);

      const _now = new Date();
      const _nowDate = _now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const _nowTime = _now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const _tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      // Deck profiles live only in the browser; the client sends the current list
      // each turn. Surface their exact names so Xenon can switch by name reliably.
      const _deckProfiles = (Array.isArray(aiBody.deckProfiles) ? aiBody.deckProfiles : [])
        .map((p) => (p && typeof p === 'object') ? { name: String(p.name || '').slice(0, 40), active: !!p.active } : { name: String(p || '').slice(0, 40), active: false })
        .filter((p) => p.name)
        .slice(0, 24);
      const _deckProfilesText = _deckProfiles.length
        ? ` The Deck widget has these profiles (switch with switch_deck_profile using the EXACT name): ${_deckProfiles.map((p) => p.active ? `"${p.name}" (currently active)` : `"${p.name}"`).join(', ')}.`
        : '';
      // ── Opt-in advanced AI features ──────────────────────────────────
      // The client sends only the flags the user enabled in Settings → Funzioni
      // AI. Each flag unlocks its tools + prompt context for this turn only, so
      // disabled features cost zero extra tokens.
      const _features = (aiBody.features && typeof aiBody.features === 'object') ? aiBody.features : {};
      // STREAMING — OBS / Twitch / YouTube / Streamer.bot control. Exposed ONLY
      // when the matching integration is configured/connected (mirrors the deck
      // action-catalog gating), so non-streamers pay zero extra tokens. Every tool
      // routes through the same allowlisted deckRegistry that Deck keys use.
      let _streamingText = '';
      {
        const _s = (await readHubSettings().catch(() => null)) || {};
        const _tw = await streamTwitch.status().catch(() => ({ connected: false }));
        const _yt = await streamYouTube.status().catch(() => ({ connected: false }));
        const _enabled = [];
        if (_s.obsHost || obsLocalWanted) {
          AI_FUNCTIONS.push({ name: 'obs_control', description: 'Control OBS Studio: start/stop/toggle recording or streaming, switch to a scene, or go to the next scene.', parameters: { type: 'OBJECT', properties: {
            action: { type: 'STRING', description: 'One of: start_recording, stop_recording, toggle_recording, start_streaming, stop_streaming, toggle_streaming, switch_scene, next_scene' },
            scene: { type: 'STRING', description: 'Scene name — required only for switch_scene' },
          }, required: ['action'] } });
          _enabled.push('OBS (recording, streaming, scene switching)');
        }
        if (_tw.connected) {
          AI_FUNCTIONS.push({ name: 'twitch_action', description: 'Control your Twitch channel: create a clip, set the stream title or game/category, send a chat message, drop a stream marker, shout out a channel, change chat mode, or run an ad.', parameters: { type: 'OBJECT', properties: {
            action: { type: 'STRING', description: 'One of: create_clip, set_title, set_game, send_chat, marker, shoutout, chat_mode, run_ad' },
            value: { type: 'STRING', description: 'The parameter: new title (set_title), game/category (set_game), message (send_chat), marker note (marker), channel login (shoutout), chat mode emoteonly|followers|subscribers|slow|off (chat_mode), or ad length in seconds (run_ad). Omit for create_clip.' },
          }, required: ['action'] } });
          _enabled.push('Twitch (clip, title, game, chat, marker, shoutout, chat mode, ad)');
        }
        if (_yt.connected) {
          AI_FUNCTIONS.push({ name: 'youtube_broadcast', description: 'Start, stop, or toggle your YouTube live broadcast.', parameters: { type: 'OBJECT', properties: {
            mode: { type: 'STRING', description: 'One of: start, stop, toggle' },
          }, required: ['mode'] } });
          _enabled.push('YouTube (start/stop broadcast)');
        }
        if (_s.streamerbotHost) {
          AI_FUNCTIONS.push({ name: 'streamerbot_action', description: 'Trigger a Streamer.bot action by its exact name.', parameters: { type: 'OBJECT', properties: {
            action: { type: 'STRING', description: 'Exact Streamer.bot action name to run' },
          }, required: ['action'] } });
          _enabled.push('Streamer.bot (run actions)');
        }
        if (_enabled.length) {
          _streamingText = ' STREAMING CONTROL is available for: ' + _enabled.join('; ') + '.'
            + ' Use these tools when the user asks to control their stream (e.g. "start recording", "go live", "switch to my Gioco scene", "set the title to…", "clip that"). "Go live" on Twitch means start the OBS stream (obs_control start_streaming).'
            + ' If a tool returns an "unavailable"/"not_connected" error, tell the user that integration isn\'t connected and point them to Settings → Streaming.';
        }
      }
      // SMART DEVICE & MEDIA CONTROL — Spotify / Home Assistant / Discord voice.
      // Each tool is declared ONLY when its integration is connected/configured
      // (mirrors the streaming gate), so users without it pay zero extra tokens.
      // Every control routes through the same allowlisted deckRegistry the Deck +
      // widgets use; reads (now-playing, entity list, voice state) call the
      // provider instance directly, exactly like the existing data endpoints.
      let _integrationsText = '';
      {
        const _sp = await streamSpotify.status().catch(() => ({ connected: false }));
        const _dc = await discordRpc.status().catch(() => ({ connected: false }));
        const _s2 = (await readHubSettings().catch(() => null)) || {};
        const _haCfg = (_s2.homeAssistant && typeof _s2.homeAssistant === 'object') ? _s2.homeAssistant : {};
        const _haOn = !!(_haCfg.url && _haCfg.token);
        const _bits = [];
        if (_sp.connected) {
          AI_FUNCTIONS.push({ name: 'spotify_control', description: 'Control Spotify in full: play/pause, next/previous track, PLAY A SPECIFIC SONG, artist, album or playlist by NAME (searches Spotify and starts it), add a song to the queue, shuffle on/off, repeat, save/like the current track, set the device volume, seek, switch the playback device, and read what is currently playing. Playback control needs Spotify Premium (a "premium_required" error means the account is not Premium).', parameters: { type: 'OBJECT', properties: {
            action: { type: 'STRING', description: 'One of: play, pause, next, previous, play_song, queue_song, play_playlist, shuffle_on, shuffle_off, repeat, like, unlike, volume, seek, device, status. Use "status" to read the current track, playback state and available devices before answering "what\'s playing?" or when you need the device list.' },
            query: { type: 'STRING', description: 'The song/artist/album name for play_song and queue_song, the playlist name for play_playlist, or the device name for device. Omit otherwise.' },
            value: { type: 'STRING', description: 'The numeric/enum parameter: repeat mode (off|context|track — omit to cycle); volume 0-100; seek position in SECONDS. Omit otherwise.' },
          }, required: ['action'] } });
          _bits.push('Spotify (play/pause, next/prev, play or queue any song by name, playlists, shuffle, repeat, like, volume, seek, switch device)');
        }
        if (_haOn) {
          AI_FUNCTIONS.push({ name: 'home_assistant', description: 'Control the user\'s smart home through Home Assistant: list every device/entity with its current state, turn a device on/off/toggle, activate a scene, and control ANY device in fine detail (light brightness & colour, thermostat temperature, fan speed, cover position, media players, switches…) via a Home Assistant service call. When you do not already know the exact entity_id, call action "list" FIRST and match by the friendly name/area.', parameters: { type: 'OBJECT', properties: {
            action: { type: 'STRING', description: 'One of: list, turn_on, turn_off, toggle, scene, service. "list" returns all entities (id, friendly name, domain, area, state). "service" performs a detailed call (see service/data).' },
            entity_id: { type: 'STRING', description: 'The Home Assistant entity id, e.g. "light.living_room" or "climate.bedroom". Required for every action except list.' },
            service: { type: 'STRING', description: 'For action "service": the "<domain>.<service>" to call, e.g. "light.turn_on", "climate.set_temperature", "cover.set_cover_position", "fan.set_percentage".' },
            data: { type: 'STRING', description: 'For action "service": the service parameters as a JSON object string, e.g. {"brightness_pct":40,"color_name":"red"} or {"temperature":21}. Omit when the service takes no extra data.' },
          }, required: ['action'] } });
          _bits.push('Home Assistant (list devices, on/off/toggle, scenes, and detailed control: brightness, colour, temperature, fan speed, covers, media players)');
        }
        if (_dc.connected) {
          AI_FUNCTIONS.push({ name: 'discord_voice', description: 'Control the user\'s Discord voice settings via the desktop app: mute/unmute the microphone, deafen/undeafen, switch between push-to-talk and voice-activity, JOIN a voice channel by name, leave the current channel, nudge the input (mic) or output (speaker) volume up/down, toggle an audio-processing feature, and read the current voice state plus the list of available voice channels.', parameters: { type: 'OBJECT', properties: {
            action: { type: 'STRING', description: 'One of: mute, unmute, deafen, undeafen, ptt, vad, join, leave, input_volume, output_volume, audio_toggle, status. Use "status" to read the current mute/deafen state and the joinable channels before a join.' },
            channel: { type: 'STRING', description: 'The voice channel name to join (for action join). Matched case-insensitively against the user\'s channels.' },
            mode: { type: 'STRING', description: 'up or down — for input_volume / output_volume.' },
            feature: { type: 'STRING', description: 'For audio_toggle: noise_suppression | echo_cancellation | automatic_gain_control | qos.' },
          }, required: ['action'] } });
          _bits.push('Discord voice (mute/deafen, push-to-talk, join/leave a channel by name, input/output volume, audio features)');
        }
        if (_bits.length) {
          _integrationsText = ' SMART DEVICE & MEDIA CONTROL is available for: ' + _bits.join('; ') + '.'
            + ' Use these tools whenever the user asks to control the matching thing — e.g. "metti <canzone> su Spotify"/"play <song>" → spotify_control play_song; "accendi la luce del salotto"/"turn on the living room light" → home_assistant (list first if you don\'t know the entity, then turn_on); "abbassa le luci al 30%" → home_assistant service light.turn_on with {"brightness_pct":30}; "mettimi in muto su Discord" → discord_voice mute; "entra nel canale Gaming" → discord_voice join.'
            + ' For Home Assistant, ALWAYS call action "list" first when you are unsure of the exact entity_id, then act on the matched id. If a tool returns an "unavailable"/"not_connected" error, tell the user that integration isn\'t connected (Settings → Spotify / Casa / Discord) rather than pretending it worked.';
        }
      }
      // GENESIS — AI-composed dashboard pages. The page/widget map is client-
      // owned (like deck profiles), so the client sends a snapshot per turn.
      let _genesisText = '';
      if (_features.genesis === true) {
        const ds = (aiBody.dashboardState && typeof aiBody.dashboardState === 'object') ? aiBody.dashboardState : null;
        const _avail = (ds && Array.isArray(ds.availableWidgets) ? ds.availableWidgets : [])
          .filter(w => typeof w === 'string').slice(0, 32).map(w => w.slice(0, 24));
        const _pages = (ds && Array.isArray(ds.pages) ? ds.pages : [])
          .filter(p => p && typeof p === 'object').slice(0, 8)
          .map(p => ({
            name: String(p.name || '').slice(0, 40),
            widgets: (Array.isArray(p.widgets) ? p.widgets : []).slice(0, 32).map(w => String(w).slice(0, 24)),
          }));
        const _maxPages = (ds && Number.isFinite(ds.maxPages)) ? ds.maxPages : 8;
        AI_FUNCTIONS.push(
          { name: 'genesis_compose_page', description: 'GENESIS: create a NEW dashboard page with the given name and widgets, then switch to it. Call this ONLY once you know what the page is for — if the user just said "create a dashboard/page" with no purpose, ask first. Pick widgets ONLY from the available widget ids in the system context. Use "tabs" to group related widgets into tabbed tiles and "sizes" to make key tiles wider.', parameters: { type: 'OBJECT', properties: {
            name: { type: 'STRING', description: 'Short page name in the user\'s language, e.g. "Streaming"' },
            widgets: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Widget ids to place on the page (3-6 is ideal), from the available list' },
            tabs: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'STRING' } }, description: 'Optional: groups of 2+ widget ids (all also present in "widgets") to merge into a single tabbed tile. e.g. [["twitch","obs"]] puts Twitch and OBS as tabs in one tile. Use when widgets are related or when the user asks for tabs.' },
            sizes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { widget: { type: 'STRING' }, size: { type: 'STRING', description: 'small | medium | large | wide | full' } }, required: ['widget', 'size'] }, description: 'Optional: make specific tiles wider than the balanced default. Use "wide"/"full" for the page\'s primary tile (e.g. the main video/preview or chat).' },
          }, required: ['name', 'widgets'] } },
          { name: 'genesis_add_widgets', description: 'GENESIS: add widgets to an EXISTING dashboard page (referenced by its exact name from the current pages list), then switch to it. Use "tabs" to group widgets into tabbed tiles without disturbing the rest of the page.', parameters: { type: 'OBJECT', properties: {
            page: { type: 'STRING', description: 'Exact name of the existing page' },
            widgets: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Widget ids to add, from the available list' },
            tabs: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'STRING' } }, description: 'Optional: groups of 2+ widget ids (on this page) to merge into tabbed tiles.' },
          }, required: ['page', 'widgets'] } },
          { name: 'genesis_duplicate_widget', description: 'GENESIS: mirror/duplicate a single widget onto another dashboard page (by its exact name). Duplicable widgets (media, mic, tasks, notes, agenda, system, audio, timer, lighting) become a LIVE copy shown on both pages; use when the user wants the same widget available on more than one page.', parameters: { type: 'OBJECT', properties: {
            widget: { type: 'STRING', description: 'Widget id to duplicate, from the available list' },
            page: { type: 'STRING', description: 'Exact name of the destination page' },
          }, required: ['widget', 'page'] } },
          { name: 'genesis_remove_page', description: 'GENESIS: remove a dashboard page by its exact name. DESTRUCTIVE — always confirm with the user before calling.', parameters: { type: 'OBJECT', properties: {
            page: { type: 'STRING', description: 'Exact name of the page to remove' },
          }, required: ['page'] } },
          { name: 'genesis_setup_deck', description: 'GENESIS: populate the Deck (stream-deck) widget with a ready-to-use profile of keys. Call this in the SAME turn whenever you compose/extend a page that includes the "deck" widget, or when the user asks to configure the deck. Each key needs a short title in the user\'s language, one emoji icon, a theme-fitting accent hex color and an action from the allowed list.', parameters: { type: 'OBJECT', properties: {
            profile: { type: 'STRING', description: 'Short profile name in the user\'s language matching the theme, e.g. "Gaming"' },
            cols: { type: 'NUMBER', description: 'Grid columns (1-8), proportionate to the number of keys' },
            rows: { type: 'NUMBER', description: 'Grid rows (1-8); cols×rows should fit all keys' },
            keys: { type: 'ARRAY', description: 'The deck keys, most essential first (4-10 ideal)', items: { type: 'OBJECT', properties: {
              title: { type: 'STRING', description: 'Short key label in the user\'s language (max ~12 chars)' },
              icon: { type: 'STRING', description: 'A single emoji for the key, e.g. 🎙️' },
              color: { type: 'STRING', description: 'Accent hex color for the key, e.g. #ff3b30' },
              action: { type: 'STRING', description: 'One of: media_playpause, media_next, media_prev, play_sound, mic_toggle, volume_mute, volume_up, volume_down, app_mixer, app_volume_up, app_volume_down, app_mute, ai_voice, ai_chat, ai_prompt, lighting_color, open_app, open_file, open_store_app, open_url, hotkey, webhook, obs_record, obs_stream, obs_scene, obs_scene_next, twitch_clip, twitch_marker, twitch_ad, twitch_title, twitch_game, twitch_chat, twitch_shoutout, twitch_chatmode, yt_broadcast, sb_action, remote_disconnect, remote_block, remote_screen_cycle' },
              value: { type: 'STRING', description: 'Action parameter when needed: prompt text for ai_prompt; hex color for lighting_color; URL for open_url/webhook; app path for open_app/open_file; key combo for hotkey (e.g. "ctrl+shift+m"); scene name for obs_scene; app name for app_volume_up/down and app_mute; new title/game/message/login for twitch_title/twitch_game/twitch_chat/twitch_shoutout. Omit otherwise.' },
              ledColor: { type: 'STRING', description: 'Optional hex color: flashes the RGB lighting when the key fires. Use on the most important keys.' },
            }, required: ['title', 'icon', 'action'] } },
          }, required: ['profile', 'keys'] } },
        );
        _genesisText = ` GENESIS (dashboard composer) is ENABLED. Available widget ids: ${_avail.join(', ') || 'unknown'}.` +
          ` Current pages: ${_pages.map(p => `"${p.name}" [${p.widgets.join(', ') || 'empty'}]`).join('; ') || 'none'} (max ${_maxPages} pages).` +
          ' When the request names a clear activity or theme (e.g. "build me a streaming page"), pick the most relevant widgets (3-6) and call genesis_compose_page with a short fitting name — no need to ask which widgets.' +
          ' When the request is GENERIC ("create a new dashboard/page" with no purpose), do NOT compose yet: first ask, in the user\'s language, one short question about what the page is for, suggesting 2-3 concrete examples (e.g. gaming, work/focus, music, streaming). If useful, follow up with at most ONE more question about what they want to see on it, then compose. Never ask more than two questions before composing.' +
          ' RICH LAYOUT — compose thoughtfully, not just a flat row of tiles:' +
          '  • TABS: pass "tabs" to genesis_compose_page/genesis_add_widgets to merge related widgets into a single tabbed tile. ALWAYS honour an explicit request for tabs, AND use tabs on your own when two or more widgets are closely related or the page would otherwise be crowded — e.g. group [obs, twitch] or [obs, twitch, youtube] on a streaming page, [tasks, agenda, notes] on a work page, [media, audio, mic] for sound. Never group a widget the user wants prominent on its own.' +
          '  • SIZES: pass "sizes" to make the page\'s primary tile wider ("wide" or "full") — e.g. the OBS/preview tile on a streaming page, the media tile on a music page — so the layout has a clear focal point.' +
          '  • DUPLICATE: call genesis_duplicate_widget to mirror a widget (media, mic, tasks, notes, agenda, system, audio, timer, lighting) onto another page when the user wants it available in more than one place (e.g. "keep the player on every page").' +
          ' DECK: the "deck" widget is a programmable stream-deck key grid — NEVER leave it empty. Whenever a page you compose or extend includes "deck" (or the user asks to set up the deck), ALSO call genesis_setup_deck in the same turn: pick the most essential keys for the theme (4-10) — e.g. for gaming: mic toggle, app mixer, play/pause, lighting color, OBS record; for streaming: OBS stream/record/scene, mic toggle, mixer — each with a short title in the user\'s language, one fitting emoji, an accent hex color matching the theme, and add ledColor on the most important keys so the RGB lighting reacts on press. Choose cols×rows proportionate to the key count (4 keys → 2x2, 6 → 3x2, 8 → 4x2).' +
          ' After all genesis calls, ALWAYS recap briefly in the user\'s language what you created: the page, its widgets, and each deck key with its function.' +
          ' Confirm before genesis_remove_page.';
      }
      // GUARDIAN — long-term hardware health. Exposes a single read-only tool
      // that returns the locally-computed digest (no extra API calls).
      let _guardianText = '';
      if (_features.guardian === true) {
        AI_FUNCTIONS.push({
          name: 'guardian_report',
          description: 'GUARDIAN: get the hardware-health digest — CPU/GPU load and temperature plus RAM usage aggregated over the last 24h / 7 days / 30 days, with 7d-vs-30d trend deltas. Call BEFORE answering any question about PC health, temperatures over time, thermal trends, or "is my PC ok".',
          parameters: { type: 'OBJECT', properties: {} },
        });
        AI_FUNCTIONS.push({
          name: 'query_sensor_history',
          description: 'GUARDIAN: get the recorded history of ONE sensor broken down for comparison — today vs yesterday, last 24h, 7-day and 30-day averages, the peak day of the last 30 days, and the last 7 daily points. Use this (not guardian_report) for specific time comparisons like "was my GPU hotter yesterday than today", "what was my worst day this month", "how has my CPU temp trended this week".',
          parameters: { type: 'OBJECT', properties: {
            metric: { type: 'STRING', description: 'Which sensor: "cpu" (load %), "cpuTemp", "gpu" (load %), "gpuTemp", "mem" (RAM %), "cpuWatts" or "gpuWatts" (power draw). Friendly names like "gpu temp", "ram" or "cpu power" also work.' },
          }, required: ['metric'] },
        });
        _guardianText = ' GUARDIAN (hardware health history) is ENABLED: when the user asks about PC health, temperatures, or long-term trends, call guardian_report and base your analysis ONLY on its real data — mention notable maxima and 7d-vs-30d trends, suggest practical fixes (dust, fan curve, background apps) only when the data justifies them, and say so plainly when everything looks healthy. For a SPECIFIC time comparison or a single sensor over time (today vs yesterday, worst day this month, this week\'s trend), call query_sensor_history with the metric instead. If collectedDays is low, note that the history is still short.';
      }
      // PERSISTENT MEMORY — durable facts Xenon remembers about the user across
      // sessions. On by default (local & private); disabled via Settings →
      // Funzioni AI. The tools are exposed and the stored facts are injected into
      // the prompt only while enabled, so a user who turned it off pays nothing.
      let _memoryText = '';
      {
        const _sm = (await readHubSettings().catch(() => null)) || {};
        if (_sm.aiMemory !== false) {
          AI_FUNCTIONS.push(...buildMemoryFunctions());
          _memoryText = aiMemory.count() > 0 ? aiMemory.formatForPrompt() : aiMemory.emptyPromptHint();
        }
      }
      // PC CONTROL — consent-gated generic Windows command execution. Off by
      // default; the tool NEVER runs a command directly — it proposes one that
      // executes only after the user approves a confirmation card.
      let _pcControlText = '';
      if (_features.pcControl === true) {
        AI_FUNCTIONS.push({
          name: 'run_pc_command',
          description: 'PC CONTROL: run a Windows PowerShell command on the user\'s PC to do something the other tools do not cover (system tweaks, file operations, launching things with arguments, queries…). This NEVER runs automatically: the user sees a confirmation card with the exact command and must approve it. Propose the SMALLEST, most targeted command that does the job, and always fill "description" with a short plain-language explanation of what it does and why. Prefer a dedicated tool when one exists (audio, media, apps, lighting…).',
          parameters: { type: 'OBJECT', properties: {
            command: { type: 'STRING', description: 'The exact PowerShell command to run, e.g. "Get-Process | Sort CPU -desc | Select -First 5".' },
            description: { type: 'STRING', description: 'Short plain-language summary of what this command does, shown to the user on the confirmation card.' },
          }, required: ['command', 'description'] },
        });
        _pcControlText = ' PC CONTROL is ENABLED: you may use run_pc_command for actions no other tool covers. It executes ONLY after the user approves a confirmation card showing the exact command — so after calling it, do NOT say it is done; instead tell the user to review and confirm on the card — the result is shown to them there once it runs. Always prefer a dedicated tool when one exists. Keep commands minimal and safe; if a request is ambiguous or potentially destructive (deleting files, changing system config), explain the risk and ask the user to confirm the intent before proposing the command.'
          + ' Make each command SELF-SUFFICIENT so it does not fail on a missing prerequisite: when creating a file in a folder that may not exist, create the folder first in the same command (e.g. `New-Item -ItemType Directory -Force -Path "$HOME\\Desktop\\Nintendo" | Out-Null; New-Item -ItemType File -Force -Path "$HOME\\Desktop\\Nintendo\\dante.txt" -Value "…"`), and generally use `-Force`/existence checks so a reasonable command succeeds on the first try. If a command fails, read the error shown on the card and propose a corrected one.';
      }
      const _summaryText = convSummary
        ? ` CONVERSATION MEMORY — a summary of earlier parts of THIS conversation that scrolled out of the recent window (treat it as accurate context; the recent turns follow after it): ${convSummary}`
        : '';
      const SYS_BASE = `Current date and time: ${_nowDate}, ${_nowTime} (${_tz}). ` +
        'You are Xenon, a capable, helpful AI assistant embedded in Xenon — a real-time dashboard for the CORSAIR Xeneon Edge 14.5" display.' +
        ' Answer ANY question the user asks, drawing on your broad general knowledge (technology, science, history, everyday topics, etc.).' +
        ' For anything recent, live, or that you are not certain about (news, prices, sports results, weather elsewhere, release dates, "what is X today"…), call web_search instead of guessing — then answer using the results.' +
        ' YOU CAN DIRECTLY CONTROL THE WHOLE DASHBOARD — this is a core part of your job, not an afterthought. Whenever the user asks for something a tool covers, DO IT with the tool instead of only describing it. Your controls, by area:' +
        '  • Audio & mic: mute/unmute the mic, set mic volume, set speaker volume, mute the speaker, turn a single app up/down or mute it (per-app mixer), and switch the default speaker/output or microphone/input device by name (list them first if unsure).' +
        '  • Media: play/pause, next, previous track, and choose which app the Now Playing tile follows (media source).' +
        '  • Productivity: read/replace notes; list/create/complete/delete tasks (and clear all); list/create/delete calendar events (and clear all); start/list/delete countdown timers.' +
        '  • RGB lighting: set a manual colour, clear it, enable/disable reactive effects, configure event-flash effects, and turn the whole lighting bridge on/off.' +
        '  • System & apps: read live CPU/GPU/RAM/disk stats and individual sensors (e.g. CPU temp), open or close any app/website/file on Windows, lock the PC, and turn Performance Mode on/off.' +
        '  • Appearance: change the theme/skin by name OR set exact semantic hex colours for the app canvas, panels, nested surfaces, controls, primary/muted text, borders, accent foreground and success/warning/error/info states via customize_appearance; Light/Dark/Auto seed a coherent palette and unsafe contrast is repaired by default.' +
        '  • Preferences: set the 12h/24h clock, temperature unit, interface language, weather location (auto or a manual city), and which widgets show on the focus lock screen, via configure_preferences.' +
        '  • Dashboard UI: navigate between dashboard pages, switch the Deck to one of its profiles, and open the weather / settings / app-switcher panels or the focus lock screen.' +
        '  • Screen vision: capture and analyse any monitor.' +
        '  • Creator & marketplace: search the community catalog and start installs (the user always confirms in the review dialog), CREATE brand-new custom widgets by writing their code (ground with sdk_reference, then create_widget), and build or extend full Deck profiles (ground with deck_action_catalog, then configure_deck).' +
        ' APP KNOWLEDGE: you have built-in documentation about Xenon itself. BEFORE answering any question about how Xenon works — setup, requirements, why something reads empty (e.g. fans/watts and admin rights), updates, the marketplace, supporter codes, publishing content, integrations setup, privacy, troubleshooting — call xenon_knowledge with the question and ground your answer on the returned card instead of guessing; if the card does not cover it, say plainly what you are unsure about.' +
        ' Feature-gated extras appear as extra tools ONLY when the matching integration is connected or the user enabled them: full Spotify playback control incl. playing/queueing any song by name (spotify_control), smart-home control via Home Assistant incl. detailed brightness/colour/temperature/fan/cover control (home_assistant), Discord voice control incl. join-by-name/mute/deafen/volume (discord_voice), composing/editing dashboard pages (Genesis — pages, tabbed tiles, widget duplication, Deck setup), controlling OBS/Twitch/YouTube/Streamer.bot (Streaming), reading long-term hardware-health history (Guardian), and running arbitrary confirmed Windows commands (PC Control — run_pc_command). When such a tool is present, prefer it over a generic answer. When the user asks for something you genuinely have no tool for: if PC Control is enabled and the task is doable via a Windows command, propose one with run_pc_command; otherwise say plainly you cannot do it rather than pretending you did.' +
        ' WHEN ASKED WHAT YOU CAN DO — OR whether you can do/control a specific thing ("puoi controllare il mio PC?", "sai gestire l\'audio?", "can you also…?"): NEVER give a vague blurb and NEVER give a NARROW answer that mentions only one slice (e.g. only "monitoring") while omitting the rest — that is underselling and it reads as dishonest. Lead with the truth that you do not just READ/monitor the PC, you actively CONTROL it, then name the real breadth from the control surface above: open & close apps, control audio/mic (incl. per-app mixer and switching the output/mic device), media & media source, RGB lighting, lock the PC, live CPU/GPU/RAM/disk stats and sensors, Performance Mode, appearance incl. exact hex colours and light/dark, preferences (clock, unit, language, weather, lock-screen widgets), notes/tasks/calendar/timers, pages/Deck profiles/panels, screen vision, searching & installing community marketplace content, and CREATING new custom widgets and Deck profiles from scratch — plus any enabled extras (Genesis page-building, Streaming control, Guardian health history, and — when PC Control is on — running arbitrary confirmed Windows commands, which is real, deep control of the machine). In a VOICE turn answer in ONE or TWO short spoken sentences that name several of these areas in flowing prose — NO bulleted list, no "*", no line breaks — and offer to detail any (e.g. "Sì, non solo lo monitoro: apro e chiudo app, gestisco audio media e luci, blocco il PC, cambio tema e impostazioni, e con il Controllo PC attivo eseguo comandi Windows. Vuoi che ti mostri qualcosa?"). Only in a TEXT turn give a short organised list. Ground it in the tools you actually have this turn — do not invent capabilities.' +
        ' SCREEN VISION SAFETY: call capture_screen ONLY when the latest user message explicitly asks you to inspect/read/look at the screen, monitor, screenshot, image, window, or visible UI. Do not ask which monitor unless the user actually requested screen vision. For weather, temperature, clothing, outfit, or "what should I wear" questions, use get_weather and answer directly; never route those to capture_screen, even if speech-to-text produced a short/garbled phrase such as "che vesti".' +

        // ── Conversational data collection ──────────────────────────────────
        ' CONVERSATIONAL BEHAVIOUR — follow these rules every time:' +
        ' (1) COLLECT BEFORE ACTING: when the user asks you to do something but has not provided the information you need to call the function, ask for it conversationally — one concise question at a time — and wait for the answer. Do NOT call the function with invented, empty, or guessed required fields.' +
        '     Examples: "aggiungimi un task" → ask what the task is; "metti un timer" → ask for how long; "crea un evento" → ask title then date/time; "scrivi nelle note" → ask what to write; "cambia tema" → ask which (xenon/ocean/ember/violet/mono).' +
        ' (2) IDENTIFY BEFORE DELETE/COMPLETE: when the user says "elimina il task", "segna come fatto il timer", etc. without specifying which one, call list_tasks/list_timers/list_calendar_events first and then ask the user to confirm which item.' +
        ' (3) CONFIRM DESTRUCTIVE ACTIONS: before running clear_all_tasks, clear_all_calendar_events, write_notes (overwrite), delete_calendar_event, or any bulk delete, briefly state what you are about to do ("Sto per cancellare tutti i task, procedo?") and wait for confirmation. Exception: if the user\'s message already makes the intent unambiguous and explicit ("sì cancella tutto", "svuota tutto"), proceed directly.' +
        ' (4) COLLECT KEY OPTIONAL FIELDS TOO — after required fields, also ask for these specific optional ones before calling the function:' +
        '   • create_task → after the task text, ask for priority (alta / media / bassa).' +
        '   • start_timer → after the duration, ask for a label (e.g. "Come lo chiamo?" — skip if user seems in a hurry or already answered).' +
        '   • create_calendar_event → collect in this exact order before calling the function: (a) title if missing, (b) date if missing, (c) time if missing — ask as one short question e.g. "A che ora?" — do NOT skip this, do NOT default to 00:00, (d) then ask once about a reminder ("Vuoi un promemoria? Se sì, quando?"). Call create_calendar_event EXACTLY ONCE with all collected fields — never call it before the reminder question, never call it twice.' +
        '   For all other optional fields (recurrence, notes on events, etc.) use sensible defaults and do NOT ask unless the user explicitly mentions them.' +
        '   Exception: if the request already contains everything ("crea evento riunione domani alle 15"), call immediately — no further questions.' +
        ' (5) VOLUME WITHOUT A NUMBER: if the user says "alza", "abbassa", "aumenta", "diminuisci" volume/microfono without a number, infer a reasonable delta (±20 from the current value or a sensible target like 80 for "alza" and 40 for "abbassa") and act without asking.' +
        ' (6) ACT ONLY ON THE CURRENT REQUEST: earlier turns in this conversation may show actions you already completed (e.g. a task you added). NEVER repeat or re-execute a past action unless the user explicitly asks again in their latest message. Each new user message is a fresh request — respond to THAT, do not carry over or replay a previous command.' +
        ' (7) ASK WHEN GENUINELY UNSURE: you are a real assistant, not a guesser. When a request is ambiguous, could reasonably mean different things, or would produce a big/irreversible change from an unclear instruction, ask ONE short clarifying question before acting instead of guessing. But do NOT over-ask: when the intent is clear or a sensible default obviously fits, just do it. Balance — one good question beats a wrong action, and one confident action beats a needless question.' +

        // ── Other rules ─────────────────────────────────────────────────────
        ' TOOL CALLS: invoke functions ONLY through the native function-calling mechanism. NEVER write a tool call as plain text (e.g. "[call:...]", "default_api.…", code blocks) — anything you write as text is shown and spoken to the user verbatim.' +
        ' Always reply in the same language as the user.' +
        ' IMPORTANT — speech-to-text artefacts: the STT engine may occasionally merge consecutive words when the user mixes Italian with English proper nouns. If you receive something like "apristim", "aprispot", "apridiscord", or similar phonetic mashups, interpret them as the most likely Italian command plus the English app name (e.g. "apristim" → open Steam, "aprispot" → open Spotify). Always prefer a command interpretation over treating the input as gibberish.' +
        _deckProfilesText +
        _streamingText +
        _integrationsText +
        _genesisText +
        _guardianText +
        _memoryText +
        _summaryText +
        _pcControlText;
      // Voice turns are spoken aloud, so keep them short and conversational: this
      // also makes both the reply generation and the text-to-speech noticeably faster.
      const SYS_VOICE = ' This is a VOICE conversation — your reply will be spoken aloud. Keep it SHORT and natural, like a spoken answer: 1-2 sentences, no markdown, no lists, no headings. Get straight to the point as if talking to a person.' +
        ' When you need to ask the user a clarifying question (data collection), ask only ONE question per turn and keep it to a single short spoken sentence — the microphone will reopen automatically after your reply so the user can answer immediately.' +
        ' If the user only says a dismissal ("stop", "basta", "ferma", "esci", "lascia stare", "grazie" with nothing else), reply with a single short word like "Ok" and call close_ai_panel.';
      const SYS_AUDIO = ' The user\'s request is provided as an audio clip — transcribe it yourself and act on it. Ignore any bracketed placeholder like "[richiesta vocale]" — it is just an internal label, not something the user said. If a short text snippet also accompanies the audio, it is the BEGINNING of the same spoken sentence (captured a moment earlier) and the audio continues it — treat them as one continuous request and combine them.';
      const SYS_TEXT = ' Be concise but complete; replies may be read aloud.';
      // Strong language lock — placed LAST so it overrides any tendency to drift to
      // English (which happens most when the turn carries an image or audio).
      const SYS_LANG = langName
        ? ` CRITICAL: the user's language is ${langName}. You MUST always reply in ${langName} — including when you describe a screenshot, an image, or anything you "see" — unless the user's latest message is clearly in a different language, whether they typed it OR spoke it (match the language they actually used this turn). Never switch to English on your own.`
        : '';
      // Opt-in "advanced reasoning" (Settings → Funzioni AI): route TEXT turns to
      // the stronger model. Voice / audio turns stay on the fast model — latency
      // matters when the reply is spoken aloud. `chatModel` is a `let` so the
      // fallback below can drop back to the fast model if the pro model is
      // unavailable (e.g. not enabled on the user's key), mid-conversation.
      const _reasonSettings = (await readHubSettings().catch(() => null)) || {};
      let chatModel = (_reasonSettings.aiProReasoning === true && !isVoice && !hasAudio)
        ? AI_MODELS.chatPro : AI_MODELS.chat;
      const callGemini = (msgs) => new Promise((resolve, reject) => {
        const payload = JSON.stringify({
          system_instruction: { parts: [{ text: SYS_BASE + ((isVoice || hasAudio) ? SYS_VOICE : SYS_TEXT) + (hasAudio ? SYS_AUDIO : '') + SYS_LANG }] },
          tools: [{ functionDeclarations: AI_FUNCTIONS }],
          contents: msgs,
          generationConfig: { temperature: 0.7, maxOutputTokens: 1024, candidateCount: 1, thinkingConfig: { thinkingBudget: 0 } },
        });
        const aiReq = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/${chatModel}:generateContent?key=${encodeURIComponent(apiKey)}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
        }, (aiRes) => {
          let data = '';
          aiRes.on('data', chunk => { data += chunk; });
          aiRes.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
              else resolve(parsed);
            } catch (parseErr) { reject(parseErr); }
          });
        });
        aiReq.on('error', reject);
        aiReq.setTimeout(20000, () => { aiReq.destroy(); reject(new Error('Gemini request timed out')); });
        aiReq.write(payload);
        aiReq.end();
      });

      const _AI_FN_NAMES = new Set(AI_FUNCTIONS.map(f => f.name));
      const getCandidate = (r) => {
        let content = r.candidates && r.candidates[0] && r.candidates[0].content;
        const parts = (content && content.parts) || [];
        // Gemini 3 can prepend "thought" parts even with thinking disabled; the
        // functionCall / real answer may sit in any later part. Reading only
        // parts[0] used to skip tool calls and leak thought text to the chat.
        let part = parts.find(p => p.functionCall) || parts.find(p => p.text && !p.thought) || parts[0];
        // Fallback: the model sometimes writes the tool call as plain text
        // ("[call:default_api:fn{…}]"). Recover it as a real functionCall and
        // rewrite the history turn so the functionResponse stays well-formed.
        if (part && !part.functionCall) {
          const visText = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
          const leaked = _parseLeakedToolCall(visText, _AI_FN_NAMES);
          if (leaked) {
            part = { functionCall: { name: leaked.name, args: leaked.args } };
            content = { role: 'model', parts: [part] };
          }
        }
        return { content, part };
      };

      // currentMessages already built above (with optional imageParts injected)
      const clientActions = [];

      if (provider === 'ollama') {
        const settings = await readHubSettings().catch(() => null);
        const baseUrl = aiLocal.sanitizeOllamaUrl(aiBody.ollamaUrl || (settings && settings.ollamaUrl));
        const concreteModel = aiLocal.resolveModel(ollModel, settings && settings.hardwareScan);
        // Smaller local models tend to parrot tool output verbatim, so reinforce
        // the language lock: web_search snippets often come back in English and
        // must be translated into the user's language before answering.
        const SYS_LOCAL = (langName ? ` Tool results (especially web_search) may be written in English; ALWAYS translate and write your final answer in ${langName}, never copy the English text verbatim.` : '');
        const systemText = SYS_BASE + ((isVoice || hasAudio) ? SYS_VOICE : SYS_TEXT) + SYS_LANG + SYS_LOCAL;
        try {
          const result = await aiLocal.localChat({
            baseUrl, model: concreteModel, geminiTools: AI_FUNCTIONS,
            history: currentMessages, systemText,
            executeTool: (fnName, fnArgs) => executeAiTool(fnName, fnArgs, {
              apiKey, uiLang: _uiLang2, latestUserText: _latestUserText,
              latestLooksLikeClothingWeather: _latestLooksLikeClothingWeather,
              latestExplicitlyWantsScreen: _latestExplicitlyWantsScreen,
              provider: 'ollama',
            }).then(r => ({ fnResult: r.fnResult, clientActions: r.clientActions })),
          });
          json({ text: result.text, clientActions: result.clientActions, newContent: result.newContent });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      if (provider === 'openai' || provider === 'anthropic') {
        // Server-mediated cloud providers (ChatGPT / Claude). Their keys are
        // SERVER-ONLY, so read them from settings — never from the request body.
        // Chat + function-calling + vision reuse the same tools and the same
        // { text, clientActions, newContent } response shape as Gemini/local.
        const settings = await readHubSettings().catch(() => null);
        const provKey = provider === 'openai'
          ? String((settings && settings.openaiApiKey) || '').trim()
          : String((settings && settings.anthropicApiKey) || '').trim();
        if (!provKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing_key' })); return;
        }
        const provModel = provider === 'openai' ? (settings && settings.openaiModel) : (settings && settings.anthropicModel);
        // web_search for these providers runs key-free via DuckDuckGo (see below),
        // whose snippets are often English — reinforce the language lock, exactly
        // like the local path does.
        const SYS_XLATE = (langName ? ` Tool results (especially web_search) may be written in English; ALWAYS translate and write your final answer in ${langName}, never copy the English text verbatim.` : '');
        const systemText = SYS_BASE + ((isVoice || hasAudio) ? SYS_VOICE : SYS_TEXT) + SYS_LANG + SYS_XLATE;
        const mod = provider === 'openai' ? aiOpenai : aiAnthropic;
        try {
          const result = await mod.chat({
            apiKey: provKey, model: provModel, geminiTools: AI_FUNCTIONS,
            history: currentMessages, systemText,
            executeTool: (fnName, fnArgs) => executeAiTool(fnName, fnArgs, {
              apiKey, uiLang: _uiLang2, latestUserText: _latestUserText,
              latestLooksLikeClothingWeather: _latestLooksLikeClothingWeather,
              latestExplicitlyWantsScreen: _latestExplicitlyWantsScreen,
              provider,
            }).then(r => ({ fnResult: r.fnResult, clientActions: r.clientActions, pendingScreenImage: r.pendingScreenImage })),
          });
          json({ text: result.text, clientActions: result.clientActions, newContent: result.newContent });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      // Pro model unavailable / errored → transparently fall back to the fast
      // model (for this call AND the rest of the tool loop) so the user is never
      // stranded by an opt-in setting — including when the failure happens on a
      // later loop iteration, AFTER a tool call already mutated state.
      const callGeminiWithFallback = async (msgs) => {
        try {
          return await callGemini(msgs);
        } catch (err) {
          if (chatModel !== AI_MODELS.chat) { chatModel = AI_MODELS.chat; return await callGemini(msgs); }
          throw err;
        }
      };

      let geminiResult = await callGeminiWithFallback(currentMessages);
      let { content, part } = getCandidate(geminiResult);

      // Function calling loop. Bounded by BOTH a step cap and a wall-clock budget
      // so multi-step requests (e.g. Genesis composing a page AND setting up the
      // Deck, or a chain of dashboard actions) can complete instead of being cut
      // off at 3 steps — while a runaway or slow model can never hang the turn.
      const AI_MAX_TOOL_ITERS = 8;
      const AI_TOOL_TIME_BUDGET_MS = 28000;
      const _loopStart = Date.now();
      let pendingScreenImage = null; // base64 JPEG to feed Gemini after capture_screen
      for (let iter = 0; iter < AI_MAX_TOOL_ITERS && part && part.functionCall; iter++) {
        if (iter > 0 && Date.now() - _loopStart > AI_TOOL_TIME_BUDGET_MS) break;
        const fnName = part.functionCall.name;
        const fnArgs = part.functionCall.args || {};
        currentMessages = [...currentMessages, content];

        const { fnResult, clientActions: fnClientActions, pendingScreenImage: fnScreen } =
          await executeAiTool(fnName, fnArgs, {
            apiKey,
            uiLang: _uiLang2,
            latestUserText: _latestUserText,
            latestLooksLikeClothingWeather: _latestLooksLikeClothingWeather,
            latestExplicitlyWantsScreen: _latestExplicitlyWantsScreen,
          });
        for (const a of fnClientActions) clientActions.push(a);
        if (fnScreen) pendingScreenImage = fnScreen;

        currentMessages = [...currentMessages, {
          role: 'user',
          parts: [{ functionResponse: { name: fnName, response: { output: JSON.stringify(fnResult) } } }],
        }];

        // Feed the captured screenshot to Gemini so it can actually see the screen.
        if (pendingScreenImage) {
          currentMessages.push({
            role: 'user',
            parts: [
              { text: 'Here is the current screenshot of the requested monitor.' },
              { inlineData: { mimeType: 'image/jpeg', data: pendingScreenImage } },
            ],
          });
          pendingScreenImage = null;
        }

        geminiResult = await callGeminiWithFallback(currentMessages);
        ({ content, part } = getCandidate(geminiResult));
      }

      const text = ((content && content.parts) || [])
        .filter(p => p.text && !p.thought)
        .map(p => p.text).join('')
        // Never show/speak a leaked text tool call (it was either executed via
        // the fallback above or is plain noise).
        .replace(new RegExp(LEAKED_CALL_RE.source, 'g'), '')
        .trim();
      json({ text, clientActions, newContent: content });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/ai/summarize' && req.method === 'POST') {
    // Rolling conversation summary: fold older turns (that scrolled out of the
    // client's window) into a compact running summary the next /api/ai turn
    // injects as context. Provider-aware; best-effort — on any failure the
    // client keeps its raw history under the hard cap.
    try {
      const raw = await readBodyBuffer(req, 256 * 1024);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const provider = aiLocal.sanitizeProvider(body.provider);
      const apiKey = String(body.key || '').trim().slice(0, 200);
      const prev = String(body.prevSummary || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
      const turns = Array.isArray(body.messages) ? body.messages.slice(0, 60) : [];
      const uiLang = String(body.lang || '').toLowerCase().slice(0, 2);
      const LANG_NAMES = { it: 'Italian', en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese' };
      const langName = LANG_NAMES[uiLang] || 'English';
      // Flatten the turns to plain "Role: text" lines (text parts only — images
      // and audio are not carried in history anyway).
      const transcript = turns.map((m) => {
        if (!m || !Array.isArray(m.parts)) return '';
        const txt = m.parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join(' ').trim();
        return txt ? `${m.role === 'model' ? 'Assistant' : 'User'}: ${txt}` : '';
      }).filter(Boolean).join('\n').slice(0, 8000);
      if (!transcript) { json({ summary: prev }); return; }
      const sysText = `You maintain a running summary of a conversation between a user and Xenon (a dashboard assistant). Update the summary so it captures the durable context: what the user wants, decisions made, facts they shared, and any open thread — written in ${langName}. Be concise (at most ~8 short sentences). Output ONLY the updated summary, with no preamble.`;
      const userText = (prev ? `Current summary:\n${prev}\n\n` : '') + `New conversation turns to fold in:\n${transcript}\n\nUpdated summary:`;
      let summary = prev;
      if (provider === 'ollama') {
        const settings = await readHubSettings().catch(() => null);
        const baseUrl = aiLocal.sanitizeOllamaUrl(body.ollamaUrl || (settings && settings.ollamaUrl));
        const concreteModel = aiLocal.resolveModel(aiLocal.sanitizeModel(body.model), settings && settings.hardwareScan);
        const result = await aiLocal.localChat({
          baseUrl, model: concreteModel, geminiTools: [],
          history: [{ role: 'user', parts: [{ text: userText }] }],
          systemText: sysText,
          executeTool: async () => ({ fnResult: {}, clientActions: [] }),
        }).catch(() => null);
        if (result && result.text) summary = String(result.text).trim().slice(0, 2000);
      } else if (provider === 'openai' || provider === 'anthropic') {
        const settings = await readHubSettings().catch(() => null);
        const mod = provider === 'openai' ? aiOpenai : aiAnthropic;
        const provKey = provider === 'openai' ? (settings && settings.openaiApiKey) : (settings && settings.anthropicApiKey);
        const provModel = provider === 'openai' ? (settings && settings.openaiModel) : (settings && settings.anthropicModel);
        if (!provKey) { json({ summary: prev }); return; }
        const out = await mod.oneShot({ apiKey: provKey, model: provModel, systemText: sysText, userText, maxTokens: 400 }).catch(() => '');
        if (out) summary = String(out).trim().slice(0, 2000);
      } else {
        if (!apiKey) { json({ summary: prev }); return; }
        const out = await _geminiOneShot(apiKey, [{ text: userText }], sysText, 400).catch(() => '');
        if (out) summary = String(out).trim().slice(0, 2000);
      }
      json({ summary });
    } catch (e) { json({ error: e.message }); }

  } else if (reqPath === '/api/vitals/roast' && req.method === 'POST') {
    // Bit's opt-in AI roasts: ONE short in-character line generated by the
    // user's configured Xenon AI provider from real context (which vital died,
    // for how long, streak, gaming, time of day, now playing, weather). The
    // client hard-times-out and falls back to the offline phrase bank on ANY
    // failure or empty result, so this is best-effort by design. POST-only,
    // never a JSONP candidate; the Gemini key travels in the body exactly like
    // /api/ai/summarize (established pattern). Keys are never logged.
    try {
      // Server-side opt-in re-check (same spirit as /api/vitals/nag): a forged
      // loopback request can't burn the user's AI quota unless they actually
      // enabled Bit AND AI roasts in Settings.
      const vitalsCfg = _serverHubSettings && _serverHubSettings.vitals;
      const petCfg = (vitalsCfg && vitalsCfg.enabled !== false && vitalsCfg.pet) ? vitalsCfg.pet : null;
      if (!petCfg || petCfg.enabled !== true || petCfg.aiRoasts !== true) { json({ text: '' }); return; }
      const raw = await readBodyBuffer(req, 32 * 1024);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const provider = aiLocal.sanitizeProvider(body.provider);
      const apiKey = String(body.key || '').trim().slice(0, 200);
      // Every context string is length-bounded and stripped of control chars
      // before it goes anywhere near a prompt.
      const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
      const uiLang = clean(body.lang, 5).toLowerCase().slice(0, 2);
      const LANG_NAMES = { it: 'Italian', en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', ru: 'Russian', nl: 'Dutch' };
      const langName = LANG_NAMES[uiLang] || 'English';
      const tone = ['soft', 'spicy', 'savage'].includes(body.tone) ? body.tone : 'spicy';
      const TONE_DESC = {
        soft: 'a gentle, warm nudge',
        spicy: 'sarcastic and cheeky',
        savage: 'merciless and absurd, but never genuinely cruel',
      };
      const ctx = body.ctx && typeof body.ctx === 'object' ? body.ctx : {};
      const KIND_DESC = {
        zero: 'one of the meters just hit zero — roast the user into fixing it',
        nag: 'the meter is STILL at zero — nag again from a fresh angle',
        welcomeback: 'the user just finished a game session during which a meter died — congratulate and roast',
        return: 'the user just came back to the PC after being away — welcome them back with a wink',
      };
      const kindDesc = KIND_DESC[clean(ctx.kind, 20)] || KIND_DESC.nag;
      const facts = [];
      const vitalName = clean(ctx.vital, 40);
      if (vitalName) facts.push('neglected meter: ' + vitalName);
      const min = Math.max(0, Math.min(100000, Math.round(Number(ctx.min) || 0)));
      if (min > 0) facts.push('minutes in this state: ' + min);
      const streak = Math.max(0, Math.min(100000, Math.round(Number(ctx.streak) || 0)));
      if (streak > 1) facts.push('current self-care streak: ' + streak + ' days');
      if (ctx.gaming === true) facts.push('the user is gaming right now');
      const timeOfDay = clean(ctx.timeOfDay, 20);
      if (timeOfDay) facts.push('time of day: ' + timeOfDay);
      const media = clean(ctx.media, 80);
      if (media) facts.push('now playing: ' + media);
      const weather = clean(ctx.weather, 60);
      if (weather) facts.push('weather outside: ' + weather);
      const sysText = 'You are Bit, an 8-bit pixel guardian who lives on the user\'s PC dashboard and guards their self-care meters (hydration, energy, movement, eye rest, posture). '
        + `Write exactly ONE line in ${langName}, maximum 140 characters. No quotes, no emoji, no preamble, no explanations. `
        + `Tone: ${TONE_DESC[tone]}. Funny, like a friend teasing — never a bully. Situation: ${kindDesc}.`;
      const userText = 'Context:\n' + (facts.length ? facts.join('\n') : '(no extra context)') + '\n\nBit\'s one-liner:';
      let text = '';
      if (provider === 'ollama') {
        const settings = await readHubSettings().catch(() => null);
        const baseUrl = aiLocal.sanitizeOllamaUrl(body.ollamaUrl || (settings && settings.ollamaUrl));
        const concreteModel = aiLocal.resolveModel(aiLocal.sanitizeModel(body.model), settings && settings.hardwareScan);
        const result = await aiLocal.localChat({
          baseUrl, model: concreteModel, geminiTools: [],
          history: [{ role: 'user', parts: [{ text: userText }] }],
          systemText: sysText,
          executeTool: async () => ({ fnResult: {}, clientActions: [] }),
        }).catch(() => null);
        if (result && result.text) text = String(result.text);
      } else if (provider === 'openai' || provider === 'anthropic') {
        const settings = await readHubSettings().catch(() => null);
        const mod = provider === 'openai' ? aiOpenai : aiAnthropic;
        const provKey = provider === 'openai' ? (settings && settings.openaiApiKey) : (settings && settings.anthropicApiKey);
        const provModel = provider === 'openai' ? (settings && settings.openaiModel) : (settings && settings.anthropicModel);
        if (provKey) text = await mod.oneShot({ apiKey: provKey, model: provModel, systemText: sysText, userText, maxTokens: 100 }).catch(() => '');
      } else {
        if (apiKey) text = await _geminiOneShot(apiKey, [{ text: userText }], sysText, 100).catch(() => '');
      }
      json({ text: clean(text, 200) });
    } catch (e) { json({ error: e.message }); }

  } else if (reqPath === '/api/log' && req.method === 'POST') {
    try {
      const body = await readBodyBuffer(req, 4 * 1024);
      const { msg } = JSON.parse(body.toString('utf8') || '{}');
      if (typeof msg === 'string') process.stdout.write('[CLIENT] ' + msg + '\n');
      res.writeHead(204); res.end();
    } catch { res.writeHead(204); res.end(); }

  } else if (reqPath === '/api/screens' && req.method === 'GET') {
    try {
      const psScript = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.Bounds.X)|$($_.Bounds.Y)|$($_.Bounds.Width)|$($_.Bounds.Height)|$($_.Primary)|$($_.DeviceName)" }';
      const stdout = await new Promise((resolve, reject) =>
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript],
          { maxBuffer: 64 * 1024, windowsHide: true },
          (err, out) => err ? reject(err) : resolve(out)
        )
      );
      const screens = stdout.trim().split(/\r?\n/).filter(Boolean).map((line, i) => {
        const [x, y, w, h, primary, dev] = line.trim().split('|');
        const label = (dev || '').replace(/^\\\\.\\/, '').trim() || `DISPLAY${i + 1}`;
        return { index: i, x: parseInt(x) || 0, y: parseInt(y) || 0, width: parseInt(w) || 1920, height: parseInt(h) || 1080, primary: primary === 'True', name: label };
      });
      json({ screens });
    } catch {
      json({ screens: [{ index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true, name: 'DISPLAY1' }] });
    }

  } else if (reqPath === '/api/screenshot' && req.method === 'GET') {
    const tmpPath = path.join(os.tmpdir(), `xenon_ss_${Date.now()}.jpg`);
    try {
      const ffmpeg = getFfmpegPath();
      const px = urlObj.searchParams.get('x');
      const py = urlObj.searchParams.get('y');
      const pw = urlObj.searchParams.get('w');
      const ph = urlObj.searchParams.get('h');
      const ffmpegArgs = ['-y', '-f', 'gdigrab', '-framerate', '1'];
      if (px !== null && py !== null && pw !== null && ph !== null) {
        const w = parseInt(pw), h = parseInt(ph);
        if (w > 0 && h > 0) {
          ffmpegArgs.push('-offset_x', px, '-offset_y', py, '-video_size', `${w}x${h}`);
        }
      }
      // gdigrab -vframes 1 takes a single screenshot frame
      ffmpegArgs.push('-i', 'desktop', '-vframes', '1', '-q:v', '3', '-vf', 'scale=\'min(1920,iw)\':-2', tmpPath);
      await execFilePromise(ffmpeg, ffmpegArgs, { timeout: 15000 });
      const imgBuffer = await fs.promises.readFile(tmpPath);
      const base64 = imgBuffer.toString('base64');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ base64, mimeType: 'image/jpeg' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    } finally {
      fs.promises.unlink(tmpPath).catch(() => {});
    }

  } else if (reqPath === '/api/stt/start' && req.method === 'POST') {
    try {
      await readBody(req);
      await Promise.race([
        _sttDeviceWhenReady(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('STT device timeout')), 10000)),
      ]);
      if (!_sttUseWasapi && !_sttDshowDevice) throw new Error('No audio device available for recording');
      // A full-duplex Voce Live session already owns the mic (dshow can't share
      // the device) — refuse a one-shot recorder so it can't starve the live
      // capture's ffmpeg and tear the session down under the user.
      if (_liveActive) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'live_active' })); return;
      }
      // Prevent two concurrent STT sessions (e.g. two browser tabs receiving the same wake event)
      if (_sttPending.size > 0) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'already_recording' })); return;
      }
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const wavPath = path.join(os.tmpdir(), `xenon-stt-${id}.wav`);

      let resolveRecording, resolveSaved;
      const recordingStarted = new Promise(r => { resolveRecording = r; });
      const recordingSaved   = new Promise(r => { resolveSaved   = r; });

      // Release the wake-word listener before opening the mic (dshow cannot
      // share a device). Resolves when its capture child has actually exited —
      // immediately when the feature is off, so this adds no latency then.
      await wakeWord.suspend();
      const ffmpeg = getFfmpegPath();
      const inputArgs = _sttInputArgs();
      const silenceDb = _sttSilenceDb();
      const gain = _sttGain();
      // silencedetect runs on the RAW signal (so end-of-speech is judged before
      // the boost lifts the noise floor); volume then boosts the saved WAV so
      // the transcription clip is audible for a quiet hands-free mic.
      const ffmpegProc = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'info',
        ...inputArgs,
        '-af', `silencedetect=noise=${silenceDb.toFixed(1)}dB:d=0.55,volume=${gain}`,
        '-ar', '16000', '-ac', '1', '-acodec', 'pcm_s16le',
        '-y', wavPath,
      ], { windowsHide: true });

      ffmpegProc.stdin.setDefaultEncoding('utf8');
      ffmpegProc.stderr.setEncoding('utf8');

      let stderrAccum = '';
      let didStart = false;
      let silenceNotified = false;
      let sawSpeech = false;
      let _silenceDebounce = null; // fires stt_silence after a short wait when no speech yet
      ffmpegProc.stderr.on('data', d => {
        stderrAccum += d;
        if (!didStart && /Press \[q\] to stop/i.test(stderrAccum)) {
          didStart = true;
          resolveRecording();
        }
        // End-of-speech detection: stop the recorder as soon as the user goes quiet.
        // • silence_end  → audio resumed; the user is actively speaking (sawSpeech).
        // • silence_start → user paused. We ALWAYS wait a bit before deciding end-of-
        //   speech, otherwise a natural mid-sentence pause (e.g. between words or a
        //   breath) would cut the user off. silence_end during the wait cancels it.
        if (!silenceNotified) {
          if (/silence_end:/.test(d)) {
            sawSpeech = true;
            if (_silenceDebounce) { clearTimeout(_silenceDebounce); _silenceDebounce = null; }
          }
          if (/silence_start:/.test(d) && !_silenceDebounce) {
            const startMatch = d.match(/silence_start:\s*([\d.]+)/);
            const silenceStartAt = startMatch ? Number(startMatch[1]) : 0;
            if (Number.isFinite(silenceStartAt) && silenceStartAt > 0.35) sawSpeech = true;
            // Long grace after real speech: people pause mid-sentence to think,
            // and we MUST NOT cut them off. Short grace when no speech happened
            // yet (the user is just slow to start, no need to wait as long).
            const grace = sawSpeech ? STT_AFTER_SPEECH_SILENCE_GRACE_MS : STT_START_SILENCE_GRACE_MS;
            _silenceDebounce = setTimeout(() => {
              if (!silenceNotified) { silenceNotified = true; broadcastSSE('stt_silence', { id }); }
            }, grace);
          }
        }
      });
      ffmpegProc.on('exit', () => resolveSaved());
      ffmpegProc.on('error', e => {
        process.stdout.write('[STT] ffmpeg error: ' + e.message + '\n');
        if (!didStart) { didStart = true; resolveRecording(); }
        resolveSaved();
      });

      _sttPending.set(id, { ffmpegProc, wavPath, recordingStarted, resolveRecording, recordingSaved, resolveSaved, silenceDb, startedAt: Date.now() });

      try {
        await Promise.race([
          recordingStarted,
          new Promise((_, rej) => setTimeout(() => rej(new Error('ffmpeg did not start recording')), 6000)),
        ]);
      } catch (startErr) {
        // A failed start must not leak the pending slot: a stale entry keeps
        // every later start answering 409, keeps the wake word's isBusy() true
        // and leaves its listener suspended. Clean up, then rethrow for the 500.
        _sttPending.delete(id);
        try { ffmpegProc.kill(); } catch { /* never spawned / already gone */ }
        if (_sttPending.size === 0) wakeWord.resumeSoon();
        throw startErr;
      }
      process.stdout.write(`[STT] Recording id=${id} via=${_sttUseWasapi ? 'wasapi' : 'dshow'} silence=${silenceDb.toFixed(1)}dB gain=${gain}x\n`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/stt/stop' && req.method === 'POST') {
    try {
      const stopBody = JSON.parse(await readBody(req) || '{}');
      const id = String(stopBody.id || '').trim();
      const apiKey = String(stopBody.key || '').trim().slice(0, 200);
      const sttLang = String(stopBody.lang || 'en').toLowerCase().slice(0, 2);
      const sttProvider = aiLocal.sanitizeProvider(stopBody.provider);
      // mode 'audio' → return the raw recording so the caller can send it straight
      // to the chat model (transcribe + answer in one call). Default → transcribe here.
      // mode 'test'  → mic self-test: report the device/level we captured and whether
      // it passed the speech gate, with no transcription and no API key needed.
      const audioMode = stopBody.mode === 'audio';
      const testMode  = stopBody.mode === 'test';
      const rec = _sttPending.get(id);
      if (!rec) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' })); return;
      }
      // Stop ffmpeg gracefully — send 'q' then close stdin (EOF)
      try { rec.ffmpegProc.stdin.write('q'); rec.ffmpegProc.stdin.end(); } catch {}
      await Promise.race([rec.recordingSaved, new Promise(r => setTimeout(r, 6000))]);
      _sttPending.delete(id);
      // Mic released → let the wake-word listener come back (after a settle
      // delay; no-op unless the feature is enabled and wanted).
      if (_sttPending.size === 0) wakeWord.resumeSoon();
      let wavData = null;
      try { wavData = await fs.promises.readFile(rec.wavPath); } catch {}
      fs.promises.unlink(rec.wavPath).catch(() => {});
      // Whole-clip RMS — used both for logging and as a speech gate below.
      let clipStats = { rms: 0, peak: 0 };
      if (wavData && wavData.length > 44) {
        clipStats = _pcmRmsStats(wavData.slice(44), 16000, 80);
        process.stdout.write(`[STT] Stopped id=${id} wavSize=${wavData.length} rms=${clipStats.rms.toFixed(1)} peak=${clipStats.peak.toFixed(1)}\n`);
      } else {
        process.stdout.write(`[STT] Stopped id=${id} wavSize=${wavData ? wavData.length : 0}\n`);
      }
      // Mic self-test: surface exactly which device was captured and how loud it
      // was, so a user (or a bug report screenshot) can tell whether the voice
      // capture path actually hears them — independent of the browser mic meter,
      // which reads a different device than this server-side recorder.
      if (testMode) {
        const heard = !!(wavData && wavData.length > 44 && clipStats.rms > 0 && _sttLooksLikeSpeech(clipStats));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          test: true,
          heard,
          via: _sttUseWasapi ? 'wasapi' : 'dshow',
          device: _sttUseWasapi ? (cachedMicLabel || 'Default (WASAPI)') : (_sttDshowDevice || 'unknown'),
          db: Math.round(_dbFromRms(clipStats.rms)),
          gain: _sttGain(),
        })); return;
      }
      if (!wavData || wavData.length < 100) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(audioMode ? { audio: '', silent: true } : { text: '' })); return;
      }
      if (clipStats.rms > 0 && !_sttLooksLikeSpeech(clipStats)) {
        process.stdout.write(`[STT] Below speech floor (rms=${clipStats.rms.toFixed(1)}, peak=${clipStats.peak.toFixed(1)}) → empty\n`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(audioMode ? { audio: '', silent: true } : { text: '' })); return;
      }
      if (audioMode) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ audio: wavData.toString('base64'), mimeType: 'audio/wav' })); return;
      }
      let sttText;
      if (sttProvider === 'ollama') {
        process.stdout.write(`[STT] Local whisper transcribe lang=${sttLang}\n`);
        try {
          sttText = await aiLocal.localStt(wavData, sttLang, __dirname);
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: '', error: e.message })); return;
        }
      } else {
        if (!apiKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing_key' })); return;
        }
        process.stdout.write(`[STT] Transcribing lang=${sttLang}\n`);
        sttText = await _transcribeAudio(wavData.toString('base64'), 'audio/wav', apiKey, sttLang);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: sttText }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/ai/models' && req.method === 'GET') {
    // Live model list for the picker (ChatGPT / Claude), fetched from each
    // provider's own models API with the server-only key so it always reflects
    // what the provider currently offers. Degrades to an empty list (never an
    // error page) when there's no key or the call fails.
    try {
      const prov = aiLocal.sanitizeProvider(urlObj.searchParams.get('provider'));
      const settings = await readHubSettings().catch(() => null);
      let models = [];
      if (prov === 'openai') {
        const key = String((settings && settings.openaiApiKey) || '').trim();
        if (key) models = await aiOpenai.listModels({ apiKey: key }).catch(() => []);
      } else if (prov === 'anthropic') {
        const key = String((settings && settings.anthropicApiKey) || '').trim();
        if (key) models = await aiAnthropic.listModels({ apiKey: key }).catch(() => []);
      }
      json({ models });
    } catch (e) {
      json({ models: [], error: e.message });
    }

  } else if (reqPath === '/api/transcribe' && req.method === 'POST') {
    try {
      const tRaw = await readBodyBuffer(req, 30 * 1024 * 1024);
      const tBody = JSON.parse(tRaw.toString('utf8') || '{}');
      const apiKey = String(tBody.key || '').trim().slice(0, 200);
      const tProvider = aiLocal.sanitizeProvider(tBody.provider);
      const audioB64 = typeof tBody.audio === 'string' ? tBody.audio.slice(0, 20 * 1024 * 1024) : '';
      const rawMime = typeof tBody.mimeType === 'string' ? tBody.mimeType : 'audio/webm';
      const ALLOWED_AUDIO = new Set(['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/mp4', 'audio/wav']);
      const safeMime = ALLOWED_AUDIO.has(rawMime) ? rawMime : 'audio/webm';
      const safeLang = String(tBody.lang || 'auto').toLowerCase().slice(0, 5).replace(/[^a-z-]/g, '') || 'auto';

      // Non-Gemini STT: decode → transcode to 16kHz mono WAV via ffmpeg, then
      // transcribe. Ollama and Claude (no speech API) use local whisper.cpp;
      // ChatGPT uses OpenAI Whisper with its server-only key. No Gemini key
      // required. Errors degrade gracefully (HTTP 200, empty text).
      if (tProvider === 'ollama' || tProvider === 'anthropic' || tProvider === 'openai') {
        if (!audioB64) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing_params' })); return;
        }
        let openaiKey = '';
        if (tProvider === 'openai') {
          const s = await readHubSettings().catch(() => null);
          openaiKey = String((s && s.openaiApiKey) || '').trim();
          if (!openaiKey) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: '', error: 'no_key' })); return; }
        }
        try {
          const inBuf = Buffer.from(audioB64, 'base64');
          const ffmpeg = getFfmpegPath();
          const wavBuffer = await new Promise((resolve, reject) => {
            const ff = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'wav', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', 'pipe:1'], { windowsHide: true });
            const out = [];
            const errBuf = [];
            ff.stdout.on('data', c => out.push(c));
            ff.stderr.on('data', c => errBuf.push(c));
            ff.on('error', reject);
            ff.on('close', code => {
              if (code === 0 && out.length) resolve(Buffer.concat(out));
              else reject(new Error('ffmpeg wav transcode failed: ' + Buffer.concat(errBuf).toString().slice(0, 200)));
            });
            ff.stdin.on('error', () => {}); // ignore EPIPE if ffmpeg exits early
            ff.stdin.write(inBuf);
            ff.stdin.end();
          });
          const text = tProvider === 'openai'
            ? await aiOpenai.stt({ apiKey: openaiKey, wavBuffer, lang: safeLang })
            : await aiLocal.localStt(wavBuffer, safeLang, __dirname);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text })); return;
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: '', error: e.message })); return;
        }
      }

      if (!apiKey || !audioB64) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_params' })); return;
      }
      const tPayload = JSON.stringify({
        contents: [{ parts: [
          { text: 'Transcribe this audio exactly as spoken. Output only the transcribed text, nothing else — no explanations, no punctuation beyond what was said. The user may mix Italian commands with English proper nouns (app names, brand names): always output them as separate words with a space between them (e.g. "apri Steam", not "apristim"; "apri Spotify", not "aprispot"; "apri Discord", not "apridiscord"). The recording may begin with a short notification chime or activation tone — ignore it completely and transcribe only human speech that follows. If the audio contains only silence, background noise, breathing, chimes, or music with no clear human speech, output exactly an empty string. Do NOT guess, invent, or output placeholder text.' },
          { inline_data: { mime_type: safeMime, data: audioB64 } },
        ] }],
        generationConfig: { temperature: 0, maxOutputTokens: 256, candidateCount: 1 },
      });
      const tText = await new Promise((resolve, reject) => {
        const geminiReq = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/${AI_MODELS.chat}:generateContent?key=${encodeURIComponent(apiKey)}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(tPayload), 'User-Agent': 'Xenon/2.0' },
        }, (gRes) => {
          let d = '';
          gRes.on('data', c => { d += c; });
          gRes.on('end', () => {
            try {
              const parsed = JSON.parse(d);
              resolve(((parsed?.candidates?.[0]?.content?.parts) || []).filter(p => p.text && !p.thought).map(p => p.text).join('').trim() || '');
            } catch { reject(new Error('invalid JSON')); }
          });
        });
        geminiReq.on('error', reject);
        geminiReq.setTimeout(15000, () => { geminiReq.destroy(); reject(new Error('timeout')); });
        geminiReq.write(tPayload);
        geminiReq.end();
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: tText }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/tts' && req.method === 'POST') {
    try {
      const ttsRaw = await readBodyBuffer(req, 64 * 1024);
      const ttsBody = JSON.parse(ttsRaw.toString('utf8') || '{}');
      const apiKey = String(ttsBody.key || '').trim().slice(0, 200);
      const rawText = String(ttsBody.text || '').trim().slice(0, 1000);
      // Default to a male Gemini voice; the client may override via `voice`.
      const voice = String(ttsBody.voice || 'Charon').replace(/[^A-Za-z]/g, '').slice(0, 30) || 'Charon';
      const ttsProvider = aiLocal.sanitizeProvider(ttsBody.provider);
      const ttsLang = String(ttsBody.lang || 'en').slice(0, 5);
      if (!rawText) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_params' })); return;
      }
      // Non-Gemini providers return a ready WAV. Ollama and Claude use the free
      // local Edge neural TTS; ChatGPT uses OpenAI TTS (server-only key).
      if (ttsProvider === 'ollama' || ttsProvider === 'anthropic' || ttsProvider === 'openai') {
        try {
          let wavBuf;
          if (ttsProvider === 'openai') {
            const s = await readHubSettings().catch(() => null);
            const oKey = String((s && s.openaiApiKey) || '').trim();
            if (!oKey) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'missing_key' })); return; }
            wavBuf = await aiOpenai.tts({ apiKey: oKey, text: rawText });
          } else {
            wavBuf = await aiLocal.localTts(rawText, ttsLang, getFfmpegPath());
          }
          if (!wavBuf || !wavBuf.length) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no_audio' })); return; }
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(wavBuf.length), 'Cache-Control': 'no-store' });
          res.end(wavBuf); return;
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message })); return;
        }
      }
      if (!apiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_params' })); return;
      }
      const ttsPayload = JSON.stringify({
        contents: [{ parts: [{ text: rawText }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      });
      process.stdout.write(`[TTS] request voice=${voice} chars=${rawText.length}\n`);
      const _ttsStart = Date.now();
      const inlineData = await new Promise((resolve, reject) => {
        const ttsReq = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/${AI_MODELS.tts}:generateContent?key=${encodeURIComponent(apiKey)}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ttsPayload), 'User-Agent': 'Xenon/2.0' },
        }, (ttsRes) => {
          let d = '';
          ttsRes.on('data', c => { d += c; });
          ttsRes.on('end', () => {
            process.stdout.write(`[TTS] Gemini HTTP ${ttsRes.statusCode} in ${Date.now() - _ttsStart}ms\n`);
            try {
              const parsed = JSON.parse(d);
              if (parsed.error) {
                process.stdout.write(`[TTS] Gemini error: ${parsed.error.message || JSON.stringify(parsed.error).slice(0, 160)}\n`);
                return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
              }
              const part = parsed?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
              if (!part || !part.data) return reject(new Error('no audio data in TTS response'));
              resolve(part);
            } catch (e) { reject(e); }
          });
        });
        ttsReq.on('error', reject);
        ttsReq.setTimeout(60000, () => { ttsReq.destroy(); reject(new Error('TTS timeout')); });
        ttsReq.write(ttsPayload);
        ttsReq.end();
      });
      const pcmBytes = Buffer.from(inlineData.data, 'base64');
      const rateMatch = String(inlineData.mimeType || '').match(/rate=(\d+)/);
      const sampleRate = rateMatch ? parseInt(rateMatch[1]) : 24000;
      const wavBuf = pcmToWav(pcmBytes, sampleRate);
      process.stdout.write(`[TTS] OK wav=${wavBuf.length} bytes rate=${sampleRate}\n`);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(wavBuf.length), 'Cache-Control': 'no-store' });
      res.end(wavBuf);
    } catch (e) {
      process.stdout.write(`[TTS] FAIL ${e.message}\n`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/speak' && req.method === 'POST') {
    // Server-side voice output (Windows SAPI) — instant and focus-independent.
    // Resolves when speech finishes so the client knows when to re-open listening.
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const text = String(b.text || '').slice(0, 2000);
      const langp = String(b.lang || 'en').slice(0, 5);
      const key = String(b.key || '').trim().slice(0, 200);
      if (!text) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'missing_text' })); return; }
      const speakProvider = aiLocal.sanitizeProvider(b.provider);
      await speakOnServer(text, langp, key, speakProvider);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/speak/stop' && req.method === 'POST') {
    try { await readBody(req); } catch {}
    stopServerSpeak();
    res.writeHead(204); res.end();

  } else if (reqPath === '/api/ai-local/scan' && req.method === 'GET') {
    try {
      const scan = await aiLocal.scanHardware();
      // Persist into settings so the client and resolveModel can use it.
      // Serialized with every other settings writer (see withHubSettingsLock).
      await withHubSettingsLock(async () => {
        const current = await readHubSettings().catch(() => null);
        if (current) { current.hardwareScan = scan; _serverHubSettings = await writeHubSettings(current).catch(() => _serverHubSettings); }
      });
      json({ scan });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/ai-local/status' && req.method === 'GET') {
    try {
      const settings = await readHubSettings().catch(() => null);
      const baseUrl = aiLocal.sanitizeOllamaUrl(settings && settings.ollamaUrl);
      const status = await aiLocal.localStatus(baseUrl, __dirname);
      json({ status });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/ai-local/models' && req.method === 'GET') {
    try {
      const settings = await readHubSettings().catch(() => null);
      const baseUrl = aiLocal.sanitizeOllamaUrl(settings && settings.ollamaUrl);
      const models = await aiLocal.listOllamaModels(baseUrl);
      json({ models });
    } catch {
      // Graceful: an empty list keeps the UI usable even if Ollama is offline.
      json({ models: [] });
    }

  } else if (reqPath === '/api/ai-local/pull' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const model = aiLocal.sanitizeModel(body.model);
      const settings = await readHubSettings().catch(() => null);
      // Resolve 'auto' exactly as the chat path does (resolveModel + hardwareScan)
      // so the model we pull is the same one the chat will request — otherwise
      // 'auto' could download qwen2.5:3b while chat asks for qwen2.5:7b → 404.
      // Use the persisted scan, or probe now if the user never ran a manual scan,
      // so the safety gate below always has real hardware figures to reason about.
      let scan = settings && settings.hardwareScan;
      if (!scan || typeof scan !== 'object') { scan = await aiLocal.scanHardware().catch(() => null); }
      const concrete = aiLocal.resolveModel(model, scan);
      // SAFETY GATE — refuse the download (never pull) when the hardware can't run
      // the model. Incompatible machines are blocked outright; otherwise the model
      // must fit either VRAM or RAM. This keeps a weak PC from downloading gigabytes
      // only to crash the GPU on the first inference.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      if (scan && scan.tier === 'incompatible') {
        res.write(`data: ${JSON.stringify({ error: 'Il tuo hardware non è adatto all’AI locale (serve almeno ~8 GB di RAM o ~4 GB di VRAM). Non è stato scaricato nulla: usa Xenon AI in cloud (Gemini).', done: true })}\n\n`);
        return res.end();
      }
      const safety = aiLocal.modelSafety(concrete, scan);
      if (!safety.ok) {
        res.write(`data: ${JSON.stringify({ error: safety.reason, done: true })}\n\n`);
        return res.end();
      }
      const baseUrl = aiLocal.sanitizeOllamaUrl(settings && settings.ollamaUrl);
      await aiLocal.pullModel(baseUrl, concrete, (p) => {
        res.write(`data: ${JSON.stringify(p)}\n\n`);
      });
      res.write(`data: ${JSON.stringify({ status: 'success', done: true })}\n\n`);
      res.end();
    } catch (e) {
      try { res.write(`data: ${JSON.stringify({ error: e.message, done: true })}\n\n`); res.end(); }
      catch { res.writeHead(500); res.end(); }
    }

  } else if (reqPath === '/api/ai-local/ollama-start' && req.method === 'POST') {
    try {
      await readBody(req);
      const settings = await readHubSettings().catch(() => null);
      const baseUrl = aiLocal.sanitizeOllamaUrl(settings && settings.ollamaUrl);
      const result = await aiLocal.startOllama(baseUrl);
      json(result);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }

  } else if (reqPath === '/api/ai-local/ollama-autostart' && req.method === 'GET') {
    try {
      const enabled = await aiLocal.getOllamaAutostart();
      json({ enabled });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/ai-local/ollama-autostart' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const result = await aiLocal.setOllamaAutostart(body.enabled === true);
      json(result);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }

  } else if (reqPath === '/api/ai-local/whisper-install' && req.method === 'POST') {
    try {
      await readBody(req);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      await aiLocal.installWhisper(__dirname, (p) => {
        res.write(`data: ${JSON.stringify(p)}\n\n`);
      });
      res.write(`data: ${JSON.stringify({ status: 'success', done: true })}\n\n`);
      res.end();
      // Whisper just became available → drop the negative probe cache and let
      // the wake word start if enabled.
      _whisperProbedAt = 0;
      refreshWakeWordWatch();
    } catch (e) {
      try { res.write(`data: ${JSON.stringify({ error: e.message, done: true })}\n\n`); res.end(); }
      catch { res.writeHead(500); res.end(); }
    }

  } else if (reqPath === '/api/wake/status' && req.method === 'GET') {
    // Settings → Xenon AI wake-word row: is the toggle on, is whisper installed,
    // is the listener actually running right now.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      enabled: !!(_serverHubSettings && _serverHubSettings.wakeWord && _serverHubSettings.wakeWord.enabled),
      whisper: _whisperReady(),
      listening: wakeWord.isActive(),
    }));

  } else if (reqPath === '/api/chime' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      playChimeOnServer(b.kind === 'close' ? 'close' : 'wake');
    } catch {}
    res.writeHead(204); res.end();

  } else if (reqPath === '/api/volume/duck' && req.method === 'POST') {
    // Lower system volume before TTS speaks so Xenon's voice is foregrounded.
    try {
      await readBody(req);
      if (!_duckActive && cachedSpeakerId) {
        _duckSavedVolume = _lastSpeakerVolume;
        _duckActive = true;
        execFile(SVV, ['/SetVolume', cachedSpeakerId, '20'], () => {});
      }
      res.writeHead(204); res.end();
    } catch { res.writeHead(204); res.end(); }

  } else if (reqPath === '/api/volume/restore' && req.method === 'POST') {
    try {
      await readBody(req);
      if (_duckActive && cachedSpeakerId) {
        const vol = _duckSavedVolume != null ? _duckSavedVolume : 70;
        _duckActive = false;
        _duckSavedVolume = null;
        execFile(SVV, ['/SetVolume', cachedSpeakerId, String(vol)], () => {});
      }
      res.writeHead(204); res.end();
    } catch { res.writeHead(204); res.end(); }

  } else if (reqPath === '/background' && req.method === 'POST') {
    try {
      const body = await readBodyBuffer(req, BACKGROUND_MAX_BYTES);
      const file = parseMultipartBackground(req, body);
      const extFromName = path.extname(file.originalName).toLowerCase();
      const ext = BACKGROUND_MIME_BY_EXT.has(extFromName) ? extFromName : BACKGROUND_EXT_BY_MIME.get(file.contentType);
      if (!ext || !BACKGROUND_MIME_BY_EXT.has(ext)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported file type' }));
        return;
      }
      const expectedType = BACKGROUND_MIME_BY_EXT.get(ext);
      if (file.contentType && file.contentType !== 'application/octet-stream' && file.contentType !== expectedType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File type mismatch' }));
        return;
      }
      await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
      const safeName = `background-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
      const safePath = path.join(UPLOADS_DIR, safeName);
      await fs.promises.writeFile(safePath, file.data);

      let response = { ok: true, url: `/uploads/${safeName}`, name: file.originalName, type: expectedType, size: file.data.length, conversion: 'not-needed' };
      if (expectedType === 'video/mp4') {
        const webmName = safeName.replace(/\.mp4$/i, '.webm');
        const webmPath = path.join(UPLOADS_DIR, webmName);
        try {
          const webmStat = await transcodeMp4BackgroundToWebm(safePath, webmPath);
          await fs.promises.unlink(safePath).catch(() => {});
          response = {
            ok: true,
            url: `/uploads/${webmName}`,
            name: `${path.basename(file.originalName, path.extname(file.originalName))}.webm`,
            type: 'video/webm',
            size: webmStat.size,
            originalName: file.originalName,
            originalType: expectedType,
            converted: true,
            conversion: 'webm-vp8',
          };
          cleanupOldBackgrounds(webmName);
        } catch (conversionError) {
          await fs.promises.unlink(webmPath).catch(() => {});
          response = {
            ...response,
            conversion: isFfmpegMissing(conversionError) ? 'ffmpeg-missing' : 'failed',
          };
          console.warn(`Background MP4 conversion skipped: ${conversionError.message}`);
          cleanupOldBackgrounds(safeName);
        }
      } else {
        cleanupOldBackgrounds(safeName);
      }

      json(response);
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }

  } else if (reqPath === '/font' && req.method === 'POST') {
    try {
      const body = await readBodyBuffer(req, FONT_MAX_BYTES);
      const file = parseMultipartBackground(req, body, 'font');
      // Fonts are validated by EXTENSION (the served MIME + how the browser loads
      // them derive from it). Content-Type is only a soft hint — browsers report
      // fonts inconsistently (font/woff2, application/octet-stream, empty) — so it
      // never rejects on its own; the extension allowlist + server-generated name
      // are the real controls, exactly like the durable-upload invariant.
      const extFromName = path.extname(file.originalName).toLowerCase();
      const ext = FONT_MIME_BY_EXT.has(extFromName) ? extFromName : FONT_EXT_BY_MIME.get(file.contentType);
      if (!ext || !FONT_MIME_BY_EXT.has(ext)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported file type' }));
        return;
      }
      await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
      const safeName = `font-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
      await fs.promises.writeFile(path.join(UPLOADS_DIR, safeName), file.data);
      cleanupOldFonts(safeName);
      json({ ok: true, url: `/uploads/${safeName}`, name: file.originalName, size: file.data.length });
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }

  } else if (req.method === 'DELETE' && reqPath.startsWith('/font/')) {
    // Imported-theme cleanup. Only a generated font filename inside UPLOADS_DIR
    // is accepted; arbitrary uploads and paths remain unreachable.
    try {
      const name = decodeURIComponent(reqPath.slice('/font/'.length));
      if (!/^[A-Za-z0-9._-]+\.(?:woff2?|ttf|otf)$/i.test(name)) { res.writeHead(400); res.end(); return; }
      const abs = path.join(UPLOADS_DIR, name);
      if (!abs.startsWith(UPLOADS_DIR + path.sep)) { res.writeHead(400); res.end(); return; }
      await fs.promises.rm(abs, { force: true });
      json({ ok: true });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/icon-pack' && req.method === 'POST') {
    // Install a Deck icon pack (the 'icons' preset kind). Reached only from the
    // import preview's Apply step. All validation is fail-closed in
    // icon-packs.js (SVG reject-list, PNG magic bytes, id charsets, size caps);
    // files land under server-derived names via a temp-dir + rename install.
    try {
      const body = await readBodyBuffer(req, ICON_PACK_BODY_MAX);
      let payload = null;
      try { payload = JSON.parse(body.toString('utf8')); } catch { payload = null; }
      const result = await iconPackStore.install(payload);
      if (!result.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      json(result);
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }

  } else if (reqPath === '/icon-packs' && req.method === 'GET') {
    // Installed icon-pack manifests (no file data) — feeds the Deck key icon
    // picker's pack sections.
    try { json({ ok: true, packs: await iconPackStore.list() }); } catch (e) { err500(e.message); }

  } else if (req.method === 'GET' && reqPath.startsWith('/icon-pack/')) {
    // Serve one pack icon (/icon-pack/<packId>/<file>). Both segments are
    // regex-validated + prefix-asserted in icon-packs.js. The deny-all CSP +
    // nosniff keep an SVG inert even opened top-level — defense-in-depth on top
    // of the install-time reject-list.
    try {
      const parts = reqPath.slice('/icon-pack/'.length).split('/');
      const hit = parts.length === 2
        ? iconPackStore.resolve(decodeURIComponent(parts[0]), decodeURIComponent(parts[1]))
        : null;
      if (!hit) { res.writeHead(404); res.end(); return; }
      const data = await fs.promises.readFile(hit.abs);
      res.writeHead(200, {
        'Content-Type': hit.mime,
        'Content-Security-Policy': "default-src 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch { res.writeHead(404); res.end(); }

  } else if (req.method === 'DELETE' && reqPath.startsWith('/icon-pack/')) {
    // Uninstall a pack (Installed content cleanup). Id is regex-gated in
    // icon-packs.js; keys that embedded a pack icon keep their copy.
    try {
      const id = decodeURIComponent(reqPath.slice('/icon-pack/'.length));
      const ok = await iconPackStore.remove(id);
      if (!ok) { res.writeHead(400); res.end(); return; }
      json({ ok: true });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/sound-pack' && req.method === 'POST') {
    // Install a soundboard pack (the 'sounds' preset kind). Reached only from
    // the import preview's Apply step. Validation is fail-closed in
    // sound-packs.js (per-clip magic bytes, id charsets, size caps); clips land
    // under DETERMINISTIC server-derived names (packs/<id>/<clip>.<ext>) so
    // shared Deck profiles can reference them across machines.
    try {
      const body = await readBodyBuffer(req, SOUND_PACK_BODY_MAX);
      let payload = null;
      try { payload = JSON.parse(body.toString('utf8')); } catch { payload = null; }
      const result = await soundPackStore.install(payload);
      if (!result.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      json(result);
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }

  } else if (reqPath === '/deck/sound-packs' && req.method === 'GET') {
    // Installed soundboard-pack manifests (clip ids/labels + pack-relative
    // paths, no audio data) — feeds the editor's sound picker. Additive: the
    // loose-upload library keeps its own GET /deck/sounds contract untouched.
    try { json({ ok: true, packs: await soundPackStore.list() }); } catch (e) { err500(e.message); }

  } else if (req.method === 'DELETE' && reqPath.startsWith('/sound-pack/')) {
    // Uninstall a pack (Installed content cleanup). Deck keys referencing its
    // clips degrade to a no-op flash — same as any missing local file.
    try {
      const id = decodeURIComponent(reqPath.slice('/sound-pack/'.length));
      const ok = await soundPackStore.remove(id);
      if (!ok) { res.writeHead(400); res.end(); return; }
      json({ ok: true });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/tile-asset' && req.method === 'POST') {
    // Manual per-tile decoration upload. Mirrors /background but keeps every file
    // (multiple tiles → multiple pictures); a `tileasset-*` name is server-generated
    // and orphans are reclaimed by cleanupUnreferencedTileAssets() on layout save.
    try {
      const body = await readBodyBuffer(req, TILE_ASSET_MAX_BYTES);
      const file = parseMultipartBackground(req, body, 'asset');
      const extFromName = path.extname(file.originalName).toLowerCase();
      const ext = TILE_ASSET_MIME_BY_EXT.has(extFromName) ? extFromName : TILE_ASSET_EXT_BY_MIME.get(file.contentType);
      if (!ext || !TILE_ASSET_MIME_BY_EXT.has(ext)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported file type' }));
        return;
      }
      const expectedType = TILE_ASSET_MIME_BY_EXT.get(ext);
      if (file.contentType && file.contentType !== 'application/octet-stream' && file.contentType !== expectedType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File type mismatch' }));
        return;
      }
      await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
      const safeName = `tileasset-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
      await fs.promises.writeFile(path.join(UPLOADS_DIR, safeName), file.data);
      json({ ok: true, url: `/uploads/${safeName}`, name: file.originalName, type: expectedType, size: file.data.length });
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }

  } else if (req.method === 'GET' && reqPath.startsWith('/uploads/')) {
    try {
      const name = decodeURIComponent(reqPath.slice('/uploads/'.length));
      if (!/^[A-Za-z0-9._-]+$/.test(name)) { res.writeHead(403); res.end('Forbidden'); return; }
      const abs = path.join(UPLOADS_DIR, name);
      const ext = path.extname(name).toLowerCase();
      const mime = BACKGROUND_MIME_BY_EXT.get(ext) || FONT_MIME_BY_EXT.get(ext);
      if (!mime) { res.writeHead(404); res.end(); return; }
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) { res.writeHead(404); res.end(); return; }

      const baseHeaders = {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable',
      };
      const range = req.headers.range;

      if (range) {
        const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
        if (!match) {
          res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }

        const suffixLength = match[1] === '' ? Number(match[2]) : null;
        const start = suffixLength !== null ? Math.max(0, stat.size - suffixLength) : Number(match[1]);
        const end = match[2] === '' || suffixLength !== null ? stat.size - 1 : Number(match[2]);

        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= stat.size) {
          res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }

        res.writeHead(206, {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': String(end - start + 1),
        });
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, { ...baseHeaders, 'Content-Length': String(stat.size) });
      fs.createReadStream(abs).pipe(res);
    } catch (e) {
      if (e.code === 'ENOENT') { res.writeHead(404); res.end(); }
      else err500(e.message);
    }

  } else if (req.method === 'GET' && /^\/(styles|components|js|vendor|public|shared|assets)(\/|$)/.test(reqPath)) {
    // Static asset handler for refactored CSS/JS files, vendored libs (GridStack),
    // bundled images under public/, and the shared @xenon/core modules exposed via
    // the server/shared junction. Normalise to an absolute path and reject any
    // traversal outside __dirname (the junction target is our own packages/core,
    // and path.normalize is purely lexical so the guard still holds).
    const rel = reqPath.replace(/^\//, '');
    const abs = path.normalize(path.join(__dirname, rel));
    if (!abs.startsWith(path.join(__dirname, path.sep)) && abs !== __dirname) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const ext = path.extname(abs).toLowerCase();
    const STATIC_MIME = {
      '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif',
    };
    const mime = STATIC_MIME[ext] || 'application/octet-stream';
    if (ext === '.css' || ext === '.js') {
      // CSS/JS: revalidate on every load (no-cache) but skip the transfer when the
      // file is unchanged. The ETag is derived from size+mtime, so a local edit
      // produces a new tag and shows on refresh — the 304 only fires byte-identical.
      fs.promises.stat(abs).then(stat => {
        const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { 'Cache-Control': 'no-cache', 'ETag': etag }); res.end(); return;
        }
        return fs.promises.readFile(abs).then(data => {
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'ETag': etag });
          res.end(data);
        });
      }).catch(e => { if (e.code === 'ENOENT') { res.writeHead(404); res.end(); } else err500(e.message); });
    } else {
      // Images/static assets: cache for a day (effectively immutable filenames).
      fs.promises.readFile(abs)
        .then(data => { res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' }); res.end(data); })
        .catch(e => { if (e.code === 'ENOENT') { res.writeHead(404); res.end(); } else err500(e.message); });
    }

  // ── Twitch live integration (OAuth device flow) ──────────────────────────
  // Responses never include tokens — only { connected, login, configured } or the
  // device-flow code/URL the user authorises on their phone.
  } else if (reqPath === '/stream/twitch/status' && req.method === 'GET') {
    try { json(await streamTwitch.status()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/twitch/login' && req.method === 'POST') {
    try { await readBody(req); json(await streamTwitch.startDeviceLogin()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/twitch/login/poll' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await streamTwitch.pollDeviceToken(body.deviceCode));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/twitch/logout' && req.method === 'POST') {
    try { await readBody(req); json(await streamTwitch.logout()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/twitch/stream' && req.method === 'GET') {
    // Live status for the dashboard tile (viewer count / live-offline). Cheap
    // Helix call; the client polls only while the tile is visible.
    try { json(await streamTwitch.streamStatus()); }
    catch (e) { err500(e.message); }

  // ── YouTube live integration (Google OAuth device flow) ──────────────────
  } else if (reqPath === '/stream/youtube/status' && req.method === 'GET') {
    try { json(await streamYouTube.status()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/youtube/login' && req.method === 'POST') {
    try { await readBody(req); json(await streamYouTube.startDeviceLogin()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/youtube/login/poll' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await streamYouTube.pollDeviceToken(body.deviceCode));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/youtube/logout' && req.method === 'POST') {
    try { await readBody(req); json(await streamYouTube.logout()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/youtube/broadcast' && req.method === 'GET') {
    // Live broadcast status + viewer count for the YouTube widget. Quota-aware:
    // the client polls only while the tile is visible.
    try { json(await streamYouTube.broadcastStatus()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/youtube/title' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await streamYouTube.updateBroadcastTitle(body.title));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/config' && req.method === 'POST') {
    // Save the streaming app credentials pasted in Settings → Streaming (so the
    // user never edits stream-config.json by hand) and re-create the providers.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      await saveStreamConfig(body);
      json({ ok: true });
    } catch (e) { err500(e.message); }

  // ── Discord voice integration (local RPC/IPC — needs the Discord desktop app) ─
  } else if (reqPath === '/stream/discord/status' && req.method === 'GET') {
    try { json(await discordRpc.status()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/discord/login' && req.method === 'POST') {
    // Blocks until the user approves the consent dialog in the Discord client (or
    // it times out) — a single round-trip, unlike the device-code providers. The
    // watch is torn down BEFORE login, not after: Discord may serve only one
    // concurrent RPC client, so a live watch holding the pipe made the login
    // socket fail with a misleading "Discord isn't running". refreshDiscordWatch
    // re-arms cleanly on the fresh token afterwards.
    try {
      await readBody(req);
      if (discordStopWatch) { discordStopWatch(); discordStopWatch = null; }
      const r = await discordRpc.login();
      refreshDiscordWatch();
      json(r);
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/discord/logout' && req.method === 'POST') {
    // Watch down FIRST: logout's close() would otherwise schedule a reconnect
    // racing the revoke, and the dying watch held the (possibly single) pipe.
    try {
      await readBody(req);
      if (discordStopWatch) { discordStopWatch(); discordStopWatch = null; }
      const r = await discordRpc.logout();
      discordNotifs = [];
      refreshDiscordWatch();
      json(r);
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/discord/channels' && req.method === 'GET') {
    // Voice channels across the user's guilds, for the Deck editor's join picker
    // and the dashboard widget's channel list. Returns {ok:false} (not an error)
    // when Discord is offline so callers fall back to a typed channel-id field.
    try { json({ ok: true, channels: await discordRpc.listVoiceChannels() }); }
    catch (e) { json({ ok: false, channels: [], error: String((e && e.message) || e) }); }

  } else if (reqPath === '/stream/discord/sounds' && req.method === 'GET') {
    // The user's soundboard sounds (guild + built-in), for the Deck editor's
    // soundboard picker. Client-safe (id + guild + name); {ok:false} with an empty
    // list when Discord is offline so the picker degrades instead of erroring.
    try { json({ ok: true, sounds: await discordRpc.listSoundboardSounds() }); }
    catch (e) { json({ ok: false, sounds: [], error: String((e && e.message) || e) }); }

  } else if (reqPath === '/stream/discord/voice' && req.method === 'GET') {
    // Live voice state for the dashboard widget (self mute/deaf, mode, volumes,
    // audio processing, current channel + members). Client-safe; {ok:false} when
    // offline. The widget reads this once on mount for an instant paint, then gets
    // real-time updates over SSE — so this read also arms the event watch.
    refreshDiscordWatch();
    try { json(await discordRpc.voiceState()); }
    catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }

  } else if (reqPath === '/stream/discord/roster' && req.method === 'GET') {
    // Who's currently connected in each voice channel, for the widget's Channels
    // tab. The client polls this only while that tab is open and the tile is
    // visible, so the per-channel reads stay off the idle path. Client-safe
    // (names + mute/deaf only); {ok:false} when Discord is offline.
    try { json(await discordRpc.voiceRoster()); }
    catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }

  } else if (reqPath === '/notifications/windows' && req.method === 'GET') {
    // Seed for the Notifications tile: feature flags + the bounded feed buffer.
    // New items then stream live over the `windows_notification` SSE event.
    // Notification text is private user data — loopback-only like every route,
    // and NEVER a JSONP candidate.
    const wn = normalizeWindowsNotifications(_serverHubSettings && _serverHubSettings.windowsNotifications);
    json({ ok: true, enabled: wn.enabled, hide: wn.hide, toast: wn.toast, excluded: wn.excluded, state: winNotif.getState(), items: winNotif.getFeed() });

  } else if (reqPath === '/sdk/widgets' && req.method === 'GET') {
    // Installed third-party widget packages — validated manifests only (see
    // sdk-widgets.js normalizeManifest). Manifest text is untrusted → the client
    // renders it via textContent. NEVER a JSONP candidate. Always rescans (this
    // is the Rescan button) and refreshes the shared scan cache. Each package is
    // decorated (copy — the cached scan stays undecorated) with its origin +
    // exportable flag so the UI can limit exports to the user's own creations.
    const scan = await refreshSdkScan();
    const packages = scan.packages.map(p => ({ ...p, origin: widgetOriginOf(p.id), exportable: widgetExportable(p.id) }));
    json({ ok: true, api: sdkWidgets.SDK_API_VERSION, packages, invalid: scan.invalid });

  } else if (reqPath === '/sdk/fetch' && req.method === 'POST') {
    // Host-mediated network for SDK widgets. The sandboxed iframe has NO network
    // (CSP connect-src 'none' — never weakened); instead the dashboard host
    // relays a widget's request here after checking the user's host grants, and
    // this handler re-validates everything against the package's DECLARED host
    // allowlist (manifest = authority): http(s) only, loopback/link-local
    // unreachable even via DNS rebinding (sdk-proxy guarded lookup), plain http
    // only to private-network targets, headers rebuilt from an allowlist, no
    // redirect following, bounded request/response bodies. NEVER a JSONP
    // candidate.
    try {
      if (!sdkFeatureEnabled()) { json({ ok: false, error: 'sdk_disabled' }); return; }
      const body = JSON.parse(await readBody(req, 512 * 1024) || '{}');
      const pkgId = String(body.pkg || '');
      const scan = await sdkPackagesCached();
      const pkg = scan.packages.find(p => p.id === pkgId);
      if (!pkg) { json({ ok: false, error: 'unknown_package' }); return; }
      const grants = sdkGrantsFor(pkgId);
      // Addresses the user typed into the manifest's declared userHosts slots.
      // resolveUserHosts re-validates every stored value against the manifest's
      // own rules, so this can only ever widen the allowlist to hosts the
      // manifest could have declared itself.
      const filled = sdkWidgets.resolveUserHosts(pkg, grants.userHosts);
      const v = sdkWidgets.validateProxyRequest(pkg, body, filled.hosts);
      if (!v.ok) { json({ ok: false, error: v.error }); return; }
      // Server-side consent: the manifest is the authority for WHICH hosts are
      // reachable, but the user's per-package grant is the authority for whether
      // they approved this one. Enforce it here too, not only in the client bridge
      // — the route is reachable without a mounted widget frame. A filled slot IS
      // the user's consent (they typed that address), so it needs no second grant.
      let host = '';
      try { host = new URL(v.url).hostname.toLowerCase().replace(/\.$/, ''); } catch { /* v.url already validated */ }
      if (!grants.hosts.includes(host) && !filled.hosts.includes(host)) { json({ ok: false, error: 'host_not_granted' }); return; }
      // Secret injection: replace {{secret:NAME}} placeholders in the (already
      // validated) url/headers/body with the package's stored secrets, so the
      // real API key lives server-side and never rode through the sandboxed
      // frame. Gated on the package DECLARING and being GRANTED `secrets`;
      // resolveProxySecrets re-pins the host (a secret can't redirect the
      // request) and re-checks headers for CRLF.
      let outReq = v;
      if (pkg.secrets === true && grants.secrets) {
        const rs = sdkStore.resolveProxySecrets(v, sdkSecretsLoad(pkgId), pkg.hosts.concat(filled.hosts));
        if (!rs.ok) { json({ ok: false, error: rs.error }); return; }
        outReq = rs.req;
      }
      const release = sdkFetchGateAcquire(pkgId);
      if (!release) { json({ ok: false, error: 'rate_limited' }); return; }
      try {
        const r = await sdkProxy.proxyFetch(outReq);
        const textual = sdkProxy.isTextualContentType(r.contentType);
        json({
          ok: true,
          status: r.status,
          contentType: r.contentType,
          location: r.location || undefined,
          encoding: textual ? 'utf8' : 'base64',
          body: textual ? r.buffer.toString('utf8') : r.buffer.toString('base64'),
        });
      } catch (e) {
        const msg = String((e && e.message) || 'fetch_failed');
        json({ ok: false, error: ['timeout', 'blocked_address', 'response_too_large'].includes(msg) ? msg : 'fetch_failed' });
      } finally {
        release();
      }
    } catch (e) {
      if (e && e.code === 'PAYLOAD_TOO_LARGE') json({ ok: false, error: 'payload_too_large' });
      else err500(e.message);
    }

  } else if (reqPath === '/sdk/store' && req.method === 'POST') {
    // Persistent key/value store for a widget's own settings (followed teams,
    // chosen sources, a map's last view). Gated on the package DECLARING
    // `storage` and being GRANTED it; the namespace is the package id, or a
    // shared `storageGroup` so sibling widgets can share one store. Values
    // round-trip through JSON and are size/count-capped in sdk-store.js; writes
    // are change-driven. Data lives in DATA_DIR/widget-store (outside the package
    // folder, so updates/exports never touch it). NEVER a JSONP candidate.
    try {
      if (!sdkFeatureEnabled()) { json({ ok: false, error: 'sdk_disabled' }); return; }
      const body = JSON.parse(await readBody(req, 512 * 1024) || '{}');
      const pkgId = String(body.pkg || '');
      const scan = await sdkPackagesCached();
      const pkg = scan.packages.find(p => p.id === pkgId);
      if (!pkg) { json({ ok: false, error: 'unknown_package' }); return; }
      if (pkg.storage !== true || !sdkGrantsFor(pkgId).storage) { json({ ok: false, error: 'not_granted' }); return; }
      const isWrite = body.op && ['set', 'delete', 'clear'].includes(body.op.op);
      if (isWrite && !sdkStoreGateOk(pkgId)) { json({ ok: false, error: 'rate_limited' }); return; }
      const ns = sdkStore.storeNamespace(pkg);
      if (!ns) { json({ ok: false, error: 'bad_namespace' }); return; }
      const r = sdkStore.applyStoreOp(sdkStoreLoad(ns), body.op);
      if (!r.ok) { json({ ok: false, error: r.error }); return; }
      if (r.changed) {
        await sdkStoreSave(ns, r.store);
        // Tell OTHER surfaces so their mounted frames of this package (and any
        // storageGroup siblings sharing this namespace) re-mount and re-read the
        // store — the cross-surface "custom widget not 1:1 on the XENON" fix
        // (GitHub #109). The writer's own surface filters this out by origin.
        // Writes only (r.changed is never set by a read), so no spurious remounts.
        const pkgs = scan.packages.filter(p => sdkStore.storeNamespace(p) === ns).map(p => p.id);
        broadcastSSE('sdk_store', { ns, pkgs, origin: String(body.origin || '') });
      }
      json({ ok: true, value: r.value, keys: r.keys });
    } catch (e) {
      if (e && e.code === 'PAYLOAD_TOO_LARGE') json({ ok: false, error: 'payload_too_large' });
      else json({ ok: false, error: (e && e.message) || 'bad_request' });
    }

  } else if (reqPath === '/sdk/secret' && req.method === 'POST') {
    // Write-only secret vault for API keys. The widget can SET/DELETE named
    // secrets and LIST their names or test existence (`has`), but a read NEVER
    // returns a value — secrets are consumed only by {{secret:NAME}} substitution
    // inside the fetch proxy, server-side, so a published package ships no keys
    // and the sandboxed frame never sees them. Gated on the package DECLARING and
    // being GRANTED `secrets`. Stored in DATA_DIR/widget-secrets. Never JSONP.
    try {
      if (!sdkFeatureEnabled()) { json({ ok: false, error: 'sdk_disabled' }); return; }
      const body = JSON.parse(await readBody(req, 32 * 1024) || '{}');
      const pkgId = String(body.pkg || '');
      const scan = await sdkPackagesCached();
      const pkg = scan.packages.find(p => p.id === pkgId);
      if (!pkg) { json({ ok: false, error: 'unknown_package' }); return; }
      if (pkg.secrets !== true || !sdkGrantsFor(pkgId).secrets) { json({ ok: false, error: 'not_granted' }); return; }
      const isWrite = body.op && ['set', 'delete'].includes(body.op.op);
      if (isWrite && !sdkStoreGateOk('sec:' + pkgId)) { json({ ok: false, error: 'rate_limited' }); return; }
      const r = sdkStore.applySecretOp(sdkSecretsLoad(pkgId), body.op);
      if (!r.ok) { json({ ok: false, error: r.error }); return; }
      if (r.changed) await sdkSecretsSave(pkgId, r.secrets);
      json({ ok: true, names: r.names, has: r.has });
    } catch (e) {
      if (e && e.code === 'PAYLOAD_TOO_LARGE') json({ ok: false, error: 'payload_too_large' });
      else json({ ok: false, error: (e && e.message) || 'bad_request' });
    }

  } else if (req.method === 'GET' && reqPath.startsWith('/sdk/tile/')) {
    // Same-origin image proxy for map/radar tiles. The widget points an
    // <img>/Leaflet tile layer straight at this URL — allowed by the widget CSP's
    // `img-src 'self'` with NO relaxation — so a slippy map paints at native
    // speed instead of base64-ing every tile over the fetch bridge at ~1 req/s.
    // Same trust boundary as the fetch proxy (allowlisted + user-GRANTED host,
    // guardedLookup SSRF block, size cap) plus a bounded LRU + per-package gate.
    // Read-only, images only, and secrets are NEVER injected here.
    try {
      if (!sdkFeatureEnabled()) { res.writeHead(404); res.end(); return; }
      const pkgId = decodeURIComponent(reqPath.slice('/sdk/tile/'.length));
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(pkgId)) { res.writeHead(404); res.end(); return; }
      const scan = await sdkPackagesCached();
      const pkg = scan.packages.find(p => p.id === pkgId);
      if (!pkg) { res.writeHead(404); res.end(); return; }
      const grants = sdkGrantsFor(pkgId);
      // A user-filled slot can host a tile server too (a self-hosted map on the
      // LAN), so the same resolved hosts apply here as on the fetch proxy.
      const filled = sdkWidgets.resolveUserHosts(pkg, grants.userHosts);
      const v = sdkWidgets.validateProxyRequest(pkg, { url: urlObj.searchParams.get('u') || '', method: 'GET' }, filled.hosts);
      if (!v.ok) { res.writeHead(400); res.end(); return; }
      let host = '';
      try { host = new URL(v.url).hostname.toLowerCase().replace(/\.$/, ''); } catch { /* validated */ }
      if (!grants.hosts.includes(host) && !filled.hosts.includes(host)) { res.writeHead(403); res.end(); return; }
      const serve = (contentType, buffer, hit) => {
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=600',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'X-Content-Type-Options': 'nosniff',
          'X-Xenon-Tile': hit ? 'hit' : 'miss',
        });
        res.end(buffer);
      };
      const cached = sdkTileCacheGet(v.url);
      if (cached) { serve(cached.contentType, cached.buffer, true); return; }
      const release = sdkTileGate(pkgId);
      if (!release) { res.writeHead(429); res.end(); return; }
      try {
        const tile = await sdkTileFetch(v.url);
        serve(tile.contentType, tile.buffer, false);
      } finally { release(); }
    } catch (e) {
      const st = e && Number(e.status);
      res.writeHead(st >= 400 && st < 600 ? st : 502); res.end();
    }

  } else if (req.method === 'POST' && reqPath.startsWith('/sdk/hook/')) {
    // Local webhook ingress for SDK widgets: any loopback process (Streamer.bot,
    // AutoHotkey, a script) can push an event to a widget with
    // `POST /sdk/hook/<pkg>/<hookId>`. The hook id must be DECLARED in the
    // package manifest and the payload is bounded; delivery is live-only over
    // the `sdk_hook` SSE event (no buffer — hooks are events, not storage) and
    // the dashboard host forwards it only to widgets the user granted the hook
    // to. Loopback-only like every route; NEVER a JSONP candidate.
    try {
      const m = /^\/sdk\/hook\/([^/]+)\/([^/]+)$/.exec(reqPath);
      const pkgId = m ? m[1] : '';
      const hookId = m ? m[2] : '';
      if (!sdkFeatureEnabled()) { json({ ok: false, error: 'sdk_disabled' }); return; }
      // Per-package/hook rate floor (mirrors the fetch gate): a misbehaving local
      // script can't turn one hook into an SSE flood across every surface.
      if (!sdkHookGateOk(pkgId + '/' + hookId)) { json({ ok: false, error: 'rate_limited' }); return; }
      const body = await readBody(req, 64 * 1024);
      const scan = await sdkPackagesCached();
      const pkg = scan.packages.find(p => p.id === pkgId);
      if (!pkg) { json({ ok: false, error: 'unknown_package' }); return; }
      if (!pkg.hooks.includes(hookId)) { json({ ok: false, error: 'unknown_hook' }); return; }
      // Server-side consent: only fan out a hook the user actually granted to the
      // package. Grants are the shared settings blob (same across surfaces), so
      // this is authoritative — and `delivered` now means "a granted listener
      // could receive it", not merely "some SSE client exists".
      if (!sdkGrantsFor(pkgId).hooks.includes(hookId)) { json({ ok: false, error: 'not_granted' }); return; }
      let data = body;
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('json') || /^\s*[[{]/.test(body)) {
        try { data = JSON.parse(body); } catch { /* keep raw string */ }
      }
      const delivered = sseClients.size > 0;
      if (delivered) broadcastSSE('sdk_hook', { pkg: pkgId, hook: hookId, data });
      json({ ok: true, delivered });
    } catch (e) {
      if (e && e.code === 'PAYLOAD_TOO_LARGE') json({ ok: false, error: 'payload_too_large' });
      else err500(e.message);
    }

  } else if (reqPath === '/sdk/handler-ack' && req.method === 'POST') {
    // The dashboard page acks a dispatched sdk_handler call on behalf of the
    // widget frame that handled it (the sandboxed frame itself has no network —
    // the CSP kill-switch stays intact; this POST comes from the host page).
    // First ack wins; late/unknown callIds are a harmless no-op.
    try {
      const body = JSON.parse(await readBody(req, 4096) || '{}');
      json({ ok: true, matched: sdkHandlerAck(body.callId, body.ok !== false, body.error) });
    } catch (e) { json({ ok: false, error: (e && e.message) || 'bad_request' }); }

  } else if (reqPath === '/sdk/deck-states' && req.method === 'POST') {
    // The HOST page mirrors widget-published deck states here so the Virtual
    // Deck popup (no widget frames) can light sdkState keys. POST-only JSON
    // from the dashboard page (Origin layer); values re-validated + bounded in
    // acceptSdkDeckStates; rebroadcast only when something actually changed.
    try {
      if (!sdkFeatureEnabled()) { json({ ok: false, error: 'sdk_disabled' }); return; }
      // 256KB: worst case is 256 states × (120-char key + 200-char value +
      // meta + JSON escaping) — a 32KB cap would silently reject a busy relay
      // and leave the popup's sdkState keys permanently dark.
      const body = JSON.parse(await readBody(req, 262144) || '{}');
      json({ ok: true, changed: acceptSdkDeckStates(body) });
    } catch (e) { json({ ok: false, error: (e && e.message) || 'bad_request' }); }

  } else if (reqPath === '/sdk/widgets/example' && req.method === 'POST') {
    // One-click install of a bundled reference widget: copies the example
    // package from the app tree into DATA_DIR/widgets. The requested id is
    // resolved through a fixed allowlist map — never interpolated into a
    // path — so request input still never reaches the filesystem directly;
    // an unknown/missing id falls back to the original default.
    try {
      const body = JSON.parse(await readBody(req, 4096) || '{}');
      const folder = (typeof body.id === 'string' && Object.hasOwn(EXAMPLE_WIDGETS, body.id))
        ? EXAMPLE_WIDGETS[body.id] : EXAMPLE_WIDGETS['hello-xenon'];
      const src = path.join(__dirname, 'sdk-example', folder);
      const dest = path.join(SDK_WIDGETS_DIR, folder);
      await fs.promises.mkdir(dest, { recursive: true });
      for (const name of await fs.promises.readdir(src)) {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;
        await fs.promises.copyFile(path.join(src, name), path.join(dest, name));
      }
      await recordWidgetOrigin(folder, 'builtin');   // shipped example, not the user's work
      await refreshSdkScan();   // the new package is visible to hot paths immediately
      json({ ok: true });
    } catch {
      json({ ok: false, error: 'install_failed' });
    }

  } else if (reqPath === '/sdk/install' && req.method === 'POST') {
    // Install a widget package shipped inside a shared bundle. The payload is
    // validated EXACTLY like a folder scan (manifest rebuilt via normalizeManifest,
    // every file path + extension re-checked, caps enforced) BEFORE a single byte
    // is written; then the files land in DATA_DIR/widgets/<id>/ and the scan
    // refreshes. Grants are NOT auto-issued here — the package renders nothing and
    // reaches no service until the user approves its permissions through the normal
    // grant flow, and the SDK master toggle still gates all runtime ingress.
    // `origin` rides OUTSIDE the validated payload shape (extra keys are ignored
    // by validateWidgetPayload): only 'creator' (the Widget Creator declaring the
    // user's own build) is honoured — anything else records as an import, so a
    // share-code install can never claim to be the user's own work. And even a
    // 'creator' claim can't relabel an id already recorded as an import
    // (mergeOrigin makes 'import' sticky), so replaying an imported payload with
    // origin:'creator' no longer launders it into an exportable "own" widget.
    const body = await readBody(req);
    let payload; try { payload = JSON.parse(body); } catch { payload = null; }
    const origin = (payload && payload.origin === 'creator') ? 'creator' : 'import';
    const r = await installWidgetPayload(payload, origin);
    json(r);

  } else if (reqPath === '/sdk/claim' && req.method === 'POST') {
    // Mark an installed package as the user's OWN creation — a folder they built
    // by hand in server/data/widgets — which makes it exportable again. A
    // deliberate ownership assertion by the user; the install boundary is
    // untouched. Only an 'unknown'-origin package (no record yet) can be claimed:
    // never one recorded as an import or the bundled example. POST + JSON →
    // covered by the loopback Origin layer; NEVER a JSONP candidate.
    const body = await readBody(req);
    let id = '';
    try { id = String((JSON.parse(body || '{}') || {}).id || ''); } catch { id = ''; }
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) { json({ ok: false, error: 'bad_id' }); return; }
    const scan = await sdkPackagesCached();
    if (!scan.packages.some(p => p.id === id)) { json({ ok: false, error: 'not_found' }); return; }
    if (widgetOriginOf(id) !== 'unknown') { json({ ok: false, error: 'not_claimable' }); return; }
    await recordWidgetOrigin(id, 'local');
    json({ ok: true });

  } else if (req.method === 'GET' && reqPath.startsWith('/sdk/export/')) {
    // Read an installed package's files as an embeddable payload for a bundle
    // export. Read-only; the files are already reachable via /sdk/widget/, so this
    // is no new exposure. readPackagePayload applies the same asset allowlist/caps.
    // Redistribution gate: only the user's OWN creations may leave as a share
    // code — packages that arrived via import/gallery (or the bundled example)
    // are refused here, server-side, regardless of what the client asks for.
    const id = decodeURIComponent(reqPath.slice('/sdk/export/'.length));
    if (!widgetExportable(id)) { json({ ok: false, error: 'not_exportable' }); return; }
    const payload = await sdkWidgets.readPackagePayload(SDK_WIDGETS_DIR, id);
    if (!payload) { json({ ok: false, error: 'not_found' }); return; }
    json({ ok: true, payload });

  } else if (req.method === 'DELETE' && reqPath.startsWith('/sdk/widget/')) {
    // Remove one installed package (Settings → installed-packages manager).
    // DELETE + JSON → covered by the loopback Origin layer; the id is validated
    // against the package-id charset and the resolved dir prefix-checked before
    // anything is unlinked. Never GET, never a JSONP candidate.
    try {
      const id = decodeURIComponent(reqPath.slice('/sdk/widget/'.length));
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) { res.writeHead(400); res.end(); return; }
      const dir = path.join(SDK_WIDGETS_DIR, id);
      if (!dir.startsWith(SDK_WIDGETS_DIR + path.sep)) { res.writeHead(400); res.end(); return; }
      await fs.promises.rm(dir, { recursive: true, force: true });
      await recordWidgetOrigin(id, 'forget');   // drop the origin record with the files
      refreshSdkScan();
      json({ ok: true });
    } catch (e) { err500(e.message); }

  } else if (req.method === 'GET' && reqPath.startsWith('/sdk/widget/')) {
    // Sandboxed widget assets. resolveAsset() is the trust boundary (package id
    // + per-segment validation + extension allowlist + prefix check), and EVERY
    // response carries WIDGET_CSP: `sandbox allow-scripts` keeps the document
    // sandboxed even when navigated to directly, and `connect-src 'none'`
    // blocks all network from widget code — a sandboxed iframe fetches with
    // Origin:null, which isAllowedRequest() accepts for the iCUE WebView, so
    // this CSP is the layer that keeps widget code away from the local API.
    const m = /^\/sdk\/widget\/([^/]+)\/(.+)$/.exec(reqPath);
    const abs = m ? sdkWidgets.resolveAsset(SDK_WIDGETS_DIR, m[1], m[2]) : null;
    if (!abs) { res.writeHead(404); res.end(); }
    else {
      try {
        const data = await fs.promises.readFile(abs);
        res.writeHead(200, {
          'Content-Type': sdkWidgets.mimeFor(abs),
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': sdkWidgets.WIDGET_CSP,
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(data);
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'EISDIR') { res.writeHead(404); res.end(); }
        else err500(e.message);
      }
    }

  } else if (reqPath === '/stream/discord/notifications' && req.method === 'GET') {
    // Seed for the widget's Notifications tab: the feature flags + the bounded
    // recent-notification buffer. New items then stream live over the
    // `discord_notification` SSE event. Notification text is private user data —
    // loopback-only like every route, and NEVER a JSONP candidate.
    const dn = normalizeDiscordNotifications(_serverHubSettings && _serverHubSettings.discordNotifications);
    json({ ok: true, enabled: dn.enabled, hide: dn.hide, state: discordRpc.notifStatus(), items: discordNotifs });

  } else if (reqPath === '/stream/discord/launch' && req.method === 'POST') {
    // Start the Discord desktop app (via its registered "discord://" protocol) so
    // the widget's "Open Discord" overlay can bring it up when it isn't running.
    // The protocol string is a FIXED constant — no user/settings input reaches the
    // spawn — and ShellExecute surfaces a real error if Discord isn't installed.
    await readBody(req);
    try {
      await new Promise((resolve, reject) =>
        execFile('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', "try{[void][System.Diagnostics.Process]::Start([System.Diagnostics.ProcessStartInfo]@{FileName='discord://';UseShellExecute=$true})}catch{exit 1}"],
          { windowsHide: true, timeout: 10000 },
          (e2) => e2 ? reject(e2) : resolve()));
      json({ ok: true });
    } catch (e) { json({ ok: false, error: 'launch_failed' }); }

  // ── Spotify integration (Authorization Code + PKCE — redirect flow) ──────────
  // Responses never include tokens — only { connected, login, configured } or the
  // authorize URL the user opens. Playback CONTROL runs through /actions/run (the
  // allowlisted spotify* Deck actions); these routes are reads + the OAuth dance.
  } else if (reqPath === '/stream/spotify/status' && req.method === 'GET') {
    try { json(await streamSpotify.status()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/spotify/login' && req.method === 'POST') {
    // Return the authorize URL; the client opens it in a new window and polls
    // /status until the callback completes. The redirect_uri is pinned to the
    // loopback IP (Spotify rejects `localhost`) and MUST match the one the user
    // registered in their Spotify app — see docs/streaming-setup.md.
    try { await readBody(req); json(streamSpotify.buildAuthUrl(spotifyRedirectUri(req))); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/spotify/callback' && req.method === 'GET') {
    // Spotify's redirect lands here (a top-level GET navigation, so no Origin
    // header and no CSRF_MUTATION_PATHS entry — the unguessable OAuth `state`,
    // minted by our own /login, is the CSRF guard). Exchange the code, then show a
    // tiny self-closing page; the Settings poll picks up the connected state.
    try {
      const sp = urlObj.searchParams;
      let ok = false;
      if (sp.get('error')) ok = false;                     // user denied consent
      else { const r = await streamSpotify.exchangeCode(sp.get('code'), sp.get('state')); ok = !!(r && r.ok); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(spotifyCallbackPage(ok));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/spotify/logout' && req.method === 'POST') {
    try { await readBody(req); json(await streamSpotify.logout()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/spotify/queue' && req.method === 'GET') {
    // "Up Next": the currently-playing track + the upcoming queue, for the widget.
    // The client polls this only while the tile is visible.
    try { json(await streamSpotify.getQueue()); }
    catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }

  } else if (reqPath === '/stream/spotify/playlists' && req.method === 'GET') {
    try { json(await streamSpotify.getPlaylists()); }
    catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }

  } else if (reqPath === '/stream/spotify/devices' && req.method === 'GET') {
    try { json(await streamSpotify.getDevices()); }
    catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }

  } else if (reqPath === '/stream/spotify/player' && req.method === 'GET') {
    // Full now-playing state (track, progress, shuffle/repeat, device volume, liked)
    // for the widget's hero. Polled only while the tile is visible; playback control
    // itself still runs through the allowlisted /actions/run spotify* actions.
    // ?fresh=1 skips the snapshot cache — the post-control resync (next/prev/seek)
    // needs the live state, not a pre-action snapshot cached for the TTL.
    try { json(await streamSpotify.getPlayer({ fresh: urlObj.searchParams.get('fresh') === '1' })); }
    catch (e) { json({ ok: false, error: String((e && e.message) || e) }); }

  } else if (reqPath === '/stream/spotify/launch' && req.method === 'POST') {
    // Start the Spotify desktop app (via its registered "spotify:" protocol) so the
    // widget's "Open Spotify" button can bring it up when it isn't running. The
    // protocol string is a FIXED constant — no user/settings input reaches the spawn.
    await readBody(req);
    try {
      await new Promise((resolve, reject) =>
        execFile('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', "try{[void][System.Diagnostics.Process]::Start([System.Diagnostics.ProcessStartInfo]@{FileName='spotify:';UseShellExecute=$true})}catch{exit 1}"],
          { windowsHide: true, timeout: 10000 },
          (e2) => e2 ? reject(e2) : resolve()));
      json({ ok: true });
    } catch (e) { json({ ok: false, error: 'launch_failed' }); }

  } else if (reqPath === '/second-screen/requirements' && req.method === 'GET') {
    try {
      const r = await secondScreen.requirements();
      // The tile also needs the native helper (the GDI capture host); fold its
      // presence into the same payload so the client decides in one round-trip.
      r.captureAvailable = screenCapture.available();
      json(r);
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/second-screen/install' && req.method === 'POST') {
    try {
      await readBody(req);
      json(await secondScreen.installDriver());
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/second-screen/create-display' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await secondScreen.createDisplay(body && body.mode));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/second-screen/apply-resolution' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await applySecondScreenMode((body && body.mode) || {}, { soft: !!(body && body.soft) }));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/second-screen/remove-display' && req.method === 'POST') {
    try {
      await readBody(req);
      json(await secondScreen.removeDisplay());
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/status' && req.method === 'GET') {
    try { json(await remoteControl.status()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/install' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const ok = await remoteControl.installTool(body.tool);
      if (ok) { json({ ok }); } else { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok })); }
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/tailscale/login' && req.method === 'POST') {
    try {
      await readBody(req);
      await remoteControl.startTailscaleLogin();
      json({ ok: true });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/sunshine/configure' && req.method === 'POST') {
    try {
      await readBody(req);
      await remoteControl.configureSunshine();
      json({ ok: true });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }

  } else if (reqPath === '/remote/pin' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const result = await remoteControl.sendPin(body.pin);
      if (result.ok) { json({ ok: true }); }
      else { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, status: result.status })); }
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/kill' && req.method === 'POST') {
    try {
      await readBody(req);
      const ok = await remoteControl.killSwitch();
      json({ ok });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/enable' && req.method === 'POST') {
    try {
      await readBody(req);
      await remoteControl.enable();
      json({ ok: true });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/disable' && req.method === 'POST') {
    try {
      await readBody(req);
      await remoteControl.disable();
      json({ ok: true });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/ondemand' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const ok = await remoteControl.setOnDemand(body.value === true);
      json({ ok });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/screens' && req.method === 'GET') {
    try { json(await remoteControl.listScreens()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/screen' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const ok = await remoteControl.setScreen(body.id);
      if (ok) { json({ ok: true }); } else { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false })); }
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/screen/cycle' && req.method === 'POST') {
    try { await readBody(req); const active = await remoteControl.cycleScreen(); json({ ok: !!active, active }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/session/close' && req.method === 'POST') {
    try { await readBody(req); const ok = await remoteControl.closeSession(); json({ ok }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/block' && req.method === 'POST') {
    try { await readBody(req); const ok = await remoteControl.blockAccess(); json({ ok }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/unblock' && req.method === 'POST') {
    try { await readBody(req); const ok = await remoteControl.unblockAccess(); json({ ok }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/sse' && req.method === 'GET') {
    // Server-Sent Events stream — replaces client-side polling for status, media,
    // system and audio data. Keepalive pings prevent proxy connection timeouts.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':connected\n\n');

    sseClients.add(res);
    _syncFpsMonitor(); // a dashboard is watching → run PresentMon (if installed)
    refreshObsWatch();
    refreshDiscordWatch();
    refreshHaWatch();
    refreshSbWatch();
    refreshWlWatch();
    refreshUnifiEventsWatch();
    refreshWinNotifWatch();
    refreshWakeWordWatch();
    req.on('close', () => { sseClients.delete(res); if (sseClients.size === 0) obsLocalWanted = false; _syncFpsMonitor(); refreshObsWatch(); refreshDiscordWatch(); refreshHaWatch(); refreshSbWatch(); refreshWlWatch(); refreshUnifiEventsWatch(); refreshWinNotifWatch(); refreshWakeWordWatch(); });

    // Push current state immediately so the client doesn't wait for the first tick.
    Promise.all([
      getSystemInfo().catch(() => null),
      getMediaInfo().catch(() => null),
      getAudioInfo().catch(() => null),
    ]).then(([sys, media, audio]) => {
      // Full status payload — a partial {muted}-only seed read as "no game" on the
      // client, hiding the Companion pill on every SSE (re)connect.
      const now = `event: status\ndata: ${JSON.stringify(statusPayload())}\n\n`;
      if (sys)   res.write(`event: system\ndata: ${JSON.stringify(sys)}\n\n`);
      if (media) res.write(`event: media\ndata: ${JSON.stringify(media)}\n\n`);
      if (audio) res.write(`event: audio\ndata: ${JSON.stringify(audio)}\n\n`);
      else res.write('event: audio\ndata: {"unavailable":true}\n\n');
      res.write(now);
    }).catch(() => {});
    // Seed the just-connected client with the current OBS state (if watching).
    if (obsStopWatch) { try { res.write(`event: obs\ndata: ${JSON.stringify(obsState)}\n\n`); } catch (e) { /* ignore */ } }
    if (obsStopWatch && obsPreview.image) { try { res.write(`event: obs_preview\ndata: ${JSON.stringify(obsPreview)}\n\n`); } catch (e) { /* ignore */ } }
    // Seed the just-connected client with the current Home Assistant state.
    buildHaState().then((st) => { try { res.write(`event: homeassistant\ndata: ${JSON.stringify(st)}\n\n`); } catch (e) { /* ignore */ } }).catch(() => {});
    // Seed the just-connected client with the current Streamer.bot globals.
    buildSbState().then((st) => { try { res.write(`event: streamerbot\ndata: ${JSON.stringify(st)}\n\n`); } catch (e) { /* ignore */ } }).catch(() => {});
    // Seed the current peripheral battery. The 'battery' tick is 90s, and unlike
    // the builtin tile (which fetches GET /api/battery on mount) a sandboxed SDK
    // widget has no seed endpoint of its own — it can only wait for the stream,
    // so without this it sits on "Looking for devices…" for up to a minute and a
    // half after every reload. getDevices() is TTL-cached and dedups concurrent
    // callers, so several surfaces connecting at once still cost one read.
    batteryMonitor.getDevices().then((payload) => { try { res.write(`event: battery\ndata: ${JSON.stringify(payload)}\n\n`); } catch (e) { /* ignore */ } }).catch(() => {});
    // Seed the current stock quotes (paint immediately), then kick a refresh if
    // the cache is empty/stale so a freshly opened dashboard fills in fast.
    try { if (_stocksCache.quotes.length) res.write(`event: stocks\ndata: ${JSON.stringify(_stocksCache)}\n\n`); } catch (e) { /* ignore */ }
    if (!_stocksCache.quotes.length || Date.now() - _stocksCache.refreshedAt > 5 * 60 * 1000) refreshStocks().catch(() => {});
    // Seed the current football fixtures/results, then kick a refresh if stale.
    try { if (_footballCache.teams.length) res.write(`event: football\ndata: ${JSON.stringify(_footballCache)}\n\n`); } catch (e) { /* ignore */ }
    if (!_footballCache.teams.length || Date.now() - _footballCache.refreshedAt > 5 * 60 * 1000) refreshFootball().catch(() => {});
    // Seed the current news headlines, then kick a refresh if empty/stale
    // (display-only feed: only when the widget/ticker actually uses it).
    try { if (_newsCache.items.length) res.write(`event: news\ndata: ${JSON.stringify(_newsCache)}\n\n`); } catch (e) { /* ignore */ }
    if (_feedWidgetInUse('news', 'news') && (!_newsCache.items.length || Date.now() - _newsCache.refreshedAt > 15 * 60 * 1000)) refreshNews().catch(() => {});
    // Seed the current Claude Code usage aggregate, then refresh if empty/stale
    // (display-only feed: only when the widget is on the dashboard).
    try { if (_claudeCache.data) res.write(`event: claude\ndata: ${JSON.stringify(_claudeCache.data)}\n\n`); } catch (e) { /* ignore */ }
    if (_feedWidgetInUse('claude') && (!_claudeCache.data || Date.now() - _claudeCache.refreshedAt > 5 * 60 * 1000)) refreshClaude().catch(() => {});
    // Seed the SDK data-only streams (tasks/notes/agenda) for custom widgets.
    // Unlike system/media/audio/status these are broadcast ONLY on change, so a
    // sandboxed widget subscribing to one (it can't fetch) would paint nothing
    // until the user next edits a task/note/event. Same loopback-only stream and
    // same payload shape as the change broadcasts; the custom-widget host forwards
    // each only to a frame that was granted that stream.
    readTasks().then(t => { try { res.write(`event: tasks\ndata: ${JSON.stringify({ tasks: t })}\n\n`); } catch (e) { /* ignore */ } }).catch(() => {});
    readEvents().then(ev => { try { res.write(`event: agenda\ndata: ${JSON.stringify({ events: ev })}\n\n`); } catch (e) { /* ignore */ } }).catch(() => {});
    readNotes().then(n => { try { if (n) res.write(`event: notes\ndata: ${JSON.stringify(n)}\n\n`); } catch (e) { /* ignore */ } }).catch(() => {});
    // Timers too: timer_update otherwise fires only on mutations/completions, so
    // a reloaded dashboard (or a fresh Virtual Deck popup) would show blank
    // countdown faces and unlit timerRunning keys for the rest of a running timer.
    try { res.write(`event: timer_update\ndata: ${JSON.stringify({ timers: _timers })}\n\n`); } catch (e) { /* ignore */ }
    // And the relayed SDK deck states, so a fresh Virtual Deck popup paints its
    // sdkState keys without waiting for the next widget state change.
    try { if (Object.keys(_sdkDeckStates.states).length) res.write(`event: sdk_states\ndata: ${JSON.stringify(_sdkDeckStates)}\n\n`); } catch (e) { /* ignore */ }

  } else {
    res.writeHead(404); res.end();
  }
});

// ── Embedded-browser relay WebSocket ──────────────────────────────────────────
// The Browser widget streams CDP screencast frames over this loopback-only socket
// and sends pointer/keyboard input back. Each client owns its tiles and they are
// closed when it disconnects (which lets the headless Edge idle-shut-down).
const { WebSocketServer } = require('ws');
const embeddedWss = new WebSocketServer({ noServer: true });
const liveWss = new WebSocketServer({ noServer: true });
let _embConnSeq = 0;

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { pathname = ''; }
  const WS_PATHS = ['/embedded-browser/ws', '/second-screen/ws', '/api/ai/live'];
  if (!WS_PATHS.includes(pathname)) { socket.destroy(); return; }
  // Same loopback/Host/Origin guard as every HTTP route — the relay is local-only.
  if (!isAllowedRequest(req)) { socket.destroy(); return; }
  if (pathname === '/api/ai/live') {
    liveWss.handleUpgrade(req, socket, head, (client) => _handleLiveClient(client));
    return;
  }
  if (pathname === '/second-screen/ws') {
    embeddedWss.handleUpgrade(req, socket, head, (client) => _handleSecondScreenClient(client));
    return;
  }
  embeddedWss.handleUpgrade(req, socket, head, (client) => _handleEmbeddedClient(client));
});

// Binary relay frame: [u16BE header length][UTF-8 JSON header][JPEG bytes].
// Streaming clients opt in ({binary:true} on open/start) and then receive frames
// as binary WebSocket messages — no base64 layer (~33% less wire) and no
// per-frame atob loop on the client's main thread. The base64-in-JSON path stays
// for a dashboard that was already open before a server update.
function _packWsFrame(header, payload) {
  const h = Buffer.from(JSON.stringify(header), 'utf8');
  const out = Buffer.allocUnsafe(2 + h.length + payload.length);
  out.writeUInt16BE(h.length, 0);
  h.copy(out, 2);
  payload.copy(out, 2 + h.length);
  return out;
}

// Relay for the Second-screen tile. One capture host is shared, so only one
// client streams at a time; if a second client starts, it takes over the sink.
// The capture process itself self-stops when no tile is visible (the client
// sends 'stop' on hide / perf-pause), keeping idle cost at zero.
function _handleSecondScreenClient(client) {
  const send = (obj) => { try { client.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } };
  let owns = false;
  let useBinary = false;
  const sink = (data, meta) => {
    if (!useBinary) { send({ type: 'frame', data, w: meta.w, h: meta.h, seq: meta.seq }); return; }
    let payload; try { payload = Buffer.from(data, 'base64'); } catch (e) { return; }
    try { client.send(_packWsFrame({ type: 'frame', w: meta.w, h: meta.h, seq: meta.seq }, payload)); } catch (e) { /* ignore */ }
  };
  client.on('message', async (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    try {
      switch (m.type) {
        case 'list': { const r = await screenCapture.list(); send({ type: 'monitors', monitors: r.monitors || [] }); break; }
        case 'start': {
          owns = true;
          useBinary = m.binary === true;
          screenCapture.setFrameSink(sink);
          const r = await screenCapture.start({ monitor: m.monitor, fps: m.fps, maxWidth: m.maxWidth, maxHeight: m.maxHeight, quality: m.quality });
          send({ type: 'started', info: r });
          break;
        }
        case 'stop': { owns = false; await screenCapture.stop(); send({ type: 'stopped' }); break; }
        case 'input': { screenCapture.input(m.event); break; }
        default: break;
      }
    } catch (e) {
      send({ type: 'error', error: String((e && e.message) || e) });
    }
  });
  const cleanup = () => { if (owns) screenCapture.stop().catch(() => {}); owns = false; };
  client.on('close', cleanup);
  client.on('error', cleanup);
}

// Execute the cross-surface follow plan for a Browser-widget navigation: any idle
// sibling tile still sitting on the page this one just left is re-navigated so it
// picks up the shared session (GitHub #96). Best-effort — a sibling that has gone
// away simply drops out.
function _applyBrowserSync(localId, connId, url, userInitiated) {
  let plan;
  try { plan = browserSync.navigated(localId, connId, url, { at: Date.now(), userInitiated: !!userInitiated }); }
  catch (e) { return; }
  for (const step of plan) embeddedBrowser.navigate(step.tid, step.url).catch(() => {});
}

function _handleEmbeddedClient(client) {
  const connId = 'c' + (++_embConnSeq);
  const myTiles = new Set();                 // server-namespaced tile ids owned by this client
  const myLocalIds = new Set();              // logical tile ids open here (for cross-surface sync cleanup)
  const send = (obj) => { try { client.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } };
  let useBinary = false;                     // set by the first 'open' that opts in
  client.on('message', async (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const localId = String(m.tile || '');
    const tid = connId + ':' + localId;        // namespaced so tiles never collide across clients
    try {
      switch (m.type) {
        case 'open': {
          myTiles.add(tid);
          myLocalIds.add(localId);
          browserSync.open(localId, connId, tid);
          if (m.binary === true) useBinary = true;
          const onFrame = (data, meta) => {
            if (!useBinary) { send({ type: 'frame', tile: localId, data, meta }); return; }
            let payload; try { payload = Buffer.from(data, 'base64'); } catch (e) { return; }
            try { client.send(_packWsFrame({ type: 'frame', tile: localId, meta }, payload)); } catch (e) { /* ignore */ }
          };
          // A page-driven navigation (a link click, a login redirect) fans out to
          // idle sibling surfaces still on the same page; user-typed navigations
          // are flagged separately below and don't.
          const onNav = (url) => { send({ type: 'nav', tile: localId, url }); _applyBrowserSync(localId, connId, url, false); };
          const r = await embeddedBrowser.open(tid, m.url, m.w, m.h, m.dpr, onFrame, onNav);
          await embeddedBrowser.startScreencast(tid);
          send({ type: 'opened', tile: localId, url: r.url });
          break;
        }
        case 'navigate': { browserSync.markUserNav(localId, connId, Date.now()); const r = await embeddedBrowser.navigate(tid, m.url); send({ type: 'nav', tile: localId, url: r.url }); break; }
        case 'resize':    await embeddedBrowser.setSize(tid, m.w, m.h, m.dpr); break;
        case 'input':     browserSync.markInput(localId, connId, Date.now()); await embeddedBrowser.input(tid, m.event); break;
        case 'screencast': if (m.on) await embeddedBrowser.startScreencast(tid); else await embeddedBrowser.stopScreencast(tid); break;
        case 'reload':    browserSync.markInput(localId, connId, Date.now()); await embeddedBrowser.reload(tid); break;
        case 'clearData': browserSync.markInput(localId, connId, Date.now()); await embeddedBrowser.clearData(tid); send({ type: 'cleared', tile: localId }); break;
        case 'history':   browserSync.markUserNav(localId, connId, Date.now()); await embeddedBrowser.navHistory(tid, m.dir < 0 ? -1 : 1); break;
        case 'close':     myTiles.delete(tid); myLocalIds.delete(localId); browserSync.close(localId, connId); await embeddedBrowser.closeTile(tid); break;
        default: break;
      }
    } catch (e) {
      send({ type: 'error', tile: localId, error: String((e && e.message) || e) });
    }
  });
  const cleanup = () => {
    for (const tid of myTiles) embeddedBrowser.closeTile(tid).catch(() => {});
    myTiles.clear();
    for (const lid of myLocalIds) browserSync.close(lid, connId);
    myLocalIds.clear();
  };
  client.on('close', cleanup);
  client.on('error', cleanup);
}

// ── Voce Live (Gemini Live realtime) — server pieces ─────────────────────────
// Continuous mic → 16 kHz mono PCM frames, built on the SAME device selection
// (WASAPI/dshow), gain and ffmpeg the one-shot STT recorder uses — but piping
// raw PCM to stdout so it streams to Gemini in ~100 ms frames with no WAV
// round-trip. Returns a stop handle.
function _startLivePcmCapture(onPcm, onError) {
  const inputArgs = _sttInputArgs();
  if (!inputArgs) throw new Error('No audio device available for the live session');
  const ffmpeg = getFfmpegPath();
  const gain = _sttGain();
  const proc = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    ...inputArgs,
    '-af', `volume=${gain}`,
    '-ar', String(aiLive.INPUT_SAMPLE_RATE), '-ac', '1', '-f', 's16le', 'pipe:1',
  ], { windowsHide: true });
  let carry = Buffer.alloc(0);
  proc.stdout.on('data', (buf) => {
    // chunkPcm keeps a trailing partial frame as its last element; carry it to
    // the next tick so no audio is dropped at buffer boundaries.
    const frames = aiLive.chunkPcm(carry.length ? Buffer.concat([carry, buf]) : buf, aiLive.INPUT_CHUNK_BYTES);
    carry = Buffer.alloc(0);
    for (const f of frames) {
      if (f.length === aiLive.INPUT_CHUNK_BYTES) { try { onPcm(f); } catch (e) { /* ignore */ } }
      else carry = f;
    }
  });
  proc.stderr.on('data', () => {}); // drain
  proc.on('error', (e) => { try { onError && onError(e); } catch (_) { /* ignore */ } });
  proc.on('exit', () => { try { onError && onError(new Error('capture ended')); } catch (_) { /* ignore */ } });
  return { stop() { try { proc.stdin.end(); } catch {} try { proc.kill(); } catch {} } };
}

// System instruction for a Live voice session: date/time, identity, spoken-answer
// brief, remembered facts, optional rolling summary carried from the client, and
// the reply language. Mirrors the /api/ai SYS_BASE+SYS_VOICE spirit, compactly.
function _buildLiveSystemInstruction({ langName, summary }) {
  const now = new Date();
  const nowDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const nowTime = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const memText = (_serverHubSettings && _serverHubSettings.aiMemory !== false && aiMemory.count() > 0)
    ? ' ' + aiMemory.formatForPrompt() : '';
  const sumText = summary ? ` Earlier in this conversation: ${summary}` : '';
  const langText = langName ? ` Always reply in ${langName}.` : '';
  return `Current date and time: ${nowDate}, ${nowTime} (${tz}). You are Xenon, the voice assistant for a CORSAIR Xeneon Edge dashboard. This is a spoken conversation: keep answers short and natural — 1-2 sentences, no markdown, no lists. Use the provided tools to control the dashboard when the user asks, and confirm briefly what you did. For questions about how Xenon itself works (setup, features, sensors, updates, marketplace, troubleshooting), call xenon_knowledge first and answer from its card.` + memText + sumText + langText;
}

async function _teardownLiveSession(reason) {
  // No-op only when the session neither started arming (no _liveActive) nor
  // created any handles. Crucially, if _liveActive was set true — even before
  // _liveSession was assigned, i.e. a stop that lands mid-await in the 'start'
  // path — we must STILL restore the duck and the wake word, or the mic stays
  // ducked and the wake word stays suspended forever.
  if (!_liveActive && !_liveSession) return;
  const s = _liveSession;
  const wasActive = _liveActive;
  _liveSession = null;
  _liveActive = false;
  try { if (s && s.timer) clearTimeout(s.timer); } catch {}
  try { if (s && s.capture) s.capture.stop(); } catch {}
  try { if (s && s.session) s.session.close(); } catch {}
  try { _restoreSpeakerVolume(); } catch {}
  // Mic released: restore the wake word's desired state, then let it come back
  // after a settle delay (clears the suspend flag). Mirrors the STT stop path.
  if (wasActive) {
    try { refreshWakeWordWatch(); } catch {}
    try { wakeWord.resumeSoon(); } catch {}
  }
  process.stdout.write(`[Live] session ended (${reason || 'done'})\n`);
}

const LIVE_MAX_SESSION_MS = 5 * 60 * 1000;

function _handleLiveClient(client) {
  const send = (obj) => { try { client.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } };
  let started = false;
  let aborted = false; // a stop/close arrived while 'start' was still mid-await
  let langName = '';
  let uiLang = '';
  let latestUserText = '';
  const endClient = (reason) => { try { send({ type: 'closed', reason }); } catch {} try { client.close(); } catch {} };

  client.on('message', async (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.type === 'start') {
      if (started) return;
      started = true;
      const reject = (code, msg) => { process.stdout.write(`[Live] start rejected: ${code}\n`); send({ type: 'error', code, error: msg }); endClient(code); };
      const settings = (await readHubSettings().catch(() => null)) || {};
      if (aborted) { endClient('aborted'); return; } // client stopped/closed during the settings read
      // NOTE: we deliberately do NOT re-check settings.aiLiveVoice here. The toggle
      // is a client-side UX gate (the browser only opens this socket when it's on);
      // it is not a security boundary (isAllowedRequest already is). Re-checking a
      // freshly-read setting here only created a desync failure mode — client ON but
      // persisted OFF → silently rejected — which is exactly the "starts then stops"
      // bug. Trust the intent: a connected client wants a Live session.
      const apiKey = String(m.key || settings.geminiApiKey || '').trim();
      if (!apiKey) { reject('no_key', 'No Gemini API key'); return; }
      if (_liveActive) { reject('busy', 'A live session is already active'); return; }
      // Wait for the capture device to actually be probed (like the STT path)
      // rather than bailing synchronously — on a fresh boot the probe can lag the
      // first click and would otherwise wrongly report "no microphone".
      try {
        await Promise.race([
          _sttDeviceWhenReady(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('device timeout')), 8000)),
        ]);
      } catch (e) { reject('no_mic', 'Microphone not ready'); return; }
      if (aborted) { endClient('aborted'); return; }
      if (!_sttInputArgs()) { reject('no_mic', 'No microphone available'); return; }

      const LANG_NAMES = { it: 'Italian', en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese' };
      uiLang = String(m.lang || '').toLowerCase().slice(0, 2);
      langName = LANG_NAMES[uiLang] || '';
      const summary = String(m.summary || '').replace(/\s+/g, ' ').trim().slice(0, 2000);

      _liveActive = true;
      refreshWakeWordWatch();   // sync(false) — keep the wake word down for the session
      await wakeWord.suspend(); // ensure its capture child has actually exited
      // A stop/close during the suspend await: _liveActive is now true (so the
      // teardown restores the wake word/duck), but no session/capture exists yet.
      if (aborted) { _teardownLiveSession('aborted').then(() => endClient('aborted')); return; }
      _duckSpeakerVolume();

      const timer = setTimeout(() => { send({ type: 'timeout' }); _teardownLiveSession('timeout').then(() => endClient('timeout')); }, LIVE_MAX_SESSION_MS);
      _liveSession = { session: null, capture: null, timer };

      const tools = buildCoreAiFunctions();
      // Match the turn-based handler: expose the memory tools by voice too when
      // memory is on, so "remember this" / "forget that" work in a Live session.
      if (settings.aiMemory !== false) tools.push(...buildMemoryFunctions());
      const systemInstruction = _buildLiveSystemInstruction({ langName, summary });

      const session = aiLive.createLiveSession({
        apiKey,
        model: AI_MODELS.live,
        systemInstruction,
        tools,
        WebSocketImpl: require('ws').WebSocket,
        onSetupComplete: () => { process.stdout.write('[Live] setup complete — session ready\n'); send({ type: 'ready' }); },
        onAudio: (b64) => send({ type: 'audio', data: b64 }),
        onInputText: (text) => { latestUserText = text; send({ type: 'input', text }); },
        onOutputText: (text) => send({ type: 'output', text }),
        onInterrupted: () => send({ type: 'interrupted' }),
        onToolCall: async (calls) => {
          for (const c of calls) {
            let out = { error: 'failed' };
            const forwarded = [];
            try {
              const r = await executeAiTool(c.name, c.args || {}, {
                apiKey, uiLang, latestUserText,
                latestLooksLikeClothingWeather: false, latestExplicitlyWantsScreen: false, provider: 'gemini',
              });
              out = r.fnResult || { ok: true };
              for (const a of (r.clientActions || [])) forwarded.push(a);
            } catch (e) { out = { error: String((e && e.message) || e) }; }
            for (const a of forwarded) send({ type: 'action', action: a.action, args: a.args });
            if (_liveSession && _liveSession.session) _liveSession.session.sendToolResponse([{ id: c.id, name: c.name, response: { output: JSON.stringify(out) } }]);
          }
        },
        onError: (e) => { const msg = String((e && e.message) || e); process.stdout.write(`[Live] gemini error: ${msg}\n`); send({ type: 'error', error: msg }); _teardownLiveSession('error').then(() => endClient('error')); },
        onClose: (info) => {
          const detail = info ? `code=${info.code} reason=${info.reason || '(none)'}` : '';
          process.stdout.write(`[Live] gemini socket closed ${detail}\n`);
          // Forward the close reason so the client can show why (bad model/key →
          // typically 1007/1008/1011) and fall back to the turn-based path.
          if (_liveActive) { send({ type: 'error', code: 'gemini_closed', error: `Gemini Live closed (${detail})` }); _teardownLiveSession('gemini_closed').then(() => endClient('gemini_closed')); }
        },
      });
      _liveSession.session = session;

      try {
        _liveSession.capture = _startLivePcmCapture(
          (frame) => { if (session && !session.closed) session.sendAudio(frame); },
          (e) => { send({ type: 'error', code: 'capture', error: String((e && e.message) || e) }); _teardownLiveSession('capture').then(() => endClient('capture')); },
        );
      } catch (e) {
        send({ type: 'error', code: 'capture', error: String((e && e.message) || e) });
        _teardownLiveSession('capture_start').then(() => endClient('capture_start'));
        return;
      }
      process.stdout.write('[Live] session started\n');
      return;
    }

    if (m.type === 'stop') { aborted = true; await _teardownLiveSession('client_stop'); endClient('stopped'); return; }
    if (m.type === 'interrupt') { try { if (_liveSession && _liveSession.session) _liveSession.session.endAudioTurn(); } catch {} return; }
  });

  const onGone = () => { aborted = true; _teardownLiveSession('client_gone'); };
  client.on('close', onGone);
  client.on('error', onGone);
}

// After a self-update, the in-app updater cannot ship the native helper: it applies
// only the signed source zip, and xenon-helper.exe isn't in it (it's a separate
// release asset attached by CI). A freshly updated install would keep running a stale
// exe until the user re-ran INSTALL. Heal it here — once per new app version, and only
// when a helper is already present — via helper-update.js, which downloads the exe
// ONLY when its SHA-256 matches the release's Ed25519-SIGNED SHA256SUMS (same pinned
// key and fail-closed rule as the app self-update). Because the server then executes
// this exe, verifying it keeps this auto path from ever running a swapped/MITM'd
// binary. Best-effort and off the boot hot path; the PowerShell fallback covers the
// gap until the next restart, and a machine with no helper is left alone.
const HELPER_CHECK_MARKER = path.join(DATA_DIR, 'helper-checked.txt');
const HELPER_REFRESH_MAX_TRIES = 6;             // in-session retries before falling back to next boot
const HELPER_REFRESH_RETRY_MS = 3 * 60 * 1000;  // 3 min apart → ~15 min of coverage after the first try
function ensureHelperUpToDate(attempt = 1) {
  if (process.platform !== 'win32' || !APP_VERSION) return;
  try {
    if (!fs.existsSync(HELPER_EXE)) return; // PS-only install by choice: never surprise-download
    let marked = '';
    try { marked = fs.readFileSync(HELPER_CHECK_MARKER, 'utf8').trim(); } catch { /* first run */ }
    if (marked && marked === APP_VERSION) return; // already ensured for this version
    createHelperUpdate({ helperExe: HELPER_EXE, appVersion: APP_VERSION }).refresh().then(status => {
      // Terminal for this app version → record it so we don't re-check until the next
      // update. 'skip-not-latest' = the app isn't on the latest release, so pulling
      // latest's helper could pair a newer helper with an older server; leave it.
      const done = status === 'up-to-date' || status === 'installed'
        || status === 'skip-not-latest' || status === 'no-helper';
      if (done) { writeFileAtomic(HELPER_CHECK_MARKER, APP_VERSION).catch(() => {}); return; }
      // Transient (the signed assets aren't attached yet — CI does that a few minutes
      // after a release is published — or a network hiccup / hash mismatch). Retry a
      // few times THIS session so someone who updates the instant a release goes out
      // still lands the verified helper without waiting for a restart; after the cap it
      // falls back to the next-boot retry (the marker stays unwritten).
      if (attempt < HELPER_REFRESH_MAX_TRIES) {
        setTimeout(() => { try { ensureHelperUpToDate(attempt + 1); } catch { /* ignore */ } }, HELPER_REFRESH_RETRY_MS).unref();
      }
    }).catch(() => { /* best-effort */ });
  } catch { /* best-effort */ }
}

// The host the last listen() attempt used, so an EADDRINUSE retry re-binds the
// same stack (see the error handler below).
let _listenHost = '::';
let _eaddrinuseRetries = 0;
const EADDRINUSE_MAX_RETRIES = 15;   // ~15 s of retrying before giving up
const EADDRINUSE_RETRY_MS = 1000;

function _startListen(host) {
  _listenHost = host;
  server.listen(PORT, host, () => {
    console.log('Widget server running on http://' + host + ':' + PORT);
    // Refresh an outdated native helper left behind by an in-app self-update. Delayed
    // and fire-and-forget so it never competes with boot; runs at most once per version.
    setTimeout(() => { try { ensureHelperUpToDate(); } catch { /* ignore */ } }, 8000);
    getAudioInfo().then(info => {
      if (info && info.mic && typeof info.mic.muted === 'boolean') isMuted = info.mic.muted;
      console.log('Speaker cache:', cachedSpeakerId);
      console.log('Mic cache:   ', cachedMicId);
      console.log('Mic muted:   ', isMuted);
    }).catch(e => console.error('Audio init failed:', e.message));
    _initSttDevice(); // Enumerate DirectShow audio devices in background
    _initTimers().catch(() => {}); // Load persisted timers + start 1-second check loop
    // PresentMon (real in-game FPS) is NOT started here: it holds an admin ETW
    // tracing session, so it stays paused until the first dashboard connects and
    // is torn down when the last one leaves (see _syncFpsMonitor on the SSE path).
    try { gameDetect.startGameDetect(); } catch (e) { console.error('Game detect init failed:', e.message); } // Game mode via foreground full-screen detection
    try { guardian.start(); } catch (e) { console.error('Guardian init failed:', e.message); } // Opt-in sensor history (no-op while disabled)
    // Lighting ↔ Home Assistant bridge: the HA lighting provider rides the shared
    // deckHa client via runtime hooks, so its token/URL never enter the lighting
    // config. listLights only touches HA when the integration is configured.
    try {
      lighting.setExternalRuntime('homeassistant', {
        callService: (domain, service, target, data) => deckHa.callService(domain, service, target, data),
        listLights: async () => {
          const s = (await readHubSettings().catch(() => null)) || {};
          const ha = s.homeAssistant || {};
          if (!ha.url || !ha.token) return [];   // HA not configured → nothing to list
          const ents = await deckHa.listEntities().catch(() => []);
          return ents.filter(e => e && e.domain === 'light');
        },
      });
    } catch (e) { console.error('Lighting HA runtime init failed:', e.message); }
    // Lighting ↔ Razer Chroma bridge: the Chroma lighting provider fans the
    // dashboard's ambient/reactive/album colour to every Razer device through the
    // shared deckChroma session. Gated on the chroma.enabled opt-in so a disabled
    // integration never opens a Chroma session from the lighting path.
    try {
      lighting.setExternalRuntime('chroma', {
        applyColor: async (color) => {
          const s = (await readHubSettings().catch(() => null)) || {};
          if (!(s.chroma && s.chroma.enabled === true)) return;   // opt-in gate
          return deckChroma.applyColor(color);
        },
        release: () => deckChroma.release(),
        available: () => { try { return deckChroma.getStatus().available; } catch (e) { return false; } },
      });
    } catch (e) { console.error('Lighting Chroma runtime init failed:', e.message); }
    readHubSettings().then(s => {
      if (s) _serverHubSettings = s;
      // Apply persisted lighting config (no-op/zero-cost while master is OFF).
      try { lighting.applyConfig((s || _serverHubSettings).lighting); } catch (e) { console.error('Lighting init failed:', e.message); }
      // OpenRGB was removed from the product. Tear down anything a previous
      // version may have left so it never launches itself again: drop the
      // auto-start scheduled task (one fire-and-forget call, silent if absent).
      try { execFile('schtasks', ['/Delete', '/TN', 'XenonEdge OpenRGB', '/F'], { windowsHide: true }, () => {}); } catch { /* ignore */ }
    }).catch(() => {});
  });
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    // A previous instance (or one of its long-lived children — media host,
    // pwsh worker, embedded browser) may still be releasing port 3030. The tray
    // "Restart" respawns node fast, so an immediate exit here left the dashboard
    // dead until a manual retry ("RESTART fails" in issue #100). Wait and retry
    // a few times before giving up, so a quick restart just picks up the port
    // once the old process finishes shutting down.
    if (_eaddrinuseRetries < EADDRINUSE_MAX_RETRIES) {
      _eaddrinuseRetries++;
      console.warn('Port ' + PORT + ' in use, retrying in ' + EADDRINUSE_RETRY_MS + 'ms (' + _eaddrinuseRetries + '/' + EADDRINUSE_MAX_RETRIES + ')…');
      // Re-listen WITHOUT a callback: the original _startListen() registered the
      // boot callback via once('listening'), which survives failed attempts and
      // fires on the eventual success — passing it again would double-run boot.
      setTimeout(() => { try { server.listen(PORT, _listenHost); } catch { /* re-emits 'error' */ } }, EADDRINUSE_RETRY_MS);
      return;
    }
    console.error('Port ' + PORT + ' is already in use. Close the other node process before restarting.');
    process.exit(1);
  } else if ((err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL') && server.listening === false) {
    // IPv6 not available on this system — fall back to IPv4 loopback
    console.warn('IPv6 not available, falling back to 127.0.0.1');
    _startListen('127.0.0.1');
  } else {
    throw err;
  }
});

// Try IPv6 dual-stack first (accepts both 127.0.0.1 and ::1).
// Falls back to IPv4 via the error handler if IPv6 is unavailable.
_startListen('::');

// ── SSE broadcast timers ──────────────────────────────────────────────────────
// These replace client-side setInterval polling.  Timers only run work when at
// least one SSE client is connected, so they have no cost at idle.

// ── System-idle probe (presence for Bit, the vitals pet) ─────────────────────
// The Xeneon touchscreen alone can't prove the user is at the PC (they may
// never tap that monitor), so the pet's PC-invading actions key off REAL input
// recency via GetLastInputInfo (idle.ps1, hosted in the persistent worker —
// Add-Type compiles once per worker lifetime, repeat reads are instant).
// Three consumers: the pet's PC-invading actions (/api/vitals/nag), the meters'
// away-pause (vitals.js freezes decay once idleSec crosses its threshold), and
// the Ambient screensaver auto-start (ambient-mode.js starts/dismisses on
// whole-PC idle so it never fires while the user is busy on another screen), so
// the probe runs when ANY of them wants it. Polled only while an SSE client is
// connected: zero cost at idle. Consumed by statusPayload() and /api/vitals/nag.
const _idleProbe = { sec: null, at: 0 };
const _vitalsNagLast = { overlay: 0, minimize: 0, lock: 0 };
function vitalsPetCfg() {
  const v = _serverHubSettings && _serverHubSettings.vitals;
  return (v && v.enabled !== false && v.pet && v.pet.enabled === true) ? v.pet : null;
}
function idleProbeWanted() {
  const v = _serverHubSettings && _serverHubSettings.vitals;
  if (v && v.enabled !== false) {
    if (v.pet && v.pet.enabled === true) return true; // pet presence gate
    if (v.awayPause !== false) return true;           // meters' away-pause (default on)
  }
  // Ambient screensaver auto-start also needs whole-PC idle, so it doesn't fire
  // while the user is active on another screen (idleMinutes clamped by normalize).
  const a = _serverHubSettings && _serverHubSettings.ambientMode;
  if (a && a.enabled !== false && Number(a.idleMinutes) > 0) return true;
  return false;
}
// Adaptive cadence: 15s while the user is active (presence changes slowly),
// 5s once the PC looks unattended — dismissing the Ambient screensaver and the
// vitals return-credit both hinge on spotting the RETURN quickly, and a
// GetLastInputInfo read via the persistent worker costs microseconds. The fast
// tick only runs while nobody is at the PC, so it taxes no one. When a fresh
// sample shows activity resumed, the status broadcast goes out immediately so
// clients react within one probe tick instead of also waiting for the 3s timer.
const IDLE_POLL_MS = 15000;
const IDLE_POLL_FAST_MS = 5000;
const IDLE_AWAY_SEC = 45;   // deliberately below the 60s minimum screensaver threshold
async function _pollIdleProbe() {
  let delay = IDLE_POLL_MS;
  // A tick with no SSE client (2-3s EventSource reconnect gap) or with every
  // consumer off simply SKIPS the read — it must not wipe the sample: the 60s
  // freshness gates in statusPayload() and /api/vitals/nag already stop stale
  // values from being served, and wiping here would break the return-transition
  // broadcast (prev must stay a number across a reconnect hiccup) and reset the
  // fast cadence exactly while a screensaver is up.
  if (sseClients.size > 0 && idleProbeWanted()) {
    try {
      const r = await runCollector(IDLE_SCRIPT, [], 5000);
      if (r && r.ok === true && Number.isFinite(Number(r.idleSec))) {
        const prev = _idleProbe.sec;
        _idleProbe.sec = Math.max(0, Number(r.idleSec));
        _idleProbe.at = Date.now();
        if (typeof prev === 'number' && prev >= IDLE_AWAY_SEC && _idleProbe.sec < IDLE_AWAY_SEC) broadcastStatusNow();
      }
    } catch { /* probe unavailable → idleSec reads null → PC actions stay off */ }
    // Cadence from the last KNOWN sample — even when this read failed. A single
    // worker hiccup while the user is away must not drop back to the slow tick
    // right when spotting the return matters most.
    if (typeof _idleProbe.sec === 'number' && _idleProbe.sec >= IDLE_AWAY_SEC) delay = IDLE_POLL_FAST_MS;
  }
  setTimeout(_pollIdleProbe, delay).unref();
}
setTimeout(_pollIdleProbe, IDLE_POLL_MS).unref();

// The ONE shape of a 'status' payload — used by GET /status, the periodic SSE
// broadcast AND the SSE connect-seed. Every 'status' event must carry the full
// set: a partial one (the old seed sent just {muted}) reads as "no game" on the
// client and hid the Game Companion pill / confused Performance Mode on every
// SSE reconnect.
// bootAt = when this server process started. Vitals (vitals.js) uses it as a
// boot fence: a last-refill stamp older than it means the PC was off (or the
// backend restarted) in between, so the meters reseed to full instead of
// charging the downtime as neglect.
const _serverBootAt = Date.now();
function statusPayload() {
  let gaming = false;
  let activity = 'other';
  try { gaming = gameDetect.isGaming(); } catch { gaming = false; }
  try { activity = gameDetect.getActivity(); } catch { activity = 'other'; }
  let fgProcess = '';
  try { fgProcess = gameDetect.getForegroundProcess(); } catch { fgProcess = ''; }
  // gameRunning = game alive (foreground OR background); drives the Companion pill.
  // Computed before getGameProcess (it prunes the name once the game has exited).
  let gameRunning = false;
  try { gameRunning = gameDetect.isGameRunning(); } catch { gameRunning = false; }
  let gameProcess = '';
  try { gameProcess = gameDetect.getGameProcess(); } catch { gameProcess = ''; }
  // Presence for Vitals + Bit: seconds since real keyboard/mouse input, or
  // null when the probe is off (idleProbeWanted false) or stale — null means
  // "unknown": the pet never fires PC-invading actions on unknown, and the
  // meters' away-pause simply stays inactive (today's wall-clock behavior).
  const idleSec = (_idleProbe.at > 0 && Date.now() - _idleProbe.at < 60000) ? _idleProbe.sec : null;
  // version rides along so a page left open across a self-update can detect
  // the server changed under it and reload onto the matching client JS
  // (main.js) — a stale client's normalizers can corrupt shared state on save.
  return { muted: isMuted, gaming, activity, process: fgProcess, gameRunning, gameProcess, idleSec, bootAt: _serverBootAt, version: APP_VERSION };
}

// Broadcast only when the payload actually changed (plus a slow heartbeat).
// The payload is identical tick after tick on an idle PC, and every SSE event
// wakes each connected renderer (parse + handlers + DOM writes + a composited
// frame) — a constant idle CPU/GPU tax users see on a dashboard nobody is
// touching. Lighting and the briefing sampler still see every 3s tick; only
// the wire broadcast is deduplicated. The 30s heartbeat keeps slow consumers
// honest — notably the version-fence reload deferred while the user is typing
// (main.js retries it on each status event).
let _lastStatusJson = '';
let _lastStatusSentAt = 0;
function broadcastStatusNow() {
  if (sseClients.size === 0) return;
  const st = statusPayload();
  try { lighting.onStatus({ gaming: st.gaming }); } catch {}
  try { briefing.onStatusTick(st); } catch {}
  const j = JSON.stringify(st);
  if (j === _lastStatusJson && Date.now() - _lastStatusSentAt < 30000) return;
  _lastStatusJson = j;
  _lastStatusSentAt = Date.now();
  broadcastSSE('status', st);
}

setInterval(broadcastStatusNow, 3000).unref();

// Game-mode flips ride the foreground probe's instant push lines: broadcast
// right away so entering/leaving a game doesn't wait for the next 3s tick.
try { gameDetect.onGamingChange(() => broadcastStatusNow()); } catch {}

// Same change-only rule for 'media': with nothing playing (or a paused track)
// the payload is byte-identical every 2s, yet each broadcast made every client
// re-run applyMedia — textContent rewrites invalidate layout even when the text
// is the same string, so the compositor presented a fresh frame every 2s for a
// picture that never changed. A reconnecting client is never left stale: the
// SSE connect-seed pushes the full current media state directly. Also used by
// the native helper's instant track-change push (_onMediaChangedPush).
let _lastMediaJson = '';
async function broadcastMediaNow() {
  if (sseClients.size === 0) return;
  const payload = mediaForBroadcast(await getMediaInfo());
  const j = JSON.stringify(payload);
  if (j === _lastMediaJson) return;
  _lastMediaJson = j;
  broadcastSSE('media', payload);
}

setInterval(() => { broadcastMediaNow().catch(() => {}); }, 2000).unref();

setInterval(async () => {
  if (sseClients.size === 0) return;
  try {
    const sys = await getSystemInfo();
    broadcastSSE('system', sys);
    lighting.onSystem(sys);
    try { briefing.onSystemSample(sys); } catch {}
  } catch {}
}, 7000).unref();

// Peripheral battery moves on a minutes scale and its sources are relatively
// expensive (iCUE SDK round-trips + a Bluetooth PnP scan), so it gets its own
// slow tick with a change-dedup instead of riding the 7s system broadcast.
let _lastBatteryJson = '';
setInterval(async () => {
  if (sseClients.size === 0) return;
  try {
    const payload = await batteryMonitor.getDevices();
    const j = JSON.stringify(payload);
    if (j === _lastBatteryJson) return;
    _lastBatteryJson = j;
    broadcastSSE('battery', payload);
  } catch {}
}, 90000).unref();

// The 'audio' tick spawns SoundVolumeView.exe (native, can't move to pwsh-worker),
// so each fire is a process + temp-CSV cycle. External volume/mute changes are rare
// and this is a glance display, so an 8s cadence roughly halves the daily spawn
// count vs 5s while staying responsive; a dirty-check then skips the SSE broadcast
// (and the client-side mixer rebuild) when nothing actually changed. Lighting still
// sees every sample so volume-reactive effects stay live.
let _lastAudioJson = '';
setInterval(async () => {
  if (sseClients.size === 0) return;
  try {
    const a = await getAudioInfo();
    lighting.onAudio(a);
    const j = JSON.stringify(a);
    if (j !== _lastAudioJson) { _lastAudioJson = j; broadcastSSE('audio', a); }
  } catch {
    // SoundVolumeView failed (commonly AV-quarantined). Tell clients so the Volume
    // section can show an explicit "audio unavailable" notice instead of sitting
    // silently on placeholder dashes. Deduped like a normal payload.
    const j = '{"unavailable":true}';
    if (j !== _lastAudioJson) { _lastAudioJson = j; broadcastSSE('audio', { unavailable: true }); }
  }
}, 8000).unref();

// Keepalive ping every 20 s to prevent proxy/load-balancer timeouts.
setInterval(() => {
  if (sseClients.size === 0) return;
  const ping = ':ping\n\n';
  for (const res of sseClients) {
    try { res.write(ping); } catch { sseClients.delete(res); }
  }
}, 20000).unref();

// ── Last-resort process guards ────────────────────────────────────────────────
// The backend runs unattended 24/7. Node terminates the process on an unhandled
// promise rejection (and on an uncaught exception), so a single stray error in
// ANY of the many background tasks — SSE broadcasts, sensor polls, lighting, the
// game/foreground probes — would take the whole dashboard down, after which the
// tray "Restart" could race the still-held port. That is the most likely cause
// of the "crashed again, RESTART fails" reports on machines where the PowerShell
// sensor layer keeps failing (issue #100). Log loudly and keep serving instead
// of dying: a broken sensor read must never kill the dashboard. Genuinely fatal
// conditions (a failed listen) are still handled explicitly at their source, and
// intentional shutdown sets _shuttingDown so these don't fire spuriously.
let _shuttingDown = false;
process.on('unhandledRejection', (reason) => {
  if (_shuttingDown) return;
  console.error('[unhandledRejection] ' + ((reason && reason.stack) || (reason && reason.message) || reason));
});
process.on('uncaughtException', (err) => {
  if (_shuttingDown) return;
  console.error('[uncaughtException] ' + ((err && err.stack) || err));
});

// Graceful shutdown: close SSE streams and the HTTP server so port 3030 is
// released promptly on Ctrl+C / SIGTERM. Without this, long-lived SSE
// connections keep the process alive for 30+ seconds after the signal,
// causing EADDRINUSE on quick restarts (npm run start immediately after Ctrl+C).
// The handler calls process.exit(0) explicitly — the old comment warning
// about suppressing Ctrl+C only applies to handlers that *return* without
// exiting. A 3-second safety timeout force-exits if connections drain slowly.
function _gracefulShutdown() {
  _shuttingDown = true;
  // Flush a pending (debounced) lighting persist so the last change survives.
  // The promise is awaited by the exit path below — firing it and exiting
  // immediately could kill the process mid write-fsync-rename.
  let shutdownFlush = Promise.resolve();
  try { shutdownFlush = _flushLightingPersist().catch(() => {}); } catch {}
  // Terminate all open SSE streams (the main long-lived handles).
  for (const res of sseClients) { try { res.end(); } catch {} }
  sseClients.clear();
  // Release RGB bridge so iCUE reclaims device control immediately.
  try { lighting.releaseAll(); lighting.disconnect(); } catch {}
  // Stop the persistent PowerShell collector host (safe to kill: no SMTC handles).
  try { _killWorker('shutdown'); } catch {}
  // Retire the SMTC media host gracefully (stdin close → clean exit → handles released).
  try { _retireMediaHost('shutdown'); } catch {}
  // Retire the DDC/CI display host (stdin close → releases physical monitor handles).
  try { _retireDdcHost('shutdown'); } catch {}
  // Kill the headless embedded-browser Edge instance (if one is running).
  try { embeddedBrowser.shutdown(); } catch {}
  // Stop the second-screen capture host (if one is running).
  try { screenCapture.shutdown(); } catch {}
  // Stop the PresentMon FPS reader (holds an admin ETW tracing session) and the
  // foreground game probe. Both spawn long-lived children with no job object, so
  // without an explicit stop process.exit orphans them across every restart.
  try { if (_fpsPauseTimer) { clearTimeout(_fpsPauseTimer); _fpsPauseTimer = null; } } catch {}
  try { fpsMonitor.stopFpsMonitor(); } catch {}
  try { gameDetect.stopGameDetect(); } catch {}
  try { winNotif.stop(); } catch {}
  try { wakeWord.stop(); } catch {}
  try { guardian.stop(); } catch {}
  // Kill any in-flight STT recorder: unlike the other children it has no stop
  // module, so Ctrl+C mid-recording would orphan an ffmpeg that keeps the mic
  // device open — blocking the wake word after restart.
  for (const rec of _sttPending.values()) { try { rec.ffmpegProc.kill(); } catch {} }
  _sttPending.clear();
  // Tear down any active Voce Live session — its continuous ffmpeg capture and
  // Gemini WebSocket are long-lived children/handles with no job object, so
  // process.exit would orphan the ffmpeg (mic stays open, wake word dead).
  try { _teardownLiveSession('shutdown'); } catch {}
  // Stop the live voice watch (clears its reconnect timer) then close the Discord
  // RPC named-pipe socket. Stopping first prevents close() from scheduling a
  // reconnect during shutdown.
  try { if (discordStopWatch) { discordStopWatch(); discordStopWatch = null; } } catch {}
  try { discordRpc.close(); } catch {}
  // Stop the live Home Assistant watch (clears its reconnect timer) then close the
  // WebSocket. Stopping first prevents close() from scheduling a reconnect.
  try { if (haStopWatch) { haStopWatch(); haStopWatch = null; } } catch {}
  try { if (haNotifyTimer) { clearTimeout(haNotifyTimer); haNotifyTimer = null; } } catch {}
  try { deckHa.close(); } catch {}
  // Stop the Wave Link mixer watch (clears its reconnect timer) then close the WS;
  // uninitialize any held Chroma session so Synapse reclaims device control.
  try { if (wlStopWatch) { wlStopWatch(); wlStopWatch = null; } } catch {}
  try { if (wlNotifyTimer) { clearTimeout(wlNotifyTimer); wlNotifyTimer = null; } } catch {}
  try { deckWaveLink.close(); } catch {}
  // Stop the UniFi Protect camera-notifications watch (clears its reconnect timer)
  // then close the updates WebSocket — a long-lived socket with no job object.
  try { if (unifiEventsStopWatch) { unifiEventsStopWatch(); unifiEventsStopWatch = null; } } catch {}
  try { deckUnifiEvents.close(); } catch {}
  try { deckChroma.close(); } catch {}
  // Resolve any parked sdk_handler calls so their /actions/run responses flush
  // before the server closes (their timers are cleared with them).
  try { sdkHandlerShutdown(); } catch {}
  // Close any Virtual Deck popup windows we spawned — they have no job object,
  // so process.exit would orphan them on a dead server.
  for (const pid of _deckPopupPids) { try { process.kill(pid); } catch {} }
  _deckPopupPids.clear();
  // Close the HTTP server; exit once all remaining connections drain AND the
  // lighting flush (if one was pending) has reached the disk.
  server.close(() => { shutdownFlush.then(() => process.exit(0)); });
  // Safety: force-exit after 3 s if some connection or write refuses to finish.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT',  _gracefulShutdown);
process.on('SIGTERM', _gracefulShutdown);
