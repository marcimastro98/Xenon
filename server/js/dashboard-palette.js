'use strict';
// "+" quick-add: lists the addable widgets, built-in and installed from the
// Store, grouped into categories with an icon each, filtered and searchable, and
// adds the chosen one to the current page — OR (tab mode) merges it into a
// target tile as a new tab. Which entries exist and where they are filed is
// js/palette-model.js; this file draws them.
(function () {
  // Widgets grouped into scannable categories (instead of one long flat list).
  // An id not in any category falls into a trailing "misc" grid so nothing is lost.
  const WIDGET_CATEGORIES = [
    { labelKey: 'palette_cat_productivity', ids: ['agenda', 'calendar', 'tasks', 'timer', 'notes', 'weather', 'search', 'transfer', 'stocks', 'football', 'news', 'notifications', 'vitals', 'phone'] },
    { labelKey: 'palette_cat_media', ids: ['media', 'chat', 'chatgpt', 'browser', 'slideshow'] },
    { labelKey: 'palette_cat_system', ids: ['system', 'fans', 'power', 'battery', 'disk', 'devclean', 'audio', 'mic', 'secondscreen', 'remote', 'smarthome', 'unifi', 'lighting', 'claude', 'openaicodex'] },
    { labelKey: 'palette_cat_streaming', ids: ['twitch', 'twitchwatch', 'youtube', 'youtubelive', 'obs', 'discord', 'spotify', 'streamerbot', 'wavelink', 'deck'] },
  ];
  // Built-in widgets that open only with a supporter pass. The panel says so up
  // front, so nobody adds one expecting it to work straight away.
  const SUPPORTER_WIDGETS = new Set(['devclean']);
  // Inline icons (currentColor) — one per widget id.
  const I = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const WIDGET_ICONS = {
    media: I('<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>'),
    chat: I('<path d="M21 12a8 8 0 0 1-11.4 7.2L4 21l1.8-5.6A8 8 0 1 1 21 12Z"/>'),
    // Two speech bubbles: a conversation, with no OpenAI mark.
    chatgpt: I('<path d="M14 9a5 5 0 0 1-7.2 4.5L3 15l1.2-3.6A5 5 0 1 1 14 9Z"/><path d="M10.5 16.5A5 5 0 0 0 17.2 19L21 20.5l-1.2-3.6A5 5 0 0 0 16.5 9.5"/>'),
    agenda: I('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
    calendar: I('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>'),
    tasks: I('<path d="M9 6h11M9 12h11M9 18h11"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>'),
    timer: I('<circle cx="12" cy="13" r="8"/><path d="M12 13V9M9 2h6"/>'),
    notes: I('<path d="M6 3h9l3 3v15H6z"/><path d="M9 9h6M9 13h6M9 17h4"/>'),
    system: I('<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>'),
    audio: I('<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>'),
    mic: I('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
    deck: I('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
    remote: I('<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    twitch: I('<path d="M5 3h14v10l-4 4h-3l-3 3v-3H5z"/><path d="M11 8v3M15 8v3"/>'),
    twitchwatch: I('<path d="M5 3h14v10l-4 4h-3l-3 3v-3H5z"/><path d="M10 7.5l4 2.5-4 2.5z"/>'),
    obs: I('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.4"/>'),
    youtube: I('<rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9l5 3-5 3z"/>'),
    youtubelive: I('<rect x="2" y="9" width="20" height="12" rx="4"/><path d="M10 12l5 3-5 3z"/><path d="M6.5 6.5a6 6 0 0 1 11 0"/>'),
    discord: I('<path d="M8 4h8l3 4 1.5 8-4 2-1.5-2.5M8 4 5 8l-1.5 8 4 2L9 15.5"/><circle cx="9.2" cy="12" r="1.1"/><circle cx="14.8" cy="12" r="1.1"/>'),
    spotify: I('<circle cx="12" cy="12" r="9"/><path d="M7.5 10c3-.8 6-.5 8.5 1M8 13c2.3-.6 4.6-.4 6.5.9M8.5 15.6c1.7-.4 3.4-.3 4.9.7"/>'),
    browser: I('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 8h18M7 5.5h.01M10 5.5h.01"/>'),
    slideshow: I('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m4 17 4.5-4 3.5 2.5 3-2.5L20 17"/>'),
    secondscreen: I('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4M15 7l3 3-3 3"/>'),
    weather: I('<path d="M6.5 18a4.5 4.5 0 0 1 .4-9 5.5 5.5 0 0 1 10.5 1.4A3.8 3.8 0 0 1 17 18Z"/><path d="M12 2v1.5M4 6l1 1M20 6l-1 1"/>'),
    smarthome: I('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>'),
    streamerbot: I('<path d="M12 3l7 4v10l-7 4-7-4V7z"/><path d="M9 11h.01M15 11h.01M9 15h6"/>'),
    wavelink: I('<path d="M6 3v18M12 3v18M18 3v18"/><path d="M4 8h4M10 14h4M16 6h4"/>'),
    lighting: I('<path d="M9 18h6M10 21h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2h6c0-.8.4-1.5 1-2A7 7 0 0 0 12 2Z"/>'),
    notifications: I('<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>'),
    stocks: I('<path d="M3 3v18h18"/><path d="m7 14 3-3 3 3 5-6"/><path d="M17 8h4v4"/>'),
    football: I('<circle cx="12" cy="12" r="9"/><path d="m12 7 4.5 3.3-1.7 5.3h-5.6L7.5 10.3 12 7Z"/><path d="M12 3v4M20.5 9.5l-3.7 2.7M18 20l-2.8-4.4M6 20l2.8-4.4M3.5 9.5l3.7 2.7"/>'),
    news: I('<path d="M4 5h13v14a2 2 0 0 1-2 2H5a2 2 0 0 1-1-3.8"/><path d="M17 8h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2"/><path d="M8 9h5M8 13h5M8 17h3"/>'),
    claude: I('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2c.35 2.6 1.05 3.3 3.6 3.6-2.55.35-3.25 1.05-3.6 3.6-.35-2.55-1.05-3.25-3.6-3.6 2.55-.35 3.25-1.05 3.6-3.6Z"/>'),
    // A generic terminal prompt: the tile works WITH Codex, it is not OpenAI's,
    // so it carries no OpenAI mark.
    openaicodex: I('<rect x="2.5" y="4" width="19" height="16" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5"/><path d="M12.5 15h4.5"/>'),
    vitals: I('<path d="M12 21S3.8 15.9 2.9 10.8A5.2 5.2 0 0 1 12 6.4a5.2 5.2 0 0 1 9.1 4.4C20.2 15.9 12 21 12 21Z"/><path d="M7 12h2.4l1.3-2.6 2 4.4 1.4-1.8H17"/>'),
    unifi: I('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 4.6-2.6a1 1 0 0 1 1.5.9v7.4a1 1 0 0 1-1.5.9L16 14"/><circle cx="9" cy="12" r="2.5"/>'),
    fans: I('<circle cx="12" cy="12" r="2"/><path d="M12 10c0-3.5 1.5-6 4-6 1.8 0 2.6 1.6 1.6 3.1C16.5 8.7 14 10 12 10ZM14 12c3.5 0 6 1.5 6 4 0 1.8-1.6 2.6-3.1 1.6C15.3 16.5 14 14 14 12ZM12 14c0 3.5-1.5 6-4 6-1.8 0-2.6-1.6-1.6-3.1C7.5 15.3 10 14 12 14ZM10 12c-3.5 0-6-1.5-6-4 0-1.8 1.6-2.6 3.1-1.6C8.7 7.5 10 10 10 12Z"/>'),
    power: I('<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>'),
    search: I('<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>'),
    disk: I('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/><path d="M12 3a9 9 0 0 1 9 9h-6.5"/>'),
    devclean: I('<path d="M14.5 3.5 20.5 9.5"/><path d="m17.5 6.5-7 7"/><path d="M10.5 13.5 6 18l-2.5-.5L3 15l4.5-4.5"/><path d="M14 20h7"/>'),
    transfer: I('<path d="M7 20V8"/><path d="m3 12 4-4 4 4"/><path d="M17 4v12"/><path d="m13 12 4 4 4-4"/>'),
    phone: I('<path d="M6.5 3h3l1.5 4-2 1.4a12 12 0 0 0 5.6 5.6l1.4-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.2 2 2 0 0 1 6.5 3Z"/>'),
    battery: I('<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 10v4M5.5 10.5v3M9 10.5v3"/>'),
    custom: I('<path d="M14 7h4a1 1 0 0 1 1 1v3.5a1.5 1.5 0 0 0 0 3V18a1 1 0 0 1-1 1h-3.5a1.5 1.5 0 0 1-3 0H8a1 1 0 0 1-1-1v-3.5a1.5 1.5 0 0 1 0-3V8a1 1 0 0 1 1-1h3.5a1.5 1.5 0 0 1 3 0Z"/>'),
  };
  const FALLBACK_ICON = I('<rect x="3" y="3" width="18" height="18" rx="3"/>');
  const tr = (k, fb) => (typeof t === 'function' ? t(k) : (fb != null ? fb : k));
  const PM = () => window.PaletteModel;
  const CW = () => window.CustomWidget;

  // ── One item, whatever it is ────────────────────────────────────────────
  // A built-in widget (its i18n name and glyph), a Store widget (its own name,
  // author and glyph, the puzzle when it has none) or a tile already on the
  // page (tab mode's "move here": a Store widget's tile shows its package).
  // `query` highlights the match while searching; `idx` marks a search result
  // for the arrow keys.
  function makeEntryItem(entry, onPick, query, idx) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'widget-palette-item';
    if (idx != null) btn.dataset.idx = String(idx);
    const ico = document.createElement('span');
    ico.className = 'widget-palette-ico';
    const own = entry.iconEl ? entry.iconEl() : null;   // a package's own glyph (inert SVG element)
    if (own) ico.appendChild(own);
    else ico.innerHTML = WIDGET_ICONS[entry.base] || FALLBACK_ICON;   // static, trusted SVG
    const text = document.createElement('span');
    text.className = 'widget-palette-text';
    const lbl = document.createElement('span');
    lbl.className = 'widget-palette-label';
    if (query) window.FuzzyFind.renderHighlighted(lbl, entry.label, query);
    else {
      // Built-in names follow a language change; a package's name is its own.
      if (entry.i18nKey) lbl.setAttribute('data-i18n', entry.i18nKey);
      lbl.textContent = entry.label;
    }
    text.appendChild(lbl);
    if (entry.sub) {
      const sub = document.createElement('span');
      sub.className = 'widget-palette-sub';
      sub.textContent = entry.sub;
      text.appendChild(sub);
    }
    btn.append(ico, text);
    if (entry.supporter) {
      const badge = document.createElement('span');
      badge.className = 'widget-palette-badge';
      badge.setAttribute('data-i18n', 'palette_supporters');
      badge.textContent = tr('palette_supporters', 'For supporters');
      btn.appendChild(badge);
    }
    if (entry.placed) {
      // Already on the dashboard: the same item, quieter, with an arrow that says
      // the tap goes there instead of adding something.
      btn.classList.add('is-placed');
      const go = document.createElement('span');
      go.className = 'widget-palette-go';
      go.setAttribute('aria-hidden', 'true');
      // Drawn node by node: this function's only markup is the static icon table.
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      const arrow = document.createElementNS(NS, 'path');
      arrow.setAttribute('d', 'm9 6 6 6-6 6');
      svg.appendChild(arrow);
      go.appendChild(svg);
      btn.appendChild(go);
    }
    // An item near the bottom of a scrolling palette would otherwise take focus on
    // press and the browser would scroll it into view — yanking it out from under
    // the cursor before mouseup, so the tap lands on empty space and never fires
    // ("the item runs away when you click it"). Suppress the focus (and its
    // scroll-into-view) on press; the click below still fires and keyboard focus
    // via Tab is unaffected.
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); });
    btn.addEventListener('click', () => onPick(entry));
    return btn;
  }

  // A titled block of items: the heading, then the items on the panel's one
  // shared grid, so every block's columns line up with the others.
  function renderBlock(pop, headingKey, entries, onPick) {
    if (!entries.length) return;
    const section = document.createElement('div');
    section.className = 'widget-palette-section';
    const head = document.createElement('div');
    head.className = 'widget-palette-cat';
    head.setAttribute('data-i18n', headingKey);
    head.textContent = tr(headingKey, '');
    section.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'widget-palette-grid';
    entries.forEach((e) => grid.appendChild(makeEntryItem(e, onPick)));
    section.appendChild(grid);
    pop.appendChild(section);
  }

  // ── Search ──────────────────────────────────────────────────────────────
  // Typing replaces the category view with one ranked list, matched in all 11
  // languages plus hidden words per widget (palette_kw_<id> in i18n.js), and the
  // Store widgets by name, author, description and category. It searches inside
  // the filter that is on. Matching is js/fuzzy-find.js; this is only the
  // palette's half.
  let _search = null;   // { input, pop, render, entries, index, results, selected }
  // The filter chosen last, kept for the session: reopening the panel to add a
  // second Store widget should not send you back to "all".
  let _lastFilter = 'all';

  function catKeyOf(base) {
    const cat = WIDGET_CATEGORIES.find(c => c.ids.includes(base));
    return cat ? cat.labelKey : 'palette_cat_other';
  }

  function builtinFields(base) {
    const FF = window.FuzzyFind;
    if (!FF || typeof i18n !== 'object') return [];
    const cur = (typeof lang === 'string' && lang) ? lang : 'en';
    return [
      ...FF.i18nFields(i18n, 'layout_widget_' + base, 1, { lang: cur, fuzzy: true }),
      ...FF.i18nFields(i18n, 'palette_kw_' + base, 0.8, { lang: cur, fuzzy: true }),
      ...FF.i18nFields(i18n, catKeyOf(base), 0.3, { lang: cur, mainOnly: true }),
    ];
  }

  function packageFields(pkg, category) {
    const FF = window.FuzzyFind;
    const cur = (typeof lang === 'string' && lang) ? lang : 'en';
    const catKey = PM() ? PM().CATEGORY_KEY[category] : '';
    return [
      { text: String(pkg.name), weight: 1, fuzzy: true },
      { text: String(pkg.author || ''), weight: 0.5 },
      { text: String(pkg.description || ''), weight: 0.4 },
      ...(FF && catKey && typeof i18n === 'object' ? FF.i18nFields(i18n, catKey, 0.3, { lang: cur, mainOnly: true }) : []),
    ];
  }

  // Store widgets this panel may offer: installed, not an Ambient scene, not
  // paused. Safe mode hides them (a tile would only say safe mode is on). A
  // switched-off SDK does NOT: adding one is the user switching it on, which
  // CustomWidget.addToPage does in the same tap.
  function storePackages() {
    const C = CW();
    if (!C || typeof C.cachedPackages !== 'function') return [];
    if (typeof hubSettings !== 'undefined' && hubSettings && hubSettings.safeMode) return [];
    return C.cachedPackages().filter(p => p && p.id && p.name && p.surface !== 'ambient'
      && !(typeof C.isSuspended === 'function' && C.isSuspended(p.id)));
  }

  // The catalog is read only to file a Store widget whose manifest names no
  // category, once per session (the server keeps its own cache). Offline, such
  // a widget is simply filed under "other".
  let _catalog = null;
  let _catalogAsk = null;
  function loadCatalog() {
    if (_catalog) return Promise.resolve(_catalog);
    if (!_catalogAsk) {
      _catalogAsk = fetch('/api/community/catalog').then((r) => r.json())
        .then((c) => { _catalog = Array.isArray(c && c.entries) ? c.entries : []; return _catalog; })
        .catch(() => { _catalogAsk = null; return []; });
    }
    return _catalogAsk;
  }

  function selectResult(i) {
    if (!_search) return;
    const items = _search.pop.querySelectorAll('.widget-palette-item[data-idx]');
    if (!items.length) return;
    _search.selected = (i + items.length) % items.length;
    items.forEach((b) => {
      const on = Number(b.dataset.idx) === _search.selected;
      b.classList.toggle('is-selected', on);
      if (on) b.scrollIntoView({ block: 'nearest' });
    });
  }

  function renderResults() {
    const S = _search;
    const q = S.input.value;
    if (!q.trim()) { S.results = []; S.render(); return; }
    if (!S.index) S.index = window.FuzzyFind.createIndex(S.entries());
    const res = window.FuzzyFind.search(S.index, q, { limit: 40 });
    const pop = S.pop;
    pop.textContent = '';
    pop.classList.remove('widget-palette--cols');
    pop.classList.add('widget-palette--results');
    S.results = [];
    if (!res.length) {
      const empty = document.createElement('div');
      empty.className = 'widget-palette-empty';
      empty.textContent = tr('palette_search_empty', '');
      pop.appendChild(empty);
      return;
    }
    // One heading per group, groups in the order of their best match.
    const groups = new Map();
    for (const r of res) {
      const g = r.entry.group;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r.entry);
    }
    for (const [groupKey, list] of groups) {
      const head = document.createElement('div');
      head.className = 'widget-palette-cat';
      head.textContent = tr(groupKey, '');
      pop.appendChild(head);
      const grid = document.createElement('div');
      grid.className = 'widget-palette-grid widget-palette-results';
      for (const entry of list) {
        grid.appendChild(makeEntryItem(entry, (e) => e.pick(), q, S.results.length));
        S.results.push(entry);
      }
      pop.appendChild(grid);
    }
    selectResult(0);
  }

  function attachSearch(modal, before, pop, render, entries) {
    const row = document.createElement('div');
    row.className = 'widget-palette-searchrow';
    row.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/></svg>';
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'widget-palette-search';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('enterkeyhint', 'search');
    input.setAttribute('data-i18n-placeholder', 'palette_search_placeholder');
    input.setAttribute('data-i18n-aria-label', 'palette_search_placeholder');
    input.placeholder = tr('palette_search_placeholder', '');
    input.setAttribute('aria-label', input.placeholder);
    row.appendChild(input);
    modal.insertBefore(row, before);
    _search = { input, pop, render, entries, index: null, results: [], selected: 0 };
    let raf = 0;
    input.addEventListener('input', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; if (_search && _search.input === input) renderResults(); });
    });
    input.addEventListener('keydown', (ev) => {
      if (!_search || !_search.results.length) return;
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        selectResult(_search.selected + (ev.key === 'ArrowDown' ? 1 : -1));
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        const e = _search.results[_search.selected] || _search.results[0];
        if (e) e.pick();
      }
    });
    // Straight into the field with a keyboard. Never where there is a touch
    // surface: focusing would raise the on-screen keyboard over the Edge's
    // 720 pixels before anyone asked for it.
    const touch = window.matchMedia && window.matchMedia('(any-pointer: coarse)').matches;
    if (!touch) setTimeout(() => { try { input.focus({ preventScroll: true }); } catch { /* best effort */ } }, 0);
    return input;
  }

  // Esc from main.js (capture phase): a query is cleared first, the palette
  // closes on the next one.
  function handleEscape() {
    if (!_search || !document.getElementById('widget-palette') || !_search.input.value) return false;
    _search.input.value = '';
    _search.results = [];
    _search.render();
    return true;
  }

  // The filter row: "All", "Installed" (the Store widgets on this PC) and each
  // category that has something in it. Plain buttons in one row; on a narrow
  // screen the row scrolls sideways under the finger (native scrolling only).
  function renderFilters(row, filters, active, onPick) {
    row.textContent = '';
    for (const f of filters) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'widget-palette-filter' + (f === active ? ' is-on' : '');
      b.setAttribute('aria-pressed', String(f === active));
      const key = f === 'all' ? 'palette_filter_all' : f === 'installed' ? 'palette_filter_installed' : PM().CATEGORY_KEY[f];
      b.setAttribute('data-i18n', key);
      b.textContent = tr(key, f);
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); });
      b.addEventListener('click', () => onPick(f));
      row.appendChild(b);
    }
  }

  // opts.tabTargetMember: when set, the palette adds the chosen widget AS A TAB
  // to that tile (merge) instead of placing it on the page.
  function openPalette(pageId, anchorEl, opts) {
    closePalette();
    const layout = getDashboardLayout();
    const tabTarget = opts && opts.tabTargetMember;
    const remoteConfigured = () => !!(window.RemoteControl && window.RemoteControl.isConfigured());
    // The second screen is a Windows Indirect Display Driver; there is no
    // equivalent on macOS or Linux, so offering the widget there promises a tile
    // that can only ever explain itself. Undefined means /version has not landed
    // yet — offer it, because guessing wrong on Windows hides a working feature.
    const secondScreenSupported = () =>
      !window.XenonPlatform || window.XenonPlatform === 'win32';

    // Centered modal (backdrop + card) rather than a popover anchored to the "+":
    // it never depends on where the button sits, so nothing (the floating layout
    // dock, the minimal-mode chrome) can clip it, and it reads as a tidy sheet.
    const overlay = document.createElement('div');
    overlay.className = 'widget-palette-overlay';
    overlay.id = 'widget-palette';
    const modal = document.createElement('div');
    modal.className = 'widget-palette-modal';
    const head = document.createElement('div');
    head.className = 'widget-palette-head';
    const title = document.createElement('h3');
    title.className = 'widget-palette-title';
    const titleKey = tabTarget ? 'palette_tab_title' : 'palette_title';
    title.setAttribute('data-i18n', titleKey);
    title.textContent = tr(titleKey, tabTarget ? 'Aggiungi come tab' : 'Aggiungi widget');
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'widget-palette-close';
    closeBtn.setAttribute('data-i18n-title', 'palette_close');
    closeBtn.title = tr('palette_close', 'Chiudi');
    closeBtn.setAttribute('aria-label', closeBtn.title);
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    closeBtn.addEventListener('click', closePalette);
    head.append(title, closeBtn);
    const filterRow = document.createElement('div');
    filterRow.className = 'widget-palette-filters';
    // `pop` is the scrolling content container (the modal body).
    const pop = document.createElement('div');
    pop.className = 'widget-palette-body';
    modal.append(head, filterRow, pop);
    overlay.appendChild(modal);

    // ── What can be offered ──────────────────────────────────────────────
    const tg = window.DashboardTabGroups;
    let builtins = [];
    let moveEntries = [];
    let members = [];
    if (tabTarget) {
      const groupOf = (id) => (tg ? tg.widgetGroupOf(layout.groups, id) : null);
      const targetGid = groupOf(tabTarget);
      const group = targetGid && layout.groups[targetGid];
      members = group ? group.members : [tabTarget];
      const groupPage = group ? group.page
        : (layout.widgets[tabTarget] && layout.widgets[tabTarget].page)
        || ((layout.copies || []).find(c => c.id === tabTarget) || {}).page
        || ((layout.pages && layout.pages[0] && layout.pages[0].id) || 'dashboard');
      // MOVE: standalone-visible widgets + copies that live on this page and are
      // not already in a group. Picking one relocates the real tile into the tab.
      DASHBOARD_WIDGET_IDS.forEach(id => {
        if (id === tabTarget || members.includes(id)) return;
        const w = layout.widgets[id];
        if (w && w.visible && w.page === groupPage && !groupOf(id)) moveEntries.push({ id, base: id });
      });
      (layout.copies || []).forEach(c => {
        if (!c || c.id === tabTarget || members.includes(c.id)) return;
        if (c.page === groupPage && !groupOf(c.id)) moveEntries.push({ id: c.id, base: c.widget });
      });
      // ADD / DUPLICATE: every known widget not already a member (a duplicable one
      // is duplicated; a hidden one is brought in). Store widgets are entries of
      // their own below, never the generic host tile.
      builtins = DASHBOARD_WIDGET_IDS.filter(id => layout.widgets[id] && !members.includes(id)).map(id => ({ id, base: id }));
    } else {
      const addable = window.DashboardGrid && window.DashboardGrid.addableWidgetIds
        ? window.DashboardGrid.addableWidgetIds(layout.widgets, layout.groups, DASHBOARD_WIDGET_IDS)
        : DASHBOARD_WIDGET_IDS.filter(id => layout.widgets[id] && layout.widgets[id].visible === false);
      const DI = window.DashboardInstances;
      const set = new Set(addable);
      if (DI) DASHBOARD_WIDGET_IDS.forEach(id => { if (layout.widgets[id] && DI.isDuplicable(id)) set.add(id); });
      builtins = DASHBOARD_WIDGET_IDS.filter(id => set.has(id)).map(id => ({ id, base: id }));
    }
    if (!remoteConfigured()) {
      builtins = builtins.filter(b => b.id !== 'remote');
      const RC = window.RemoteControl;
      if (!tabTarget && RC && typeof RC.refreshStatus === 'function' && !RC.getStatus()) RC.refreshStatus();
    }
    if (!secondScreenSupported()) builtins = builtins.filter(b => b.id !== 'secondscreen');

    // ── Already on the dashboard ─────────────────────────────────────────
    // A widget that is placed is not offered again, and an entry that is simply
    // absent reads as "it disappeared" (asked on Discord about Weather). So the
    // panel lists them too, last and quietly, saying where each one is; a tap goes
    // there. Which ones count is palette-model.js's placedBuiltins.
    const tabGroupId = tabTarget && tg ? tg.widgetGroupOf(layout.groups, tabTarget) : null;
    const placedModel = PM().placedBuiltins({
      widgets: layout.widgets, ids: DASHBOARD_WIDGET_IDS, pageId, table: WIDGET_CATEGORIES,
      groupOf: (id) => (tg ? tg.widgetGroupOf(layout.groups, id) : null),
      isDuplicable: (id) => !!(window.DashboardInstances && window.DashboardInstances.isDuplicable(id)),
      tabTarget, members,
    }).filter((m) => !(m.id === 'remote' && !remoteConfigured()) && !(m.id === 'secondscreen' && !secondScreenSupported()));
    const pageNameOf = (id) => {
      const page = (layout.pages || []).find((x) => x.id === id);
      return page && typeof pageDisplayName === 'function' ? pageDisplayName(page) : String(id);
    };
    const whereText = (where) => (where.type === 'tab' ? tr('palette_placed_tab', 'A tab here')
      : where.type === 'page' ? tr('palette_placed_page', 'On page “{page}”').replace('{page}', pageNameOf(where.page))
      : tr('palette_placed_here', 'On this page'));
    const showPlaced = (m) => {
      closePalette();
      if (m.where.type === 'tab') { if (tg && tabGroupId) tg.setGroupActive(tabGroupId, m.id); return; }
      const at = layout.widgets[m.id];
      const P = window.DashboardPager;
      if (P && typeof P.goToPage === 'function' && at && at.page) P.goToPage(at.page);
      // The page scrolls in first; then the tile is brought into view and lit.
      setTimeout(() => {
        const tile = document.querySelector('.grid-stack-item[gs-id="' + m.id + '"]');
        if (!tile || tile.closest('#widget-pool')) {
          // Marked as placed, with no tile on any page: nothing to show, so put it
          // here, which is what the person was looking for.
          if (window.DashboardGrid) window.DashboardGrid.addWidgetToPage(m.id, pageId);
          return;
        }
        tile.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        tile.classList.add('widget-found');
        setTimeout(() => tile.classList.remove('widget-found'), 2000);
      }, 450);
    };
    const toPlacedItem = (m) => ({
      base: m.base, label: tr('layout_widget_' + m.base, m.base), i18nKey: 'layout_widget_' + m.base,
      sub: whereText(m.where), placed: true, group: 'palette_placed', pick: () => showPlaced(m),
      // Found by the same words, a little below an entry that can be added.
      fields: builtinFields(m.base).map((f) => ({ ...f, weight: (f.weight || 1) * 0.85 })),
    });

    // ── Picking ──────────────────────────────────────────────────────────
    const pickBuiltin = (id) => {
      closePalette();
      if (tabTarget) { if (tg) tg.addAsTab(id, tabTarget); }
      else if (window.DashboardGrid) window.DashboardGrid.addWidgetToPage(id, pageId);
    };
    const pickPackage = (pkgId) => {
      closePalette();
      const C = CW();
      if (!C) return;
      if (tabTarget) C.addAsTab(pkgId, tabTarget);
      else C.addToPage(pkgId, pageId);
    };
    const pickMove = (id) => { closePalette(); if (tg) tg.addAsTab(id, tabTarget, { move: true }); };
    // A bundled example is installed first, then placed like any Store widget.
    const pickExample = async (id) => {
      closePalette();
      const C = CW();
      if (!C || typeof C.installExample !== 'function') return;
      try { await C.installExample(id); await C.getPackages(true); } catch { return; }
      if (tabTarget) C.addAsTab(id, tabTarget);
      else C.addToPage(id, pageId);
    };
    const examples = () => {
      const C = CW();
      const safe = typeof hubSettings !== 'undefined' && hubSettings && hubSettings.safeMode;
      if (safe || !C || typeof C.missingExamples !== 'function') return [];
      return C.missingExamples().map((ex) => ({
        base: 'custom', label: String(ex.name), sub: String(ex.desc || ''),
        group: 'palette_examples', pick: () => pickExample(ex.id),
        fields: [{ text: String(ex.name), weight: 1, fuzzy: true }, { text: String(ex.desc || ''), weight: 0.4 }],
      }));
    };

    // ── Entries, as the panel draws them ─────────────────────────────────
    const receipts = () => (typeof hubSettings !== 'undefined' && hubSettings && Array.isArray(hubSettings.contentInstalls)) ? hubSettings.contentInstalls : [];
    const moveItem = (e) => {
      const C = CW();
      const isPkg = e.base === 'custom';
      const name = isPkg && C && C.assignedName ? C.assignedName(e.id) : '';
      return {
        base: e.base, label: name || tr('layout_widget_' + e.base, e.base), i18nKey: name ? '' : 'layout_widget_' + e.base,
        iconEl: isPkg && C && C.assignedIcon ? () => C.assignedIcon(e.id) : null,
        group: 'palette_move_existing', pick: () => pickMove(e.id),
        fields: name ? [{ text: name, weight: 1, fuzzy: true }] : builtinFields(e.base),
      };
    };
    const toItem = (m) => {
      if (m.kind === 'pkg') {
        const pkg = m.pkg;
        return {
          base: 'custom', label: String(pkg.name), sub: pkg.author ? String(pkg.author) : '',
          iconEl: () => (CW() && CW().packageIcon ? CW().packageIcon(pkg) : null),
          group: 'palette_group_store', pick: () => pickPackage(pkg.id), fields: packageFields(pkg, m.category),
        };
      }
      return {
        base: m.base, label: tr('layout_widget_' + m.base, m.base), i18nKey: 'layout_widget_' + m.base,
        supporter: SUPPORTER_WIDGETS.has(m.base),
        group: tabTarget ? 'palette_add_new' : 'palette_group_builtin', pick: () => pickBuiltin(m.id), fields: builtinFields(m.base),
      };
    };
    let model = [];
    const rebuild = () => {
      model = PM().buildEntries({ builtins, packages: storePackages(), table: WIDGET_CATEGORIES, catalog: _catalog || [], receipts: receipts() });
    };
    rebuild();

    let filter = _lastFilter;
    const filtersNow = () => PM().availableFilters(model, true);
    const paintFilters = () => {
      if (!filtersNow().includes(filter)) filter = 'all';
      renderFilters(filterRow, filtersNow(), filter, (f) => {
        filter = f; _lastFilter = f;
        paintFilters();
        if (_search) _search.index = null;
        if (_search && _search.input.value.trim()) renderResults(); else render();
      });
    };
    const render = () => {
      paintFilters();
      pop.textContent = '';
      pop.classList.remove('widget-palette--results');
      pop.classList.add('widget-palette--cols');
      const shown = PM().filterEntries(model, filter);
      if (tabTarget && filter === 'all') renderBlock(pop, 'palette_move_existing', moveEntries.map(moveItem), (e) => e.pick());
      for (const [cat, list] of PM().groupByCategory(shown)) {
        renderBlock(pop, PM().CATEGORY_KEY[cat], list.map(toItem), (e) => e.pick());
      }
      if (!pop.childElementCount) {
        // The text sits in its own span: applyTranslations rewrites the text of
        // a data-i18n element, and would take the Store button with it.
        const empty = document.createElement('div');
        empty.className = 'widget-palette-empty';
        const msg = document.createElement('span');
        empty.appendChild(msg);
        const safe = typeof hubSettings !== 'undefined' && hubSettings && hubSettings.safeMode;
        const key = filter === 'installed' ? (safe ? 'palette_store_safe' : 'palette_store_empty') : 'palette_empty';
        msg.setAttribute('data-i18n', key);
        msg.textContent = tr(key, key === 'palette_empty' ? 'Tutti i widget sono già in uso' : '');
        if (filter === 'installed' && !safe && window.CommunityGallery && typeof window.CommunityGallery.open === 'function') {
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'widget-palette-empty-btn';
          open.setAttribute('data-i18n', 'palette_open_store');
          open.textContent = tr('palette_open_store', 'Open the Store');
          open.addEventListener('click', () => { closePalette(); window.CommunityGallery.open('widget'); });
          empty.appendChild(open);
        }
        pop.appendChild(empty);
      }
      // Under Installed, the bundled examples not installed yet: one tap installs
      // and places one. The reference widget the SDK guide starts from lives here.
      if (filter === 'installed') renderBlock(pop, 'palette_examples', examples(), (e) => e.pick());
      // What is already on the dashboard, inside the filter that is on.
      renderBlock(pop, 'palette_placed', PM().filterEntries(placedModel, filter).map(toPlacedItem), (e) => e.pick());
    };
    render();
    // The search looks inside the filter that is on; tab mode's "move here"
    // entries stay a section of their own, because moving a tile that is already
    // on the page and adding a new one are different acts.
    const input = attachSearch(modal, filterRow, pop, render, () => [
      ...(tabTarget && filter === 'all' ? moveEntries.map(moveItem) : []),
      ...PM().filterEntries(model, filter).map(toItem),
      ...(filter === 'installed' ? examples() : []),
      ...PM().filterEntries(placedModel, filter).map(toPlacedItem),
    ]);

    // Store widgets may not be loaded yet (no tile on screen this session), and
    // one without a manifest category is filed from the catalog: fetch both,
    // then redraw whatever view is up.
    const refresh = () => {
      if (!_search || _search.input !== input) return;
      rebuild();
      _search.index = null;
      if (input.value.trim()) renderResults(); else render();
    };
    const C = CW();
    // A fresh list every time the panel opens: a widget folder just created by
    // hand (the SDK guide's first step) or installed on another surface shows up
    // without a reload. One small local request.
    const loaded = (C && typeof C.getPackages === 'function') ? C.getPackages(true).catch(() => null) : Promise.resolve(null);
    loaded.then(() => {
      refresh();
      const needCatalog = storePackages().some((p) => !(PM().MANIFEST_CATEGORIES.includes(p.category)));
      if (needCatalog && !_catalog) loadCatalog().then(refresh);
    });

    document.body.appendChild(overlay);
    if (typeof applyTranslations === 'function') applyTranslations();
    // Dismiss on a backdrop tap (never on a click inside the card) or Escape.
    overlay.addEventListener('pointerdown', (ev) => { if (ev.target === overlay) closePalette(); });
    document.addEventListener('keydown', _escClose);
  }
  function _escClose(ev) { if (ev.key === 'Escape') closePalette(); }
  function closePalette() {
    const p = document.getElementById('widget-palette');
    if (p) p.remove();
    _search = null;
    document.removeEventListener('keydown', _escClose);
  }

  // Canonical per-widget glyph (full <svg> string, currentColor). Shared so other
  // surfaces — the tab-group tab bar — render the SAME icon a widget was added
  // from, instead of keeping their own drifting copy. null for unknown ids.
  function iconFor(base) { return WIDGET_ICONS[base] || null; }

  window.DashboardPalette = { open: openPalette, close: closePalette, iconFor, handleEscape };
})();
