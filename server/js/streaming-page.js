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
    {
      // Discord uses the LOCAL RPC channel, not a cloud device flow: tapping
      // Connect asks the running Discord desktop app to show a consent dialog and
      // resolves in one round-trip once the user approves (flow: 'rpc').
      key: 'discord', name: 'Discord', base: '/stream/discord', flow: 'rpc',
      descKey: 'streaming_discord_desc', setupKey: 'streaming_setup_discord',
      consoleUrl: 'https://discord.com/developers/applications',
      fields: [
        { key: 'discordClientId', labelKey: 'streaming_field_clientid' },
        { key: 'discordClientSecret', labelKey: 'streaming_field_secret' },
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

    // A live connection always shows the connected state — never the "enter your
    // Client ID" setup form. The app credentials live in a server-only file and
    // are never sent to the browser, and they can read as missing (an env var
    // that's gone, credentials not yet re-saved here) even while a stored token
    // still works. In that case warn and offer a re-entry form so the connection
    // survives the next restart / token refresh, rather than nagging a working
    // account to reconnect.
    if (st.connected) {
      card.appendChild(el('p', 'streaming-connected', t('streaming_connected_as', 'Connected as') + ' ' + (st.login || '')));
      if (cfg.key === 'discord') card.appendChild(buildDiscordHideNameRow());
      if (!st.configured) {
        card.appendChild(el('p', 'settings-note streaming-warn', t('streaming_creds_missing', 'App credentials not found — re-enter them to keep this connection working after a restart.')));
        card.appendChild(buildSetupForm(cfg));
      }
      const out = el('button', 'settings-btn danger', t('streaming_disconnect', 'Disconnect'));
      out.addEventListener('click', async () => { out.disabled = true; stopPoll(); await api(cfg.base + '/logout', { method: 'POST' }); render(); });
      card.appendChild(out);
      if (st.configured) card.appendChild(buildCredActions(cfg));
      if (cfg.key === 'discord') card.appendChild(buildDiscordNotifBlock(st));
      return card;
    }
    if (!st.configured) {
      card.appendChild(buildSetupForm(cfg));
      return card;
    }
    card.appendChild(el('p', 'settings-note', t(cfg.descKey, 'Connect your account to control it from the dashboard.')));
    const btn = el('button', 'settings-btn primary', t('streaming_connect', 'Connect'));
    btn.addEventListener('click', () => startLogin(cfg, card, btn));
    card.appendChild(btn);
    card.appendChild(buildCredActions(cfg));
    if (cfg.key === 'discord') card.appendChild(buildDiscordNotifBlock(st));
    return card;
  }

  // Discord-only privacy toggle: keep the account name off the dashboard widget.
  // Reads the shared script-scope `hubSettings` (NOT window.hubSettings) by bare
  // name, guarded; saves through settings.js's global updateDiscordHideName,
  // which repaints the widget. Mirrors the Spotify hide-name toggle.
  function buildDiscordHideNameRow() {
    const hidden = (typeof hubSettings === 'object' && !!hubSettings && hubSettings.discordHideName === true);
    const row = el('label', 'settings-toggle-row full');
    const inp = document.createElement('input');
    inp.type = 'checkbox'; inp.className = 'settings-check'; inp.checked = hidden;
    inp.addEventListener('change', () => { if (typeof updateDiscordHideName === 'function') updateDiscordHideName(inp.checked); });
    const line = el('span', 'settings-label-line');
    line.append(
      el('span', null, t('discord_hide_name', 'Hide my name')),
      el('span', 'settings-hint', t('discord_hide_name_hint', 'Keep your Discord name off the widget.')));
    row.append(inp, line);
    return row;
  }

  // Discord-only: the notification-mirroring opt-in, on the provider card because
  // the re-link its extra scope needs happens right here. Reads the shared
  // script-scope `hubSettings` (NOT window.hubSettings — never assigned) and saves
  // through settings.js's global updateDiscordNotifications. OFF by default.
  function buildDiscordNotifBlock(st) {
    const box = el('div', 'streaming-notif');
    const dn = (typeof hubSettings === 'object' && hubSettings && hubSettings.discordNotifications) || { enabled: false, hide: false };
    const toggleRow = (labelKey, labelFb, hintKey, hintFb, checked, onChange) => {
      const row = el('label', 'settings-toggle-row full');
      const inp = document.createElement('input');
      inp.type = 'checkbox'; inp.className = 'settings-check'; inp.checked = checked;
      inp.addEventListener('change', () => onChange(inp.checked));
      const line = el('span', 'settings-label-line');
      line.append(el('span', null, t(labelKey, labelFb)), el('span', 'settings-hint', t(hintKey, hintFb)));
      row.append(inp, line);
      return row;
    };
    const hideRow = toggleRow(
      'streaming_discord_notif_hide', 'Hide content until tapped',
      'streaming_discord_notif_hide_hint', 'Show who wrote, but keep the text masked until you tap the notification.',
      dn.hide, (on) => { if (typeof updateDiscordNotifications === 'function') updateDiscordNotifications('hide', on); });
    // Show the re-link note ONLY on a CONFIRMED scope failure: the server sets
    // st.notif='scope_missing' when the live watch actually tried to subscribe
    // with the stored token and Discord refused. 'off' just means the watch
    // hasn't (re)probed yet — right after a successful Connect the scope check
    // takes a beat, and showing the warning then reads as "it failed again".
    const relinkNeeded = (on) => on && st.connected && st.notif === 'scope_missing';
    const relink = el('p', 'settings-note streaming-warn',
      t('streaming_discord_notif_relink', 'To activate, Disconnect and reconnect Discord once — the link needs the extra notification permission.'));
    box.appendChild(toggleRow(
      'streaming_discord_notif', 'Mirror notifications on the dashboard',
      'streaming_discord_notif_hint', 'DMs and mentions appear in the Discord widget. Read locally from the desktop app — nothing leaves this PC.',
      dn.enabled, (on) => {
        if (typeof updateDiscordNotifications === 'function') updateDiscordNotifications('enabled', on);
        hideRow.hidden = !on;
        relink.hidden = !relinkNeeded(on);
      }));
    hideRow.hidden = !dn.enabled;
    relink.hidden = !relinkNeeded(dn.enabled);
    box.append(hideRow, relink);
    return box;
  }

  // Manage-credentials strip for an ALREADY-configured provider. The setup form
  // only renders while a provider is unconfigured, so without this a wrong-but-
  // saved Client ID / secret is unrecoverable from the UI (you'd be stuck on a
  // Connect button that can never succeed). "Edit" reveals the setup form to
  // overwrite them; "Reset" clears them (empty strings, which saveStreamConfig
  // accepts) and drops any token, returning the card to the fresh setup form.
  function buildCredActions(cfg) {
    const box = el('div', 'streaming-cred-actions');
    const edit = el('button', 'settings-btn settings-btn-ghost', t('streaming_edit_creds', 'Edit credentials'));
    edit.addEventListener('click', () => {
      edit.remove();
      box.parentNode.insertBefore(buildSetupForm(cfg), box);
    });
    box.appendChild(edit);
    const reset = el('button', 'settings-btn danger', t('streaming_reset_creds', 'Reset credentials'));
    reset.addEventListener('click', async () => {
      reset.disabled = true;
      const patch = {};
      cfg.fields.forEach(f => { patch[f.key] = ''; });
      await api('/stream/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      await api(cfg.base + '/logout', { method: 'POST' }).catch(() => {});
      render();   // now unconfigured → fresh setup form
    });
    box.appendChild(reset);
    return box;
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
    // RPC (Discord): one blocking POST that resolves when the user approves the
    // consent dialog in the Discord desktop app — no code to type, no polling.
    if (cfg.flow === 'rpc') {
      showRpcWaiting(card);
      const r = await api(cfg.base + '/login', { method: 'POST' });
      if (r && r.ok) { render(); return; }
      card.querySelectorAll('.streaming-login').forEach(n => n.remove());
      btn.disabled = false;
      setNote(card, rpcLoginError(r && r.error));
      return;
    }
    const r = await api(cfg.base + '/login', { method: 'POST' });
    if (!r || !r.ok) { btn.disabled = false; setNote(card, t('streaming_error', 'Could not start login. Try again.')); return; }
    showCode(card, r);
    pollLogin(cfg, r.deviceCode, r.interval || 5);
  }

  // Map a discord-rpc login() error code to a specific, actionable note. Most RPC
  // failures come down to the desktop Discord being signed in with a DIFFERENT
  // account than the one that created the app, a wrong Client ID/Secret, or a
  // redirect-URL mismatch — so each case points the user at the likely fix
  // instead of the generic "try again".
  function rpcLoginError(err) {
    switch (err) {
      case 'discord_not_running':
        return t('streaming_discord_notrunning', 'Discord desktop app not detected. Open Discord and try again.');
      case 'discord_pipe_busy':
        return t('streaming_discord_busy', 'Discord\'s local connection is busy (another app may be using it). Wait a moment and try Connect again.');
      case 'discord_closed':
        return t('streaming_discord_closed', 'Discord closed the connection. Check that the Client ID is correct and that Discord desktop is signed in with the account that created this application.');
      case 'authorize_denied':
        return t('streaming_discord_denied', 'Authorization was denied in Discord. Approve the request — and make sure you are signed in with the account that owns this application.');
      case 'authorize_timeout':
        return t('streaming_discord_timeout', 'The authorization window timed out. Try again and click "Authorize" in Discord promptly.');
      case 'token_exchange_failed':
        return t('streaming_token_failed', 'Login failed while exchanging the code. Check the Client Secret and that the redirect URL is exactly http://localhost.');
      default:
        return t('streaming_error', 'Could not start login. Try again.');
    }
  }

  // Interim state while the Discord consent dialog is open (RPC flow).
  function showRpcWaiting(card) {
    card.querySelectorAll('.streaming-login, .streaming-err').forEach(n => n.remove());
    const box = el('div', 'streaming-login');
    box.appendChild(el('p', 'settings-note', t('streaming_discord_authorize', 'Open Discord and click "Authorize" in the pop-up that appears.')));
    box.appendChild(el('p', 'streaming-poll', t('streaming_waiting', 'Waiting for authorisation…')));
    card.appendChild(box);
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
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg>',
    shoutout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11v2l4 1 2 5h2l-1-4 9 2V7l-9 2-4-.5z"/><path d="M19 8a4 4 0 0 1 0 8"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>',
  };

  // Toggle the chat to take over most of the widget — the wordy fields/selects
  // step aside but the essential one-tap controls stay pinned above it (CSS) — or
  // back to the normal split layout. State lives on the tile's .twitch-wrap so it
  // survives per-poll repaints (the skeleton is never rebuilt).
  function toggleChatExpanded(wrap, btn) {
    const expanded = wrap.classList.toggle('chat-expanded');
    btn.innerHTML = expanded ? TW_ICONS.collapse : TW_ICONS.expand;   // static, trusted SVG
    btn.title = t(expanded ? 'twitch_chat_collapse' : 'twitch_chat_expand', expanded ? 'Collapse chat' : 'Expand chat');
    const log = wrap.querySelector('.twitch-chat-log');
    if (log) log.scrollTop = log.scrollHeight;   // keep newest messages in view
  }

  // Open Settings → Streaming directly (from the widget's "not linked" notice).
  function openStreamingSettings() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay && overlay.hidden && typeof window.toggleSettings === 'function') window.toggleSettings();
    if (typeof window.settingsSetCategory === 'function') window.settingsSetCategory('streaming');
  }

  // POST a Deck action (reuses the allowlisted dispatcher) and flash the button.
  // Returns the response so callers can react (e.g. clear a field only on success).
  async function runWidgetAction(btn, action) {
    btn.disabled = true; btn.classList.remove('ok', 'err');
    const r = await api('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
    btn.classList.add(r && r.ok ? 'ok' : 'err');
    setTimeout(() => { btn.classList.remove('ok', 'err'); btn.disabled = false; }, 1400);
    return r;
  }

  // A one-tap action button. `needsLive` tags actions that only work while the
  // channel is live, so paintTiles can dim them when offline.
  function actBtn(iconKey, labelKey, fallback, onClick, needsLive) {
    const b = el('button', 'twitch-act-btn' + (needsLive ? ' twitch-needs-live' : ''));
    const ico = el('span', 'twitch-act-ico'); ico.innerHTML = TW_ICONS[iconKey];   // static, trusted SVG
    b.append(ico, el('span', 'twitch-act-lbl', t(labelKey, fallback)));
    b.addEventListener('click', () => onClick(b));
    return b;
  }

  // A text input + send button: fires buildAction(value) on click or Enter, then
  // clears the field on success when `clearOnSend`. `needsLive` dims it offline.
  function twitchField(phKey, iconKey, clearOnSend, needsLive, buildAction) {
    const row = el('div', 'twitch-field' + (needsLive ? ' twitch-needs-live' : ''));
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'twitch-field-input'; inp.placeholder = t(phKey); inp.spellcheck = false;
    const send = el('button', 'twitch-act-btn twitch-field-send');
    const ico = el('span', 'twitch-act-ico'); ico.innerHTML = TW_ICONS[iconKey];   // static, trusted SVG
    send.appendChild(ico);
    const fire = () => {
      const v = inp.value.trim();
      if (!v) { inp.focus(); return; }
      runWidgetAction(send, buildAction(v)).then((r) => { if (clearOnSend && r && r.ok) inp.value = ''; });
    };
    send.addEventListener('click', fire);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fire(); } });
    row.append(inp, send);
    return row;
  }

  // A labelled <select> + run button. `options` are [value, i18nKey] or
  // [value, null, literalText]. The run button fires buildAction(select.value).
  function twitchSelectRow(labelKey, options, iconKey, runLabelKey, needsLive, buildAction) {
    const grp = el('div', 'twitch-act-grp' + (needsLive ? ' twitch-needs-live' : ''));
    grp.appendChild(el('span', 'twitch-act-grp-lbl', t(labelKey)));
    const sel = document.createElement('select'); sel.className = 'twitch-act-len';
    options.forEach((o) => { const opt = document.createElement('option'); opt.value = o[0]; opt.textContent = (o[2] != null) ? o[2] : t(o[1]); sel.appendChild(opt); });
    const run = actBtn(iconKey, runLabelKey, '', (b) => runWidgetAction(b, buildAction(sel.value)), false);
    grp.append(sel, run);
    return grp;
  }

  function buildActionsCard() {
    const wrap = el('div', 'twitch-actions');

    // ── Quick one-tap row: stream/mic + clip/marker ──────────────────────────
    const quick = el('div', 'twitch-act-row');
    // Go live / end stream — toggles OBS streaming (you broadcast via OBS).
    const golive = el('button', 'twitch-act-btn twitch-golive twitch-act-primary');
    golive.append(el('span', 'twitch-act-ico'), el('span', 'twitch-act-lbl'));
    golive.addEventListener('click', () => runWidgetAction(golive, { type: 'obsStream', mode: 'toggle' }));
    const mic = el('button', 'twitch-act-btn twitch-mic');
    mic.append(el('span', 'twitch-act-ico'), el('span', 'twitch-act-lbl'));
    mic.addEventListener('click', () => runWidgetAction(mic, { type: 'micMute', mode: 'toggle' }));
    const clip = actBtn('clip', 'deck_act_twitchClip', 'Clip', (b) => runWidgetAction(b, { type: 'twitchClip' }), true);
    const marker = actBtn('marker', 'deck_act_twitchMarker', 'Marker', (b) => runWidgetAction(b, { type: 'twitchMarker' }), true);
    quick.append(golive, mic, clip, marker);

    // ── Text fields: title / category / chat message / shoutout ──────────────
    const fields = el('div', 'twitch-fields');
    fields.append(
      twitchField('twitch_ph_title', 'check', false, false, (v) => ({ type: 'twitchTitle', title: v })),
      twitchField('twitch_ph_game', 'check', false, false, (v) => ({ type: 'twitchGame', game: v })),
      twitchField('twitch_ph_chat', 'send', true, false, (v) => ({ type: 'twitchChat', message: v })),
      twitchField('twitch_ph_shoutout', 'shoutout', true, true, (v) => ({ type: 'twitchShoutout', login: v })),
    );

    // ── Select rows: chat mode + ad break (the duration was the mystery "30s") ─
    const selrow = el('div', 'twitch-act-row twitch-selrow');
    selrow.append(
      twitchSelectRow('twitch_chatmode', [
        ['emoteonly', 'deck_opt_emoteonly'], ['followers', 'deck_opt_followers'],
        ['subscribers', 'deck_opt_subscribers'], ['slow', 'deck_opt_slow'], ['off', 'deck_opt_off'],
      ], 'check', 'twitch_apply', false, (v) => ({ type: 'twitchChatMode', mode: v })),
      twitchSelectRow('twitch_ad_label', ['30', '60', '90', '120', '150', '180'].map((s) => [s, null, s + 's']),
        'ad', 'twitch_ad_run', true, (v) => ({ type: 'twitchAd', length: v })),
    );

    wrap.append(quick, fields, selrow);
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

    // Shown only when the Twitch *account* isn't linked: the widget's live state,
    // channel name, chat and clip/marker/ad all need the API connection (the
    // "Go live" button works without it because it drives OBS). A tap jumps
    // straight to Settings → Streaming so the OFFLINE/— state isn't a dead end.
    const notice = el('button', 'twitch-notice'); notice.type = 'button'; notice.hidden = true;
    const nIco = el('span', 'twitch-notice-ico'); nIco.innerHTML = TW_ICONS.tv;   // static, trusted SVG
    notice.append(nIco, el('span', 'twitch-notice-txt', t('twitch_not_connected', 'Connect in Settings → Streaming')));
    notice.addEventListener('click', openStreamingSettings);
    wrap.appendChild(notice);

    const cards = el('div', 'twitch-cards');
    const actions = el('section', 'twitch-card twitch-card--actions'); actions.dataset.systemCard = 'actions'; actions.dataset.systemCardGroup = 'twitch';
    actions.appendChild(el('div', 'twitch-card-label', t('layout_card_actions', 'Actions')));
    actions.appendChild(buildActionsCard());
    const chat = el('section', 'twitch-card twitch-card--chat'); chat.dataset.systemCard = 'chat'; chat.dataset.systemCardGroup = 'twitch';
    const chatHead = el('div', 'twitch-card-head');
    chatHead.appendChild(el('div', 'twitch-card-label', t('layout_card_chat', 'Chat')));
    const chatToggle = el('button', 'twitch-chat-toggle'); chatToggle.type = 'button';
    chatToggle.title = t('twitch_chat_expand', 'Expand chat');
    chatToggle.innerHTML = TW_ICONS.expand;   // static, trusted SVG
    chatToggle.addEventListener('click', () => toggleChatExpanded(wrap, chatToggle));
    chatHead.appendChild(chatToggle);
    chat.appendChild(chatHead);
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
      // When the account isn't linked we can't know the live state at all, so say
      // "Not linked" rather than a misleading "Offline" (you can be live via OBS).
      head.querySelector('.twitch-status-text').textContent =
        !connected ? t('twitch_notlinked', 'Not linked') : (live ? 'LIVE' : t('twitch_offline', 'Offline'));
      const notice = mount.querySelector('.twitch-notice');
      if (notice) notice.hidden = connected;

      // Actions that only work on a live channel (clip/marker/ad/shoutout) are
      // tagged twitch-needs-live and dimmed when offline. Title/category/chat/
      // chat-mode work anytime, so they stay fully lit.
      mount.querySelectorAll('.twitch-needs-live').forEach(b => { b.classList.toggle('is-idle', !live); });
    });
    paintControls();
    paintPreview();
  }

  async function refreshTiles() {
    if (!twitchTiles().length) { stopTilePoll(); closeChat(); return; }
    // Hidden tab or a tile parked on a non-current pager page: skip the status/stream
    // polls AND drop the chat socket so nothing streams in while nobody's watching.
    if (document.hidden || !twitchTiles().some(onVisiblePage)) { manageChat(); return; }
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
    // The chat WebSocket should live only while a Twitch tile is actually on screen —
    // a hidden tab or an off-current-page tile keeps receiving PRIVMSGs and mutating
    // the DOM for nothing. This is the single gate for "should the socket be open".
    const visible = !document.hidden && twitchTiles().some(onVisiblePage);
    const connected = visible && !!(lastStatus && lastStatus.connected && lastStatus.login);
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
