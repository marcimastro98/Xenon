'use strict';
// YouTube dashboard widget. Two halves in one tile:
//   • viewer mode — a real player (official YouTube embed) plus a library you can
//     browse: liked videos, your playlists, the latest uploads from the channels
//     you follow, and search. Tap a video and it plays in the tile; the rest of
//     the list becomes the queue, so it advances on its own.
//   • creator mode — the live status card (viewers, health, editable title) and
//     the Go live / End stream button.
// Four sections (player / library / info / actions) tagged as dashboard cards, so
// each one hides and reorders like a System card: a streamer can switch the
// player off, a viewer can switch the broadcast cards off.
//
// PLAYBACK: the embed is driven with its own postMessage protocol rather than by
// loading YouTube's iframe_api script into the dashboard's origin — the commands
// are identical and no third-party code runs on our page. Messages are accepted
// only from the embed origin and only from our own frame.
//
// QUOTA: status polls slowly and only while a tile is on the visible page; the
// library lists load on demand (the server caches them) and search runs only when
// the user presses it.
(function () {
  const ICONS = {
    golive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    logo: '<svg viewBox="0 0 90 64" fill="none"><rect width="90" height="64" rx="18" fill="#ff0000"/><path d="M36 46V18l24 14z" fill="#0b0d10"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
    prev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 6h2.2v12H7zM19 6v12l-8.5-6z"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M14.8 6H17v12h-2.2zM5 6l8.5 6L5 18z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
    sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 8.5a4.5 4.5 0 0 1 0 7"/></svg>',
    muted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9.5l4 5M21 9.5l-4 5"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5"/></svg>',
    shrink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h5V4M20 9h-5V4M20 15h-5v5M4 15h5v5"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
    subs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="3"/><path d="M6 3h12"/><path d="M11 11l4 2.5-4 2.5z" fill="currentColor" stroke="none"/></svg>',
    list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h11M4 12h11M4 17h7"/><path d="M18 11v8"/><path d="M18 11l3-1v8" fill="none"/></svg>',
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
  const POLL_MS = 30000;    // slow on purpose (YouTube Data API quota)

  // ── Library state ─────────────────────────────────────────────────────────
  // One shared model for every tile: what tab is open, what it holds, and which
  // playlist (if any) the user has drilled into.
  const TABS = ['liked', 'playlists', 'subs', 'search'];
  const TAB_LABEL = {
    liked: () => t('youtube_liked', 'Liked'),
    playlists: () => t('youtube_playlists', 'Playlists'),
    subs: () => t('youtube_tab_subs', 'Subscriptions'),
    search: () => t('youtube_tab_search', 'Search'),
  };
  const lib = {
    tab: 'liked',
    data: { liked: null, playlists: null, subs: null, search: null },   // null = never loaded
    loading: '',
    error: '',
    openPl: null,       // { id, title } while browsing inside a playlist
    plItems: null,      // videos of openPl
    query: '',
  };

  // ── Player state ──────────────────────────────────────────────────────────
  const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
  const PLAYER_ID = 'xenon-yt';
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,24}$/;
  const player = {
    frame: null, stage: null,
    queue: [], qi: -1,
    state: -1,          // YT player state: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
    time: 0, duration: 0,
    muted: false,
    expanded: false,
    blocked: false,     // the uploader refuses embedding — offer the browser instead
    hello: null,
  };
  const cur = () => (player.qi >= 0 ? player.queue[player.qi] : null) || null;

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

  function fmtTime(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(r).padStart(2, '0');
  }

  // Open a URL where the user can see it: a visible Browser tile first (which
  // re-validates the host), else the PC's default browser through the validated
  // openUrl action. Never window.open — a kiosk surface has nowhere to put a tab.
  async function openOut(url) {
    const bt = window.BrowserTile;
    const inTile = (bt && typeof bt.openFromSdk === 'function') ? bt.openFromSdk(url) : null;
    if (inTile && inTile.ok) return true;
    const r = await api('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'openUrl', url }) });
    return !!(r && r.ok);
  }
  // Video ids come from our own server, but they end up inside a URL, so the
  // shape is re-checked here before one is ever built (scheme + id allowlist at
  // the boundary, same rule the rest of the dashboard follows).
  function watchUrl(id) {
    return VIDEO_ID_RE.test(String(id || '')) ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(id) : '';
  }

  // ── The embed, driven over postMessage ────────────────────────────────────
  function cmd(func, args) {
    const f = player.frame;
    if (!f || !f.contentWindow) return;
    try {
      f.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: args || [], id: PLAYER_ID, channel: 'widget' }), EMBED_ORIGIN);
    } catch { /* frame torn down mid-command */ }
  }
  // The embed only starts reporting back once we say we're listening. It can miss
  // the first message while it boots, so say it a few times and stop on the reply.
  function sayHello() {
    clearInterval(player.hello);
    let n = 0;
    const tick = () => {
      const f = player.frame;
      if (!f || !f.contentWindow || ++n > 12) { clearInterval(player.hello); player.hello = null; return; }
      try { f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: PLAYER_ID, channel: 'widget' }), EMBED_ORIGIN); } catch { /* gone */ }
    };
    player.hello = setInterval(tick, 400);
    tick();
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== EMBED_ORIGIN) return;
    const f = player.frame;
    if (!f || !f.contentWindow || e.source !== f.contentWindow) return;
    let d = null;
    try { d = JSON.parse(typeof e.data === 'string' ? e.data : ''); } catch { return; }
    if (!d || typeof d !== 'object') return;
    if (player.hello) { clearInterval(player.hello); player.hello = null; }
    const info = d.info;
    if (d.event === 'onStateChange') {
      player.state = Number(info);
      if (player.state === 1) player.blocked = false;
      if (player.state === 0) { playNext(); return; }
      paintPlayer();
    } else if (d.event === 'onError') {
      // 101 / 150 = the uploader disabled embedding. Nothing to retry: offer the
      // browser instead of leaving a dead black rectangle.
      player.blocked = true; player.state = 2;
      paintPlayer();
    } else if (d.event === 'infoDelivery' || d.event === 'initialDelivery') {
      if (info && typeof info === 'object') {
        if (typeof info.currentTime === 'number') player.time = info.currentTime;
        if (typeof info.duration === 'number' && info.duration > 0) player.duration = info.duration;
        if (typeof info.muted === 'boolean') player.muted = info.muted;
        if (typeof info.playerState === 'number') player.state = info.playerState;
        paintPlayer();
      }
    }
  });

  function destroyFrame() {
    clearInterval(player.hello); player.hello = null;
    if (player.frame && player.frame.parentNode) player.frame.parentNode.removeChild(player.frame);
    player.frame = null; player.stage = null;
  }

  function mountFrame(stage, videoId) {
    destroyFrame();
    const f = document.createElement('iframe');
    f.className = 'yt-frame';
    f.title = 'YouTube';
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.setAttribute('allowfullscreen', '');
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    const p = new URLSearchParams({
      enablejsapi: '1', autoplay: '1', rel: '0', playsinline: '1',
      modestbranding: '1', origin: location.origin, widget_referrer: location.origin,
    });
    f.src = EMBED_ORIGIN + '/embed/' + encodeURIComponent(videoId) + '?' + p.toString();
    f.addEventListener('load', sayHello);
    stage.insertBefore(f, stage.firstChild);
    player.frame = f; player.stage = stage;
    sayHello();
  }

  // Start playing `list` at `index`. The rest of the list is the queue, so a tap
  // on one video plays the whole thing from there, like YouTube's own lists.
  function playList(list, index, stage) {
    const src = Array.isArray(list) ? list : [];
    const wanted = src[index] && src[index].id;
    // Track the tapped video by id, not by position: the filter below can drop a
    // row, and an index into the unfiltered list would then start the wrong video.
    const q = src.filter(v => v && VIDEO_ID_RE.test(String(v.id || '')));
    if (!q.length) return;
    const found = q.findIndex(v => v.id === wanted);
    const i = found >= 0 ? found : 0;
    player.queue = q; player.qi = i;
    player.time = 0; player.duration = q[i].seconds || 0; player.blocked = false; player.state = 3;
    const target = stage || player.stage || document.querySelector('.yt-player-stage');
    if (!target) return;
    // Same frame, still alive, only a different video: swap it in place — that
    // keeps the playback permission the first tap earned, so the queue advances
    // without the browser blocking a fresh autoplay.
    if (player.frame && player.stage === target && player.frame.contentWindow) cmd('loadVideoById', [q[i].id]);
    else mountFrame(target, q[i].id);
    paintPlayer();
  }
  function playAt(i) {
    if (i < 0 || i >= player.queue.length) return;
    player.qi = i; player.time = 0; player.duration = player.queue[i].seconds || 0;
    player.blocked = false; player.state = 3;
    if (player.frame && player.stage) cmd('loadVideoById', [player.queue[i].id]);
    paintPlayer();
  }
  function playNext() { if (player.qi + 1 < player.queue.length) playAt(player.qi + 1); else { player.state = 0; paintPlayer(); } }
  function playPrev() {
    // Under 5 seconds in, "previous" means the previous video; after that it
    // means "start this one again", which is what every player does.
    if (player.time > 5) { cmd('seekTo', [0, true]); player.time = 0; paintPlayer(); return; }
    if (player.qi > 0) playAt(player.qi - 1);
  }
  function togglePlay() {
    if (player.state === 1) { cmd('pauseVideo'); player.state = 2; }
    else if (cur()) { cmd('playVideo'); player.state = 3; }
    paintPlayer();
  }
  function stopPlayer() {
    destroyFrame();
    player.queue = []; player.qi = -1; player.state = -1;
    player.time = 0; player.duration = 0; player.blocked = false;
    setExpanded(false);
    paintPlayer();
  }
  // Expanding only re-positions the card (see the CSS): re-parenting the iframe
  // into an overlay would reload it, which restarts the video the user is
  // watching. No dashboard tile creates a containing block, so `position: fixed`
  // lands on the viewport as intended.
  function setExpanded(on) {
    player.expanded = !!on;
    document.body.classList.toggle('yt-expanded', player.expanded);
    tiles().forEach(tile => tile.classList.toggle('yt-tile-expanded', player.expanded));
    paintPlayer();
  }
  // Escape leaves the big player without hunting for the button on a touchscreen.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && player.expanded) setExpanded(false); });

  // ── Library loading ───────────────────────────────────────────────────────
  const LIB_PATH = { liked: '/stream/youtube/liked', playlists: '/stream/youtube/playlists', subs: '/stream/youtube/subscriptions' };

  async function loadTab(tab, force) {
    if (!connected) return;
    if (tab === 'search') return;                       // explicit action only
    if (!force && lib.data[tab] !== null) return;
    if (lib.loading === tab) return;
    lib.loading = tab; lib.error = ''; paintLibrary();
    const r = await api(LIB_PATH[tab]);
    lib.loading = '';
    if (r && r.ok) lib.data[tab] = (tab === 'playlists' ? (r.playlists || []) : (r.videos || []));
    else lib.error = (r && r.error) || 'failed';
    paintLibrary();
  }

  async function openPlaylist(p) {
    lib.openPl = { id: p.id, title: p.title };
    lib.plItems = null; lib.error = ''; lib.loading = 'pl'; paintLibrary();
    const r = await api('/stream/youtube/playlist/items?id=' + encodeURIComponent(p.id));
    lib.loading = '';
    if (r && r.ok) lib.plItems = r.videos || [];
    else lib.error = (r && r.error) || 'failed';
    paintLibrary();
  }

  async function runSearch(q) {
    const query = String(q || '').trim();
    if (query.length < 2) return;
    lib.query = query; lib.loading = 'search'; lib.error = ''; paintLibrary();
    const r = await api('/stream/youtube/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: query }) });
    lib.loading = '';
    if (r && r.ok) lib.data.search = r.videos || [];
    else lib.error = (r && r.error) || 'failed';
    paintLibrary();
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  function ensure(mount) {
    if (mount.dataset.ytBuilt === '2' && mount.firstChild) return;
    mount.dataset.ytBuilt = '2';
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
    cards.append(buildPlayerCard(), buildLibraryCard(), buildInfoCard(), buildActionsCard());
    wrap.appendChild(cards);
    mount.replaceChildren(wrap);
  }

  function iconBtn(cls, icon, label, onClick) {
    const b = el('button', 'yt-ib ' + cls); b.type = 'button';
    b.innerHTML = icon;                 // static, trusted SVG
    b.title = label; b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }

  function buildPlayerCard() {
    const card = el('section', 'yt-card yt-card--player');
    card.dataset.systemCard = 'player'; card.dataset.systemCardGroup = 'youtube';
    const stage = el('div', 'yt-player-stage');
    stage.appendChild(el('div', 'yt-player-empty', t('youtube_player_empty', 'Pick a video to start')));
    card.appendChild(stage);

    const now = el('div', 'yt-now');
    now.append(el('div', 'yt-now-title'), el('div', 'yt-now-sub'));
    card.appendChild(now);

    const seekRow = el('div', 'yt-seek-row');
    const seek = document.createElement('input');
    seek.type = 'range'; seek.className = 'yt-seek'; seek.min = '0'; seek.max = '1000'; seek.value = '0';
    seek.setAttribute('aria-label', t('youtube_seek', 'Seek'));
    seek.addEventListener('input', () => { seek.dataset.ytDrag = '1'; });
    seek.addEventListener('change', () => {
      seek.dataset.ytDrag = '';
      if (player.duration > 0) {
        const to = (Number(seek.value) / 1000) * player.duration;
        cmd('seekTo', [to, true]); player.time = to; paintPlayer();
      }
    });
    seekRow.append(el('span', 'yt-time yt-time-cur', '0:00'), seek, el('span', 'yt-time yt-time-dur', '0:00'));
    card.appendChild(seekRow);

    const bar = el('div', 'yt-transport');
    bar.append(
      iconBtn('yt-prev', ICONS.prev, t('youtube_prev', 'Previous'), playPrev),
      iconBtn('yt-playpause', ICONS.play, t('youtube_playpause', 'Play / pause'), togglePlay),
      iconBtn('yt-next', ICONS.next, t('youtube_next', 'Next'), playNext),
      el('span', 'yt-transport-gap'),
      iconBtn('yt-mute', ICONS.sound, t('youtube_mute', 'Mute'), () => {
        player.muted = !player.muted; cmd(player.muted ? 'mute' : 'unMute'); paintPlayer();
      }),
      iconBtn('yt-expand', ICONS.expand, t('youtube_expand', 'Full screen'), () => setExpanded(!player.expanded)),
      iconBtn('yt-out', ICONS.external, t('youtube_open_browser', 'Open in the browser'), async (e) => {
        const v = cur(); const url = v && watchUrl(v.id);
        if (url) await openOut(url); else showActionErr(e.currentTarget, 'generic');
      }),
      iconBtn('yt-stop', ICONS.close, t('youtube_close_player', 'Close the player'), stopPlayer),
    );
    card.appendChild(bar);

    const blocked = el('div', 'yt-blocked');
    blocked.append(el('span', null, t('youtube_no_embed', 'This video cannot be played inside apps.')));
    const bb = el('button', 'yt-blocked-btn', t('youtube_open_browser', 'Open in the browser'));
    bb.type = 'button';
    bb.addEventListener('click', async () => { const v = cur(); const url = v && watchUrl(v.id); if (url) await openOut(url); });
    blocked.appendChild(bb);
    card.appendChild(blocked);
    return card;
  }

  function buildLibraryCard() {
    const card = el('section', 'yt-card yt-card--library');
    card.dataset.systemCard = 'library'; card.dataset.systemCardGroup = 'youtube';

    const tabsRow = el('div', 'yt-tabs');
    const TAB_ICON = { liked: ICONS.heart, playlists: ICONS.list, subs: ICONS.subs, search: ICONS.search };
    TABS.forEach(id => {
      const b = el('button', 'yt-tab'); b.type = 'button'; b.dataset.ytTab = id;
      const ico = el('span', 'yt-tab-ico'); ico.innerHTML = TAB_ICON[id];   // static, trusted SVG
      b.append(ico, el('span', 'yt-tab-lbl', TAB_LABEL[id]()));
      b.addEventListener('click', () => {
        lib.tab = id; lib.openPl = null; lib.plItems = null; lib.error = '';
        paintLibrary();
        loadTab(id);
      });
      tabsRow.appendChild(b);
    });
    card.appendChild(tabsRow);

    const searchRow = el('div', 'yt-search-row');
    const inp = document.createElement('input');
    inp.type = 'search'; inp.className = 'yt-search-input'; inp.maxLength = 100;
    inp.placeholder = t('youtube_search_ph', 'Search on YouTube');
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(inp.value); });
    const go = el('button', 'yt-search-go'); go.type = 'button';
    go.innerHTML = ICONS.search;                       // static, trusted SVG
    go.setAttribute('aria-label', t('youtube_tab_search', 'Search'));
    go.addEventListener('click', () => runSearch(inp.value));
    searchRow.append(inp, go);
    card.appendChild(searchRow);

    const crumb = el('button', 'yt-crumb'); crumb.type = 'button';
    const ci = el('span', 'yt-crumb-ico'); ci.innerHTML = ICONS.back;      // static, trusted SVG
    crumb.append(ci, el('span', 'yt-crumb-txt'));
    crumb.addEventListener('click', () => { lib.openPl = null; lib.plItems = null; paintLibrary(); });
    card.appendChild(crumb);

    card.appendChild(el('div', 'yt-list'));
    return card;
  }

  function buildInfoCard() {
    const info = el('section', 'yt-card yt-card--info');
    info.dataset.systemCard = 'info'; info.dataset.systemCardGroup = 'youtube';
    return info;
  }

  function buildActionsCard() {
    const actions = el('section', 'yt-card yt-card--actions');
    actions.dataset.systemCard = 'actions'; actions.dataset.systemCardGroup = 'youtube';
    actions.appendChild(el('div', 'yt-card-label', t('layout_card_actions', 'Actions')));
    const go = el('button', 'yt-btn yt-golive');
    go.append(el('span', 'yt-btn-ico'), el('span', 'yt-btn-lbl'));
    go.addEventListener('click', () => runAction(go, { type: 'ytBroadcast', mode: 'toggle' }));
    actions.appendChild(go);
    return actions;
  }

  // ── Rows ──────────────────────────────────────────────────────────────────
  function videoRow(v, index, list) {
    const b = el('button', 'yt-row'); b.type = 'button';
    const art = el('span', 'yt-row-art');
    if (v.image) art.style.backgroundImage = 'url("' + encodeURI(v.image) + '")';
    if (v.seconds != null) art.appendChild(el('span', 'yt-row-dur', fmtTime(v.seconds)));
    const meta = el('div', 'yt-row-meta');
    meta.append(el('span', 'yt-row-name', v.title || '—'));
    if (v.channel) meta.append(el('span', 'yt-row-sub', v.channel));
    const play = el('span', 'yt-row-play'); play.innerHTML = ICONS.play;   // static, trusted SVG
    b.append(art, meta, play);
    b.addEventListener('click', async () => {
      const wrap = b.closest('.yt-wrap');
      const stage = wrap ? wrap.querySelector('.yt-player-stage') : null;
      // The player card can be switched off in layout edit mode. Someone who did
      // that still expects a tap to play something, so fall back to the browser
      // rather than doing nothing.
      if (stage) playList(list, index, stage);
      else { const url = watchUrl(v.id); if (url) await openOut(url); }
    });
    return b;
  }

  function playlistRow(p) {
    const b = el('button', 'yt-row yt-row--pl'); b.type = 'button';
    const art = el('span', 'yt-row-art');
    if (p.image) art.style.backgroundImage = 'url("' + encodeURI(p.image) + '")';
    const meta = el('div', 'yt-row-meta');
    meta.append(el('span', 'yt-row-name', p.title || '—'));
    if (p.count != null) meta.append(el('span', 'yt-row-sub', p.count + ' ' + t('youtube_videos', 'videos')));
    const chev = el('span', 'yt-row-play'); chev.innerHTML = ICONS.play;   // static, trusted SVG
    b.append(art, meta, chev);
    b.addEventListener('click', () => openPlaylist(p));
    return b;
  }

  // ── Painting ──────────────────────────────────────────────────────────────
  function eachMount(fn) {
    tiles().forEach(tile => {
      const mount = tile.querySelector('.youtube-widget-mount');
      if (!mount) return;
      ensure(mount);
      fn(mount, tile);
    });
  }

  // The embed reports its position several times a second, so paintPlayer runs on
  // a hot path. Re-parsing an identical SVG is the expensive part of a repaint;
  // this skips it unless the icon really changed.
  function setIcon(node, key, svg) {
    if (node.dataset.ytIcon === key) return;
    node.dataset.ytIcon = key;
    node.innerHTML = svg;                 // static, trusted SVG
  }

  function paintPlayer() {
    const v = cur();
    const playing = player.state === 1 || player.state === 3;
    eachMount(mount => {
      const card = mount.querySelector('.yt-card--player');
      if (!card) return;
      const editing = document.body.classList.contains('layout-editing');
      card.style.display = (connected || editing) ? '' : 'none';
      const stage = card.querySelector('.yt-player-stage');
      const owns = !!(player.frame && player.stage === stage);
      const empty = stage.querySelector('.yt-player-empty');
      if (empty) empty.style.display = owns ? 'none' : '';
      card.classList.toggle('is-playing', owns && !!v);
      card.classList.toggle('is-expanded', player.expanded && owns);

      const title = card.querySelector('.yt-now-title');
      const sub = card.querySelector('.yt-now-sub');
      title.textContent = v ? (v.title || '') : '';
      sub.textContent = v ? [v.channel || '', player.queue.length > 1 ? (player.qi + 1) + '/' + player.queue.length : ''].filter(Boolean).join(' · ') : '';

      const pp = card.querySelector('.yt-playpause');
      setIcon(pp, playing ? 'pause' : 'play', playing ? ICONS.pause : ICONS.play);
      const mute = card.querySelector('.yt-mute');
      setIcon(mute, player.muted ? 'muted' : 'sound', player.muted ? ICONS.muted : ICONS.sound);
      mute.classList.toggle('is-on', player.muted);
      const exp = card.querySelector('.yt-expand');
      setIcon(exp, player.expanded ? 'shrink' : 'expand', player.expanded ? ICONS.shrink : ICONS.expand);
      card.querySelector('.yt-prev').disabled = !v;
      card.querySelector('.yt-next').disabled = !v || player.qi + 1 >= player.queue.length;
      pp.disabled = !v;
      card.querySelector('.yt-out').disabled = !v;
      card.querySelector('.yt-stop').disabled = !v;

      const seek = card.querySelector('.yt-seek');
      const dur = player.duration > 0 ? player.duration : (v && v.seconds) || 0;
      seek.disabled = !(dur > 0);
      if (seek.dataset.ytDrag !== '1') seek.value = String(dur > 0 ? Math.round((player.time / dur) * 1000) : 0);
      card.querySelector('.yt-time-cur').textContent = fmtTime(player.time);
      card.querySelector('.yt-time-dur').textContent = fmtTime(dur);

      card.querySelector('.yt-blocked').style.display = (owns && player.blocked) ? '' : 'none';
    });
  }

  function paintLibrary() {
    eachMount(mount => {
      const card = mount.querySelector('.yt-card--library');
      if (!card) return;
      const editing = document.body.classList.contains('layout-editing');
      card.style.display = (connected || editing) ? '' : 'none';
      card.querySelectorAll('.yt-tab').forEach(b => b.classList.toggle('is-on', b.dataset.ytTab === lib.tab));
      card.querySelector('.yt-search-row').style.display = (lib.tab === 'search' && !lib.openPl) ? '' : 'none';
      const crumb = card.querySelector('.yt-crumb');
      crumb.style.display = lib.openPl ? '' : 'none';
      if (lib.openPl) crumb.querySelector('.yt-crumb-txt').textContent = lib.openPl.title || t('youtube_playlists', 'Playlists');

      const list = card.querySelector('.yt-list');
      // Rebuilding an unchanged list on every status poll would throw away the
      // user's scroll position every 30 seconds, so only rebuild on a real change.
      const rows = lib.openPl ? lib.plItems : lib.data[lib.tab];
      const sig = [connected, document.documentElement.lang, lib.tab, lib.openPl && lib.openPl.id, lib.loading, lib.error,
        rows === null || rows === undefined ? 'n' : rows.map(r => r.id).join(',')].join('|');
      if (list.dataset.ytSig === sig) return;
      list.dataset.ytSig = sig;
      if (connected !== true) { list.replaceChildren(); return; }
      if (lib.loading) { list.replaceChildren(el('div', 'yt-list-note', t('browser_loading', 'Loading…'))); return; }
      if (lib.error) { list.replaceChildren(el('div', 'yt-list-note yt-list-err', t('youtube_list_failed', 'Could not load this list.'))); return; }

      const frag = document.createDocumentFragment();
      if (lib.openPl) {
        const items = lib.plItems || [];
        if (!items.length) frag.appendChild(el('div', 'yt-list-note', t('youtube_nothing', 'Nothing here')));
        items.forEach((v, i) => frag.appendChild(videoRow(v, i, items)));
      } else if (lib.tab === 'playlists') {
        const pls = lib.data.playlists;
        if (pls === null) frag.appendChild(el('div', 'yt-list-note', t('browser_loading', 'Loading…')));
        else if (!pls.length) frag.appendChild(el('div', 'yt-list-note', t('youtube_no_playlists', 'No playlists on this account')));
        else pls.forEach(p => frag.appendChild(playlistRow(p)));
      } else if (lib.tab === 'search' && lib.data.search === null) {
        frag.appendChild(el('div', 'yt-list-note', t('youtube_search_hint', 'Type something and press search.')));
      } else {
        const vids = lib.data[lib.tab];
        if (vids === null) frag.appendChild(el('div', 'yt-list-note', t('browser_loading', 'Loading…')));
        else if (!vids.length) frag.appendChild(el('div', 'yt-list-note', t('youtube_nothing', 'Nothing here')));
        else vids.forEach((v, i) => frag.appendChild(videoRow(v, i, vids)));
      }
      list.replaceChildren(frag);
    });
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

  // Labels are written into the DOM once at build time, but the language can
  // change under a widget that is mid-playback — and rebuilding to re-translate
  // would reload the iframe and restart the video. So the fixed labels are
  // re-applied on every paint instead (a handful of textContent writes), and the
  // list signature carries the language so its rows re-render too.
  function relabel(mount) {
    mount.querySelectorAll('.yt-tab').forEach(b => {
      const f = TAB_LABEL[b.dataset.ytTab];
      if (f) b.querySelector('.yt-tab-lbl').textContent = f();
    });
    const inp = mount.querySelector('.yt-search-input');
    if (inp) inp.placeholder = t('youtube_search_ph', 'Search on YouTube');
    const lbl = mount.querySelector('.yt-card--actions .yt-card-label');
    if (lbl) lbl.textContent = t('layout_card_actions', 'Actions');
  }

  function paint() {
    const st = last, conn = connected;
    const live = !!(st && st.ok && st.live);
    eachMount(mount => {
      relabel(mount);
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
      // Actions: nothing to press until an account is connected.
      const actions = mount.querySelector('.yt-card--actions');
      actions.style.display = (conn === false && !editing) ? 'none' : '';
      const go = mount.querySelector('.yt-golive');
      go.classList.toggle('is-live', live);
      go.querySelector('.yt-btn-ico').innerHTML = live ? ICONS.stop : ICONS.golive;   // static, trusted SVG
      go.querySelector('.yt-btn-lbl').textContent = live ? t('twitch_endstream', 'End stream') : t('twitch_golive', 'Go live');
    });
    paintPlayer();
    paintLibrary();
  }

  async function refresh() {
    if (!tiles().length) { stop(); return; }
    if (document.hidden || !tiles().some(onVisiblePage)) return;
    const s = await api('/stream/youtube/status');
    const was = connected;
    if (s) connected = !!s.connected;
    if (connected) {
      const b = await api('/stream/youtube/broadcast'); if (b) last = b;
      if (was !== true) loadTab(lib.tab);          // first connection: fill the open tab
    } else if (connected === false && was !== false) {
      // Signed out (possibly to sign a different account in): drop everything the
      // previous account put on screen.
      lib.data = { liked: null, playlists: null, subs: null, search: null };
      lib.openPl = null; lib.plItems = null; lib.error = '';
      stopPlayer();
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
