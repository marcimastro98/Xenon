'use strict';
// YouTube Live widget — the creator half, split out of the YouTube widget so that
// one is for watching and this one is for broadcasting. Three cards:
//   • info    — viewers, total views and likes, the editable title, ingest health
//               and who can watch.
//   • actions — create a live from nothing, go live, end it, cancel it, copy the
//               link, and the stream key for OBS.
//   • chat    — the live chat, read and write.
//
// STARTING A STREAM: creating the broadcast also creates the channel's ingestion
// endpoint if it has none, and asks YouTube for `enableAutoStart`. That is what
// makes the flow honest — YouTube itself takes the broadcast live the moment OBS
// starts pushing, so nothing here has to guess when the encoder is ready. Go live
// stays for the case where the encoder is already up.
//
// QUOTA: the status poll is slow (30s) and only runs while a tile is on the page
// being looked at. Chat is the one repeating cost, so it polls only while the
// stream is actually live AND its card is on screen, at the interval YouTube
// itself asks for. The server holds each answer for that interval, so nothing
// here can make it cost more by asking harder.
(function () {
  const ICONS = {
    logo: '<svg viewBox="0 0 90 64" fill="none"><rect width="90" height="64" rx="18" fill="#ff0000"/><path d="M36 46V18l24 14z" fill="#0b0d10"/></svg>',
    golive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v4M15 12v3"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 20l18-8L3 4l4 8z"/></svg>',
  };
  const HEALTH_KEY = { good: 'youtube_health_good', ok: 'youtube_health_ok', bad: 'youtube_health_bad', noData: 'youtube_health_nodata' };
  const PRIVACY = ['public', 'unlisted', 'private'];
  const PRIVACY_KEY = { public: 'ytl_privacy_public', unlisted: 'ytl_privacy_unlisted', private: 'ytl_privacy_private' };
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;                     // shared DOM factory from utils.js
  const api = apiJson;                   // shared fetch-JSON helper from utils.js
  // Only tiles actually placed on a dashboard page count — a widget sitting in the
  // pool must not poll YouTube. Same rule as every other polling widget.
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="youtubelive"]')).filter(n => n.closest('.pager-page')); }
  // A paired phone is refused the stream key by the server (it is a credential
  // that lets its holder broadcast to the channel). Knowing that here means not
  // offering a button that could only fail.
  const isRemote = !!window.__xenonRemote;

  function openStreamingSettings() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay && overlay.hidden && typeof window.toggleSettings === 'function') window.toggleSettings();
    if (typeof window.settingsSetCategory === 'function') window.settingsSetCategory('streaming');
  }

  const POLL_MS = 30000;
  const CHAT_MAX = 150;                  // messages kept in the list
  let poll = null;
  let chatTimer = null;
  let connected = null;                  // null = not asked yet
  let bc = null;                         // broadcastStatus result
  let busy = '';                         // an action in flight: 'create' | 'live' | 'cancel'
  const chat = { items: [], token: '', pollMs: 5000, error: '', ids: new Set() };
  const draft = { title: '', privacy: 'unlisted' };
  let key = null;                        // { url, key } once revealed

  const live = () => !!(bc && bc.ok && bc.live);
  const hasBroadcast = () => !!(bc && bc.ok && (bc.live || bc.title));

  // ── Actions ───────────────────────────────────────────────────────────────
  // Every one of these reports its own failure next to the button that caused it
  // rather than through a toast: on a touchscreen the finger is already there.
  function showErr(node, msg) {
    const card = node && node.closest('.ytl-card');
    if (!card) return;
    let n = card.querySelector('.ytl-err');
    if (!n) { n = el('div', 'ytl-err'); card.appendChild(n); }
    n.textContent = msg;
    clearTimeout(n._ytlT);
    n._ytlT = setTimeout(() => { n.textContent = ''; }, 6000);
  }
  const ERR_KEY = {
    no_broadcast: 'youtube_err_no_broadcast',
    not_connected: 'youtube_err_not_connected',
    already_exists: 'ytl_err_already',
    is_live: 'ytl_err_is_live',
    no_stream: 'ytl_err_no_stream',
    no_chat: 'ytl_chat_wait',
  };
  // Takes the whole reply, not just its error code, because "no reply at all"
  // is its own thing and the most likely one right after an update: the browser
  // has the new dashboard and the server is still the old one, so the route does
  // not exist yet. Saying "that did not work" there sends the user looking in the
  // wrong place.
  function errText(r) {
    if (!r) return t('ytl_err_noserver', 'Xenon did not answer');
    const k = ERR_KEY[r.error];
    return k ? t(k, String(r.error)) : t('ytl_err_generic', 'That did not work');
  }

  async function post(path, body) {
    return api(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  }

  async function runAction(btn, what, fn) {
    if (busy) return;
    busy = what; paint();
    const r = await fn();
    busy = '';
    if (!r || !r.ok) showErr(btn, errText(r));
    bc = null;                          // force the next poll to re-read the truth
    await refresh();
  }

  // ── Chat ──────────────────────────────────────────────────────────────────
  function chatWanted() {
    if (!live() || !bc.chat) return false;
    if (document.hidden) return false;
    return tiles().some(tile => {
      if (!onVisiblePage(tile)) return false;
      const card = tile.querySelector('.ytl-card--chat');
      return !!card && getComputedStyle(card).display !== 'none';
    });
  }

  async function pollChat() {
    chatTimer = null;
    if (!chatWanted()) { scheduleChat(8000); return; }
    const r = await api('/stream/youtube/chat' + (chat.token ? '?page=' + encodeURIComponent(chat.token) : ''));
    if (r && r.ok) {
      chat.error = '';
      chat.token = r.pageToken || '';
      chat.pollMs = Math.max(5000, Number(r.pollMs) || 5000);
      let added = false;
      (r.messages || []).forEach(m => {
        if (!m || !m.id || chat.ids.has(m.id)) return;
        chat.ids.add(m.id); chat.items.push(m); added = true;
      });
      if (chat.items.length > CHAT_MAX) {
        const cut = chat.items.splice(0, chat.items.length - CHAT_MAX);
        cut.forEach(m => chat.ids.delete(m.id));
      }
      if (added) paintChat();
    } else if (r && r.error && r.error !== 'no_chat') {
      chat.error = r.error;
      paintChat();
    }
    scheduleChat(chat.pollMs);
  }
  function scheduleChat(ms) {
    clearTimeout(chatTimer);
    chatTimer = setTimeout(pollChat, Math.max(4000, ms || 5000));
  }
  function resetChat() {
    chat.items.length = 0; chat.ids.clear();
    chat.token = ''; chat.error = '';
  }

  async function sendChat(input, btn) {
    const text = String(input.value || '').trim();
    if (!text) return;
    input.disabled = true; btn.disabled = true;
    const r = await post('/stream/youtube/chat/send', { text });
    input.disabled = false; btn.disabled = false;
    if (r && r.ok) {
      input.value = '';
      // The message comes back through the normal poll; asking early would just
      // spend a quota unit to see something the next tick brings anyway.
      input.focus();
    } else {
      showErr(btn, errText(r));
    }
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  function ensure(mount) {
    // Bumped when the built markup changes: a hidden widget's DOM is kept in the
    // pool rather than destroyed, so a stale build would never gain the notice.
    if (mount.dataset.ytlBuilt === '2' && mount.firstChild) return;
    mount.dataset.ytlBuilt = '2';
    const wrap = el('div', 'ytl-wrap');

    const wm = el('div', 'ytl-watermark'); wm.innerHTML = ICONS.logo;      // static, trusted SVG
    wrap.appendChild(wm);

    const head = el('div', 'ytl-head');
    const brand = el('div', 'ytl-brand');
    brand.append(el('span', 'ytl-logo', 'YouTube'), el('span', 'ytl-logo-sub', 'LIVE'));
    const pill = el('span', 'ytl-pill');
    pill.append(el('span', 'ytl-pill-dot'), el('span', 'ytl-pill-txt'));
    head.append(brand, pill);
    wrap.appendChild(head);

    // The info card carries a "connect" line of its own, but paint() hides that
    // card when there is no account — so the explanation went away exactly when
    // it was the only thing left to say. This notice sits OUTSIDE the cards.
    const notice = el('button', 'ytl-setup'); notice.type = 'button'; notice.hidden = true;
    notice.append(el('span', 'ytl-setup-txt', t('youtube_w_setup', 'Connect your YouTube account in Settings → Streaming')));
    notice.addEventListener('click', openStreamingSettings);
    wrap.appendChild(notice);

    const cards = el('div', 'ytl-cards');
    cards.append(buildInfoCard(), buildActionsCard(), buildChatCard());
    wrap.appendChild(cards);
    mount.replaceChildren(wrap);
  }

  function buildInfoCard() {
    const card = el('section', 'ytl-card ytl-card--info');
    card.dataset.systemCard = 'info'; card.dataset.systemCardGroup = 'youtubelive';
    card.appendChild(el('div', 'ytl-info'));
    return card;
  }

  function buildActionsCard() {
    const card = el('section', 'ytl-card ytl-card--actions');
    card.dataset.systemCard = 'actions'; card.dataset.systemCardGroup = 'youtubelive';
    card.appendChild(el('div', 'ytl-card-label', t('layout_card_actions', 'Actions')));

    // Create a live: a title, who can see it, and the button.
    const make = el('div', 'ytl-make');
    const ti = document.createElement('input');
    ti.type = 'text'; ti.className = 'ytl-input ytl-make-title'; ti.maxLength = 100;
    ti.addEventListener('input', () => { draft.title = ti.value; });
    const privRow = el('div', 'ytl-privacy');
    PRIVACY.forEach(p => {
      const b = el('button', 'ytl-priv'); b.type = 'button'; b.dataset.ytlPriv = p;
      b.addEventListener('click', async () => {
        if (hasBroadcast()) {
          const r = await post('/stream/youtube/privacy', { privacy: p });
          if (!r || !r.ok) { showErr(b, errText(r)); return; }
          bc = null; await refresh();
        } else {
          draft.privacy = p; paint();
        }
      });
      privRow.appendChild(b);
    });
    const mk = el('button', 'ytl-btn ytl-make-go');
    mk.append(el('span', 'ytl-btn-ico'), el('span', 'ytl-btn-lbl'));
    mk.querySelector('.ytl-btn-ico').innerHTML = ICONS.plus;              // static, trusted SVG
    mk.addEventListener('click', () => runAction(mk, 'create', () =>
      post('/stream/youtube/broadcast/create', { title: draft.title, privacy: draft.privacy })));
    make.append(ti, privRow, mk, el('div', 'ytl-hint ytl-make-hint'));
    card.appendChild(make);

    // Live controls, for a broadcast that already exists.
    const row = el('div', 'ytl-row ytl-live-row');
    const go = el('button', 'ytl-btn ytl-go');
    go.append(el('span', 'ytl-btn-ico'), el('span', 'ytl-btn-lbl'));
    go.addEventListener('click', () => runAction(go, 'live', () =>
      post('/actions/run', { type: 'ytBroadcast', mode: 'toggle' })));
    const cancel = el('button', 'ytl-ib ytl-cancel'); cancel.type = 'button';
    cancel.innerHTML = ICONS.trash;                                       // static, trusted SVG
    cancel.title = t('ytl_cancel', 'Cancel the live');
    cancel.setAttribute('aria-label', cancel.title);
    cancel.addEventListener('click', () => runAction(cancel, 'cancel', () => post('/stream/youtube/broadcast/cancel')));
    const linkBtn = el('button', 'ytl-ib ytl-link'); linkBtn.type = 'button';
    linkBtn.innerHTML = ICONS.link;                                       // static, trusted SVG
    linkBtn.title = t('ytl_link', 'Link to the live');
    linkBtn.setAttribute('aria-label', linkBtn.title);
    linkBtn.addEventListener('click', async () => {
      const url = watchUrl();
      if (!url) return;
      const done = await copyText(url);
      flash(linkBtn, done ? t('ytl_copied', 'Copied') : t('ytl_err_generic', 'That did not work'));
    });
    row.append(go, el('span', 'ytl-row-gap'), linkBtn, cancel);
    card.appendChild(row);
    card.appendChild(el('div', 'ytl-hint ytl-live-hint'));

    // Stream key. Hidden until asked for, and never offered on a paired device.
    if (!isRemote) {
      const kr = el('div', 'ytl-keyrow');
      const kl = el('span', 'ytl-key-ico'); kl.innerHTML = ICONS.key;     // static, trusted SVG
      const kv = el('code', 'ytl-key-val', '••••••••••••••••');
      const show = el('button', 'ytl-mini ytl-key-show', t('ytl_key_show', 'Show'));
      show.type = 'button';
      show.addEventListener('click', async () => {
        if (key) { key = null; paintActions(); return; }
        const r = await api('/stream/youtube/streamkey');
        if (!r || !r.ok) { showErr(show, errText(r)); return; }
        key = { url: String(r.url || ''), key: String(r.key || '') };
        paintActions();
      });
      const cp = el('button', 'ytl-mini ytl-key-copy', t('ytl_copy', 'Copy'));
      cp.type = 'button';
      cp.addEventListener('click', async () => {
        if (!key) return;
        const done = await copyText(key.key);
        flash(cp, done ? t('ytl_copied', 'Copied') : t('ytl_err_generic', 'That did not work'));
      });
      kr.append(kl, kv, show, cp);
      card.appendChild(kr);
      card.appendChild(el('div', 'ytl-hint ytl-key-hint', t('ytl_key_pconly', 'Only visible on the PC')));
    }
    return card;
  }

  function buildChatCard() {
    const card = el('section', 'ytl-card ytl-card--chat');
    card.dataset.systemCard = 'chat'; card.dataset.systemCardGroup = 'youtubelive';
    card.appendChild(el('div', 'ytl-chat-list'));
    const row = el('div', 'ytl-chat-row');
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'ytl-input ytl-chat-input'; inp.maxLength = 200;
    const send = el('button', 'ytl-chat-send'); send.type = 'button';
    send.innerHTML = ICONS.send;                                          // static, trusted SVG
    send.setAttribute('aria-label', t('ytl_chat_ph', 'Write in chat'));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(inp, send); });
    send.addEventListener('click', () => sendChat(inp, send));
    row.append(inp, send);
    card.appendChild(row);
    return card;
  }

  // A short label swap on a button, used for "Copied". Restores whatever the
  // button said before, so it survives a language change mid-flash.
  function flash(btn, msg) {
    const lbl = btn.querySelector('.ytl-btn-lbl') || btn;
    const was = lbl.textContent;
    const title = btn.title;
    lbl.textContent = msg; btn.title = msg;
    clearTimeout(btn._ytlFlash);
    btn._ytlFlash = setTimeout(() => { lbl.textContent = was; btn.title = title; }, 1600);
  }

  // The public watch URL of the current broadcast. Built from the id the server
  // reported and checked before it becomes a link, like every other URL the
  // dashboard builds from data it did not write.
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,24}$/;
  function watchUrl() {
    const id = bc && bc.id;
    return VIDEO_ID_RE.test(String(id || '')) ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(id) : '';
  }

  // ── Painting ──────────────────────────────────────────────────────────────
  function eachMount(fn) {
    tiles().forEach(tile => {
      const mount = tile.querySelector('.youtubelive-widget-mount');
      if (!mount) return;
      ensure(mount);
      fn(mount, tile);
    });
  }

  // A title row that becomes an inline editor on tap. Same shape the YouTube
  // widget used, kept here because this is now where the title lives.
  function buildTitle(text) {
    const row = el('div', 'ytl-title');
    const span = el('span', 'ytl-title-text', text);
    span.title = t('youtube_edit_title', 'Click to edit the title');
    span.addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'ytl-input'; inp.value = text; inp.maxLength = 100;
      let done = false;
      const commit = async (save) => {
        if (done) return; done = true;
        if (save && inp.value.trim() && inp.value.trim() !== text) {
          await post('/stream/youtube/title', { title: inp.value.trim() });
          bc = null;
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

  function buildInfo() {
    const box = el('div', 'ytl-info');
    if (connected === false) { box.appendChild(el('div', 'ytl-notice', t('youtube_not_connected', 'Connect in Settings'))); return box; }
    if (connected === null) { box.appendChild(el('div', 'ytl-notice', t('browser_loading', 'Loading…'))); return box; }
    if (!hasBroadcast()) { box.appendChild(el('div', 'ytl-notice', t('ytl_no_broadcast', 'No live scheduled'))); return box; }
    if (live()) {
      const v = el('div', 'ytl-viewers');
      v.append(
        el('span', 'ytl-viewers-num', String(bc.viewers != null ? bc.viewers : '—')),
        el('span', 'ytl-viewers-label', t('twitch_viewers', 'viewers')),
      );
      box.appendChild(v);
      const bits = [];
      if (bc.totalViews != null) bits.push(bc.totalViews.toLocaleString() + ' ' + t('youtube_views', 'views'));
      if (bc.likes != null) bits.push(bc.likes.toLocaleString() + ' ' + t('youtube_likes', 'likes'));
      if (bits.length) box.appendChild(el('div', 'ytl-stats', bits.join(' · ')));
    }
    if (bc.title) box.appendChild(buildTitle(bc.title));
    if (bc.health && HEALTH_KEY[bc.health]) {
      const h = el('div', 'ytl-health ytl-health-' + bc.health);
      h.append(el('span', 'ytl-health-dot'), el('span', null, t('youtube_health', 'Stream') + ': ' + t(HEALTH_KEY[bc.health], bc.health)));
      box.appendChild(h);
    }
    return box;
  }

  function paintActions() {
    eachMount(mount => {
      const card = mount.querySelector('.ytl-card--actions');
      if (!card) return;
      const editing = document.body.classList.contains('layout-editing');
      card.style.display = (connected !== false || editing) ? '' : 'none';
      card.querySelector('.ytl-card-label').textContent = t('layout_card_actions', 'Actions');

      const has = hasBroadcast();
      const isLive = live();
      // Two states, and only one of them on screen: with no broadcast the card is
      // "make one", with a broadcast it is "run it".
      card.querySelector('.ytl-make').style.display = has ? 'none' : '';
      card.querySelector('.ytl-live-row').style.display = has ? '' : 'none';

      const ti = card.querySelector('.ytl-make-title');
      ti.placeholder = t('ytl_title_ph', 'Title of the live');
      if (document.activeElement !== ti) ti.value = draft.title;
      const mk = card.querySelector('.ytl-make-go');
      mk.querySelector('.ytl-btn-lbl').textContent = t('ytl_create', 'Create a live');
      mk.disabled = !!busy || connected !== true;
      card.querySelector('.ytl-make-hint').textContent = t('ytl_create_hint', 'It starts on its own when OBS begins sending');

      // The privacy pills set the new broadcast's visibility before it exists and
      // change the real one after, so they read from whichever is in play.
      const current = has ? (bc.privacy || '') : draft.privacy;
      card.querySelectorAll('.ytl-priv').forEach(b => {
        const p = b.dataset.ytlPriv;
        b.textContent = t(PRIVACY_KEY[p], p);
        b.classList.toggle('is-on', p === current);
      });

      const go = card.querySelector('.ytl-go');
      go.classList.toggle('is-live', isLive);
      go.querySelector('.ytl-btn-ico').innerHTML = isLive ? ICONS.stop : ICONS.golive;   // static, trusted SVG
      go.querySelector('.ytl-btn-lbl').textContent = isLive ? t('twitch_endstream', 'End stream') : t('twitch_golive', 'Go live');
      go.disabled = !!busy;
      const cancel = card.querySelector('.ytl-cancel');
      // Cancelling is throwing the broadcast away, which YouTube refuses once it
      // is live and we refuse here too rather than offering a button that errors.
      cancel.style.display = (has && !isLive) ? '' : 'none';
      cancel.disabled = !!busy;
      card.querySelector('.ytl-link').disabled = !watchUrl();
      // Waiting for the encoder is the normal state right after creating a live,
      // so it is stated rather than left as a button that refuses.
      const hint = card.querySelector('.ytl-live-hint');
      hint.textContent = (has && !isLive) ? t('ytl_waiting', 'Waiting for OBS') : '';
      hint.style.display = hint.textContent ? '' : 'none';

      const kv = card.querySelector('.ytl-key-val');
      if (kv) {
        kv.textContent = key ? (key.key || '—') : '••••••••••••••••';
        card.querySelector('.ytl-key-show').textContent = key ? t('ytl_key_hide', 'Hide') : t('ytl_key_show', 'Show');
        card.querySelector('.ytl-key-copy').disabled = !key;
        card.querySelector('.ytl-key-hint').textContent = t('ytl_key_pconly', 'Only visible on the PC');
      }
    });
  }

  function paintChat() {
    eachMount(mount => {
      const card = mount.querySelector('.ytl-card--chat');
      if (!card) return;
      const editing = document.body.classList.contains('layout-editing');
      card.style.display = (connected !== false || editing) ? '' : 'none';
      const list = card.querySelector('.ytl-chat-list');
      const inp = card.querySelector('.ytl-chat-input');
      inp.placeholder = t('ytl_chat_ph', 'Write in chat');
      const canSend = live() && !!bc.chat;
      inp.disabled = !canSend;
      card.querySelector('.ytl-chat-send').disabled = !canSend;

      if (!canSend && !chat.items.length) {
        list.replaceChildren(el('div', 'ytl-chat-note', t('ytl_chat_wait', 'Chat starts when you go live')));
        return;
      }
      if (!chat.items.length) {
        list.replaceChildren(el('div', 'ytl-chat-note', chat.error ? errText({ error: chat.error }) : t('ytl_chat_empty', 'No messages yet')));
        return;
      }
      // Only the new tail is appended: rebuilding the list every few seconds would
      // throw away the scroll position of anyone reading back through it.
      const have = list.querySelectorAll('.ytl-msg').length;
      if (list.querySelector('.ytl-chat-note')) { list.replaceChildren(); }
      const start = list.querySelectorAll('.ytl-msg').length ? have : 0;
      const stuck = list.scrollTop + list.clientHeight >= list.scrollHeight - 24;
      const frag = document.createDocumentFragment();
      for (let i = start; i < chat.items.length; i++) frag.appendChild(msgRow(chat.items[i]));
      if (frag.childNodes.length) list.appendChild(frag);
      while (list.childElementCount > CHAT_MAX) list.removeChild(list.firstChild);
      if (stuck) list.scrollTop = list.scrollHeight;
    });
  }

  function msgRow(m) {
    const row = el('div', 'ytl-msg');
    const av = el('span', 'ytl-msg-av');
    if (m.avatar) av.style.backgroundImage = 'url("' + encodeURI(m.avatar) + '")';
    const body = el('div', 'ytl-msg-body');
    const who = el('span', 'ytl-msg-who', m.author || '—');
    if (m.owner) who.classList.add('is-owner');
    else if (m.moderator) who.classList.add('is-mod');
    else if (m.sponsor) who.classList.add('is-sponsor');
    body.append(who, el('span', 'ytl-msg-text', m.text || ''));
    row.append(av, body);
    return row;
  }

  function paint() {
    eachMount(mount => {
      const isLive = live();
      const pill = mount.querySelector('.ytl-pill');
      pill.classList.toggle('live', isLive);
      mount.querySelector('.ytl-pill-txt').textContent = isLive ? 'LIVE' : t('youtube_offline', 'Offline');
      const info = mount.querySelector('.ytl-card--info');
      const editing = document.body.classList.contains('layout-editing');
      info.style.display = (connected !== false || editing) ? '' : 'none';
      info.replaceChildren(buildInfo());
      const setup = mount.querySelector('.ytl-setup');
      // Only a definite "no account": while the check is still out the cards are
      // on screen and saying "connect" would be a guess.
      if (setup) {
        setup.hidden = connected !== false;
        setup.querySelector('.ytl-setup-txt').textContent = t('youtube_w_setup', 'Connect your YouTube account in Settings → Streaming');
      }
    });
    paintActions();
    paintChat();
  }

  async function refresh() {
    if (!tiles().length) { stop(); return; }
    // Same split the YouTube widget uses: the connection check reads our own token
    // store and costs no quota, so it always runs — without it the tile has no
    // idea what to draw. The broadcast read below is the one that costs.
    const s = await api('/stream/youtube/status');
    const was = connected;
    if (s) connected = !!s.connected;
    const seen = !document.hidden && tiles().some(onVisiblePage);
    if (connected && seen) {
      const b = await api('/stream/youtube/broadcast');
      if (b) {
        const wasLive = live();
        bc = b;
        // A new stream is a new chat. Keeping the old messages would show the
        // previous broadcast's chat under this one's.
        if (!live() || (!wasLive && live())) resetChat();
      }
    } else if (connected === false && was !== false) {
      bc = null; key = null; resetChat();
    }
    paint();
    publishBroadcast();
    if (chatWanted() && !chatTimer) scheduleChat(1000);
  }

  // ── SDK bridge ────────────────────────────────────────────────────────────
  // Hand the SDK host the broadcast state this tile has already read. Reading it
  // is the one thing here that costs YouTube quota, so a widget granted
  // `youtubeLive` costs nothing extra while this tile is on the dashboard; the
  // host's own loader is the fallback for a dashboard without it. The chat is
  // deliberately NOT published: it is the user's own broadcast chat, it costs
  // quota per read, and no widget has asked for it.
  function publishBroadcast() {
    try {
      if (!window.CustomWidget || typeof CustomWidget.publishStream !== 'function') return;
      // The host cuts the payload down to the fields a widget may see — publishing
      // `bc` verbatim is not a wider grant, it is the same one shape.
      CustomWidget.publishStream('youtubeLive', connected === false
        ? { ok: false, error: 'not_connected', live: false }
        : (bc || { ok: true, live: false }));
    } catch { /* the SDK host is optional — never let it break the tile */ }
  }

  function stop() {
    if (poll) { clearInterval(poll); poll = null; }
    clearTimeout(chatTimer); chatTimer = null;
  }

  function renderWidgets() {
    if (!tiles().length) { stop(); return; }
    paint();
    if (!poll) { refresh(); poll = setInterval(refresh, POLL_MS); }
  }

  window.YouTubeLiveWidget = { renderWidgets };
})();
