'use strict';
// Spotlight — the local file search overlay. A fullscreen frosted surface with
// one big input: results stream in as you type (GET /search, debounced, stale
// responses aborted), the parser's interpretation shows as removable chips
// ("PDF · ultimo mese"), and a tap opens the file (POST /search/open) or
// reveals it in Explorer (POST /search/reveal). All offline, no AI required —
// the AI merely calls the same backend through its own tools.
//
// Three ways in: the pull-down gesture on the top bar (a water-drop reveal
// growing from the touch point — the Edge-first interaction), the 🔍 button in
// the quickbar (discoverable path, both Full and Minimal chromes), and the
// Search widget tile. `/spotlight` (the desktop popup the global hotkey opens)
// reuses this module on its own page.
//
// The whole search surface (bar, chips, status, results, Bit) is built by
// createSearchUI(), a factory with per-instance state: the overlay holds one
// instance, and the Search widget tile embeds its own so typing and results
// live inside the tile (window.Spotlight.createSearchUI). One engine, no
// duplicated search code.
//
// Invariants honored here:
//  * ambientFreeze token while open — nothing animates under the frosted blur.
//  * File names/paths are UNTRUSTED text → built with textContent, never
//    innerHTML (the match highlight splits the string and appends spans).
//  * The overlay acts only on server-minted result ids; no path travels up.
(function () {
  const {
    t, fmtSize, fmtDate, shortDir, chipLabel, filterWords, FILTER_GROUPS,
  } = window.SpotlightResultWords;

  const DEBOUNCE_MS = 180;
  const PULL_OPEN_PX = 150;    // drag distance that commits the open (short pulls = just the effect)
  const PULL_START_PX = 16;    // vertical movement before the gesture claims the pointer
  const CHAT_ICON = 'M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-4.6 3.7A.9.9 0 0 1 3 20V5a1 1 0 0 1 1-1Z';

  // ── tiny formatters ──────────────────────────────────────────────────────

  // ── file-type icon (compact inline SVG set) ──────────────────────────────
  const { KIND_OF_EXT, ICON_PATHS, highlightName, PREVIEW_EXTS } = window.SpotlightFileKinds;
  for (const [kind, exts] of Object.entries({
    image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'svg', 'tif', 'tiff'],
    video: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'm4v'],
    audio: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'wma'],
    doc: ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'md', 'rtf', 'odt', 'csv'],
    zip: ['zip', 'rar', '7z', 'tar', 'gz', 'iso'],
    exe: ['exe', 'msi', 'lnk', 'bat', 'cmd'],
  })) for (const e of exts) KIND_OF_EXT[e] = kind;

  const { iconFor, upgradeAppIcon } = window.SpotlightIcons;

  // ── chips (the parser's interpretation, removable) ───────────────────────
  // ── filters the menu adds (as words the parser already understands) ───────

  const spotState = {
    rowSeq: 0,
    root: null,             // overlay element (built lazily)
    shell: null,            // the pill/panel that expands while typing
    ui: null,               // the overlay's search surface
    openState: false,
    pull: null,               // { x, y, id, active, zone, zoneRect, detached, cx }
    dropEl: null,
  };

  // ── the search surface factory ───────────────────────────────────────────
  // Builds the bar (glass, input, filters, AI sparkle, optional ×) + body
  // (chips, status, results) into opts.host and wires the whole engine with
  // per-instance state. Used twice: the overlay below, and the Search widget
  // tile (via window.Spotlight.createSearchUI).
  //   opts.host       element receiving .spot-bar + .spot-body
  //   opts.stateHost  element carrying the state classes (spot-expanded,
  //                   spot-loading): the overlay root or the widget's own container
  //   opts.keyHost    element the keydown handler attaches to
  //   opts.withClose  build the × button (overlay only)
  //   opts.onClose    Escape / × (overlay closes; the widget clears)
  //   opts.onExpand   expanded-state change (the popup resizes its window on it)
  //   opts.onOpened   a file was successfully opened (overlay closes; widget stays)
  //   opts.showRecent () => boolean: the empty search lists recent files (the
  //                   overlay always; the tile only with its setting on)
  //   opts.preview    show an image preview beside the list (overlay only)
  //   opts.onChat     (text, send) hands the phrase to Bit's chat: sent with
  //                   `send`, otherwise left in its field. Answers a sentence
  //                   when it could not. Adds Bit to the bar, Ctrl+B and the row
  //                   that asks Bit
  function createSearchUI(opts) {
    const stateHost = opts.stateHost;
    let debTimer = null;
    let inflight = null;         // AbortController of the running fetch
    let lastResults = [];
    let selIndex = -1;
    let disabled = {};           // chip dimensions the user removed this session
    const listId = 'spot-list-' + (++spotState.rowSeq);

    function setExpanded(expanded) {
      stateHost.classList.toggle('spot-expanded', !!expanded);
      if (typeof opts.onExpand === 'function') opts.onExpand(!!expanded);
    }

    function svgIcon(d, cls) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      if (cls) svg.classList.add(...cls.split(' '));
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
      return svg;
    }

    // ── DOM ──
    const bar = document.createElement('div');
    bar.className = 'spot-bar';
    const glass = svgIcon('M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm0 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM20.7 22.1l-4.8-4.8 1.4-1.4 4.8 4.8-1.4 1.4Z', 'spot-bar-icon');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'spot-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = opts.onChat
      ? t('spot_placeholder_bit', 'Cerca sul PC o chiedi a Bit…')
      : t('spot_placeholder', 'Cerca sul PC…');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', listId);
    input.setAttribute('aria-autocomplete', 'list');
    input.addEventListener('input', () => {
      disabled = {};
      if (bit && input.value.trim()) bit.typing();
      runSearch();
    });

    // Filters: a small menu of the parser's own words.
    const filterBtn = document.createElement('button');
    filterBtn.type = 'button';
    filterBtn.className = 'spot-filter-toggle';
    filterBtn.title = t('spot_filters', 'Filtri');
    filterBtn.setAttribute('aria-haspopup', 'true');
    filterBtn.setAttribute('aria-expanded', 'false');
    filterBtn.appendChild(svgIcon('M3 5h18l-7 8v5l-4 2v-7L3 5Z'));
    filterBtn.addEventListener('click', () => toggleFilters());

    // Bit: a press opens the chat with what is typed, waiting to be sent.
    let bit = null;
    bar.append(glass, input, filterBtn);
    if (opts.onChat) {
      const bitBtn = document.createElement('button');
      bitBtn.type = 'button';
      bitBtn.className = 'spot-bit';
      bitBtn.title = t('spot_chat', 'Chiedi a Bit (Ctrl+B)');
      bitBtn.setAttribute('aria-label', bitBtn.title);
      bit = window.SpotlightBit.create(bitBtn, { onOverlay: !!opts.withClose });
      bitBtn.addEventListener('mouseenter', () => bit.wave());
      bitBtn.addEventListener('click', () => openChat());
      bar.appendChild(bitBtn);
    }
    if (opts.withClose) {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'spot-close';
      // A drawn X, not the × glyph: a font puts that off the button's centre.
      const x = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      x.setAttribute('viewBox', '0 0 24 24');
      x.setAttribute('aria-hidden', 'true');
      const xp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      xp.setAttribute('d', 'M6 6l12 12M18 6L6 18');
      x.appendChild(xp);
      closeBtn.appendChild(x);
      closeBtn.setAttribute('aria-label', t('spot_close', 'Chiudi'));
      closeBtn.title = t('spot_close', 'Chiudi');
      closeBtn.addEventListener('click', () => { if (typeof opts.onClose === 'function') opts.onClose(); });
      bar.appendChild(closeBtn);
    }

    const filterMenu = document.createElement('div');
    filterMenu.className = 'spot-filter-menu';
    filterMenu.hidden = true;
    for (const [labelKey, labelFb, items] of FILTER_GROUPS) {
      const group = document.createElement('div');
      group.className = 'spot-filter-group';
      const label = document.createElement('span');
      label.className = 'spot-filter-label';
      label.textContent = t(labelKey, labelFb);
      group.appendChild(label);
      for (const [word, key, fb] of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'spot-filter-item';
        b.textContent = t(key, fb);
        b.addEventListener('click', () => addFilter(word));
        group.appendChild(b);
      }
      filterMenu.appendChild(group);
    }

    function toggleFilters(force) {
      const open = typeof force === 'boolean' ? force : filterMenu.hidden;
      filterMenu.hidden = !open;
      filterBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      filterBtn.classList.toggle('is-on', open);
      if (open) setExpanded(true);
      else if (!input.value.trim()) renderIdle();
    }

    function addFilter(word) {
      const phrase = filterWords()[word];
      if (!phrase) return;
      input.value = (input.value.trim() + ' ' + phrase).trim();
      toggleFilters(false);
      input.focus();
      runSearch();
    }

    const chipsEl = document.createElement('div');
    chipsEl.className = 'spot-chips';
    chipsEl.hidden = true;

    const statusEl = document.createElement('div');
    statusEl.className = 'spot-status';
    statusEl.setAttribute('aria-live', 'polite');

    const listEl = document.createElement('div');
    listEl.className = 'spot-list';
    listEl.id = listId;
    listEl.setAttribute('role', 'listbox');

    // The preview: one image, shown beside the list for the selected row.
    const previewEl = document.createElement('div');
    previewEl.className = 'spot-preview';
    previewEl.hidden = true;
    const previewImg = document.createElement('img');
    previewImg.alt = '';
    previewImg.decoding = 'async';
    const previewCap = document.createElement('div');
    previewCap.className = 'spot-preview-cap';
    previewEl.append(previewImg, previewCap);
    previewImg.addEventListener('error', () => { previewEl.hidden = true; stateHost.classList.remove('spot-has-preview'); });

    const resultsWrap = document.createElement('div');
    resultsWrap.className = 'spot-results';
    resultsWrap.append(listEl, previewEl);

    const body = document.createElement('div');
    body.className = 'spot-body';
    body.append(filterMenu, chipsEl, statusEl, resultsWrap);

    opts.host.append(bar, body);

    // ── chips render ──
    function renderChips(chips) {
      chipsEl.textContent = '';
      for (const c of chips || []) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'spot-chip spot-chip-' + c.type;
        const label = document.createElement('span');
        label.textContent = chipLabel(c);
        chip.appendChild(label);
        const x = document.createElement('span');
        x.className = 'spot-chip-x';
        x.textContent = '×';
        chip.appendChild(x);
        chip.title = t('spot_chip_remove', 'Non è quello che intendevo');
        chip.addEventListener('click', () => {
          // Removing a chip = "that reading was wrong": re-parse with the
          // dimension disabled, so the word searches as a plain term instead.
          disabled[c.type] = true;
          runSearch();
        });
        chipsEl.appendChild(chip);
      }
      chipsEl.hidden = !chipsEl.childElementCount;
    }

    // The empty state. Where recents are allowed: the files and folders last
    // opened from Xenon. Otherwise (the tile by default) the pill alone,
    // Apple-style: the panel body only exists while there is text.
    let recentReq = 0;
    let idle = Promise.resolve();   // settles once the empty state has its final size
    // The last recents shown. An open draws them at once, so the native window
    // grows before the bar comes in, instead of opening short and growing once
    // the server answers; the fresh list replaces them when it comes.
    let recentGroups = null;
    let hoverArmed = false;          // the pointer moved over this list (see the results)
    function renderIdle() {
      hoverArmed = false;
      listEl.textContent = '';
      statusEl.textContent = '';
      chipsEl.textContent = '';
      chipsEl.hidden = true;
      lastResults = [];
      selIndex = -1;
      hidePreview();
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      idle = Promise.resolve();
      if (!filterMenu.hidden) { setExpanded(true); return; }
      const recents = typeof opts.showRecent === 'function' && opts.showRecent();
      const cached = recents ? recentGroups : null;
      if (cached) showRecentGroups(cached);
      else setExpanded(false);
      if (!recents) return;
      const fresh = loadRecent();
      if (!cached) idle = fresh;
    }

    function showRecentGroups(groups) {
      setExpanded(true);
      renderGroups(groups, []);
    }

    async function loadRecent() {
      const req = ++recentReq;
      let out = null;
      try { out = await (await fetch('/search/recent')).json(); } catch { out = null; }
      if (req !== recentReq || input.value.trim() || !out || !out.ok) return;
      const groups = [
        ['spot_recent_files', 'Aperti di recente', out.files || []],
        ['spot_recent_folders', 'Cartelle che usi', out.folders || []],
      ].filter((g) => g[2].length);
      recentGroups = groups.length ? groups : null;
      if (groups.length) { showRecentGroups(groups); return; }
      listEl.textContent = '';
      lastResults = [];
      setExpanded(false);
    }

    // ── results ──
    function rowsOf() { return listEl.querySelectorAll('.spot-row'); }

    // A list drawn under a resting pointer must not pick the row it lands on:
    // the search window opening under the mouse selected that file, popped its
    // preview and moved the highlight. Hover selects once the pointer moves.
    listEl.addEventListener('pointermove', (e) => {
      if (hoverArmed || !(e.movementX || e.movementY)) return;
      hoverArmed = true;
      const row = e.target && e.target.closest ? e.target.closest('.spot-row') : null;
      const index = row ? Array.prototype.indexOf.call(rowsOf(), row) : -1;
      if (index >= 0 && index !== selIndex) setSelected(index);
    });
    listEl.addEventListener('pointerleave', () => { hoverArmed = false; });

    function setSelected(i, quiet) {
      const rows = rowsOf();
      if (!rows.length) { selIndex = -1; return; }
      selIndex = Math.max(0, Math.min(rows.length - 1, i));
      rows.forEach((r, idx) => {
        r.classList.toggle('is-selected', idx === selIndex);
        r.setAttribute('aria-selected', idx === selIndex ? 'true' : 'false');
      });
      const sel = rows[selIndex];
      if (sel) {
        input.setAttribute('aria-activedescendant', sel.id);
        if (sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
      }
      showPreview(lastResults[selIndex]);
      if (!quiet && bit && lastResults[selIndex] && lastResults[selIndex].ask) bit.wave();
    }

    function hidePreview() {
      previewEl.hidden = true;
      previewImg.removeAttribute('src');
      stateHost.classList.remove('spot-has-preview');
    }

    function showPreview(r) {
      if (!opts.preview || !r || r.app || !PREVIEW_EXTS.has(String(r.ext || '').toLowerCase())) { hidePreview(); return; }
      previewImg.src = '/search/thumb?id=' + encodeURIComponent(r.id);
      previewCap.textContent = [fmtSize(r.size), fmtDate(r.mtime)].filter(Boolean).join('  ·  ');
      previewEl.hidden = false;
      stateHost.classList.add('spot-has-preview');
    }

    async function act(kind, r, row) {
      try {
        const res = await fetch('/search/' + kind, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: r.id }),
        });
        const out = await res.json().catch(() => ({}));
        if (out && out.ok) {
          if (kind === 'open' && typeof opts.onOpened === 'function') opts.onOpened();
          return;
        }
        if (out && out.error === 'blocked_ext' && out.revealable) {
          // An exe/lnk result never opens from here — offer the safe path inline.
          row.classList.add('spot-row-blocked');
          const note = row.querySelector('.spot-row-note') || row.appendChild(Object.assign(document.createElement('span'), { className: 'spot-row-note' }));
          note.textContent = t('spot_blocked_hint', 'Per sicurezza non si apre da qui: usa “Mostra nella cartella”');
          return;
        }
        statusEl.textContent = out && out.error === 'not_found'
          ? t('spot_gone', 'Il file non esiste più')
          : t('spot_open_failed', 'Apertura non riuscita');
      } catch {
        statusEl.textContent = t('spot_open_failed', 'Apertura non riuscita');
      }
    }

    async function copyPath(r) {
      if (!r || r.app || !r.path) return;
      try {
        await navigator.clipboard.writeText(r.path);
        statusEl.textContent = t('spot_path_copied', 'Percorso copiato');
      } catch {
        statusEl.textContent = t('spot_copy_failed', 'Copia non riuscita');
      }
    }

    function buildRow(r, terms) {
      const row = document.createElement('div');
      row.className = r.app ? 'spot-row spot-row-app' : 'spot-row';
      row.id = listId + '-r' + (lastResults.length);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.tabIndex = -1;

      let iconEl;
      if (r.app) iconEl = svgIcon(ICON_PATHS.app, 'spot-icon spot-icon-appglyph');
      else iconEl = iconFor(r.kind === 'folder' ? { ext: '' } : r);
      row.appendChild(iconEl);
      upgradeAppIcon(r, iconEl);

      const mid = document.createElement('div');
      mid.className = 'spot-row-mid';
      const nameEl = document.createElement('div');
      nameEl.className = 'spot-row-name';
      nameEl.appendChild(highlightName(r.name || '', terms));
      const metaEl = document.createElement('div');
      metaEl.className = 'spot-row-meta';
      if (r.app) metaEl.textContent = t('spot_app', 'Applicazione');
      else if (r.kind === 'folder') {
        const files = r.files ? r.files + ' ' + t('spot_files', 'file') : '';
        metaEl.textContent = [shortDir(r.dir), files].filter(Boolean).join('  ·  ');
      } else metaEl.textContent = [shortDir(r.dir), fmtSize(r.size), fmtDate(r.mtime)].filter(Boolean).join('  ·  ');
      mid.append(nameEl, metaEl);
      row.appendChild(mid);

      lastResults.push(r);
      const index = lastResults.length - 1;
      row.addEventListener('mouseenter', () => { if (hoverArmed && selIndex !== index) setSelected(index); });
      row.addEventListener('click', () => act('open', r, row));
      if (r.app) return row;

      const revealBtn = document.createElement('button');
      revealBtn.type = 'button';
      revealBtn.className = 'spot-row-reveal';
      revealBtn.title = t('spot_reveal', 'Mostra nella cartella') + ' (Ctrl+Invio)';
      revealBtn.appendChild(svgIcon(ICON_PATHS.folder));
      revealBtn.addEventListener('click', (e) => { e.stopPropagation(); act('reveal', r, row); });
      row.appendChild(revealBtn);
      return row;
    }

    // The last row of every search: the phrase, for Bit. Enter or a tap sends it.
    function askFace() {
      const face = document.createElement('span');
      face.className = 'spot-ask-face';
      // Engine-drawn markup, no user text in it.
      const svg = window.BitApp ? BitApp.icon('talk', 'talk') : '';
      if (svg) face.innerHTML = svg;
      else face.appendChild(svgIcon(CHAT_ICON, 'spot-icon'));
      return face;
    }

    function addAskRow() {
      const phrase = input.value.trim();
      if (!opts.onChat || !phrase) return;
      const row = document.createElement('div');
      row.className = 'spot-row spot-row-ask';
      row.id = listId + '-r' + lastResults.length;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.tabIndex = -1;
      const mid = document.createElement('div');
      mid.className = 'spot-row-mid';
      const nameEl = document.createElement('div');
      nameEl.className = 'spot-row-name';
      nameEl.textContent = t('spot_ask', 'Chiedi a Bit');
      const metaEl = document.createElement('div');
      metaEl.className = 'spot-row-meta';
      metaEl.textContent = phrase;
      mid.append(nameEl, metaEl);
      row.append(askFace(), mid);
      lastResults.push({ ask: true });
      const index = lastResults.length - 1;
      row.addEventListener('mouseenter', () => { if (hoverArmed && selIndex !== index) setSelected(index); });
      row.addEventListener('click', () => { void askBit(true); });
      listEl.appendChild(row);
      input.setAttribute('aria-expanded', 'true');
      // Alone in the list it is what Enter sends, and a send can spend Sparks: it shows.
      if (index === 0) setSelected(0, true);
    }

    function dropAskRow() {
      const row = listEl.querySelector('.spot-row-ask');
      if (!row) return;
      row.remove();
      lastResults.pop();
    }

    // Rows in labelled groups, in the order they are listed; the keyboard
    // walks them as one list.
    function renderGroups(groups, terms) {
      listEl.textContent = '';
      lastResults = [];
      selIndex = -1;
      hidePreview();
      for (const [key, fb, items] of groups) {
        if (!items.length) continue;
        const head = document.createElement('div');
        head.className = 'spot-group';
        head.setAttribute('role', 'presentation');
        head.textContent = t(key, fb);
        listEl.appendChild(head);
        for (const r of items) listEl.appendChild(buildRow(r, terms));
      }
      input.setAttribute('aria-expanded', lastResults.length ? 'true' : 'false');
      input.removeAttribute('aria-activedescendant');
    }

    function catalogName() {
      return window.XenonPlatform === 'darwin' ? 'Spotlight' : 'Windows Search';
    }

    function renderResults(out, terms) {
      setExpanded(true);
      if (out.index === 'building') {
        // The Living Index is still walking the roots: results flow from Windows
        // Search meanwhile, and get complete on their own within a minute.
        statusEl.textContent = t('spot_index_building', 'Sto imparando il disco… i risultati si completano da soli tra poco');
      } else if (out.wds === 'unsupported' && out.index !== 'ready') {
        // Not Windows. There is no catalog to have been turned off, so naming
        // one is both wrong and unactionable — the index IS the backend here,
        // and the only useful sentence points at the setting that starts it.
        statusEl.textContent = t('spot_index_off', 'Aggiungi una cartella in Impostazioni → Ricerca e disco per attivare la ricerca');
      } else if (out.wds === 'unavailable' && out.index !== 'ready') {
        statusEl.textContent = t('spot_wds_off', 'Windows Search è disattivato su questo PC: risultati limitati');
      } else if (!(out.apps || []).length && !(out.results || []).length && out.wds !== 'pending') {
        // With the Living Index ready, "no results" is the honest, complete
        // answer. The gap hint explains a possible omission only while the
        // search runs WITHOUT the index — and it has to name the right cause:
        // on Windows the catalog's coverage, elsewhere the index itself, which
        // is the only backend there.
        const none = t('spot_no_results', 'Nessun risultato');
        if (out.index === 'ready') statusEl.textContent = none;
        else if (out.wds === 'unsupported') {
          statusEl.textContent = none + '. ' + t('spot_index_off', 'Aggiungi una cartella in Impostazioni → Ricerca e disco per attivare la ricerca');
        } else {
          statusEl.textContent = none + '. ' + t('spot_no_results_hint', 'Windows non indicizza tutte le cartelle: aggiungi le tue in Impostazioni → Ricerca e disco');
        }
      } else {
        statusEl.textContent = '';
      }
      const apps = (out.apps || []).map((a) => ({ id: a.id, name: a.name, app: true }));
      const results = out.results || [];
      renderGroups([
        ['spot_group_apps', 'App', apps],
        ['spot_group_folders', 'Cartelle', results.filter((r) => r.kind === 'folder')],
        ['spot_group_files', 'File', results.filter((r) => r.kind !== 'folder' && !r.content)],
        ['spot_group_content', 'Nel contenuto', results.filter((r) => r.kind !== 'folder' && r.content)],
      ], terms);
      if (!lastResults.length && out.wds !== 'pending') noneFound();
      addAskRow();
    }

    function noneFound() {
      if (bit) bit.noResults(input.value.trim());
    }

    // The catalog's rows that arrived after the answer: added below, never
    // reshuffling what is already on screen (a row must not move under a
    // finger about to tap it).
    function appendCatalog(out, terms) {
      const have = new Set(lastResults.filter((r) => r.path).map((r) => r.path.toLowerCase()));
      const extra = (out.results || []).filter((r) => r.path && !have.has(r.path.toLowerCase()));
      if (!extra.length) {
        if (lastResults.every((r) => r.ask)) {
          statusEl.textContent = t('spot_no_results', 'Nessun risultato');
          noneFound();
        }
        return;
      }
      statusEl.textContent = '';
      // Bit's row stays last, and keeps the selection if it had it.
      const askSelected = !!(lastResults[selIndex] && lastResults[selIndex].ask);
      dropAskRow();
      const head = document.createElement('div');
      head.className = 'spot-group';
      head.setAttribute('role', 'presentation');
      head.textContent = t('spot_group_catalog', 'Anche da {name}').replace('{name}', catalogName());
      listEl.appendChild(head);
      for (const r of extra) listEl.appendChild(buildRow(r, terms));
      input.setAttribute('aria-expanded', 'true');
      addAskRow();
      if (askSelected) setSelected(lastResults.length - 1);
    }

    // ── Bit ──
    async function askBit(send) {
      const problem = await opts.onChat(input.value.trim(), send);
      if (problem) { setExpanded(true); statusEl.textContent = problem; return; }
      if (send) reset();
    }

    function openChat() {
      void bit.press().then(() => askBit(false));
    }

    // ── search plumbing ──
    function runSearch() {
      if (debTimer) { clearTimeout(debTimer); debTimer = null; }
      const q = input.value;
      if (!q.trim()) { disabled = {}; if (inflight) inflight.abort(); renderIdle(); return; }
      recentReq++;
      debTimer = setTimeout(async () => {
        debTimer = null;
        if (inflight) inflight.abort();
        const ctrl = new AbortController();
        inflight = ctrl;
        stateHost.classList.add('spot-loading');
        try {
          // 1024: a pasted path is often longer than a typed query.
          let url = '/search?q=' + encodeURIComponent(q.slice(0, 1024));
          if (Object.keys(disabled).length) url += '&disable=' + encodeURIComponent(JSON.stringify(disabled));
          const res = await fetch(url, { signal: ctrl.signal });
          const out = await res.json();
          if (ctrl !== inflight) return;   // a newer keystroke superseded this
          renderChips(out.chips);
          const terms = q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/\s+/).filter((s) => s.length >= 2);
          renderResults(out, terms);
          if (out.wds === 'pending') {
            // The index answered first; the catalog's rows (and the content
            // matches only it can find) follow on the same query.
            const more = await fetch(url + '&catalog=1', { signal: ctrl.signal }).then((r) => r.json()).catch(() => null);
            if (ctrl !== inflight || !more || !more.ok) return;
            appendCatalog(more, terms);
          }
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          setExpanded(true);
          statusEl.textContent = t('spot_error', 'Ricerca non disponibile');
        } finally {
          if (ctrl === inflight) { inflight = null; stateHost.classList.remove('spot-loading'); }
        }
      }, DEBOUNCE_MS);
    }

    opts.keyHost.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!filterMenu.hidden) { toggleFilters(false); return; }
        if (typeof opts.onClose === 'function') opts.onClose();
        return;
      }
      // Ctrl+I was the old way to ask Bit from here: it still is.
      if (opts.onChat && e.ctrlKey && !e.shiftKey && !e.altKey && /^[bi]$/i.test(e.key)) {
        e.preventDefault(); openChat(); return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(selIndex + 1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(selIndex - 1); return; }
      // Ctrl+C with nothing selected in the box copies the selected result's
      // path; with text selected it is the ordinary copy.
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')
        && selIndex >= 0 && input.selectionStart === input.selectionEnd) {
        e.preventDefault(); void copyPath(lastResults[selIndex]); return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const idx = selIndex >= 0 ? selIndex : 0;
        const r = lastResults[idx];
        const row = rowsOf()[idx];
        if (!r || !row) return;
        if (r.ask) { void askBit(true); return; }
        // Ctrl+Enter shows it in its folder instead of opening it.
        if (e.ctrlKey && !r.app) act('reveal', r, row);
        else act('open', r, row);
      }
    });

    // Fresh start (overlay open, widget Escape): clears text and pending work.
    function reset() {
      disabled = {};
      input.value = '';
      if (debTimer) { clearTimeout(debTimer); debTimer = null; }
      if (inflight) { inflight.abort(); inflight = null; }
      stateHost.classList.remove('spot-loading');
      filterMenu.hidden = true;
      filterBtn.classList.remove('is-on');
      renderIdle();
    }

    return {
      input,
      focus() { input.focus(); },
      // A line under the bar, for what a host has to tell.
      say(text) { setExpanded(true); statusEl.textContent = text; },
      reset,
      idle: () => idle,
      setQuery(q) { input.value = q || ''; runSearch(); },
      greet() { if (bit) bit.greet(); },
      // Stop pending work without touching the DOM (overlay close, tile teardown).
      stop() {
        if (debTimer) { clearTimeout(debTimer); debTimer = null; }
        if (inflight) { inflight.abort(); inflight = null; }
        if (bit) bit.stop();
        recentReq++;
      },
    };
  }

  // ── overlay shell (one createSearchUI instance) ──────────────────────────
  let onCloseNav = null;       // popup page: close = window.close

  // The popup page listens to this to grow/shrink its own window.
  function announceExpand(expanded) {
    try { window.dispatchEvent(new CustomEvent('spotlight-expand', { detail: { expanded } })); } catch {}
  }

  // A search tile on a widget layer has no chat of its own: the step goes to the
  // dashboard, or to Bit on the screen, the way a Deck key's does.
  async function chatFromLayer(text, send) {
    // Opening has no field to fill from here: the phrase stays on the bar, and its row sends it.
    const action = send ? { type: 'ai', mode: 'prompt', prompt: text } : { type: 'ai', mode: 'open' };
    try {
      const res = await fetch('/deck/client-step', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const out = await res.json().catch(() => null);
      if (out && out.ok) return '';
    } catch { /* said below */ }
    return t('spot_chat_failed', 'La chat non si è aperta, riprova');
  }

  function chatOnDashboard(text, send) {
    close();
    if (send && typeof window.aiAsk === 'function') { window.aiAsk(text); return; }
    window.DashboardOpen.run({ open: 'chat' });
    const field = document.getElementById('ai-text-input');
    if (!field) return;
    if (text) { field.value = text; field.dispatchEvent(new Event('input', { bubbles: true })); }
    field.focus();
  }

  // The search window has its own chat (spotlight-chat.js). On the dashboard the
  // overlay gives way to the chat already there, by the way the shell asks for it.
  function chatHandler() {
    if (window.SpotlightChat) return (text, send) => window.SpotlightChat.open(text, send);
    if (typeof isLayerPage === 'function' && isLayerPage()) return chatFromLayer;
    return window.DashboardOpen ? chatOnDashboard : null;
  }

  function build() {
    if (spotState.root) return spotState.root;
    spotState.root = document.createElement('div');
    spotState.root.className = 'spotlight';
    spotState.root.hidden = true;

    // One shell that IS the pill when closed and grows into the results panel
    // while typing — a single continuous rounded surface, Apple-style.
    spotState.shell = document.createElement('div');
    spotState.shell.className = 'spot-shell';
    spotState.ui = createSearchUI({
      host: spotState.shell,
      stateHost: spotState.root,
      keyHost: spotState.root,
      withClose: true,
      onClose: () => close(),
      onExpand: announceExpand,
      onOpened: () => close(),
      // The overlay is the user's own search on the PC: recents always, and
      // the image preview beside the list.
      showRecent: () => true,
      preview: true,
      onChat: chatHandler(),
    });
    spotState.root.appendChild(spotState.shell);

    // A tap on the frosted backdrop (outside the panel) closes.
    spotState.root.addEventListener('pointerdown', (e) => { if (e.target === spotState.root) close(); });

    document.body.appendChild(spotState.root);
    return spotState.root;
  }

  // ── open / close ─────────────────────────────────────────────────────────
  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  function open() {
    build();
    if (spotState.openState) { spotState.ui.focus(); return; }
    spotState.openState = true;
    spotState.root.hidden = false;
    spotState.root.classList.add('spot-open', 'spot-pop');
    setTimeout(() => spotState.root.classList.remove('spot-pop'), 350);
    if (window.ambientFreeze) window.ambientFreeze('spotlight', true);
    spotState.ui.reset();
    spotState.ui.focus();
    spotState.ui.greet();
    // Start the catalog host now, so the first query does not pay for it.
    fetch('/search?q=').catch(() => {});
  }

  // A new search in a window that stayed as it was left: no old text, no results.
  function fresh() {
    open();
    spotState.ui.reset();
    spotState.ui.focus();
  }

  function greet() {
    if (spotState.ui) spotState.ui.greet();
  }

  function openWithQuery(q) {
    open();
    if (q) spotState.ui.setQuery(q);
  }

  function close() {
    if (!spotState.openState || !spotState.root) return;
    spotState.openState = false;
    spotState.ui.stop();
    spotState.root.classList.remove('spot-open', 'spot-pop', 'spot-expanded', 'spot-loading');
    spotState.root.hidden = true;
    announceExpand(false);
    if (window.ambientFreeze) window.ambientFreeze('spotlight', false);
    if (typeof onCloseNav === 'function') onCloseNav();
  }

  const {
    attachGesture,
  } = window.SpotlightPullGesture({ PULL_OPEN_PX, PULL_START_PX, spotState, reducedMotion, open });

  // ── boot ─────────────────────────────────────────────────────────────────
  function init() {
    // A widget on the screen only borrows the search UI for its tile: the
    // overlay is not drawn there, so its gesture and Ctrl+Space would open an
    // invisible search (the global hotkey still opens the real one).
    if (typeof isLayerPage === 'function' && isLayerPage()) return;
    attachGesture();
    // Desktop keyboard path inside a dashboard tab: Ctrl+Space (the global
    // OS-level hotkey is the helper's job and opens the /spotlight popup).
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'Space') {
        e.preventDefault();
        if (spotState.openState) close(); else open();
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.Spotlight = {
    open, openWithQuery, close, fresh,
    say(text) { open(); spotState.ui.say(text); },
    toggle() { if (spotState.openState) close(); else open(); },
    isOpen() { return spotState.openState; },
    // The bar's empty state is in place, recents and all (or never came).
    idle() { return spotState.ui ? spotState.ui.idle() : Promise.resolve(); },
    createSearchUI,
    chatHandler,
    greet,
    _setCloseNav(fn) { onCloseNav = typeof fn === 'function' ? fn : null; },
  };
})();
