'use strict';
// YouTube dashboard widget: live status + viewer count + stream health, with a
// Go live / End stream button — plus a viewer-mode Playlists card (your own
// playlists + Liked videos, tap to play in the Browser tile or the PC browser).
// Three manageable sections (info / actions / playlists) tagged as dashboard
// cards (hide/reorder like the System panel). Polled (no SSE) and QUOTA-AWARE —
// only polls while a tile is visible and the tab is foregrounded, at a slow
// cadence; playlists load once per connection. Actions go through /actions/run
// (ytBroadcast, openUrl). Renders into .youtube-widget-mount.
(function () {
  const ICONS = {
    golive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    logo: '<svg viewBox="0 0 90 64" fill="none"><rect width="90" height="64" rx="18" fill="#ff0000"/><path d="M36 46V18l24 14z" fill="#0b0d10"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
  };
  const HEALTH_KEY = { good: 'youtube_health_good', ok: 'youtube_health_ok', bad: 'youtube_health_bad', noData: 'youtube_health_nodata' };
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl; // shared DOM factory from utils.js
  // Only tiles actually placed on a dashboard page count. A hidden / never-added
  // widget sits in the #widget-pool (outside any .pager-page), so it must NOT
  // poll the YouTube API. Adding the widget moves it into a page → polling starts
  // on the next layout pass; removing it parks it back → polling stops.
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="youtube"]')).filter(el => el.closest('.pager-page')); }
  const api = apiJson; // shared fetch-JSON helper from utils.js

  let poll = null;
  let last = null;          // broadcastStatus result
  let connected = null;     // null=unknown
  let playlists = null;     // null=not loaded yet (loads once per connection)
  const POLL_MS = 30000;    // slow on purpose (YouTube Data API quota)

  const ERR_KEY = { no_broadcast: 'youtube_err_no_broadcast', not_connected: 'youtube_err_not_connected' };
  function showActionErr(btn, reason) {
    const card = btn.closest('.yt-card');
    if (!card) return;
    let n = card.querySelector('.yt-err');
    if (!n) { n = el('div', 'yt-err'); card.appendChild(n); }
    n.textContent = t(ERR_KEY[reason] || 'youtube_err_generic', 'Action failed');
    n.style.display = '';
    clearTimeout(n._tm); n._tm = setTimeout(() => { n.style.display = 'none'; }, 6000);
  }

  async function runAction(btn, action) {
    btn.disabled = true; btn.classList.remove('ok', 'err');
    const r = await api('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
    const ok = !!(r && r.ok);
    btn.classList.add(ok ? 'ok' : 'err');
    if (!ok) showActionErr(btn, r && r.error);
    setTimeout(() => { btn.classList.remove('ok', 'err'); btn.disabled = false; }, 1400);
  }

  function ensure(mount) {
    if (mount.dataset.ytBuilt === '1' && mount.firstChild) return;
    mount.dataset.ytBuilt = '1';
    const wrap = el('div', 'yt-wrap');

    const wm = el('div', 'yt-watermark'); wm.innerHTML = ICONS.logo;   // static, trusted SVG
    wrap.appendChild(wm);

    const head = el('div', 'yt-head');
    const brand = el('div', 'yt-brand');
    brand.append(el('span', 'yt-logo', 'YouTube'));
    const pill = el('span', 'yt-pill'); pill.append(el('span', 'yt-pill-dot'), el('span', 'yt-pill-txt'));
    head.append(brand, pill);
    wrap.appendChild(head);

    const cards = el('div', 'yt-cards');
    const info = el('section', 'yt-card yt-card--info'); info.dataset.systemCard = 'info'; info.dataset.systemCardGroup = 'youtube';
    const actions = el('section', 'yt-card yt-card--actions'); actions.dataset.systemCard = 'actions'; actions.dataset.systemCardGroup = 'youtube';
    actions.appendChild(el('div', 'yt-card-label', t('layout_card_actions', 'Actions')));
    const go = el('button', 'yt-btn yt-golive');
    go.append(el('span', 'yt-btn-ico'), el('span', 'yt-btn-lbl'));
    go.addEventListener('click', () => runAction(go, { type: 'ytBroadcast', mode: 'toggle' }));
    actions.appendChild(go);
    const pls = el('section', 'yt-card yt-card--playlists'); pls.dataset.systemCard = 'playlists'; pls.dataset.systemCardGroup = 'youtube';
    pls.appendChild(el('div', 'yt-card-label', t('youtube_playlists', 'Playlists')));
    pls.appendChild(el('div', 'yt-pl-list'));
    cards.append(info, actions, pls);
    wrap.appendChild(cards);
    mount.replaceChildren(wrap);
  }

  // Tap a playlist → resolve its watch URL server-side (the id never becomes a
  // URL client-side), then play it where the user can see it: a visible Browser
  // tile first, else the PC's default browser via the validated openUrl action.
  async function openPlaylist(btn, id) {
    btn.disabled = true; btn.classList.remove('ok', 'err');
    const r = await api('/stream/youtube/playlist/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    let ok = false;
    if (r && r.ok && r.url) {
      const bt = window.BrowserTile;
      const inTile = (bt && typeof bt.openFromSdk === 'function') ? bt.openFromSdk(r.url) : null;
      if (inTile && inTile.ok) ok = true;
      else {
        const ra = await api('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'openUrl', url: r.url }) });
        ok = !!(ra && ra.ok);
      }
    }
    btn.classList.add(ok ? 'ok' : 'err');
    if (!ok) showActionErr(btn, r && r.error);
    setTimeout(() => { btn.classList.remove('ok', 'err'); btn.disabled = false; }, 1400);
  }

  function plRow(p, liked) {
    const b = el('button', 'yt-pl'); b.type = 'button';
    const art = el('span', 'yt-pl-art');
    if (liked) art.innerHTML = ICONS.heart;   // static, trusted SVG
    else if (p.image) art.style.backgroundImage = 'url("' + encodeURI(p.image) + '")';
    const meta = el('div', 'yt-pl-meta');
    meta.append(el('span', 'yt-pl-name', p.title || '—'));
    if (p.count != null) meta.append(el('span', 'yt-pl-count', p.count + ' ' + t('youtube_videos', 'videos')));
    const play = el('span', 'yt-pl-play'); play.innerHTML = ICONS.play;   // static, trusted SVG
    b.append(art, meta, play);
    b.addEventListener('click', () => openPlaylist(b, p.id));
    return b;
  }

  function paintPlaylists(mount) {
    const card = mount.querySelector('.yt-card--playlists');
    if (!card) return;
    const editing = document.body.classList.contains('layout-editing');
    card.style.display = (connected || editing) ? '' : 'none';
    const list = card.querySelector('.yt-pl-list');
    const sig = connected !== true ? 'x' : playlists === null ? 'l'
      : 'p' + playlists.map(p => p.id + ':' + (p.count != null ? p.count : '')).join('|');
    if (list.dataset.ytSig === sig) return;
    list.dataset.ytSig = sig;
    if (connected !== true) { list.replaceChildren(); return; }
    if (playlists === null) { list.replaceChildren(el('div', 'yt-pl-empty', t('browser_loading', 'Loading…'))); return; }
    const frag = document.createDocumentFragment();
    // "Liked videos" is the LL system playlist — always first, like YouTube's own Library.
    frag.appendChild(plRow({ id: 'LL', title: t('youtube_liked', 'Liked videos'), count: null, image: '' }, true));
    playlists.forEach(p => frag.appendChild(plRow(p, false)));
    list.replaceChildren(frag);
  }

  // A title row that turns into an inline editor on click (saves on Enter/blur).
  function buildTitle(text) {
    const row = el('div', 'yt-title');
    const span = el('span', 'yt-title-text', text);
    span.title = t('youtube_edit_title', 'Click to edit the title');
    span.addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'yt-title-input'; inp.value = text; inp.maxLength = 100;
      let done = false;
      const commit = async (save) => {
        if (done) return; done = true;
        if (save && inp.value.trim() && inp.value.trim() !== text) {
          await api('/stream/youtube/title', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: inp.value.trim() }) });
          last = null;            // force a fresh status next poll
        }
        refresh();
      };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); });
      inp.addEventListener('blur', () => commit(true));
      row.replaceChildren(inp); inp.focus(); inp.select();
    });
    row.appendChild(span);
    return row;
  }

  function buildInfo(conn, live, st) {
    const box = el('div', 'yt-info');
    if (conn === false) { box.appendChild(el('div', 'yt-notice', t('youtube_not_connected', 'Connect in Settings'))); return box; }
    if (live) {
      const v = el('div', 'yt-viewers');
      v.append(el('span', 'yt-viewers-num', String(st && st.viewers != null ? st.viewers : '—')), el('span', 'yt-viewers-label', t('twitch_viewers', 'viewers')));
      box.appendChild(v);
      // Total views · likes line.
      const bits = [];
      if (st && st.totalViews != null) bits.push(st.totalViews.toLocaleString() + ' ' + t('youtube_views', 'views'));
      if (st && st.likes != null) bits.push(st.likes.toLocaleString() + ' ' + t('youtube_likes', 'likes'));
      if (bits.length) box.appendChild(el('div', 'yt-stats', bits.join(' · ')));
    }
    // Title (editable) — shown whenever a broadcast exists. No big "Offline" text:
    // the OFFLINE pill in the header already conveys the state.
    if (st && st.title) box.appendChild(buildTitle(st.title));
    if (st && st.health && HEALTH_KEY[st.health]) {
      const h = el('div', 'yt-health yt-health-' + st.health);
      h.append(el('span', 'yt-health-dot'), el('span', null, t('youtube_health', 'Stream') + ': ' + t(HEALTH_KEY[st.health], st.health)));
      box.appendChild(h);
    }
    return box;
  }

  function paint() {
    const st = last, conn = connected;
    const live = !!(st && st.ok && st.live);
    tiles().forEach(tile => {
      const mount = tile.querySelector('.youtube-widget-mount');
      if (!mount) return;
      ensure(mount);
      const pill = mount.querySelector('.yt-pill');
      pill.classList.toggle('live', live);
      mount.querySelector('.yt-pill-txt').textContent = live ? 'LIVE' : t('youtube_offline', 'Offline');
      // Info card: when offline with no broadcast there's nothing to show, so hide
      // the whole card (no empty box) — except in layout-edit mode, where it stays
      // visible so you can still hide/reorder it.
      const info = mount.querySelector('.yt-card--info');
      const body = buildInfo(conn, live, st);
      const editing = document.body.classList.contains('layout-editing');
      info.style.display = (body.childNodes.length || editing) ? '' : 'none';
      info.replaceChildren(body);
      const go = mount.querySelector('.yt-golive');
      go.style.display = conn === false ? 'none' : '';
      go.classList.toggle('is-live', live);
      go.querySelector('.yt-btn-ico').innerHTML = live ? ICONS.stop : ICONS.golive;   // static, trusted SVG
      go.querySelector('.yt-btn-lbl').textContent = live ? t('twitch_endstream', 'End stream') : t('twitch_golive', 'Go live');
      paintPlaylists(mount);
    });
  }

  async function refresh() {
    if (!tiles().length) { stop(); return; }
    if (document.hidden || !tiles().some(onVisiblePage)) return;
    const s = await api('/stream/youtube/status');
    if (s) connected = !!s.connected;
    if (connected) {
      const b = await api('/stream/youtube/broadcast'); if (b) last = b;
      // Playlists load once per connection (server caches 5 min); a failed load
      // stays null so the next poll retries.
      if (playlists === null) {
        const p = await api('/stream/youtube/playlists');
        if (p && p.ok && Array.isArray(p.playlists)) playlists = p.playlists;
      }
    } else if (connected === false) {
      playlists = null;   // reload after a re-login (possibly another account)
    }
    paint();
  }
  function stop() { if (poll) { clearInterval(poll); poll = null; } }

  function renderWidgets() {
    if (!tiles().length) { stop(); return; }
    paint();
    if (!poll) { refresh(); poll = setInterval(refresh, POLL_MS); }
  }

  window.YouTubeWidget = { renderWidgets };
})();
