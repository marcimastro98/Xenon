'use strict';
// Settings → Spotify: a dedicated connect card for the Spotify integration
// (Authorization Code + PKCE — Client ID only, no secret). Kept out of the generic
// Streaming hub because it has its own redirect-URI setup and its own Settings
// category with the "what you get" explanation. Tokens live only on the server;
// this page only ever sees { connected, login, configured }. Renders into
// #settings-spotify-hub.
(function () {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;   // shared DOM factory from utils.js
  const api = apiJson; // shared fetch-JSON helper from utils.js
  const BASE = '/stream/spotify';
  let pollTimer = null;

  function mount() { return document.getElementById('settings-spotify-hub'); }
  function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

  // The exact redirect URI to register in the Spotify app. Pinned to the loopback
  // IP (Spotify rejects `localhost`) with this dashboard's actual port.
  function redirectUri() {
    return 'http://127.0.0.1:' + (location.port || '3030') + '/stream/spotify/callback';
  }

  // Stop polling once the Spotify section is no longer on screen (category switch
  // or the whole Settings overlay closed) so an abandoned login never runs forever.
  function sectionVisible() {
    const g = document.querySelector('.settings-group[data-settings-cat="spotify"]');
    const overlay = document.getElementById('settings-overlay');
    return !!(g && !g.hidden && (!overlay || !overlay.hidden));
  }

  async function render() {
    const host = mount();
    if (!host) return;
    const st = (await api(BASE + '/status')) || {};
    if (!mount()) return;                 // closed while awaiting
    host.replaceChildren(buildCard(st));
  }

  function buildCard(st) {
    const card = el('div', 'streaming-card');
    card.dataset.provider = 'spotify';
    const head = el('div', 'streaming-card-head');
    head.appendChild(el('span', 'streaming-card-title', 'Spotify'));
    head.appendChild(el('span', 'streaming-dot' + (st.connected ? ' on' : '')));
    card.appendChild(head);

    if (st.connected) {
      card.appendChild(el('p', 'streaming-connected', t('streaming_connected_as', 'Connected as') + ' ' + (st.login || '')));
      // A connected token with no display name usually means Spotify didn't confirm
      // the account (approved with a different account than the one that owns the
      // app, or the app is in Development Mode and the account isn't added under
      // Users). Same signal as the Liked-Songs "reconnect" hint — guide the fix.
      if (!st.login) {
        card.appendChild(el('p', 'settings-note streaming-warn', t('spotify_no_user_hint', 'Linked, but Spotify hasn\'t confirmed the account. If this doesn\'t fill in shortly, make sure you approved with the same Spotify account that created the app — and, if the app is in Development Mode, add that account under "Users and Access" in the Spotify Developer Dashboard.')));
      }
      if (!st.configured) {
        card.appendChild(el('p', 'settings-note streaming-warn', t('streaming_creds_missing', 'App credentials not found — re-enter them to keep this connection working after a restart.')));
        card.appendChild(buildSetupForm());
      }
      const out = el('button', 'settings-btn danger', t('streaming_disconnect', 'Disconnect'));
      out.addEventListener('click', async () => { out.disabled = true; stopPoll(); await api(BASE + '/logout', { method: 'POST' }); render(); });
      card.appendChild(out);
      if (st.configured) card.appendChild(buildCredActions());
      return card;
    }
    if (!st.configured) { card.appendChild(buildSetupForm()); return card; }
    const btn = el('button', 'settings-btn primary', t('streaming_connect', 'Connect'));
    btn.addEventListener('click', () => startLogin(card, btn));
    card.appendChild(btn);
    card.appendChild(buildCredActions());
    return card;
  }

  // Manage-credentials strip for an already-configured Spotify app. Without it a
  // wrong-but-saved Client ID is unrecoverable from the UI (the setup form only
  // shows while unconfigured, so you'd be stuck on a Connect that can't succeed).
  // "Edit" reveals the setup form to overwrite the Client ID; "Reset" clears it
  // (empty string, which saveStreamConfig accepts) and drops any token, returning
  // the card to first-time setup. Mirrors the generic Streaming hub cards.
  function buildCredActions() {
    const box = el('div', 'streaming-cred-actions');
    const edit = el('button', 'settings-btn settings-btn-ghost', t('streaming_edit_creds', 'Edit credentials'));
    edit.addEventListener('click', () => { edit.remove(); box.parentNode.insertBefore(buildSetupForm(), box); });
    box.appendChild(edit);
    const reset = el('button', 'settings-btn danger', t('streaming_reset_creds', 'Reset credentials'));
    reset.addEventListener('click', async () => {
      reset.disabled = true;
      stopPoll();
      await api('/stream/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spotifyClientId: '' }) });
      await api(BASE + '/logout', { method: 'POST' }).catch(() => {});
      render();   // now unconfigured → fresh setup form
    });
    box.appendChild(reset);
    return box;
  }

  // Setup form (shown until a Client ID is saved): the copyable redirect URI to
  // register, a link to the Spotify dashboard, the Client ID input, and Save.
  function buildSetupForm() {
    const box = el('div', 'streaming-setup');
    box.appendChild(buildCopyRow(t('streaming_spotify_redirect', 'Redirect URI (add this to your Spotify app)'), redirectUri()));
    const link = el('a', 'streaming-setup-link', t('streaming_open_console', 'Open developer console'));
    link.href = 'https://developer.spotify.com/dashboard'; link.target = '_blank'; link.rel = 'noopener';
    box.appendChild(link);
    const field = el('label', 'streaming-field');
    field.appendChild(el('span', 'streaming-field-label', t('streaming_field_clientid', 'Client ID')));
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'settings-text-input streaming-input';
    inp.spellcheck = false; inp.autocomplete = 'off';
    field.appendChild(inp);
    box.appendChild(field);
    const save = el('button', 'settings-btn primary', t('streaming_save', 'Save'));
    save.addEventListener('click', async () => {
      const v = inp.value.trim();
      if (!v) { inp.focus(); return; }
      save.disabled = true;
      await api('/stream/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spotifyClientId: v }) });
      render();   // now configured → Connect button
    });
    box.appendChild(save);
    return box;
  }

  // A read-only value with a one-tap Copy button — used for the redirect URI so the
  // user can paste it into Spotify without re-typing it exactly.
  function buildCopyRow(labelText, value) {
    const wrap = el('div', 'streaming-field streaming-copy');
    wrap.appendChild(el('span', 'streaming-field-label', labelText));
    const row = el('div', 'streaming-copy-row');
    const code = el('code', 'streaming-copy-val', value);
    const btn = el('button', 'settings-btn streaming-copy-btn', t('streaming_copy', 'Copy'));
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      const ok = await copyText(value);
      btn.textContent = t(ok ? 'streaming_copied' : 'streaming_copy', ok ? 'Copied' : 'Copy');
      if (ok) setTimeout(() => { btn.textContent = t('streaming_copy', 'Copy'); }, 1500);
    });
    row.append(code, btn);
    wrap.appendChild(row);
    return wrap;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* fall through to the legacy path */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }

  function setNote(card, msg) {
    let note = card.querySelector('.streaming-err');
    if (!note) { note = el('p', 'settings-note streaming-err'); card.appendChild(note); }
    note.textContent = msg;
  }

  // Open Spotify's consent page in a new tab, then poll /status until the loopback
  // callback stores the tokens. No code to type.
  async function startLogin(card, btn) {
    btn.disabled = true;
    const r = await api(BASE + '/login', { method: 'POST' });
    if (!r || !r.ok || !r.authUrl) { btn.disabled = false; setNote(card, t('streaming_error', 'Could not start login. Try again.')); return; }
    window.open(r.authUrl, '_blank', 'noopener');
    card.querySelectorAll('.streaming-login, .streaming-err').forEach(n => n.remove());
    const wait = el('div', 'streaming-login');
    wait.appendChild(el('p', 'settings-note', t('streaming_spotify_authorize', 'A Spotify tab opened — approve access there, then return here.')));
    wait.appendChild(el('p', 'streaming-poll', t('streaming_waiting', 'Waiting for authorisation…')));
    card.appendChild(wait);
    poll(0);
  }

  // Bounded (~4 min) so a login the user abandons doesn't poll forever; also stops
  // the moment the section is hidden.
  function poll(tries) {
    stopPoll();
    if (tries > 96) { render(); return; }
    pollTimer = setTimeout(async () => {
      if (!sectionVisible()) { stopPoll(); return; }
      const st = await api(BASE + '/status');
      if (!sectionVisible()) { stopPoll(); return; }
      if (st && st.connected) { stopPoll(); render(); return; }
      poll(tries + 1);
    }, 2500);
  }

  // Called by settings.js whenever the Settings modal (re)opens.
  function init() {
    if (!mount()) return;
    stopPoll();
    render();
  }

  window.SpotifySettings = { init };
})();
