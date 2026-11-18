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
  const { input, panel, readRecent, setSearching, reveal, leave } = window.SettingsSearchGoing;
  const RESULT_LIMIT = 40;
  const { build, text } = window.SettingsSearchIndexOfRows;

  let index = null;
  let entries = [];
  let query = '';
  let results = [];
  let selected = 0;
  let paintRaf = 0;


  function ensureIndex(force) {
    if (index && !force) return;
    if (!window.FuzzyFind) return;
    entries = build();
    index = window.FuzzyFind.createIndex(entries);
  }

  // ── Recent picks (a per-screen convenience, never synced) ──

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

  // ── Going to the row ──
  // ── Wiring ──
  function onInput(ev) {
    query = ev.target.value || '';
    if (query.trim()) loadEveryLanguage();
    schedulePaint();
  }

  // The page holds only some languages (/layer-i18n.js); a word in any of them
  // should find its setting, so the first search fetches the rest and runs again.
  function loadEveryLanguage() {
    if (!window.I18nLoad) return;
    window.I18nLoad.ensureAll().then((added) => {
      if (!added) return;
      index = null;
      if (query.trim()) schedulePaint();
    });
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

  // A row asked for by its id (the Xenon window's search, js/grid/dashboard-open.js).
  function revealId(id) {
    ensureIndex(true);
    reveal(entries.find((e) => e.id === id), false);
  }

  // `rowsIn(doc, pages)`: the rows of another copy of the page, for the Xenon window's
  // search (js/menu/xenon-menu-settings-find.js), which has no Settings of its own.
  window.SettingsSearch = { init, onOpen, handleEscape, leave, revealId, rowsIn: build, _build: build };
})();
