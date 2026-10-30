'use strict';
// The gallery of what Xenon captured: screenshots, recordings and Instant
// Replay clips, newest first, grouped by day, on the Store's overlay. A tap
// opens the viewer (js/capture-gallery-viewer.js: play, trim, copy, show in
// the folder, delete; a paired phone plays and downloads).
//
// The server sends ids and names only (GET /captures); previews and files come
// by id (/captures/thumb, /captures/file). Opened from the Deck key, Xenon AI
// (SSE `gallery_open`), Settings → Capture and the "saved" toasts; refreshed by
// SSE `captures` (deleted or trimmed anywhere) and `capture` (a new one).
(function () {
  const M = window.CaptureGalleryModel;
  const PAGE = 60;

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
    try { return new Date(group.at).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); } catch { return group.key; }
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

  function status(text, retry) {
    const box = el('div', 'cgal-status capg-status', text);
    if (retry) {
      const again = el('button', 'ui-btn ui-btn--secondary', tr('capg_retry', 'Try again'));
      again.type = 'button';
      again.addEventListener('click', () => reload());
      box.appendChild(el('div', 'capg-status-act')).appendChild(again);
    }
    return box;
  }

  function paintGrid() {
    const body = g.body;
    body.replaceChildren();
    if (!g.entries.length) {
      body.appendChild(status(g.filter || g.game
        ? tr('capg_empty_filter', 'Nothing here with this filter.')
        : tr('capg_empty', 'Nothing yet. Screenshots, recordings and replays you save land here.')));
      return;
    }
    for (const group of M.groupByDay(g.entries, Date.now())) {
      const section = el('section', 'capg-day');
      section.appendChild(el('h4', 'capg-day-title', dayTitle(group)));
      const grid = el('div', 'capg-grid');
      group.items.forEach(e => grid.appendChild(tile(e)));
      section.appendChild(grid);
      body.appendChild(section);
    }
    if (g.more) {
      const more = el('button', 'ui-btn ui-btn--secondary capg-more', tr('capg_more', 'Show more'));
      more.type = 'button';
      more.addEventListener('click', loadMore);
      body.appendChild(more);
    }
  }

  function paintHead(r) {
    if (r.usedBytes != null && typeof formatBytes === 'function') {
      g.sub.textContent = tr('capg_sub', 'Screenshots, recordings and replays: {size}').replace('{size}', formatBytes(Number(r.usedBytes) || 0));
    }
    if (!Array.isArray(r.games)) return;
    // A choice of game only when there is one to make.
    const games = r.games.filter(x => x && typeof x.label === 'string');
    g.gameSel.hidden = games.length < 2 && !g.game;
    g.gameSel.replaceChildren(new Option(tr('capg_game_all', 'All games'), ''));
    games.forEach(x => g.gameSel.appendChild(new Option(x.label === 'Desktop' ? tr('capg_desktop', 'Desktop') : x.label, x.label)));
    g.gameSel.value = g.game;
  }

  async function reload() {
    if (!g) return;
    const mine = g;
    const r = await fetchPage(0);
    if (g !== mine) return;
    if (!r || r.ok !== true) { g.body.replaceChildren(status(tr('capg_error', 'The gallery did not load.'), true)); return; }
    g.entries = Array.isArray(r.entries) ? r.entries : [];
    g.more = r.more === true;
    g.editable = r.editable === true;
    g.pinnable = r.pinnable === true;
    g.sendable = r.sendable === true;
    g.can = engineCan(r.can);
    paintHead(r);
    paintGrid();
    if (g.viewer) g.viewer.sync(g.entries);
  }

  async function loadMore() {
    const last = g.entries[g.entries.length - 1];
    if (!last) return;
    const mine = g;
    const r = await fetchPage(last.createdAt);
    if (g !== mine || !r || r.ok !== true) return;
    g.entries = g.entries.concat(Array.isArray(r.entries) ? r.entries : []);
    g.more = r.more === true;
    const top = g.body.scrollTop;
    paintGrid();
    g.body.scrollTop = top;
  }

  function filterBar() {
    const bar = el('div', 'capg-bar');
    const kinds = el('div', 'capg-filters');
    kinds.setAttribute('role', 'group');
    const names = { '': ['capg_filter_all', 'All'], video: ['capg_filter_video', 'Videos'], screenshot: ['capg_filter_shot', 'Screenshots'] };
    M.FILTERS.forEach((f) => {
      const b = el('button', 'capg-filter', tr(names[f][0], names[f][1]));
      b.type = 'button';
      b.dataset.filter = f;
      b.setAttribute('aria-pressed', String(f === g.filter));
      b.addEventListener('click', () => {
        if (g.filter === f) return;
        g.filter = f;
        kinds.querySelectorAll('.capg-filter').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.filter === f)));
        reload();
      });
      kinds.appendChild(b);
    });
    const sel = el('select', 'capg-game-select');
    sel.setAttribute('aria-label', tr('capg_game_all', 'All games'));
    sel.hidden = true;
    sel.addEventListener('change', () => { g.game = sel.value; reload(); });
    g.gameSel = sel;
    bar.append(kinds, sel);
    return bar;
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
      onClose: () => { if (g) { g.viewer = null; g.overlay.focus(); } },
      onChanged: (focusId, line) => reload().then(() => { if (focusId && g) openViewer(focusId, line); }),
    });
  }

  function onKey(ev) {
    if (ev.key === 'Escape' && !ev.defaultPrevented && g && !g.viewer) { ev.preventDefault(); close(); }
  }

  function close() {
    if (!g) return;
    if (g.viewer) g.viewer.close();
    document.removeEventListener('keydown', onKey);
    g.overlay.remove();
    g = null;
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('capture-gallery', false);
  }

  // `opts.id` opens the viewer on that capture once the list is in;
  // `opts.filter` starts on '', 'video' or 'screenshot'.
  async function open(opts) {
    const o = opts || {};
    if (typeof isLayerPage === 'function' && isLayerPage()) return;
    close();
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('capture-gallery', true);
    const overlay = el('div', 'preset-modal-overlay cgal-overlay capg-overlay');
    overlay.tabIndex = -1;
    const modal = el('div', 'preset-modal cgal-modal capg-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', tr('capg_title', 'Gallery'));
    g = { overlay, modal, entries: [], more: false, editable: false, pinnable: false, can: engineCan(null), viewer: null, game: '', filter: M.FILTERS.includes(o.filter) ? o.filter : '' };

    const head = el('div', 'cgal-topbar');
    const brand = el('div', 'cgal-brand');
    brand.appendChild(icon('gallery', 'cgal-brand-mark'));
    const txt = el('div', 'cgal-brand-txt');
    txt.appendChild(el('h3', 'cgal-brand-title', tr('capg_title', 'Gallery')));
    g.sub = txt.appendChild(el('p', 'cgal-brand-sub', tr('capg_sub_plain', 'Screenshots, recordings and replays')));
    brand.appendChild(txt);
    const x = el('button', 'cgal-iconbtn');
    x.type = 'button';
    x.title = tr('capg_close', 'Close');
    x.setAttribute('aria-label', x.title);
    x.appendChild(icon('close'));
    x.addEventListener('click', close);
    head.append(brand, x);
    modal.appendChild(head);
    modal.appendChild(filterBar());
    g.body = modal.appendChild(el('div', 'cgal-scroll capg-scroll'));
    overlay.appendChild(modal);
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    overlay.focus();
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
