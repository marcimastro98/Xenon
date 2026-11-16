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
  const KIND_OF_EXT = {};
  for (const [kind, exts] of Object.entries({
    image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic', 'svg', 'tif', 'tiff'],
    video: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'm4v'],
    audio: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'wma'],
    doc: ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'md', 'rtf', 'odt', 'csv'],
    zip: ['zip', 'rar', '7z', 'tar', 'gz', 'iso'],
    exe: ['exe', 'msi', 'lnk', 'bat', 'cmd'],
  })) for (const e of exts) KIND_OF_EXT[e] = kind;

  const ICON_PATHS = {
    folder: 'M4 5h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
    image: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm1 12 4.5-5 3.5 4 2.5-3L20 16v2H5v-2Zm3.5-9A1.75 1.75 0 1 1 8.5 10.5 1.75 1.75 0 0 1 8.5 7Z',
    video: 'M4 5h11a1 1 0 0 1 1 1v3.5l5-3v11l-5-3V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
    audio: 'M9 4h2v12.6a3.4 3.4 0 1 1-2-3.1V4Zm5 2 6-2v10.6a3.4 3.4 0 1 1-2-3.1V7.5l-4 1.3V6Z',
    doc: 'M6 2h8l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm7 1.5V8h4.5L13 3.5ZM8 12h8v1.6H8V12Zm0 4h8v1.6H8V16Z',
    zip: 'M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm6 1v2h2V4h-2Zm0 3v2h2V7h-2Zm0 3v2h2v-2h-2Zm-1 3.5h4l1 4a3 3 0 1 1-6 0l1-4Z',
    exe: 'M12 2 4 6v6c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V6l-8-4Zm0 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z',
    file: 'M6 2h8l5 5v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm7 1.5V8h4.5L13 3.5Z',
    app: 'M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z',
  };

  function iconFor(r) {
    const ext = String(r.ext || '').toLowerCase();
    const kind = ext === '' ? 'folder' : (KIND_OF_EXT[ext] || 'file');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICON_PATHS[kind] || ICON_PATHS.file);
    svg.appendChild(path);
    svg.classList.add('spot-icon', 'spot-icon-' + kind);
    return svg;
  }

  // Real app logos: an app/exe/lnk result upgrades its generic glyph to the
  // real icon, fetched by opaque id from /search/icon and cached per app for
  // the session. Two races handled explicitly (both were live bugs — the icon
  // showed once, then a delete-and-retype pinned the glyph forever):
  //  * one fetch per key at a time; every re-render only re-registers the
  //    LATEST glyph element + result id, so the response lands on the row the
  //    user is looking at, not a disconnected one;
  //  * only SUCCESSES are cached. A late response for a stale id (evicted
  //    server-side between renders) must never overwrite a good icon with
  //    "no icon" — on an empty answer we retry once with the freshest id.
  // Shared across instances (overlay + widget tiles): the cache is per app,
  // not per surface.
  const appIcons = new Map();     // key → data URL (successes only)
  const appIconWait = new Map();  // key → { host, id } of the latest render
  // `force` is the synchronous cache-hit path: it runs while the row is still
  // being BUILT (it gets appended to the list at the end of the render loop),
  // so isConnected is false by construction there — the guard is only for
  // ASYNC responses, where a disconnected host means a superseded render.
  function swapIconInto(el, src, force) {
    if (!el || (!force && !el.isConnected)) return;
    const img = document.createElement('img');
    img.className = 'spot-icon spot-icon-app';
    img.alt = '';
    img.src = src;
    el.replaceWith(img);
  }
  function requestIcon(key, id) {
    fetch('/search/icon?id=' + encodeURIComponent(id))
      .then((res) => res.json())
      .then((out) => {
        const icon = out && out.ok && out.icon && String(out.icon).startsWith('data:image/') ? String(out.icon) : null;
        const wait = appIconWait.get(key);
        if (icon) {
          if (appIcons.size > 300) appIcons.clear();
          appIcons.set(key, icon);
          appIconWait.delete(key);
          if (wait) swapIconInto(wait.host, icon);
          return;
        }
        if (wait && wait.id !== id) { requestIcon(key, wait.id); return; }
        appIconWait.delete(key);
      })
      .catch(() => { appIconWait.delete(key); });
  }
  function upgradeAppIcon(r, host) {
    const ext = String(r.ext || '').toLowerCase();
    if (!r.app && ext !== 'exe' && ext !== 'lnk') return;
    const key = r.app ? 'app:' + (r.name || '') : (r.dir || '') + '\\' + (r.name || '');
    const hit = appIcons.get(key);
    if (hit) { swapIconInto(host, hit, true); return; }
    const pending = appIconWait.has(key);
    appIconWait.set(key, { host, id: r.id });
    if (!pending) requestIcon(key, r.id);
  }

  // Highlight query terms inside an UNTRUSTED file name without innerHTML:
  // split on the matches and append text nodes + <b> spans.
  function highlightName(name, terms) {
    const frag = document.createDocumentFragment();
    const lower = name.toLowerCase();
    const ranges = [];
    for (const term of terms || []) {
      const tl = String(term).toLowerCase();
      if (tl.length < 2) continue;
      let idx = lower.indexOf(tl);
      while (idx !== -1) { ranges.push([idx, idx + tl.length]); idx = lower.indexOf(tl, idx + 1); }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    let pos = 0;
    for (const [s, e] of ranges) {
      if (s < pos) continue;
      if (s > pos) frag.appendChild(document.createTextNode(name.slice(pos, s)));
      const b = document.createElement('b');
      b.textContent = name.slice(s, e);
      frag.appendChild(b);
      pos = e;
    }
    if (pos < name.length) frag.appendChild(document.createTextNode(name.slice(pos)));
    return frag;
  }

  // ── chips (the parser's interpretation, removable) ───────────────────────
  // ── filters the menu adds (as words the parser already understands) ───────

  const PREVIEW_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);
  let rowSeq = 0;

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
    const listId = 'spot-list-' + (++rowSeq);

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
    function renderIdle() {
      listEl.textContent = '';
      statusEl.textContent = '';
      chipsEl.textContent = '';
      chipsEl.hidden = true;
      lastResults = [];
      selIndex = -1;
      hidePreview();
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      if (!filterMenu.hidden) { setExpanded(true); return; }
      setExpanded(false);
      if (typeof opts.showRecent === 'function' && opts.showRecent()) void loadRecent();
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
      if (!groups.length) return;
      setExpanded(true);
      renderGroups(groups, []);
    }

    // ── results ──
    function rowsOf() { return listEl.querySelectorAll('.spot-row'); }

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
      row.addEventListener('mouseenter', () => { if (selIndex !== index) setSelected(index); });
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
      row.addEventListener('mouseenter', () => { if (selIndex !== index) setSelected(index); });
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
  let root = null;             // overlay element (built lazily)
  let shell = null;            // the pill/panel that expands while typing
  let ui = null;               // the overlay's search surface
  let openState = false;
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
    if (root) return root;
    root = document.createElement('div');
    root.className = 'spotlight';
    root.hidden = true;

    // One shell that IS the pill when closed and grows into the results panel
    // while typing — a single continuous rounded surface, Apple-style.
    shell = document.createElement('div');
    shell.className = 'spot-shell';
    ui = createSearchUI({
      host: shell,
      stateHost: root,
      keyHost: root,
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
    root.appendChild(shell);

    // A tap on the frosted backdrop (outside the panel) closes.
    root.addEventListener('pointerdown', (e) => { if (e.target === root) close(); });

    document.body.appendChild(root);
    return root;
  }

  // ── open / close ─────────────────────────────────────────────────────────
  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  }

  function open() {
    build();
    if (openState) { ui.focus(); return; }
    openState = true;
    root.hidden = false;
    root.classList.add('spot-open', 'spot-pop');
    setTimeout(() => root.classList.remove('spot-pop'), 350);
    if (window.ambientFreeze) window.ambientFreeze('spotlight', true);
    ui.reset();
    ui.focus();
    ui.greet();
    // Start the catalog host now, so the first query does not pay for it.
    fetch('/search?q=').catch(() => {});
  }

  // A new search in a window that stayed as it was left: no old text, no results.
  function fresh() {
    open();
    ui.reset();
    ui.focus();
  }

  function greet() {
    if (ui) ui.greet();
  }

  function openWithQuery(q) {
    open();
    if (q) ui.setQuery(q);
  }

  function close() {
    if (!openState || !root) return;
    openState = false;
    ui.stop();
    root.classList.remove('spot-open', 'spot-pop', 'spot-expanded', 'spot-loading');
    root.hidden = true;
    announceExpand(false);
    if (window.ambientFreeze) window.ambientFreeze('spotlight', false);
    if (typeof onCloseNav === 'function') onCloseNav();
  }

  // ── pull-down gesture: the island itself melts into a droplet ────────────
  // Apple-style choreography in three phases, driven per-frame from the
  // pointer (CSS vars + transforms only — no layout thrash):
  //   1. STRETCH  (0 → DETACH_AT of the threshold): the capsule itself is the
  //      liquid — it stretches down (scaleY + translateY via --spot-pull,
  //      composing with the island's own --mini-tx anchor) while a bulge
  //      swells out of its bottom edge under the finger, connected by a neck.
  //   2. PINCH-OFF (past DETACH_AT): the capsule springs back with an elastic
  //      overshoot and the bulge detaches as a free teardrop that follows the
  //      finger (x smoothed, so it trails like a real drop).
  //   3. COMMIT / ABSORB: enough pull → the drop glides into the pill's
  //      resting rect and becomes the search bar. Short pull → the drop flies
  //      back to the detach point and the capsule absorbs it with a bounce.
  // Horizontal drags and plain taps are untouched: the gesture claims the
  // pointer only after clearly vertical movement.
  const DETACH_AT = 0.4;         // fraction of PULL_OPEN_PX where the drop pinches off
  let pull = null;               // { x, y, id, active, zone, zoneRect, detached, cx }
  let dropEl = null;

  function ensureDrop() {
    if (dropEl) return dropEl;
    dropEl = document.createElement('div');
    dropEl.className = 'spot-drop';
    dropEl.hidden = true;
    document.body.appendChild(dropEl);
    return dropEl;
  }

  // Where the shell rests once open — the drop glides to this rect.
  function shellRestRect() {
    const w = Math.min(620, window.innerWidth - 48);
    const top = Math.min(window.innerHeight * (window.innerHeight <= 760 ? 0.09 : 0.26), 220);
    return { left: (window.innerWidth - w) / 2, top, width: w, height: 62 };
  }

  function zoneStretch(zone, p) {
    zone.classList.add('spot-zone-stretch');
    zone.classList.remove('spot-zone-return', 'spot-zone-absorb');
    zone.style.setProperty('--spot-pull', String(p));
  }
  function zoneRelease(zone, absorb) {
    zone.classList.remove('spot-zone-stretch');
    zone.classList.add(absorb ? 'spot-zone-absorb' : 'spot-zone-return');
    zone.style.setProperty('--spot-pull', '0');
    setTimeout(() => zone.classList.remove('spot-zone-return', 'spot-zone-absorb'), 450);
  }

  function attachGesture() {
    document.addEventListener('pointerdown', (e) => {
      if (openState) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const zone = e.target && e.target.closest && e.target.closest('.topbar, #topbar-mini');
      if (!zone) return;
      pull = { x: e.clientX, y: e.clientY, id: e.pointerId, active: false, zone, zoneRect: zone.getBoundingClientRect(), detached: false, cx: e.clientX };
    });

    window.addEventListener('pointermove', (e) => {
      if (!pull || e.pointerId !== pull.id) return;
      const dy = e.clientY - pull.y;
      const dx = Math.abs(e.clientX - pull.x);
      if (!pull.active) {
        if (dy > PULL_START_PX && dy > dx * 1.5) {
          pull.active = true;
          if (reducedMotion()) return;
          const d = ensureDrop();
          d.className = 'spot-drop spot-drop-attached';
          d.hidden = false;
          d.style.borderRadius = '50% / 44% 56%';
          pull.cx = Math.max(pull.zoneRect.left + 24, Math.min(pull.zoneRect.right - 24, e.clientX));
        } else if (dx > 24 || dy < -PULL_START_PX) {
          pull = null; // horizontal or upward: not ours
        }
        return;
      }
      e.preventDefault();
      if (reducedMotion()) return;

      // ONE continuous model for the whole drag: the drop's size and position
      // are the same functions of progress before and after the pinch-off, so
      // that moment changes ownership (capsule → finger) without any jump —
      // the v1 two-formula split popped visibly right at the detach point.
      const drag = Math.max(0, dy);
      const p = Math.min(1, drag / PULL_OPEN_PX);
      const ease = 1 - Math.pow(1 - p, 2);
      const zr = pull.zoneRect;
      const w = 42 + ease * 24;
      const h = 14 + ease * 46;

      if (!pull.detached && p >= DETACH_AT) {
        // Pinch-off: the capsule springs back elastic; the drop is free now.
        pull.detached = true;
        zoneRelease(pull.zone, false);
        dropEl.classList.remove('spot-drop-attached');
      }

      // The drop rides just under the fingertip (slight lag — a drop trails,
      // it doesn't teleport), clamped onto the capsule while still attached.
      const tx = pull.detached ? e.clientX : Math.max(zr.left + 24, Math.min(zr.right - 24, e.clientX));
      pull.cx += (tx - pull.cx) * (pull.detached ? 0.3 : 0.5);
      const bottom = zr.bottom + drag * 0.8;
      dropEl.style.width = w + 'px';
      dropEl.style.height = h + 'px';
      dropEl.style.left = (pull.cx - w / 2) + 'px';
      dropEl.style.top = (bottom - h) + 'px';

      if (!pull.detached) {
        // Still one body: stretch the capsule gently and keep a thinning neck
        // bridging its bottom edge and the drop (the neck is the ::before,
        // sized by these vars — it covers whatever gap the pull opens).
        const local = p / DETACH_AT;
        zoneStretch(pull.zone, local);
        const gap = Math.max(0, (bottom - h) - (zr.bottom + local * 6));
        dropEl.style.setProperty('--neck-h', (gap + 10).toFixed(1) + 'px');
        dropEl.style.setProperty('--neck-w', (30 - local * 14).toFixed(1) + 'px');
      }
      dropEl.classList.toggle('spot-drop-ready', drag >= PULL_OPEN_PX);
    }, { passive: false });

    const finish = (e) => {
      if (!pull || (e.pointerId != null && e.pointerId !== pull.id)) return;
      const wasActive = pull.active;
      const dy = wasActive ? (e.clientY - pull.y) : 0;
      const zone = pull.zone;
      const zr = pull.zoneRect;
      const detached = pull.detached;
      const cx = pull.cx;
      pull = null;
      if (!wasActive) return;
      if (reducedMotion()) {
        if (dy >= PULL_OPEN_PX && !openState) open();
        return;
      }
      if (!dropEl) return;
      if (dy >= PULL_OPEN_PX && !openState) {
        // Phase 3 (commit): the drop glides into the pill's resting place and
        // BECOMES the search bar; the shell fades in underneath it.
        if (!detached) zoneRelease(zone, false);
        const rest = shellRestRect();
        dropEl.classList.remove('spot-drop-ready', 'spot-drop-attached');
        dropEl.classList.add('spot-drop-commit');
        dropEl.style.left = rest.left + 'px';
        dropEl.style.top = rest.top + 'px';
        dropEl.style.width = rest.width + 'px';
        dropEl.style.height = rest.height + 'px';
        dropEl.style.borderRadius = '18px';
        const d = dropEl;
        setTimeout(() => {
          open();
          setTimeout(() => { d.hidden = true; d.classList.remove('spot-drop-commit'); }, 160);
        }, 220);
      } else {
        // Phase 3 (absorb): surface tension wins — the drop flies back to the
        // capsule's bottom edge and the capsule swallows it with a bounce.
        dropEl.classList.remove('spot-drop-ready', 'spot-drop-attached');
        dropEl.classList.add('spot-drop-retract');
        const backX = Math.max(zr.left + 26, Math.min(zr.right - 26, cx));
        dropEl.style.left = (backX - 11) + 'px';
        dropEl.style.top = (zr.bottom - 12) + 'px';
        dropEl.style.width = '22px';
        dropEl.style.height = '10px';
        dropEl.style.borderRadius = '50%';
        const d = dropEl;
        setTimeout(() => {
          zoneRelease(zone, true); // the absorb bounce fires as the drop lands
          setTimeout(() => { d.hidden = true; d.classList.remove('spot-drop-retract'); }, 60);
        }, 170);
      }
    };
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

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
        if (openState) close(); else open();
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.Spotlight = {
    open, openWithQuery, close, fresh,
    say(text) { open(); ui.say(text); },
    toggle() { if (openState) close(); else open(); },
    isOpen() { return openState; },
    createSearchUI,
    chatHandler,
    greet,
    _setCloseNav(fn) { onCloseNav = typeof fn === 'function' ? fn : null; },
  };
})();
