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
  };
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
  };
  const ACTION_MIN_INTERVAL_MS = 250;   // per-instance action rate limit
  const FETCH_MIN_INTERVAL_MS = 1000;   // per-instance proxied-fetch rate limit
  const STATE_MIN_INTERVAL_MS = 150;    // per-instance deck-state publish rate limit

  let pkgCache = null;        // last /sdk/widgets result ({packages, invalid})
  let pkgFetchPromise = null; // in-flight /sdk/widgets fetch (shared by callers)
  // instanceId → { frame, pkgId, ready, lastAction, lastFetch, lastState, ambient? }.
  // Ambient entries are fullscreen scene frames registered by AmbientMode under
  // a reserved id — they are not tiles, so every tile-driven cleanup below must
  // skip them (AmbientMode owns their lifecycle).
  const AMBIENT_INST_ID = '__ambient-scene__';
  const frames = new Map();
  const lastData = {};        // stream → last payload (seed for late frames)
  // Deck states published by widgets over the bridge, keyed "pkg/stateId".
  // Authoritative copy — pushed wholesale into the Deck snapshot on change.
  const sdkStates = {};
  // Optional display meta per state ({label, icon, color}) for key.live badges.
  const sdkStateMeta = {};

  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="custom"]')).filter(n => n.closest('.pager-page')); }

  function instanceIdOf(tile) {
    const item = tile.closest('.grid-stack-item');
    return (item && item.getAttribute('gs-id')) || 'custom';
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
  function themePayload() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings : {};
    return {
      appearance: document.documentElement.getAttribute('data-appearance') || 'dark',
      accent: typeof hs.accent === 'string' ? hs.accent : '#1ed760',
      background: typeof hs.background === 'string' ? hs.background : '#070808',
      text: typeof hs.text === 'string' ? hs.text : '#f0f3f1',
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
  function grantsFor(pkgId) {
    const g = sdk().grants;
    const grant = (g && typeof g === 'object') ? g[pkgId] : null;
    return {
      streams: (grant && Array.isArray(grant.streams)) ? grant.streams : [],
      actions: (grant && Array.isArray(grant.actions)) ? grant.actions : [],
      hosts: (grant && Array.isArray(grant.hosts)) ? grant.hosts : [],
      hooks: (grant && Array.isArray(grant.hooks)) ? grant.hooks : [],
      handlers: (grant && Array.isArray(grant.handlers)) ? grant.handlers : [],
    };
  }
  function actionAllowed(grant, action) {
    if (!action || typeof action !== 'object' || typeof action.type !== 'string') return false;
    return grant.actions.some(cat => (ACTION_CATEGORIES[cat] || []).includes(action.type));
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
    if (!host || !grant.hosts.includes(host)) { reply({ ok: false, error: 'host_not_allowed' }); return; }
    const d = await api('/sdk/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pkg: entry.pkgId, url: msg.url, method: msg.method, headers: msg.headers, body: msg.body }),
    });
    if (!d) { reply({ ok: false, error: 'offline' }); return; }
    reply({ ok: !!d.ok, status: d.status, contentType: d.contentType, location: d.location, encoding: d.encoding, body: d.body, error: d.error });
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
        theme: themePayload(),
        lang: langCode(),
        streams: grant.streams.slice(),
        actions: grant.actions.slice(),
        hosts: grant.hosts.slice(),
        hooks: grant.hooks.slice(),
        handlers: grant.handlers.slice(),
      });
      grant.streams.forEach(stream => {
        if (lastData[stream] !== undefined) post(entry, { type: 'data', stream, data: lastData[stream] });
      });
    } else if (d.type === 'action') {
      if (entry.ready) onBridgeAction(entry, grant, d);
    } else if (d.type === 'fetch') {
      if (entry.ready) onBridgeFetch(entry, grant, d);
    } else if (d.type === 'state') {
      if (entry.ready) onBridgeState(entry, d);
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

  // SSE relay (called from main.js): cache + fan out to granted, ready frames.
  // Always cache lastData so a frame returning to view gets fresh data on the next
  // tick, but don't post to a hidden tab or to a frame parked on a non-current pager
  // page — a sandboxed widget shouldn't re-render (or wake its timers) off-screen.
  function onData(stream, payload) {
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
        const declared = (pkg.deck && Array.isArray(pkg.deck.handlers)) ? pkg.deck.handlers : [];
        if (!declared.length) continue;
        const granted = grantsFor(pkg.id).handlers;
        if (!declared.some(h => granted.includes(h.id))) continue;   // nothing granted → no frame
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
      if (existing && existing.pkgId === pkg.id && existing.frame.isConnected) continue;
      if (existing) { try { existing.frame.remove(); } catch {} frames.delete(key); }
      const frame = document.createElement('iframe');
      frame.className = 'cw-frame cw-frame--service';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.title = pkg.name;
      frame.src = '/sdk/widget/' + encodeURIComponent(pkg.id) + '/' + pkg.entry;
      frames.set(key, { frame, pkgId: pkg.id, ready: false, lastAction: 0, service: true });
      serviceHost().appendChild(frame);
    }
  }

  // Theme changed (called from settings.js after applyHubSettings).
  function refreshTheme() {
    for (const [, entry] of frames) {
      if (entry.ready) post(entry, { type: 'theme', theme: themePayload() });
    }
  }

  // ── Permission dialog ────────────────────────────────────────────
  function closePermDialog() {
    const bd = document.querySelector('.cw-perm-backdrop');
    if (bd) bd.remove();
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
    const hooks = Array.isArray(pkg.hooks) ? pkg.hooks : [];
    const deckMacros = (pkg.deck && Array.isArray(pkg.deck.actions)) ? pkg.deck.actions : [];
    const deckStates = (pkg.deck && Array.isArray(pkg.deck.states)) ? pkg.deck.states : [];
    const deckHandlers = (pkg.deck && Array.isArray(pkg.deck.handlers)) ? pkg.deck.handlers : [];
    const deckNames = deckMacros.map(m => m.name).concat(deckStates.map(s => s.name)).concat(deckHandlers.map(h => h.name));
    if (pkg.streams.length) addSection('cw_perm_streams', 'It can see:', pkg.streams, STREAM_LABELS);
    if (pkg.actions.length) addSection('cw_perm_actions', 'It can do:', pkg.actions, ACTION_LABELS);
    if (hosts.length) addSection('cw_perm_hosts', 'It can talk to (via Xenon):', hosts, {});
    if (hooks.length) addSection('cw_perm_hooks', 'It can receive local events:', hooks, {});
    if (deckNames.length) addSection('cw_perm_deck', 'It adds to the Deck:', deckNames, {});
    if (pkg.background === true && deckHandlers.length) {
      panel.appendChild(el('div', 'cw-perm-note', t('cw_perm_background', 'This widget can keep running hidden in the background so its Deck keys always answer.')));
    }
    if (!pkg.streams.length && !pkg.actions.length && !hosts.length && !hooks.length && !deckNames.length) {
      panel.appendChild(el('div', 'cw-perm-sec cw-perm-nothing', t('cw_perm_none', 'Nothing — it only draws its own content')));
    }
    panel.appendChild(el('div', 'cw-perm-note', t('cw_perm_note', 'Widgets run isolated from the dashboard, with no network access, and can only use what you allow here. Only install widgets from people you trust.')));
    if (hosts.length) {
      panel.appendChild(el('div', 'cw-perm-note', t('cw_perm_net_note', 'Network access is limited to the servers listed above and always goes through Xenon — never directly from the widget.')));
    }

    const row = el('div', 'cw-perm-actions-row');
    const cancel = el('button', 'cw-btn', t('cw_cancel', 'Cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', closePermDialog);
    const allow = el('button', 'cw-btn cw-btn--primary', t('cw_allow', 'Allow'));
    allow.type = 'button';
    allow.addEventListener('click', () => {
      const cur = sdk();
      const patch = {
        grants: { ...(cur.grants || {}), [pkg.id]: { streams: pkg.streams.slice(), actions: pkg.actions.slice(), hosts: hosts.slice(), hooks: hooks.slice(), handlers: deckHandlers.map(h => h.id) } },
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
        const btn = el('button', 'cw-btn' + (b.primary ? ' cw-btn--primary' : ''), t(b.key, b.fb));
        btn.type = 'button';
        btn.addEventListener('click', b.onClick);
        row.appendChild(btn);
      });
      box.appendChild(row);
    }
    body.replaceChildren(box);
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
        // Edit reopens the no-code creator for widgets it made (detected by their
        // xgen.json at edit time); harmless on hand-made widgets — it just tells
        // the user it can't be edited here.
        const edit = el('button', 'cw-btn cw-btn--ghost', t('cw_edit', 'Edit'));
        edit.type = 'button';
        edit.addEventListener('click', () => { if (window.WidgetCreator) window.WidgetCreator.open({ editId: pkg.id, onInstalled: () => fetchPackages(true) }); });
        row.appendChild(edit);
        const add = el('button', 'cw-btn cw-btn--primary', t('cw_add', 'Add'));
        add.type = 'button';
        add.addEventListener('click', () => openPermDialog(pkg, instId));
        row.appendChild(add);
        list.appendChild(row);
      });
    });
    // Always offer "make your own", even when packs are installed.
    const createRow = el('div', 'cw-pick-create');
    const createBtn = el('button', 'cw-btn cw-btn--primary', '＋ ' + t('wc_create', 'Create a widget'));
    createBtn.type = 'button';
    createBtn.addEventListener('click', () => { if (window.WidgetCreator) window.WidgetCreator.open({ onInstalled: () => fetchPackages(true) }); });
    createRow.appendChild(createBtn);
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
      || manHandlers.some(h => !g.handlers.includes(h));
  }

  function mountFrame(body, instId, pkg) {
    const existing = frames.get(instId);
    if (existing && existing.pkgId === pkg.id && existing.frame.isConnected) return;
    if (existing) { try { existing.frame.remove(); } catch {} frames.delete(instId); }
    const frame = document.createElement('iframe');
    frame.className = 'cw-frame';
    // Sandbox: scripts only. NO allow-same-origin (opaque origin) and the served
    // CSP additionally re-sandboxes + blocks all network (see server/sdk-widgets.js).
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = pkg.name;
    frame.src = '/sdk/widget/' + encodeURIComponent(pkg.id) + '/' + pkg.entry;
    frames.set(instId, { frame, pkgId: pkg.id, ready: false, lastAction: 0 });
    body.replaceChildren(frame);
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
            hint: ['cw_none_hint', 'Create your own with a few taps, try the built-in example, or drop a widget folder in server/data/widgets and rescan.'],
            buttons: [
              { key: 'wc_create', fb: 'Create a widget', primary: true, onClick: () => { if (window.WidgetCreator) window.WidgetCreator.open({ onInstalled: () => fetchPackages(true) }); } },
              { key: 'cw_example', fb: 'Install example', onClick: async () => { await api('/sdk/widgets/example', { method: 'POST' }); fetchPackages(true); } },
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
      if (grantNeedsReview(pkg)) {
        const entry = frames.get(instId);
        if (entry) { try { entry.frame.remove(); } catch {} frames.delete(instId); }
        showState(body, 'cw_review', 'This widget asks for new permissions', {
          hint: ['cw_review_hint', 'It was updated (or predates a Xenon feature) and now requests capabilities you haven\'t approved.'],
          buttons: [
            { key: 'cw_review_btn', fb: 'Review permissions', primary: true, onClick: () => openPermDialog(pkg, instId) },
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

  // Package list access for AmbientMode / the Settings scene picker.
  async function getPackages(force) {
    if (!pkgCache || force) await fetchPackages(!!force);
    return pkgCache || { packages: [], invalid: [] };
  }
  function cachedPackages() {
    return (pkgCache && Array.isArray(pkgCache.packages)) ? pkgCache.packages : [];
  }
  // Grant helpers for non-tile surfaces: has the package every capability it
  // declares? (Same all-or-nothing rule the tiles use.)
  function packageGranted(pkg) {
    return !!pkg && !grantNeedsReview(pkg) && sdk().grants && !!sdk().grants[pkg.id];
  }
  function requestGrant(pkg, onAllow) {
    openPermDialog(pkg, null, onAllow);
  }

  window.CustomWidget = {
    renderWidgets, onData, onHook, onHandler, refreshTheme, refreshPackages: () => fetchPackages(true), clearAssign,
    registerAmbientFrame, unregisterAmbientFrame, getPackages, cachedPackages, packageGranted, requestGrant,
  };
})();
