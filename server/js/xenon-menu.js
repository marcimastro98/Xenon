'use strict';

// The Xenon menu's view (plan §20): one renderer for both places, the page over
// the main screen (menu.html, js/screen-menu-page.js) and the dashboard panel
// (js/xenon-menu-panel.js). The rows come from the server (GET /xenon-menu,
// server/xenon-menu.js); every change goes through POST /actions/run, the same
// capability a Deck key or Bit would use, then the menu reads itself again.
// Verbs that move elsewhere (gallery, Settings, dashboard, Bit) go back to the
// place through `onOpen`, because only it knows how to get there.
// Every text is set with textContent; no inline styles.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XenonMenuView = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const CLOSE_FIRST_MS = 300;   // a closing row runs once the menu is off the screen
  const ERROR_FOR_MS = 6000;
  const REFRESH_DELAY_MS = 250;
  // What can change a row while the menu is open: settings (widgets, keys,
  // look, mode), captures, the replay and recording state, the Deck's keys.
  const LIVE_EVENTS = ['settings', 'captures', 'replay', 'recording', 'deck', 'screen_menu'];

  // ── Pure helpers (tested in node) ──────────────────────────────
  function fill(str, vars) {
    return String(str).replace(/\{(\w+)\}/g, (m, name) => (vars && vars[name] != null ? String(vars[name]) : m));
  }

  // A row text: { key, vars }, { text }, or a list of those joined by commas.
  function text(x, tt) {
    if (!x) return '';
    if (Array.isArray(x)) return x.map((y) => text(y, tt)).filter(Boolean).join(', ');
    if (typeof x.text === 'string') return x.text;
    if (typeof x.key === 'string') return fill(tt(x.key), x.vars);
    return '';
  }

  // The sections as this place shows them: rows only the screen can run
  // (`screenOnly`) leave the dashboard panel.
  function sectionsFor(data, place) {
    const list = (data && Array.isArray(data.sections)) ? data.sections : [];
    return list.map((s) => ({
      ...s,
      rows: (Array.isArray(s.rows) ? s.rows : []).filter((r) => r && !(r.screenOnly && place !== 'screen')),
    }));
  }

  // ── The view ───────────────────────────────────────────────────
  function create(rootEl, opts = {}) {
    const doc = rootEl.ownerDocument;
    const place = opts.place === 'screen' ? 'screen' : 'dashboard';
    const server = typeof opts.server === 'string' ? opts.server : '';
    const tt = typeof opts.t === 'function' ? opts.t : (k) => k;
    const Icons = (typeof window !== 'undefined' && window.XenonMenuIcons) || null;
    let data = null;
    let section = 'now';
    let busy = false;
    let recording = null;   // { row, btn } while a key row waits for keys
    let errorTimer = 0;
    let errorText = '';   // kept so a redraw right after a failed act still shows it
    let loadSeq = 0;
    let addOpen = false;
    let addFilter = '';
    let refreshTimer = 0;
    let es = null;

    const el = (tag, cls, txt) => {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (txt != null) n.textContent = txt;
      return n;
    };
    const icon = (name) => (Icons ? Icons.make(doc, name) : null);
    const button = (cls, label) => {
      const b = el('button', cls, label);
      b.type = 'button';
      return b;
    };

    rootEl.classList.add('xm');
    rootEl.dataset.place = place;
    const nav = el('nav', 'xm-nav');
    nav.setAttribute('aria-label', tt('xmenu_title'));
    const main = el('section', 'xm-main');
    main.setAttribute('aria-live', 'polite');
    rootEl.replaceChildren(nav, main);

    // ── Acts ──
    async function post(path, body) {
      const res = await fetch(server + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return res.json().catch(() => null);
    }

    function showError(code) {
      const D = typeof window !== 'undefined' && window.DeckErrorText;
      const msg = D && typeof D.describe === 'function' ? D.describe(code, tt) : String(code || '');
      errorText = fill(tt('xmenu_failed'), { why: msg });
      clearTimeout(errorTimer);
      errorTimer = setTimeout(() => {
        errorText = '';
        const box = main.querySelector('.xm-error');
        if (box) box.hidden = true;
      }, ERROR_FOR_MS);
      paintError(main.querySelector('.xm-error'));
    }

    function paintError(box) {
      if (!box) return;
      box.textContent = errorText;
      box.hidden = !errorText;
    }

    async function perform(row, act) {
      if (!act || busy) return;
      if (row && row.closes && typeof opts.onClose === 'function') {
        opts.onClose();
        await new Promise((r) => setTimeout(r, CLOSE_FIRST_MS));
      }
      if (act.open) {
        if (typeof opts.onOpen === 'function') opts.onOpen(act.open);
        return;
      }
      if (!act.run) return;
      busy = true;
      rootEl.classList.add('is-busy');
      try {
        const r = await post('/actions/run', act.run);
        if (!r || r.ok === false) showError((r && r.error) || 'unavailable');
      } catch (e) {
        showError('unavailable');
      } finally {
        busy = false;
        rootEl.classList.remove('is-busy');
      }
      if (!(row && row.closes)) load();
    }

    // ── Rows ──
    function rowShell(r, cls) {
      const li = el('div', 'xm-row' + (cls ? ' ' + cls : ''));
      li.dataset.row = r.id;
      const words = el('div', 'xm-words');
      words.appendChild(el('span', 'xm-label', text(r.label, tt)));
      const sub = text(r.sub, tt);
      if (sub) words.appendChild(el('span', 'xm-sub', sub));
      li.appendChild(words);
      return li;
    }

    function drawTile(r) {
      const b = button('xm-tile');
      b.dataset.row = r.id;
      const ic = icon(r.icon);
      if (ic) b.appendChild(ic);
      b.appendChild(el('span', 'xm-tile-label', text(r.label, tt)));
      if (r.combo) b.appendChild(el('span', 'xm-tile-key', r.combo));
      b.addEventListener('click', () => perform(r, r.act));
      return b;
    }

    function drawStatus(r) {
      const li = rowShell(r, 'xm-tone-' + (r.tone || 'none'));
      li.appendChild(el('span', 'xm-value', text(r.value, tt)));
      if (r.act) {
        const b = button('ui-btn ui-btn--secondary xm-act', text(r.button, tt) || tt('xmenu_open'));
        b.addEventListener('click', () => perform(r, r.act));
        li.appendChild(b);
      }
      return li;
    }

    function drawToggle(r) {
      const li = rowShell(r);
      const sw = el('label', 'ui-toggle xm-switch');
      const input = el('input');
      input.type = 'checkbox';
      input.setAttribute('role', 'switch');
      input.checked = r.on === true;
      input.setAttribute('aria-label', text(r.label, tt));
      const acts = r.acts || {};
      input.disabled = !(r.on ? acts.off : acts.on);
      input.addEventListener('change', () => perform(r, input.checked ? acts.on : acts.off));
      sw.append(input, el('span', 'ui-toggle-track'));
      li.appendChild(sw);
      return li;
    }

    function drawChoice(r) {
      const li = rowShell(r, 'xm-row--stack');
      const group = el('div', 'xm-choices');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', text(r.label, tt));
      for (const o of r.options || []) {
        const b = button('xm-choice', text(o.label, tt));
        const on = String(o.value) === String(r.value);
        b.setAttribute('aria-pressed', String(on));
        b.addEventListener('click', () => { if (!on) perform(r, o.act); });
        group.appendChild(b);
      }
      li.appendChild(group);
      return li;
    }

    function drawWidget(r) {
      const li = rowShell(r);
      li.querySelector('.xm-words').appendChild(el('span', 'xm-sub', text(r.value, tt)));
      const b = button('ui-btn ui-btn--secondary xm-act', tt('xmenu_remove'));
      b.addEventListener('click', () => perform(r, r.act));
      li.appendChild(b);
      return li;
    }

    function drawMode(r) {
      const li = rowShell(r, 'xm-row--stack');
      const group = el('div', 'xm-modes');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', text(r.label, tt));
      for (const o of r.options || []) {
        const b = button('xm-mode');
        const on = o.value === r.value;
        b.setAttribute('aria-pressed', String(on));
        b.append(el('span', 'xm-mode-name', text(o.label, tt)), el('span', 'xm-sub', text(o.sub, tt)));
        b.addEventListener('click', () => { if (!on) perform(r, o.act); });
        group.appendChild(b);
      }
      li.appendChild(group);
      return li;
    }

    function drawButton(r) {
      const li = rowShell(r, 'xm-row--button');
      const b = button('ui-btn ' + (r.primary ? 'ui-btn--primary' : 'ui-btn--secondary') + ' xm-act', text(r.label, tt));
      li.querySelector('.xm-label').hidden = true;
      b.addEventListener('click', () => perform(r, r.act));
      li.appendChild(b);
      return li;
    }

    function drawKey(r) {
      const li = rowShell(r, 'xm-tone-' + (r.tone || 'none'));
      li.querySelector('.xm-words').appendChild(el('span', 'xm-sub xm-note', text(r.note, tt)));
      const b = button('xm-combo', r.combo || tt('xmenu_key_set'));
      if (r.record) {
        b.setAttribute('aria-label', fill(tt('xmenu_key_change'), { name: text(r.label, tt) }));
        b.addEventListener('click', () => startRecording(r, b));
      } else {
        b.disabled = true;
      }
      li.appendChild(b);
      return li;
    }

    function drawAdd(r) {
      const li = rowShell(r, 'xm-row--stack');
      const toggle = button('ui-btn ui-btn--secondary xm-act', addOpen ? tt('xmenu_add_close') : tt('xmenu_add'));
      toggle.setAttribute('aria-expanded', String(addOpen));
      li.querySelector('.xm-label').hidden = true;
      toggle.prepend(icon('plus') || '');
      toggle.addEventListener('click', () => { addOpen = !addOpen; draw(); });
      li.appendChild(toggle);
      if (!addOpen) return li;
      const search = el('input', 'xm-search');
      search.type = 'search';
      search.value = addFilter;
      search.placeholder = tt('xmenu_add_search');
      search.setAttribute('aria-label', tt('xmenu_add_search'));
      const list = el('div', 'xm-addlist');
      const paint = () => {
        const q = addFilter.trim().toLowerCase();
        const items = (r.choices || []).filter((c) => !q || text(c.label, tt).toLowerCase().includes(q));
        list.replaceChildren(...items.map((c) => {
          const b = button('xm-addchoice', text(c.label, tt));
          b.addEventListener('click', () => { addOpen = false; addFilter = ''; perform(r, c.act); });
          return b;
        }));
        if (!items.length) list.appendChild(el('p', 'xm-empty', tt('xmenu_add_none')));
      };
      search.addEventListener('input', () => { addFilter = search.value; paint(); });
      paint();
      li.append(search, list);
      return li;
    }

    const DRAW = {
      status: drawStatus, toggle: drawToggle, choice: drawChoice, pages: drawChoice, widget: drawWidget,
      mode: drawMode, button: drawButton, key: drawKey, add: drawAdd,
    };

    // ── Key recording ──
    function startRecording(r, btn) {
      stopRecording();
      recording = { row: r, btn };
      btn.classList.add('is-recording');
      btn.textContent = tt('xmenu_key_press');
      doc.addEventListener('keydown', onRecordKey, true);
    }

    function stopRecording() {
      if (!recording) return;
      doc.removeEventListener('keydown', onRecordKey, true);
      recording.btn.classList.remove('is-recording');
      recording.btn.textContent = recording.row.combo || tt('xmenu_key_set');
      recording = null;
    }

    function onRecordKey(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { stopRecording(); return; }
      const S = typeof window !== 'undefined' && window.DeckShortcuts;
      const combo = S ? S.comboFromKeyEvent(e) : null;
      if (!combo) return;   // only modifiers so far
      const { row } = recording;
      stopRecording();
      if (!S.normalizeShortcut(combo)) { showError('bad_shortcut'); return; }
      perform(row, { run: { ...row.record.action, [row.record.param]: combo } });
    }

    // ── Layout ──
    function drawNav(sections) {
      const brand = el('div', 'xm-brand');
      brand.appendChild(el('span', 'xm-brand-name', 'Xenon'));
      if (place === 'screen' && data && data.menuKey) brand.appendChild(el('span', 'xm-sub', fill(tt('xmenu_key_closes'), { key: data.menuKey })));
      const list = el('div', 'xm-nav-list');
      for (const s of sections) {
        const b = button('xm-nav-btn');
        b.dataset.section = s.id;
        if (s.id === section) b.setAttribute('aria-current', 'true');
        const ic = icon(s.icon);
        if (ic) b.appendChild(ic);
        b.appendChild(el('span', 'xm-nav-label', text(s.title, tt)));
        b.addEventListener('click', () => show(s.id));
        list.appendChild(b);
      }
      const bit = button('xm-bit');
      bit.dataset.row = 'bit';
      bit.append(icon('bit') || '', el('span', 'xm-nav-label', tt('xmenu_bit')));
      bit.addEventListener('click', () => perform({ closes: true }, { open: 'bit' }));
      nav.replaceChildren(brand, list, bit);
      // On a phone the sections are a scrolling row: keep the chosen one in view.
      const cur = list.querySelector('[aria-current="true"]');
      if (cur && typeof cur.scrollIntoView === 'function') cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function drawMain(s) {
      const head = el('header', 'xm-head');
      const words = el('div', 'xm-words');
      words.append(el('h1', 'xm-title', text(s.title, tt)), el('p', 'xm-sub', text(s.sub, tt)));
      const close = button('xm-close');
      close.setAttribute('aria-label', tt('xmenu_close'));
      close.appendChild(icon('close') || doc.createTextNode('×'));
      close.addEventListener('click', () => { if (typeof opts.onClose === 'function') opts.onClose(); });
      head.append(words, close);
      const err = el('p', 'xm-error');
      err.setAttribute('role', 'status');
      paintError(err);
      const body = el('div', 'xm-body');
      const tiles = s.rows.filter((r) => r.kind === 'tile');
      if (tiles.length) {
        const grid = el('div', 'xm-tiles');
        tiles.forEach((r) => grid.appendChild(drawTile(r)));
        body.appendChild(grid);
      }
      const rows = s.rows.filter((r) => r.kind !== 'tile' && DRAW[r.kind]);
      if (rows.length) {
        const list = el('div', 'xm-list');
        rows.forEach((r) => list.appendChild(DRAW[r.kind](r)));
        body.appendChild(list);
      }
      main.replaceChildren(head, err, body);
    }

    function draw() {
      if (!data) {
        main.replaceChildren(el('p', 'xm-empty', tt('xmenu_loading')));
        return;
      }
      const sections = sectionsFor(data, place);
      if (!sections.some((s) => s.id === section)) section = sections.length ? sections[0].id : 'now';
      drawNav(sections);
      const s = sections.find((x) => x.id === section);
      if (s) drawMain(s);
    }

    async function load() {
      const seq = ++loadSeq;
      try {
        const res = await fetch(server + '/xenon-menu', { cache: 'no-store' });
        const next = res.ok ? await res.json() : null;
        if (seq !== loadSeq) return;
        if (!next) throw new Error('bad');
        data = next;
        if (!recording) draw();
      } catch (e) {
        if (seq !== loadSeq) return;
        if (!data) main.replaceChildren(el('p', 'xm-empty', tt('xmenu_offline')));
      }
    }

    function show(id) {
      stopRecording();
      if (typeof id === 'string' && id) section = id;
      addOpen = false;
      draw();
      const cur = nav.querySelector('[aria-current="true"]');
      if (cur && doc.activeElement && rootEl.contains(doc.activeElement)) cur.focus();
    }

    // `live`: one SSE connection while the menu is open, closed with it.
    function watch() {
      if (!opts.live || es || typeof EventSource !== 'function') return;
      es = new EventSource(server + '/sse');
      for (const name of LIVE_EVENTS) {
        es.addEventListener(name, (e) => {
          if (typeof opts.onEvent === 'function') {
            try { opts.onEvent(name, JSON.parse(e.data)); } catch (err) { /* a broken event changes nothing */ }
          }
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(load, REFRESH_DELAY_MS);
        });
      }
    }

    function destroy() {
      stopRecording();
      clearTimeout(errorTimer);
      clearTimeout(refreshTimer);
      if (es) { es.close(); es = null; }
      loadSeq++;
      rootEl.replaceChildren();
    }

    draw();
    watch();
    return { load, show, destroy, section: () => section, recording: () => !!recording, cancelRecording: stopRecording };
  }

  return { create, text, fill, sectionsFor, CLOSE_FIRST_MS };
});
