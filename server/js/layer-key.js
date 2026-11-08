'use strict';
// A Deck key placed on the screen, drawn by every layer page, light or full: the
// layer widget's instance is the key's id, and its look comes from GET /deck/press.
// The button is ours, never a widget's, and only a real tap reaches POST /deck/press.
//
// The server decides what a tap does (server/deck-press.js): a key the person has
// not agreed to, or one that changed since, answers key_changed and runs nothing.
// The sheet then lists every step it would run; only the tap on Allow agrees, and
// the agreement names what the sheet showed, so a key edited meanwhile is refused.
// A list too long for the sheet keeps Allow off until it has been read to its end.
(function () {
  const PRESSED_MS = 220;
  const FAILED_MS = 1600;
  // Allow stays off this long: a double tap on the key must not land on it.
  const ARM_MS = 600;
  // A fractional zoom can leave the last pixel of a list out of reach.
  const SCROLL_SLACK = 2;
  const EDGE_GAP = 8;
  const COLOR_RE = /^#[0-9a-f]{3,8}$/i;
  // Schemes that cannot run script, as deck.js's safeIconSrc.
  const SRC_RE = /^(https?:\/\/|data:image\/|blob:)/i;
  const tr = (key, fallback) => (typeof t === 'function' ? t(key, fallback) : fallback);
  const host = () => window.LayerHost;

  const read = (id) => fetch('/deck/press?id=' + encodeURIComponent(id)).then(r => r.json()).catch(() => null);

  function post(body) {
    return fetch('/deck/press', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(r => r.json()).catch(() => null);
  }

  const stepName = (step) => (step.label ? tr(step.label, step.type) : step.type);
  const nameOf = (d) => d.title || (d.does && d.does[0] ? stepName(d.does[0]) : '');

  // The light page has no Deck, so the icon set comes when a key first needs it.
  let iconsAsked = false;
  function askIcons() {
    if (iconsAsked) return;
    iconsAsked = true;
    const script = document.createElement('script');
    script.src = 'js/deck-icons.js';
    script.addEventListener('load', refreshAll);
    document.head.appendChild(script);
  }

  function iconNode(icon) {
    const box = document.createElement('span');
    box.className = 'layer-key-ico';
    const value = String(icon.value || '').trim();
    if (icon.type === 'image' && SRC_RE.test(value)) {
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.src = value;
      box.appendChild(img);
    } else if (icon.type === 'builtin') {
      if (!window.DeckIcons) { askIcons(); return null; }
      if (!window.DeckIcons.has(value)) return null;
      box.appendChild(window.DeckIcons.el(value));
    } else if (icon.type === 'emoji') {
      box.textContent = value;
    } else {
      return null;
    }
    return box;
  }

  function draw(node, d) {
    const live = !!d && d.ok === true && d.state !== 'gone';
    const btn = node.querySelector('.layer-key-btn');
    const name = live ? nameOf(d) : tr('layer_key_gone', 'Key removed');
    const asks = live && d.state === 'confirm';
    btn.textContent = '';
    node.classList.toggle('is-gone', !live);
    node.classList.toggle('needs-ok', asks);
    if (live && COLOR_RE.test(String(d.bg || ''))) node.style.setProperty('--key-bg', d.bg);
    else node.style.removeProperty('--key-bg');
    const icon = live && d.icon ? iconNode(d.icon) : null;
    if (icon) btn.appendChild(icon);
    if (!icon || d.title) {
      const label = document.createElement('span');
      label.className = 'layer-key-title';
      label.textContent = name;   // a key's title is the person's, or Bit's, text
      btn.appendChild(label);
    }
    btn.setAttribute('aria-label', name);
    btn.title = asks ? tr('layer_key_needs_ok', 'Tap to see what it does') : name;
  }

  // Replies can cross when several changes land together: the last asked is drawn.
  const asked = new WeakMap();
  async function refresh(node) {
    const turn = (asked.get(node) || 0) + 1;
    asked.set(node, turn);
    const d = await read(node.dataset.layerKey);
    if (asked.get(node) === turn) draw(node, d);
  }

  function refreshAll() {
    document.querySelectorAll('[data-layer-key]').forEach(refresh);
  }

  let sheet = null;
  let sheetKey = null;
  function closeSheet() {
    if (!sheet) return;
    sheet.remove();
    sheet = null;
    // The sheet took the keyboard when it opened: the key it came from takes it back.
    sheetKey.focus({ focusVisible: false });
  }

  // Beside the key, inside the window: the shell shows only the slots and the sheets.
  function placeSheet(box, node) {
    const r = node.getBoundingClientRect();
    const s = box.getBoundingClientRect();
    const below = r.bottom + EDGE_GAP;
    const top = below + s.height <= window.innerHeight - EDGE_GAP ? below : r.top - s.height - EDGE_GAP;
    const left = Math.min(r.left, window.innerWidth - s.width - EDGE_GAP);
    box.style.setProperty('--key-sheet-x', Math.max(EDGE_GAP, left) + 'px');
    box.style.setProperty('--key-sheet-y', Math.max(EDGE_GAP, top) + 'px');
  }

  function textRow(tag, className, text) {
    const el = document.createElement(tag);
    el.className = className;
    el.textContent = text;
    return el;
  }

  function sheetButton(label, primary, onTap) {
    const btn = textRow('button', primary ? 'layer-key-sheet-go' : 'layer-key-sheet-no', label);
    btn.type = 'button';
    btn.addEventListener('click', (e) => { if (e.isTrusted) onTap(); });
    return btn;
  }

  function openSheet(node, title, parts, buttons) {
    closeSheet();
    const box = document.createElement('div');
    box.className = 'layer-key-sheet';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', title);
    box.tabIndex = -1;
    const row = document.createElement('div');
    row.className = 'layer-key-sheet-row';
    row.append(...buttons);
    box.append(textRow('p', 'layer-key-sheet-title', title), ...parts, row);
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
    document.body.appendChild(box);
    if (host() && host().showSheet) host().showSheet(box);
    placeSheet(box, node);
    sheet = box;
    sheetKey = node.querySelector('.layer-key-btn');
    // On the sheet, never on Allow: Esc has to reach it, and a stray Enter must agree to nothing.
    box.focus({ focusVisible: false });
  }

  const cancelButton = () => sheetButton(tr('ai_deck_cancel', 'Cancel'), false, closeSheet);

  function stepList(does) {
    const list = document.createElement('ol');
    list.className = 'layer-key-steps';
    for (const step of does) {
      const item = textRow('li', 'layer-key-step', stepName(step));
      if (step.detail) item.appendChild(textRow('span', 'layer-key-step-detail', step.detail));
      list.appendChild(item);
    }
    return list;
  }

  const seenToEnd = (list) => list.scrollTop + list.clientHeight >= list.scrollHeight - SCROLL_SLACK;

  // Allow agrees to every step, so it needs the list on the screen right to its end.
  function armAllow(allow, list, hint) {
    let waited = false;
    let read = false;
    const update = () => {
      read = read || seenToEnd(list);
      allow.disabled = !(waited && read);
      hint.textContent = read
        ? tr('layer_key_confirm_hint', 'Allow it and your next tap runs this.')
        : tr('layer_key_read_all', 'Scroll to the end to see every step.');
    };
    update();
    if (!read) {
      list.tabIndex = 0;   // a keyboard can scroll it too
      list.addEventListener('scroll', update, { passive: true });
    }
    setTimeout(() => { waited = true; update(); }, ARM_MS);
  }

  function showConfirm(node, d) {
    const allow = sheetButton(tr('layer_key_allow', 'Allow'), true, () => agree(node, d.fp));
    allow.disabled = true;
    const list = stepList(d.does);
    const hint = textRow('p', 'layer-key-sheet-hint', '');
    openSheet(node, nameOf(d) || tr('layout_widget_key', 'Deck key'), [list, hint], [cancelButton(), allow]);
    armAllow(allow, list, hint);
    draw(node, d);
  }

  function showGone(node) {
    const id = node.dataset.layerKey;
    const remove = sheetButton(tr('layer_key_remove', 'Take it off'), true, () => {
      closeSheet();
      fetch('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'layerRemove', target: id }) })
        .catch(() => failed(node));
    });
    const hint = textRow('p', 'layer-key-sheet-hint', tr('layer_key_gone_hint', 'This key is no longer in the Deck.'));
    openSheet(node, tr('layer_key_gone', 'Key removed'), [hint], [cancelButton(), remove]);
    draw(node, null);
  }

  // A fresh read: what the sheet shows is what the server would run now.
  async function ask(node) {
    const d = await read(node.dataset.layerKey);
    if (!d || d.ok !== true || d.state === 'gone') { showGone(node); return; }
    if (d.state === 'confirm') { showConfirm(node, d); return; }
    closeSheet();
    draw(node, d);
  }

  function failed(node) {
    node.classList.add('is-failed');
    setTimeout(() => node.classList.remove('is-failed'), FAILED_MS);
  }

  async function agree(node, fp) {
    const res = await post({ id: node.dataset.layerKey, accept: fp });
    if (res && res.ok) { closeSheet(); refresh(node); return; }
    if (res && (res.error === 'key_changed' || res.error === 'gone')) { ask(node); return; }
    closeSheet();
    failed(node);
  }

  async function tap(node, e) {
    if (!e.isTrusted || node.classList.contains('is-running')) return;
    if (host() && host().editing()) return;
    node.classList.add('is-running');
    const res = await post({ id: node.dataset.layerKey });
    node.classList.remove('is-running');
    if (res && res.ok) {
      node.classList.add('is-pressed');
      setTimeout(() => node.classList.remove('is-pressed'), PRESSED_MS);
    } else if (res && (res.error === 'key_changed' || res.error === 'gone')) {
      await ask(node);
    } else if (!res || res.error !== 'busy') {
      failed(node);
    }
  }

  // The button for the layer widget `w`, kept by the layer id. Asked again whenever
  // the layers change, which is how an agreement made elsewhere reaches the face.
  function atom(w) {
    const placed = document.querySelector('[data-layer-key="' + w.id + '"]');
    if (placed) { refresh(placed); return placed; }
    const node = document.createElement('section');
    node.className = 'layer-key';
    node.dataset.dashboardWidget = 'key';
    node.dataset.layerKey = w.id;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layer-key-btn';
    btn.addEventListener('click', e => tap(node, e));
    node.appendChild(btn);
    refresh(node);
    return node;
  }

  // The person placed this key themselves, so that tap was their agreement.
  async function accept(id, fp) {
    const res = await post({ id, accept: fp });
    refreshAll();
    return res;
  }

  window.LayerKey = Object.freeze({ atom, accept, refreshAll });
})();
