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
// The whole search surface (bar, chips, status, results, AI mode) is built by
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
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  const DEBOUNCE_MS = 180;
  const PULL_OPEN_PX = 150;    // drag distance that commits the open (short pulls = just the effect)
  const PULL_START_PX = 16;    // vertical movement before the gesture claims the pointer

  // ── tiny formatters ──────────────────────────────────────────────────────
  function fmtSize(n) {
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let v = n, i = -1;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v >= 10 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
  }
  // Dates follow the dashboard's language, not the browser's: an English Xenon
  // on an Italian Windows was labelling a chip "dicembre 2025". Guarded because
  // t() echoes the key back when a dict is missing it, and a bogus locale tag
  // makes toLocaleDateString throw.
  function dateLocale() {
    const l = t('locale', '');
    return /^[a-z]{2}(-[A-Za-z0-9]{2,8})*$/.test(l) ? l : undefined;
  }
  function fmtDate(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const d = new Date(ms), now = new Date();
    const days = Math.floor((now - d) / 86400000);
    if (days <= 0) return t('spot_today', 'oggi');
    if (days === 1) return t('spot_yesterday', 'ieri');
    if (days < 30) return days + ' ' + t('spot_days_ago', 'giorni fa');
    return d.toLocaleDateString(dateLocale());
  }
  function shortDir(dir) {
    return String(dir || '').replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~');
  }

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
  function chipLabel(c) {
    if (c.type === 'kind') {
      return t('spot_kind_' + c.kind, { image: 'Foto', video: 'Video', audio: 'Musica', document: 'Documenti', archive: 'Archivi' }[c.kind] || c.kind);
    }
    if (c.type === 'ext') return (c.exts || []).map((e) => '.' + e).join(' ');
    if (c.type === 'size') return (c.dir === 'min' ? '≥ ' : '≤ ') + fmtSize(c.bytes);
    if (c.type === 'date') {
      const K = {
        today: t('spot_today', 'oggi'), yesterday: t('spot_yesterday', 'ieri'),
        thisWeek: t('spot_this_week', 'questa settimana'), lastWeek: t('spot_last_week', 'settimana scorsa'),
        thisMonth: t('spot_this_month', 'questo mese'), lastMonth: t('spot_last_month', 'mese scorso'),
        thisYear: t('spot_this_year', 'quest’anno'), lastYear: t('spot_last_year', 'anno scorso'),
        recent: t('spot_recent', 'recenti'),
      };
      if (K[c.key]) return K[c.key];
      if (c.key === 'month') {
        const d = new Date(c.year, c.month, 1);
        return d.toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' });
      }
      if (c.key === 'year') return String(c.year);
      if (c.key === 'lastN') return t('spot_last_n', 'ultimi') + ' ' + c.n + ' ' + t('spot_unit_' + c.unit, c.unit);
      if (c.key === 'range') {
        // AI-produced explicit date bounds: shown as plain local dates.
        const f = (ms) => new Date(ms).toLocaleDateString(dateLocale());
        if (c.after != null && c.before != null) return f(c.after) + ' – ' + f(c.before);
        if (c.after != null) return t('spot_from', 'dal') + ' ' + f(c.after);
        if (c.before != null) return t('spot_until', 'fino al') + ' ' + f(c.before);
      }
      return '';
    }
    return '';
  }

  // ── filters the menu adds (as words the parser already understands) ───────
  // A filter is typed into the query rather than kept apart, so it shows as the
  // same removable chip a typed "foto" or "questo mese" does, and the query
  // stays one string the user can read and edit. The parser speaks Italian and
  // English; other languages get the English words.
  const FILTER_WORDS = {
    it: { image: 'foto', video: 'video', audio: 'musica', document: 'documenti', archive: 'archivi',
      today: 'oggi', week: 'questa settimana', month: 'questo mese', year: "quest'anno",
      big: 'più di 100 mb', huge: 'più di 1 gb' },
    en: { image: 'photos', video: 'videos', audio: 'music', document: 'documents', archive: 'archives',
      today: 'today', week: 'this week', month: 'this month', year: 'this year',
      big: 'more than 100 mb', huge: 'more than 1 gb' },
  };
  function filterWords() {
    // `lang` is i18n.js's global (a script-level let, not a window property).
    const l = typeof lang !== 'undefined' ? lang : 'en';
    return FILTER_WORDS[l === 'it' ? 'it' : 'en'];
  }
  const FILTER_GROUPS = [
    ['spot_filter_type', 'Tipo', [['image', 'spot_kind_image', 'Foto'], ['video', 'spot_kind_video', 'Video'], ['audio', 'spot_kind_audio', 'Musica'], ['document', 'spot_kind_document', 'Documenti'], ['archive', 'spot_kind_archive', 'Archivi']]],
    ['spot_filter_date', 'Modificati', [['today', 'spot_today', 'oggi'], ['week', 'spot_this_week', 'questa settimana'], ['month', 'spot_this_month', 'questo mese'], ['year', 'spot_this_year', 'quest’anno']]],
    ['spot_filter_size', 'Dimensione', [['big', 'spot_filter_big', 'Oltre 100 MB'], ['huge', 'spot_filter_huge', 'Oltre 1 GB']]],
  ];

  const PREVIEW_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);
  let rowSeq = 0;

  // ── the search surface factory ───────────────────────────────────────────
  // Builds the bar (glass, input, filters, AI sparkle, optional ×) + body
  // (chips, status, results) into opts.host and wires the whole engine with
  // per-instance state. Used twice: the overlay below, and the Search widget
  // tile (via window.Spotlight.createSearchUI).
  //   opts.host       element receiving .spot-bar + .spot-body
  //   opts.stateHost  element carrying the state classes (spot-expanded,
  //                   spot-loading, spot-ai, spot-ai-thinking) — the overlay
  //                   root or the widget's own container
  //   opts.keyHost    element the keydown handler attaches to
  //   opts.withClose  build the × button (overlay only)
  //   opts.onClose    Escape / × (overlay closes; the widget clears)
  //   opts.onExpand   expanded-state change (the popup resizes its window on it)
  //   opts.onOpened   a file was successfully opened (overlay closes; widget stays)
  //   opts.showRecent () => boolean: the empty search lists recent files (the
  //                   overlay always; the tile only with its setting on)
  //   opts.preview    show an image preview beside the list (overlay only)
  function createSearchUI(opts) {
    const stateHost = opts.stateHost;
    let debTimer = null;
    let inflight = null;         // AbortController of the running fetch
    let lastResults = [];
    let selIndex = -1;
    let disabled = {};           // chip dimensions the user removed this session
    // AI mode: the phrase goes to the configured Xenon AI provider ON ENTER
    // (never per keystroke — that would burn quota on every letter) and comes
    // back as the same structured filter the offline parser produces.
    let aiMode = false;
    let aiRanFor = null;         // last phrase the AI searched; Enter re-runs only on change
    let aiNotice = '';           // one-shot status line shown with the next results
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
    input.placeholder = t('spot_placeholder', 'Cerca sul PC…');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', listId);
    input.setAttribute('aria-autocomplete', 'list');
    input.addEventListener('input', () => {
      disabled = {};
      if (aiMode) {
        // AI mode searches on Enter only. While editing, keep whatever is on
        // screen and just remind how to run.
        aiRanFor = null;
        if (!input.value.trim()) { renderIdle(); return; }
        setExpanded(true);
        statusEl.textContent = t('spot_ai_hint', 'Premi Invio: l’AI interpreta la frase');
        return;
      }
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

    // AI mode toggle: the sparkle. Ctrl+I flips it too.
    const aiBtn = document.createElement('button');
    aiBtn.type = 'button';
    aiBtn.className = 'spot-ai-toggle';
    aiBtn.title = t('spot_ai_toggle', 'Ricerca intelligente (Ctrl+I)');
    aiBtn.setAttribute('aria-pressed', 'false');
    const spark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    spark.setAttribute('viewBox', '0 0 24 24');
    spark.setAttribute('aria-hidden', 'true');
    const sp1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    sp1.setAttribute('d', 'M10 2l2 5.6L17.6 9.6 12 11.6 10 17.2 8 11.6 2.4 9.6 8 7.6 10 2Z');
    const sp2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    sp2.setAttribute('d', 'M18.5 13l1.2 3.3L23 17.5l-3.3 1.2L18.5 22l-1.2-3.3L14 17.5l3.3-1.2L18.5 13Z');
    spark.append(sp1, sp2);
    aiBtn.appendChild(spark);
    aiBtn.addEventListener('click', () => setAiMode(!aiMode));
    bar.append(glass, input, filterBtn, aiBtn);
    if (opts.withClose) {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'spot-close';
      closeBtn.textContent = '×';
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
      if (aiMode) setAiMode(false);
      else runSearch();
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
    function renderChips(chips, fixed) {
      chipsEl.textContent = '';
      for (const c of chips || []) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'spot-chip spot-chip-' + c.type + (fixed ? ' spot-chip-fixed' : '');
        const label = document.createElement('span');
        label.textContent = chipLabel(c);
        chip.appendChild(label);
        if (!fixed) {
          // Offline-parser chips are removable; AI chips only DISPLAY the
          // interpretation (rephrasing is the correction path there).
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
        }
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

    function setSelected(i) {
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
      if (aiNotice) {
        // One-shot notice (e.g. "AI unavailable, standard search") shown WITH
        // the results it applies to, then cleared.
        statusEl.textContent = statusEl.textContent ? aiNotice + ' · ' + statusEl.textContent : aiNotice;
        aiNotice = '';
      }
      const apps = (out.apps || []).map((a) => ({ id: a.id, name: a.name, app: true }));
      const results = out.results || [];
      renderGroups([
        ['spot_group_apps', 'App', apps],
        ['spot_group_folders', 'Cartelle', results.filter((r) => r.kind === 'folder')],
        ['spot_group_files', 'File', results.filter((r) => r.kind !== 'folder' && !r.content)],
        ['spot_group_content', 'Nel contenuto', results.filter((r) => r.kind !== 'folder' && r.content)],
      ], terms);
    }

    // The catalog's rows that arrived after the answer: added below, never
    // reshuffling what is already on screen (a row must not move under a
    // finger about to tap it).
    function appendCatalog(out, terms) {
      const have = new Set(lastResults.filter((r) => r.path).map((r) => r.path.toLowerCase()));
      const extra = (out.results || []).filter((r) => r.path && !have.has(r.path.toLowerCase()));
      if (!extra.length) {
        if (!lastResults.length) statusEl.textContent = t('spot_no_results', 'Nessun risultato');
        return;
      }
      statusEl.textContent = '';
      const head = document.createElement('div');
      head.className = 'spot-group';
      head.setAttribute('role', 'presentation');
      head.textContent = t('spot_group_catalog', 'Anche da {name}').replace('{name}', catalogName());
      listEl.appendChild(head);
      for (const r of extra) listEl.appendChild(buildRow(r, terms));
      input.setAttribute('aria-expanded', 'true');
    }

    // ── AI mode ──
    function setAiMode(on) {
      aiMode = !!on;
      aiRanFor = null;
      stateHost.classList.toggle('spot-ai', aiMode);
      stateHost.classList.remove('spot-ai-thinking');
      aiBtn.classList.toggle('is-on', aiMode);
      aiBtn.setAttribute('aria-pressed', aiMode ? 'true' : 'false');
      input.placeholder = aiMode
        ? t('spot_ai_placeholder', 'Descrivi cosa cerchi…')
        : t('spot_placeholder', 'Cerca sul PC…');
      if (aiMode) {
        // No per-keystroke searches in AI mode: stop whatever is running and
        // wait for Enter.
        if (debTimer) { clearTimeout(debTimer); debTimer = null; }
        if (inflight) { inflight.abort(); inflight = null; }
        stateHost.classList.remove('spot-loading');
        if (input.value.trim()) {
          setExpanded(true);
          statusEl.textContent = t('spot_ai_hint', 'Premi Invio: l’AI interpreta la frase');
        }
      } else if (input.value.trim()) {
        runSearch();
      } else {
        renderIdle();
      }
      input.focus();
    }

    // One phrase → one provider round-trip → the same structured filter the
    // offline parser produces, executed by the same engine. Any failure
    // degrades to the offline parse with an honest notice, never a dead end.
    async function runAiSearch() {
      const q = input.value.trim();
      if (!q) return;
      if (debTimer) { clearTimeout(debTimer); debTimer = null; }
      if (inflight) inflight.abort();
      const ctrl = new AbortController();
      inflight = ctrl;
      aiRanFor = q;
      stateHost.classList.add('spot-loading', 'spot-ai-thinking');
      setExpanded(true);
      statusEl.textContent = t('spot_ai_thinking', 'L’AI sta interpretando…');
      try {
        const res = await fetch('/search/ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: q.slice(0, 300) }),
          signal: ctrl.signal,
        });
        const out = await res.json().catch(() => ({}));
        if (ctrl !== inflight) return;
        if (!out || !out.ok) {
          aiNotice = t('spot_ai_fallback', 'AI non disponibile: uso la ricerca normale');
          aiRanFor = null;
          runSearch();
          return;
        }
        renderChips(out.chips, true);
        renderResults(out, out.terms || []);
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        statusEl.textContent = t('spot_error', 'Ricerca non disponibile');
      } finally {
        if (ctrl === inflight) {
          inflight = null;
          stateHost.classList.remove('spot-loading', 'spot-ai-thinking');
        }
      }
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
          let url = '/search?q=' + encodeURIComponent(q.slice(0, 200));
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
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault(); setAiMode(!aiMode); return;
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
        // AI mode: the first Enter on a (new) phrase runs the AI search; with
        // results already on screen for it, Enter opens the selection.
        if (aiMode && input.value.trim() && input.value.trim() !== aiRanFor) { runAiSearch(); return; }
        const idx = selIndex >= 0 ? selIndex : 0;
        const r = lastResults[idx];
        const row = rowsOf()[idx];
        if (!r || !row) return;
        // Ctrl+Enter shows it in its folder instead of opening it.
        if (e.ctrlKey && !r.app) act('reveal', r, row);
        else act('open', r, row);
      }
    });

    return {
      input,
      focus() { input.focus(); },
      // Fresh start (overlay open, widget Escape): clears text and pending
      // work; the AI mode CHOICE persists, like the overlay always did.
      reset() {
        disabled = {};
        aiRanFor = null;
        input.value = '';
        if (debTimer) { clearTimeout(debTimer); debTimer = null; }
        if (inflight) { inflight.abort(); inflight = null; }
        stateHost.classList.remove('spot-loading', 'spot-ai-thinking');
        filterMenu.hidden = true;
        filterBtn.classList.remove('is-on');
        renderIdle();
      },
      setQuery(q) { input.value = q || ''; runSearch(); },
      // Stop pending work without touching the DOM (overlay close, tile teardown).
      stop() {
        if (debTimer) { clearTimeout(debTimer); debTimer = null; }
        if (inflight) { inflight.abort(); inflight = null; }
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
    // Start the catalog host now, so the first query does not pay for it.
    fetch('/search?q=').catch(() => {});
  }

  function openWithQuery(q) {
    open();
    if (q) ui.setQuery(q);
  }

  function close() {
    if (!openState || !root) return;
    openState = false;
    ui.stop();
    root.classList.remove('spot-open', 'spot-pop', 'spot-expanded', 'spot-loading', 'spot-ai-thinking');
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
    open, openWithQuery, close,
    toggle() { if (openState) close(); else open(); },
    isOpen() { return openState; },
    createSearchUI,
    _setCloseNav(fn) { onCloseNav = typeof fn === 'function' ? fn : null; },
  };
})();
