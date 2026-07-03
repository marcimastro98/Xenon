'use strict';
// Streamer.bot dashboard widget: a live activity feed (follows, subs, raids, cheers,
// channel-point redemptions, hype trains, YouTube members…) plus a live view of your
// Streamer.bot global variables. Read-only — the Deck owns the actions.
//
// EVENT-DRIVEN: the server keeps ONE subscription open (only while a dashboard is on
// screen + Streamer.bot is configured) and pushes each event over SSE
// (event: 'streamerbot_event') and connection/globals over 'streamerbot'. The widget
// fetches a seed once on mount (GET /streamerbot/activity) and then idles until
// something actually happens — near-zero cost at rest. Renders into
// .streamerbot-widget-mount.
(function () {
  const S = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const ICONS = {
    logo: S('<path d="M12 3l7 4v10l-7 4-7-4V7z"/><path d="M12 3v18M5 7l7 4 7-4"/>'),
    follow: S('<path d="M12 21s-7-4.5-9.5-9A5 5 0 0 1 12 6a5 5 0 0 1 9.5 6C19 16.5 12 21 12 21z"/>'),
    sub: S('<path d="m12 3 2.9 6 6.1.5-4.6 4 1.4 6L12 16.8 6.2 19.5l1.4-6L3 9.5 9.1 9z"/>'),
    gift: S('<rect x="3" y="8" width="18" height="4"/><path d="M5 12v9h14v-9M12 8v13M12 8S9 3 6.5 4.5 8 8 12 8zM12 8s3-5 5.5-3.5S16 8 12 8z"/>'),
    cheer: S('<path d="M13 2 4 14h6l-1 8 9-12h-6z"/>'),
    raid: S('<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 6a3 3 0 0 1 0 6M21 20a6 6 0 0 0-5-5.9"/>'),
    reward: S('<path d="m12 3 3 6 6 .5-4.5 4L18 20l-6-3.3L6 20l1.5-6.5L3 9.5 9 9z"/>'),
    live: S('<circle cx="12" cy="12" r="4"/><path d="M6.3 6.3a8 8 0 0 0 0 11.4M17.7 6.3a8 8 0 0 1 0 11.4"/>'),
    announce: S('<path d="M3 11v2l4 1 2 5h2l-1-4 9 2V6l-9 2-4 .5z"/><path d="M19 8a4 4 0 0 1 0 8"/>'),
    hype: S('<path d="M12 3c1 3-1 4-1 6a3 3 0 0 0 6 0c0-1 0-2-1-3 3 2 5 5 5 9a9 9 0 0 1-18 0c0-3 2-6 5-8 0 2 1 3 2 3-1-3 1-5 2-6z"/>'),
    spark: S('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/>'),
  };
  // Event type → { icon, cat, unit } — cat drives the accent colour class, unit
  // labels the amount chip. Unknown types fall back to a generic spark.
  const EVT = {
    Follow: { icon: 'follow', cat: 'follow' },
    Sub: { icon: 'sub', cat: 'sub', unit: 'mo' }, ReSub: { icon: 'sub', cat: 'sub', unit: 'mo' },
    GiftSub: { icon: 'gift', cat: 'gift' }, GiftBomb: { icon: 'gift', cat: 'gift' },
    Cheer: { icon: 'cheer', cat: 'cheer', unit: 'bits' },
    Raid: { icon: 'raid', cat: 'raid', unit: 'viewers' },
    RewardRedemption: { icon: 'reward', cat: 'reward' },
    StreamOnline: { icon: 'live', cat: 'live' }, StreamOffline: { icon: 'live', cat: 'off' },
    Announcement: { icon: 'announce', cat: 'announce' },
    HypeTrainStart: { icon: 'hype', cat: 'hype' }, HypeTrainEnd: { icon: 'hype', cat: 'hype' },
    NewSubscriber: { icon: 'sub', cat: 'sub' }, NewSponsor: { icon: 'sub', cat: 'sub' },
    SuperChat: { icon: 'cheer', cat: 'cheer' }, SuperSticker: { icon: 'cheer', cat: 'cheer' },
    MembershipGift: { icon: 'gift', cat: 'gift' }, GiftMembershipReceived: { icon: 'gift', cat: 'gift' },
    MemberMileStone: { icon: 'sub', cat: 'sub', unit: 'mo' },
  };
  const EVT_MAX = 40;

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;   // shared DOM factory from utils.js
  const api = apiJson; // shared fetch-JSON helper from utils.js

  const TABS = [
    { id: 'activity', labelKey: 'sbw_tab_activity', fb: 'Activity' },
    { id: 'globals', labelKey: 'sbw_tab_globals', fb: 'Globals' },
  ];
  let activeTab = 'activity';

  let configured = null;   // null = unknown
  let connected = false;
  let globals = {};
  let events = [];         // most-recent first, capped EVT_MAX
  let seeded = false;

  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="streamerbot"]')).filter(el => el.closest('.pager-page')); }

  function openStreamingSettings() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay && overlay.hidden && typeof window.toggleSettings === 'function') window.toggleSettings();
    if (typeof window.settingsSetCategory === 'function') window.settingsSetCategory('streaming');
  }

  // "RewardRedemption" → "Reward Redemption"; keeps acronyms readable enough.
  function humanizeType(type) {
    return String(type || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim();
  }

  // Short relative age: "now", "3m", "2h", "1d". The browser owns the clock.
  function fmtAge(at) {
    const s = Math.max(0, Math.floor((Date.now() - (at || 0)) / 1000));
    if (s < 10) return t('sbw_now', 'now');
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  function ensure(mount) {
    if (mount.dataset.sbBuilt === '1' && mount.firstChild) return;
    mount.dataset.sbBuilt = '1';
    const wrap = el('div', 'sbw-wrap');

    const head = el('div', 'sbw-head');
    const brand = el('div', 'sbw-brand');
    const logo = el('span', 'sbw-logo'); logo.innerHTML = ICONS.logo;   // static, trusted SVG
    brand.append(logo, el('span', 'sbw-title', 'Streamer.bot'));
    const pill = el('span', 'sbw-pill');
    pill.append(el('span', 'sbw-pill-dot'), el('span', 'sbw-pill-txt'));
    head.append(brand, pill);
    wrap.appendChild(head);

    const notice = el('button', 'sbw-notice'); notice.type = 'button'; notice.hidden = true;
    const nIco = el('span', 'sbw-notice-ico'); nIco.innerHTML = ICONS.logo;   // static, trusted SVG
    notice.append(nIco, el('span', 'sbw-notice-txt', t('sbw_setup', 'Connect Streamer.bot in Settings → Streaming')));
    notice.addEventListener('click', openStreamingSettings);
    wrap.appendChild(notice);

    const tabs = el('div', 'sbw-tabs');
    TABS.forEach(tb => {
      const b = el('button', 'sbw-tab', t(tb.labelKey, tb.fb));
      b.type = 'button'; b.dataset.stab = tb.id;
      b.addEventListener('click', () => { activeTab = tb.id; paint(); });
      tabs.appendChild(b);
    });
    wrap.appendChild(tabs);

    const body = el('div', 'sbw-body');
    const pAct = el('div', 'sbw-panel sbw-panel--activity'); pAct.dataset.stab = 'activity';
    pAct.appendChild(el('div', 'sbw-feed'));
    body.appendChild(pAct);
    const pGlob = el('div', 'sbw-panel sbw-panel--globals'); pGlob.dataset.stab = 'globals';
    pGlob.appendChild(el('div', 'sbw-globals'));
    body.appendChild(pGlob);
    wrap.appendChild(body);

    mount.replaceChildren(wrap);
  }

  function applyLabels(mount) {
    mount.querySelectorAll('.sbw-tab').forEach(tb => {
      const def = TABS.find(x => x.id === tb.dataset.stab);
      if (def) tb.textContent = t(def.labelKey, def.fb);
    });
    const nTxt = mount.querySelector('.sbw-notice-txt');
    if (nTxt) nTxt.textContent = t('sbw_setup', 'Connect Streamer.bot in Settings → Streaming');
  }

  // Build one feed row. All event fields are untrusted → textContent (via el), never
  // innerHTML; the icon is a static library SVG chosen by the (validated) type.
  function feedRow(item) {
    const def = EVT[item.type] || { icon: 'spark', cat: 'other' };
    const row = el('div', 'sbw-evt sbw-evt--' + def.cat);
    const ico = el('span', 'sbw-evt-ico'); ico.innerHTML = ICONS[def.icon] || ICONS.spark;   // static SVG
    row.appendChild(ico);
    const main = el('div', 'sbw-evt-main');
    const line = el('div', 'sbw-evt-line');
    if (item.user) line.appendChild(el('span', 'sbw-evt-user', item.user));
    line.appendChild(el('span', 'sbw-evt-type', humanizeType(item.type)));
    if (item.amount != null) line.appendChild(el('span', 'sbw-evt-amt', String(item.amount) + (def.unit ? ' ' + def.unit : '')));
    main.appendChild(line);
    if (item.text) main.appendChild(el('div', 'sbw-evt-text', item.text));
    row.appendChild(main);
    const age = el('time', 'sbw-evt-age', fmtAge(item.at)); age.dataset.at = String(item.at || 0);
    row.appendChild(age);
    return row;
  }

  function paintFeed(mount) {
    const feed = mount.querySelector('.sbw-feed');
    if (!feed) return;
    if (!events.length) {
      const msg = configured === false ? t('sbw_setup_short', 'Not connected')
        : !connected ? t('sbw_offline_hint', 'Streamer.bot isn\'t reachable — open it and start Servers/Clients → WebSocket Server (it reconnects on its own).')
          : t('sbw_waiting', 'Waiting for events…');
      feed.replaceChildren(el('div', 'sbw-empty', msg));
      return;
    }
    const frag = document.createDocumentFragment();
    events.forEach(item => frag.appendChild(feedRow(item)));
    feed.replaceChildren(frag);
  }

  function paintGlobals(mount) {
    const box = mount.querySelector('.sbw-globals');
    if (!box) return;
    const names = Object.keys(globals).sort((a, b) => a.localeCompare(b));
    if (!names.length) {
      box.replaceChildren(el('div', 'sbw-empty', t('sbw_no_globals', 'No global variables')));
      return;
    }
    const frag = document.createDocumentFragment();
    names.forEach(name => {
      const g = el('div', 'sbw-global');
      g.append(el('span', 'sbw-global-name', name), el('span', 'sbw-global-val', String(globals[name])));
      frag.appendChild(g);
    });
    box.replaceChildren(frag);
  }

  function paint() {
    tiles().forEach(tile => {
      const mount = tile.querySelector('.streamerbot-widget-mount');
      if (!mount) return;
      ensure(mount);
      applyLabels(mount);
      const off = configured === false;
      mount.querySelector('.sbw-wrap').classList.toggle('sbw-off', off);
      const notice = mount.querySelector('.sbw-notice');
      if (notice) notice.hidden = !off;

      const pill = mount.querySelector('.sbw-pill');
      pill.classList.toggle('is-live', connected);
      mount.querySelector('.sbw-pill-txt').textContent =
        off ? t('sbw_setup_short', 'Not connected')
          : connected ? t('sbw_connected', 'Connected') : t('sbw_offline', 'Offline');

      mount.querySelectorAll('.sbw-tab').forEach(tb => tb.classList.toggle('is-active', tb.dataset.stab === activeTab));
      mount.querySelectorAll('.sbw-panel').forEach(p => { p.hidden = p.dataset.stab !== activeTab; });

      paintFeed(mount);
      paintGlobals(mount);
    });
  }

  async function seed() {
    if (!tiles().length) return;
    const d = await api('/streamerbot/activity');
    if (d && typeof d === 'object') {
      configured = !!d.configured;
      connected = !!d.connected;
      globals = (d.globals && typeof d.globals === 'object') ? d.globals : {};
      // recent is oldest→newest; the feed shows newest first.
      events = (Array.isArray(d.recent) ? d.recent.slice(-EVT_MAX) : []).reverse();
    }
    paint();
  }

  // SSE 'streamerbot' — connection + globals (shared with the Deck stateful keys).
  function onState(data) {
    if (!data || typeof data !== 'object') return;
    configured = !!data.configured;
    connected = !!data.connected;
    if (data.globals && typeof data.globals === 'object') globals = data.globals;
    paint();
  }

  // SSE 'streamerbot_event' — a single new activity item; prepend + cap.
  function onEvent(item) {
    if (!item || typeof item !== 'object') return;
    events.unshift(item);
    if (events.length > EVT_MAX) events = events.slice(0, EVT_MAX);
    paint();
  }

  function renderWidgets() {
    if (!tiles().length) { seeded = false; return; }
    paint();                                 // instant paint from cache
    if (!seeded) { seeded = true; seed(); }  // deduped across the multi-pass layout init
  }

  // Keep the relative ages fresh without re-fetching: retick visible rows each 30s
  // (only while a tile is placed and the page is visible — near-zero cost).
  setInterval(() => {
    if (document.hidden || !tiles().length) return;
    document.querySelectorAll('[data-dashboard-widget="streamerbot"] .sbw-evt-age').forEach(node => {
      node.textContent = fmtAge(Number(node.dataset.at) || 0);
    });
  }, 30000);

  window.StreamerbotWidget = { renderWidgets, onState, onEvent };
})();
