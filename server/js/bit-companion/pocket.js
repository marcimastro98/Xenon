'use strict';
// Bit's pocket: what opens when the person taps their own Bit (companion.js, tile.js, desk.js through the
// Xenon menu's window). At the top what Bit has to tell now (signals.js) with the one thing to do about it;
// then four quick keys the person chooses from what this PC can run (GET /api/bit/pocket, server/bit/pocket.js);
// then "Ask Bit" and its room. Opening it is seeing what it says: the sign over its head goes.
// On the dashboard it opens beside the Bit that was tapped; alone in the menu's window (`sheet`) it fills it,
// and a key closes the window before it runs (POST /screen-menu `run`), as the menu's own tiles do.
(() => {
  let ui = null;   // { root, card, sheet, ac, keysBox, choices, usual, picking }

  const say = (key, vars = {}) => String(t(key)).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  const prefs = () => window.BitApp?.state()?.prefs || {};
  const post = (path, body) => fetch(SERVER + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => ({ ok: false }));

  // What each sign says, and what may be done about it.
  const NOW = Object.freeze({
    done: { line: 'mybit_sig_done' },
    ask: { line: 'mybit_sig_ask' },
    soon: { line: 'mybit_sig_soon', plain: 'mybit_sig_soon_plain' },
    bell: { line: 'mybit_sig_bell', go: 'mybit_sig_bell_more', act: (v) => ({ run: { type: 'timerStart', label: v.label || 'Bit', minutes: '5' } }) },
    disk: { line: 'mybit_sig_disk', go: 'mybit_sig_disk_go', act: (v) => ({ ask: say('mybit_sig_disk_q', v) }) },
  });

  function close() {
    if (!ui) return;
    ui.ac.abort();
    ui.root.remove();
    ui = null;
  }

  function failed() {
    window.XenonToast?.show({ type: 'error', message: t('mybit_pocket_failed') });
  }

  /** Does what a key or a line asks: { run } a Deck action, { open } a screen, { ask } a question for Bit. */
  async function act(what) {
    const sheet = ui?.sheet;
    close();
    if (what.chat || what.ask) {
      if (sheet) await post('/screen-menu', { sheet: { open: 'chat' }, ...(what.ask ? { ask: what.ask } : {}) });
      else if (what.ask && typeof window.aiAsk === 'function') window.aiAsk(what.ask);
      else window.DashboardOpen?.run({ open: 'chat' });
      return;
    }
    if (what.room) { window.BitSheet?.open(); return; }
    if (what.open) {
      // Alone in the menu's window, the window becomes that screen, as the menu's own rows do.
      const req = { open: String(what.open).split(':')[0] };
      const address = sheet && window.DashboardOpen?.sheetAddress(req);
      if (address) window.location.href = address; else window.DashboardOpen?.run(req);
      return;
    }
    if (!what.run) return;
    const r = sheet ? await post('/screen-menu', { run: what.run }) : await post('/actions/run', what.run);
    if (r?.ok === false) failed();
  }

  function button(cls, text, onClick) {
    const b = makeEl('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick, { signal: ui.ac.signal });
    return b;
  }

  function nowRow() {
    const row = makeEl('div', 'bitp-now');
    const s = window.BitSignals?.top();
    const said = s && NOW[s.kind];
    if (!said) {
      row.classList.add('is-quiet');
      row.append(makeEl('p', 'bitp-line', t('mybit_pocket_nothing')));
      return row;
    }
    const sign = window.BitSigns?.svg(s.kind);
    if (sign) row.append(sign);
    const plain = said.plain && !s.vars?.title;
    row.append(makeEl('p', 'bitp-line', say(plain ? said.plain : said.line, s.vars)));
    if (said.go) row.append(button('bitp-btn is-main', t(said.go), () => act(said.act(s.vars))));
    return row;
  }

  function keyButton(c, onClick) {
    const b = button('bitp-key', '', onClick);
    const icon = window.XenonMenuIcons?.make(document, c.icon);
    if (icon) b.append(icon);
    b.append(makeEl('span', '', t(c.label)));
    return b;
  }

  // The person's keys among what this PC runs; the usual four when they chose none.
  function chosen() {
    const ids = (prefs().keys || []).length ? prefs().keys : ui.usual;
    return ids.map((id) => ui.choices.find((c) => c.id === id)).filter(Boolean);
  }

  async function saveKeys(ids) {
    const r = await post('/api/bit/prefs', { keys: ids });
    if (!r?.ok || !r.bit) { failed(); return; }
    window.BitApp?.heard(r.bit);
    drawKeys();
  }

  function pickRow() {
    const ids = chosen().map((c) => c.id);
    const full = ids.length >= 4;
    return ui.choices.map((c) => {
      const on = ids.includes(c.id);
      const b = keyButton(c, () => saveKeys(on ? ids.filter((id) => id !== c.id) : [...ids, c.id]));
      b.setAttribute('aria-pressed', String(on));
      b.disabled = full && !on;
      return b;
    });
  }

  function drawKeys() {
    if (!ui) return;
    const box = ui.keysBox;
    box.replaceChildren();
    box.classList.toggle('is-picking', ui.picking);
    if (!ui.choices) { box.append(makeEl('p', 'bitp-note', t(ui.choices === null ? 'mybit_pocket_loading' : 'mybit_pocket_failed'))); return; }
    if (ui.picking) box.append(...pickRow());
    else box.append(...chosen().map((c) => keyButton(c, () => act(c.act))));
    ui.edit.textContent = t(ui.picking ? 'mybit_pocket_edit_done' : 'mybit_pocket_edit');
  }

  async function loadKeys() {
    try {
      const r = await fetch(SERVER + '/api/bit/pocket').then((res) => res.json());
      if (!ui || r?.ok !== true || !Array.isArray(r.choices)) throw new Error('no keys');
      ui.choices = r.choices;
      ui.usual = Array.isArray(r.usual) ? r.usual : [];
    } catch {
      if (ui) ui.choices = false;
    }
    drawKeys();
  }

  // Beside the Bit that was tapped: over it when there is room, else under it.
  function placeBy(card, anchor) {
    const r = anchor?.getBoundingClientRect?.();
    if (!r) { card.classList.add('is-centred'); return; }
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    const top = r.top - h - 8 >= 8 ? r.top - h - 8 : Math.min(r.bottom + 8, innerHeight - h - 8);
    card.style.left = Math.round(left) + 'px';
    card.style.top = Math.round(Math.max(8, top)) + 'px';
  }

  /** @param {{ anchor?: Element, sheet?: boolean }} [o] */
  function open(o = {}) {
    if (ui) { close(); return; }
    const root = makeEl('div', 'bitp' + (o.sheet ? ' is-sheet' : ''));
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', t('mybit_pocket_title'));
    const card = makeEl('div', 'bitp-card');
    ui = { root, card, sheet: !!o.sheet, ac: new AbortController(), keysBox: makeEl('div', 'bitp-keys'), choices: null, usual: [], picking: false };
    ui.edit = button('bitp-btn is-quiet', '', () => { ui.picking = !ui.picking; drawKeys(); });
    const foot = makeEl('div', 'bitp-foot');
    foot.append(button('bitp-btn', t('mybit_pocket_ask'), () => act({ chat: true })), button('bitp-btn', t('mybit_pocket_room'), () => act({ room: true })), ui.edit);
    card.append(nowRow(), ui.keysBox, foot);
    root.append(card);
    root.addEventListener('click', (e) => { if (e.target === root) close(); }, { signal: ui.ac.signal });
    addEventListener('xenon-bit', drawKeys, { signal: ui.ac.signal }); // its keys, once its Bit is read (menu's window)
    addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); } }, { signal: ui.ac.signal, capture: true });
    document.body.append(root);
    drawKeys();
    if (!o.sheet) placeBy(card, o.anchor);
    window.BitApp?.seen?.('pocket');
    const sign = window.BitSignals?.top()?.kind;
    if (sign) window.BitApp?.seen?.(`sign.${sign}`); // which sign was seen, never what it was about
    window.BitSignals?.seen();
    loadKeys().then(() => { if (ui && !o.sheet) placeBy(card, o.anchor); });
    return true;
  }

  window.BitPocket = Object.freeze({ open, close, isOpen: () => !!ui });
})();
