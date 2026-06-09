'use strict';
// Settings → Streaming: connect Twitch via the OAuth Device Code Flow.
// Flow: tap Connect → server returns a short user code + verification URL → we
// show them (authorise on a phone, no password typed on the touchscreen) → we
// poll until Twitch confirms → show "Connected as <channel>" + Disconnect.
// Tokens live only on the server; this page only ever sees { connected, login }.
(function () {
  let pollTimer = null;

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl; // shared DOM factory from utils.js
  function mount() { return document.getElementById('settings-streaming-hub'); }
  function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

  const api = apiJson; // shared fetch-JSON helper from utils.js

  // Stop polling once the section is no longer on screen (category switch or the
  // whole Settings overlay closed) so a pending device-flow never runs forever.
  function sectionVisible() {
    const g = document.querySelector('.settings-group[data-settings-cat="streaming"]');
    const overlay = document.getElementById('settings-overlay');
    return !!(g && !g.hidden && (!overlay || !overlay.hidden));
  }

  // The streaming providers, rendered as one connect card each. When a provider
  // isn't configured yet, its card shows credential INPUTS (so the user pastes
  // them here instead of editing a file) + a link to the developer console.
  const PROVIDERS = [
    {
      key: 'twitch', name: 'Twitch', base: '/stream/twitch',
      descKey: 'streaming_twitch_desc', setupKey: 'streaming_setup_twitch',
      consoleUrl: 'https://dev.twitch.tv/console/apps/create',
      fields: [{ key: 'twitchClientId', labelKey: 'streaming_field_clientid' }],
    },
    {
      key: 'youtube', name: 'YouTube', base: '/stream/youtube',
      descKey: 'streaming_youtube_desc', setupKey: 'streaming_setup_youtube',
      consoleUrl: 'https://console.cloud.google.com/apis/credentials',
      fields: [
        { key: 'youtubeClientId', labelKey: 'streaming_field_clientid' },
        { key: 'youtubeClientSecret', labelKey: 'streaming_field_secret' },
      ],
    },
  ];

  async function render() {
    const host = mount();
    if (!host) return;
    const states = await Promise.all(PROVIDERS.map(p => api(p.base + '/status')));
    if (!mount()) return;            // closed while awaiting
    host.replaceChildren(...PROVIDERS.map((p, i) => buildProviderCard(p, states[i] || {})));
  }

  function buildProviderCard(cfg, st) {
    const card = el('div', 'streaming-card');
    card.dataset.provider = cfg.key;
    const head = el('div', 'streaming-card-head');
    head.appendChild(el('span', 'streaming-card-title', cfg.name));
    head.appendChild(el('span', 'streaming-dot' + (st.connected ? ' on' : '')));
    card.appendChild(head);

    if (!st.configured) {
      card.appendChild(buildSetupForm(cfg));
      return card;
    }
    if (st.connected) {
      card.appendChild(el('p', 'streaming-connected', t('streaming_connected_as', 'Connected as') + ' ' + (st.login || '')));
      const out = el('button', 'settings-btn danger', t('streaming_disconnect', 'Disconnect'));
      out.addEventListener('click', async () => { out.disabled = true; stopPoll(); await api(cfg.base + '/logout', { method: 'POST' }); render(); });
      card.appendChild(out);
      return card;
    }
    card.appendChild(el('p', 'settings-note', t(cfg.descKey, 'Connect your account to control it from the dashboard.')));
    const btn = el('button', 'settings-btn primary', t('streaming_connect', 'Connect'));
    btn.addEventListener('click', () => startLogin(cfg, card, btn));
    card.appendChild(btn);
    return card;
  }

  // Credential-entry form shown when a provider isn't configured yet: a short
  // setup hint + a link to the dev console + an input per required field + Save.
  // On save the server writes stream-config.json and re-creates the provider, so
  // the card immediately re-renders into the Connect state.
  function buildSetupForm(cfg) {
    const box = el('div', 'streaming-setup');
    box.appendChild(el('p', 'settings-note', t(cfg.setupKey, 'Register an app and paste its credentials below.')));
    const link = el('a', 'streaming-setup-link', t('streaming_open_console', 'Open developer console'));
    link.href = cfg.consoleUrl; link.target = '_blank'; link.rel = 'noopener';
    box.appendChild(link);
    const inputs = {};
    cfg.fields.forEach(f => {
      const field = el('label', 'streaming-field');
      field.appendChild(el('span', 'streaming-field-label', t(f.labelKey, f.key)));
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'settings-text-input streaming-input';
      inp.spellcheck = false; inp.autocomplete = 'off';
      field.appendChild(inp);
      inputs[f.key] = inp;
      box.appendChild(field);
    });
    const save = el('button', 'settings-btn primary', t('streaming_save', 'Save'));
    save.addEventListener('click', async () => {
      const patch = {}; let any = false;
      cfg.fields.forEach(f => { const v = inputs[f.key].value.trim(); if (v) { patch[f.key] = v; any = true; } });
      if (!any) return;
      save.disabled = true;
      await api('/stream/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      render();   // now configured → Connect button
    });
    box.appendChild(save);
    return box;
  }

  async function startLogin(cfg, card, btn) {
    btn.disabled = true;
    const r = await api(cfg.base + '/login', { method: 'POST' });
    if (!r || !r.ok) { btn.disabled = false; setNote(card, t('streaming_error', 'Could not start login. Try again.')); return; }
    showCode(card, r);
    pollLogin(cfg, r.deviceCode, r.interval || 5);
  }

  function setNote(card, msg) {
    let note = card.querySelector('.streaming-err');
    if (!note) { note = el('p', 'settings-note streaming-err'); card.appendChild(note); }
    note.textContent = msg;
  }

  function showCode(card, r) {
    card.querySelectorAll('.streaming-login, .streaming-err').forEach(n => n.remove());
    const box = el('div', 'streaming-login');
    box.appendChild(el('p', 'settings-note', t('streaming_devstep', 'On your phone, open this link and enter the code:')));
    box.appendChild(el('div', 'streaming-code', r.userCode || ''));
    const url = el('a', 'streaming-url');
    url.href = r.verificationUri || '#'; url.target = '_blank'; url.rel = 'noopener';
    url.textContent = r.verificationUri || '';
    box.appendChild(url);
    box.appendChild(el('p', 'streaming-poll', t('streaming_waiting', 'Waiting for authorisation…')));
    card.appendChild(box);
  }

  function pollLogin(cfg, deviceCode, interval) {
    stopPoll();
    pollTimer = setTimeout(async () => {
      if (!sectionVisible()) { stopPoll(); return; }
      const r = await api(cfg.base + '/login/poll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceCode }),
      });
      if (!sectionVisible()) { stopPoll(); return; }
      if (r && r.ok) { stopPoll(); render(); return; }
      if (r && r.pending) { pollLogin(cfg, deviceCode, r.slowDown ? interval + 5 : interval); return; }
      stopPoll();
      render();   // expired / denied → back to the Connect button
    }, Math.max(1, interval) * 1000);
  }

  // Called by settings.js whenever the Settings modal (re)opens.
  function init() {
    if (!mount()) return;
    stopPoll();
    render();
  }

  // ── Dashboard widget: the full Twitch panel ───────────────────────────────
  // One unified widget with three manageable sections (actions / chat),
  // tagged as dashboard "cards" so they hide/reorder like the System panel cards.
  // Called from dashboard-layout.js applyDashboardLayout (streamRender step). The
  // skeleton is built ONCE per tile (idempotent) so the per-poll content update
  // and the layout-card controls don't fight each other; only dynamic content
  // (live state, viewer count, chat) is refreshed in place.
  let tilePoll = null;
  let lastStream = null;
  let lastStatus = null;
  let micMuted = false;          // from SSE `status` (data.muted)
  let obsStreaming = false;      // from SSE `obs`
  let obsPreviewImg = '';        // from SSE `obs_preview` (data URL of the OBS program)
  const TILE_POLL_MS = 12000;

  // Only tiles actually placed on a dashboard page count. A hidden / never-added
  // widget sits in the #widget-pool (outside any .pager-page), so it must NOT
  // poll Twitch or open the chat socket. Adding the widget starts it; removing
  // it (parked back to the pool) stops the poll and closes the chat connection.
  function twitchTiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="twitch"]')).filter(el => el.closest('.pager-page')); }
  function stopTilePoll() { if (tilePoll) { clearInterval(tilePoll); tilePoll = null; } }

  // Inline icons (currentColor) for a polished, non-emoji look.
  const TW_ICONS = {
    clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9.5h18M8 5l-1.5 4.5M16 5l-1.5 4.5"/></svg>',
    marker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12v18l-6-4-6 4V3Z"/></svg>',
    ad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h3l7 4V5L7 9H4Z"/><path d="M17.5 9a4 4 0 0 1 0 6"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.4 7.2L4 21l1.8-5.6A8 8 0 1 1 21 12Z"/></svg>',
    tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="m8 3 4 4 4-4"/></svg>',
    golive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    micOn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 18 18M9 9v2a3 3 0 0 0 4.5 2.6M15 11V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 10 6.3M12 18v3"/></svg>',
  };

  // POST a Deck action (reuses the allowlisted dispatcher) and flash the button.
  async function runWidgetAction(btn, action) {
    btn.disabled = true; btn.classList.remove('ok', 'err');
    const r = await api('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
    btn.classList.add(r && r.ok ? 'ok' : 'err');
    setTimeout(() => { btn.classList.remove('ok', 'err'); btn.disabled = false; }, 1400);
  }

  function actBtn(iconKey, labelKey, fallback, onClick) {
    const b = el('button', 'twitch-act-btn');
    const ico = el('span', 'twitch-act-ico'); ico.innerHTML = TW_ICONS[iconKey];   // static, trusted SVG
    b.append(ico, el('span', 'twitch-act-lbl', t(labelKey, fallback)));
    b.addEventListener('click', () => onClick(b));
    return b;
  }

  function buildActionsCard() {
    const wrap = el('div', 'twitch-actions');

    // Go live / end stream — toggles OBS streaming (you broadcast via OBS).
    const golive = el('button', 'twitch-act-btn twitch-golive twitch-act-primary');
    golive.append(el('span', 'twitch-act-ico'), el('span', 'twitch-act-lbl'));
    golive.addEventListener('click', () => runWidgetAction(golive, { type: 'obsStream', mode: 'toggle' }));

    // Mic mute / unmute.
    const mic = el('button', 'twitch-act-btn twitch-mic');
    mic.append(el('span', 'twitch-act-ico'), el('span', 'twitch-act-lbl'));
    mic.addEventListener('click', () => runWidgetAction(mic, { type: 'micMute', mode: 'toggle' }));

    const clip = actBtn('clip', 'deck_act_twitchClip', 'Clip', (b) => runWidgetAction(b, { type: 'twitchClip' }));
    const marker = actBtn('marker', 'deck_act_twitchMarker', 'Marker', (b) => runWidgetAction(b, { type: 'twitchMarker' }));
    const adRow = el('div', 'twitch-act-ad');
    const len = document.createElement('select'); len.className = 'twitch-act-len';
    ['30', '60', '90', '120', '150', '180'].forEach(s => { const o = document.createElement('option'); o.value = s; o.textContent = s + 's'; len.appendChild(o); });
    const ad = actBtn('ad', 'deck_act_twitchAd', 'Ad', (b) => runWidgetAction(b, { type: 'twitchAd', length: len.value }));
    adRow.append(len, ad);

    wrap.append(golive, mic, clip, marker, adRow);
    return wrap;
  }

  // Reflect live OBS-streaming + mic state on the go-live / mic buttons.
  function paintControls() {
    twitchTiles().forEach(tile => {
      const golive = tile.querySelector('.twitch-golive');
      if (golive) {
        golive.classList.toggle('is-live', obsStreaming);
        golive.querySelector('.twitch-act-ico').innerHTML = obsStreaming ? TW_ICONS.stop : TW_ICONS.golive;
        golive.querySelector('.twitch-act-lbl').textContent = obsStreaming ? t('twitch_endstream', 'End stream') : t('twitch_golive', 'Go live');
      }
      const mic = tile.querySelector('.twitch-mic');
      if (mic) {
        mic.classList.toggle('is-muted', micMuted);
        mic.querySelector('.twitch-act-ico').innerHTML = micMuted ? TW_ICONS.micOff : TW_ICONS.micOn;
        mic.querySelector('.twitch-act-lbl').textContent = micMuted ? t('twitch_mic_unmute', 'Unmute') : t('twitch_mic_mute', 'Mute');
      }
    });
  }

  // Paint the OBS program preview into the preview card(s).
  function paintPreview() {
    twitchTiles().forEach(tile => {
      const card = tile.querySelector('.twitch-card--preview');
      if (!card) return;
      const img = card.querySelector('.twitch-preview-img');
      const empty = card.querySelector('.twitch-preview-empty');
      if (obsPreviewImg) {
        img.src = obsPreviewImg; img.hidden = false; if (empty) empty.hidden = true;
      } else {
        img.removeAttribute('src'); img.hidden = true; if (empty) empty.hidden = false;
      }
    });
  }

  // Build the static skeleton once per mount; mark it so we never rebuild (which
  // would wipe the layout-card controls/state applied by applyDashboardCards).
  function ensureSkeleton(mount) {
    if (mount.dataset.twBuilt === '1' && mount.firstChild) return;
    mount.dataset.twBuilt = '1';
    const wrap = el('div', 'twitch-wrap');

    const head = el('div', 'twitch-head');
    const brand = el('div', 'twitch-brand');
    brand.append(el('span', 'twitch-logo', 'Twitch'), el('span', 'twitch-channel'));
    const pill = el('span', 'twitch-status-pill');
    pill.append(el('span', 'twitch-status-dot'), el('span', 'twitch-status-text', t('twitch_offline', 'Offline')));
    head.append(brand, pill);
    wrap.appendChild(head);

    const cards = el('div', 'twitch-cards');
    const actions = el('section', 'twitch-card twitch-card--actions'); actions.dataset.systemCard = 'actions'; actions.dataset.systemCardGroup = 'twitch';
    actions.appendChild(el('div', 'twitch-card-label', t('layout_card_actions', 'Actions')));
    actions.appendChild(buildActionsCard());
    const chat = el('section', 'twitch-card twitch-card--chat'); chat.dataset.systemCard = 'chat'; chat.dataset.systemCardGroup = 'twitch';
    chat.appendChild(el('div', 'twitch-card-label', t('layout_card_chat', 'Chat')));
    const log = el('div', 'twitch-chat-log');
    chat.appendChild(log);
    seedChatLog(log);
    cards.append(actions, chat);
    wrap.appendChild(cards);
    mount.replaceChildren(wrap);
  }

  function paintTiles() {
    const st = lastStream, status = lastStatus;
    const connected = !!(status && status.connected);
    const live = !!(st && st.ok && st.live);
    twitchTiles().forEach(tile => {
      const mount = tile.querySelector('.twitch-widget-mount');
      if (!mount) return;
      ensureSkeleton(mount);
      const head = mount.querySelector('.twitch-head');
      head.querySelector('.twitch-channel').textContent = connected ? (status.login || '') : '—';
      const pill = head.querySelector('.twitch-status-pill');
      pill.classList.toggle('live', live);
      head.querySelector('.twitch-status-text').textContent = live ? 'LIVE' : t('twitch_offline', 'Offline');

      // Clip/Marker/Ad need a live channel; dim them when offline. Go-live and mic
      // are always usable, so they're excluded.
      mount.querySelectorAll('.twitch-act-btn:not(.twitch-golive):not(.twitch-mic), .twitch-act-len').forEach(b => { b.classList.toggle('is-idle', !live); });
    });
    paintControls();
    paintPreview();
  }

  async function refreshTiles() {
    if (!twitchTiles().length) { stopTilePoll(); closeChat(); return; }
    if (document.hidden) return;
    const [status, stream] = await Promise.all([api('/stream/twitch/status'), api('/stream/twitch/stream')]);
    if (status) lastStatus = status;
    if (stream) lastStream = stream;
    paintTiles();
    manageChat();
  }

  function renderWidgets() {
    if (!twitchTiles().length) { stopTilePoll(); closeChat(); return; }
    paintTiles();                                 // instant paint from cache
    manageChat();
    if (!tilePoll) { refreshTiles(); tilePoll = setInterval(refreshTiles, TILE_POLL_MS); }
  }

  // ── Twitch chat (anonymous IRC over WebSocket — no token needed to READ) ────
  // Reading a channel's chat needs no auth: connect as an anon `justinfan` nick.
  // One socket per channel, shared across all tiles; messages buffer so a freshly
  // built chat-log (new tile / rebuild) seeds instantly.
  let chatSock = null;
  let chatChannel = '';
  let chatReconnect = null;
  const chatBuffer = [];
  const CHAT_MAX = 120;

  function manageChat() {
    const connected = !!(lastStatus && lastStatus.connected && lastStatus.login);
    if (connected) connectChat(lastStatus.login.toLowerCase());
    else closeChat();
  }

  function connectChat(channel) {
    if (chatChannel === channel && chatSock && chatSock.readyState <= 1) return;  // already on it
    closeChat();
    chatChannel = channel;
    try { chatSock = new WebSocket('wss://irc-ws.chat.twitch.tv:443'); }
    catch { chatSock = null; return; }
    chatSock.onopen = () => {
      ircSend('CAP REQ :twitch.tv/tags');
      ircSend('NICK justinfan' + (10000 + Math.floor(Math.random() * 89999)));
      ircSend('JOIN #' + channel);
    };
    chatSock.onmessage = (e) => handleIrc(String(e.data || ''));
    chatSock.onclose = () => { if (chatChannel) scheduleChatReconnect(); };
    chatSock.onerror = () => { try { chatSock.close(); } catch {} };
  }

  function scheduleChatReconnect() {
    if (chatReconnect) return;
    chatReconnect = setTimeout(() => { chatReconnect = null; if (chatChannel && twitchTiles().length) connectChat(chatChannel); }, 4000);
  }

  function closeChat() {
    if (chatReconnect) { clearTimeout(chatReconnect); chatReconnect = null; }
    const ch = chatChannel; chatChannel = '';
    if (chatSock) { try { chatSock.onclose = null; chatSock.close(); } catch {} chatSock = null; }
    if (ch) { /* keep buffer so a quick reconnect still shows history */ }
  }

  function ircSend(line) { try { if (chatSock && chatSock.readyState === 1) chatSock.send(line + '\r\n'); } catch {} }

  function handleIrc(raw) {
    raw.split('\r\n').forEach(line => {
      if (!line) return;
      if (line.startsWith('PING')) { ircSend('PONG :tmi.twitch.tv'); return; }
      let rest = line; const tags = {};
      if (line[0] === '@') {
        const sp = line.indexOf(' ');
        line.slice(1, sp).split(';').forEach(kv => { const i = kv.indexOf('='); if (i > 0) tags[kv.slice(0, i)] = kv.slice(i + 1); });
        rest = line.slice(sp + 1);
      }
      const pm = rest.indexOf(' PRIVMSG ');
      if (pm === -1) return;
      const nick = (rest.slice(0, pm).match(/:?([^!]+)!/) || [])[1] || tags['display-name'] || '?';
      const after = rest.slice(pm + 9);                 // ' PRIVMSG '.length === 9
      const mi = after.indexOf(' :');
      if (mi === -1) return;
      pushChat(tags['display-name'] || nick, after.slice(mi + 2), tags.color || '');
    });
  }

  function pushChat(name, text, color) {
    const entry = { name: String(name).slice(0, 40), text: String(text).slice(0, 500), color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : '' };
    chatBuffer.push(entry);
    if (chatBuffer.length > CHAT_MAX) chatBuffer.shift();
    document.querySelectorAll('.twitch-chat-log').forEach(log => appendChatLine(log, entry));
  }

  function chatEmptyEl() {
    const box = el('div', 'twitch-chat-empty');
    const ico = el('span', 'twitch-chat-empty-ico'); ico.innerHTML = TW_ICONS.chat;   // static, trusted SVG
    box.append(ico, el('span', null, t('twitch_chat_empty', 'No chat messages yet')));
    return box;
  }

  function appendChatLine(log, entry) {
    const empty = log.querySelector('.twitch-chat-empty');
    if (empty) empty.remove();
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const line = el('div', 'twitch-chat-line');
    const u = el('span', 'twitch-chat-user', entry.name + ':');
    if (entry.color) u.style.color = entry.color;
    line.append(u, document.createTextNode(' '));
    line.appendChild(el('span', 'twitch-chat-text', entry.text));
    log.appendChild(line);
    while (log.childElementCount > CHAT_MAX) log.removeChild(log.firstChild);
    if (near) log.scrollTop = log.scrollHeight;
  }

  function seedChatLog(log) {
    if (!chatBuffer.length) { log.appendChild(chatEmptyEl()); return; }
    chatBuffer.forEach(e => appendChatLine(log, e));
  }

  // ── SSE hooks (fed by main.js, mirroring how the Deck is updated) ─────────
  function onMic(muted) { micMuted = !!muted; if (twitchTiles().length) paintControls(); }
  function onObs(state) {
    if (state && typeof state.obsStreaming === 'boolean') obsStreaming = state.obsStreaming;
    if (twitchTiles().length) paintControls();
  }
  function onObsPreview(p) { obsPreviewImg = (p && p.image) || ''; if (twitchTiles().length) paintPreview(); }

  window.StreamingPage = { init, renderWidgets, onMic, onObs, onObsPreview };
})();
