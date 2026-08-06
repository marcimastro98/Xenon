'use strict';
// Twitch dashboard widget — watching. The official Twitch player plus a list to
// pick from: the channels you follow that are on air, what is busiest right now,
// and a search. Tap a channel and it plays in the tile. An optional chat card
// shows that channel's chat beside it.
//
// It is deliberately a SEPARATE widget from js/streaming-page.js's Twitch tile,
// which is the streamer's side: going live, clipping, markers, ads, chat modes.
// Those two have nothing to do with each other except the account they read, and
// the same split already happened on the YouTube side for the same reason.
//
// PLAYBACK: Twitch's embed refuses to load unless the page's own domain is named
// in a `parent` parameter, so it is read from location.hostname on every mount
// rather than hardcoded — that is what makes the tile work identically on the
// Xeneon Edge (127.0.0.1, measured), on a desktop browser and on a paired phone
// reaching the PC by its LAN address. Unlike YouTube's, this embed has no
// postMessage protocol worth speaking, so play/pause/volume/quality stay where
// Twitch put them: inside the player. Our own chrome is only what the embed does
// not offer — which channel is on, full screen, open in the browser, close.
//
// COST: the connection check reads our own token store and costs nothing. The
// lists are cached server-side for a minute (live lists go stale fast) and
// Twitch has no daily quota to run out of, so nothing here rations itself the
// way the YouTube widget has to.
(function () {
  const ICONS = {
    logo: '<svg viewBox="0 0 24 28" fill="#9146ff"><path d="M2.2 0L0 5.6v20.1h6.7V28h3.9l3.2-2.3h5.5L24 20.1V0zm2.2 2.2h17.4v16.8l-3.9 3.9h-5.5l-3.2 2.2v-2.2H4.4zm5.8 12.3h2.2V7.8h-2.2zm6 0h2.2V7.8h-2.2z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
    fire: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c.5 3.2-1.2 4.6-2.6 6C7.8 9.6 6 11.2 6 14a6 6 0 0 0 12 0c0-3-1.5-4.7-3-6.4-1-1.2-1.8-2.4-1.6-4C12.8 4.4 12.4 3 12 2zm0 11a2.6 2.6 0 0 1 2.6 2.6A2.6 2.6 0 0 1 12 18.2a2.6 2.6 0 0 1-2.6-2.6C9.4 14.2 12 14 12 13z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
    expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5"/></svg>',
    shrink: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h5V4M20 9h-5V4M20 15h-5v5M4 15h5v5"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    viewers: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 3L10.5 13.5"/><path d="M21 3l-6.8 18-3.7-7.5L3 9.8z"/></svg>',
    smile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01"/></svg>',
  };
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;                 // shared DOM factory from utils.js
  const api = apiJson;               // shared fetch-JSON helper from utils.js
  // Only tiles actually placed on a dashboard page count — a widget that was
  // never added sits in the #widget-pool, outside any .pager-page, and must not
  // poll anything.
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="twitchwatch"]')).filter(n => n.closest('.pager-page')); }

  let poll = null;
  let connected = null;              // null = not asked yet
  const POLL_MS = 60000;

  // ── Library state ─────────────────────────────────────────────────────────
  const TABS = ['followed', 'top', 'search'];
  const TAB_LABEL = {
    followed: () => t('tww_tab_followed', 'Followed'),
    top: () => t('tww_tab_top', 'Top'),
    search: () => t('tww_tab_search', 'Search'),
  };
  const lib = {
    tab: 'followed',
    data: { followed: null, top: null, search: null },   // null = never loaded
    loading: '',
    error: '',
  };

  // ── Player state ──────────────────────────────────────────────────────────
  // A Twitch login is the only thing that ends up inside the embed URL, so its
  // shape is re-checked here even though the server already validated it: this
  // is the boundary where a string becomes part of a URL.
  const LOGIN_RE = /^[a-z0-9_]{1,25}$/;
  // What Twitch will accept as `parent`: a host name or an IPv4 literal. An IPv6
  // literal (location.hostname gives it without brackets) is not a valid value
  // and there is no point building a frame that will be refused — the widget
  // says so and offers the browser instead.
  const PARENT_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$/;
  const player = {
    frame: null, stage: null,
    ch: null,                        // the channel row being watched
    expanded: false,
    idle: false, idleT: null,
  };

  function embedParent() {
    const h = String(location.hostname || '');
    return PARENT_RE.test(h) ? h : '';
  }
  function channelUrl(login) {
    return LOGIN_RE.test(String(login || '')) ? 'https://www.twitch.tv/' + encodeURIComponent(login) : '';
  }
  function fmtViewers(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '';
    if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(v);
  }

  // Open Settings → Streaming, the same way the Discord widget's "not linked"
  // notice does.
  function openStreamingSettings() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay && overlay.hidden && typeof window.toggleSettings === 'function') window.toggleSettings();
    if (typeof window.settingsSetCategory === 'function') window.settingsSetCategory('streaming');
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

  // ── The embed ─────────────────────────────────────────────────────────────
  function destroyFrame() {
    if (player.frame && player.frame.parentNode) player.frame.parentNode.removeChild(player.frame);
    player.frame = null; player.stage = null;
  }

  function mountFrame(stage, login) {
    const parent = embedParent();
    if (!parent) return false;
    destroyFrame();
    const f = document.createElement('iframe');
    f.className = 'tww-frame';
    f.title = 'Twitch';
    // No fullscreen permission, deliberately — the same rule the YouTube tile
    // follows. The browser's own fullscreen is what breaks the kiosk: leaving it
    // hands the window back in a state where the Windows taskbar sits on top of
    // the dashboard until Xenon is restarted. Withholding the permission is what
    // makes the embed hide its fullscreen button, so the only way to enlarge the
    // player is ours, and ours never touches the app's window.
    f.allow = 'autoplay; encrypted-media; picture-in-picture';
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    const p = new URLSearchParams({ channel: login, parent, autoplay: 'true', muted: 'false' });
    f.src = 'https://player.twitch.tv/?' + p.toString();
    stage.insertBefore(f, stage.firstChild);
    player.frame = f; player.stage = stage;
    return true;
  }

  function watch(ch, stage) {
    if (!ch || !LOGIN_RE.test(String(ch.login || ''))) return;
    const target = stage || player.stage || document.querySelector('.tww-player-stage');
    if (!target) return;
    // Nothing to do if it is already the channel on screen: re-mounting would
    // reload the stream the user is already watching.
    if (player.ch && player.ch.login === ch.login && player.frame && player.stage === target) return;
    player.ch = ch;
    mountFrame(target, ch.login);
    paint();
    publishWatch();
  }

  function stopPlayer() {
    destroyFrame();
    player.ch = null;
    closeChat();            // no channel, no chat to follow
    chatLines = [];
    setExpanded(false);
    paint();
    publishWatch();
  }

  // Expanding only re-positions the card (see the CSS): re-parenting the iframe
  // into an overlay would reload it, which drops the stream. No dashboard tile
  // creates a containing block, so `position: fixed` lands on the viewport.
  function setExpanded(on) {
    player.expanded = !!on;
    document.body.classList.toggle('tww-expanded', player.expanded);
    tiles().forEach(tile => tile.classList.toggle('tww-tile-expanded', player.expanded));
    if (player.expanded) wakeControls(); else clearIdle();
    paint();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && player.expanded) setExpanded(false); });

  // ── Idle controls at full screen ──────────────────────────────────────────
  // The controls fade out while something is playing and come back on the first
  // touch. The catcher is what makes "the first touch" possible: the embed is a
  // cross-origin iframe, so a finger moving over the picture raises no event this
  // document can see. It only takes input while the controls are hidden, so once
  // they are up Twitch's own player controls stay reachable.
  const IDLE_MS = 3500;
  function clearIdle() {
    clearTimeout(player.idleT); player.idleT = null;
    player.idle = false;
    document.querySelectorAll('.tww-card--player').forEach(c => c.classList.remove('is-idle'));
  }
  function armIdle() {
    clearTimeout(player.idleT);
    if (!player.expanded || !player.ch) return;
    player.idleT = setTimeout(() => {
      player.idleT = null; player.idle = true;
      document.querySelectorAll('.tww-card--player.is-expanded').forEach(c => c.classList.add('is-idle'));
    }, IDLE_MS);
  }
  function wakeControls() {
    if (player.idle) {
      player.idle = false;
      document.querySelectorAll('.tww-card--player').forEach(c => c.classList.remove('is-idle'));
    }
    armIdle();
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  const LIB_PATH = { followed: '/stream/twitch/followed', top: '/stream/twitch/top' };

  async function loadTab(tab, force) {
    if (!connected) return;
    if (tab === 'search') return;                        // explicit action only
    if (!force && lib.data[tab] !== null) return;
    if (lib.loading === tab) return;
    lib.loading = tab; lib.error = ''; paintLibrary();
    const r = await api(LIB_PATH[tab]);
    lib.loading = '';
    if (r && r.ok) lib.data[tab] = r.channels || [];
    else lib.error = (r && r.error) || 'failed';
    paintLibrary();
    publishWatch();
  }

  async function runSearch(q) {
    const query = String(q || '').trim();
    if (query.length < 2) return;
    lib.loading = 'search'; lib.error = ''; paintLibrary();
    const r = await api('/stream/twitch/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: query }) });
    lib.loading = '';
    if (r && r.ok) lib.data.search = r.channels || [];
    else lib.error = (r && r.error) || 'failed';
    paintLibrary();
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  function ensure(mount) {
    // Bumped when the built markup changes: a hidden widget's DOM is kept in the
    // pool rather than destroyed, so a stale build would never gain the notice.
    if (mount.dataset.twwBuilt === '2' && mount.firstChild) return;
    mount.dataset.twwBuilt = '2';
    const wrap = el('div', 'tww-wrap');

    const wm = el('div', 'tww-watermark'); wm.innerHTML = ICONS.logo;      // static, trusted SVG
    wrap.appendChild(wm);

    const head = el('div', 'tww-head');
    head.appendChild(el('span', 'tww-logo', 'Twitch'));
    wrap.appendChild(head);

    // All three cards are taken off screen with no account connected, which left
    // the tile as a watermark on an empty background with nothing saying why.
    const notice = el('button', 'tww-setup'); notice.type = 'button'; notice.hidden = true;
    notice.append(el('span', 'tww-setup-txt', t('tww_setup', 'Connect your Twitch account in Settings → Streaming')));
    notice.addEventListener('click', openStreamingSettings);
    wrap.appendChild(notice);

    const cards = el('div', 'tww-cards');
    cards.append(buildPlayerCard(), buildLibraryCard(), buildChatCard());
    wrap.appendChild(cards);
    mount.replaceChildren(wrap);
  }

  function iconBtn(cls, icon, label, onClick) {
    const b = el('button', 'tww-ib ' + cls); b.type = 'button';
    b.innerHTML = icon;                                                   // static, trusted SVG
    b.title = label; b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }

  function buildPlayerCard() {
    const card = el('section', 'tww-card tww-card--player');
    card.dataset.systemCard = 'player'; card.dataset.systemCardGroup = 'twitchwatch';
    // The stage sits inside a wrapper that owns the available height, so a 16:9
    // picture can never grow tall enough to push the list that picks a channel
    // off the bottom of the tile.
    const stageWrap = el('div', 'tww-stage-wrap');
    const fit = el('div', 'tww-stage-fit');
    const stage = el('div', 'tww-player-stage');
    stage.appendChild(el('div', 'tww-player-empty', t('tww_player_empty', 'Pick a channel from the list')));
    fit.appendChild(stage); stageWrap.appendChild(fit);
    card.appendChild(stageWrap);

    const catcher = el('div', 'tww-idlecatch');
    catcher.addEventListener('pointerdown', (e) => { e.stopPropagation(); wakeControls(); });
    card.appendChild(catcher);
    ['pointermove', 'pointerdown'].forEach(ev => card.addEventListener(ev, () => { if (player.expanded) wakeControls(); }));

    const now = el('div', 'tww-now');
    now.append(el('div', 'tww-now-title'), el('div', 'tww-now-sub'));
    card.appendChild(now);

    const bar = el('div', 'tww-transport');
    bar.append(
      el('span', 'tww-transport-gap'),
      iconBtn('tww-expand', ICONS.expand, t('tww_expand', 'Full screen'), () => setExpanded(!player.expanded)),
      iconBtn('tww-out', ICONS.external, t('tww_open_browser', 'Open in the browser'), async () => {
        const url = player.ch && channelUrl(player.ch.login);
        if (url) await openOut(url);
      }),
      iconBtn('tww-stop', ICONS.close, t('tww_close_player', 'Close the player'), stopPlayer),
    );
    card.appendChild(bar);

    // Shown only when the page's own address is not something Twitch will accept
    // as a `parent`. Saying so beats a black rectangle that never explains itself.
    const blocked = el('div', 'tww-blocked');
    blocked.append(el('span', null, t('tww_no_embed', 'Twitch cannot play at this address.')));
    const bb = el('button', 'tww-blocked-btn', t('tww_open_browser', 'Open in the browser'));
    bb.type = 'button';
    bb.addEventListener('click', async () => {
      const url = player.ch && channelUrl(player.ch.login);
      if (url) await openOut(url);
    });
    blocked.appendChild(bb);
    card.appendChild(blocked);
    return card;
  }

  function buildLibraryCard() {
    const card = el('section', 'tww-card tww-card--library');
    card.dataset.systemCard = 'library'; card.dataset.systemCardGroup = 'twitchwatch';

    const tabsRow = el('div', 'tww-tabs');
    const TAB_ICON = { followed: ICONS.heart, top: ICONS.fire, search: ICONS.search };
    TABS.forEach(id => {
      const b = el('button', 'tww-tab'); b.type = 'button'; b.dataset.twwTab = id;
      const ico = el('span', 'tww-tab-ico'); ico.innerHTML = TAB_ICON[id];  // static, trusted SVG
      b.append(ico, el('span', 'tww-tab-lbl', TAB_LABEL[id]()));
      b.addEventListener('click', () => {
        lib.tab = id; lib.error = '';
        paintLibrary();
        loadTab(id);
      });
      tabsRow.appendChild(b);
    });
    card.appendChild(tabsRow);

    const searchRow = el('div', 'tww-search-row');
    const inp = document.createElement('input');
    inp.type = 'search'; inp.className = 'tww-search-input'; inp.maxLength = 100;
    inp.placeholder = t('tww_search_ph', 'Search a channel');
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(inp.value); });
    const go = el('button', 'tww-search-go'); go.type = 'button';
    go.innerHTML = ICONS.search;                                           // static, trusted SVG
    go.setAttribute('aria-label', t('tww_tab_search', 'Search'));
    go.addEventListener('click', () => runSearch(inp.value));
    searchRow.append(inp, go);
    card.appendChild(searchRow);

    card.appendChild(el('div', 'tww-list'));
    return card;
  }

  function buildChatCard() {
    const card = el('section', 'tww-card tww-card--chat');
    card.dataset.systemCard = 'chat'; card.dataset.systemCardGroup = 'twitchwatch';

    const row = el('div', 'tww-chat-send');
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'tww-chat-input'; inp.maxLength = 500;
    inp.placeholder = t('tww_chat_ph', 'Send a message');
    const send = el('button', 'tww-chat-go'); send.type = 'button';
    send.innerHTML = ICONS.send;                                           // static, trusted SVG
    send.setAttribute('aria-label', t('tww_chat_send', 'Send'));
    const go = () => sendChatMessage(inp);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    send.addEventListener('click', go);
    const emo = iconBtn('tww-chat-emo', ICONS.smile, t('tww_chat_emotes', 'Emotes'), (e) => {
      e.stopPropagation();
      toggleEmotePicker(card);
    });
    // Everything the embed could do and this cannot: channel points, the emote
    // picker, moderation. One tap opens the real chat page where those live,
    // rather than pretending they are here.
    const out = iconBtn('tww-chat-out', ICONS.external, t('tww_chat_open', 'Open the full chat'), async () => {
      const url = player.ch && LOGIN_RE.test(player.ch.login)
        ? 'https://www.twitch.tv/popout/' + encodeURIComponent(player.ch.login) + '/chat'
        : '';
      if (url) await openOut(url);
    });
    row.append(inp, emo, send, out);

    card.append(el('div', 'tww-chat-note'), el('div', 'tww-chat-log'), el('div', 'tww-emopick'), row, el('div', 'tww-chat-err'));
    return card;
  }

  // ── The emote picker ──────────────────────────────────────────────────────
  // Twitch's own input has one, and typing `berlinoWhatt` from memory is not a
  // real alternative. Tapping an emote puts its CODE in the box rather than an
  // image, because that is what a chat message is: the code is what everyone
  // else's client turns back into the picture.
  const emoCache = new Map();          // channel → [{ name, url }]
  let emoLoading = '';
  async function toggleEmotePicker(card) {
    const box = card.querySelector('.tww-emopick');
    if (box.classList.contains('is-open')) { box.classList.remove('is-open'); return; }
    const ch = player.ch && player.ch.login;
    if (!ch) return;
    box.classList.add('is-open');
    if (emoCache.has(ch)) { fillEmotePicker(box, emoCache.get(ch), card); return; }
    if (emoLoading === ch) return;
    emoLoading = ch;
    box.replaceChildren(el('div', 'tww-emopick-note', t('browser_loading', 'Loading…')));
    const r = await api('/stream/twitch/emotes?channel=' + encodeURIComponent(ch));
    emoLoading = '';
    const list = (r && r.ok && Array.isArray(r.emotes)) ? r.emotes : [];
    if (emoCache.size >= 8) emoCache.clear();
    emoCache.set(ch, list);
    if (box.classList.contains('is-open')) fillEmotePicker(box, list, card);
  }
  function fillEmotePicker(box, list, card) {
    if (!list.length) { box.replaceChildren(el('div', 'tww-emopick-note', t('tww_chat_noemotes', 'No emotes to show'))); return; }
    const frag = document.createDocumentFragment();
    list.forEach(e => {
      const b = el('button', 'tww-emopick-item'); b.type = 'button';
      b.title = e.name;
      const img = document.createElement('img');
      img.src = e.url; img.alt = e.name; img.loading = 'lazy';
      b.appendChild(img);
      b.addEventListener('click', () => {
        const inp = card.querySelector('.tww-chat-input');
        // A chat message needs the code separated from whatever is around it, or
        // the next word swallows it.
        const cur = inp.value;
        inp.value = (cur && !/\s$/.test(cur) ? cur + ' ' : cur) + e.name + ' ';
        inp.focus();
      });
      frag.appendChild(b);
    });
    box.replaceChildren(frag);
  }
  // A tap anywhere else closes it, the way every picker on the dashboard behaves.
  document.addEventListener('pointerdown', (e) => {
    document.querySelectorAll('.tww-emopick.is-open').forEach(box => {
      if (!box.contains(e.target)) box.classList.remove('is-open');
    });
  });

  // Sending is a different thing from reading and takes a different route: the
  // socket above is joined anonymously and cannot speak, so the message goes to
  // our own server, which posts it to Twitch with the user's token. It arrives in
  // the chat the reader is listening to, so it appears in the log like any other.
  async function sendChatMessage(input) {
    const text = String(input.value || '').trim();
    const ch = player.ch;
    if (!text || !ch) return;
    input.disabled = true;
    const r = await api('/stream/twitch/chat/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: ch.login, message: text }),
    });
    input.disabled = false;
    if (r && r.ok) { input.value = ''; showChatErr(''); }
    else showChatErr(chatErrText(r));
    input.focus();
  }
  const CHAT_ERR_KEY = {
    not_connected: 'tww_err_not_connected',
    refused: 'tww_chat_refused',
    not_sent: 'tww_chat_dropped',
    no_user: 'tww_chat_nochannel',
  };
  function chatErrText(r) {
    if (!r) return t('tww_chat_noserver', 'Xenon did not answer');
    const k = CHAT_ERR_KEY[r.error];
    return k ? t(k, String(r.error)) : t('tww_chat_failed', 'The message did not go through');
  }
  function showChatErr(msg) {
    document.querySelectorAll('.tww-chat-err').forEach(n => {
      n.textContent = msg;
      n.style.display = msg ? '' : 'none';
      clearTimeout(n._tm);
      if (msg) n._tm = setTimeout(() => { n.textContent = ''; n.style.display = 'none'; }, 8000);
    });
  }

  // ── Chat, read anonymously and drawn by us ────────────────────────────────
  // This started as Twitch's own chat iframe and that was the wrong call, proven
  // twice on a real dashboard: the embed is a whole twitch.tv page, so it opened
  // with Twitch's cookie and advertising panel across it (built for a full window,
  // so cut off in a tile with its buttons out of reach), and once that was
  // answered the page's own header, event banner, message box and footer left
  // about two lines for the actual chat. Reading a channel's chat needs no account
  // at all, so the messages come over the same anonymous IRC socket the streamer's
  // Twitch tile has used for versions, and the lines are ours to draw: they fit,
  // they match the dashboard, and nothing sets a cookie.
  const CHAT_MAX = 120;
  let chatSock = null;
  let chatChannel = '';
  let chatReconnect = null;
  let chatLines = [];

  function chatCardOn() {
    return tiles().some(tile => {
      const c = tile.querySelector('.tww-card--chat');
      return !!c && c.dataset.systemCardHidden !== 'true';
    });
  }
  // The single gate for "should the socket be open": a socket left open on a
  // hidden page keeps receiving messages and mutating the DOM for nobody.
  function manageChat() {
    const want = !!(player.ch && chatCardOn() && !document.hidden && tiles().some(onVisiblePage));
    if (want) connectChat(player.ch.login);
    else closeChat();
  }

  function connectChat(channel) {
    if (chatChannel === channel && chatSock && chatSock.readyState <= 1) return;
    const switched = chatChannel !== channel;
    closeChat();
    if (switched) {
      chatLines = [];
      document.querySelectorAll('.tww-chat-log').forEach(l => l.replaceChildren());
      publishChat(channel, false);   // a widget must not keep drawing the previous channel's chat
    }
    chatChannel = channel;
    try { chatSock = new WebSocket('wss://irc-ws.chat.twitch.tv:443'); }
    catch { chatSock = null; return; }
    chatSock.onopen = () => {
      ircSend('CAP REQ :twitch.tv/tags');
      ircSend('NICK ' + window.TwitchChat.anonNick());
      ircSend('JOIN #' + channel);
    };
    chatSock.onmessage = (e) => {
      const r = window.TwitchChat.parseIrcLines(String(e.data || ''));
      if (r.ping) ircSend('PONG :tmi.twitch.tv');
      r.messages.forEach(pushChat);
    };
    chatSock.onclose = () => { if (chatChannel) scheduleChatReconnect(); };
    chatSock.onerror = () => { try { chatSock.close(); } catch { /* already gone */ } };
  }
  function scheduleChatReconnect() {
    if (chatReconnect) return;
    chatReconnect = setTimeout(() => {
      chatReconnect = null;
      if (chatChannel && tiles().length) connectChat(chatChannel);
    }, 4000);
  }
  function closeChat() {
    if (chatReconnect) { clearTimeout(chatReconnect); chatReconnect = null; }
    const had = chatChannel;
    chatChannel = '';
    if (chatSock) { try { chatSock.onclose = null; chatSock.close(); } catch { /* already gone */ } chatSock = null; }
    // Keep the messages and say the feed stopped, rather than publishing an empty
    // list: a reconnect is four seconds and a widget should not blink through it.
    if (had) { cancelChatFlush(); publishChat(had, false); }
  }
  function ircSend(line) {
    try { if (chatSock && chatSock.readyState === 1) chatSock.send(line + '\r\n'); }
    catch { /* closed under us */ }
  }

  function pushChat(entry) {
    entry.seq = ++chatSeq;   // lets an SDK widget tell new lines from a repeated snapshot
    chatLines.push(entry);
    if (chatLines.length > CHAT_MAX) chatLines.shift();
    document.querySelectorAll('.tww-chat-log').forEach(log => appendChatLine(log, entry));
    publishChatSoon();
  }
  // Names, message text and the colour all come from strangers in a public chat.
  // Text goes in as text, the colour was validated against a strict hex pattern
  // and an emote id against a strict character set before it became a URL, so
  // none of it can turn into markup, a style or a path.
  function appendChatLine(log, entry) {
    const near = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    const line = el('div', 'tww-chat-line');
    const u = el('span', 'tww-chat-user', entry.name + ':');
    if (entry.color) u.style.color = entry.color;
    line.append(u, document.createTextNode(' '));
    const body = el('span', 'tww-chat-text');
    (entry.parts || [{ type: 'text', text: entry.text }]).forEach(p => {
      if (p.type === 'emote') {
        const img = document.createElement('img');
        img.className = 'tww-emote';
        img.src = p.url;
        img.alt = p.name;                 // the code, if the image never loads
        img.title = p.name;
        img.loading = 'lazy';
        body.appendChild(img);
      } else body.appendChild(document.createTextNode(p.text));
    });
    line.appendChild(body);
    log.appendChild(line);
    while (log.childElementCount > CHAT_MAX) log.removeChild(log.firstChild);
    if (near) log.scrollTop = log.scrollHeight;   // follow only if already at the end
  }

  function channelRow(ch) {
    const b = el('button', 'tww-row'); b.type = 'button';
    const art = el('span', 'tww-row-art');
    if (ch.image) art.style.backgroundImage = 'url("' + encodeURI(ch.image) + '")';
    const meta = el('div', 'tww-row-meta');
    meta.append(el('span', 'tww-row-name', ch.name || ch.login));
    const sub = [ch.game || '', ch.title || ''].filter(Boolean).join(' · ');
    if (sub) meta.append(el('span', 'tww-row-sub', sub));
    b.append(art, meta);
    const v = fmtViewers(ch.viewers);
    if (v) {
      const badge = el('span', 'tww-row-viewers');
      const dot = el('span', 'tww-row-dot'); dot.innerHTML = ICONS.viewers;  // static, trusted SVG
      badge.append(dot, el('span', null, v));
      b.appendChild(badge);
    } else {
      const play = el('span', 'tww-row-play'); play.innerHTML = ICONS.play;  // static, trusted SVG
      b.appendChild(play);
    }
    b.addEventListener('click', async () => {
      const wrap = b.closest('.tww-wrap');
      const stage = wrap ? wrap.querySelector('.tww-player-stage') : null;
      // Someone who hid the player card still expects a tap to do something, so
      // fall back to the browser rather than doing nothing at all.
      if (stage && embedParent()) watch(ch, stage);
      else { const url = channelUrl(ch.login); if (url) await openOut(url); }
    });
    return b;
  }

  // ── Painting ──────────────────────────────────────────────────────────────
  function eachMount(fn) {
    tiles().forEach(tile => {
      const mount = tile.querySelector('.twitchwatch-widget-mount');
      if (!mount) return;
      ensure(mount);
      fn(mount, tile);
    });
  }

  function setIcon(node, key, svg) {
    if (node.dataset.twwIcon === key) return;
    node.dataset.twwIcon = key;
    node.innerHTML = svg;                                                  // static, trusted SVG
  }

  function paintPlayer() {
    const ch = player.ch;
    const canEmbed = !!embedParent();
    eachMount(mount => {
      const card = mount.querySelector('.tww-card--player');
      if (!card) return;
      const editing = document.body.classList.contains('layout-editing');
      // Unknown is not the same as disconnected: only a definite "no account"
      // takes the player away, or the tile renders as an empty box while the
      // first answer is still in flight.
      card.style.display = (connected !== false || editing) ? '' : 'none';
      const stage = card.querySelector('.tww-player-stage');
      const owns = !!(player.frame && player.stage === stage);
      const empty = stage.querySelector('.tww-player-empty');
      if (empty) {
        empty.style.display = owns ? 'none' : '';
        empty.textContent = canEmbed ? t('tww_player_empty', 'Pick a channel from the list') : t('tww_no_embed', 'Twitch cannot play at this address.');
      }
      card.classList.toggle('is-playing', owns && !!ch);
      card.classList.toggle('is-expanded', player.expanded && owns);

      card.querySelector('.tww-now-title').textContent = ch ? (ch.name || ch.login) : '';
      const v = ch ? fmtViewers(ch.viewers) : '';
      card.querySelector('.tww-now-sub').textContent = ch
        ? [ch.game || '', v ? v + ' ' + t('tww_viewers', 'watching') : ''].filter(Boolean).join(' · ')
        : '';

      const exp = card.querySelector('.tww-expand');
      setIcon(exp, player.expanded ? 'shrink' : 'expand', player.expanded ? ICONS.shrink : ICONS.expand);
      exp.disabled = !ch;
      card.querySelector('.tww-out').disabled = !ch;
      card.querySelector('.tww-stop').disabled = !ch;
      card.querySelector('.tww-blocked').style.display = (!canEmbed && ch) ? '' : 'none';
    });
  }

  function paintLibrary() {
    eachMount(mount => {
      const card = mount.querySelector('.tww-card--library');
      if (!card) return;
      const editing = document.body.classList.contains('layout-editing');
      card.style.display = (connected !== false || editing) ? '' : 'none';
      card.querySelectorAll('.tww-tab').forEach(b => b.classList.toggle('is-on', b.dataset.twwTab === lib.tab));
      card.querySelector('.tww-search-row').style.display = lib.tab === 'search' ? '' : 'none';

      const list = card.querySelector('.tww-list');
      const rows = lib.data[lib.tab];
      // Rebuilding an unchanged list on every poll would throw the user's scroll
      // position away, so only rebuild on a real change.
      const sig = [connected, document.documentElement.lang, lib.tab, lib.loading, lib.error,
        rows === null || rows === undefined ? 'n' : rows.map(r => r.login).join(',')].join('|');
      if (list.dataset.twwSig === sig) return;
      list.dataset.twwSig = sig;

      // A definite "no account" never resolves, so it must not borrow the loading
      // line — that is a spinner over an answer we already have.
      if (connected === false) { list.replaceChildren(el('div', 'tww-list-note', t('twitch_not_connected', 'Connect in Settings'))); return; }
      if (connected !== true) { list.replaceChildren(el('div', 'tww-list-note', t('browser_loading', 'Loading…'))); return; }
      if (lib.loading) { list.replaceChildren(el('div', 'tww-list-note', t('browser_loading', 'Loading…'))); return; }
      if (lib.error === 'scope') {
        // The one failure worth its own sentence AND a button. The account IS
        // connected, and Settings says so in green two taps away, so a message
        // that only says "reconnect" reads as a contradiction and as a bug. It
        // has to say which permission is missing, that the connection itself is
        // fine, and then take the user to the one place that can fix it.
        const note = el('div', 'tww-list-note tww-list-err');
        note.appendChild(el('div', null, t('tww_err_scope', 'Twitch is connected, but the followed list needs a permission that was not asked for. Reconnect once.')));
        const b = el('button', 'tww-note-btn', t('tww_err_scope_btn', 'Open Settings'));
        b.type = 'button';
        b.addEventListener('click', openStreamingSettings);
        note.appendChild(b);
        list.replaceChildren(note);
        return;
      }
      if (lib.error) { list.replaceChildren(el('div', 'tww-list-note tww-list-err', t('tww_list_failed', 'Could not load this list.'))); return; }

      const frag = document.createDocumentFragment();
      if (lib.tab === 'search' && rows === null) {
        frag.appendChild(el('div', 'tww-list-note', t('tww_search_hint', 'Type a name and press search.')));
      } else if (rows === null) {
        frag.appendChild(el('div', 'tww-list-note', t('browser_loading', 'Loading…')));
      } else if (!rows.length) {
        frag.appendChild(el('div', 'tww-list-note', lib.tab === 'followed'
          ? t('tww_none_followed', 'Nobody you follow is live right now')
          : t('tww_nothing', 'Nothing here')));
      } else {
        rows.forEach(ch => frag.appendChild(channelRow(ch)));
      }
      list.replaceChildren(frag);
    });
  }

  function paintChat() {
    const want = player.ch ? player.ch.login : '';
    eachMount(mount => {
      const card = mount.querySelector('.tww-card--chat');
      if (!card) return;
      const editing = document.body.classList.contains('layout-editing');
      card.style.display = (connected !== false || editing) ? '' : 'none';
      const log = card.querySelector('.tww-chat-log');
      const note = card.querySelector('.tww-chat-note');
      // Written on EVERY pass, not only when the channel changes. The note is set
      // once at build time and the language can arrive after that, which is
      // exactly what happened: the whole widget was in Italian and this one line
      // stayed in English, because the rebuild it was waiting for never came.
      note.textContent = want
        ? (chatLines.length ? '' : t('tww_chat_wait', 'Waiting for the first message'))
        : t('tww_chat_empty', 'The chat appears here once you are watching a channel');
      note.style.display = (want && chatLines.length) ? 'none' : '';
      card.classList.toggle('is-empty', !want);
      log.style.display = want ? '' : 'none';
      // Nothing playing means no chat to speak in, so the box goes away rather
      // than sitting there accepting text with nowhere to send it.
      card.querySelector('.tww-chat-send').style.display = want ? '' : 'none';
      // A log built after the messages started arriving (a new tile, a rebuild)
      // seeds from the buffer instead of staying blank until someone types.
      if (log.dataset.twwChat !== want) {
        log.dataset.twwChat = want;
        log.replaceChildren();
        if (want) chatLines.forEach(e => appendChatLine(log, e));
      }
    });
    manageChat();
  }

  // Fixed labels are written once at build time, but the language can change
  // under a tile that is mid-stream, and rebuilding would reload the player. So
  // they are re-applied on every paint instead, and the list signature carries
  // the language so its rows re-render too.
  function relabel(mount) {
    mount.querySelectorAll('.tww-tab').forEach(b => {
      const f = TAB_LABEL[b.dataset.twwTab];
      if (f) b.querySelector('.tww-tab-lbl').textContent = f();
    });
    const inp = mount.querySelector('.tww-search-input');
    if (inp) inp.placeholder = t('tww_search_ph', 'Search a channel');
    const ci = mount.querySelector('.tww-chat-input');
    if (ci) ci.placeholder = t('tww_chat_ph', 'Send a message');
    const setup = mount.querySelector('.tww-setup');
    // Only a definite "no account": while the check is still out the cards are on
    // screen and saying "connect" would be a guess.
    if (setup) {
      setup.hidden = connected !== false;
      setup.querySelector('.tww-setup-txt').textContent = t('tww_setup', 'Connect your Twitch account in Settings → Streaming');
    }
  }

  function paint() {
    eachMount(mount => relabel(mount));
    paintPlayer();
    paintLibrary();
    paintChat();
  }

  async function refresh() {
    if (!tiles().length) { stop(); return; }
    // "Is an account connected" reads our own token store and reaches nothing
    // outside the PC, so it runs even when nobody is looking at the tile — a
    // widget that does not know what to draw is what leaves an empty box on
    // screen for as long as the page stays unseen.
    const s = await api('/stream/twitch/status');
    const was = connected;
    if (s) connected = !!s.connected;
    if (connected) {
      if (lib.tab !== 'search' && lib.data[lib.tab] === null && !lib.loading) loadTab(lib.tab);
    } else if (connected === false && was !== false) {
      // Signed out, possibly to sign a different account in: drop everything the
      // previous account put on screen.
      lib.data = { followed: null, top: null, search: null };
      lib.error = '';
      stopPlayer();
    }
    paint();
    publishWatch();
  }
  function stop() {
    if (poll) { clearInterval(poll); poll = null; }
    closeChat();
    cancelChatFlush();      // stop what you start: closeChat only cancels it when a chat was open
    // The widget was taken off every page — but the tile's DOM is MOVED to the
    // hidden widget pool, not destroyed, and a display:none iframe keeps playing.
    // Without this, removing the widget mid-stream leaves the audio running with
    // nothing on screen left to stop it.
    if (player.frame) stopPlayer();
  }

  function renderWidgets() {
    if (!tiles().length) { stop(); return; }
    paint();
    if (!poll) { refresh(); poll = setInterval(refresh, POLL_MS); }
  }

  // ── SDK bridge ────────────────────────────────────────────────────────────
  // Two streams and one action for community widgets. Everything here hands over
  // what this tile has ALREADY read: a widget granted `twitchWatch` costs no
  // extra call to Twitch, and a widget granted `twitchChat` costs no second
  // socket. That is the whole design — the SDK never gets its own connection to
  // Twitch, it gets a copy of ours.
  const CHAT_SDK_MAX = 40;          // messages carried in a snapshot
  const CHAT_SDK_MS = 500;          // a busy channel is 10+ lines a second
  let chatSeq = 0;
  let chatFlush = null;

  function publish(stream, payload) {
    try {
      if (window.CustomWidget && typeof CustomWidget.publishStream === 'function') {
        CustomWidget.publishStream(stream, payload);
      }
    } catch { /* the SDK host is optional — never let it break the tile */ }
  }
  // The row the player is on, cut down to the fields a widget can use. Called by
  // the SDK host too (its loader reads `playing` live rather than caching it).
  function playingForSdk() {
    const c = player.ch;
    if (!c || !LOGIN_RE.test(String(c.login || ''))) return null;
    return {
      login: c.login,
      name: c.name || c.login,
      title: c.title || '',
      game: c.game || '',
      viewers: (c.viewers == null || !Number.isFinite(Number(c.viewers))) ? null : Number(c.viewers),
      image: c.image || '',
    };
  }
  function publishWatch() {
    publish('twitchWatch', {
      ok: connected !== false,
      connected: connected === true,
      error: lib.error || '',
      live: Array.isArray(lib.data.followed) ? lib.data.followed : [],
      playing: playingForSdk(),
    });
  }
  // Coalesced: a snapshot rather than an event, so a widget that was off-screen
  // (the host stops feeding those) comes back to the current conversation instead
  // of a hole, and `seq` lets it tell what it has already drawn.
  function publishChat(channel, connectedNow) {
    publish('twitchChat', {
      ok: true,
      channel: channel || '',
      connected: !!connectedNow,
      messages: chatLines.slice(-CHAT_SDK_MAX),
    });
  }
  function publishChatSoon() {
    if (chatFlush) return;
    chatFlush = setTimeout(() => { chatFlush = null; publishChat(chatChannel, true); }, CHAT_SDK_MS);
  }
  function cancelChatFlush() {
    if (chatFlush) { clearTimeout(chatFlush); chatFlush = null; }
  }

  // Play a channel in this tile on behalf of a widget the user granted `watch`.
  // The login is re-validated here because this is where it becomes part of an
  // embed URL, and an unknown channel is still played: Followed and Top are the
  // lists WE happen to hold, not the set of channels that exist.
  function playFromSdk(raw) {
    const login = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!LOGIN_RE.test(login)) return { ok: false, error: 'bad_channel' };
    if (!tiles().length) return { ok: false, error: 'unavailable' };
    const stage = document.querySelector('.tww-player-stage');
    if (!stage) return { ok: false, error: 'unavailable' };
    const known = ['followed', 'top', 'search']
      .map(k => lib.data[k])
      .filter(Array.isArray)
      .reduce((all, list) => all.concat(list), [])
      .find(c => c && c.login === login);
    watch(known || { login, name: login, title: '', game: '', viewers: null, image: '', live: true }, stage);
    return { ok: true };
  }

  window.TwitchWatchWidget = { renderWidgets, playFromSdk, playingForSdk };
})();
