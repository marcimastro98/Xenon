'use strict';
// YouTube dashboard widget: live status + viewer count + stream health, with a
// Go live / End stream button. Two manageable sections (info / actions) tagged as
// dashboard cards (hide/reorder like the System panel). Polled (no SSE) and
// QUOTA-AWARE — only polls while a tile is visible and the tab is foregrounded,
// at a slow cadence. Actions go through /actions/run (ytBroadcast). Renders into
// .youtube-widget-mount.
(function () {
  const ICONS = {
    golive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    logo: '<svg viewBox="0 0 90 64" fill="none"><rect width="90" height="64" rx="18" fill="#ff0000"/><path d="M36 46V18l24 14z" fill="#0b0d10"/></svg>',
  };
  const HEALTH_KEY = { good: 'youtube_health_good', ok: 'youtube_health_ok', bad: 'youtube_health_bad', noData: 'youtube_health_nodata' };
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  // Only tiles actually placed on a dashboard page count. A hidden / never-added
  // widget sits in the #widget-pool (outside any .pager-page), so it must NOT
  // poll the YouTube API. Adding the widget moves it into a page → polling starts
  // on the next layout pass; removing it parks it back → polling stops.
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="youtube"]')).filter(el => el.closest('.pager-page')); }
  async function api(p, o) { try { const r = await fetch(p, o); return await r.json(); } catch { return null; } }

  let poll = null;
  let last = null;          // broadcastStatus result
  let connected = null;     // null=unknown
  const POLL_MS = 30000;    // slow on purpose (YouTube Data API quota)

  const ERR_KEY = { no_broadcast: 'youtube_err_no_broadcast', not_connected: 'youtube_err_not_connected' };
  function showActionErr(btn, reason) {
    const card = btn.closest('.yt-card--actions');
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
    cards.append(info, actions);
    wrap.appendChild(cards);
    mount.replaceChildren(wrap);
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
    });
  }

  async function refresh() {
    if (!tiles().length) { stop(); return; }
    if (document.hidden) return;
    const s = await api('/stream/youtube/status');
    if (s) connected = !!s.connected;
    if (connected) { const b = await api('/stream/youtube/broadcast'); if (b) last = b; }
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
