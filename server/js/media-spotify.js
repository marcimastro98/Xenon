'use strict';
// Media tile → Spotify enrichment. The Playback tab reads Windows SMTC (any app),
// which already gives cover, title, transport and per-app volume. When the source
// is *Spotify* AND the Spotify API is linked (Settings → Spotify), this adds the
// Spotify-only extras SMTC can't: a real seek bar, ♥ save-to-Liked, shuffle,
// repeat, and collapsible playlists + Connect devices. Anything Spotify-specific
// goes through the allowlisted /actions/run spotify* actions; state is read from
// /stream/spotify/player (+ /playlists, /devices on demand).
//
// It shows ONLY when the source is Spotify and the account is linked (a Spotify
// source that isn't linked, or any other player, hides the strip entirely) — so
// the Media tile stays clean for everyone else. Polls only while the Playback
// pane is actually visible; a 1s local ticker keeps the seek bar smooth between
// polls. Rendered once into #media-pane-play .media-content (single instance,
// like the per-app volume control).
(function () {
  const ICONS = {
    shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.3 4.2 12.5a4.4 4.4 0 0 1 6.2-6.2l1.6 1.6 1.6-1.6a4.4 4.4 0 0 1 6.2 6.2z"/></svg>',
    heartFilled: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5 4.05 12.6a4.5 4.5 0 0 1 6.36-6.37L12 7.8l1.59-1.57a4.5 4.5 0 0 1 6.36 6.37z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h11M4 12h11M4 17h7"/><circle cx="19" cy="16" r="2.4"/><path d="M21.4 16V9l-2.4.8"/></svg>',
    devices: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="12" height="9" rx="1.5"/><path d="M6 20h6M9 13v7"/><rect x="16" y="9" width="5" height="11" rx="1.5"/></svg>',
    computer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>',
    speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="3"/><circle cx="12" cy="14" r="4"/><path d="M12 6h.01"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };
  function deviceIcon(type) {
    if (type === 'computer') return ICONS.computer;
    if (type === 'smartphone' || type === 'tablet') return ICONS.phone;
    return ICONS.speaker;
  }

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = (tag, cls, txt) => (typeof makeEl === 'function' ? makeEl(tag, cls, txt) : (() => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; })());
  const api = (url, opt) => (typeof apiJson === 'function' ? apiJson(url, opt) : fetch((typeof SERVER === 'string' ? SERVER : '') + url, opt).then(r => r.json()).catch(() => null));

  let player = null;         // rich state from /stream/spotify/player
  let playlists = null;
  let devices = null;
  let drawer = '';           // '' | 'playlists' | 'devices'
  let shown = false;         // strip currently visible (source spotify + linked)
  let pollTimer = null;
  let tickTimer = null;
  let dragging = false;
  let localProgressMs = 0;
  let loading = false;
  let active = false;        // strip lifecycle running (source is Spotify)
  let lastKey = '';          // last media track key, to resync promptly on song change
  let rateBackoffUntil = 0;  // while Spotify 429s us, hold off polling until this time
  const POLL_MS = 5000;

  const pane = () => document.getElementById('media-pane-play');
  // Enrich only when the current media source is Spotify (the SMTC app resolves to
  // Spotify). Whether the API is *linked* is decided by the /player response.
  function sourceIsSpotify() {
    return (typeof hasActiveMedia === 'function' && hasActiveMedia())
      && typeof mediaData === 'object' && mediaData && /spotify/i.test(String(mediaData.app || ''));
  }
  // Poll only while the Playback pane is actually on screen (not the Chat/Discord
  // tab, not a hidden dashboard). offsetParent is null when an ancestor is display:none.
  function paneVisible() { const p = pane(); return !!(p && p.offsetParent !== null) && !document.hidden; }

  function fmt(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '0:00';
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function controlToast(r) {
    if (!r || r.ok) return;
    const e = r.error || '';
    let msg = '';
    if (e === 'premium_required') msg = t('spotify_w_premium', 'Spotify Premium required for playback control');
    else if (e === 'forbidden') msg = t('spotify_w_reconnect', 'Reconnect Spotify in Settings → Spotify to grant permission');
    else if (e === 'no_active_device') msg = t('spotify_w_no_active', 'No active Spotify device — start playback first');
    else if (e === 'nothing_playing') msg = t('spotify_w_nothing', 'Nothing playing right now');
    if (msg && typeof showHubToast === 'function') showHubToast('Spotify', msg, '');
  }

  async function runAction(btn, action) {
    if (btn) { btn.disabled = true; btn.classList.remove('ok', 'err'); }
    const r = await api('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
    const ok = !!(r && r.ok);
    if (btn) { btn.classList.add(ok ? 'ok' : 'err'); setTimeout(() => { btn.classList.remove('ok', 'err'); btn.disabled = false; }, 1000); }
    if (!ok) controlToast(r);
    await loadPlayer();
    if (drawer === 'devices') await loadDevices();
    paint();
    return r;
  }

  function iconBtn(cls, icon, title) {
    const b = el('button', 'msp-ctl ' + cls); b.type = 'button'; b.title = title;
    b.innerHTML = icon;   // static, trusted SVG
    return b;
  }

  // Build the strip once inside the media content column, after the volume row.
  function ensure() {
    const p = pane();
    if (!p) return false;
    const content = p.querySelector('.media-content');
    if (!content) return false;
    if (content.querySelector('.msp')) return true;

    const strip = el('div', 'msp'); strip.hidden = true;

    // Seek row
    const seek = el('div', 'msp-seek');
    const cur = el('span', 'msp-time msp-cur', '0:00');
    const range = document.createElement('input');
    range.type = 'range'; range.className = 'msp-range'; range.min = '0'; range.max = '1000'; range.value = '0';
    range.setAttribute('aria-label', t('spotify_w_seek', 'Seek'));
    const tot = el('span', 'msp-time msp-tot', '0:00');
    range.addEventListener('input', () => { dragging = true; setFill(range); const dur = dur0(); if (dur > 0) cur.textContent = fmt(Number(range.value) / 1000 * dur); });
    range.addEventListener('change', () => {
      dragging = false;
      const dur = dur0();
      if (dur > 0) { const ms = Math.round(Number(range.value) / 1000 * dur); localProgressMs = ms; runAction(null, { type: 'spotifySeek', value: String(ms) }); }
    });
    seek.append(cur, range, tot);
    strip.appendChild(seek);

    // Control row: shuffle · like · repeat · (spacer) · Playlists · Devices
    const row = el('div', 'msp-row');
    const shuffle = iconBtn('msp-shuffle', ICONS.shuffle, t('spotify_w_shuffle', 'Shuffle'));
    shuffle.addEventListener('click', () => runAction(shuffle, { type: 'spotifyShuffle', mode: 'toggle' }));
    const like = iconBtn('msp-like', ICONS.heart, t('spotify_w_save', 'Save to Liked Songs'));
    like.addEventListener('click', () => runAction(like, { type: 'spotifyLike', mode: 'toggle' }));
    const repeat = iconBtn('msp-repeat', ICONS.repeat, t('spotify_w_repeat', 'Repeat'));
    repeat.addEventListener('click', () => runAction(repeat, { type: 'spotifyRepeat', mode: 'toggle' }));
    const spacer = el('span', 'msp-spacer');
    const plBtn = el('button', 'msp-pill msp-pill-pl'); plBtn.type = 'button';
    plBtn.innerHTML = ICONS.list; plBtn.append(el('span', null, t('spotify_w_playlists', 'Playlists')));
    plBtn.addEventListener('click', () => toggleDrawer('playlists'));
    const dvBtn = el('button', 'msp-pill msp-pill-dv'); dvBtn.type = 'button';
    dvBtn.innerHTML = ICONS.devices; dvBtn.append(el('span', null, t('spotify_w_devices', 'Devices')));
    dvBtn.addEventListener('click', () => toggleDrawer('devices'));
    row.append(shuffle, like, repeat, spacer, plBtn, dvBtn);
    strip.appendChild(row);

    // Place the seek + Spotify controls right under the transport, keeping the
    // per-app volume row at the very bottom.
    const vol = content.querySelector('#media-volume');
    if (vol) content.insertBefore(strip, vol);
    else content.appendChild(strip);

    // Playlists/Devices open as an overlay SHEET bounded to the pane, with its own
    // header + scroll area — an inline list would overflow the fixed-height tile
    // and clip its rows. Appended to the pane (position:relative) so it covers the
    // whole playback view; absolute positioning keeps it out of the grid flow.
    const sheet = el('div', 'msp-sheet'); sheet.hidden = true;
    const shead = el('div', 'msp-sheet-head');
    shead.append(el('span', 'msp-sheet-ico'), el('span', 'msp-sheet-title'));
    const close = el('button', 'msp-sheet-close'); close.type = 'button'; close.title = t('spotify_w_close', 'Close');
    close.innerHTML = ICONS.close;   // static, trusted SVG
    close.addEventListener('click', () => { drawer = ''; paint(); });
    shead.appendChild(close);
    sheet.append(shead, el('div', 'msp-sheet-list'));
    p.appendChild(sheet);
    return true;
  }

  function dur0() { return (player && player.durationMs) || 0; }
  function setFill(input) {
    const max = Number(input.max) || 100;
    input.style.setProperty('--msp-fill', (max ? (Number(input.value) / max) * 100 : 0) + '%');
  }

  function toggleDrawer(which) {
    drawer = (drawer === which) ? '' : which;
    if (drawer === 'playlists' && playlists === null) loadPlaylists().then(paint);
    else if (drawer === 'devices' && devices === null) loadDevices().then(paint);
    else paint();
  }

  function paintSeek() {
    if (dragging) return;
    const p = pane(); if (!p) return;
    const range = p.querySelector('.msp-range');
    if (!range) return;
    const dur = dur0();
    const pos = Math.min(localProgressMs, dur || localProgressMs);
    range.value = String(dur > 0 ? Math.round(pos / dur * 1000) : 0);
    range.disabled = !(dur > 0);
    setFill(range);
    const cur = p.querySelector('.msp-cur'); if (cur) cur.textContent = fmt(pos);
    const tot = p.querySelector('.msp-tot'); if (tot) tot.textContent = dur > 0 ? fmt(dur) : '0:00';
  }

  function drawerRows() {
    const frag = document.createDocumentFragment();
    if (drawer === 'playlists') {
      if (playlists === null) { frag.appendChild(el('div', 'msp-hint', t('spotify_w_loading', 'Loading…'))); return frag; }
      if (!playlists.length) { frag.appendChild(el('div', 'msp-hint', t('spotify_w_no_playlists', 'No playlists'))); return frag; }
      playlists.forEach(pl => {
        const b = el('button', 'msp-item'); b.type = 'button';
        const art = el('span', 'msp-item-art'); if (pl.image) art.style.backgroundImage = 'url("' + encodeURI(pl.image) + '")';
        const meta = el('div', 'msp-item-meta');
        meta.append(el('span', 'msp-item-name', pl.name || '—'));
        if (pl.tracks != null) meta.append(el('span', 'msp-item-sub', pl.tracks + ' ' + t('spotify_w_tracks', 'tracks')));
        const play = el('span', 'msp-item-go'); play.innerHTML = ICONS.play;   // static, trusted SVG
        b.append(art, meta, play);
        b.addEventListener('click', async () => { const r = await runAction(b, { type: 'spotifyPlaylist', playlist: pl.uri }); if (r && r.ok) { drawer = ''; paint(); } });
        frag.appendChild(b);
      });
    } else if (drawer === 'devices') {
      if (devices === null) { frag.appendChild(el('div', 'msp-hint', t('spotify_w_loading', 'Loading…'))); return frag; }
      if (!devices.length) { frag.appendChild(el('div', 'msp-hint', t('spotify_w_no_devices', 'No devices found'))); return frag; }
      devices.forEach(dv => {
        const b = el('button', 'msp-item' + (dv.active ? ' is-active' : '')); b.type = 'button';
        const ico = el('span', 'msp-item-ico'); ico.innerHTML = deviceIcon(dv.type);   // static, trusted SVG
        const meta = el('div', 'msp-item-meta');
        meta.append(el('span', 'msp-item-name', dv.name || '—'));
        const sub = dv.active ? t('spotify_w_playing_here', 'Playing here') : (dv.volume != null ? dv.volume + '%' : '');
        if (sub) meta.append(el('span', 'msp-item-sub', sub));
        b.append(ico, meta);
        if (dv.active) b.appendChild(el('span', 'msp-item-dot'));
        b.addEventListener('click', async () => { if (dv.active) return; const r = await runAction(b, { type: 'spotifyDevice', device: dv.name }); if (r && r.ok) { drawer = ''; paint(); } });
        frag.appendChild(b);
      });
    }
    return frag;
  }

  function paint() {
    const p = pane(); if (!p) return;
    const strip = p.querySelector('.msp'); if (!strip) return;
    strip.hidden = !shown;
    if (!shown) {
      const sh = p.querySelector('.msp-sheet'); if (sh) sh.hidden = true;
      drawer = '';
      return;
    }

    // Transport-state toggles
    const shuffle = p.querySelector('.msp-shuffle');
    if (shuffle) shuffle.classList.toggle('is-on', !!(player && player.shuffle));
    const repeat = p.querySelector('.msp-repeat');
    const rep = (player && player.repeat) || 'off';
    if (repeat) { repeat.classList.toggle('is-on', rep !== 'off'); repeat.classList.toggle('is-one', rep === 'track'); }
    const like = p.querySelector('.msp-like');
    if (like) { const liked = !!(player && player.liked); like.innerHTML = liked ? ICONS.heartFilled : ICONS.heart; like.classList.toggle('is-on', liked); }

    paintSeek();

    // Pills + overlay sheet
    p.querySelector('.msp-pill-pl').classList.toggle('is-open', drawer === 'playlists');
    p.querySelector('.msp-pill-dv').classList.toggle('is-open', drawer === 'devices');
    const sheet = p.querySelector('.msp-sheet');
    if (sheet) {
      sheet.hidden = !drawer;
      if (drawer) {
        sheet.querySelector('.msp-sheet-ico').innerHTML = drawer === 'playlists' ? ICONS.list : ICONS.devices;   // static, trusted SVG
        sheet.querySelector('.msp-sheet-title').textContent = drawer === 'playlists'
          ? t('spotify_w_playlists', 'Playlists') : t('spotify_w_devices', 'Devices');
        sheet.querySelector('.msp-sheet-list').replaceChildren(drawerRows());
      }
    }
  }

  // ── Data ────────────────────────────────────────────────────────────
  async function loadPlayer() {
    const r = await api('/stream/spotify/player');
    // Rate-limited: keep the last state and ease off hard (every ~30s), so we stop
    // restarting Spotify's window and the limit can actually clear.
    if (r && r.error === 'rate_limited') { rateBackoffUntil = Date.now() + 30000; return; }
    if (!r || r.error === 'not_connected' || r.ok === false) { player = null; shown = false; return; }
    player = r;                       // { ok, playing, track, progressMs, durationMs, shuffle, repeat, liked, ... }
    localProgressMs = r.progressMs || 0;
    shown = true;                     // source is Spotify AND the API is linked
  }
  function loadPlaylists() {
    return api('/stream/spotify/playlists').then(d => { playlists = (d && d.ok && Array.isArray(d.playlists)) ? d.playlists : []; }).catch(() => { playlists = []; });
  }
  function loadDevices() {
    return api('/stream/spotify/devices').then(d => { devices = (d && d.ok && Array.isArray(d.devices)) ? d.devices : []; }).catch(() => { devices = []; });
  }

  async function refresh() {
    if (!sourceIsSpotify() || !paneVisible()) return;
    if (Date.now() < rateBackoffUntil) return;   // rate-limit backoff
    if (loading) return; loading = true;
    try {
      await loadPlayer();
      if (shown && drawer === 'devices') await loadDevices();
      paint();
    } finally { loading = false; }
  }

  function tick() {
    if (!shown || !paneVisible() || dragging) return;
    if (!player || !player.playing || !player.track) return;
    const dur = player.durationMs || 0;
    localProgressMs = dur > 0 ? Math.min(localProgressMs + 1000, dur) : localProgressMs + 1000;
    paintSeek();
  }

  function startTimers() {
    if (!pollTimer) pollTimer = setInterval(refresh, POLL_MS);
    if (!tickTimer) tickTimer = setInterval(tick, 1000);
  }
  function stopTimers() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  const mediaKey = () => (typeof mediaData === 'object' && mediaData) ? (String(mediaData.title || '') + '|' + String(mediaData.artist || mediaData.album || '')) : '';

  // Called from media.js on every media update (fires often — SSE ticks). Manages
  // the strip lifecycle but only forces a /player refresh on the RISING edge
  // (source became Spotify) and when the TRACK actually changes — otherwise the
  // periodic 5s poll handles it, so idle media ticks don't drive extra requests.
  function sync() {
    if (!sourceIsSpotify()) {
      if (active) {
        active = false; shown = false; drawer = ''; stopTimers();
        const p = pane(); const strip = p && p.querySelector('.msp');
        if (strip) strip.hidden = true;
      }
      lastKey = '';
      return;
    }
    if (!ensure()) return;
    const key = mediaKey();
    if (!active) { active = true; lastKey = key; startTimers(); refresh(); }
    else if (key !== lastKey) { lastKey = key; refresh(); }   // song changed → resync now
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

  window.MediaSpotify = { sync };
})();
