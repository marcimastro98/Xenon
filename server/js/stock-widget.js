'use strict';
// Stock-market (Borsa) widget — a live watchlist with sparklines plus a detail
// view with a gradient SVG area chart (range 1D/1W/1M/1Y), day range and
// 52-week stats.
//
// Data is pushed over SSE ('stocks' → onSSE) and seeded once on mount
// (GET /api/stocks, which also returns the watchlist so every added symbol is
// shown — even one Yahoo can't quote yet — instead of silently vanishing).
// Symbols are added through a real SEARCH (GET /api/stocks/search): the user
// types a company name and picks the matching ticker, so "facebook" resolves to
// META rather than being saved as an unquotable symbol. Favorites are persisted
// via POST /api/stocks/watchlist; charts are fetched on-demand
// (GET /api/stocks/chart) and briefly cached. All external strings
// (symbol/name/currency/exchange) render through textContent.
(function () {
  const el = makeEl;        // shared DOM factory (utils.js)
  const api = apiJson;      // fetch → JSON, null on failure (utils.js)
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  const RANGES = ['1d', '1w', '1m', '1y'];
  let quotes = null;        // null = not seeded yet (drives the render); resolved quotes only
  let watchlist = [];       // [{symbol,name}] from the server — persists across SSE quote updates
  let tileCfg = { chart: true, sparklines: true };
  let meta = { provider: '', refreshedAt: 0 };
  let seeded = false, seedInflight = false;
  // Shared view state across mounts (rare to have two Borsa tiles open).
  let view = { mode: 'list', symbol: '', range: '1d' };
  const chartCache = new Map(); // `${symbol}|${range}` → chart data
  let gradSeq = 0;              // unique gradient ids so two charts never collide

  // ── search (add box) state — shared across mounts ──
  let searchQuery = '';
  let searchResults = [];   // [{symbol,name,exchange,type}]
  let searchBusy = false;
  let searchSeq = 0;        // drop stale responses
  let searchTimer = 0;
  let searchResultsFor = '';// the exact query text that produced searchResults —
                            // guards Enter against acting on stale debounced results
  let resultsHost = null;   // the live dropdown node — updated in place so typing
                            // never rebuilds the <input> (which would drop keystrokes)

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="stocks"]')).filter(n => n.closest('.pager-page'));
  }

  const svgNS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    const n = document.createElementNS(svgNS, tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function dirOf(pct) { return pct > 0.0001 ? 'up' : pct < -0.0001 ? 'down' : 'flat'; }

  function fmtPrice(v, cur) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    const abs = Math.abs(n);
    const digits = abs >= 1000 ? 2 : abs >= 1 ? 2 : 4;
    let s;
    try { s = n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }); }
    catch { s = n.toFixed(digits); }
    return cur ? s + ' ' + curSymbol(cur) : s;
  }
  function curSymbol(cur) {
    const m = { EUR: '€', USD: '$', GBP: '£', JPY: '¥' };
    return m[String(cur || '').toUpperCase()] || cur || '';
  }
  function fmtPct(pct) { const n = Number(pct) || 0; return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }

  function fmtTime(tsec, range) {
    const n = Number(tsec);
    if (!Number.isFinite(n)) return '';
    const d = new Date(n * 1000);
    try {
      return (range === '1d' || range === '1w')
        ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleDateString([], { day: '2-digit', month: 'short' });
    } catch { return ''; }
  }

  // ── sparkline (tiny inline SVG, coloured by direction) ──
  function sparkline(values, dir) {
    const w = 68, h = 24, pad = 2;
    const vals = (values || []).filter(v => Number.isFinite(v));
    const box = svg('svg', { class: 'sw-spark sw-' + dir, viewBox: `0 0 ${w} ${h}`, width: w, height: h, preserveAspectRatio: 'none' });
    if (vals.length < 2) return box;
    const min = Math.min(...vals), max = Math.max(...vals);
    const flat = max === min;
    const span = (max - min) || 1;
    const stepX = (w - pad * 2) / (vals.length - 1);
    const frac = (v) => flat ? 0.5 : (v - min) / span;   // a flat series sits centered, not on the floor
    const pts = vals.map((v, i) => [pad + i * stepX, pad + (h - pad * 2) * (1 - frac(v))]);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    box.appendChild(svg('path', { d, class: 'sw-spark-line', fill: 'none' }));
    return box;
  }

  // ── change pill (tinted background + arrow, colour-blind-safe secondary encoding) ──
  function changePill(pct, extraClass) {
    const dir = dirOf(pct);
    const pill = el('span', 'sw-pill sw-pill--' + dir + (extraClass ? ' ' + extraClass : ''));
    const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '•';
    pill.append(el('span', 'sw-pill-arrow', arrow), el('span', 'sw-pill-val', fmtPct(pct)));
    return pill;
  }

  // The list is one row per WATCHLIST entry, with its live quote merged in when
  // resolved — so an added symbol that has no quote yet still shows (removable)
  // instead of disappearing. Falls back to quotes before the first seed lands.
  function displayRows() {
    const bySym = new Map((quotes || []).map(q => [q.symbol, q]));
    const wl = watchlist.length ? watchlist : (quotes || []).map(q => ({ symbol: q.symbol, name: q.name }));
    return wl.map(w => bySym.get(w.symbol) || { symbol: w.symbol, name: w.name || w.symbol, unresolved: true });
  }

  // ── one watchlist row ──
  function row(q) {
    if (q.unresolved) return unresolvedRow(q);
    const dir = dirOf(q.changePct);
    const r = el('button', 'sw-row sw-' + dir);
    r.type = 'button';
    const main = el('div', 'sw-row-main');
    main.append(el('div', 'sw-row-name', q.name || q.symbol), el('div', 'sw-row-sym', q.symbol));
    r.appendChild(main);
    if (tileCfg.sparklines !== false && Array.isArray(q.spark) && q.spark.length > 1) {
      r.appendChild(sparkline(q.spark, dir));
    }
    const right = el('div', 'sw-row-right');
    right.appendChild(el('div', 'sw-row-price', fmtPrice(q.price, q.currency)));
    right.appendChild(changePill(q.changePct));
    r.appendChild(right);
    r.appendChild(removeBtn(q.symbol));
    r.addEventListener('click', () => { view = { mode: 'detail', symbol: q.symbol, range: view.range || '1d' }; paint(); loadChart(q.symbol, view.range); });
    return r;
  }

  // A watchlist entry the provider can't quote (bad ticker, delisted, market
  // closed with no history) — shown muted so the user can see and remove it.
  function unresolvedRow(q) {
    const r = el('div', 'sw-row sw-row--dead');
    const main = el('div', 'sw-row-main');
    main.append(el('div', 'sw-row-name', q.name || q.symbol), el('div', 'sw-row-sym', q.symbol));
    r.appendChild(main);
    r.appendChild(el('div', 'sw-row-nodata', t('stocks_no_data', 'No data')));
    r.appendChild(removeBtn(q.symbol, true));
    return r;
  }

  function removeBtn(sym, always) {
    const b = el('button', 'sw-row-rm' + (always ? ' is-shown' : ''));
    b.type = 'button';
    b.setAttribute('aria-label', t('stocks_remove', 'Remove') + ' ' + sym);
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    b.addEventListener('click', (e) => { e.stopPropagation(); removeSymbol(sym); });
    return b;
  }

  // ── search-driven add box ──
  function addBox() {
    const box = el('div', 'sw-add');
    const field = el('div', 'sw-add-field');
    field.innerHTML = '<svg class="sw-add-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
    const input = el('input', 'sw-add-input');
    input.type = 'text';
    input.placeholder = t('stocks_search_ph', 'Search a company or symbol…');
    input.maxLength = 60; input.autocomplete = 'off'; input.spellcheck = false;
    input.value = searchQuery;
    field.appendChild(input);
    box.appendChild(field);

    const results = el('div', 'sw-results');
    box.appendChild(results);
    resultsHost = results;
    renderResults(results);

    input.addEventListener('input', () => {
      searchQuery = input.value;
      scheduleSearch();            // updates ONLY the dropdown, keeps focus + caret
    });
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { searchQuery = ''; input.value = ''; searchResults = []; searchResultsFor = ''; searchBusy = false; refreshResults(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const raw = input.value.trim();
      if (!raw) return;
      // Only trust searchResults if they were fetched for exactly this text —
      // otherwise the debounced fetch hasn't caught up and results[0] is stale
      // (typing "AAPL" fast would else add "AA"'s top hit). Flush a fresh search.
      if (searchResults.length && searchResultsFor === raw) { addSymbol(searchResults[0]); return; }
      if (searchTimer) { clearTimeout(searchTimer); searchTimer = 0; }
      await runSearch(raw);
      if (searchResults.length && searchResultsFor === raw) addSymbol(searchResults[0]);
      else addRawSymbol(raw);
    });
    // Keep focus + the actual caret/selection after a full repaint while the
    // input is focused (e.g. a background SSE quote tick rebuilding the widget).
    const prev = document.activeElement;
    if (prev && prev.classList && prev.classList.contains('sw-add-input')) {
      let selS = null, selE = null;
      try { selS = prev.selectionStart; selE = prev.selectionEnd; } catch {}
      requestAnimationFrame(() => {
        try {
          input.focus();
          const n = input.value.length;
          input.setSelectionRange(selS == null ? n : selS, selE == null ? n : selE);
        } catch {}
      });
    }
    return box;
  }

  function renderResults(host) {
    host.replaceChildren();
    const q = searchQuery.trim();
    if (!q) return;
    if (searchBusy && !searchResults.length) {
      host.appendChild(el('div', 'sw-result sw-result--info', t('stocks_searching', 'Searching…')));
      return;
    }
    if (!searchResults.length) {
      const info = el('div', 'sw-result sw-result--info', t('stocks_no_results', 'No match — add as symbol'));
      info.classList.add('is-tappable');
      info.addEventListener('click', () => addRawSymbol(q));
      host.appendChild(info);
      return;
    }
    const already = new Set((watchlist.length ? watchlist : (quotes || [])).map(w => w.symbol));
    searchResults.forEach(r => {
      const item = el('button', 'sw-result');
      item.type = 'button';
      const info = el('div', 'sw-result-info');
      info.append(el('div', 'sw-result-name', r.name || r.symbol));
      const sub = el('div', 'sw-result-sub');
      sub.append(el('span', 'sw-result-sym', r.symbol));
      if (r.exchange) sub.append(el('span', 'sw-result-exch', r.exchange));
      info.appendChild(sub);
      item.appendChild(info);
      if (r.type) item.appendChild(el('span', 'sw-result-type', r.type));
      if (already.has(r.symbol)) { item.classList.add('is-added'); item.appendChild(el('span', 'sw-result-added', '✓')); }
      item.addEventListener('click', () => addSymbol(r));
      host.appendChild(item);
    });
  }

  function refreshResults() { if (resultsHost && resultsHost.isConnected) renderResults(resultsHost); }

  function scheduleSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    const query = searchQuery.trim();
    if (!query) { searchResults = []; searchBusy = false; refreshResults(); return; }
    searchBusy = true;
    searchTimer = setTimeout(() => runSearch(query), 220);
    refreshResults();
  }

  async function runSearch(query) {
    const seq = ++searchSeq;
    const d = await api('/api/stocks/search?q=' + encodeURIComponent(query));
    if (seq !== searchSeq) return;           // a newer keystroke superseded this
    searchResults = (d && Array.isArray(d.results)) ? d.results : [];
    searchResultsFor = query;                // stamp which text these results are for
    searchBusy = false;
    refreshResults();
  }

  async function addSymbol(r) {
    if (!r || !r.symbol) return;
    const ok = await postWatchlist('add', r.symbol, r.name);
    if (ok) { searchQuery = ''; searchResults = []; searchSeq++; await refresh(); }
    else if (window.XenonToast) window.XenonToast.show({ type: 'error', title: t('stocks_add_fail', 'Could not add symbol'), message: r.symbol });
  }
  async function addRawSymbol(raw) {
    const ok = await postWatchlist('add', raw, '');
    if (ok) { searchQuery = ''; searchResults = []; searchSeq++; await refresh(); }
    else if (window.XenonToast) window.XenonToast.show({ type: 'error', title: t('stocks_add_fail', 'Could not add symbol'), message: raw });
  }

  async function removeSymbol(sym) {
    const ok = await postWatchlist('remove', sym, '');
    if (ok) {
      if (view.mode === 'detail' && view.symbol === sym) view = { mode: 'list', symbol: '', range: view.range };
      await refresh();
    } else if (window.XenonToast) {
      window.XenonToast.show({ type: 'error', title: t('stocks_add_fail', 'Could not update watchlist'), message: sym });
    }
  }

  async function postWatchlist(action, symbol, name) {
    const d = await api('/api/stocks/watchlist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, symbol, name: name || '' }),
    });
    if (d && Array.isArray(d.watchlist)) watchlist = d.watchlist;   // authoritative
    return !!(d && d.ok);
  }

  // ── detail view (big quote + range switch + area chart + stats) ──
  function detailView(mount) {
    const q = (quotes || []).find(x => x.symbol === view.symbol) || { symbol: view.symbol, name: view.symbol };
    const dir = dirOf(q.changePct);
    const wrap = el('div', 'sw-detail sw-' + dir);

    const head = el('div', 'sw-detail-head');
    const back = el('button', 'sw-back'); back.type = 'button'; back.setAttribute('aria-label', t('back', 'Back'));
    back.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
    back.addEventListener('click', () => { view = { mode: 'list', symbol: '', range: view.range }; paint(); });
    const titleBox = el('div', 'sw-detail-title');
    titleBox.append(el('div', 'sw-detail-name', q.name || q.symbol), el('div', 'sw-detail-sym', detailSub(q)));
    const rm = el('button', 'sw-detail-rm'); rm.type = 'button';
    rm.setAttribute('aria-label', t('stocks_remove', 'Remove'));
    rm.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
    rm.addEventListener('click', () => removeSymbol(q.symbol));
    head.append(back, titleBox, rm);
    wrap.appendChild(head);

    const priceRow = el('div', 'sw-detail-price');
    priceRow.appendChild(el('span', 'sw-detail-big', fmtPrice(q.price, q.currency)));
    const chgWrap = el('span', 'sw-detail-chgwrap');
    chgWrap.append(
      el('span', 'sw-detail-chgabs sw-' + dir, (Number(q.change) >= 0 ? '+' : '') + (Number(q.change) || 0).toFixed(2)),
      changePill(q.changePct, 'sw-pill--lg')
    );
    priceRow.appendChild(chgWrap);
    wrap.appendChild(priceRow);

    // Range switcher (segmented control)
    const ranges = el('div', 'sw-ranges');
    RANGES.forEach(rk => {
      const b = el('button', 'sw-range' + (view.range === rk ? ' is-active' : ''), rk.toUpperCase());
      b.type = 'button';
      b.addEventListener('click', () => { view.range = rk; paint(); loadChart(q.symbol, rk); });
      ranges.appendChild(b);
    });
    wrap.appendChild(ranges);

    // Chart (from cache, else a loading placeholder)
    const chartHost = el('div', 'sw-chart-host');
    const cached = chartCache.get(q.symbol + '|' + view.range);
    if (tileCfg.chart !== false) {
      if (cached) chartHost.appendChild(areaChart(cached, q));
      else chartHost.appendChild(el('div', 'sw-chart-loading', t('stocks_loading', 'Loading chart…')));
    }
    wrap.appendChild(chartHost);

    // Stats
    const stats = el('div', 'sw-stats');
    stats.appendChild(statBox(t('stocks_day_range', 'Day range'), rangeText(q.dayLow, q.dayHigh, q.currency)));
    stats.appendChild(statBox(t('stocks_52w', '52-week'), rangeText(q.low52, q.high52, q.currency)));
    if (q.exchange) stats.appendChild(statBox(t('stocks_exchange', 'Exchange'), q.exchange));
    if (q.marketState) stats.appendChild(statBox(t('stocks_market', 'Market'), marketLabel(q.marketState)));
    wrap.appendChild(stats);

    mount.replaceChildren(wrap);
  }

  function detailSub(q) {
    const bits = [q.symbol];
    if (q.currency) bits.push(curSymbol(q.currency));
    return bits.join(' · ');
  }
  function marketLabel(s) {
    const v = String(s || '').toUpperCase();
    if (v === 'REGULAR') return t('stocks_market_open', 'Open');
    if (v === 'CLOSED' || v === 'POST' || v === 'POSTPOST' || v === 'PREPRE' || v === 'PRE') return t('stocks_market_closed', 'Closed');
    return s;
  }
  function rangeText(lo, hi, cur) {
    if (!Number.isFinite(Number(lo)) || !Number.isFinite(Number(hi))) return '—';
    return fmtPrice(lo, '') + ' – ' + fmtPrice(hi, cur);
  }
  function statBox(label, value) {
    const b = el('div', 'sw-stat');
    b.append(el('div', 'sw-stat-label', label), el('div', 'sw-stat-value', value));
    return b;
  }

  // ── area chart with gradient fill + baseline (prevClose) + hover crosshair ──
  function areaChart(data, q) {
    const points = (data && Array.isArray(data.points)) ? data.points.filter(p => p && Number.isFinite(p.c)) : [];
    const host = el('div', 'sw-chart');
    if (points.length < 2) { host.appendChild(el('div', 'sw-chart-loading', t('stocks_no_chart', 'No chart data'))); return host; }
    const W = 320, H = 132, padY = 10;
    const closes = points.map(p => p.c);
    const base = Number.isFinite(Number(data.prevClose)) ? Number(data.prevClose) : closes[0];
    const min = Math.min(...closes, base), max = Math.max(...closes, base);
    const flat = max === min;
    const span = (max - min) || 1;
    const x = i => (i / (points.length - 1)) * W;
    const y = v => padY + (H - padY * 2) * (1 - (flat ? 0.5 : (v - min) / span));   // flat series centered
    const up = closes[closes.length - 1] >= base;
    const cls = up ? 'up' : 'down';
    const gid = 'sw-grad-' + (++gradSeq);

    const box = svg('svg', { class: 'sw-chart-svg sw-' + cls, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
    const defs = svg('defs');
    const grad = svg('linearGradient', { id: gid, x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.appendChild(svg('stop', { class: 'sw-grad-a', offset: '0%' }));
    grad.appendChild(svg('stop', { class: 'sw-grad-b', offset: '100%' }));
    defs.appendChild(grad); box.appendChild(defs);

    // baseline (prevClose) — the diverging reference
    const by = y(base);
    box.appendChild(svg('line', { class: 'sw-chart-base', x1: 0, y1: by.toFixed(1), x2: W, y2: by.toFixed(1) }));
    // area + line
    const linePts = points.map((p, i) => x(i).toFixed(1) + ' ' + y(p.c).toFixed(1));
    box.appendChild(svg('path', { class: 'sw-chart-area', d: `M0 ${H} L` + linePts.join(' L') + ` L${W} ${H} Z`, fill: 'url(#' + gid + ')' }));
    box.appendChild(svg('path', { class: 'sw-chart-line', d: 'M' + linePts.join(' L'), fill: 'none' }));
    host.appendChild(box);

    // crosshair + tooltip (interaction layer)
    const cross = svg('line', { class: 'sw-chart-cross', x1: 0, y1: 0, x2: 0, y2: H }); cross.style.opacity = '0'; box.appendChild(cross);
    const dot = svg('circle', { class: 'sw-chart-dot', r: 3.5, cx: 0, cy: 0 }); dot.style.opacity = '0'; box.appendChild(dot);
    const tip = el('div', 'sw-chart-tip'); tip.style.opacity = '0'; host.appendChild(tip);
    host.addEventListener('pointermove', (ev) => {
      const rect = box.getBoundingClientRect();
      const rel = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const idx = Math.round(rel * (points.length - 1));
      const p = points[idx]; if (!p) return;
      const px = x(idx), py = y(p.c);
      cross.setAttribute('x1', px.toFixed(1)); cross.setAttribute('x2', px.toFixed(1)); cross.style.opacity = '1';
      dot.setAttribute('cx', px.toFixed(1)); dot.setAttribute('cy', py.toFixed(1)); dot.style.opacity = '1';
      tip.replaceChildren();
      tip.append(el('span', 'sw-tip-price', fmtPrice(p.c, q.currency)));
      const tm = fmtTime(p.t, view.range); if (tm) tip.append(el('span', 'sw-tip-time', tm));
      tip.style.opacity = '1';
      tip.style.left = (rel * rect.width) + 'px';
    });
    host.addEventListener('pointerleave', () => { cross.style.opacity = '0'; dot.style.opacity = '0'; tip.style.opacity = '0'; });
    return host;
  }

  async function loadChart(symbol, range) {
    const key = symbol + '|' + range;
    if (chartCache.has(key)) { paint(); return; }
    const d = await api('/api/stocks/chart?symbol=' + encodeURIComponent(symbol) + '&range=' + encodeURIComponent(range));
    if (d && Array.isArray(d.points)) {
      if (chartCache.size > 24) chartCache.delete(chartCache.keys().next().value);
      chartCache.set(key, d);
    }
    if (view.mode === 'detail' && view.symbol === symbol && view.range === range) paint();
  }

  // ── list view ──
  function listView(mount) {
    const wrap = el('div', 'sw-wrap');
    const head = el('div', 'sw-head');
    const titleWrap = el('div', 'sw-head-title');
    titleWrap.append(el('span', 'sw-title', t('layout_widget_stocks', 'Borsa')));
    const rows = displayRows();
    if (rows.length) titleWrap.appendChild(el('span', 'sw-count', String(rows.length)));
    head.appendChild(titleWrap);
    if (meta.provider) {
      const src = el('span', 'sw-src');
      src.append(el('span', 'sw-src-dot'), el('span', null, providerLabel(meta.provider)));
      head.appendChild(src);
    }
    wrap.appendChild(head);

    wrap.appendChild(addBox());

    const list = el('div', 'sw-list');
    if (quotes === null && !watchlist.length) {
      list.appendChild(el('div', 'sw-state', t('stocks_loading', 'Loading…')));
    } else if (!rows.length) {
      list.appendChild(el('div', 'sw-state', t('stocks_empty', 'No stocks yet — search a company above')));
    } else {
      rows.forEach(q => list.appendChild(row(q)));
    }
    wrap.appendChild(list);
    mount.replaceChildren(wrap);
  }

  function providerLabel(p) {
    const m = { yahoo: 'Yahoo Finance', twelvedata: 'Twelve Data', finnhub: 'Finnhub' };
    return m[String(p).toLowerCase()] || p;
  }

  function paint() {
    tiles().forEach(tile => {
      const mount = tile.querySelector('.stocks-widget-mount');
      if (!mount) return;
      if (view.mode === 'detail') detailView(mount);
      else listView(mount);
    });
  }

  async function refresh() {
    const d = await api('/api/stocks?refresh=1');
    if (d) applySeed(d);
    paint();
  }

  function applySeed(d) {
    if (Array.isArray(d.quotes)) quotes = d.quotes;
    if (Array.isArray(d.watchlist)) watchlist = d.watchlist;
    if (d.tile && typeof d.tile === 'object') tileCfg = d.tile;
    if (d.provider) meta.provider = d.provider;
    if (d.refreshedAt) meta.refreshedAt = d.refreshedAt;
    // Feed the ticker too (so it fills even if the widget is what's open).
    if (window.Ticker) window.Ticker.onStocks({ quotes: quotes || [] });
  }

  async function seed() {
    if (!tiles().length || seedInflight) return;
    seedInflight = true;
    try {
      const d = await api('/api/stocks');
      if (d) applySeed(d);
      else if (quotes === null) quotes = [];
    } finally { seedInflight = false; }
    paint();
  }

  // ── public API ──
  function renderWidgets() {
    if (!tiles().length) { seeded = false; return; }
    paint();                                   // instant paint from cache
    if (!seeded) { seeded = true; seed(); }    // deduped across layout passes
  }
  function onSSE(cache) {
    if (cache && Array.isArray(cache.quotes)) {
      quotes = cache.quotes;
      if (cache.provider) meta.provider = cache.provider;
      if (cache.refreshedAt) meta.refreshedAt = cache.refreshedAt;
      if (window.Ticker) window.Ticker.onStocks(cache);
      paint();
    }
  }

  window.StockWidget = { renderWidgets, onSSE };
})();
