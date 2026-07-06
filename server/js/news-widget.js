'use strict';
// News widget — a merged, time-sorted stream of headlines from the sources and
// topics the user follows, each with its outlet, relative time and (optionally) a
// thumbnail. Tapping a headline opens the article.
//
// Data is pushed over SSE ('news' → onSSE) and seeded once on mount
// (GET /api/news, which also returns the followed feeds). Feeds are added through
// a search: curated outlets by name, or any free text as a Google-News topic
// (POST /api/news/feeds). All external text renders through textContent; article
// links and image URLs are used only after an http(s) scheme check.
(function () {
  const el = makeEl;        // shared DOM factory (utils.js)
  const api = apiJson;      // fetch → JSON, null on failure (utils.js)
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  let items = null;         // null = not seeded yet
  let feeds = [];           // [{id,type,name,query?}] followed feeds (from server)
  let tileCfg = { images: true };
  let meta = { refreshedAt: 0 };
  let seeded = false, seedInflight = false;
  let managing = false;     // "following" chip strip open?

  // search state
  let searchQuery = '';
  let searchResults = [];
  let searchBusy = false;
  let searchSeq = 0;
  let searchTimer = 0;
  let searchResultsFor = '';
  let resultsHost = null;

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="news"]')).filter(n => n.closest('.pager-page'));
  }

  function safeHttp(u) { return /^https?:\/\//i.test(String(u || '')) ? String(u) : ''; }

  function relTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    const s = Math.max(0, (Date.now() - n) / 1000);
    if (s < 60) return t('news_now', 'now');
    if (s < 3600) return Math.floor(s / 60) + t('news_min', 'm');
    if (s < 86400) return Math.floor(s / 3600) + t('news_hour', 'h');
    const d = Math.floor(s / 86400);
    if (d < 7) return d + t('news_day', 'd');
    try { return new Date(n).toLocaleDateString([], { day: '2-digit', month: 'short' }); } catch { return ''; }
  }
  function feedLabel(f) { return f.type === 'topic' ? (f.name || f.query || f.id) : (f.name || f.id); }

  // ── headline row ──
  function headline(it) {
    const href = safeHttp(it.url);
    const rowTag = href ? 'a' : 'div';
    const row = el(rowTag, 'nw-item');
    if (href) { row.href = href; row.target = '_blank'; row.rel = 'noopener noreferrer'; }
    if (tileCfg.images !== false && safeHttp(it.image)) {
      const thumb = el('div', 'nw-thumb');
      const img = el('img'); img.loading = 'lazy'; img.alt = ''; img.decoding = 'async'; img.src = safeHttp(it.image);
      img.addEventListener('error', () => { thumb.remove(); });
      thumb.appendChild(img);
      row.appendChild(thumb);
    }
    const body = el('div', 'nw-item-body');
    body.appendChild(el('div', 'nw-item-title', it.title || ''));
    const meta2 = el('div', 'nw-item-meta');
    if (it.source) meta2.appendChild(el('span', 'nw-item-src', it.source));
    const rt = relTime(it.published);
    if (rt) meta2.appendChild(el('span', 'nw-item-time', rt));
    body.appendChild(meta2);
    row.appendChild(body);
    return row;
  }

  // ── search add box ──
  function addBox() {
    const box = el('div', 'nw-add');
    const field = el('div', 'nw-add-field');
    field.innerHTML = '<svg class="nw-add-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
    const input = el('input', 'nw-add-input');
    input.type = 'text';
    input.placeholder = t('news_search_ph', 'Search an outlet, or type a topic…');
    input.maxLength = 60; input.autocomplete = 'off'; input.spellcheck = false;
    input.value = searchQuery;
    field.appendChild(input);
    box.appendChild(field);

    const results = el('div', 'nw-results');
    box.appendChild(results);
    resultsHost = results;
    renderResults(results);

    input.addEventListener('input', () => { searchQuery = input.value; scheduleSearch(); });
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { searchQuery = ''; input.value = ''; searchResults = []; searchResultsFor = ''; searchBusy = false; refreshResults(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const raw = input.value.trim();
      if (!raw) return;
      // Prefer an exact-ish outlet match; otherwise follow it as a topic.
      if (searchResults.length && searchResultsFor === raw) addSource(searchResults[0]);
      else addTopic(raw);
    });
    const prev = document.activeElement;
    if (prev && prev.classList && prev.classList.contains('nw-add-input')) {
      let selS = null, selE = null;
      try { selS = prev.selectionStart; selE = prev.selectionEnd; } catch {}
      requestAnimationFrame(() => { try { input.focus(); const n = input.value.length; input.setSelectionRange(selS == null ? n : selS, selE == null ? n : selE); } catch {} });
    }
    return box;
  }
  function renderResults(host) {
    host.replaceChildren();
    const q = searchQuery.trim();
    if (!q) return;
    const already = new Set(feeds.map(f => f.type + ':' + f.id));
    if (searchBusy && !searchResults.length) host.appendChild(el('div', 'nw-result nw-result--info', t('news_searching', 'Searching…')));
    searchResults.forEach(r => {
      const item = el('button', 'nw-result'); item.type = 'button';
      item.appendChild(el('span', 'nw-result-name', r.name || r.id));
      item.appendChild(el('span', 'nw-result-type', t('news_source', 'Outlet')));
      if (already.has('source:' + r.id)) { item.classList.add('is-added'); item.appendChild(el('span', 'nw-result-added', '✓')); }
      item.addEventListener('click', () => addSource(r));
      host.appendChild(item);
    });
    // Always offer "follow as a topic" for the typed text.
    const topic = el('button', 'nw-result nw-result--topic'); topic.type = 'button';
    const tl = el('span', 'nw-result-name'); tl.append(t('news_follow_topic', 'Follow topic') + ' “', el('b', null, q), '”'); topic.appendChild(tl);
    topic.appendChild(el('span', 'nw-result-type', t('news_topic', 'Topic')));
    topic.addEventListener('click', () => addTopic(q));
    host.appendChild(topic);
  }
  function refreshResults() { if (resultsHost && resultsHost.isConnected) renderResults(resultsHost); }
  function scheduleSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    const query = searchQuery.trim();
    if (!query) { searchResults = []; searchBusy = false; refreshResults(); return; }
    searchBusy = true;
    searchTimer = setTimeout(() => runSearch(query), 240);
    refreshResults();
  }
  async function runSearch(query) {
    const seq = ++searchSeq;
    const d = await api('/api/news/search?q=' + encodeURIComponent(query));
    if (seq !== searchSeq) return;
    searchResults = (d && Array.isArray(d.results)) ? d.results : [];
    searchResultsFor = query;
    searchBusy = false;
    refreshResults();
  }
  async function addSource(r) {
    if (!r || !r.id) return;
    const ok = await postFeeds('add', { type: 'source', id: r.id });
    if (ok) { searchQuery = ''; searchResults = []; searchSeq++; await refresh(); }
    else if (window.XenonToast) window.XenonToast.show({ type: 'error', title: t('news_add_fail', 'Could not add'), message: r.name || r.id });
  }
  async function addTopic(text) {
    const q = String(text || '').trim();
    if (!q) return;
    const ok = await postFeeds('add', { type: 'topic', name: q, query: q });
    if (ok) { searchQuery = ''; searchResults = []; searchSeq++; await refresh(); }
    else if (window.XenonToast) window.XenonToast.show({ type: 'error', title: t('news_add_fail', 'Could not add'), message: q });
  }
  async function removeFeed(f) {
    const ok = await postFeeds('remove', { type: f.type, id: f.id, query: f.query, name: f.name });
    if (ok) await refresh();
  }
  async function postFeeds(action, payload) {
    const d = await api('/api/news/feeds', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
    if (d && Array.isArray(d.feeds)) feeds = d.feeds;
    return !!(d && d.ok);
  }

  // ── following chips ──
  function followingStrip() {
    const strip = el('div', 'nw-follows');
    feeds.forEach(f => {
      const chip = el('span', 'nw-chip' + (f.type === 'topic' ? ' nw-chip--topic' : ''));
      chip.appendChild(el('span', 'nw-chip-label', feedLabel(f)));
      const x = el('button', 'nw-chip-rm'); x.type = 'button'; x.setAttribute('aria-label', t('news_remove', 'Remove') + ' ' + feedLabel(f));
      x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      x.addEventListener('click', () => removeFeed(f));
      chip.appendChild(x);
      strip.appendChild(chip);
    });
    return strip;
  }

  // ── list view ──
  function listView(mount) {
    const wrap = el('div', 'nw-wrap');
    const head = el('div', 'nw-head');
    const titleWrap = el('div', 'nw-head-title');
    titleWrap.append(el('span', 'nw-title', t('layout_widget_news', 'News')));
    if (items && items.length) titleWrap.appendChild(el('span', 'nw-count', String(items.length)));
    head.appendChild(titleWrap);
    const manage = el('button', 'nw-manage' + (managing ? ' is-on' : '')); manage.type = 'button';
    manage.setAttribute('aria-label', t('news_manage', 'Manage feeds'));
    manage.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
    manage.addEventListener('click', () => { managing = !managing; paint(); });
    head.appendChild(manage);
    wrap.appendChild(head);

    if (managing) {
      wrap.appendChild(addBox());
      wrap.appendChild(followingStrip());
    }

    const list = el('div', 'nw-list');
    if (items === null) list.appendChild(el('div', 'nw-state', t('news_loading', 'Loading…')));
    else if (!items.length) {
      const empty = el('div', 'nw-state');
      empty.append(el('div', null, feeds.length ? t('news_none', 'No headlines right now') : t('news_empty', 'No feeds yet')));
      if (!managing) { const b = el('button', 'nw-empty-add', t('news_add_feeds', 'Add feeds')); b.type = 'button'; b.addEventListener('click', () => { managing = true; paint(); }); empty.appendChild(b); }
      list.appendChild(empty);
    } else {
      items.forEach(it => list.appendChild(headline(it)));
    }
    wrap.appendChild(list);
    mount.replaceChildren(wrap);
  }

  function paint() {
    tiles().forEach(tile => {
      const mount = tile.querySelector('.news-widget-mount');
      if (mount) listView(mount);
    });
  }

  async function refresh() {
    const d = await api('/api/news?refresh=1');
    if (d) applySeed(d);
    paint();
  }
  function applySeed(d) {
    if (Array.isArray(d.items)) items = d.items;
    if (Array.isArray(d.feeds)) feeds = d.feeds;
    if (d.tile && typeof d.tile === 'object') tileCfg = d.tile;
    if (d.refreshedAt) meta.refreshedAt = d.refreshedAt;
    if (window.Ticker) window.Ticker.setSource('news', tickerItems());
  }
  function tickerItems() {
    return (items || []).slice(0, 20).map(it => ({ label: it.source || '', value: it.title || '', dir: 'flat' })).filter(x => x.value);
  }
  async function seed() {
    if (!tiles().length || seedInflight) return;
    seedInflight = true;
    try {
      const d = await api('/api/news');
      if (d) applySeed(d);
      else if (items === null) items = [];
    } finally { seedInflight = false; }
    paint();
  }

  // ── public API ──
  function renderWidgets() {
    if (!tiles().length) { seeded = false; return; }
    paint();
    if (!seeded) { seeded = true; seed(); }
  }
  function onSSE(cache) {
    if (cache && Array.isArray(cache.items)) {
      items = cache.items;
      if (cache.refreshedAt) meta.refreshedAt = cache.refreshedAt;
      if (window.Ticker) window.Ticker.setSource('news', tickerItems());
      paint();
    }
  }

  window.NewsWidget = { renderWidgets, onSSE };
})();
