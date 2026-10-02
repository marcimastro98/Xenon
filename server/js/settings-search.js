'use strict';

// ── Settings search ──────────────────────────────────────────────────────────
// One field at the top of the Settings sidebar that finds a setting by what it
// is called, in any of the 11 languages, and takes you to its row.
//
// The index is read from the page, not from a hand-kept list: every row in
// #settings-content already names itself through data-i18n keys, and i18n.js
// holds every language at runtime, so a key gives us the label in all 11. That
// is what lets a German user find "Helligkeit" and "brightness" alike, and an
// Italian user with the app in English still type "luminosità". A row added to
// index.html is searchable the day it lands, with no second place to update.
// Each category also carries hidden words (settings_kw_<cat> in i18n.js) for
// the panels other modules draw into empty mounts (lighting, streaming, remote
// control...), whose text is not in the markup until they render.
//
// Matching lives in js/fuzzy-find.js (pure, unit-tested). This file is only
// the DOM half: build the index, paint the results, reveal the chosen row.
(function () {
  const RECENT_KEY = 'xeneonedge.settingsSearchRecent.v1';
  const RECENT_MAX = 5;
  const RESULT_LIMIT = 40;
  const ROW_SEL = '.settings-toggle-row, .settings-row, .settings-vitals-row, .settings-subcard-head, .settings-ambient-row, .settings-supporter-row';
  const LABEL_MAX = 90;
  const VALUE_SEL = 'option[data-i18n], .settings-seg-btn[data-i18n], .settings-seg [data-i18n], button[data-i18n]';

  let index = null;
  let entries = [];
  let query = '';
  let results = [];
  let selected = 0;
  let paintRaf = 0;

  const input = () => document.getElementById('settings-search-input');
  const panel = () => document.getElementById('settings-search-results');
  const content = () => document.getElementById('settings-content');

  // Every language for one key; see FuzzyFind.i18nFields for the weights.
  function fieldsFor(key, weight, opts) {
    if (typeof i18n !== 'object' || !i18n || !window.FuzzyFind) return [];
    const cur = (typeof lang === 'string' && lang) ? lang : 'en';
    return window.FuzzyFind.i18nFields(i18n, key, weight, { ...(opts || {}), lang: cur });
  }

  function keyOf(el) {
    return el ? (el.getAttribute('data-i18n') || '') : '';
  }

  function labelKeyOf(row) {
    const line = row.querySelector('.settings-label-line [data-i18n]:not(.settings-hint)');
    if (line) return keyOf(line);
    for (const el of row.querySelectorAll('[data-i18n]')) {
      if (el.classList.contains('settings-hint') || el.tagName === 'OPTION' || el.tagName === 'BUTTON') continue;
      return keyOf(el);
    }
    return row.hasAttribute('data-i18n') ? keyOf(row) : '';
  }

  // A row the user cannot see on this machine is not a result: a Windows-only
  // row on macOS, or a row hidden because the thing it configures is off (the
  // Pixel Retro sub-toggle, the other AI providers' panels). Only [hidden]
  // BELOW the card counts, because the cards themselves are hidden by the
  // category switch.
  function reachable(el, card) {
    const off = window.XenonPlatform && window.XenonPlatform !== 'win32';
    if (off && el.closest('[data-settings-win-only]')) return false;
    for (let n = el; n && n !== card; n = n.parentElement) {
      if (n.hidden) return false;
    }
    return true;
  }

  function build() {
    const list = [];
    const catKeys = {};
    document.querySelectorAll('#settings-nav [data-settings-cat]').forEach((b) => {
      if (b.hidden) return;
      const cat = b.dataset.settingsCat;
      // The Supporta footer button names the category in its title; its label
      // is the short form.
      const key = b.getAttribute('data-i18n-title') || keyOf(b.querySelector('[data-i18n]'));
      if (cat && key && !catKeys[cat]) catKeys[cat] = key;
    });

    for (const [cat, key] of Object.entries(catKeys)) {
      list.push({
        id: 'cat:' + cat, kind: 'cat', cat, labelKey: key,
        fields: [...fieldsFor(key, 1, { fuzzy: true }), ...fieldsFor('settings_kw_' + cat, 0.8, { fuzzy: true })],
      });
    }

    const root = content();
    if (!root) return list;
    const seen = new Set();
    for (const card of root.children) {
      const cat = card.dataset && card.dataset.settingsCat;
      // No reachable() test on the card itself: every card outside the open category carries
      // `hidden` from settingsSetCategory, so that test indexed only the open
      // one. A card this machine lacks is caught by its category being absent
      // from the sidebar, or by the Windows-only mark.
      if (!cat || !catKeys[cat]) continue;
      if (window.XenonPlatform && window.XenonPlatform !== 'win32' && card.closest('[data-settings-win-only]')) continue;
      const catFields = fieldsFor(catKeys[cat], 0.3, { mainOnly: true });
      const headEl = card.querySelector('.settings-group-head [data-i18n]:not(.settings-hint)');
      const cardKey = keyOf(headEl);
      const cardHint = keyOf(card.querySelector('.settings-group-head .settings-hint[data-i18n]'));
      const cardFields = fieldsFor(cardKey, 0.6, { mainOnly: true });
      if (cardKey) {
        list.push({
          id: cat + '|' + cardKey, kind: 'card', cat, labelKey: cardKey, hintKey: cardHint, el: card,
          fields: [...fieldsFor(cardKey, 1, { fuzzy: true }), ...fieldsFor(cardHint, 0.4), ...catFields],
        });
      }
      const rows = card.querySelectorAll(ROW_SEL);
      const inRow = new Set();
      rows.forEach((row) => {
        inRow.add(row);
        if (!reachable(row, card)) return;
        const labelKey = labelKeyOf(row);
        if (!labelKey || labelKey === cardKey) return;
        // A row nested in another row with the same label (a toggle-row used as
        // the caption of a vitals-row) is one setting, not two results.
        const outer = row.parentElement && row.parentElement.closest(ROW_SEL);
        if (outer && card.contains(outer) && labelKeyOf(outer) === labelKey) return;
        // A paragraph that happens to be the first text in a row is a note,
        // not the name of a setting.
        if (text(labelKey).length > LABEL_MAX) return;
        let id = cat + '|' + labelKey;
        for (let n = 2; seen.has(id); n++) id = cat + '|' + labelKey + '#' + n;
        seen.add(id);
        const hintKey = keyOf(row.querySelector('.settings-hint[data-i18n]'));
        const values = [];
        row.querySelectorAll(VALUE_SEL).forEach((v) => { values.push(...fieldsFor(keyOf(v), 0.5)); });
        // Extra words for a row whose control has no translated text of its own
        // (°C / °F): data-search-kw names an i18n key, like settings_kw_<cat>.
        const kw = row.getAttribute('data-search-kw') || row.querySelector('[data-search-kw]')?.getAttribute('data-search-kw');
        if (kw) values.push(...fieldsFor(kw, 0.8, { fuzzy: true }));
        list.push({
          id, kind: 'row', cat, labelKey, hintKey, cardKey, el: row,
          fields: [...fieldsFor(labelKey, 1, { fuzzy: true }), ...fieldsFor(hintKey, 0.4), ...values, ...cardFields, ...catFields],
        });
      });
      // Actions that are not part of a row: "Import theme…", "Export backup".
      card.querySelectorAll('.settings-btn[data-i18n]').forEach((btn) => {
        if ([...inRow].some((r) => r.contains(btn)) || !reachable(btn, card)) return;
        const labelKey = keyOf(btn);
        const id = cat + '|' + labelKey;
        if (seen.has(id)) return;
        seen.add(id);
        list.push({
          id, kind: 'action', cat, labelKey, cardKey, el: btn,
          fields: [...fieldsFor(labelKey, 0.9, { fuzzy: true }), ...cardFields, ...catFields],
        });
      });
    }
    for (const e of list) e.catKey = catKeys[e.cat];
    return list;
  }

  function ensureIndex(force) {
    if (index && !force) return;
    if (!window.FuzzyFind) return;
    entries = build();
    index = window.FuzzyFind.createIndex(entries);
  }

  // ── Recent picks (a per-screen convenience, never synced) ──
  function readRecent() {
    try {
      const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
    } catch { return []; }
  }
  function pushRecent(id) {
    try {
      const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch { /* private mode, blocked storage: the search still works */ }
  }

  function run() {
    ensureIndex();
    if (!index) { results = []; return; }
    if (!query.trim()) {
      const byId = new Map(entries.map((e) => [e.id, e]));
      results = readRecent().map((id) => byId.get(id)).filter(Boolean).map((entry) => ({ entry, score: 0 }));
      return;
    }
    const recent = new Set(readRecent());
    results = window.FuzzyFind.search(index, query, {
      limit: RESULT_LIMIT,
      boost: (e) => (recent.has(e.id) ? 0.05 : 0),
    });
  }

  // ── Painting ──
  function text(key) {
    return key && typeof t === 'function' ? t(key) : '';
  }

  function itemFor(res, i) {
    const e = res.entry;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-search-item';
    btn.id = 'settings-search-opt-' + i;
    btn.setAttribute('role', 'option');
    btn.dataset.idx = String(i);
    // Keep the field focused on a pointer press, so the keyboard does not
    // close and reopen on a touch screen between two picks.
    btn.addEventListener('pointerdown', (ev) => ev.preventDefault());
    btn.addEventListener('click', () => reveal(e, false));

    const label = document.createElement('span');
    label.className = 'settings-search-label';
    window.FuzzyFind.renderHighlighted(label, text(e.labelKey), query);
    btn.appendChild(label);

    const crumbs = [text(e.catKey)];
    // A card named like its category ("Meteo › Meteo") says nothing twice.
    const cardText = e.cardKey && e.cardKey !== e.labelKey ? text(e.cardKey) : '';
    if (cardText && cardText !== crumbs[0]) crumbs.push(cardText);
    const crumb = document.createElement('span');
    crumb.className = 'settings-search-crumb';
    crumb.textContent = e.kind === 'cat' ? '' : crumbs.filter(Boolean).join(' › ');
    if (crumb.textContent) btn.appendChild(crumb);

    const hint = text(e.hintKey);
    if (hint) {
      const h = document.createElement('span');
      h.className = 'settings-search-hint';
      window.FuzzyFind.renderHighlighted(h, hint, query);
      btn.appendChild(h);
    }
    return btn;
  }

  function paint() {
    paintRaf = 0;
    const box = panel();
    if (!box) return;
    box.textContent = '';
    if (!query.trim() && !results.length) { setSearching(false); return; }
    setSearching(true);
    if (!results.length) {
      const empty = document.createElement('p');
      empty.className = 'settings-search-empty';
      empty.textContent = text('settings_search_empty');
      box.appendChild(empty);
      input()?.removeAttribute('aria-activedescendant');
      return;
    }
    if (!query.trim()) {
      const head = document.createElement('div');
      head.className = 'settings-search-head';
      head.textContent = text('settings_search_recent');
      box.appendChild(head);
    }
    const list = document.createElement('div');
    list.className = 'settings-search-list';
    list.setAttribute('role', 'listbox');
    results.forEach((r, i) => list.appendChild(itemFor(r, i)));
    box.appendChild(list);
    select(Math.min(selected, results.length - 1));
  }

  function schedulePaint() {
    run();
    selected = 0;
    if (!paintRaf) paintRaf = requestAnimationFrame(paint);
  }

  function select(i) {
    const box = panel();
    if (!box) return;
    selected = Math.max(0, i);
    box.querySelectorAll('.settings-search-item').forEach((b) => {
      const on = Number(b.dataset.idx) === selected;
      b.classList.toggle('is-selected', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) {
        b.scrollIntoView({ block: 'nearest' });
        input()?.setAttribute('aria-activedescendant', b.id);
      }
    });
  }

  function setSearching(on) {
    const c = content();
    const box = panel();
    if (!c || !box) return;
    c.classList.toggle('is-searching', on);
    box.hidden = !on;
    input()?.setAttribute('aria-expanded', on ? 'true' : 'false');
    if (on) c.scrollTop = 0;
  }

  // ── Going to the row ──
  function reveal(entry, fromKeyboard) {
    if (!entry) return;
    pushRecent(entry.id);
    setSearching(false);
    if (typeof settingsSetCategory === 'function') settingsSetCategory(entry.cat);
    // On a phone the category list may be open over the content: the choice
    // is made, fold it away like a category tap does.
    document.getElementById('settings-nav')?.classList.remove('is-open');
    const el = entry.el && entry.el.isConnected ? entry.el : null;
    if (!el) return;
    const details = el.closest('details');
    if (details && !details.open) details.open = true;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // After settingsSetCategory's column packing has placed the cards.
    requestAnimationFrame(() => {
      el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      el.classList.remove('settings-search-flash');
      void el.offsetWidth;   // restart the animation on a second pick
      el.classList.add('settings-search-flash');
      setTimeout(() => el.classList.remove('settings-search-flash'), 2600);
      if (fromKeyboard) {
        const ctl = el.matches('button, input, select, textarea') ? el : el.querySelector('input:not([type="hidden"]), select, textarea, button');
        if (ctl) { try { ctl.focus({ preventScroll: true }); } catch { /* best effort */ } }
      }
    });
  }

  // ── Wiring ──
  function onInput(ev) {
    query = ev.target.value || '';
    schedulePaint();
  }

  function onKey(ev) {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (!results.length) return;
      ev.preventDefault();
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      select((selected + step + results.length) % results.length);
    } else if (ev.key === 'Enter') {
      if (!results.length) return;
      ev.preventDefault();
      const r = results[selected] || results[0];
      if (r) reveal(r.entry, true);
    }
  }

  function onFocus() {
    // Rebuilt per search session: panels drawn by other modules after Settings
    // opened (lighting, the calendar feeds) join the index this way, and a
    // language switch is picked up for free.
    ensureIndex(true);
    schedulePaint();
  }

  function onBlur() {
    // Recents are an offer while the field is focused, not a mode to get stuck
    // in. A real query stays on screen until it is cleared or used.
    if (!query.trim()) setTimeout(() => { if (document.activeElement !== input() && !query.trim()) setSearching(false); }, 0);
  }

  function clear() {
    const el = input();
    if (el) el.value = '';
    query = '';
    results = [];
    setSearching(false);
    if (panel()) panel().textContent = '';
  }

  function isEditable(el) {
    return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  }

  function settingsOpen() {
    const o = document.getElementById('settings-overlay');
    return !!o && !o.hidden;
  }

  function init() {
    const el = input();
    if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    el.addEventListener('input', onInput);
    el.addEventListener('keydown', onKey);
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', onBlur);
    // Ctrl+F (or /) while Settings is open lands in this field instead of the
    // browser's find bar, which cannot see categories that are not on screen.
    document.addEventListener('keydown', (ev) => {
      if (!settingsOpen()) return;
      const slash = ev.key === '/' && !ev.ctrlKey && !ev.metaKey && !ev.altKey && !isEditable(ev.target);
      const find = (ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 'f' || ev.key === 'F');
      if (!slash && !find) return;
      ev.preventDefault();
      el.focus();
      el.select();
    });
  }

  // Called by toggleSettings() when the panel opens.
  function onOpen() {
    init();
    index = null;
    clear();
    // Straight into the field with a mouse and keyboard. Never on a screen with
    // a touch surface: focusing there raises the on-screen keyboard over half
    // of the Edge's 720 pixels before the user asked for it.
    const touch = window.matchMedia && window.matchMedia('(any-pointer: coarse)').matches;
    if (!touch) setTimeout(() => { try { input()?.focus({ preventScroll: true }); } catch { /* best effort */ } }, 0);
  }

  // Esc from main.js: first clears a query, only then closes Settings.
  function handleEscape() {
    const el = input();
    if (el && (el.value || !panel()?.hidden)) { clear(); el.blur(); return true; }
    return false;
  }

  // A category picked from the sidebar ends the search view.
  function leave() {
    if (content()?.classList.contains('is-searching')) setSearching(false);
  }

  window.SettingsSearch = { init, onOpen, handleEscape, leave, _build: build };
})();
