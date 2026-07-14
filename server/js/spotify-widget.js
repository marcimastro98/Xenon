'use strict';
// Spotify dashboard widget — a full Spotify Connect remote for the dashboard.
// The centrepiece is a now-playing HERO (large cover, live seek bar, transport,
// shuffle/repeat/like, device volume). Below it, three tabs surface the pieces
// Windows SMTC (the Media tile) can't: the live "Up Next" queue, your playlists
// (tap to play) and your Spotify Connect devices (tap to move playback).
//
// Every control goes through the allowlisted /actions/run dispatcher (the same
// spotify* actions the Deck uses); the widget only READS state, via
// /stream/spotify/{player,queue,playlists,devices}. The Web API has no push
// channel, so state is polled — but ONLY while a tile is placed AND the page is
// visible (an idle/backgrounded dashboard does zero network work). A 1-second
// LOCAL ticker advances the progress bar between polls so it stays smooth without
// hammering the API. Requires the account linked in Settings → Spotify; playback
// control needs Premium. Renders into .spotify-widget-mount.
(function () {
  const ICONS = {
    // Official Spotify glyph (solid) — crisp at any size, unlike a hand-traced path.
    logo: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.42 1.56-.299.421-1.02.599-1.559.3z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5l9 7-9 7zM16 5h2.4v14H16z"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 5l-9 7 9 7zM5.6 5H8v14H5.6z"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.3 4.2 12.5a4.4 4.4 0 0 1 6.2-6.2l1.6 1.6 1.6-1.6a4.4 4.4 0 0 1 6.2 6.2z"/></svg>',
    heartFilled: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5 4.05 12.6a4.5 4.5 0 0 1 6.36-6.37L12 7.8l1.59-1.57a4.5 4.5 0 0 1 6.36 6.37z"/></svg>',
    volume: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h3l6 4V5L7 9H4Z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/></svg>',
    note: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    play_s: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    computer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>',
    speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="3"/><circle cx="12" cy="14" r="4"/><path d="M12 6h.01"/></svg>',
  };
  // A device's icon by its Spotify type (falls back to a generic speaker).
  function deviceIcon(type) {
    if (type === 'computer') return ICONS.computer;
    if (type === 'smartphone' || type === 'tablet') return ICONS.phone;
    return ICONS.speaker;
  }

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;   // shared DOM factory from utils.js
  const api = apiJson; // shared fetch-JSON helper from utils.js

  // Only tiles actually placed on a dashboard page count. A hidden / never-added
  // widget sits in the #widget-pool (outside any .pager-page), so it does no polling.
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="spotify"]')).filter(el => el.closest('.pager-page')); }
  // Tiles the user is actually looking at. The pager keeps off-screen pages
  // mounted, so a tile parked on page 2 still passes document.hidden and would
  // otherwise keep burning Spotify API quota invisibly — gate polling on this.
  // getClientRects() additionally catches a widget parked in a tab GROUP whose tab
  // isn't selected (display:none ancestor): it sits on the current page yet is
  // invisible, and polling Spotify for it all session long is what tripped the
  // rate limit that froze the player state (same class of bug as the v4.5.1
  // Cameras/Second-screen tab-visibility fix). NOT offsetParent: that reads null
  // for a genuinely-visible tile too (any position:fixed or display:contents
  // ancestor), which would wrongly freeze its polling and seek bar. An empty
  // getClientRects() means no layout box — i.e. a display:none somewhere above —
  // without those false negatives (same test jQuery's :visible uses).
  function visibleTiles() { return tiles().filter(el => onVisiblePage(el) && el.getClientRects().length > 0); }
  // Repaint one region of every BUILT mount (unbuilt tiles are skipped — the
  // skeleton hasn't run yet). Every repaint loop in this file goes through here.
  function repaintAll(fn) { tiles().forEach(tile => { const m = tile.querySelector('.spotify-widget-mount'); if (m && m.dataset.spBuilt === '1') fn(m); }); }

  let connected = null;      // null = unknown, from /stream/spotify/status
  let username = '';
  let player = null;         // rich now-playing state from /stream/spotify/player
  let queue = null;          // upcoming tracks (lazy, Up Next tab)
  let queueReliable = true;  // false when playing a loose track (no playlist context) → Spotify's Up Next is only a guess
  let playlists = null;      // cached list (loaded when the Playlists tab opens)
  let devices = null;        // cached list (loaded when the Devices tab opens)
  let seeded = false;
  let pollTimer = null;
  let tickTimer = null;
  let dragging = false;      // true while a seek/volume slider is being dragged
  let localProgressMs = 0;   // client-advanced progress between polls (smooth bar)
  let lastTrackId = null;    // to detect a track change and reset the seek bar
  // After a control that moves playback (next/prev/seek), Spotify keeps reporting
  // the PRE-action state for a moment — adopting it would snap the bar back to the
  // old song's time ("skipped but the bar kept the previous track's position").
  // While this window is open and the track hasn't changed, keep the local
  // (optimistic + ticking) position instead of the server's.
  let suppressSyncUntil = 0;
  let lastSyncAt = 0;        // last SUCCESSFUL /player read — while recent, the API stays authoritative
  let lastSmtcPos = null;    // last SMTC position seen while the API was stale — only a MOVED value is trusted (a frozen timeline must not yank the bar)
  // When nothing is playing: true = Spotify is open somewhere (a Connect device is
  // available) so the empty state offers Play; false = closed → offer "Open Spotify";
  // null = unknown/irrelevant (something is playing).
  let spotifyOpen = null;
  // true = a playback read came back 403 (the stored login is missing the
  // user-read-playback-state scope): Spotify can be playing and we still can't see
  // it, so the empty state must say "reconnect for permission", not "no device".
  let playbackForbidden = false;
  // true = Spotify is rate-limiting us (429). Brief and self-clearing; we keep the
  // last known state and show a neutral "busy" note rather than flapping to empty.
  let rateLimited = false;
  let backoffUntil = 0;      // while rate-limited, hold off polling until this time
  const POLL_MS = 6000;      // network refresh cadence while a tile is visible

  const TABS = [
    { id: 'queue', labelKey: 'spotify_w_upnext', fb: 'Up Next' },
    { id: 'playlists', labelKey: 'spotify_w_playlists', fb: 'Playlists' },
    { id: 'devices', labelKey: 'spotify_w_devices', fb: 'Devices' },
  ];
  let activeTab = 'queue';   // shared across this widget's tiles (session-scoped)

  function openSpotifySettings() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay && overlay.hidden && typeof window.toggleSettings === 'function') window.toggleSettings();
    if (typeof window.settingsSetCategory === 'function') window.settingsSetCategory('spotify');
  }

  // mm:ss for a millisecond duration (— when unknown).
  function fmt(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '0:00';
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // Turn a friendly error code from a control action into a brief toast so the
  // user learns *why* (Premium, no device) instead of a silent no-op.
  function controlToast(r) {
    if (!r || r.ok) return;
    const e = r.error || '';
    let msg = '';
    if (e === 'premium_required') msg = t('spotify_w_premium', 'Spotify Premium required for playback control');
    else if (e === 'forbidden') msg = t('spotify_w_reconnect', 'Reconnect Spotify in Settings → Spotify to grant permission');
    else if (e === 'no_active_device') msg = t('spotify_w_no_active', 'No active Spotify device — start playback first');
    else if (e === 'nothing_playing') msg = t('spotify_w_nothing', 'Nothing playing right now');
    else if (e === 'rate_limited') msg = t('spotify_w_busy', 'Spotify is busy — retrying shortly');
    if (msg && typeof showHubToast === 'function') showHubToast('Spotify', msg, '');
  }

  // Actions that move playback to a different track — their resync must WAIT for
  // Spotify to actually flip (an immediate read still reports the old track).
  const TRACK_CHANGE_ACTIONS = new Set(['spotifyNext', 'spotifyPrev', 'spotifyPlaylist']);
  const sleep = (ms) => new Promise(res => setTimeout(res, ms));

  // While Spotify's Web API is rate-limited it refuses even play/next/prev — but
  // when the music plays ON THIS PC those don't need the Web API at all: Windows'
  // media transport (the exact path the Media tile's buttons use) drives the local
  // Spotify app instantly. Only when the SELECTED media session is Spotify, so the
  // fallback can never skip another app's track.
  const SMTC_FALLBACK = { spotifyPlay: 'playpause', spotifyNext: 'next', spotifyPrev: 'previous' };

  // POST an allowlisted Deck action, flash the button, then resync so the view
  // reflects Spotify quickly. Returns the response so callers can react.
  async function runAction(btn, action) {
    if (btn) { btn.disabled = true; btn.classList.remove('ok', 'err'); }
    let r = await api('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
    let ok = !!(r && r.ok);
    if (!ok && r && r.error === 'rate_limited' && SMTC_FALLBACK[action.type]) {
      const md = (typeof mediaData === 'object' && mediaData) ? mediaData : null;
      if (md && md.active && /spotify/i.test(String(md.app || ''))) {
        // spotifyPlay must stay idempotent through the TOGGLE transport: the
        // empty-state button sends an explicit mode:'play', and under rate limit
        // the painted state is by definition stale — if Windows says the app is
        // already in the asked state, report success WITHOUT firing, or a "Play"
        // tap would pause music that is actually playing.
        const wanted = (action.type === 'spotifyPlay' && (action.mode === 'play' || action.mode === 'pause')) ? action.mode : '';
        if (wanted && (wanted === 'play') === (md.playbackStatus === 'Playing')) { r = { ok: true }; ok = true; }
        else {
          const fb = await api('/media/' + SMTC_FALLBACK[action.type], { method: 'POST' });
          if (fb && fb.ok) { r = fb; ok = true; }   // transport delivered locally — no "busy" toast
        }
      }
    }
    if (btn) { btn.classList.add(ok ? 'ok' : 'err'); setTimeout(() => { btn.classList.remove('ok', 'err'); btn.disabled = false; }, 1000); }
    if (!ok) controlToast(r);
    const changesTrack = ok && TRACK_CHANGE_ACTIONS.has(action.type);
    const fromTid = lastTrackId;   // the track we're skipping AWAY from
    if (changesTrack) {
      // Optimistic: the new song starts at 0. Suppress adopting server progress for
      // the same (= old) track while Spotify propagates the skip.
      suppressSyncUntil = Date.now() + 6000;
      localProgressMs = 0;
      repaintAll(paintSeek);
    }
    if (tiles().length) {
      if (changesTrack) {
        // Delayed fresh reads (cache bypassed) until the track actually flips.
        // (repeat-one legitimately keeps the same track: the loop just runs out.)
        for (const d of [450, 900, 1600]) {
          await sleep(d);
          await loadPlayer(true);
          const tid = (player && player.track && (player.track.uri || player.track.id)) || null;
          if (!player || tid !== fromTid) break;   // flipped (or state gone) → done
        }
        suppressSyncUntil = 0;   // resync settled — normal adoption resumes
      } else {
        await loadPlayer();
      }
      if (activeTab === 'queue') await loadQueue();
      else if (activeTab === 'devices') await loadDevices();
      paint();
    }
    return r;
  }

  // ── Skeleton (built once per mount, idempotent) ───────────────────────────
  function ctlBtn(cls, icon, title) {
    const b = el('button', 'sp-ctl ' + cls); b.type = 'button'; b.title = title;
    b.innerHTML = icon;   // static, trusted SVG
    return b;
  }

  function ensure(mount) {
    if (mount.dataset.spBuilt === '1' && mount.firstChild) return;
    mount.dataset.spBuilt = '1';
    const wrap = el('div', 'sp-wrap');

    // Header: logo + username, and a live device chip on the right.
    const head = el('div', 'sp-head');
    const brand = el('div', 'sp-brand');
    const logo = el('span', 'sp-logo'); logo.innerHTML = ICONS.logo;   // static, trusted SVG
    brand.append(logo, el('span', 'sp-user'));
    const chip = el('div', 'sp-dev-chip'); chip.hidden = true;
    chip.append(el('span', 'sp-dev-chip-ico'), el('span', 'sp-dev-chip-name'));
    head.append(brand, chip);
    wrap.appendChild(head);

    // "Account not linked" call-to-action — opens Settings → Spotify.
    const notice = el('button', 'sp-notice'); notice.type = 'button'; notice.hidden = true;
    const nIco = el('span', 'sp-notice-ico'); nIco.innerHTML = ICONS.logo;   // static, trusted SVG
    notice.append(nIco, el('span', 'sp-notice-txt', t('spotify_w_connect', 'Connect in Settings → Spotify')));
    notice.addEventListener('click', openSpotifySettings);
    wrap.appendChild(notice);

    // ── Now-playing hero ─────────────────────────────────────────────────
    const now = el('div', 'sp-now');

    // Big album cover — a DIRECT child of the hero so the layout can place it
    // ABOVE the controls (tall/portrait tiles) or BESIDE them (wide/short tiles).
    // It also drives the ambient blurred backdrop via the --sp-cover custom prop.
    const art = el('div', 'sp-now-art');
    const artPh = el('span', 'sp-now-art-ph'); artPh.innerHTML = ICONS.note;   // static, trusted SVG
    art.appendChild(artPh);
    now.appendChild(art);

    // Controls column: title/artist + like, seek, transport, volume.
    const panel = el('div', 'sp-now-panel');
    const nowHead = el('div', 'sp-now-head');
    const info = el('div', 'sp-now-info');
    info.append(el('span', 'sp-now-title'), el('span', 'sp-now-sub'));
    const like = ctlBtn('sp-like', ICONS.heart, t('spotify_w_save', 'Save to Liked Songs'));
    like.addEventListener('click', () => runAction(like, { type: 'spotifyLike', mode: 'toggle' }));
    nowHead.append(info, like);
    panel.appendChild(nowHead);

    // Seek row: elapsed — range — remaining.
    const seekRow = el('div', 'sp-seek');
    const cur = el('span', 'sp-time sp-cur', '0:00');
    const range = document.createElement('input');
    range.type = 'range'; range.className = 'sp-range sp-seek-range';
    range.min = '0'; range.max = '1000'; range.value = '0'; range.step = '1';
    range.setAttribute('aria-label', t('spotify_w_seek', 'Seek'));
    const tot = el('span', 'sp-time sp-tot', '0:00');
    range.addEventListener('input', () => { dragging = true; previewSeek(mount); });
    range.addEventListener('change', () => {
      dragging = false;
      const dur = (player && player.durationMs) || 0;
      if (dur > 0) {
        const ms = Math.round(Number(range.value) / 1000 * dur);
        localProgressMs = ms;                              // optimistic — no flicker back during the round-trip
        // Spotify reports the PRE-seek position for a moment after the call; adopting
        // it would snap the bar back to where it was. Hold the local position until
        // the state settles (a track change clears this early).
        suppressSyncUntil = Date.now() + 4000;
        runAction(null, { type: 'spotifySeek', value: String(ms) });
      }
    });
    seekRow.append(cur, range, tot);
    panel.appendChild(seekRow);

    // Transport: shuffle · prev · play/pause · next · repeat.
    const transport = el('div', 'sp-transport');
    const shuffle = ctlBtn('sp-shuffle', ICONS.shuffle, t('spotify_w_shuffle', 'Shuffle'));
    shuffle.addEventListener('click', () => runAction(shuffle, { type: 'spotifyShuffle', mode: 'toggle' }));
    const prev = ctlBtn('sp-prev', ICONS.prev, t('spotify_w_prev', 'Previous'));
    prev.addEventListener('click', () => runAction(prev, { type: 'spotifyPrev' }));
    const playBtn = ctlBtn('sp-play', ICONS.play, t('spotify_w_play', 'Play'));
    playBtn.addEventListener('click', () => {
      // Optimistic flip for instant feedback; the resync corrects if it failed.
      if (player) { player.playing = !player.playing; paintTransport(mount); }
      runAction(playBtn, { type: 'spotifyPlay', mode: 'toggle' });
    });
    const next = ctlBtn('sp-next', ICONS.next, t('spotify_w_next', 'Next'));
    next.addEventListener('click', () => runAction(next, { type: 'spotifyNext' }));
    const repeat = ctlBtn('sp-repeat', ICONS.repeat, t('spotify_w_repeat', 'Repeat'));
    repeat.addEventListener('click', () => runAction(repeat, { type: 'spotifyRepeat', mode: 'toggle' }));
    transport.append(shuffle, prev, playBtn, next, repeat);
    panel.appendChild(transport);

    // Volume (only shown when the active device supports it).
    const volRow = el('div', 'sp-vol');
    const volIco = el('span', 'sp-vol-ico'); volIco.innerHTML = ICONS.volume;   // static, trusted SVG
    const vol = document.createElement('input');
    vol.type = 'range'; vol.className = 'sp-range sp-vol-range';
    vol.min = '0'; vol.max = '100'; vol.value = '50'; vol.step = '1';
    vol.setAttribute('aria-label', t('spotify_w_volume', 'Volume'));
    vol.addEventListener('input', () => { dragging = true; setRangeFill(vol); });
    vol.addEventListener('change', () => { dragging = false; runAction(null, { type: 'spotifyVolume', mode: 'set', value: vol.value }); });
    volRow.append(volIco, vol);
    panel.appendChild(volRow);

    now.appendChild(panel);

    // Empty state shown inside the hero when linked but nothing is playing. Carries
    // an action button: Play (Spotify is open → resume) or Open Spotify (app closed).
    const empty = el('div', 'sp-now-empty');
    const eIco = el('span', 'sp-now-empty-ico'); eIco.innerHTML = ICONS.note;   // static, trusted SVG
    const emptyBtn = el('button', 'sp-now-empty-btn'); emptyBtn.type = 'button'; emptyBtn.hidden = true;
    emptyBtn.append(el('span', 'sp-now-empty-btn-ico'), el('span', 'sp-now-empty-btn-lbl'));
    emptyBtn.addEventListener('click', () => {
      if (spotifyOpen) runAction(emptyBtn, { type: 'spotifyPlay', mode: 'play' });
      else openSpotifyApp(emptyBtn);
    });
    const eHint = el('span', 'sp-now-empty-hint'); eHint.hidden = true;   // shown only when no Connect device is available
    empty.append(eIco, el('span', 'sp-now-empty-lbl', t('spotify_w_nothing', 'Nothing playing right now')), emptyBtn, eHint);
    now.appendChild(empty);

    wrap.appendChild(now);

    // ── Tabs ─────────────────────────────────────────────────────────────
    const tabs = el('div', 'sp-tabs');
    TABS.forEach(tb => {
      const b = el('button', 'sp-tab', t(tb.labelKey, tb.fb));
      b.type = 'button'; b.dataset.stab = tb.id;
      b.addEventListener('click', () => selectTab(tb.id));
      tabs.appendChild(b);
    });
    wrap.appendChild(tabs);

    const body = el('div', 'sp-body');
    const pq = el('div', 'sp-panel sp-panel--queue'); pq.dataset.stab = 'queue';
    const pp = el('div', 'sp-panel sp-panel--playlists'); pp.dataset.stab = 'playlists';
    const pd = el('div', 'sp-panel sp-panel--devices'); pd.dataset.stab = 'devices';
    body.append(pq, pp, pd);
    wrap.appendChild(body);
    mount.replaceChildren(wrap);
  }

  // Switch the active internal tab and lazy-load its data the first time it opens.
  function selectTab(id) {
    activeTab = id;
    if (id === 'queue' && queue === null && connected) loadQueue().then(paint);
    else if (id === 'playlists' && playlists === null && connected) loadPlaylists().then(paint);
    else if (id === 'devices' && devices === null && connected) loadDevices().then(paint);
    else paint();
  }

  // ── Hero paint helpers (update in place — never rebuild, so drags survive) ──
  function setRangeFill(input) {
    const min = Number(input.min) || 0, max = Number(input.max) || 100;
    const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
    input.style.setProperty('--sp-fill', pct + '%');
  }

  // Live preview while dragging the seek bar (time text follows the thumb).
  function previewSeek(mount) {
    const range = mount.querySelector('.sp-seek-range');
    const cur = mount.querySelector('.sp-cur');
    setRangeFill(range);
    const dur = (player && player.durationMs) || 0;
    if (cur && dur > 0) cur.textContent = fmt(Number(range.value) / 1000 * dur);
  }

  function paintTransport(mount) {
    const playing = !!(player && player.playing);
    const pb = mount.querySelector('.sp-play');
    if (pb) { pb.innerHTML = playing ? ICONS.pause : ICONS.play; pb.title = playing ? t('spotify_w_pause', 'Pause') : t('spotify_w_play', 'Play'); }
    mount.querySelector('.sp-shuffle').classList.toggle('is-on', !!(player && player.shuffle));
    const rp = mount.querySelector('.sp-repeat');
    const rep = (player && player.repeat) || 'off';
    rp.classList.toggle('is-on', rep !== 'off');
    rp.classList.toggle('is-one', rep === 'track');
  }

  // Update just the seek bar + times (called by the 1s ticker and on paint).
  function paintSeek(mount) {
    if (dragging) return;
    const dur = (player && player.durationMs) || 0;
    const range = mount.querySelector('.sp-seek-range');
    const cur = mount.querySelector('.sp-cur');
    const tot = mount.querySelector('.sp-tot');
    if (!range) return;
    const pos = Math.min(localProgressMs, dur || localProgressMs);
    range.value = String(dur > 0 ? Math.round(pos / dur * 1000) : 0);
    range.disabled = !(dur > 0);
    setRangeFill(range);
    if (cur) cur.textContent = fmt(pos);
    if (tot) tot.textContent = dur > 0 ? fmt(dur) : '0:00';
  }

  function paintHero(mount) {
    const now = mount.querySelector('.sp-now');
    const has = !!(player && player.track);
    now.classList.toggle('is-empty', !has);
    now.classList.toggle('is-playing', !!(player && player.playing && has));

    const art = mount.querySelector('.sp-now-art');
    const img = has ? (player.track.image || '') : '';
    art.style.backgroundImage = img ? 'url("' + encodeURI(img) + '")' : '';
    art.classList.toggle('has-cover', !!img);
    // Feed the ambient blurred backdrop (a ::before layer reads --sp-cover) so the
    // whole hero takes on the album's colours — the immersive "now playing" look.
    now.classList.toggle('has-cover', !!img);
    now.style.setProperty('--sp-cover', img ? 'url("' + encodeURI(img) + '")' : 'none');

    mount.querySelector('.sp-now-title').textContent = has ? (player.track.name || '—') : '';
    const sub = has ? [player.track.artist, player.track.album].filter(Boolean).join(' · ') : '';
    mount.querySelector('.sp-now-sub').textContent = sub;

    // Empty state: label + one action (+ a hint). When no Spotify Connect device is
    // available we can't tell "app closed" from "app open but idle" — the Web API
    // simply doesn't list a desktop app until playback has started once — so we show
    // the honest "No active device" + an Open-Spotify button AND a hint telling the
    // user to press play once if it's already open. Spotify with an active device but
    // nothing playing → "Nothing playing" + Play (resume). Still checking
    // (spotifyOpen === null) → neutral note, no button.
    const eLbl = mount.querySelector('.sp-now-empty-lbl');
    const eBtn = mount.querySelector('.sp-now-empty-btn');
    const eHint = mount.querySelector('.sp-now-empty-hint');
    if (eLbl && eBtn) {
      const busy = !has && rateLimited === true;
      const forbidden = !has && !busy && playbackForbidden === true;
      const closed = !busy && !forbidden && spotifyOpen === false;
      if (busy) {
        // Rate-limited: transient, clears on its own. Don't offer an action.
        eLbl.textContent = t('spotify_w_busy', 'Spotify is busy — retrying shortly');
        eBtn.hidden = true;
      } else if (forbidden) {
        // The login predates the playback-read permission: Spotify can be playing and
        // we still get a 403. Opening the app won't help — only a fresh reconnect will.
        eLbl.textContent = t('spotify_w_perm', 'Spotify needs permission');
        eBtn.hidden = true;
      } else {
        eLbl.textContent = closed ? t('spotify_w_closed', 'No active Spotify device') : t('spotify_w_nothing', 'Nothing playing right now');
        eBtn.hidden = has || spotifyOpen === null;
        eBtn.querySelector('.sp-now-empty-btn-ico').innerHTML = closed ? ICONS.logo : ICONS.play_s;   // static, trusted SVG
        eBtn.querySelector('.sp-now-empty-btn-lbl').textContent = closed ? t('spotify_w_open', 'Open Spotify') : t('spotify_w_play', 'Play');
        eBtn.classList.toggle('is-open', closed);   // green filled for Open, subtle for Play
      }
      if (eHint) {
        eHint.hidden = !(forbidden || closed);
        eHint.textContent = forbidden
          ? t('spotify_w_perm_hint', 'Reconnect in Settings → Spotify (Disconnect, then Connect) and approve access — the current login is missing playback permission.')
          : (closed ? t('spotify_w_closed_hint', 'If Spotify is already open, play something once so it shows up here.') : '');
      }
    }

    const like = mount.querySelector('.sp-like');
    const liked = has && player.liked === true;
    like.innerHTML = liked ? ICONS.heartFilled : ICONS.heart;   // static, trusted SVG
    like.classList.toggle('is-on', liked);
    like.hidden = !has;

    paintTransport(mount);
    paintSeek(mount);

    // Volume row — only when the active device reports it supports volume.
    const volRow = mount.querySelector('.sp-vol');
    const showVol = has && player.supportsVolume && player.volume != null;
    volRow.hidden = !showVol;
    if (showVol && !dragging) { const vol = mount.querySelector('.sp-vol-range'); vol.value = String(player.volume); setRangeFill(vol); }

    // Device chip (where playback lives).
    const chip = mount.querySelector('.sp-dev-chip');
    const devName = (player && player.device) || '';
    chip.hidden = !(connected === true && devName);
    if (!chip.hidden) {
      chip.querySelector('.sp-dev-chip-ico').innerHTML = ICONS.speaker;   // static, trusted SVG
      chip.querySelector('.sp-dev-chip-name').textContent = devName;
    }
  }

  // ── Track / list rows ─────────────────────────────────────────────────────
  function trackRow(tk) {
    const row = el('div', 'sp-track');
    const art = el('span', 'sp-track-art');
    if (tk.image) art.style.backgroundImage = 'url("' + encodeURI(tk.image) + '")';
    const meta = el('div', 'sp-track-meta');
    meta.append(el('span', 'sp-track-name', tk.name || '—'), el('span', 'sp-track-artist', tk.artist || ''));
    row.append(art, meta);
    return row;
  }

  function paintQueue(mount) {
    const panel = mount.querySelector('.sp-panel--queue');
    if (!panel) return;
    // Skip the rebuild when nothing changed — paint() runs every 6s poll tick and the
    // queue is usually identical (avoids re-creating every row + its art each time).
    const sig = connected !== true ? 'x' : queue === null ? (rateLimited ? 'b' : 'l') : !queue.length ? 'e'
      : 'q' + (queueReliable ? '' : '~') + queue.map(tk => (tk.uri || tk.name || '')).join('|');
    if (panel.dataset.spSig === sig) return;
    panel.dataset.spSig = sig;
    if (connected !== true) { panel.replaceChildren(el('div', 'sp-empty', t('spotify_w_notlinked', 'Not linked'))); return; }
    if (queue === null) {
      panel.replaceChildren(el('div', 'sp-empty', rateLimited
        ? t('spotify_w_busy', 'Spotify is busy — retrying shortly')
        : t('spotify_w_loading', 'Loading…')));
      return;
    }
    if (!queue.length) { panel.replaceChildren(emptyState(ICONS.note, t('spotify_w_no_queue', 'The queue is empty'))); return; }
    const frag = document.createDocumentFragment();
    // Without a playlist/album context Spotify's queue is only an autoplay guess and
    // often doesn't match what actually plays next — say so rather than showing a
    // wrong "next" as fact (the "random music shows the next song wrong" report).
    if (!queueReliable) {
      frag.appendChild(el('div', 'sp-queue-note', t('spotify_w_queue_guess', 'Approximate — Spotify only knows the exact order inside a playlist or album')));
    }
    queue.forEach(tk => frag.appendChild(trackRow(tk)));
    panel.replaceChildren(frag);
  }

  function paintPlaylists(mount) {
    const panel = mount.querySelector('.sp-panel--playlists');
    if (!panel) return;
    const sig = connected !== true ? 'x' : playlists === null ? 'l' : !playlists.length ? 'e'
      : 'p' + playlists.map(p => (p.uri || p.name || '') + ':' + (p.tracks != null ? p.tracks : '')).join('|');
    if (panel.dataset.spSig === sig) return;
    panel.dataset.spSig = sig;
    if (connected !== true) { panel.replaceChildren(el('div', 'sp-empty', t('spotify_w_notlinked', 'Not linked'))); return; }
    if (playlists === null) { panel.replaceChildren(el('div', 'sp-empty', t('spotify_w_loading', 'Loading…'))); return; }
    if (!playlists.length) { panel.replaceChildren(emptyState(ICONS.note, t('spotify_w_no_playlists', 'No playlists'))); return; }
    const frag = document.createDocumentFragment();
    playlists.forEach(p => {
      const b = el('button', 'sp-pl'); b.type = 'button';
      const art = el('span', 'sp-pl-art');
      if (p.image) art.style.backgroundImage = 'url("' + encodeURI(p.image) + '")';
      const meta = el('div', 'sp-pl-meta');
      meta.append(el('span', 'sp-pl-name', p.name || '—'));
      if (p.tracks != null) meta.append(el('span', 'sp-pl-count', p.tracks + ' ' + t('spotify_w_tracks', 'tracks')));
      const play = el('span', 'sp-pl-play'); play.innerHTML = ICONS.play_s;   // static, trusted SVG
      b.append(art, meta, play);
      b.addEventListener('click', () => runAction(b, { type: 'spotifyPlaylist', playlist: p.uri }));
      frag.appendChild(b);
    });
    panel.replaceChildren(frag);
  }

  function paintDevices(mount) {
    const panel = mount.querySelector('.sp-panel--devices');
    if (!panel) return;
    const sig = connected !== true ? 'x' : devices === null ? 'l' : !devices.length ? 'e'
      : 'd' + devices.map(dv => (dv.name || '') + ':' + (dv.active ? 1 : 0) + ':' + (dv.volume != null ? dv.volume : '')).join('|');
    if (panel.dataset.spSig === sig) return;
    panel.dataset.spSig = sig;
    if (connected !== true) { panel.replaceChildren(el('div', 'sp-empty', t('spotify_w_notlinked', 'Not linked'))); return; }
    if (devices === null) { panel.replaceChildren(el('div', 'sp-empty', t('spotify_w_loading', 'Loading…'))); return; }
    if (!devices.length) { panel.replaceChildren(emptyState(ICONS.computer, t('spotify_w_no_devices', 'No devices found'))); return; }
    const frag = document.createDocumentFragment();
    devices.forEach(dv => {
      const b = el('button', 'sp-dev' + (dv.active ? ' is-active' : '')); b.type = 'button';
      const ico = el('span', 'sp-dev-ico'); ico.innerHTML = deviceIcon(dv.type);   // static, trusted SVG
      const meta = el('div', 'sp-dev-meta');
      meta.append(el('span', 'sp-dev-name', dv.name || '—'));
      const sub = dv.active ? t('spotify_w_playing_here', 'Playing here') : (dv.volume != null ? dv.volume + '%' : '');
      if (sub) meta.append(el('span', 'sp-dev-sub', sub));
      b.append(ico, meta);
      if (dv.active) b.appendChild(el('span', 'sp-dev-dot'));
      // Transfer by device name (the allowlisted spotifyDevice action matches it).
      b.addEventListener('click', () => { if (!dv.active) runAction(b, { type: 'spotifyDevice', device: dv.name }); });
      frag.appendChild(b);
    });
    panel.replaceChildren(frag);
  }

  function emptyState(iconSvg, label) {
    const box = el('div', 'sp-empty-state');
    const ico = el('span', 'sp-empty-ico'); ico.innerHTML = iconSvg;   // static, trusted SVG
    box.append(ico, el('span', 'sp-empty-lbl', label));
    return box;
  }

  // Re-apply every static (language-dependent) label so the widget follows the UI
  // language like every other panel (paint runs on a language change).
  function applyLabels(mount) {
    mount.querySelectorAll('.sp-tab').forEach(tb => {
      const def = TABS.find(x => x.id === tb.dataset.stab);
      if (def) tb.textContent = t(def.labelKey, def.fb);
    });
    const nTxt = mount.querySelector('.sp-notice-txt');
    if (nTxt) nTxt.textContent = t('spotify_w_connect', 'Connect in Settings → Spotify');
    const eLbl = mount.querySelector('.sp-now-empty-lbl');
    if (eLbl) eLbl.textContent = t('spotify_w_nothing', 'Nothing playing right now');
  }

  // "Hide my name" (Settings → Spotify): keep the account display name off the
  // widget for privacy. hubSettings is settings.js's classic-script global (a
  // top-level `let`, NOT window.hubSettings) — read it by bare name, guarded.
  function nameHidden() {
    try { return typeof hubSettings !== 'undefined' && !!hubSettings && hubSettings.spotifyHideName === true; } catch (e) { return false; }
  }

  function paint() {
    const linked = connected === true;
    const showName = linked && !nameHidden();
    tiles().forEach(tile => {
      const mount = tile.querySelector('.spotify-widget-mount');
      if (!mount) return;
      ensure(mount);
      applyLabels(mount);
      mount.querySelector('.sp-wrap').classList.toggle('sp-off', !linked);
      mount.querySelector('.sp-user').textContent = showName ? (username || '') : '';
      const notice = mount.querySelector('.sp-notice');
      if (notice) notice.hidden = linked;

      mount.querySelectorAll('.sp-tab').forEach(tb => tb.classList.toggle('is-active', tb.dataset.stab === activeTab));
      mount.querySelectorAll('.sp-panel').forEach(p => { p.hidden = p.dataset.stab !== activeTab; });

      paintHero(mount);
      paintQueue(mount);
      paintPlaylists(mount);
      paintDevices(mount);
    });
  }

  // ── Data loads ────────────────────────────────────────────────────────────
  async function loadStatus() {
    const s = await api('/stream/spotify/status');
    if (s) { connected = !!s.connected; username = s.login || ''; }
  }
  async function loadPlayer(fresh) {
    if (connected !== true) { player = null; spotifyOpen = null; return; }
    const p = await api('/stream/spotify/player' + (fresh ? '?fresh=1' : ''));
    // Rate-limited (429): Spotify is briefly refusing us. Keep the last known state
    // and don't fire the extra devices call — hammering only extends the cooldown.
    if (p && p.error === 'rate_limited') { rateLimited = true; return; }
    rateLimited = false;
    playbackForbidden = !!(p && p.error === 'forbidden');
    if (p && p.ok) {
      player = p;
      // Sync the local progress from this FRESH snapshot — but guard the "playing
      // track at 100%" artifact. A track that is PLAYING can never sit at (or past)
      // its full length: it would have advanced to the next song. Spotify reports
      // exactly that at track flips, and on some playback setups it stays FROZEN
      // there, which pinned the bar at "4:05 / 4:05" on a song that just started. So
      // an end-pinned progress while playing is unusable: on a track change start
      // from 0, otherwise keep the locally-ticking value (the 1s ticker keeps the bar
      // live). Paused tracks legitimately sit anywhere, so the guard only applies
      // while playing. Track identity keys on uri (id is '' for local files/podcasts).
      const _tid = (player.track && (player.track.uri || player.track.id)) || null;
      const _prog = player.progressMs || 0;
      const _dur = player.durationMs || 0;
      const _changed = _tid !== lastTrackId;
      lastTrackId = _tid;
      const _artifact = !!player.playing && _dur > 1500 && _prog >= _dur - 1500;
      if (_changed) { suppressSyncUntil = 0; localProgressMs = _artifact ? 0 : _prog; }
      else if (Date.now() < suppressSyncUntil) { /* pre-action snapshot after a skip/seek → keep the local position */ }
      else if (!_artifact) localProgressMs = _prog;
      lastSyncAt = Date.now();
      lastSmtcPos = null;    // API is authoritative again — re-seed the SMTC fallback on the next stale window
    } else if (p && p.error === 'not_connected') {
      player = null; spotifyOpen = null;                   // genuinely unlinked → connect UI
    } else if (!player) {
      player = { ok: true, playing: false, track: null };  // no prior state → neutral empty
    }
    // else: a transient failure (network / http_5xx / forbidden) — KEEP the last
    // known now-playing (and its ticking progress) so the hero + seek bar don't
    // blink to empty on a hiccup.
    // Nothing playing → check whether Spotify is reachable (a Connect device is
    // listed = the app is open somewhere) so the empty state can choose Play vs
    // Open-Spotify. Only one extra call, and only in the idle state.
    if (player && !player.track) {
      const d = await api('/stream/spotify/devices').catch(() => null);
      if (d && d.error === 'forbidden') playbackForbidden = true;   // missing scope also shows here
      spotifyOpen = !!(d && d.ok && Array.isArray(d.devices) && d.devices.length);
    } else { spotifyOpen = null; }
  }

  // Launch the Spotify desktop app, then re-check a few times so the empty state
  // switches from "Open Spotify" to Play (or the hero) once the app is up.
  async function openSpotifyApp(btn) {
    if (btn) btn.disabled = true;
    await api('/stream/spotify/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    let tries = 0;
    const recheck = () => {
      if (!tiles().length) { if (btn) btn.disabled = false; return; }
      loadPlayer().then(() => {
        paint();
        tries += 1;
        if (!spotifyOpen && (!player || !player.track) && tries < 6) setTimeout(recheck, 2000);
        else if (btn) btn.disabled = false;
      });
    };
    setTimeout(recheck, 2500);
  }
  function loadQueue() {
    return api('/stream/spotify/queue')
      .then(d => {
        if (d && d.ok && Array.isArray(d.queue)) {
          queue = d.queue;
          queueReliable = d.reliable !== false;   // default trusting; only an explicit false marks it a guess
        } else if (d && d.error === 'no_playback') {
          queue = []; queueReliable = true;       // definitive: nothing is playing → the old list is dead
        }
        // else: a FAILED read (rate limit, network) is not an empty queue — keep
        // the last known list; a never-loaded queue stays null so paintQueue can
        // say "busy"/"loading" instead of the misleading "The queue is empty".
      })
      .catch(() => { /* transient — keep the last known queue */ });
  }
  function loadPlaylists() {
    return api('/stream/spotify/playlists')
      .then(d => { playlists = (d && d.ok && Array.isArray(d.playlists)) ? d.playlists : []; })
      .catch(() => { playlists = []; });
  }
  function loadDevices() {
    return api('/stream/spotify/devices')
      .then(d => { devices = (d && d.ok && Array.isArray(d.devices)) ? d.devices : []; })
      .catch(() => { devices = []; });
  }

  // One-shot seed on mount: status + (if linked) the now-playing state, for an
  // instant hero paint.
  async function seed() {
    if (!tiles().length) return;
    await loadStatus();
    if (connected) { await loadPlayer(); if (activeTab === 'queue') await loadQueue(); }
    else { player = null; queue = null; playlists = null; devices = null; }
    lastRefreshAt = Date.now();   // the first tick's reveal edge must not repeat this round
    paint();
  }

  // Poll only while a tile is placed AND the page is visible (never on the idle
  // path). Refreshes status + player, and the open list tab so it stays current.
  let refreshing = false;    // the reveal edge in tick(), visibilitychange and the poll can converge here
  let lastRefreshAt = 0;
  async function refresh() {
    if (!tiles().length || document.hidden) return;
    // One refresh at a time, never two within 2s: a tab reveal fires both the
    // visibilitychange listener and tick()'s rising edge — unguarded, every
    // reveal cost a doubled round of Spotify reads (quota this file fights for).
    if (refreshing || Date.now() - lastRefreshAt < 2000) return;
    // Rate-limit backoff: while Spotify is 429-ing us, probe far less often (every
    // ~30s, not 6s). Each probe that leaks after the server cooldown restarts
    // Spotify's window, so easing right off is what actually lets the limit clear.
    if (Date.now() < backoffUntil) return;
    refreshing = true;
    try {
      await loadStatus();
      if (connected) {
        await loadPlayer();
        if (!rateLimited) {
          if (activeTab === 'queue') await loadQueue();
          else if (activeTab === 'devices') await loadDevices();   // devices change often
          else if (activeTab === 'playlists' && playlists === null) await loadPlaylists();
        }
      } else { player = null; queue = null; }
      backoffUntil = rateLimited ? Date.now() + 30000 : 0;
      paint();
    } finally { refreshing = false; lastRefreshAt = Date.now(); }
  }

  function startPoll() {
    // Treat "just started" as "just synced": lastSyncAt = 0 would arm the SMTC
    // mirror on the very first tick, hijacking the hero with the local (possibly
    // paused, stale) session before the first /player read even lands.
    if (!lastSyncAt) lastSyncAt = Date.now();
    if (!pollTimer) pollTimer = setInterval(() => { if (!document.hidden && visibleTiles().length) refresh(); }, POLL_MS);
    if (!tickTimer) tickTimer = setInterval(tick, 1000);
  }
  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  // Local SMTC truth for Spotify when a local session exists: true/false = the
  // Spotify app on THIS PC is playing/paused, null = no local Spotify session
  // (e.g. playback on a phone/speaker — Windows knows nothing about it). Windows'
  // state is push-driven and instant, while our snapshot is polled and can sit
  // stale for a long time through a Spotify rate-limit window.
  function smtcSession() {
    const md = (typeof mediaData === 'object' && mediaData) ? mediaData : null;
    if (!md) return null;
    const list = Array.isArray(md.sessions) ? md.sessions : [];
    return list.find(x => x && /spotify/i.test(String(x.app || '')))
      || ((md.active && /spotify/i.test(String(md.app || ''))) ? md : null);
  }

  // 1s local ticker: advance the progress bar between polls without any network
  // call, so the hero feels live. No-ops when idle / hidden / not playing.
  let wasVisible = false;
  function tick() {
    const vis = !document.hidden && visibleTiles().length > 0;
    // A widget revealed by a tab/page switch resyncs NOW — while hidden it does
    // zero polling (quota), so its painted state may be minutes old.
    if (vis && !wasVisible) refresh();
    wasVisible = vis;
    if (!vis || dragging) return;
    // One SMTC read per tick: the local Spotify session (if any), its play state,
    // and whether it shows the very track the hero shows. A LOCAL session is only
    // proof about the hero's playback when it's the same track — the API also
    // covers playback on remote devices Windows knows nothing about.
    const s = smtcSession();
    const sp = !s ? null : s.playbackStatus === 'Playing' ? true : s.playbackStatus === 'Paused' ? false : null;
    const localKey = s ? String(s.title || '') + '|' + String(s.artist || '') : '';
    const heroKey = (player && player.track) ? (String(player.track.name || '') + '|' + String(player.track.artist || '')) : '';
    const sameTrack = !!s && localKey === heroKey;
    // If the API stopped answering a while ago (rate limit, errors — windows that
    // can last many minutes), its frozen snapshot is not truth. Windows knows the
    // LOCAL Spotify app's live state, so mirror that into the hero: play/pause,
    // and the track itself (title/artist/cover/duration/position) when the song
    // moved on while Spotify's API was silent. While reads succeed the API stays
    // authoritative.
    if (connected === true && Date.now() - lastSyncAt > 10000 && s && (s.title || s.artist)) {
      if (!player) player = { ok: true, playing: false, track: null };
      const pos = Number.isFinite(Number(s.position)) ? Number(s.position) : null;
      // Mirror play/pause only when the local session is provably THIS playback:
      // it is playing, or it shows the hero's own track. A desktop app left
      // paused on an old song must not flip a remote playback to "paused".
      if (sp !== null && player.playing !== sp && (sp === true || sameTrack)) {
        player.playing = sp;
        repaintAll(paintTransport);
      }
      if (!sameTrack && sp === true) {
        // Only a PLAYING local session may replace the hero — a paused one could
        // be yesterday's track sitting under a remote playback the API showed.
        const md = mediaData;
        player.track = {
          name: s.title || '', artist: s.artist || '', album: s.album || '',
          // Cover art only travels on the selected media payload; a neutral
          // placeholder beats keeping the WRONG track's cover on screen.
          image: (md && /spotify/i.test(String(md.app || '')) && md.thumbnail) ? md.thumbnail : '',
          uri: '', id: '',
        };
        player.durationMs = Number(s.duration) > 0 ? Number(s.duration) * 1000 : 0;
        player.liked = null;
        localProgressMs = pos > 0 ? pos * 1000 : 0;
        lastSmtcPos = pos;
        suppressSyncUntil = 0;
        repaintAll(paintHero);
      } else if (sameTrack && pos !== null) {
        // Same track, but the SMTC position MOVED away from where the bar sits:
        // the helper interpolates it live (and it reflects seeks made in the
        // Spotify app), so while the API is silent it is the better clock. Only
        // a CHANGED value counts, and small disagreements are jitter, not events.
        const moved = lastSmtcPos !== null && pos !== lastSmtcPos;
        lastSmtcPos = pos;
        if (moved && Date.now() >= suppressSyncUntil && Math.abs(pos * 1000 - localProgressMs) > 5000) {
          localProgressMs = Math.max(0, pos * 1000);
          // Hold the recovering API off for a beat: its first answer can come from
          // the server's up-to-4s-old snapshot cache still holding the pre-seek
          // progress, which would yank the bar right back (media-spotify.js does
          // the same after adopting).
          suppressSyncUntil = Date.now() + 4000;
          repaintAll(paintSeek);
        }
      }
    }
    if (!player || !player.playing || !player.track) return;
    // Local Spotify explicitly paused on the hero's own track → never advance the
    // bar. (A paused local session showing a DIFFERENT track proves nothing: the
    // hero's playback may be live on a remote device.)
    if (sp === false && sameTrack) return;
    const dur = player.durationMs || 0;
    localProgressMs = dur > 0 ? Math.min(localProgressMs + 1000, dur) : localProgressMs + 1000;
    repaintAll(paintSeek);
  }

  function renderWidgets() {
    if (!tiles().length) { stopPoll(); seeded = false; return; }
    paint();                                       // instant paint from cache
    if (!seeded) { seeded = true; seed(); }        // deduped across the multi-pass layout init
    startPoll();
  }

  // Pause polling while hidden; a return to visibility triggers an immediate refresh.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && tiles().length) refresh(); });

  window.SpotifyWidget = { renderWidgets };
})();
