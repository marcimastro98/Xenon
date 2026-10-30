// Edit mode of a layer window, loaded by js/layer-host.js the first time the
// mode is turned on (so a window that is never edited never carries it).
//
// Drag a widget to move it, drag its corner to resize it, drop it on another
// widget to make them tabs of one box. The cross takes the shown widget off the
// screen, the small cross on a tab takes that tab out of its box, "Done" ends
// the mode, "Add" lists the widgets that can be placed and puts the one picked
// in the middle of this screen; the pin on a widget attaches it to an open app
// (only where the shell can follow one) and an attached window's bar puts it
// back on the desktop; the page chips between them are
// js/layer-edit-pages.js, loaded with this file. Every change is a capability
// run on the server (layerMove, layerGroup, layerRemove, layerPlace, layersEdit,
// layerPage, layerPageEdit, layerAnchor): this page saves
// nothing itself, and the settings broadcast redraws every window from the
// saved result.
(function () {
  'use strict';

  const GRID_PX = 8;           // positions and sizes land on an 8 px grid
  const SNAP_PX = 10;          // ...and on a screen edge or another widget's edge this close
  const CLICK_PX = 4;          // less than this is a tap, not a drag
  const SVG_NS = 'http://www.w3.org/2000/svg';

  let api = null;
  let bar = null;
  let sheet = null;          // the list "Add" opens
  let drag = null;
  let pagesScript = null;
  let canAttach = false;     // the shell follows app windows (layerList says)
  let desks = null;          // { current, count } where the shell says which desktop is shown
  const frames = new WeakMap();   // slot -> frame
  const entryOf = new WeakMap();  // frame -> the box it covers, as last drawn

  const tr = (key, fallback) => {
    const text = typeof t === 'function' ? t(key) : '';
    return text && text !== key ? text : fallback;
  };

  // `tag` span inside a tab: a button may not hold another button.
  function cross(className, label, tag = 'button') {
    const btn = document.createElement(tag);
    if (tag === 'button') btn.type = 'button';
    else btn.setAttribute('role', 'button');
    btn.className = className;
    btn.setAttribute('aria-label', label);
    btn.title = label;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 10 10');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M2 2L8 8M8 2L2 8');
    svg.appendChild(path);
    btn.appendChild(svg);
    return btn;
  }

  // Run one edit; a refused one puts the boxes back where the saved state says.
  async function run(action) {
    const res = await api.run(action);
    if (!(res && res.ok)) api.place();
    return res;
  }

  const HINT = () => tr('layer_edit_hint', 'Drag to move, the corner to resize, onto another widget for tabs');

  function ensureBar() {
    if (bar) return;
    bar = document.createElement('div');
    bar.className = 'layer-edit-bar';
    const hint = document.createElement('span');
    hint.className = 'layer-edit-hint';
    hint.setAttribute('aria-live', 'polite');
    // An attached window cannot be dragged: its bar only says what failed.
    hint.textContent = api.surface === 'anchor' ? '' : HINT();
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'layer-edit-done';
    done.textContent = tr('layout_exit', 'Done');
    done.addEventListener('click', () => api.run({ type: 'layersEdit', mode: 'off' }));
    // An anchored window IS its widget: nothing to add to it, only to put back.
    if (api.surface !== 'anchor') bar.append(hint, addButton(), done);
    else bar.append(hint, detachButton(), done);
    api.root().appendChild(bar);
  }

  // Pages go on the bar of the desktop and overlay windows, once their script
  // is in (it loads the first time edit mode starts).
  function mountPages() {
    if (!bar || api.surface === 'anchor' || bar.querySelector('.layer-page-strip')) return;
    if (!window.LayerEditPages) {
      if (pagesScript) return;
      pagesScript = document.createElement('script');
      pagesScript.src = 'js/layer-edit-pages.js';
      pagesScript.addEventListener('load', () => { if (api && bar) refresh(); });
      document.head.appendChild(pagesScript);
      return;
    }
    const strip = window.LayerEditPages.mount({ run: (a) => run(a), say, tr, root: () => api.root(), closeOther: closeSheet, desks: () => desks });
    bar.insertBefore(strip, bar.querySelector('.layer-edit-add'));
  }

  // ── "Add": the widgets that can be placed, one tap puts one in the middle
  // of this screen, ready to drag ───────────────────────────────────────────
  function addButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layer-edit-add';
    btn.textContent = tr('layer_edit_add', 'Add');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', () => (sheet ? closeSheet() : openSheet(btn)));
    return btn;
  }

  function say(text) {
    const hint = bar && bar.querySelector('.layer-edit-hint');
    if (hint) hint.textContent = text;
  }

  function closeSheet() {
    if (!sheet) return;
    sheet.remove();
    sheet = null;
    const btn = bar && bar.querySelector('.layer-edit-add');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function pickRow(label, iconId, onPick) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'layer-edit-pick';
    const icon = iconId && window.DashboardPalette && window.DashboardPalette.iconFor
      ? window.DashboardPalette.iconFor(iconId) : '';
    if (icon) {
      const ico = document.createElement('span');
      ico.className = 'layer-edit-pick-ico';
      ico.innerHTML = icon;   // static, trusted SVG from the palette icon map
      row.appendChild(ico);
    }
    const name = document.createElement('span');
    name.textContent = label;   // a Store widget's name is untrusted text
    row.appendChild(name);
    row.addEventListener('click', onPick);
    return row;
  }

  async function openSheet(btn) {
    if (window.LayerEditPages) window.LayerEditPages.close();
    const list = await api.run({ type: 'layerList' });
    if (!bar || sheet) return;   // edit mode ended, or a second tap, while it loaded
    if (!(list && list.ok)) { say(tr('layer_edit_add_failed', 'It could not be added')); return; }
    const choices = list.choices || {};
    sheet = document.createElement('div');
    sheet.className = 'layer-edit-sheet';
    sheet.setAttribute('role', 'menu');
    for (const id of choices.tiles || []) sheet.appendChild(pickRow(tr('layout_widget_' + id, id), id, () => add(id)));
    for (const name of choices.widgets || []) sheet.appendChild(pickRow(name, '', () => add(name)));
    btn.setAttribute('aria-expanded', 'true');
    api.root().appendChild(sheet);
  }

  async function add(ref) {
    closeSheet();
    const res = await run({
      type: 'layerPlace', widget: ref, surface: api.surface, position: 'center', size: 'medium', monitor: api.monitor,
    });
    if (res && res.ok) { say(HINT()); return; }
    say(res && res.error === 'too_many'
      ? tr('layer_edit_add_full', 'There are 24 widgets already: take one off first')
      : tr('layer_edit_add_failed', 'It could not be added'));
  }

  // ── "Attach to an app": the widget becomes a small window that follows one
  // app and hides with it ────────────────────────────────────────────────────
  async function openAttach(widgetId) {
    closeSheet();
    if (window.LayerEditPages) window.LayerEditPages.close();
    const res = await api.run({ type: 'layerAnchor', mode: 'apps' });
    if (!bar || sheet) return;   // edit mode ended, or another sheet opened, while it loaded
    const apps = res && res.ok && Array.isArray(res.apps) ? res.apps : null;
    if (!apps) { say(tr('layer_edit_attach_failed', 'It could not be attached')); return; }
    if (!apps.length) { say(tr('layer_edit_attach_none', 'No open app to attach it to')); return; }
    sheet = document.createElement('div');
    sheet.className = 'layer-edit-sheet';
    sheet.setAttribute('role', 'menu');
    // In the sheet, not the bar: the bar cuts it short on a phone-sized window.
    const note = document.createElement('p');
    note.className = 'layer-edit-sheet-note';
    note.textContent = tr('layer_edit_attach_hint', 'Pick the app: the widget follows it and hides when you minimize it');
    sheet.appendChild(note);
    // App names come from the PC's process list: pickRow sets them as text.
    for (const a of apps) sheet.appendChild(pickRow(a.app, '', () => attach(widgetId, a.app)));
    api.root().appendChild(sheet);
  }

  async function attach(widgetId, app) {
    closeSheet();
    const res = await run({ type: 'layerAnchor', widget: widgetId, app });
    say(res && res.ok ? HINT() : tr('layer_edit_attach_failed', 'It could not be attached'));
  }

  function detachButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layer-edit-detach';
    btn.textContent = tr('layer_edit_detach', 'Back on the desktop');
    btn.addEventListener('click', async () => {
      const entry = api.boxes()[0];
      if (!entry) return;
      const res = await run({ type: 'layerAnchor', mode: 'off', widget: entry.box.lead.id });
      if (!(res && res.ok)) say(tr('layer_edit_attach_failed', 'It could not be attached'));
    });
    return btn;
  }

  // ── Geometry: px inside the window's root, fractions on the wire ──────────
  function rootBox() {
    return api.root().getBoundingClientRect();
  }

  function boxOf(slot, origin) {
    const r = slot.getBoundingClientRect();
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
  }

  // The nearest guide within SNAP_PX of a coordinate, or null.
  function guideNear(v, guides) {
    let best = null;
    for (const g of guides) if (Math.abs(g - v) <= SNAP_PX && (best === null || Math.abs(g - v) < Math.abs(best - v))) best = g;
    return best;
  }

  function snap(v, guides) {
    const g = guideNear(v, guides);
    return g !== null ? g : Math.round(v / GRID_PX) * GRID_PX;
  }

  // A moved box meets a guide with its near edge or its far one, whichever is
  // closer; only when neither edge is near one does it land on the grid.
  function snapEdge(pos, size, lines) {
    const near = guideNear(pos, lines);
    const farLine = guideNear(pos + size, lines);
    const far = farLine === null ? null : farLine - size;
    if (near !== null && (far === null || Math.abs(near - pos) <= Math.abs(far - pos))) return near;
    if (far !== null) return far;
    return Math.round(pos / GRID_PX) * GRID_PX;
  }

  function guides(origin, self) {
    const xs = [0, origin.width];
    const ys = [0, origin.height];
    for (const e of api.boxes()) {
      if (e.slot === self) continue;
      const b = boxOf(e.slot, origin);
      xs.push(b.x, b.x + b.w);
      ys.push(b.y, b.y + b.h);
    }
    return { xs, ys };
  }

  function showAt(slot, b, origin) {
    slot.style.setProperty('--layer-x', (b.x / origin.width * 100) + '%');
    slot.style.setProperty('--layer-y', (b.y / origin.height * 100) + '%');
    slot.style.setProperty('--layer-w', (b.w / origin.width * 100) + '%');
    slot.style.setProperty('--layer-h', (b.h / origin.height * 100) + '%');
  }

  function fractions(b, origin) {
    const f = (v, of) => Math.round(v / of * 10000) / 10000;
    return [f(b.x, origin.width), f(b.y, origin.height), f(b.w, origin.width), f(b.h, origin.height)].join(',');
  }

  // The other box under the pointer, if any: dropping there makes tabs.
  function targetAt(px, py, self) {
    return api.boxes().find((e) => {
      if (e.slot === self) return false;
      const r = e.slot.getBoundingClientRect();
      return px >= r.left && px < r.right && py >= r.top && py < r.bottom;
    }) || null;
  }

  function markTarget(entry) {
    for (const e of api.boxes()) {
      const frame = frames.get(e.slot);
      if (frame) frame.classList.toggle('is-drop-target', !!entry && e === entry);
    }
  }

  // ── Dragging ──────────────────────────────────────────────────────────────
  function begin(e, entry, mode) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const origin = rootBox();
    drag = { entry, mode, origin, start: boxOf(entry.slot, origin), px: e.clientX, py: e.clientY, moved: false, target: null, frame: frames.get(entry.slot) };
    drag.guides = guides(origin, entry.slot);
    if (drag.frame.setPointerCapture) drag.frame.setPointerCapture(e.pointerId);
    drag.frame.classList.add('is-dragging');
  }

  function moveTo(e) {
    if (!drag) return;
    const dx = e.clientX - drag.px;
    const dy = e.clientY - drag.py;
    if (!drag.moved && Math.hypot(dx, dy) < CLICK_PX) return;
    drag.moved = true;
    const { origin, start, guides: g } = drag;
    let b;
    if (drag.mode === 'move') {
      b = { x: snapEdge(start.x + dx, start.w, g.xs), y: snapEdge(start.y + dy, start.h, g.ys), w: start.w, h: start.h };
      drag.target = targetAt(e.clientX, e.clientY, drag.entry.slot);
      markTarget(drag.target);
    } else {
      const right = snap(start.x + start.w + dx, g.xs);
      const bottom = snap(start.y + start.h + dy, g.ys);
      b = { x: start.x, y: start.y, w: Math.max(GRID_PX, right - start.x), h: Math.max(GRID_PX, bottom - start.y) };
    }
    b.x = Math.min(Math.max(0, b.x), origin.width - Math.min(b.w, origin.width));
    b.y = Math.min(Math.max(0, b.y), origin.height - Math.min(b.h, origin.height));
    b.w = Math.min(b.w, origin.width);
    b.h = Math.min(b.h, origin.height);
    drag.box = b;
    showAt(drag.entry.slot, b, origin);
  }

  async function end() {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.frame.classList.remove('is-dragging');
    markTarget(null);
    if (!d.moved) return;
    if (d.mode === 'move' && d.target) {
      // Every tab of the dragged box joins, the shown one last so it opens.
      const members = d.entry.box.members.map(w => w.id).sort((a, b) => (a === d.entry.shown) - (b === d.entry.shown));
      for (const id of members) {
        const res = await run({ type: 'layerGroup', widget: id, with: d.target.box.lead.id, mode: 'join' });
        if (!(res && res.ok)) return;
      }
      return;
    }
    run({ type: 'layerMove', target: d.entry.box.lead.id, position: 'keep', size: 'keep', rect: fractions(d.box, d.origin) });
  }

  // ── Frames over the boxes ─────────────────────────────────────────────────
  function frameFor(entry) {
    let frame = frames.get(entry.slot);
    if (!frame) {
      frame = document.createElement('div');
      frame.className = 'layer-edit-frame';
      const remove = cross('layer-edit-remove', tr('layer_edit_remove', 'Take off the screen'));
      const grip = document.createElement('span');
      grip.className = 'layer-edit-resize';
      grip.setAttribute('aria-hidden', 'true');
      frame.append(remove, grip);
      const pin = canAttach ? attachButton() : null;
      if (pin) frame.appendChild(pin);
      frames.set(entry.slot, frame);
      wire(frame, remove, pin);
    }
    // The entry changes with every redraw; the handlers read the current one.
    entryOf.set(frame, entry);
    return frame;
  }

  // A pin: from then on the widget follows one app's window.
  function attachButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'layer-edit-attach';
    const label = tr('layer_edit_attach', 'Attach to an app');
    btn.setAttribute('aria-label', label);
    btn.title = label;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M6 2h4M7 2v4L4.5 9h7L9 6V2M8 9v5');
    svg.appendChild(path);
    btn.appendChild(svg);
    return btn;
  }

  function wire(frame, remove, pin) {
    const owns = (el, target) => !!el && (target === el || el.contains(target));
    frame.addEventListener('pointerdown', (e) => {
      if (owns(remove, e.target) || owns(pin, e.target)) return;
      const resize = !!(e.target.closest && e.target.closest('.layer-edit-resize'));
      begin(e, entryOf.get(frame), resize ? 'resize' : 'move');
    });
    frame.addEventListener('pointermove', moveTo);
    frame.addEventListener('pointerup', end);
    frame.addEventListener('pointercancel', end);
    remove.addEventListener('click', () => run({ type: 'layerRemove', target: entryOf.get(frame).shown }));
    if (pin) pin.addEventListener('click', () => openAttach(entryOf.get(frame).shown));
  }

  // A grouped box keeps its tab bar usable: the frame starts under it, and
  // each tab gets a small cross that takes it out of the box.
  function decorateTabs(entry, frame) {
    const tile = entry.slot.querySelector('.layer-tabs');
    const tabs = tile ? tile.querySelector('.tabgroup-bar') : null;
    frame.style.setProperty('--layer-edit-top', tabs ? (tabs.offsetTop + tabs.offsetHeight) + 'px' : '0px');
    if (!tabs) return;
    for (const tab of Array.from(tabs.children)) {
      if (tab.querySelector('.layer-edit-untab')) continue;
      const out = cross('layer-edit-untab', tr('layer_edit_untab', 'Take out of the tabs'), 'span');
      out.addEventListener('click', (e) => {
        e.stopPropagation();
        run({ type: 'layerGroup', widget: tab.dataset.member, mode: 'leave' });
      });
      tab.appendChild(out);
    }
  }

  function refresh() {
    if (!api) return;
    ensureBar();
    // An anchored window IS its widget: it follows its app, nothing to drag.
    if (api.surface === 'anchor') return;
    mountPages();
    if (window.LayerEditPages) window.LayerEditPages.refresh();
    for (const entry of api.boxes()) {
      const frame = frameFor(entry);
      if (frame.parentNode !== entry.slot) entry.slot.appendChild(frame);
      decorateTabs(entry, frame);
    }
  }

  function start(hostApi) {
    api = hostApi;
    document.documentElement.dataset.layerEditing = 'true';
    refresh();
    if (api.surface !== 'anchor') learnAttach();
  }

  // Frames are drawn at once; the pin joins them when the server says the
  // shell can follow an app (frames are rebuilt only if that changed).
  async function learnAttach() {
    const list = await api.run({ type: 'layerList' });
    const can = !!(list && list.ok && list.attach === true);
    desks = list && list.ok && list.desks ? list.desks : null;
    if (!api || !bar || can === canAttach) return;
    canAttach = can;
    for (const entry of api.boxes()) {
      const frame = frames.get(entry.slot);
      if (frame) frame.remove();
      frames.delete(entry.slot);
    }
    refresh();
  }

  function stop() {
    drag = null;
    closeSheet();
    if (window.LayerEditPages) window.LayerEditPages.unmount();
    delete document.documentElement.dataset.layerEditing;
    if (bar) { bar.remove(); bar = null; }
    if (!api) return;
    for (const entry of api.boxes()) {
      const frame = frames.get(entry.slot);
      if (frame) frame.remove();
      frames.delete(entry.slot);
      for (const out of Array.from(entry.slot.querySelectorAll('.layer-edit-untab'))) out.remove();
    }
  }

  window.LayerEdit = Object.freeze({ start, stop, refresh });
})();
