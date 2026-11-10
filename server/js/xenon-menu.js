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
  const KEY_TO_TRY = 'ctrl+alt+f9';   // Ctrl+Alt with a letter is AltGr: it is refused
  const REFRESH_DELAY_MS = 250;
  const FOOT_LINKS = ['store', 'sparks'];   // always in reach, whatever section is open
  const BLOCK_OF = Object.freeze({ tile: 'xm-tiles', mode: 'xm-modeblock' });
  const BALANCE_TTL_MS = 30000;
  // What can change a row while the menu is open: settings (widgets, keys,
  // look, mode), captures, the replay and recording state, the Deck's keys.
  // The last four are what a function answers with, for the place to say.
  const LIVE_EVENTS = ['settings', 'captures', 'replay', 'recording', 'deck', 'screen_menu', 'capture', 'capture_marker', 'xenon_menu_failed', 'stutter_why'];

  // ── Pure helpers (tested in node) ──────────────────────────────
  function fill(str, vars) {
    return String(str).replace(/\{(\w+)\}/g, (m, name) => (vars && vars[name] != null ? String(vars[name]) : m));
  }

  // A row text: { key, vars }, { text }, { langs } (a Store widget's own words, by
  // language), or a list of those joined by commas.
  function text(x, tt) {
    if (!x) return '';
    if (Array.isArray(x)) return x.map((y) => text(y, tt)).filter(Boolean).join(', ');
    if (typeof x.text === 'string') return x.text;
    if (x.langs && typeof x.langs === 'object') return ownWords(x.langs, tt);
    if (typeof x.key === 'string') return fill(tt(x.key), x.vars);
    if (Array.isArray(x.pair)) return x.pair.map((y) => text(y, tt)).join(': ');
    return '';
  }

  // The widget's words in the menu's language, else English, else the first it wrote.
  function ownWords(langs, tt) {
    const lang = String(tt('locale') || '').slice(0, 2).toLowerCase();
    const pick = langs[lang] != null ? langs[lang] : langs.en != null ? langs.en : Object.values(langs)[0];
    return typeof pick === 'string' ? pick : '';
  }

  // Facts about one thing as a sentence: only the first keeps its capital. Names
  // (`{ text }`) are left as they are written.
  function factLine(list, tt) {
    return list.map((y, i) => {
      const s = text(y, tt);
      return i && (y.key || y.pair) ? s.charAt(0).toLocaleLowerCase() + s.slice(1) : s;
    }).filter(Boolean).join(', ');
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
    const Palette = (typeof window !== 'undefined' && window.DashboardPalette) || null;
    let data = null;
    let section = 'now';
    let busy = false;
    let recording = null;   // { row, btn, downs } while a key row waits for keys
    let errorTimer = 0;
    let errorText = '';   // kept so a redraw right after a failed act still shows it
    let loadSeq = 0;
    let partLine = '';   // what the reading last pointed at means
    let query = '';
    let findEl = null;
    let findBox = null;
    let refreshTimer = 0;
    let es = null;
    let balance = null;   // whole Sparks, null until the hub has said
    let balanceAt = 0;

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

    // What the last function did. It outlives the redraws, and only a place that
    // loads the module has it: the dashboard's own toasts say it there.
    const resultBox = el('div', 'xm-result');
    resultBox.setAttribute('role', 'status');
    resultBox.hidden = true;
    const Result = (typeof window !== 'undefined' && window.XenonMenuResult) || null;
    const result = Result ? Result.create(resultBox, (a) => { if (typeof opts.onResultAction === 'function') opts.onResultAction(a); }) : null;

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

    // True when it went through, so a row can keep what was typed when it did not.
    async function perform(row, act, onDone) {
      if (!act || busy) return false;
      if (result) result.clear();
      // Over the screen this page's window goes with the menu: whatever comes
      // after the close has to leave now, or it is lost with the window.
      if (row && row.closes && typeof opts.leave === 'function') {
        opts.leave(act, row);
        return true;
      }
      if (row && row.closes && typeof opts.onClose === 'function') {
        opts.onClose();
        await new Promise((r) => setTimeout(r, CLOSE_FIRST_MS));
      }
      if (act.section) {
        show(act.section);
        return true;
      }
      if (act.open) {
        if (typeof opts.onOpen === 'function') opts.onOpen(act.open);
        return true;
      }
      if (!act.run) return false;
      // Over the screen the shell opens it, and lets the browser come above the menu.
      if (act.run.type === 'openUrl' && typeof opts.openLink === 'function') {
        opts.openLink(act.run.url);
        return true;
      }
      busy = true;
      rootEl.classList.add('is-busy');
      let ok = false;
      try {
        const r = await post('/actions/run', act.run);
        ok = !!r && r.ok !== false;
        if (!ok) showError((r && r.error) || 'unavailable');
        // The person chose this key from the list: that tap is their agreement.
        else if (act.run.type === 'layerKey') await post('/deck/press', { id: r.id, accept: r.fp });
        if (ok && typeof onDone === 'function') onDone(r);
      } catch (e) {
        showError('unavailable');
      } finally {
        busy = false;
        rootEl.classList.remove('is-busy');
      }
      if (!(row && row.closes)) load();
      return ok;
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
      const sub = text(r.sub, tt);
      if (sub) b.appendChild(el('span', 'xm-tile-sub', sub));
      if (r.combo) b.appendChild(el('span', 'xm-tile-key', r.combo));
      b.disabled = r.off === true;
      if (r.act) b.addEventListener('click', () => perform(r, r.act));
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

    function switchFor(r, name) {
      const sw = el('label', 'ui-toggle xm-switch');
      const input = el('input');
      input.type = 'checkbox';
      input.setAttribute('role', 'switch');
      input.checked = r.on === true;
      input.setAttribute('aria-label', name);
      input.dataset.keep = r.id;
      const acts = r.acts || {};
      input.disabled = !(r.on ? acts.off : acts.on);
      input.addEventListener('change', () => perform(r, input.checked ? acts.on : acts.off));
      sw.append(input, el('span', 'ui-toggle-track'));
      return sw;
    }

    function drawToggle(r) {
      const li = rowShell(r);
      li.appendChild(switchFor(r, text(r.label, tt)));
      return li;
    }

    function drawChip(r, item, say) {
      const b = button('xm-choice xm-chip', text(item.label, tt));
      b.dataset.keep = `${r.id}:${item.id}`;
      b.setAttribute('aria-pressed', String(item.on === true));
      b.addEventListener('pointerenter', () => say(item));
      b.addEventListener('focus', () => say(item));
      b.addEventListener('pointerleave', () => say(null));
      b.addEventListener('blur', () => say(null));
      b.addEventListener('click', () => perform(item, item.on ? item.acts.off : item.acts.on));
      return b;
    }

    // Readings to pick, a line of chips per group. The words that need explaining
    // share one line under the name, so seventeen explanations are not all on show.
    function drawChecks(r) {
      const box = el('div', 'xm-checks');
      box.dataset.row = r.id;
      const hint = el('p', 'xm-sub xm-hint', partLine || text(r.hint, tt));
      const say = (item) => {
        partLine = item ? text(item.sub, tt) : '';
        hint.textContent = partLine || text(r.hint, tt);
      };
      box.append(el('span', 'xm-label', text(r.label, tt)), hint);
      for (const g of r.groups || []) {
        const name = text(g.label, tt);
        const chips = el('div', 'xm-chips');
        chips.setAttribute('role', 'group');
        chips.setAttribute('aria-label', name);
        chips.append(...g.items.map((item) => drawChip(r, item, say)));
        const line = el('div', 'xm-chipline');
        line.append(el('span', 'xm-chipline-name', name), chips);
        box.appendChild(line);
      }
      return box;
    }

    function drawChoice(r) {
      const li = rowShell(r, 'xm-row--stack');
      const group = el('div', r.multi ? 'xm-choices xm-choices--multi' : 'xm-choices');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', text(r.label, tt));
      const view = r.live && sceneView ? sceneView.slot(r.value) : null;
      for (const o of r.options || []) {
        const b = button('xm-choice', text(o.label, tt));
        const on = r.multi ? o.on === true : String(o.value) === String(r.value);
        b.setAttribute('aria-pressed', String(on));
        b.dataset.keep = `${r.id}:${o.value}`;
        const act = r.multi || !on ? o.act : null;
        b.addEventListener('click', () => { if (act) perform(r, act); });
        if (view) view.follow(b, o.value);
        group.appendChild(b);
      }
      if (view) li.appendChild(view.box);
      if (r.demo && guide) {
        li.classList.add('xm-row--demo');
        li.appendChild(guide.demo(r.demo));
      }
      li.appendChild(group);
      return li;
    }

    // The page's title already says what this choice is: the group's name stays for a screen reader.
    function drawMode(r) {
      const li = el('div', 'xm-row xm-row--modes');
      li.dataset.row = r.id;
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
      const li = rowShell(r, r.actions ? 'xm-row--two' : '');
      const name = text(r.label, tt);
      const acts = el('div', 'xm-acts');
      for (const a of r.actions || [{ label: r.action, act: r.act, closes: r.closes }]) {
        const action = text(a.label, tt);
        const b = button('ui-btn ' + (r.primary ? 'ui-btn--primary' : 'ui-btn--secondary') + ' xm-act', action);
        b.setAttribute('aria-label', `${name}: ${action}`);
        const mark = a.icon && icon(a.icon);
        if (mark) b.prepend(mark);
        b.addEventListener('click', () => perform({ ...r, closes: a.closes }, a.act));
        acts.appendChild(b);
      }
      li.appendChild(acts);
      return li;
    }

    function drawKey(r) {
      const li = rowShell(r, 'xm-tone-' + (r.tone || 'none'));
      const note = text(r.note, tt);
      if (note) li.querySelector('.xm-words').appendChild(el('span', 'xm-sub xm-note', note));
      if (r.edit) {
        const edit = button('ui-btn ui-btn--secondary xm-act', tt('capg_edit'));
        edit.addEventListener('click', () => perform({ closes: true }, r.edit));
        li.appendChild(edit);
      }
      const b = button('xm-combo', r.combo || tt('xmenu_key_set'));
      if (r.record) {
        b.setAttribute('aria-label', fill(tt('xmenu_key_change'), { name: text(r.label, tt) }));
        b.addEventListener('click', () => startRecording(r, b));
      } else if (r.goes) {
        // Recorded in Settings, not here: the key takes you there.
        b.setAttribute('aria-label', fill(tt('xmenu_key_change'), { name: text(r.label, tt) }));
        b.addEventListener('click', () => perform({ closes: true }, r.goes));
      }
      li.appendChild(b);
      return li;
    }

    const drawTuneHead = (r) => el('h3', 'xm-tunehead', text(r.label, tt));

    const PageEdit = (typeof window !== 'undefined' && window.XenonMenuPageEdit) || null;
    const pageEdit = PageEdit ? PageEdit.create({ el, button, tt, fill, rowShell, perform, redraw: () => draw(), root: rootEl }) : null;

    const say = (x) => text(x, tt);
    const Place = (typeof window !== 'undefined' && window.XenonMenuPlace) || null;
    const placeDraw = Place ? Place.create({ el, button, say, tt, rowShell, perform, post, showError, redraw: () => draw() }) : null;
    const When = (typeof window !== 'undefined' && window.XenonMenuWhen) || null;
    const whenDraw = When ? When.create({ el, button, say, tt, fill, rowShell, perform, post, showError, redraw: () => draw() }) : null;
    const Guide = (typeof window !== 'undefined' && window.XenonMenuGuide) || null;
    const guide = Guide ? Guide.create({ el, button, say, tt, rowShell, redraw: () => draw() }) : null;

    const DRAW = {
      status: drawStatus, toggle: drawToggle, checks: drawChecks, choice: drawChoice, pages: drawChoice,
      mode: drawMode, button: drawButton, key: drawKey, pageEdit: pageEdit && pageEdit.draw,
      place: placeDraw ? placeDraw.draw : drawChoice, guide: guide && guide.draw, tunehead: drawTuneHead, when: whenDraw && whenDraw.draw,
    };
    const Peek = (typeof window !== 'undefined' && window.XenonMenuPeek) || null;
    const peek = Peek ? Peek.create({ post, onRefused: () => draw(), doc }) : null;
    // Only in the menu window: the scene page is this PC's, never a paired device's.
    const SceneView = (typeof window !== 'undefined' && window.XenonMenuSceneView) || null;
    const sceneView = SceneView && place === 'screen'
      ? SceneView.create({ el, doc, server, move: typeof moveNode === 'function' ? moveNode : null }) : null;
    const Widgets = (typeof window !== 'undefined' && window.XenonMenuWidgets) || null;
    const widgets = Widgets ? Widgets.create({
      el, button, say, tt, fill, factLine, icon, switchFor, perform, redraw: () => draw(), server, DRAW, Place, Palette, pageEdit, peek, main, clearFind, show,
    }) : null;
    if (widgets) DRAW.widget = widgets.drawRow;
    const Screens = (typeof window !== 'undefined' && window.XenonMenuScreens) || null;
    if (Screens) {
      const live = sceneView ? { slot: sceneView.slot, hold: sceneView.hold, settle: sceneView.settle } : {};
      DRAW.screens = Screens.create({ el, button, say, DRAW, rowShell, perform, icon, ...live }).draw;
    }

    // ── Key recording ──
    const clearable = (r) => !!r.combo && !r.noClear;

    function startRecording(r, btn) {
      const again = !!recording && recording.btn === btn;
      stopRecording();
      if (again) return;
      recording = { row: r, btn, downs: new Set() };
      btn.classList.add('is-recording');
      btn.textContent = tt(clearable(r) ? 'xmenu_key_press_clear' : 'xmenu_key_press');
      doc.addEventListener('keydown', onRecordKey, true);
      doc.addEventListener('keyup', onRecordKeyUp, true);
      doc.addEventListener('pointerdown', onRecordPress, true);
    }

    function stopRecording() {
      if (!recording) return;
      doc.removeEventListener('keydown', onRecordKey, true);
      doc.removeEventListener('keyup', onRecordKeyUp, true);
      doc.removeEventListener('pointerdown', onRecordPress, true);
      recording.btn.classList.remove('is-recording');
      recording.btn.textContent = recording.row.combo || tt('xmenu_key_set');
      recording = null;
    }

    // A press anywhere else is a change of mind. On the button its own click ends it.
    function onRecordPress(e) {
      if (!recording.btn.contains(e.target)) stopRecording();
    }

    // A keyup whose keydown never came: something on the PC holds that combination
    // system-wide and Windows gave it to that app. Still listening, and saying so.
    function onRecordKeyUp(e) {
      const S = typeof window !== 'undefined' && window.DeckShortcuts;
      if (S && S.keyupPress(e, recording.downs)) { takeCombo(S, S.keyupPress(e, recording.downs)); return; }
      const combo = S && S.swallowedCombo(e, recording.downs);
      if (!combo) return;
      e.preventDefault();
      e.stopPropagation();
      // One Xenon would refuse anyway (AltGr, the system): say that, it is the real answer.
      recording.btn.textContent = S.reservedBy(combo) ? tryText(S) : tt('xmenu_key_held');
    }

    const tryText = (S) => fill(tt('xmenu_key_try'), { key: S.formatShortcut(KEY_TO_TRY, /Mac/i.test(navigator.platform || '')) });

    function onRecordKey(e) {
      e.preventDefault();
      e.stopPropagation();
      recording.downs.add(String(e.code || ''));
      if (e.key === 'Escape') { stopRecording(); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && clearable(recording.row)) {
        const { row } = recording;
        stopRecording();
        perform(row, { run: { ...row.record.action, [row.record.param]: 'off' } });
        return;
      }
      const S = typeof window !== 'undefined' && window.DeckShortcuts;
      const combo = S ? S.comboFromKeyEvent(e) : null;
      if (!combo) return;   // only modifiers so far
      takeCombo(S, combo);
    }

    // A combination Xenon cannot take: still listening, with one that works to try.
    function takeCombo(S, combo) {
      if (!S.normalizeShortcut(combo) || S.reservedBy(combo)) {
        recording.btn.textContent = tryText(S);
        return;
      }
      const { row } = recording;
      stopRecording();
      perform(row, { run: { ...row.record.action, [row.record.param]: combo } });
    }

    // ── Layout ──
    // One field for the life of the view: a redraw must not take the typing away.
    function findField() {
      const field = el('input', 'xm-search xm-find');
      field.type = 'search';
      field.placeholder = tt('xmenu_search');
      field.setAttribute('aria-label', tt('xmenu_search'));
      field.addEventListener('input', () => { query = field.value; draw(); });
      field.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !query) return;
        e.stopPropagation();
        clearFind();
        draw();
      });
      return field;
    }

    function findLabel(field) {
      const box = el('label', 'xm-findbox');
      box.append(icon('search') || '', field);
      return box;
    }

    function clearFind() {
      query = '';
      if (findEl) findEl.value = '';
    }

    // The key is the way back for someone who found this menu by a button, so the
    // dashboard says it too. A phone has no such key.
    function menuKeyLine() {
      if (!data || !data.menuKey) return '';
      if (place === 'screen') return fill(tt('xmenu_key_closes'), { key: data.menuKey });
      return window.__xenonRemote ? '' : fill(tt('xmenu_key_opens'), { key: data.menuKey });
    }

    const findTile = (sections, id) => sections.flatMap((s) => s.rows).find((r) => r.kind === 'tile' && r.id === id);
    const balanceText = () => (balance === null ? '' : balance.toLocaleString());

    function drawFootLink(r) {
      const b = button('xm-settings');
      b.dataset.row = 'nav-' + r.id;
      b.append(icon(r.icon) || '', el('span', 'xm-nav-label', text(r.label, tt)));
      if (r.id === 'sparks') b.appendChild(el('span', 'xm-nav-value', balanceText()));
      // Updates waiting in the Store: the count, red like the Store's own rails; the
      // words ("2 updates available") are the tile's line, read out with the name.
      if (r.id === 'store' && r.updates > 0) {
        b.appendChild(el('span', 'xm-nav-value is-update', String(r.updates)));
        b.setAttribute('aria-label', text(r.label, tt) + ', ' + text(r.sub, tt));
      }
      b.addEventListener('click', () => perform(r, r.act));
      return b;
    }

    // The hub answers this one, so not on every redraw. No session or no answer
    // means no number: the row still opens the shop, which says why.
    async function refreshBalance() {
      const now = Date.now();
      if (now - balanceAt < BALANCE_TTL_MS) return;
      balanceAt = now;
      try {
        const res = await fetch(server + '/api/ai/xenon/balance', { cache: 'no-store' });
        const out = res.ok ? await res.json() : null;
        balance = out && Number.isFinite(out.balance) ? out.balance : null;
      } catch (e) {
        balance = null;
      }
      const value = nav.querySelector('.xm-nav-value');
      if (value) value.textContent = balanceText();
    }

    function drawNav(sections) {
      const brand = el('div', 'xm-brand');
      brand.appendChild(el('span', 'xm-brand-name', 'Xenon'));
      const keyLine = menuKeyLine();
      if (keyLine) brand.appendChild(el('span', 'xm-sub', keyLine));
      const list = el('div', 'xm-nav-list');
      for (const s of sections) {
        const b = button('xm-nav-btn');
        b.dataset.section = s.id;
        if (s.id === section && !query.trim()) b.setAttribute('aria-current', 'true');
        const ic = icon(s.icon);
        if (ic) b.appendChild(ic);
        b.appendChild(el('span', 'xm-nav-label', text(s.title, tt)));
        b.addEventListener('click', () => show(s.id));
        list.appendChild(b);
      }
      const links = FOOT_LINKS.map((id) => findTile(sections, id)).filter(Boolean).map(drawFootLink);
      const settings = button('xm-settings');
      settings.dataset.row = 'settings';
      settings.append(icon('settings') || '', el('span', 'xm-nav-label', tt('settings_title')));
      settings.addEventListener('click', () => perform({ closes: true }, { open: 'settings:general' }));
      const bit = button('xm-bit');
      bit.dataset.row = 'bit';
      bit.append(icon('bit') || '', el('span', 'xm-nav-label', tt('xmenu_bit')));
      bit.addEventListener('click', () => perform({ closes: true }, { open: 'chat' }));
      const foot = el('div', 'xm-nav-foot');
      foot.append(...links, settings, bit);
      const typing = !!findEl && doc.activeElement === findEl;
      if (!findEl) {
        findEl = findField();
        findBox = findLabel(findEl);
      }
      nav.replaceChildren(brand, findBox, list, foot);
      if (typing) findEl.focus();
      // On a phone the sections are a scrolling row: keep the chosen one in view.
      const cur = list.querySelector('[aria-current="true"]');
      if (cur && typeof cur.scrollIntoView === 'function') cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function drawMain(s) {
      const own = widgets ? widgets.screen(s) : null;
      const view = own || s;
      const head = el('header', 'xm-head');
      const words = el('div', 'xm-words');
      if (own && own.back) words.append(own.back);
      words.append(el('h1', 'xm-title', text(view.title, tt)), el('p', 'xm-sub', text(view.sub, tt)));
      head.append(words);
      if (own && own.action) head.append(own.action);
      // In its own window the X is the window's.
      if (opts.place !== 'screen') {
        const close = button('xm-close');
        close.setAttribute('aria-label', tt('xmenu_close'));
        close.appendChild(icon('close') || doc.createTextNode('×'));
        close.addEventListener('click', () => { if (typeof opts.onClose === 'function') opts.onClose(); });
        head.append(close);
      }
      const err = el('p', 'xm-error');
      err.setAttribute('role', 'status');
      paintError(err);
      const body = el('div', 'xm-body');
      if (own) body.append(...own.body);
      else drawRows(body, s.rows);
      main.replaceChildren(head, err, resultBox, body);
    }

    // In the order the server gave them: a heading starts a group, tiles share a
    // grid, the three ways of using Xenon stand alone and the other rows share a
    // list until the kind changes.
    function drawRows(body, rows) {
      let block = null;
      let blockClass = '';
      for (const r of rows) {
        if (r.kind === 'heading') {
          const head = el(r.nested ? 'h3' : 'h2', r.nested ? 'xm-heading xm-heading--page' : 'xm-heading', text(r.label, tt));
          if (r.note) head.appendChild(el('span', 'xm-heading-note', text(r.note, tt)));
          body.appendChild(head);
          blockClass = '';
          continue;
        }
        const draws = r.kind === 'tile' ? drawTile : DRAW[r.kind];
        if (!draws) continue;
        const wanted = BLOCK_OF[r.kind] || 'xm-list';
        if (wanted !== blockClass) {
          block = el('div', wanted);
          blockClass = wanted;
          body.appendChild(block);
        }
        block.appendChild(draws(r));
      }
    }

    function drawFound(sections) {
      const err = el('p', 'xm-error');
      err.setAttribute('role', 'status');
      paintError(err);
      const body = el('div', 'xm-body');
      const found = window.XenonMenuFind.find(sections, query, (x) => text(x, tt));
      for (const s of found) {
        body.appendChild(el('h2', 'xm-heading', text(s.title, tt)));
        drawRows(body, s.rows.filter((r) => r.kind !== 'heading'));
      }
      if (!found.length) body.appendChild(el('p', 'xm-empty', tt('xmenu_search_none')));
      main.replaceChildren(err, resultBox, body);
    }

    function paint() {
      if (!data) {
        main.replaceChildren(el('p', 'xm-empty', tt('xmenu_loading')));
        return;
      }
      const sections = sectionsFor(data, place);
      if (!sections.some((s) => s.id === section)) section = sections.length ? sections[0].id : 'now';
      drawNav(sections);
      if (query.trim()) { drawFound(sections); return; }
      const s = sections.find((x) => x.id === section);
      if (s) drawMain(s);
    }

    // Rows are rebuilt after every change, so what had the keyboard is found again.
    function draw() {
      const active = doc.activeElement;
      const keep = active && main.contains(active) ? active.dataset.keep : '';
      if (sceneView) sceneView.hold();
      paint();
      if (sceneView) sceneView.settle();
      if (keep) {
        const same = [...main.querySelectorAll('[data-keep]')].find((n) => n.dataset.keep === keep);
        if (same) same.focus();
      }
      if (pageEdit && pageEdit.holds()) pageEdit.focusName();
      if (widgets) widgets.settle();
    }

    async function load() {
      const seq = ++loadSeq;
      try {
        const res = await fetch(server + '/xenon-menu', { cache: 'no-store' });
        const next = res.ok ? await res.json() : null;
        if (seq !== loadSeq) return;
        if (!next) throw new Error('bad');
        data = next;
        // This PC's AltGr keys: the recorder then takes a Ctrl+Alt letter they never type.
        if (typeof window !== 'undefined' && window.DeckShortcuts) window.DeckShortcuts.useAltGrKeys(next.altGrKeys);
        if (!recording && !(pageEdit && pageEdit.holds()) && !(widgets && widgets.holds())) draw();
        if (nav.querySelector('.xm-nav-value')) refreshBalance();
      } catch (e) {
        if (seq !== loadSeq) return;
        if (!data) main.replaceChildren(el('p', 'xm-empty', tt('xmenu_offline')));
      }
    }

    function show(id) {
      stopRecording();
      if (typeof id === 'string' && id) section = id;
      partLine = '';
      if (pageEdit) pageEdit.reset();
      if (widgets) widgets.reset();
      clearFind();
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
      doc.removeEventListener('keydown', undoKey);
      if (peek) peek.stop();
      stopRecording();
      clearTimeout(errorTimer);
      clearTimeout(refreshTimer);
      if (es) { es.close(); es = null; }
      loadSeq++;
      rootEl.replaceChildren();
    }

    draw();
    watch();
    const showResult = (card) => { if (result) result.show(card); };
    const holdsEsc = () => !!recording || !!query || !!(pageEdit && pageEdit.typing());
    // Esc and the pad's back button leave a widget's screen before they leave the menu.
    const stepBack = () => {
      if (query || !widgets || !widgets.stepBack()) return false;
      draw();
      return true;
    };
    // Ctrl+Z in the Widgets section: one change back, as on the screen.
    function undoKey(e) {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || String(e.key).toLowerCase() !== 'z' || !widgets || section !== 'widgets') return;
      if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName || '')) return;
      const s = sectionsFor(data, place).find((x) => x.id === 'widgets');
      if (!s) return;
      e.preventDefault();
      widgets.undo(s.rows);
    }
    doc.addEventListener('keydown', undoKey);

    return { load, show, destroy, showError, showResult, section: () => section, recording: () => !!recording, holdsEsc, stepBack, cancelRecording: stopRecording };
  }

  return { create, text, fill, sectionsFor, CLOSE_FIRST_MS };
});
