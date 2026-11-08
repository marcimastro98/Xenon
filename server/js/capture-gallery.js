'use strict';
// The gallery of what Xenon captured: screenshots, recordings and Instant
// Replay clips, newest first, grouped by day, over the whole screen in the
// Store's frame: the kinds and the games in the rail, the pictures beside it.
// A tap opens the viewer (js/capture-gallery-viewer.js: play, trim, copy, show
// in the folder, delete; a paired phone plays and downloads).
//
// The server sends ids and names only (GET /captures); previews and files come
// by id (/captures/thumb, /captures/file). Opened from the Deck key, Xenon AI
// (SSE `gallery_open`), Settings → Capture and the "saved" toasts; refreshed by
// SSE `captures` (deleted or trimmed anywhere) and `capture` (a new one).
(function () {
  const M = window.CaptureGalleryModel;
  const PAGE = 60;
  const PLACEHOLDERS = 8;
  const KIND_ROWS = {
    '': ['capg_filter_all', 'All', 'gallery'],
    video: ['capg_filter_video', 'Videos', 'video'],
    screenshot: ['capg_filter_shot', 'Screenshots', 'screenshot'],
  };

  const tr = (k, fb) => {
    const v = typeof window.t === 'function' ? window.t(k) : k;
    return v === k && fb != null ? fb : v;
  };
  const el = makeEl;

  // Static, trusted markup only (same stroke set as the Store's icons).
  const S0 = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const ICONS = {
    gallery: S0 + '<rect x="3" y="5" width="14" height="12" rx="2"/><path d="M7 21h12a2 2 0 0 0 2-2V9"/><path d="M3 14l3.5-3.5a1.5 1.5 0 0 1 2 0L13 15"/><circle cx="12.5" cy="9" r="1.3"/></svg>',
    close: S0 + '<path d="M6 6l12 12M18 6L6 18"/></svg>',
    video: S0 + '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10.5l5-3v9l-5-3z"/></svg>',
    screenshot: S0 + '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/></svg>',
  };
  function icon(name, cls) {
    const s = el('span', 'cgal-ic' + (cls ? ' ' + cls : ''));
    s.innerHTML = ICONS[name] || ICONS.gallery; // static constant markup only
    return s;
  }

  // One open gallery: what it shows and where its parts are.
  let g = null;

  const url = (p) => (typeof SERVER === 'string' ? SERVER : '') + p;
  const thumbUrl = (id) => url('/captures/thumb?id=' + encodeURIComponent(id));

  async function fetchPage(before) {
    const q = new URLSearchParams({ limit: String(PAGE) });
    if (g.filter) q.set('kind', g.filter);
    if (g.game) q.set('game', g.game);
    if (before) q.set('before', String(before));
    return apiJson(url('/captures?' + q));
  }

  function kindLabel(e) {
    if (e.kind === 'gif') return 'GIF'; // the format's name in every language
    return e.kind === 'screenshot' ? tr('capg_kind_screenshot', 'Screenshot')
      : e.kind === 'replay' ? tr('capg_kind_replay', 'Replay') : tr('capg_kind_recording', 'Recording');
  }

  function timeOf(ms) {
    try { return new Date(ms).toLocaleTimeString([], timeParts()); } catch { return ''; }
  }

  function dayTitle(group) {
    if (group.when === 'today') return tr('capg_today', 'Today');
    if (group.when === 'yesterday') return tr('capg_yesterday', 'Yesterday');
    try {
      const day = new Date(group.at).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
      return day.charAt(0).toLocaleUpperCase() + day.slice(1);
    } catch { return group.key; }
  }

  function tile(e) {
    const b = el('button', 'capg-tile');
    b.type = 'button';
    b.dataset.id = e.id;
    const media = el('span', 'capg-thumb');
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    // No preview (engine absent, file not decodable): the kind's icon instead.
    img.addEventListener('error', () => img.replaceWith(icon(M.isVideo(e) ? 'video' : 'screenshot', 'capg-thumb-ic')), { once: true });
    img.src = thumbUrl(e.id);
    media.appendChild(img);
    if (M.isVideo(e) && e.seconds) media.appendChild(el('span', 'capg-len', M.stamp(e.seconds)));
    b.appendChild(media);
    const meta = el('span', 'capg-meta');
    meta.appendChild(el('span', 'capg-game', M.gameLabel(e.game) || tr('capg_desktop', 'Desktop')));
    meta.appendChild(el('span', 'capg-when', kindLabel(e) + ', ' + timeOf(e.createdAt)));
    b.appendChild(meta);
    b.title = e.name || '';
    b.addEventListener('click', () => openViewer(e.id));
    return b;
  }

  function key(text, onClick, cls) {
    const b = el('button', 'capg-key' + (cls ? ' ' + cls : ''), text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // A line in the middle of the page, with at most one key under it.
  function status(text, act) {
    const box = el('div', 'cgal-status capg-status', text);
    if (act) box.appendChild(act);
    return box;
  }

  function emptyState() {
    if (g.filter || g.game) return status(tr('capg_empty_filter', 'Nothing here with this filter.'));
    const text = tr('capg_empty', 'Nothing yet. Screenshots, recordings and replays you save land here.');
    if (window.__xenonRemote || typeof window.openSettings !== 'function') return status(text);
    // Settings first: a sheet window leaves as soon as nothing is showing.
    return status(text, key(tr('capg_open_settings', 'Open settings'), () => { window.openSettings('capture'); close(); }));
  }

  // The page's shape until the first answer comes.
  function placeholders() {
    const grid = el('div', 'capg-grid');
    grid.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < PLACEHOLDERS; i += 1) grid.appendChild(el('span', 'capg-thumb'));
    return grid;
  }

  function paintGrid() {
    const body = g.body;
    body.replaceChildren();
    if (!g.entries.length) { body.appendChild(emptyState()); return; }
    for (const group of M.groupByDay(g.entries, Date.now())) {
      const section = el('section', 'capg-day');
      section.appendChild(el('h4', 'capg-day-title', dayTitle(group)));
      const grid = el('div', 'capg-grid');
      group.items.forEach(e => grid.appendChild(tile(e)));
      section.appendChild(grid);
      body.appendChild(section);
    }
    if (g.more) body.appendChild(key(tr('capg_more', 'Show more'), loadMore, 'capg-more'));
  }

  function focusTile(id) {
    const shown = [...g.body.querySelectorAll('.capg-tile')].find(b => b.dataset.id === id);
    // The browser shows the ring on the picture only when the keys brought the person back.
    if (shown) shown.focus();
    else g.modal.focus({ focusVisible: false });
  }

  function railRow(name, on, pick, iconName, count) {
    const row = el('button', 'cst-railrow');
    row.type = 'button';
    if (iconName) row.appendChild(icon(iconName));
    row.appendChild(el('span', 'cst-railrow-name', name));
    if (count != null) row.appendChild(el('b', 'cst-railrow-count', String(count)));
    row.addEventListener('click', pick);
    markRow(row, on);
    return row;
  }

  function markRow(row, on) {
    row.classList.toggle('on', on);
    row.setAttribute('aria-pressed', String(on));
  }

  function setFilter(f) {
    if (g.filter === f) return;
    g.filter = f;
    [...g.kinds.children].forEach(row => markRow(row, row.dataset.filter === f));
    reload();
  }

  function setGame(label) {
    if (g.game === label) return;
    g.game = label;
    [...g.games.children].forEach(row => markRow(row, row.dataset.game === label));
    reload();
  }

  function kindRow(f) {
    const [k, fb, iconName] = KIND_ROWS[f];
    const row = railRow(tr(k, fb), f === g.filter, () => setFilter(f), iconName);
    row.dataset.filter = f;
    return row;
  }

  function gameRow(label, name, count) {
    const row = railRow(name, label === g.game, () => setGame(label), '', count);
    row.dataset.game = label;
    return row;
  }

  // A choice of game only when there is one to make. Rows are rebuilt only when
  // they changed, so one with the focus keeps the keyboard.
  function paintGames(games) {
    g.games.hidden = games.length < 2 && !g.game;
    const shown = games.map(x => x.label + '\n' + x.count).join('\n');
    if (shown === g.gamesShown) return;
    g.gamesShown = shown;
    g.games.replaceChildren(gameRow('', tr('capg_game_all', 'All games')),
      ...games.map(x => gameRow(x.label, x.label === 'Desktop' ? tr('capg_desktop', 'Desktop') : x.label, x.count)));
  }

  function paintRail(r) {
    if (r.usedBytes != null && typeof formatBytes === 'function') {
      const used = Number(r.usedBytes) || 0;
      g.used.textContent = used ? tr('capg_sub', '{size} in all').replace('{size}', formatBytes(used)) : '';
    }
    if (Array.isArray(r.games)) paintGames(r.games.filter(x => x && typeof x.label === 'string'));
  }

  async function reload() {
    if (!g) return;
    const mine = g;
    const r = await fetchPage(0);
    if (g !== mine) return;
    if (!r || r.ok !== true) {
      g.body.replaceChildren(status(tr('capg_error', 'The gallery did not load.'), key(tr('capg_retry', 'Try again'), () => reload())));
      return;
    }
    g.entries = Array.isArray(r.entries) ? r.entries : [];
    g.more = r.more === true;
    g.editable = r.editable === true;
    g.pinnable = r.pinnable === true;
    g.sendable = r.sendable === true;
    g.can = engineCan(r.can);
    paintRail(r);
    paintGrid();
    if (g.viewer) g.viewer.sync(g.entries);
  }

  async function loadMore() {
    const last = g.entries[g.entries.length - 1];
    if (!last) return;
    const mine = g;
    const r = await fetchPage(last.createdAt);
    if (g !== mine || !r || r.ok !== true) return;
    const fresh = Array.isArray(r.entries) ? r.entries : [];
    g.entries = g.entries.concat(fresh);
    g.more = r.more === true;
    const top = g.body.scrollTop;
    paintGrid();
    g.body.scrollTop = top;
    // The key that was pressed is gone: the keyboard goes on from the first new picture.
    if (fresh[0]) focusTile(fresh[0].id);
  }

  function rail() {
    const aside = el('aside', 'cst-rail');
    aside.appendChild(el('div', 'cst-rail-top')).appendChild(el('h3', 'cst-rail-title', tr('capg_title', 'Gallery')));
    g.kinds = aside.appendChild(el('nav', 'cst-rail-list'));
    g.kinds.setAttribute('aria-label', tr('capg_title', 'Gallery'));
    M.FILTERS.forEach(f => g.kinds.appendChild(kindRow(f)));
    g.games = aside.appendChild(el('nav', 'cst-rail-list capg-games'));
    g.games.setAttribute('aria-label', tr('capg_game_all', 'All games'));
    g.games.hidden = true;
    g.used = aside.appendChild(el('div', 'capg-rail-used'));
    return aside;
  }

  function closeKey() {
    const x = el('button', 'cst-close');
    x.type = 'button';
    x.title = tr('capg_close', 'Close');
    x.setAttribute('aria-label', x.title);
    x.appendChild(icon('close'));
    x.addEventListener('click', close);
    return x;
  }

  // A reply without `can` (an older server) keeps every button, as before.
  function engineCan(c) {
    const o = c && typeof c === 'object' ? c : {};
    return {
      export: o.export !== false, cover: o.cover !== false, speech: o.speech !== false,
      trim: o.trim !== false, copy: o.copy !== false,
    };
  }

  function openViewer(id, note) {
    if (!window.CaptureGalleryViewer || !g) return;
    if (g.viewer) g.viewer.close();
    g.viewer = window.CaptureGalleryViewer.open({
      host: g.modal, entries: g.entries, id,
      editable: g.editable,
      pinnable: g.pinnable === true && !window.__xenonRemote,
      sendable: g.sendable === true && !window.__xenonRemote,
      can: g.can,
      remote: !!window.__xenonRemote,
      kindLabel, timeOf, url, note,
      // Bit writes chapters in the chat, which the gallery covers: it closes first.
      askBit: !window.__xenonRemote && typeof window.aiAsk === 'function'
        ? (text) => { close(); window.aiAsk(text); } : null,
      onClose: (shown) => { if (g) { g.viewer = null; focusTile(shown); } },
      onChanged: (focusId, line) => reload().then(() => { if (focusId && g) openViewer(focusId, line); }),
    });
  }

  function close() {
    if (!g) return;
    if (g.viewer) g.viewer.close();
    g.letGo();
    g.overlay.remove();
    g = null;
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('capture-gallery', false);
  }

  // `opts.id` opens the viewer on that capture once the list is in;
  // `opts.filter` starts on '', 'video' or 'screenshot'.
  async function open(opts) {
    const o = opts || {};
    if (typeof isLayerPage === 'function' && isLayerPage() && !isSheetPage()) return;
    close();
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('capture-gallery', true);
    const overlay = el('div', 'preset-modal-overlay cgal-overlay cst-overlay capg-overlay');
    const modal = el('div', 'preset-modal cgal-modal cst capg-modal');
    modal.tabIndex = -1;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', tr('capg_title', 'Gallery'));
    g = { overlay, modal, entries: [], more: false, editable: false, pinnable: false, can: engineCan(null), viewer: null, game: '', gamesShown: '', filter: M.FILTERS.includes(o.filter) ? o.filter : '' };

    const aside = rail();
    g.body = el('div', 'cgal-scroll cst-main');
    g.body.appendChild(placeholders());
    modal.append(aside, g.body, closeKey());
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    g.letGo = window.DialogFocus.hold(modal, { onEsc: close });
    await reload();
    if (o.id && g && g.entries.some(e => e.id === o.id)) openViewer(o.id);
  }

  // SSE: something changed on the server (a delete, a trim, a new capture).
  function changed() { if (g && !(g.viewer && g.viewer.busy())) reload(); }

  // SSE `transcript` (progress and the end of a video's transcription): the
  // open viewer's panel shows it; a finished one marks the video in the list.
  function onTranscript(ev) {
    if (!g) return;
    if (g.viewer) g.viewer.onTranscript(ev);
    if (ev && ev.state === 'done') changed();
  }

  // SSE `capture_export` (progress and the end of a copy being made).
  function onExport(ev) {
    if (g && g.viewer) g.viewer.onExport(ev);
  }

  window.CaptureGallery = { open, close, changed, onTranscript, onExport, isOpen: () => !!g };
})();
