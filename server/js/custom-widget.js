'use strict';
// Custom widget tile — host side of the third-party widget SDK.
//
// Each "custom" tile hosts ONE community widget package inside a sandboxed
// <iframe sandbox="allow-scripts"> served from /sdk/widget/<id>/ with a strict
// CSP (opaque origin, zero network — see server/sdk-widgets.js). The widget
// talks to the dashboard ONLY through the versioned postMessage bridge below:
//   widget → host:  hello, action {id, action}
//   host → widget:  init {api, theme, lang, streams, actions}, data {stream,…},
//                   theme {theme}, action_result {id, ok, error}
// The user grants each package its data streams and action categories in an
// explicit permission dialog before it ever renders; the host forwards only
// granted streams and dispatches only granted actions — every action is then
// re-validated server-side by /actions/run like any Deck key.
(function () {
  const S = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const ICONS = {
    puzzle: S('<path d="M14 7h4a1 1 0 0 1 1 1v3.5a1.5 1.5 0 0 0 0 3V18a1 1 0 0 1-1 1h-3.5a1.5 1.5 0 0 1-3 0H8a1 1 0 0 1-1-1v-3.5a1.5 1.5 0 0 1 0-3V8a1 1 0 0 1 1-1h3.5a1.5 1.5 0 0 1 3 0Z"/>'),
    swap: S('<path d="M16 3h5v5M21 3l-7 7M8 21H3v-5M3 21l7-7"/>'),
    reload: S('<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>'),
  };
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;   // shared DOM factory from utils.js
  const api = apiJson; // shared fetch-JSON helper from utils.js

  // Client copy of the category → deck-action-type map (server/sdk-widgets.js
  // is the authority; keep in sync). Used to gate bridge action dispatch.
  const ACTION_CATEGORIES = {
    media: ['media'],
    volume: ['volume', 'appVolume', 'appMute'],
    mic: ['micMute'],
    lighting: ['lighting', 'lightPower', 'lightColor', 'lightAuto', 'lightEffect', 'lightDevice'],
    chroma: ['chromaColor', 'chromaOff'],
    wavelink: ['wlInputVolume', 'wlInputMute', 'wlOutputVolume', 'wlOutputMute', 'wlSwitchMonitoring', 'wlSetMonitorMix'],
    spotify: ['spotifyPlay', 'spotifyNext', 'spotifyPrev', 'spotifySave', 'spotifyLike', 'spotifyShuffle', 'spotifyRepeat', 'spotifyVolume', 'spotifySeek', 'spotifyPlaylist', 'spotifyDevice'],
    obs: ['obsScene', 'obsSceneNext', 'obsRecord', 'obsStream', 'obsMute', 'obsInputVolume'],
    discord: ['discordMute', 'discordDeafen', 'discordPtt', 'discordJoin', 'discordLeave', 'discordInputVol', 'discordOutputVol', 'discordAudioToggle', 'discordSoundboard'],
    homeassistant: ['haToggle', 'haLight', 'haMedia', 'haCover', 'haClimate', 'haFan', 'haVacuum', 'haLock', 'haAlarm', 'haScene', 'haScript', 'haButton'],
    twitch: ['twitchClip', 'twitchMarker', 'twitchAd', 'twitchTitle', 'twitchGame', 'twitchChat', 'twitchShoutout', 'twitchChatMode'],
    youtube: ['ytBroadcast'],
    streamerbot: ['sbDoAction', 'sbSendMessage', 'sbCodeTrigger'],
    url: ['openUrl'],
    tasks: ['taskAdd', 'taskToggle', 'taskDelete'],
    soundboard: ['playSound', 'soundStopAll'],
  };
  // The only playSound.file shape an SDK widget may use — an installed sound
  // pack's clip, never an arbitrary local path (that stays a Deck-key-only
  // privilege). Mirrors SDK_SOUND_FILE_RE in server/sdk-widgets.js.
  const SDK_SOUND_FILE_RE = /^packs\/[a-z0-9][a-z0-9-]{1,40}\/[a-z0-9][a-z0-9_-]{0,40}\.(?:mp3|ogg|wav)$/;

  // ── User-filled host slots (manifest `userHosts`) ─────────────────
  // A widget that talks to hardware on YOUR network — a NAS, Docker, a printer —
  // cannot know its address in advance, so its manifest declares a labelled
  // blank and the user types the address in the permission dialog. These three
  // mirror sdk-widgets.js (HOSTNAME_RE / isForbiddenProxyHost /
  // isPrivateNetworkHost) so the field can say "that address won't work" while
  // the user is still looking at it, instead of letting Allow succeed and the
  // widget silently fail later. The SERVER is the authority — resolveUserHosts
  // re-validates every stored value on every proxied request, so a mistake here
  // costs a bad error message, never a widened allowlist.
  const CW_HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*$/;
  function cwForbiddenHost(host) {
    return host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0'
      || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host);
  }
  function cwPrivateHost(host) {
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (host.endsWith('.local')) return true;
    return !host.includes('.');
  }
  // Turn what a person actually pastes — "192.168.1.50:32400", "nas.local",
  // "https://plex.example.com/web" — into the { host, port, scheme } triple the
  // grant stores. Returns { ok:false, error } with the reason to show them.
  function parseUserHost(text, scope) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return { ok: false, error: 'empty' };
    const explicitHttps = /^https:\/\//i.test(raw);
    let u;
    try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'http://' + raw); } catch { return { ok: false, error: 'bad' }; }
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || host.length > 253 || !CW_HOSTNAME_RE.test(host)) return { ok: false, error: 'bad' };
    if (cwForbiddenHost(host)) return { ok: false, error: 'forbidden' };
    const priv = cwPrivateHost(host);
    if (scope === 'private' && !priv) return { ok: false, error: 'not_private' };
    const port = u.port ? Number(u.port) : 0;
    if (u.port && !(Number.isInteger(port) && port >= 1 && port <= 65535)) return { ok: false, error: 'bad' };
    // Mirror the proxy's rule rather than restate it: plain http reaches LAN
    // gear only, so a public host is always https whatever was typed.
    return { ok: true, value: { host, port, scheme: priv ? (explicitHttps ? 'https' : 'http') : 'https' } };
  }
  // The address as the user should see it back in the field when they reopen the
  // dialog — the same text parseUserHost would accept.
  function formatUserHost(v) {
    if (!v || !v.host) return '';
    const scheme = v.scheme === 'https' ? 'https://' : '';
    return scheme + v.host + (v.port ? ':' + v.port : '');
  }
  // Client mirror of sdk-widgets.js resolveUserHosts — the extra hostnames the
  // bridge accepts for this package, plus the ready-to-use base each slot hands
  // the widget. Same skip-invalid-quietly rule: a value that no longer passes
  // reads as "not configured", never as an error.
  function resolvedUserHosts(pkg, grant) {
    const slots = Array.isArray(pkg && pkg.userHosts) ? pkg.userHosts : [];
    const values = (grant && grant.userHosts) || {};
    const byId = {};
    const hosts = [];
    for (const slot of slots) {
      const v = values[slot.id];
      const host = v && typeof v.host === 'string' ? v.host.toLowerCase() : '';
      if (!host || cwForbiddenHost(host) || !CW_HOSTNAME_RE.test(host)) continue;
      const priv = cwPrivateHost(host);
      if (slot.scope === 'private' && !priv) continue;
      const scheme = priv ? (v.scheme === 'https' ? 'https' : 'http') : 'https';
      const port = Number.isInteger(v.port) && v.port >= 1 && v.port <= 65535 ? v.port : 0;
      byId[slot.id] = { host, port, scheme, base: scheme + '://' + host + (port ? ':' + port : '') };
      if (!hosts.includes(host)) hosts.push(host);
    }
    return { byId, hosts };
  }
  const STREAM_LABELS = {
    status: ['cw_stream_status', 'System status (mic, game mode)'],
    system: ['cw_stream_system', 'System sensors (CPU, GPU, RAM)'],
    media: ['cw_stream_media', 'Now playing'],
    audio: ['cw_stream_audio', 'Volume & audio devices'],
    wavelink: ['cw_stream_wavelink', 'Wave Link mixer state'],
    stocks: ['cw_stream_stocks', 'Stock quotes & indices'],
    football: ['cw_stream_football', 'Football fixtures & scores'],
    news: ['cw_stream_news', 'News headlines'],
    claude: ['cw_stream_claude', 'Claude Code usage'],
    obs: ['cw_stream_obs', 'OBS status (scene, recording)'],
    discord: ['cw_stream_discord', 'Discord voice status'],
    discordChannels: ['cw_stream_discord_channels', 'Discord servers, voice channels and members'],
    discordSoundboard: ['cw_stream_discord_soundboard', 'Discord soundboard catalog'],
    discordNotifications: ['cw_stream_discord_notifications', 'Discord notification content (DMs and mentions)'],
    streamerbot: ['cw_stream_streamerbot', 'Streamer.bot status & events'],
    homeassistant: ['cw_stream_homeassistant', 'Home Assistant device states'],
    tasks: ['cw_stream_tasks', 'Your task list'],
    notes: ['cw_stream_notes', 'Your notes'],
    agenda: ['cw_stream_agenda', 'Your calendar events'],
    weather: ['cw_stream_weather', 'Weather conditions & forecast'],
  };
  const ACTION_LABELS = {
    media: ['cw_act_media', 'Control media playback'],
    volume: ['cw_act_volume', 'Change the volume'],
    mic: ['cw_act_mic', 'Mute/unmute the microphone'],
    lighting: ['cw_act_lighting', 'Control the RGB lighting'],
    chroma: ['cw_act_chroma', 'Control Razer Chroma lighting'],
    wavelink: ['cw_act_wavelink', 'Control the Wave Link mixer'],
    spotify: ['cw_act_spotify', 'Control Spotify playback'],
    obs: ['cw_act_obs', 'Control OBS (scenes, recording, audio)'],
    discord: ['cw_act_discord', 'Control Discord voice'],
    homeassistant: ['cw_act_homeassistant', 'Control your Home Assistant devices'],
    twitch: ['cw_act_twitch', 'Control your Twitch channel'],
    youtube: ['cw_act_youtube', 'Control your YouTube stream'],
    streamerbot: ['cw_act_streamerbot', 'Trigger Streamer.bot actions'],
    url: ['cw_act_url', 'Open web links on this PC'],
    tasks: ['cw_act_tasks', 'Add and complete your to-do tasks'],
    soundboard: ['cw_act_soundboard', 'Play clips from your installed sound packs'],
  };
  const ACTION_MIN_INTERVAL_MS = 250;   // per-instance action rate limit
  const FETCH_MIN_INTERVAL_MS = 1000;   // per-instance proxied-fetch rate limit
  const REFRESH_MIN_INTERVAL_MS = 900;  // per-instance local-stream refresh rate limit
  const STATE_MIN_INTERVAL_MS = 150;    // per-instance deck-state publish rate limit
  const ISLAND_MIN_INTERVAL_MS = 200;   // per-instance island text update rate limit
  const ISLAND_TEXT_MAX = 160;          // island line hard cap (host-rendered textContent)
  const BADGE_MIN_INTERVAL_MS = 500;    // per-instance badge chip update rate limit
  const BADGE_TEXT_MAX = 20;            // badge chip hard cap — small persistent pill, not a sentence
  const BADGE_TOOLTIP_MAX = 48;         // badge tooltip (title attribute) hard cap
  const BADGE_ICON_MAX = 8;             // badge glyph cap — same bound as a deck state's icon meta
  const CLIP_MIN_INTERVAL_MS = 1200;    // per-instance clipboard-request rate limit (a copy needs a human tap anyway)
  const CLIP_TEXT_MAX = 4096;           // max chars a single copy may carry
  const CLIP_LABEL_MAX = 64;            // the short "what is this" label shown in the confirm prompt

  // Rich Discord data does not ride the high-frequency SSE voice stream. A
  // widget may ask the host to refresh one of these fixed, same-origin sources;
  // it can never supply a URL. This keeps the iframe's network kill-switch
  // intact while making private notification content a separate visible grant.
  const LOCAL_STREAM_LOADERS = Object.freeze({
    discordChannels: Object.freeze({ ttl: 5000, load: async () => {
      const [catalog, roster] = await Promise.all([
        api('/stream/discord/channels'),
        api('/stream/discord/roster'),
      ]);
      const byId = new Map();
      if (catalog && Array.isArray(catalog.channels)) {
        catalog.channels.forEach((c) => {
          if (c && c.id != null) byId.set(String(c.id), { id: String(c.id), name: c.name || '', guild: c.guild || '', members: [] });
        });
      }
      if (roster && Array.isArray(roster.channels)) {
        roster.channels.forEach((c) => {
          if (!c || c.id == null) return;
          const id = String(c.id);
          const prev = byId.get(id) || { id, name: c.name || '', guild: c.guild || '', members: [] };
          prev.name = c.name || prev.name;
          prev.guild = c.guild || prev.guild;
          prev.members = Array.isArray(c.members) ? c.members : [];
          byId.set(id, prev);
        });
      }
      return { ok: !!((catalog && catalog.ok) || (roster && roster.ok)), channels: Array.from(byId.values()) };
    } }),
    discordSoundboard: Object.freeze({ ttl: 60000, load: async () => {
      const data = await api('/stream/discord/sounds');
      return { ok: !!(data && data.ok), sounds: (data && Array.isArray(data.sounds)) ? data.sounds : [] };
    } }),
    discordNotifications: Object.freeze({ ttl: 5000, load: async () => {
      const data = await api('/stream/discord/notifications');
      return data && typeof data === 'object'
        ? data
        : { ok: false, enabled: false, hide: true, state: 'offline', items: [] };
    } }),
  });
  const localStreamLoadedAt = Object.create(null);
  const localStreamInflight = Object.create(null);

  // Reference widgets bundled in the app tree (server/sdk-example/), installable
  // with one tap via POST /sdk/widgets/example. The server holds the
  // authoritative id→folder allowlist (EXAMPLE_WIDGETS in server.js); these ids
  // must match it. They install as origin 'builtin' — usable and updatable, but
  // never re-exportable as the user's own work.
  // `desc` mirrors each package's manifest description verbatim — an installed
  // package's row shows the manifest text as-is (untranslated), so an example's
  // row reads identically before and after installing.
  const EXAMPLES = [
    { id: 'hello-xenon', name: 'Hello Xenon', desc: 'Reference SDK widget: live clock, CPU/GPU/RAM readout and media keys. Use it as the starting point for your own widget.' },
    { id: 'teleprompter', name: 'Teleprompter', desc: 'Write a script, play it as big auto-scrolling prompter text. Deck keys control play/pause, speed and reset; in the minimal topbar the current line appears in the dynamic island.' },
    { id: 'github-stars', name: 'GitHub Stars', desc: 'Shows a GitHub repository\'s live star count, as a tile and as a small badge next to the clock. Configure the repo once; it refreshes automatically.' },
  ];

  let pkgCache = null;        // last /sdk/widgets result ({packages, invalid})
  let pkgFetchPromise = null; // in-flight /sdk/widgets fetch (shared by callers)
  // instanceId → { frame, pkgId, ready, lastAction, lastFetch, lastState, ambient? }.
  // Ambient entries are fullscreen scene frames registered by AmbientMode under
  // a reserved id — they are not tiles, so every tile-driven cleanup below must
  // skip them (AmbientMode owns their lifecycle).
  const AMBIENT_INST_ID = '__ambient-scene__';
  const frames = new Map();
  // Bumped on every Rescan / manual reload so a re-mount actually reloads the
  // widget's files. Widget assets are served no-cache+ETag, but the iframe src is
  // otherwise identical across edits, so an already-mounted frame (especially on
  // the Xeneon Edge, which the developer can't hard-refresh like a browser tab)
  // would keep showing the version it first loaded. Appending ?v=<assetVersion>
  // to the src, and re-mounting when it changes, gives widget devs a live reload.
  let assetVersion = 1;
  // This surface's identity, sent with every store WRITE so the resulting
  // cross-surface `sdk_store` broadcast can be ignored on the surface that made it
  // — only OTHER surfaces re-mount to pick up the change, so we never yank the
  // frame the user is actively editing. Opaque, per page load (GitHub #109).
  const SURFACE_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const lastData = {};        // stream → last payload (seed for late frames)
  let discordSeedInflight = null;   // shared one-shot seed of the `discord` stream
  // Deck states published by widgets over the bridge, keyed "pkg/stateId".
  // Authoritative copy — pushed wholesale into the Deck snapshot on change.
  const sdkStates = {};
  // Optional display meta per state ({label, icon, color}) for key.live badges.
  const sdkStateMeta = {};

  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="custom"]')).filter(n => n.closest('.pager-page')); }

  // Identity comes from the ATOM (data-dashboard-instance, set on every
  // duplicated copy; the primary has none → base id), NEVER from the enclosing
  // .grid-stack-item's gs-id: inside a tab group that item is the GROUP's
  // (gs-id "g-…"), so every member would collapse onto one shared key — the
  // assignment "vanished" into an unreachable key when a tile joined a group,
  // two custom tabs fought over one slot, and unassigning one killed both.
  // Standalone tiles are unaffected: a primary's gs-id IS the base id and a
  // copy's gs-id IS its data-dashboard-instance, so stored keys keep working.
  function instanceIdOf(tile) {
    return tile.getAttribute('data-dashboard-instance') || 'custom';
  }

  function sdk() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.sdkWidgets : null;
    return (hs && typeof hs === 'object') ? hs : { enabled: false, assign: {}, grants: {} };
  }
  function persist(patch) {
    if (typeof updateSdkWidgets === 'function') updateSdkWidgets(patch);
  }

  function packageById(id) {
    const list = (pkgCache && Array.isArray(pkgCache.packages)) ? pkgCache.packages : [];
    return list.find(p => p && p.id === id) || null;
  }

  // In-flight /sdk/widgets fetch is SHARED, not dropped: awaiting callers
  // (getPackages, the post-install rescan) must resolve with real data, and a
  // FORCED call that lands mid-flight still gets its fresh pass afterwards —
  // an early-return here used to silently skip the rescan of a just-installed
  // package.
  async function fetchPackages(force) {
    // A forced fetch is a Rescan / (re)install — the files on disk may have
    // changed, so bump the asset version to force mounted frames to reload them.
    if (force) assetVersion++;
    if (pkgFetchPromise) {
      await pkgFetchPromise;
      if (!force) return;
    } else if (pkgCache && !force) {
      return;
    }
    pkgFetchPromise = (async () => {
      try {
        const d = await api('/sdk/widgets');
        if (d && d.ok) pkgCache = { packages: d.packages || [], invalid: d.invalid || [] };
        else if (!pkgCache) pkgCache = { packages: [], invalid: [] };
      } finally { pkgFetchPromise = null; }
    })();
    await pkgFetchPromise;
    paint();
    syncServiceFrames();   // background packages may have appeared/gone
    // Let other UI react to the fresh list without a page reload — e.g. Settings'
    // Ambient scene picker re-lists a just-installed scene the instant it lands.
    try { window.dispatchEvent(new CustomEvent('xenon:sdk-packages')); } catch { /* no CustomEvent */ }
  }

  // ── Theme payload (host → widget) ────────────────────────────────
  // A widget themes itself from `appearance` (light/dark). data-appearance is a
  // pipeline flag, not necessarily the visible surface — an imported theme may
  // pair an old `appearance` hint with a completely different panel colour.
  // Derive appearance from the ACTUAL panel/background luminance so a widget
  // always matches the surface it sits on under any skin.
  function surfaceAppearance() {
    try {
      const cs = getComputedStyle(document.documentElement);
      let s = cs.getPropertyValue('--panel-rgb').trim() || cs.getPropertyValue('--bg').trim();
      let r, g, b;
      if (s.charAt(0) === '#') {
        const h = s.length === 4 ? s.slice(1).replace(/./g, (c) => c + c) : s.slice(1);
        r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
      } else {
        const m = s.match(/(\d+)\D+(\d+)\D+(\d+)/);
        if (m) { r = +m[1]; g = +m[2]; b = +m[3]; }
      }
      if (r == null || Number.isNaN(r)) return document.documentElement.getAttribute('data-appearance') || 'dark';
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? 'light' : 'dark';
    } catch { return document.documentElement.getAttribute('data-appearance') || 'dark'; }
  }
  function themePayload(entry) {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings : {};
    // Resolved 12h/24h preference (auto/12/24 → boolean) so a widget rendering
    // its own clock — e.g. the Ambient scene's hero time — agrees with the
    // dashboard instead of hard-coding 24h. Sent on init AND on refreshTheme, so
    // toggling the format in Settings updates a live widget without a reload.
    const clock12 = (typeof clockUses12h === 'function') ? clockUses12h() : false;
    let p = (typeof window.getEffectiveThemePalette === 'function')
      ? window.getEffectiveThemePalette()
      : null;
    let overrides = [];
    // CSS custom properties do not cross an iframe document boundary. Read the
    // final computed tokens from the frame element itself so a custom SDK widget
    // receives the palette of its own tile, including any per-widget override.
    // Service/Ambient frames simply inherit the global tokens through the same
    // path. `_xenonThemeOverrides` is host-only metadata used by generated
    // widgets to preserve an authored accent unless the tile explicitly changes
    // it; third-party widgets may ignore it and consume the effective palette.
    if (entry && entry.frame && window.ThemePalette) {
      try {
        const cs = getComputedStyle(entry.frame);
        const read = (name, fallback) => ThemePalette.normalizeHex(cs.getPropertyValue(name), fallback);
        const base = p || ThemePalette.derive({
          accent: hs.accent, background: hs.background, text: hs.text,
          contrastGuard: hs.contrastGuard,
        }, surfaceAppearance());
        const local = {
          tone: ThemePalette.toneFor(read('--surface', base.surface)),
          guard: base.guard,
          background: read('--bg', base.background),
          surface: read('--surface', base.surface),
          surfaceAlt: read('--surface-alt', base.surfaceAlt),
          control: read('--control-bg', base.control),
          text: read('--text', base.text),
          muted: read('--muted-text', base.muted),
          dim: read('--dim-text', base.dim),
          line: read('--line', base.line),
          accent: read('--accent', base.accent),
          onAccent: read('--on-accent', base.onAccent),
          success: read('--color-success', base.success),
          onSuccess: read('--on-success', base.onSuccess),
          warning: read('--color-warn', base.warning),
          onWarning: read('--on-warning', base.onWarning),
          danger: read('--color-danger', base.danger),
          onDanger: read('--on-danger', base.onDanger),
          info: read('--color-info', base.info),
          onInfo: read('--on-info', base.onInfo),
          // Panel opacity ("Opacità pannelli"): the nested-card surface already
          // carrying the user's alpha (surfaceAlt at --panel-soft-alpha), plus the
          // raw factor — so a widget can make its own cards follow it like a native
          // tile does. rgba string / 0..1 number; null when unavailable.
          surfaceSoft: (cs.getPropertyValue('--panel-soft').trim() || null),
          panelAlpha: (() => { const a = parseFloat(cs.getPropertyValue('--panel-soft-alpha')); return Number.isFinite(a) ? a : null; })(),
        };
        p = local;
        const tile = entry.frame.closest('.grid-stack-item');
        if (tile && Array.isArray(tile._xenonThemeOverrides)) overrides = tile._xenonThemeOverrides.slice();
      } catch { /* detached frame: use the global palette below */ }
    }
    if (p) {
      const palette = {
        background: p.background, surface: p.surface, surfaceAlt: p.surfaceAlt, control: p.control,
        text: p.text, muted: p.muted, dim: p.dim, line: p.line,
        accent: p.accent, onAccent: p.onAccent,
        success: p.success, onSuccess: p.onSuccess,
        warning: p.warning, onWarning: p.onWarning,
        danger: p.danger, onDanger: p.onDanger,
        info: p.info, onInfo: p.onInfo,
        // Optional (present when the tile's tokens were readable): a card surface
        // that follows the user's panel opacity, and the raw 0..1 factor.
        surfaceSoft: p.surfaceSoft || null, panelAlpha: (typeof p.panelAlpha === 'number' ? p.panelAlpha : null),
      };
      return { appearance: p.tone, overrides, clock12, ...palette, palette };
    }
    return {
      appearance: surfaceAppearance(),
      accent: typeof hs.accent === 'string' ? hs.accent : '#1ed760',
      background: typeof hs.background === 'string' ? hs.background : '#070808',
      text: typeof hs.text === 'string' ? hs.text : '#f0f3f1',
      clock12,
    };
  }
  function langCode() {
    return (typeof t === 'function' && t('locale')) || 'en';
  }

  // ── postMessage bridge ───────────────────────────────────────────
  // The iframe origin is opaque ('null'), so identity is established by
  // matching event.source against our own iframes — never by origin — and the
  // targetOrigin must be '*'. Nothing sent over the bridge is secret: theme
  // colours plus the data streams the user explicitly granted.
  function entryBySource(source) {
    for (const [instId, entry] of frames) {
      if (entry.frame && entry.frame.contentWindow === source) return { instId, entry };
    }
    return null;
  }
  function post(entry, msg) {
    try {
      if (entry.frame && entry.frame.contentWindow) entry.frame.contentWindow.postMessage({ xenonSdk: 1, ...msg }, '*');
    } catch { /* frame mid-teardown */ }
  }

  // Tell a widget its tile's pixel box + devicePixelRatio, so it can scale its
  // content to fit (see the "scale to fit" pattern in docs/WIDGET_SDK.md). This is
  // what lets a widget look IDENTICAL on the desktop browser and the Xeneon Edge —
  // the two surfaces give a tile a different pixel size and DPR, and viewport
  // units (vw/vh) resolve against the iframe's own box, so a fixed-design widget
  // scales by width/REF instead of reflowing. Change-detected (no spam), sent on
  // mount and on every tile resize via a per-entry ResizeObserver.
  function postSize(entry) {
    if (!entry || !entry.ready || !entry.frame) return;
    let r;
    try { r = entry.frame.getBoundingClientRect(); } catch { return; }
    const width = Math.round(r.width);
    const height = Math.round(r.height);
    if (!width || !height) return;   // not laid out / hidden — skip
    const dpr = window.devicePixelRatio || 1;
    if (entry.szW === width && entry.szH === height && entry.szDpr === dpr) return;
    entry.szW = width; entry.szH = height; entry.szDpr = dpr;
    post(entry, { type: 'size', width, height, dpr });
  }
  // Attach a ResizeObserver that lives ONLY on the entry (no shared registry), so
  // when the entry is dropped from `frames` and its frame from the DOM the whole
  // graph is unreferenced and GC'd — no leak, no explicit teardown at the ~13
  // frame-removal sites. No-op where ResizeObserver is unavailable.
  function observeSize(entry) {
    if (typeof ResizeObserver === 'undefined' || entry.ro) return;
    try { entry.ro = new ResizeObserver(() => postSize(entry)); entry.ro.observe(entry.frame); } catch { /* ignore */ }
  }
  function grantsFor(pkgId) {
    const g = sdk().grants;
    const grant = (g && typeof g === 'object') ? g[pkgId] : null;
    return {
      streams: (grant && Array.isArray(grant.streams)) ? grant.streams : [],
      actions: (grant && Array.isArray(grant.actions)) ? grant.actions : [],
      hosts: (grant && Array.isArray(grant.hosts)) ? grant.hosts : [],
      hooks: (grant && Array.isArray(grant.hooks)) ? grant.hooks : [],
      handlers: (grant && Array.isArray(grant.handlers)) ? grant.handlers : [],
      storage: !!(grant && grant.storage === true),
      secrets: !!(grant && grant.secrets === true),
      island: !!(grant && grant.island === true),
      badge: !!(grant && grant.badge === true),
      clipboard: !!(grant && grant.clipboard === true),
      // Addresses the user typed into the package's userHosts slots, keyed by
      // slot id. Raw — resolvedUserHosts() applies the manifest's rules.
      userHosts: (grant && grant.userHosts && typeof grant.userHosts === 'object' && !Array.isArray(grant.userHosts)) ? grant.userHosts : {},
    };
  }
  function actionAllowed(grant, action) {
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') return false;
    return grant.actions.some(cat => (ACTION_CATEGORIES[cat] || []).includes(action.type));
  }

  function entryCanRefreshLocalStream(entry) {
    if (!entry || entry.service || document.hidden || !entry.frame || !entry.frame.isConnected) return false;
    if (entry.ambient) return true;
    try { return onVisiblePage(entry.frame) && entry.frame.getClientRects().length > 0; }
    catch { return false; }
  }

  async function loadLocalStream(stream, force) {
    const spec = LOCAL_STREAM_LOADERS[stream];
    if (!spec) return null;
    const now = Date.now();
    if (!force && lastData[stream] !== undefined && now - (localStreamLoadedAt[stream] || 0) < spec.ttl) {
      return lastData[stream];
    }
    if (!localStreamInflight[stream]) {
      localStreamInflight[stream] = Promise.resolve(spec.load()).then((payload) => {
        localStreamLoadedAt[stream] = Date.now();
        onData(stream, payload);
        return payload;
      }).finally(() => { localStreamInflight[stream] = null; });
    }
    return localStreamInflight[stream];
  }

  async function onBridgeRefresh(entry, grant, msg) {
    const reqId = (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
    const stream = typeof msg.stream === 'string' ? msg.stream : '';
    if (!grant.streams.includes(stream) || !LOCAL_STREAM_LOADERS[stream]) {
      post(entry, { type: 'refresh_result', id: reqId, stream, ok: false, error: 'not_allowed' });
      return;
    }
    if (!entryCanRefreshLocalStream(entry)) {
      post(entry, { type: 'refresh_result', id: reqId, stream, ok: false, error: 'not_visible' });
      return;
    }
    const now = Date.now();
    if (!entry.lastRefresh) entry.lastRefresh = Object.create(null);
    if (now - (entry.lastRefresh[stream] || 0) < REFRESH_MIN_INTERVAL_MS) {
      post(entry, { type: 'refresh_result', id: reqId, stream, ok: false, error: 'rate_limited' });
      return;
    }
    entry.lastRefresh[stream] = now;
    try {
      const payload = await loadLocalStream(stream, msg.force === true);
      post(entry, { type: 'refresh_result', id: reqId, stream, ok: !!(payload && payload.ok), error: payload && payload.ok ? undefined : 'unavailable' });
    } catch {
      post(entry, { type: 'refresh_result', id: reqId, stream, ok: false, error: 'offline' });
    }
  }

  async function onBridgeAction(entry, grant, msg) {
    const reqId = (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
    const now = Date.now();
    if (now - (entry.lastAction || 0) < ACTION_MIN_INTERVAL_MS) {
      post(entry, { type: 'action_result', id: reqId, ok: false, error: 'rate_limited' });
      return;
    }
    entry.lastAction = now;
    if (!actionAllowed(grant, msg.action)) {
      post(entry, { type: 'action_result', id: reqId, ok: false, error: 'not_allowed' });
      return;
    }
    // Soundboard is browser-played (no server registry case): dispatch to
    // deck.js's shared player on THIS surface. SDK-originated playSound may
    // only name an installed pack's clip — the pack-relative regex is the gate.
    if (msg.action.type === 'playSound' || msg.action.type === 'soundStopAll') {
      let ok = false;
      if (!window.DeckSoundPlayer) {
        post(entry, { type: 'action_result', id: reqId, ok: false, error: 'unavailable' });
        return;
      }
      if (msg.action.type === 'soundStopAll') {
        ok = !!DeckSoundPlayer.stopAll();
      } else if (SDK_SOUND_FILE_RE.test(String(msg.action.file || ''))) {
        ok = !!(await DeckSoundPlayer.play(msg.action));
      } else {
        post(entry, { type: 'action_result', id: reqId, ok: false, error: 'not_allowed' });
        return;
      }
      post(entry, { type: 'action_result', id: reqId, ok, error: ok ? undefined : 'failed' });
      return;
    }
    const d = await api('/actions/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.action),
    });
    post(entry, { type: 'action_result', id: reqId, ok: !!(d && d.ok), error: (d && d.error) || (d ? undefined : 'offline') });
  }

  // Proxied fetch: the sandboxed frame has no network (CSP), so the host relays
  // granted requests to POST /sdk/fetch, where the server re-validates the URL
  // against the package's manifest allowlist. The grant check here is the user-
  // consent half; the manifest check server-side is the authority half.
  async function onBridgeFetch(entry, grant, msg) {
    const reqId = (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
    const reply = (extra) => post(entry, Object.assign({ type: 'fetch_result', id: reqId }, extra));
    const now = Date.now();
    if (now - (entry.lastFetch || 0) < FETCH_MIN_INTERVAL_MS) { reply({ ok: false, error: 'rate_limited' }); return; }
    entry.lastFetch = now;
    let host = '';
    try { host = new URL(String(msg.url || '')).hostname.toLowerCase().replace(/\.$/, ''); } catch { /* fall through */ }
    // Declared hosts the user approved, plus the addresses they typed into the
    // package's userHosts slots (filling a slot IS the approval).
    const filled = resolvedUserHosts(packageById(entry.pkgId), grant).hosts;
    if (!host || !(grant.hosts.includes(host) || filled.includes(host))) { reply({ ok: false, error: 'host_not_allowed' }); return; }
    const d = await api('/sdk/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pkg: entry.pkgId, url: msg.url, method: msg.method, headers: msg.headers, body: msg.body }),
    });
    if (!d) { reply({ ok: false, error: 'offline' }); return; }
    reply({ ok: !!d.ok, status: d.status, contentType: d.contentType, location: d.location, encoding: d.encoding, body: d.body, error: d.error });
  }

  // Persistent store relay: the sandboxed frame has no localStorage, so the host
  // relays get/set/delete/keys/clear to POST /sdk/store, where the server scopes
  // the data to the package (or its shared storageGroup) and enforces the caps.
  // The grant check here is the consent half; the server re-checks the grant and
  // the manifest `storage` flag (authority). Reply carries the op result verbatim.
  async function onBridgeStore(entry, grant, msg) {
    const reqId = (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
    const reply = (extra) => post(entry, Object.assign({ type: 'store_result', id: reqId }, extra));
    if (!grant.storage) { reply({ ok: false, error: 'not_granted' }); return; }
    const d = await api('/sdk/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `quiet` marks a write made while this package is still settling after a
      // sync re-mount: stored, but not broadcast back (see onStoreChanged).
      body: JSON.stringify({ pkg: entry.pkgId, op: msg.op, origin: SURFACE_ID, quiet: storeWriteIsQuiet(entry.pkgId) }),
    });
    if (!d) { reply({ ok: false, error: 'offline' }); return; }
    reply({ ok: !!d.ok, value: d.value, keys: d.keys, error: d.error });
  }

  // Secret vault relay: SET/DELETE a named key, or LIST names / test existence.
  // A read NEVER carries a value back (the server won't return one) — secrets are
  // consumed only by {{secret:NAME}} substitution inside the fetch proxy.
  async function onBridgeSecret(entry, grant, msg) {
    const reqId = (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
    const reply = (extra) => post(entry, Object.assign({ type: 'secret_result', id: reqId }, extra));
    if (!grant.secrets) { reply({ ok: false, error: 'not_granted' }); return; }
    const d = await api('/sdk/secret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pkg: entry.pkgId, op: msg.op }),
    });
    if (!d) { reply({ ok: false, error: 'offline' }); return; }
    reply({ ok: !!d.ok, names: d.names, has: d.has, error: d.error });
  }

  // Deck state publish: a widget may only publish state ids DECLARED in its
  // manifest; values are coerced to safe primitives and fanned out to the Deck
  // snapshot (same consumption path as the Streamer.bot globals). Change-detected
  // (an unchanged republish is a no-op — no clone, no DOM pass) and coalesced by
  // a trailing flush so a rapid burst still lands its LATEST value rather than
  // silently dropping it (a leading-edge time gate would lose the newest state).
  function onBridgeState(entry, msg) {
    const pkg = packageById(entry.pkgId);
    const declared = (pkg && pkg.deck && Array.isArray(pkg.deck.states)) ? pkg.deck.states : [];
    const id = typeof msg.id === 'string' ? msg.id : '';
    if (!declared.some(s => s && s.id === id)) return;
    let value = msg.value;
    if (typeof value !== 'boolean' && typeof value !== 'number') value = String(value == null ? '' : value).slice(0, 200);
    const key = entry.pkgId + '/' + id;
    // Optional rich face meta a bound key can DISPLAY (key.live badge): short
    // label, tiny icon text and a strictly hex-validated colour. Bounded and
    // rebuilt key-by-key — hostile widget strings never reach markup or CSS.
    let meta = null;
    if (msg.label != null || msg.icon != null || msg.color != null) {
      meta = {};
      const label = String(msg.label == null ? '' : msg.label).slice(0, 24);
      if (label) meta.label = label;
      const icon = String(msg.icon == null ? '' : msg.icon).slice(0, 8);
      if (icon) meta.icon = icon;
      const color = String(msg.color == null ? '' : msg.color).trim();
      if (/^#[0-9a-fA-F]{3,8}$/.test(color)) meta.color = color;
      if (!Object.keys(meta).length) meta = null;
    }
    const metaChanged = JSON.stringify(sdkStateMeta[key] || null) !== JSON.stringify(meta);
    if (sdkStates[key] === value && !metaChanged) return;   // no change → no work
    sdkStates[key] = value;
    if (meta) sdkStateMeta[key] = meta;
    else delete sdkStateMeta[key];
    scheduleSdkStateFlush();
  }
  let sdkStateFlushTimer = null;
  let sdkStateFlushAt = 0;
  function scheduleSdkStateFlush() {
    if (sdkStateFlushTimer) return;   // a flush is already pending; it'll carry the latest values
    const since = Date.now() - sdkStateFlushAt;
    const wait = since >= STATE_MIN_INTERVAL_MS ? 0 : (STATE_MIN_INTERVAL_MS - since);
    sdkStateFlushTimer = setTimeout(() => {
      sdkStateFlushTimer = null;
      sdkStateFlushAt = Date.now();
      if (window.Deck && typeof window.Deck.refreshStates === 'function') {
        window.Deck.refreshStates({
          sdkStates: Object.assign({}, sdkStates),
          sdkStateMeta: Object.assign({}, sdkStateMeta),
        });
      }
      // Mirror to the server (loopback POST, change-driven — this flush only
      // runs when a state actually changed): the Virtual Deck popup hosts no
      // widget frames, so without the `sdk_states` SSE relay its sdkState keys
      // and live faces would stay permanently dark.
      api('/sdk/deck-states', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ states: sdkStates, meta: sdkStateMeta }),
      });
    }, wait);
  }

  // Island projection: a widget with the `island` capability may show ONE short
  // plain-text line — plus an optional dimmed follow-up line (`next`) — in the
  // minimal-topbar dynamic island. Same trust shape as onBridgeState — manifest
  // declaration + user grant, values coerced to bounded plain strings,
  // host-rendered via textContent (SdkIsland). Updates are coalesced by a
  // per-entry trailing flush so a rapid burst lands its LATEST text instead of
  // being dropped. The text never leaves this page.
  function onBridgeIsland(entry, grant, msg) {
    const pkg = packageById(entry.pkgId);
    if (!pkg || pkg.island !== true || !grant.island) return;
    const coerce = (v) => String(v == null ? '' : v)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, ISLAND_TEXT_MAX);
    let text = coerce(msg.text);
    let next = coerce(msg.next);
    let badge = coerce(msg.badge).slice(0, 16);   // tiny corner chip (speed, %…)
    if (msg.op === 'clear' || !text) { text = ''; next = ''; badge = ''; }
    entry.islandText = text;   // latest wins; the flush reads this
    entry.islandNext = next;
    entry.islandBadge = badge;
    if (entry.islandFlushTimer) return;   // a flush is pending; it carries the latest text
    const since = Date.now() - (entry.islandFlushAt || 0);
    const wait = since >= ISLAND_MIN_INTERVAL_MS ? 0 : (ISLAND_MIN_INTERVAL_MS - since);
    entry.islandFlushTimer = setTimeout(() => {
      entry.islandFlushTimer = null;
      entry.islandFlushAt = Date.now();
      if (!window.SdkIsland) return;
      if (entry.islandText) SdkIsland.show(entry.pkgId, entry.islandText, entry.islandNext, entry.islandBadge);
      else SdkIsland.clear(entry.pkgId);
    }, wait);
  }

  // Persistent badge chip: a widget with the `badge` capability may show a
  // small always-on text chip next to the clock — unlike `island` (one shared
  // slot, transient), several distinct granted packages may each hold a chip
  // at once (capped host-side by SdkBadges). Same trust shape as
  // onBridgeIsland: manifest + grant checked, bounded plain strings,
  // host-rendered via textContent.
  //
  // `icon` + `color` are the optional display meta, the same shape (and the
  // same strict hex test) a deck key's live badge already accepts from a
  // widget — the glyph's colour is the widget's own identity (a star is gold,
  // not accent green), and the host has no business guessing it from the text.
  // A colour that isn't plain hex is dropped, never passed through: the chip
  // then renders the glyph in the topbar's own text colour.
  function onBridgeBadge(entry, grant, msg) {
    const pkg = packageById(entry.pkgId);
    if (!pkg || pkg.badge !== true || !grant.badge) return;
    const coerce = (v, max) => {
      const s = String(v == null ? '' : v);
      let out = '';
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        out += (c <= 31 || c === 127) ? ' ' : s[i];
      }
      return out.trim().slice(0, max);
    };
    let text = coerce(msg.text, BADGE_TEXT_MAX);
    let tooltip = coerce(msg.tooltip, BADGE_TOOLTIP_MAX);
    let icon = coerce(msg.icon, BADGE_ICON_MAX);
    const rawColor = String(msg.color == null ? '' : msg.color).trim();
    let color = /^#[0-9a-fA-F]{3,8}$/.test(rawColor) ? rawColor : '';
    if (msg.op === 'clear' || !text) { text = ''; tooltip = ''; icon = ''; color = ''; }
    entry.badgeText = text;   // latest wins; the flush reads this
    entry.badgeTooltip = tooltip;
    entry.badgeIcon = icon;
    entry.badgeColor = color;
    if (entry.badgeFlushTimer) return;   // a flush is pending; it carries the latest text
    const since = Date.now() - (entry.badgeFlushAt || 0);
    const wait = since >= BADGE_MIN_INTERVAL_MS ? 0 : (BADGE_MIN_INTERVAL_MS - since);
    entry.badgeFlushTimer = setTimeout(() => {
      entry.badgeFlushTimer = null;
      entry.badgeFlushAt = Date.now();
      if (!window.SdkBadges) return;
      if (entry.badgeText) SdkBadges.set(entry.pkgId, entry.badgeText, entry.badgeTooltip, entry.badgeIcon, entry.badgeColor);
      else SdkBadges.clear(entry.pkgId);
    }, wait);
  }

  // Clipboard copy request. Deliberately NOT a silent write: the widget only ASKS,
  // and the actual navigator.clipboard write happens inside a host-rendered
  // confirmation the user taps (openClipboardConfirm). This is load-bearing —
  // user activation propagates from a sandboxed iframe to the host and stays live
  // for ~3-4s after ANY tap, so forwarding the widget's message straight to the
  // clipboard would let a widget rewrite the clipboard off an unrelated tap. Tying
  // the write to a fresh host tap the user reads makes the gesture unambiguous.
  // Write-only, no read op exists. We ALWAYS reply (the native write promise can
  // hang forever otherwise), and reject control chars rather than silently
  // scrubbing them — a scrubbed password is a wrong password the user won't notice.
  function onBridgeClipboard(entry, grant, msg) {
    const reqId = (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
    const reply = (ok, error) => post(entry, { type: 'clipboard_result', id: reqId, ok, error });
    const pkg = packageById(entry.pkgId);
    if (!pkg || pkg.clipboard !== true || !grant.clipboard) { reply(false, 'not_allowed'); return; }

    const now = Date.now();
    if (now - (entry.clipAt || 0) < CLIP_MIN_INTERVAL_MS) { reply(false, 'rate_limited'); return; }
    entry.clipAt = now;

    const text = typeof msg.text === 'string' ? msg.text : '';
    if (!text) { reply(false, 'empty'); return; }
    if (text.length > CLIP_TEXT_MAX) { reply(false, 'too_long'); return; }
    // Reject C0/C1/DEL control chars outright — a credential copy never needs them,
    // and stripping would hand back a corrupted value.
    if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) { reply(false, 'bad_text'); return; }

    // The label is display-only chrome ("GitHub password"); scrubbing it is fine.
    const label = String(msg.label == null ? '' : msg.label)
      .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CLIP_LABEL_MAX);
    // `secret: false` lets the widget mark a non-sensitive copy (a TOTP code) so the
    // prompt can show it in full; anything else is masked.
    const secret = msg.secret !== false;

    openClipboardConfirm({ pkgId: entry.pkgId, label, text, secret })
      .then((ok) => reply(!!ok, ok ? undefined : 'declined'));
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || d.xenonSdk !== 1 || typeof d.type !== 'string') return;
    const hit = entryBySource(e.source);
    if (!hit) return;
    const { entry } = hit;
    const grant = grantsFor(entry.pkgId);
    if (d.type === 'hello') {
      entry.ready = true;
      post(entry, {
        type: 'init',
        api: 1,
        pkgId: entry.pkgId,   // the package id — lets a widget build /sdk/tile/<id> URLs
        theme: themePayload(entry),
        lang: langCode(),
        streams: grant.streams.slice(),
        actions: grant.actions.slice(),
        hosts: grant.hosts.slice(),
        // Addresses the user typed into this package's declared userHosts slots,
        // keyed by slot id, each with a ready-to-use `base` to concatenate a
        // path onto. A slot the user hasn't filled is simply absent.
        userHosts: resolvedUserHosts(packageById(entry.pkgId), grant).byId,
        hooks: grant.hooks.slice(),
        handlers: grant.handlers.slice(),
        storage: grant.storage,
        secrets: grant.secrets,
        // Unlike island/badge (host-rendered, so the widget need not know), a
        // clipboard copy is widget-initiated and returns a result — the widget
        // needs to know it was granted so it can show an honest copy affordance.
        clipboard: grant.clipboard,
      });
      grant.streams.forEach(stream => {
        if (lastData[stream] !== undefined) post(entry, { type: 'data', stream, data: lastData[stream] });
      });
      // Push-on-change stream with no cold-start snapshot — fetch one, then it
      // reaches this frame (and every other) through the normal onData fan-out.
      if (grant.streams.includes('discord') && lastData.discord === undefined) seedDiscordStream();
      entry.szW = entry.szH = entry.szDpr = undefined;   // force the first size to send
      postSize(entry);   // initial tile size, now that the widget is listening
    } else if (d.type === 'action') {
      if (entry.ready) onBridgeAction(entry, grant, d);
    } else if (d.type === 'fetch') {
      if (entry.ready) onBridgeFetch(entry, grant, d);
    } else if (d.type === 'refresh') {
      if (entry.ready) onBridgeRefresh(entry, grant, d);
    } else if (d.type === 'store') {
      if (entry.ready) onBridgeStore(entry, grant, d);
    } else if (d.type === 'secret') {
      if (entry.ready) onBridgeSecret(entry, grant, d);
    } else if (d.type === 'state') {
      if (entry.ready) onBridgeState(entry, d);
    } else if (d.type === 'island') {
      if (entry.ready) onBridgeIsland(entry, grant, d);
    } else if (d.type === 'badge') {
      if (entry.ready) onBridgeBadge(entry, grant, d);
    } else if (d.type === 'clipboard') {
      if (entry.ready) onBridgeClipboard(entry, grant, d);
    } else if (d.type === 'handler_ack') {
      // The widget answered a dispatched deck-handler call. The sandboxed frame
      // has no network, so the HOST page relays the ack to the parked
      // /actions/run response (first ack wins server-side; dupes are no-ops).
      if (entry.ready && typeof d.callId === 'string' && d.callId.length <= 64) {
        api('/sdk/handler-ack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callId: d.callId, ok: d.ok !== false, error: typeof d.error === 'string' ? d.error.slice(0, 80) : undefined }),
        });
      }
    }
  });

  // The user's own fan names (Fans widget → tap to rename, persisted in settings
  // as fanLabels) must reach sandboxed widgets too: the board only ever says
  // "Fan #1", so a widget seeing the raw sensor name shows a different label than
  // every builtin surface for the same fan — and loses the ONE clue that a header
  // drives a pump rather than a case fan (which is how a widget ends up painting
  // a healthy AIO pump at permanent redline). Copy-on-write: the payload is
  // shared with the builtin tiles, so it is never mutated in place.
  function withFanLabels(payload) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.fans)) return payload;
    const labels = (typeof window.getFanLabels === 'function') ? window.getFanLabels() : null;
    if (!labels) return payload;
    let touched = false;
    const fans = payload.fans.map((f) => {
      if (!f || typeof f !== 'object') return f;
      const custom = labels[(f.kind || 'mb') + '|' + String(f.name)];
      if (typeof custom !== 'string' || !custom) return f;
      touched = true;
      return { ...f, name: custom };
    });
    return touched ? { ...payload, fans } : payload;
  }

  // SSE relay (called from main.js): cache + fan out to granted, ready frames.
  // Always cache lastData so a frame returning to view gets fresh data on the next
  // tick, but don't post to a hidden tab or to a frame parked on a non-current pager
  // page — a sandboxed widget shouldn't re-render (or wake its timers) off-screen.
  function onData(stream, payload) {
    if (stream === 'system') payload = withFanLabels(payload);
    lastData[stream] = payload;
    for (const [, entry] of frames) {
      // A background service frame is deliberately ALWAYS fed — even with the
      // dashboard tab hidden: it exists exactly to keep the package's deck
      // handlers/states alive while the user drives keys from another surface
      // (e.g. the Virtual Deck popup). Everything else is gated on visibility:
      // an ambient scene frame only exists while its overlay is open, and tile
      // frames additionally need their pager page on screen.
      if (entry.service) {
        if (entry.ready && grantsFor(entry.pkgId).streams.includes(stream)) post(entry, { type: 'data', stream, data: payload });
        continue;
      }
      if (document.hidden) continue;
      const visible = entry.ambient ? true : onVisiblePage(entry.frame);
      if (entry.ready && visible && grantsFor(entry.pkgId).streams.includes(stream)) {
        post(entry, { type: 'data', stream, data: payload });
      }
    }
  }

  // The `discord` stream is SSE push-ON-CHANGE: server.js emits it only when the
  // voice state actually moves, so on a cold page nothing has ever been pushed and
  // `lastData.discord` is undefined — a widget mounting then gets no seed at all
  // and can only conclude "not linked", even with Discord open and the account
  // linked. The builtin widget dodges this by seeding itself from the REST
  // endpoints; an SDK widget is sandboxed with no network, so the HOST must seed
  // the stream on its behalf — in the exact shape server.js broadcasts, or the
  // widget would have to understand two payload dialects. One shared in-flight
  // promise: several frames mounting together seed once.
  async function seedDiscordStream() {
    if (lastData.discord !== undefined || discordSeedInflight) return;
    discordSeedInflight = (async () => {
      try {
        const s = await api('/stream/discord/status');
        if (!s || lastData.discord !== undefined) return;
        // `connected` is "the ACCOUNT is linked" on both sides: server.js derives it
        // from voice.connected, which the RPC layer sets to the linked flag when the
        // pipe is down and hardcodes true when it's up. status.connected is that same
        // linked flag, so the two agree.
        const connected = !!s.connected;
        const voice = connected ? await api('/stream/discord/voice').catch(() => null) : null;
        // A real push landing mid-fetch is fresher than this snapshot — let it win.
        if (lastData.discord !== undefined) return;
        const payload = {
          connected,
          login: s.login || '',
          voice: (voice && typeof voice === 'object') ? voice : null,
          notif: s.notif || 'off',
        };
        // NOT via onData: its fan-out drops frames whose pager page isn't on
        // screen, which is a sound rule for a live stream (don't feed an offscreen
        // widget 30 pushes a second) and exactly wrong for a cold-start snapshot.
        // This resolves milliseconds into boot, before the pager has marked its
        // active page, so every frame reads as invisible and the seed would be
        // thrown away — and with lastData now set, nothing would ever retry: the
        // widget sits on "not linked" for the whole session. A seed is a replay,
        // like the hello one above, so it reaches every frame that asked for it.
        lastData.discord = payload;
        for (const [, entry] of frames) {
          if (entry.ready && grantsFor(entry.pkgId).streams.includes('discord')) {
            post(entry, { type: 'data', stream: 'discord', data: payload });
          }
        }
      } catch { /* offline / Discord not configured → the widget's unlinked view is correct */ }
      finally { discordSeedInflight = null; }
    })();
  }

  // A page scrolling back into view brings its widgets back from the dead: while
  // parked they were cut off from onData (see its visibility gate), so each one is
  // showing whatever it last saw — possibly minutes old, and with no scheduled
  // correction, because most of these feeds only push when something CHANGES.
  // Hand every frame that just became visible the current snapshot of the streams
  // it was granted; the values are already in hand, so this costs no network and
  // the widget's own change-detection absorbs a repeat of what it already has.
  function replayToVisibleFrames() {
    if (document.hidden) return;
    for (const [, entry] of frames) {
      if (!entry.ready || entry.service || entry.ambient) continue;   // never gated → never stale
      if (!onVisiblePage(entry.frame)) continue;
      const streams = grantsFor(entry.pkgId).streams;
      streams.forEach(stream => {
        if (lastData[stream] !== undefined) post(entry, { type: 'data', stream, data: lastData[stream] });
      });
    }
  }
  window.addEventListener('xenon:page-change', replayToVisibleFrames);

  // A live DM/mention is an event, while SDK widgets consume the notifications
  // feed as a snapshot. Fold it into the cached snapshot and keep hide=true when
  // no seed has been loaded yet, so private body text is never revealed by
  // default merely because the first thing observed was a live event.
  function onDiscordNotification(item) {
    if (!item || typeof item !== 'object') return;
    const prev = lastData.discordNotifications;
    const items = (prev && Array.isArray(prev.items)) ? prev.items.slice() : [];
    items.push(item);
    if (items.length > 40) items.splice(0, items.length - 40);
    onData('discordNotifications', {
      ok: true,
      enabled: true,
      hide: prev ? !!prev.hide : true,
      state: 'ok',
      items,
    });
  }

  // Local webhook event (SSE `sdk_hook`, relayed from main.js): forward to the
  // matching package's frames when the user granted that hook id. Unlike stream
  // data, hooks are EVENTS — they're delivered to off-page frames too (a widget
  // may turn one into a Deck state), and there's no replay for late frames.
  function onHook(payload) {
    if (!payload || typeof payload !== 'object') return;
    const pkgId = String(payload.pkg || '');
    const hook = String(payload.hook || '');
    if (!pkgId || !hook) return;
    if (!grantsFor(pkgId).hooks.includes(hook)) return;   // grant is per-package, not per-frame
    for (const [, entry] of frames) {
      if (entry.ready && entry.pkgId === pkgId) post(entry, { type: 'hook', hook, data: payload.data });
    }
  }

  // A deck key bound to this package's handler was pressed (SSE `sdk_handler`,
  // relayed from main.js): forward to exactly ONE of the package's live frames.
  // Delivering to every frame would run the handler once per mirrored tile plus
  // once in the service frame — only the ack is deduped server-side, the side
  // effects (a webhook via /sdk/fetch, a state mutation) are not. Preference:
  // the service frame (always alive, exists for this), else the first ready one.
  function onHandler(payload) {
    if (!payload || typeof payload !== 'object') return;
    const pkgId = String(payload.pkg || '');
    const handler = String(payload.handler || '');
    if (!pkgId || !handler) return;
    if (!grantsFor(pkgId).handlers.includes(handler)) return;
    let target = null;
    for (const [, entry] of frames) {
      if (!entry.ready || entry.pkgId !== pkgId) continue;
      if (entry.service) { target = entry; break; }
      if (!target) target = entry;
    }
    if (target) post(target, { type: 'handler', handler, args: payload.args || {}, callId: String(payload.callId || '') });
  }

  // A widget's persistent store was written on ANOTHER surface (SSE `sdk_store`,
  // relayed from main.js). The sandboxed frame reads its store only at mount, so
  // re-mount every live frame of the affected package(s) — it reloads and re-reads
  // the now-updated store, bringing this surface 1:1 with where the edit was made
  // (GitHub #109: "adjustments in the browser don't appear on the XENON"). We do
  // NOT bump assetVersion: the files didn't change, only the stored data, so the
  // no-cache+ETag re-fetch on re-mount is cheap. Our own write is filtered out by
  // origin === SURFACE_ID so we never yank a frame the user is mid-edit on.
  //
  // Two guards keep this from feeding itself, and BOTH are load-bearing. A widget
  // that saves its own state as it starts (a cache, a "last updated" stamp — the
  // norm, not the exception) writes again as soon as we re-mount it. Without the
  // guards that write broadcasts back, the first surface re-mounts, its widget
  // writes, and the two surfaces bounce off each other forever: the widget
  // visibly reloads over and over on both screens. That regression shipped in
  // v4.6.1 and is what these guards close.
  //
  //  1. QUIET WINDOW. For a moment after a sync re-mount, writes from that
  //     package are sent with `quiet: true` and the server stores them without
  //     broadcasting (see POST /sdk/store). Start-up writes therefore land but
  //     stay silent, so the echo dies at the first hop. Deliberately short: a
  //     genuine user edit made inside the window would not propagate, and losing
  //     a real edit is worse than a slightly late sync.
  //  2. COOLDOWN. A package we just re-mounted is not re-mounted again for
  //     SYNC_REMOUNT_COOLDOWN_MS. Guard 1 handles the widget's own echo; this
  //     bounds everything else (a peer on a fast refresh timer, three surfaces
  //     open at once) so the worst case is one reload per window, never a storm.
  const SYNC_QUIET_MS = 4000;
  const SYNC_REMOUNT_COOLDOWN_MS = 15000;
  const _syncQuietUntil = new Map();     // pkgId → ts: writes stay unbroadcast until
  const _syncRemountedAt = new Map();    // pkgId → ts of our last sync re-mount
  // Is a write from this package currently a re-mount echo rather than a user change?
  function storeWriteIsQuiet(pkgId) {
    return Date.now() < (_syncQuietUntil.get(pkgId) || 0);
  }
  let _storeChangedPkgs = new Set();
  let _storeChangedTimer = null;
  function onStoreChanged(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.origin && payload.origin === SURFACE_ID) return;   // our own write
    const pkgs = Array.isArray(payload.pkgs)
      ? payload.pkgs
      : (payload.pkg ? [payload.pkg] : []);
    for (const p of pkgs) if (p) _storeChangedPkgs.add(String(p));
    if (!_storeChangedPkgs.size || _storeChangedTimer) return;
    // Coalesce a burst of writes (a widget that saves state rapidly) into ONE
    // re-mount per package over a 400ms window, so a chatty store can never turn
    // into a remount storm on the peer surface — mirrors the settings SSE coalesce.
    _storeChangedTimer = setTimeout(() => {
      _storeChangedTimer = null;
      const wanted = _storeChangedPkgs;
      _storeChangedPkgs = new Set();
      const now = Date.now();
      let hit = false;
      for (const [instId, entry] of frames) {
        if (instId === AMBIENT_INST_ID) continue;   // AmbientMode owns its frame lifecycle
        if (!wanted.has(entry.pkgId)) continue;
        if (now - (_syncRemountedAt.get(entry.pkgId) || 0) < SYNC_REMOUNT_COOLDOWN_MS) continue;
        _syncRemountedAt.set(entry.pkgId, now);
        _syncQuietUntil.set(entry.pkgId, now + SYNC_QUIET_MS);
        try { entry.frame.remove(); } catch {}
        frames.delete(instId);
        hit = true;
      }
      if (hit) paint();
    }, 400);
  }

  // ── Service frames (background packages) ─────────────────────────
  // A granted package that declares handlers AND `background: true` gets a
  // hidden sandboxed frame so its deck keys answer even with no tile on screen.
  // Same sandbox + registry as every frame; capped; torn down when the grant or
  // the package goes away (the sweep runs on every package/grant refresh).
  const SERVICE_FRAMES_MAX = 4;
  function serviceHost() {
    let host = document.getElementById('sdk-service-frames');
    if (!host) {
      host = el('div', '');
      host.id = 'sdk-service-frames';
      host.style.display = 'none';
      document.body.appendChild(host);
    }
    return host;
  }
  function syncServiceFrames() {
    const wanted = new Map();   // 'svc:'+pkgId → pkg
    if (sdk().enabled === true) {
      let count = 0;
      for (const pkg of ((pkgCache && pkgCache.packages) || [])) {
        if (count >= SERVICE_FRAMES_MAX) break;
        if (!pkg || pkg.background !== true) continue;
        const grant = grantsFor(pkg.id);
        // Two things outlive a tile and so justify a headless frame: granted deck
        // handlers (keys must answer) and a granted badge (the chip must stay in
        // the topbar, and keep refreshing, once the tile is gone). Nothing
        // granted → no frame.
        const declared = (pkg.deck && Array.isArray(pkg.deck.handlers)) ? pkg.deck.handlers : [];
        const handlersLive = declared.some(h => grant.handlers.includes(h.id));
        const badgeLive = pkg.badge === true && grant.badge;
        if (!handlersLive && !badgeLive) continue;
        wanted.set('svc:' + pkg.id, pkg);
        count++;
      }
    }
    // Tear down service frames no longer wanted.
    for (const [key, entry] of Array.from(frames)) {
      if (!key.startsWith('svc:')) continue;
      if (!wanted.has(key)) { try { entry.frame.remove(); } catch {} frames.delete(key); }
    }
    // Mount the missing ones.
    for (const [key, pkg] of wanted) {
      const existing = frames.get(key);
      if (existing && existing.pkgId === pkg.id && existing.assetVersion === assetVersion && existing.frame.isConnected) continue;
      if (existing) { try { existing.frame.remove(); } catch {} frames.delete(key); }
      const frame = document.createElement('iframe');
      frame.className = 'cw-frame cw-frame--service';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.title = pkg.name;
      frame.src = '/sdk/widget/' + encodeURIComponent(pkg.id) + '/' + pkg.entry + '?v=' + assetVersion;
      frames.set(key, { frame, pkgId: pkg.id, ready: false, lastAction: 0, service: true, assetVersion });
      serviceHost().appendChild(frame);
    }
  }

  // Theme changed (called from settings.js after applyHubSettings).
  function refreshTheme() {
    for (const [, entry] of frames) {
      if (entry.ready) post(entry, { type: 'theme', theme: themePayload(entry) });
    }
  }

  // ── Permission dialog ────────────────────────────────────────────
  function closePermDialog() {
    const bd = document.querySelector('.cw-perm-backdrop');
    if (bd) bd.remove();
  }

  // ── Clipboard copy confirmation ──────────────────────────────────
  // The host-drawn gate that makes the `clipboard` capability safe. The widget's
  // request lands here; the real navigator.clipboard write only happens inside the
  // Copy button's click handler below, so the user activation that authorises it is
  // unambiguously the user approving THIS copy — never an unrelated tap the widget
  // rode. Resolves the onBridgeClipboard promise: true = copied, false = declined/
  // superseded/timed out. Only one prompt exists at a time.
  let clipCloseTimer = null;
  function closeClipConfirm(result) {
    const bd = document.querySelector('.cw-clip-backdrop');
    if (!bd) return;
    const resolve = bd._resolve;
    bd.remove();
    if (clipCloseTimer) { clearTimeout(clipCloseTimer); clipCloseTimer = null; }
    if (typeof resolve === 'function') resolve(result === true);
  }
  function openClipboardConfirm({ pkgId, label, text, secret }) {
    closeClipConfirm(false);   // a fresh request supersedes any pending one (declined)
    return new Promise((resolve) => {
      const pkg = packageById(pkgId);
      const who = (pkg && pkg.name) ? pkg.name : t('cw_clip_widget', 'A widget');
      const bd = el('div', 'cw-clip-backdrop');
      bd._resolve = resolve;
      const panel = el('div', 'cw-clip');
      panel.appendChild(el('div', 'cw-clip-title', t('cw_clip_title', 'Copy to clipboard?')));

      const whatLine = el('div', 'cw-clip-what');
      whatLine.appendChild(el('span', 'cw-clip-who', who));
      if (label) whatLine.appendChild(el('span', 'cw-clip-label', label));
      panel.appendChild(whatLine);

      // Preview. A secret (password) is masked by default; the user can reveal it —
      // it is their own value and they are about to copy it. A non-secret (a TOTP
      // code the widget flagged secret:false) shows in full so they can sanity-check.
      const preview = el('div', 'cw-clip-preview');
      const val = el('span', 'cw-clip-val');
      const maskText = () => '•'.repeat(Math.min(Math.max(text.length, 4), 24));
      val.textContent = secret ? maskText() : text;
      preview.appendChild(val);
      if (secret) {
        const eye = el('button', 'cw-clip-eye');
        eye.type = 'button';
        let shown = false;
        const paint = () => { eye.textContent = shown ? t('cw_clip_hide', 'Hide') : t('cw_clip_show', 'Show'); val.textContent = shown ? text : maskText(); };
        eye.addEventListener('click', () => { shown = !shown; paint(); });
        paint();
        preview.appendChild(eye);
      }
      panel.appendChild(preview);
      panel.appendChild(el('div', 'cw-clip-note', t('cw_clip_note', 'Xenon puts this on your clipboard only when you tap Copy. It can never read your clipboard.')));

      const row = el('div', 'cw-clip-actions');
      const cancel = el('button', 'cw-btn', t('cw_cancel', 'Cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', () => closeClipConfirm(false));
      const copy = el('button', 'cw-btn cw-btn--primary', t('cw_clip_copy', 'Copy'));
      copy.type = 'button';
      copy.addEventListener('click', async () => {
        if (copy.disabled) return;
        copy.disabled = true;
        // Inside a real user gesture → the clipboard write is permitted.
        const ok = await copyText(text);
        closeClipConfirm(ok);
        if (ok && window.XenonToast) {
          try { XenonToast.show({ type: 'success', title: t('cw_clip_done', 'Copied'), message: label || who, duration: 2200 }); } catch (_) { /* toast is optional */ }
        }
      });
      row.append(cancel, copy);
      panel.appendChild(row);

      bd.appendChild(panel);
      bd.addEventListener('click', (ev) => { if (ev.target === bd) closeClipConfirm(false); });
      document.body.appendChild(bd);
      setTimeout(() => { try { copy.focus(); } catch (_) { /* focus is best-effort */ } }, 0);
      // A forgotten prompt resolves (declined) rather than pinning the widget forever.
      clipCloseTimer = setTimeout(() => closeClipConfirm(false), 20000);
    });
  }
  // instId assigns the package to a tile on Allow; pass instId = null (with an
  // optional onAllow callback) to grant without assigning — used by AmbientMode,
  // where the "assignment" is ambientMode.sceneId, not a tile.
  function openPermDialog(pkg, instId, onAllow) {
    closePermDialog();
    const bd = el('div', 'cw-perm-backdrop');
    const panel = el('div', 'cw-perm');
    panel.appendChild(el('div', 'cw-perm-title', t('cw_perm_title', 'Allow this widget?')));
    const who = el('div', 'cw-perm-pkg');
    who.appendChild(el('span', 'cw-perm-name', pkg.name));
    const meta = [pkg.author ? t('cw_by', 'by').replace('{a}', pkg.author) : '', pkg.version ? 'v' + pkg.version : ''].filter(Boolean).join(' · ');
    if (meta) who.appendChild(el('span', 'cw-perm-meta', meta));
    panel.appendChild(who);
    if (pkg.description) panel.appendChild(el('div', 'cw-perm-desc', pkg.description));

    const addSection = (labelKey, labelFb, ids, labels) => {
      panel.appendChild(el('div', 'cw-perm-sec', t(labelKey, labelFb)));
      const box = el('div', 'cw-perm-chips');
      ids.forEach(id => {
        const lb = labels[id];
        box.appendChild(el('span', 'cw-perm-chip', lb ? t(lb[0], lb[1]) : id));
      });
      panel.appendChild(box);
    };
    // Manifest extensions (all optional): declared proxy hosts, local webhook
    // ids, and Deck contributions. Untrusted manifest text → textContent only.
    // addSection already renders the raw id via textContent when no label map
    // entry exists, so these reuse it with an empty label map.
    const hosts = Array.isArray(pkg.hosts) ? pkg.hosts : [];
    const userHostSlots = Array.isArray(pkg.userHosts) ? pkg.userHosts : [];
    const hooks = Array.isArray(pkg.hooks) ? pkg.hooks : [];
    const deckMacros = (pkg.deck && Array.isArray(pkg.deck.actions)) ? pkg.deck.actions : [];
    const deckStates = (pkg.deck && Array.isArray(pkg.deck.states)) ? pkg.deck.states : [];
    const deckHandlers = (pkg.deck && Array.isArray(pkg.deck.handlers)) ? pkg.deck.handlers : [];
    const deckNames = deckMacros.map(m => m.name).concat(deckStates.map(s => s.name)).concat(deckHandlers.map(h => h.name));
    const wantsStorage = pkg.storage === true;
    const wantsSecrets = pkg.secrets === true;
    const wantsIsland = pkg.island === true;
    const wantsBadge = pkg.badge === true;
    const wantsClipboard = pkg.clipboard === true;
    const storageGroup = typeof pkg.storageGroup === 'string' ? pkg.storageGroup : '';
    if (pkg.streams.length) addSection('cw_perm_streams', 'It can see:', pkg.streams, STREAM_LABELS);
    if (pkg.actions.length) addSection('cw_perm_actions', 'It can do:', pkg.actions, ACTION_LABELS);
    if (hosts.length) addSection('cw_perm_hosts', 'It can talk to (via Xenon):', hosts, {});
    // Addresses the widget needs but cannot know: the author declared a labelled
    // blank, the user fills it in here. Prefilled when re-opened, so this dialog
    // doubles as the editor when a NAS changes address.
    const userHostFields = [];
    if (userHostSlots.length) {
      panel.appendChild(el('div', 'cw-perm-sec', t('cw_perm_userhosts', 'Addresses you provide:')));
      const box = el('div', 'cw-perm-fields');
      const saved = grantsFor(pkg.id).userHosts || {};
      userHostSlots.forEach(slot => {
        const field = el('label', 'cw-perm-field');
        field.appendChild(el('span', 'cw-perm-field-label', slot.label));
        const input = el('input', 'cw-perm-input');
        input.type = 'text';
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.placeholder = slot.scope === 'private' ? '192.168.1.50:8080' : 'example.com';
        const prev = saved[slot.id];
        if (prev) input.value = formatUserHost(prev);
        const err = el('span', 'cw-perm-field-err');
        field.append(input, err);
        box.appendChild(field);
        userHostFields.push({ slot, input, err });
      });
      panel.appendChild(box);
      panel.appendChild(el('div', 'cw-perm-note', t('cw_perm_userhosts_note', 'This widget needs an address only you know. Xenon will let it reach exactly what you type here and nothing else — never this PC itself.')));
    }
    if (hooks.length) addSection('cw_perm_hooks', 'It can receive local events:', hooks, {});
    if (deckNames.length) addSection('cw_perm_deck', 'It adds to the Deck:', deckNames, {});
    // Storage + secrets: local-only capabilities. Storage is the widget's own
    // settings on this PC (shared with sibling widgets when a group is named);
    // secrets are API keys stored write-only — the widget can use them to reach
    // its allowed servers but can never read them back.
    if (wantsStorage) {
      addSection('cw_perm_storage', 'It can save settings on this PC:', [
        storageGroup ? t('cw_perm_storage_group', 'Shared with the "{g}" widget set').replace('{g}', storageGroup) : t('cw_perm_storage_own', 'Its own settings'),
      ], {});
    }
    if (wantsSecrets) {
      addSection('cw_perm_secrets', 'It can store API keys (never shown back):', [t('cw_perm_secrets_val', 'Used only to reach the servers above')], {});
    }
    // Island projection: one short host-rendered text line in the minimal
    // topbar's dynamic island. Plain text only — never markup, links or images.
    if (wantsIsland) {
      addSection('cw_perm_island', 'It can show a line in the top status island:', [t('cw_perm_island_val', 'Short text only — never links or images')], {});
    }
    // Persistent badge: a small always-on chip next to the clock (both topbar
    // chromes), distinct from the transient island above — plain text only.
    if (wantsBadge) {
      addSection('cw_perm_badge', 'It can show a small badge next to the clock:', [t('cw_perm_badge_val', 'Short text only — never links or images')], {});
    }
    // Clipboard: the widget can ask to copy text, but every copy needs a tap on a
    // Xenon-drawn confirmation first — it can never copy silently or read what you
    // have copied. Say exactly that, so "can copy" doesn't read as "can snoop".
    if (wantsClipboard) {
      addSection('cw_perm_clipboard', 'It can copy to your clipboard (with a tap):', [t('cw_perm_clipboard_val', 'You confirm each copy, and it can never read your clipboard')], {});
    }
    // Headless running. The manifest normalizer only keeps `background` when the
    // package has something that outlives a tile (handlers and/or a badge), so
    // name whichever it actually is rather than always saying "Deck keys".
    if (pkg.background === true && (deckHandlers.length || wantsBadge)) {
      const note = (deckHandlers.length && wantsBadge)
        ? t('cw_perm_background_both', 'This widget can keep running hidden in the background, so its Deck keys always answer and its badge stays up to date with no tile on screen.')
        : (wantsBadge
          ? t('cw_perm_background_badge', 'This widget can keep running hidden in the background, so its badge stays in the top bar and up to date even with no tile on screen.')
          : t('cw_perm_background', 'This widget can keep running hidden in the background so its Deck keys always answer.'));
      panel.appendChild(el('div', 'cw-perm-note', note));
    }
    if (!pkg.streams.length && !pkg.actions.length && !hosts.length && !userHostSlots.length && !hooks.length && !deckNames.length && !wantsStorage && !wantsSecrets && !wantsIsland && !wantsBadge && !wantsClipboard) {
      panel.appendChild(el('div', 'cw-perm-sec cw-perm-nothing', t('cw_perm_none', 'Nothing — it only draws its own content')));
    }
    panel.appendChild(el('div', 'cw-perm-note', t('cw_perm_note', 'Widgets run isolated from the dashboard, with no network access, and can only use what you allow here. Only install widgets from people you trust.')));
    if (hosts.length || userHostSlots.length) {
      panel.appendChild(el('div', 'cw-perm-note', t('cw_perm_net_note', 'Network access is limited to the servers listed above and always goes through Xenon — never directly from the widget.')));
    }

    const row = el('div', 'cw-perm-actions-row');
    const cancel = el('button', 'cw-btn', t('cw_cancel', 'Cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', closePermDialog);
    const allow = el('button', 'cw-btn cw-btn--primary', t('cw_allow', 'Allow'));
    allow.type = 'button';
    // Every declared slot must hold a usable address before Allow means anything
    // — granting with a blank field would mount a widget that can only fail.
    const UH_ERRORS = {
      empty: ['cw_uh_empty', 'Enter an address'],
      bad: ['cw_uh_bad', 'That doesn\'t look like an address'],
      forbidden: ['cw_uh_forbidden', 'This address points back at this PC — widgets can never reach it'],
      not_private: ['cw_uh_private', 'Only an address on your own network (like 192.168.1.50 or nas.local)'],
    };
    const readUserHosts = () => {
      const values = {};
      let ok = true;
      for (const f of userHostFields) {
        const r = parseUserHost(f.input.value, f.slot.scope);
        if (r.ok) { values[f.slot.id] = r.value; f.err.textContent = ''; f.input.classList.remove('cw-perm-input--bad'); continue; }
        ok = false;
        // Stay quiet until they've typed something — an untouched field showing
        // a red "enter an address" the moment the dialog opens reads as an error.
        const blank = r.error === 'empty';
        const msg = UH_ERRORS[r.error] || UH_ERRORS.bad;
        f.err.textContent = blank ? '' : t(msg[0], msg[1]);
        f.input.classList.toggle('cw-perm-input--bad', !blank);
      }
      return { ok, values };
    };
    const refresh = () => { allow.disabled = !readUserHosts().ok; };
    userHostFields.forEach(f => f.input.addEventListener('input', refresh));
    if (userHostFields.length) refresh();
    allow.addEventListener('click', () => {
      const uh = readUserHosts();
      if (!uh.ok) { refresh(); return; }
      const cur = sdk();
      const patch = {
        grants: { ...(cur.grants || {}), [pkg.id]: { streams: pkg.streams.slice(), actions: pkg.actions.slice(), hosts: hosts.slice(), userHosts: uh.values, hooks: hooks.slice(), handlers: deckHandlers.map(h => h.id), storage: wantsStorage, secrets: wantsSecrets, island: wantsIsland, badge: wantsBadge, clipboard: wantsClipboard } },
      };
      if (instId != null) patch.assign = { ...(cur.assign || {}), [instId]: pkg.id };
      persist(patch);
      closePermDialog();
      paint();
      syncServiceFrames();   // a fresh handler grant may want a background frame
      if (typeof onAllow === 'function') onAllow();
    });
    row.append(cancel, allow);
    panel.appendChild(row);
    bd.appendChild(panel);
    bd.addEventListener('click', (ev) => { if (ev.target === bd) closePermDialog(); });
    document.body.appendChild(bd);
  }

  // ── Tile rendering ───────────────────────────────────────────────
  function ensure(mount) {
    if (mount.dataset.cwBuilt === '1' && mount.firstChild) return;
    mount.dataset.cwBuilt = '1';
    const wrap = el('div', 'cw-wrap');
    const head = el('div', 'cw-head');
    const brand = el('div', 'cw-brand');
    const logo = el('span', 'cw-logo'); logo.innerHTML = ICONS.puzzle;   // static, trusted SVG
    brand.append(logo, el('span', 'cw-title', t('cw_title', 'Custom widget')));
    head.appendChild(brand);
    const ctl = el('div', 'cw-ctl');
    const reloadBtn = el('button', 'cw-hbtn cw-reload-btn');
    reloadBtn.type = 'button'; reloadBtn.title = t('cw_reload', 'Reload widget (pick up file changes)');
    reloadBtn.innerHTML = ICONS.reload;   // static, trusted SVG
    ctl.appendChild(reloadBtn);
    const swapBtn = el('button', 'cw-hbtn cw-swap-btn');
    swapBtn.type = 'button'; swapBtn.title = t('cw_unassign', 'Choose another widget');
    swapBtn.innerHTML = ICONS.swap;   // static, trusted SVG
    ctl.appendChild(swapBtn);
    head.appendChild(ctl);
    wrap.appendChild(head);
    wrap.appendChild(el('div', 'cw-body'));
    mount.replaceChildren(wrap);
  }

  function showState(body, msgKey, msgFb, opts) {
    const box = el('div', 'cw-state');
    const ico = el('span', 'cw-state-ico'); ico.innerHTML = ICONS.puzzle;   // static SVG
    box.append(ico, el('span', 'cw-state-txt', t(msgKey, msgFb)));
    if (opts && opts.hint) box.appendChild(el('span', 'cw-state-hint', t(opts.hint[0], opts.hint[1])));
    if (opts && opts.buttons) {
      const row = el('div', 'cw-state-btns');
      opts.buttons.forEach(b => {
        // `label` is a pre-built literal (a translated verb + an untranslatable
        // proper name); everything else resolves through the i18n key.
        const btn = el('button', 'cw-btn' + (b.primary ? ' cw-btn--primary' : ''), b.label || t(b.key, b.fb));
        btn.type = 'button';
        btn.addEventListener('click', b.onClick);
        row.appendChild(btn);
      });
      box.appendChild(row);
    }
    body.replaceChildren(box);
  }

  // One-tap install of a bundled reference widget. The id is one of EXAMPLES —
  // the server re-checks it against its own allowlist, so a bad id installs
  // nothing rather than reaching the filesystem.
  async function installExample(id) {
    await api('/sdk/widgets/example', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    fetchPackages(true);
  }

  // Bundled examples the user hasn't installed yet — offered alongside the
  // installed packages so they stay reachable once something IS installed
  // (the empty state alone would hide them forever after the first install).
  function missingExamples() {
    const have = new Set((pkgCache && pkgCache.packages ? pkgCache.packages : []).map(p => p && p.id));
    return EXAMPLES.filter(ex => !have.has(ex.id));
  }

  // Untrusted manifest text (name/author/description) → textContent only.
  function paintPicker(body, instId) {
    const frag = document.createDocumentFragment();
    frag.appendChild(el('div', 'cw-pick-title', t('cw_pick', 'Choose a widget for this tile')));
    const list = el('div', 'cw-pick-list');
    // Group widgets by "pack" — the manifest author (e.g. "Xenon · Cyberpunk
    // pack") — under a header, so a pack's widgets sit together. Named packs come
    // first (alphabetical); widgets with no author fall through last with no
    // header. Author is untrusted manifest text → el() renders it as textContent.
    const groups = new Map();
    // Ambient scenes render fullscreen, not in a tile — they're picked in
    // Settings → Ambient, so keep them out of the tile picker.
    (pkgCache.packages || []).filter(pkg => pkg && pkg.surface !== 'ambient').forEach(pkg => {
      const key = (pkg.author && String(pkg.author).trim()) || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(pkg);
    });
    const keys = Array.from(groups.keys()).sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    keys.forEach(key => {
      if (key) list.appendChild(el('div', 'cw-pick-group', key));
      groups.get(key).forEach(pkg => {
        const row = el('div', 'cw-pick-row');
        const txt = el('div', 'cw-pick-txt');
        txt.appendChild(el('div', 'cw-pick-name', pkg.name));
        // Author is now the group header — the row meta keeps only the version.
        const meta = pkg.version ? 'v' + pkg.version : '';
        if (meta) txt.appendChild(el('div', 'cw-pick-meta', meta));
        if (pkg.description) txt.appendChild(el('div', 'cw-pick-desc', pkg.description));
        row.appendChild(txt);
        const add = el('button', 'cw-btn cw-btn--primary', t('cw_add', 'Add'));
        add.type = 'button';
        add.addEventListener('click', () => openPermDialog(pkg, instId));
        row.appendChild(add);
        list.appendChild(row);
      });
    });
    // Bundled examples not yet installed, in the same grouped-row shape as the
    // real packages above — one tap installs, then the list repaints with the
    // package's own row (and its Add button) in place of this one.
    const examples = missingExamples();
    if (examples.length) {
      list.appendChild(el('div', 'cw-pick-group', t('cw_pick_examples', 'Xenon · Examples')));
      examples.forEach(ex => {
        const row = el('div', 'cw-pick-row');
        const txt = el('div', 'cw-pick-txt');
        txt.appendChild(el('div', 'cw-pick-name', ex.name));
        txt.appendChild(el('div', 'cw-pick-desc', ex.desc));
        row.appendChild(txt);
        const add = el('button', 'cw-btn', t('cw_install', 'Install'));
        add.type = 'button';
        add.addEventListener('click', () => installExample(ex.id));
        row.appendChild(add);
        list.appendChild(row);
      });
    }
    // Always offer a way to get more, even when packs are installed.
    const createRow = el('div', 'cw-pick-create');
    const storeBtn = el('button', 'cw-btn cw-btn--primary', '＋ ' + t('cw_get_more', 'Get more widgets'));
    storeBtn.type = 'button';
    storeBtn.addEventListener('click', () => { if (window.CommunityGallery) window.CommunityGallery.open('widget'); });
    createRow.appendChild(storeBtn);
    list.appendChild(createRow);
    frag.appendChild(list);
    body.replaceChildren(frag);
  }

  // Does the package declare a stream, action, host or hook the stored grant
  // doesn't include? A widget update can ADD a capability — e.g. a to-do widget
  // that gains the `tasks` action — and the grant is all-or-nothing at approval
  // time, so a grant that predates the addition genuinely lacks it. Re-prompt
  // instead of silently mounting with a capability the widget now needs but was
  // never granted (which would leave the new feature dead). A manifest that
  // declares NOTHING new never triggers a re-review, so untouched widgets keep
  // working across the upgrade.
  function grantNeedsReview(pkg) {
    const g = grantsFor(pkg.id);
    const man = (k) => Array.isArray(pkg[k]) ? pkg[k] : [];
    const manHandlers = (pkg.deck && Array.isArray(pkg.deck.handlers)) ? pkg.deck.handlers.map(h => h.id) : [];
    return man('streams').some(s => !g.streams.includes(s))
      || man('actions').some(a => !g.actions.includes(a))
      || man('hosts').some(h => !g.hosts.includes(h))
      || man('hooks').some(h => !g.hooks.includes(h))
      || manHandlers.some(h => !g.handlers.includes(h))
      || (pkg.storage === true && !g.storage)
      || (pkg.secrets === true && !g.secrets)
      || (pkg.island === true && !g.island)
      || (pkg.badge === true && !g.badge)
      || (pkg.clipboard === true && !g.clipboard);
  }
  // A declared userHosts slot with no usable address is the same dead end as an
  // ungranted host — the widget would mount and fail every request. But it is
  // NOT the same thing to say to the user: nothing is asking for more power,
  // there's just a blank they haven't typed yet. Kept separate from
  // grantNeedsReview so paint() can tell the two apart.
  function addressNeedsFilling(pkg) {
    const slots = Array.isArray(pkg.userHosts) ? pkg.userHosts : [];
    if (!slots.length) return false;
    return Object.keys(resolvedUserHosts(pkg, grantsFor(pkg.id)).byId).length < slots.length;
  }

  function mountFrame(body, instId, pkg) {
    const existing = frames.get(instId);
    // Re-mount when the package changed OR the asset version bumped (Rescan /
    // reload), so an edited widget's files actually reload instead of the frame
    // sitting on the version it first loaded.
    if (existing && existing.pkgId === pkg.id && existing.assetVersion === assetVersion && existing.frame.isConnected) return;
    if (existing) { try { existing.frame.remove(); } catch {} frames.delete(instId); }
    const frame = document.createElement('iframe');
    frame.className = 'cw-frame';
    // Sandbox: scripts only. NO allow-same-origin (opaque origin) and the served
    // CSP additionally re-sandboxes + blocks all network (see server/sdk-widgets.js).
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = pkg.name;
    frame.src = '/sdk/widget/' + encodeURIComponent(pkg.id) + '/' + pkg.entry + '?v=' + assetVersion;
    const entry = { frame, pkgId: pkg.id, ready: false, lastAction: 0, assetVersion };
    frames.set(instId, entry);
    body.replaceChildren(frame);
    observeSize(entry);   // report tile size to the widget on mount + on every resize
  }

  function paint() {
    const seen = new Set();
    tiles().forEach(tile => {
      const mount = tile.querySelector('.custom-widget-mount');
      if (!mount) return;
      ensure(mount);
      const instId = instanceIdOf(tile);
      seen.add(instId);
      const body = mount.querySelector('.cw-body');
      const wrap = mount.querySelector('.cw-wrap');
      const titleEl = mount.querySelector('.cw-title');
      const swapBtn = mount.querySelector('.cw-swap-btn');
      const reloadBtn = mount.querySelector('.cw-reload-btn');
      // Default to "setup chrome visible"; only a successfully mounted widget
      // hides it (CSS) so the tile reads like a native widget. Re-evaluated every
      // paint so leaving/entering a mounted state flips it correctly.
      if (wrap) wrap.classList.remove('cw-mounted');
      const cfg = sdk();
      const assignedId = (cfg.assign && typeof cfg.assign === 'object') ? cfg.assign[instId] : null;
      const pkg = assignedId ? packageById(assignedId) : null;
      if (titleEl) titleEl.textContent = pkg ? pkg.name : t('cw_title', 'Custom widget');
      if (swapBtn) {
        swapBtn.hidden = !assignedId;
        swapBtn.title = t('cw_unassign', 'Choose another widget');
        swapBtn.onclick = () => {
          const cur = sdk();
          const assign = { ...(cur.assign || {}) };
          delete assign[instId];
          persist({ assign });
          const entry = frames.get(instId);
          if (entry) { try { entry.frame.remove(); } catch {} frames.delete(instId); }
          paint();
        };
      }
      // Reload: force this widget's iframe to re-fetch its files on THIS surface
      // (the Xeneon Edge can't be hard-refreshed like a browser tab). Bumps the
      // asset version so every mounted frame reloads fresh assets on next paint.
      if (reloadBtn) {
        reloadBtn.hidden = !assignedId;
        reloadBtn.title = t('cw_reload', 'Reload widget (pick up file changes)');
        reloadBtn.onclick = () => {
          assetVersion++;
          const entry = frames.get(instId);
          if (entry) { try { entry.frame.remove(); } catch {} frames.delete(instId); }
          paint();
        };
      }
      if (!cfg.enabled) {
        const entry = frames.get(instId);
        if (entry) { try { entry.frame.remove(); } catch {} frames.delete(instId); }
        showState(body, 'cw_off', 'Third-party widgets are off', {
          hint: ['cw_off_hint', 'Sandboxed mini-widgets made by the community. They run isolated, with no network access, and only see what you allow.'],
          buttons: [{ key: 'cw_enable', fb: 'Turn on', primary: true, onClick: () => { persist({ enabled: true }); fetchPackages(true); paint(); } }],
        });
        return;
      }
      if (pkgCache === null) {
        showState(body, 'cw_loading', 'Looking for installed widgets…');
        fetchPackages(false);
        return;
      }
      if (!assignedId) {
        if (!(pkgCache.packages || []).length) {
          showState(body, 'cw_none', 'No widget packages installed', {
            hint: ['cw_none_hint', 'Install one from the Store, try the built-in examples, or drop a widget folder in server/data/widgets and rescan.'],
            buttons: [
              { key: 'cw_open_store', fb: 'Open the Store', primary: true, onClick: () => { if (window.CommunityGallery) window.CommunityGallery.open('widget'); } },
              // Same bundled examples the picker offers, so the two entry points
              // can't drift apart.
              ...EXAMPLES.map(ex => ({
                label: t('cw_install', 'Install') + ' ' + ex.name,
                onClick: () => installExample(ex.id),
              })),
              { key: 'cw_rescan', fb: 'Rescan', onClick: () => fetchPackages(true) },
            ],
          });
        } else {
          paintPicker(body, instId);
        }
        return;
      }
      if (!pkg) {
        showState(body, 'cw_missing', 'This widget package was removed', {
          buttons: [
            { key: 'cw_unassign', fb: 'Choose another', primary: true, onClick: () => { if (swapBtn) swapBtn.onclick(); } },
            { key: 'cw_rescan', fb: 'Rescan', onClick: () => fetchPackages(true) },
          ],
        });
        return;
      }
      // The package's manifest now declares a capability the stored grant doesn't
      // cover — an old grant from before hosts/hooks existed, or a widget update
      // that added a host/hook. Rather than silently dead-ending the new feature
      // (network/hook requests would just fail), ask the user to review again.
      if (grantNeedsReview(pkg) || addressNeedsFilling(pkg)) {
        const entry = frames.get(instId);
        if (entry) { try { entry.frame.remove(); } catch {} frames.delete(instId); }
        // A widget whose ONLY gap is an unfilled address isn't asking for new
        // powers — it's asking where its server lives. "Asks for new
        // permissions" would alarm the user over a blank field.
        const addrOnly = !grantNeedsReview(pkg);
        showState(body,
          addrOnly ? 'cw_needs_addr' : 'cw_review',
          addrOnly ? 'This widget needs an address' : 'This widget asks for new permissions', {
            hint: addrOnly
              ? ['cw_needs_addr_hint', 'It talks to something on your own network — tell it where to find it.']
              : ['cw_review_hint', 'It was updated (or predates a Xenon feature) and now requests capabilities you haven\'t approved.'],
            buttons: [
              addrOnly
                ? { key: 'cw_needs_addr_btn', fb: 'Set the address', primary: true, onClick: () => openPermDialog(pkg, instId) }
                : { key: 'cw_review_btn', fb: 'Review permissions', primary: true, onClick: () => openPermDialog(pkg, instId) },
              { key: 'cw_unassign', fb: 'Choose another', onClick: () => { if (swapBtn) swapBtn.onclick(); } },
            ],
          });
        return;
      }
      if (wrap) wrap.classList.add('cw-mounted');
      mountFrame(body, instId, pkg);
    });
    // Drop bridge entries whose tile no longer exists (widget removed / page
    // deleted) so a dead iframe can't keep receiving data. Ambient entries are
    // not tiles — AmbientMode registers/deregisters them itself.
    for (const [instId, entry] of frames) {
      // Ambient entries are managed by AmbientMode; service frames are hidden
      // background frames (never in the tile `seen` set) owned by
      // syncServiceFrames — the tile sweep must not tear either down.
      if (entry.ambient || entry.service) continue;
      if (!seen.has(instId) || !entry.frame.isConnected) {
        try { entry.frame.remove(); } catch {}
        frames.delete(instId);
      }
    }
  }

  function renderWidgets() {
    if (!tiles().length) {
      for (const [instId, entry] of frames) {
        if (entry.ambient || entry.service) continue;   // see the paint() sweep note
        try { entry.frame.remove(); } catch {}
        frames.delete(instId);
      }
      return;
    }
    paint();
  }

  // Reset a tile to "unassigned" — drop any saved package + live frame — so the
  // next paint shows the picker. Called when a custom tile is freshly ADDED from
  // the palette: adding one should always let you choose which widget fills it,
  // never silently restore the tile's previous pick (a hidden-then-re-added base
  // custom kept its old assignment, so you never got the chooser back).
  function clearAssign(instId) {
    const id = String(instId || '');
    if (!id) return;
    const entry = frames.get(id);
    if (entry) { try { entry.frame.remove(); } catch {} frames.delete(id); }
    const cur = sdk();
    if (cur.assign && id in cur.assign) {
      const assign = { ...cur.assign };
      delete assign[id];
      persist({ assign });   // persist() → renderWidgets() repaints the tile into the picker
    }
  }

  // ── Ambient scene frames (fullscreen surface, owned by AmbientMode) ──
  // The scene iframe joins the same bridge map so hello/init, granted-stream
  // fan-out, lastData replay and action dispatch all work unchanged. Only one
  // ambient frame exists at a time.
  function registerAmbientFrame(pkgId, frame) {
    unregisterAmbientFrame();
    frames.set(AMBIENT_INST_ID, { frame, pkgId, ready: false, lastAction: 0, ambient: true });
  }
  function unregisterAmbientFrame() {
    const entry = frames.get(AMBIENT_INST_ID);
    if (entry) { try { entry.frame.remove(); } catch {} frames.delete(AMBIENT_INST_ID); }
  }

  // A native canvas Ambient scene (js/ambient-canvas.js) can embed SEVERAL SDK
  // widgets at once, unlike a single-package SDK scene. Each embedded frame joins
  // the same bridge with its own instance id (prefixed so the sweeps and the
  // teardown below can find them), and rides the ambient:true visibility rule
  // (always-fed while present, still gated on document.hidden). The renderer is
  // responsible for only mounting GRANTED packages while the SDK master is on.
  const CANVAS_FRAME_PREFIX = '__canvas-scene__/';
  function registerCanvasFrame(instId, pkgId, frame) {
    const key = CANVAS_FRAME_PREFIX + String(instId || '');
    const prev = frames.get(key);
    if (prev) { try { prev.frame.remove(); } catch {} }
    frames.set(key, { frame, pkgId, ready: false, lastAction: 0, ambient: true });
  }
  function unregisterCanvasFrames() {
    for (const [key, entry] of frames) {
      if (key.indexOf(CANVAS_FRAME_PREFIX) !== 0) continue;
      try { entry.frame.remove(); } catch {}
      frames.delete(key);
    }
  }

  // Package list access for AmbientMode / the Settings scene picker.
  async function getPackages(force) {
    if (!pkgCache || force) await fetchPackages(!!force);
    return pkgCache || { packages: [], invalid: [] };
  }
  function cachedPackages() {
    return (pkgCache && Array.isArray(pkgCache.packages)) ? pkgCache.packages : [];
  }
  // Grant helpers for non-tile surfaces: has the package every capability it
  // declares, and an address for every blank it asks the user to fill? (Same
  // all-or-nothing rule the tiles use — an Ambient scene missing its NAS
  // address is as unready as one missing a grant.)
  function packageGranted(pkg) {
    return !!pkg && !grantNeedsReview(pkg) && !addressNeedsFilling(pkg) && sdk().grants && !!sdk().grants[pkg.id];
  }
  function requestGrant(pkg, onAllow) {
    openPermDialog(pkg, null, onAllow);
  }

  window.CustomWidget = {
    renderWidgets, onData, onDiscordNotification, onHook, onHandler, onStoreChanged, refreshTheme, refreshPackages: () => fetchPackages(true), clearAssign,
    registerAmbientFrame, unregisterAmbientFrame, registerCanvasFrame, unregisterCanvasFrames,
    getPackages, cachedPackages, packageGranted, requestGrant,
    // Does this package still have a live (DOM-connected) frame? SdkIsland's
    // orphan sweep uses it to auto-clear island text whose owner tile is gone.
    pkgHasLiveFrame(pkgId) {
      for (const [, entry] of frames) {
        if (entry.pkgId === pkgId && entry.frame && entry.frame.isConnected) return true;
      }
      return false;
    },
  };
})();
