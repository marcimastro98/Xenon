'use strict';
// Canvas Ambient editor — change an installed scene right on the screen.
//
// Opened from Settings → Ambient (a scene's Edit button). The scene is shown
// full screen exactly as the screensaver draws it (js/ambient-canvas.js in edit
// mode: one page, every element in view, nothing playing), with a toolbar, a
// selection box and an options panel on top. Tap an element to select it, drag
// it to move it, drag a corner to resize it; add elements and installed
// widgets, change their layer, duplicate or delete them; change the background
// and the pages. A scene is not started from nothing here: that is Xenon Maker.
//
// The working copy is plain scene JSON; the normalizer (js/ambient-scene.js)
// runs on every repaint and on save, which goes through settings.js
// (saveAmbientScene). Every listener is added on open and removed on close.

(function () {
  if (typeof window === 'undefined') return;

  const F = () => window.AmbientEditorFields;
  const Form = () => window.AmbientEditorForm;
  const AS = () => window.AmbientScene;
  const tt = (key) => (typeof window.t === 'function' ? window.t(key) : key);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
  const UNDO_MAX = 40;

  // Static, trusted icon markup (never built from data).
  const S = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  const ICON = {
    add: S('<path d="M12 5v14M5 12h14"/>'),
    scene: S('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/>'),
    undo: S('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
    prev: S('<path d="m15 18-6-6 6-6"/>'),
    next: S('<path d="m9 18 6-6-6-6"/>'),
    close: S('<path d="M18 6 6 18M6 6l12 12"/>'),
    copy: S('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'),
    up: S('<path d="m6 15 6-6 6 6"/>'),
    down: S('<path d="m6 9 6 6 6-6"/>'),
    trash: S('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  };

  let s = null;   // the open session

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function iconBtn(cls, icon, label, onClick, withText) {
    const b = el('button', 'ace-btn ' + cls);
    b.type = 'button';
    b.innerHTML = ICON[icon];   // static SVG only
    if (withText) b.appendChild(el('span', 'ace-btn-label', label));
    b.setAttribute('aria-label', label);
    b.title = label;
    b.addEventListener('click', onClick);
    return b;
  }
  const stage = () => document.getElementById('ambient-canvas-stage');
  const overlay = () => document.getElementById('ambient-canvas-overlay');
  const comps = () => s.scene.components;
  const selected = () => (s && s.sel ? comps().find(c => c.id === s.sel) || null : null);
  const pageCount = () => (s.scene.pages && s.scene.pages.count > 1 ? s.scene.pages.count : 1);
  const itemEl = (id) => stage().querySelector('.ac-item[data-ac-id="' + id + '"]');   // ids are [a-z0-9-] only

  // ── changes and undo ────────────────────────────────────────────────────
  // A change begins with a snapshot (taken once per gesture) and ends with a
  // commit that files it for undo.
  function begin() { if (!s.pending) s.pending = JSON.stringify(s.scene); }
  function commit() {
    if (!s.pending) return;
    if (s.pending !== JSON.stringify(s.scene)) {
      s.undo.push(s.pending);
      if (s.undo.length > UNDO_MAX) s.undo.shift();
    }
    s.pending = null;
    syncBar();
  }
  function undo() {
    if (!s.undo.length) return;
    s.scene = JSON.parse(s.undo.pop());
    if (s.sel && !selected()) s.sel = null;
    s.page = Math.min(s.page, pageCount() - 1);
    repaint();
    renderPanel();
    syncBar();
  }
  const dirty = () => JSON.stringify(AS().normalizeScene(s.scene)) !== s.original;

  // ── repaint ─────────────────────────────────────────────────────────────
  let paintQueued = false;
  function repaint(now) {
    if (!now) {
      if (paintQueued) return;
      paintQueued = true;
      requestAnimationFrame(() => { paintQueued = false; if (s) repaint(true); });
      return;
    }
    window.AmbientCanvas.refresh(s.scene, { edit: { page: s.page } });
    placeSelection();
  }
  // Geometry only: move the one element without a rebuild (drags, number boxes).
  function placeItem(c) {
    const n = itemEl(c.id);
    if (n) { n.style.left = c.x + '%'; n.style.top = c.y + '%'; n.style.width = c.w + '%'; n.style.height = c.h + '%'; }
    placeSelection();
  }
  function placeSelection() {
    const c = selected();
    const box = s.dom.sel;
    if (!c || !AS().onPage(c, s.page)) { box.hidden = true; return; }
    box.hidden = false;
    box.style.left = c.x + '%'; box.style.top = c.y + '%';
    box.style.width = c.w + '%'; box.style.height = c.h + '%';
    // Panel and toolbar move to the side the element is not on, so it stays in view.
    s.dom.panel.classList.toggle('is-left', c.x + c.w / 2 > 50);
    s.dom.bar.classList.toggle('is-top', c.y + c.h > 78);
  }

  // ── selection, drag, resize ─────────────────────────────────────────────
  function select(id) {
    s.sel = id;
    s.panel = id ? 'element' : (s.panel === 'element' ? null : s.panel);
    placeSelection();
    renderPanel();
  }
  function onPointerDown(e) {
    if (e.button > 0) return;
    const handle = e.target.closest && e.target.closest('.ace-handle');
    const item = !handle && e.target.closest && e.target.closest('#ambient-canvas-stage .ac-item:not(.ac-off)');
    if (!handle && !item && !e.target.closest('.ace-sel')) {
      if (e.target.closest('#ambient-canvas-stage')) select(null);
      return;
    }
    const id = handle ? s.sel : (item ? item.dataset.acId : s.sel);
    if (!id) return;
    if (id !== s.sel) select(id);
    const c = selected();
    if (!c) return;
    e.preventDefault();
    const rect = stage().getBoundingClientRect();
    s.drag = { id: e.pointerId, mode: handle ? handle.dataset.h : 'move', x0: e.clientX, y0: e.clientY, rect, from: { x: c.x, y: c.y, w: c.w, h: c.h }, moved: false };
    begin();
  }
  function onPointerMove(e) {
    const d = s && s.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = (e.clientX - d.x0) / d.rect.width * 100;
    const dy = (e.clientY - d.y0) / d.rect.height * 100;
    if (!d.moved && Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) < 4) return;
    d.moved = true;
    const c = selected();
    const f = d.from;
    if (d.mode === 'move') {
      c.x = clamp(f.x + dx, 0, 100 - f.w);
      c.y = clamp(f.y + dy, 0, 100 - f.h);
    } else {
      // A corner: the opposite corner stays put.
      const west = d.mode.includes('w'), north = d.mode.includes('n');
      const right = f.x + f.w, bottom = f.y + f.h;
      if (west) { c.x = clamp(f.x + dx, 0, right - 2); c.w = right - c.x; } else c.w = clamp(f.w + dx, 2, 100 - f.x);
      if (north) { c.y = clamp(f.y + dy, 0, bottom - 2); c.h = bottom - c.y; } else c.h = clamp(f.h + dy, 2, 100 - f.y);
    }
    placeItem(c);
  }
  function onPointerUp(e) {
    const d = s && s.drag;
    if (!d || e.pointerId !== d.id) return;
    s.drag = null;
    if (d.moved) { commit(); renderPanel(); } else s.pending = null;
  }
  function onKey(e) {
    if (!s) return;
    const typing = e.target.closest && e.target.closest('input, textarea, select');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); return; }
    if (typing) return;
    if (e.key === 'Escape') { e.preventDefault(); if (s.addOpen) toggleAdd(false); else if (s.sel) select(null); else if (s.panel) { s.panel = null; renderPanel(); } return; }
    const c = selected();
    if (!c) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); return; }
    const step = e.shiftKey ? 5 : 1;
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!mv) return;
    e.preventDefault();
    begin();
    c.x = clamp(c.x + mv[0], 0, 100 - c.w);
    c.y = clamp(c.y + mv[1], 0, 100 - c.h);
    placeItem(c);
    commit();
    renderPanel();
  }

  // ── element actions ─────────────────────────────────────────────────────
  function restack(list) { list.forEach((c, i) => { c.z = i; }); }
  function byLayer() { return comps().slice().sort((a, b) => (a.z || 0) - (b.z || 0)); }
  function addElement(type, pkg) {
    if (comps().length >= AS().MAX_COMPONENTS) return;
    const [w, h] = F().NEW_SIZE[type] || [20, 20];
    const props = clone(F().NEW_PROPS[type] || {});
    if (type === 'text') props.text = tt('ace_new_text');
    if (pkg) props.pkgId = pkg.id;
    const raw = { id: AS().genId('cmp'), type, x: Math.round(50 - w / 2), y: Math.round(50 - h / 2), w, h, z: comps().length, props };
    if (pageCount() > 1) raw.page = s.page;
    const c = AS().normalizeComponent(raw);
    if (!c) return;
    begin();
    comps().push(c);
    restack(byLayer());
    commit();
    toggleAdd(false);
    s.sel = c.id;
    s.panel = 'element';
    repaint(true);
    renderPanel();
  }
  function duplicateSelected() {
    const c = selected();
    if (!c || comps().length >= AS().MAX_COMPONENTS) return;
    begin();
    const copy = clone(c);
    copy.id = AS().genId('cmp');
    copy.x = clamp(c.x + 2, 0, 100 - c.w);
    copy.y = clamp(c.y + 2, 0, 100 - c.h);
    const order = byLayer();
    order.splice(order.indexOf(c) + 1, 0, copy);
    comps().push(copy);
    restack(order);
    commit();
    s.sel = copy.id;
    repaint(true);
    renderPanel();
  }
  function moveLayer(dir) {
    const c = selected();
    if (!c) return;
    const order = byLayer();
    const i = order.indexOf(c), j = i + dir;
    if (j < 0 || j >= order.length) return;
    begin();
    [order[i], order[j]] = [order[j], order[i]];
    restack(order);
    commit();
    repaint(true);
  }
  function removeSelected() {
    const c = selected();
    if (!c) return;
    begin();
    s.scene.components = comps().filter(x => x !== c);
    restack(byLayer());
    commit();
    s.sel = null;
    s.panel = null;
    repaint(true);
    renderPanel();
  }

  // ── a field changed in the panel ────────────────────────────────────────
  function applyField(target, f, v) {
    const { setPath } = Form();
    if (f.path === 'pages.count') {
      if (v <= 1) delete target.pages;
      else target.pages = { every: 30, transition: 'fade', ...(target.pages || {}), count: v };
      s.page = Math.min(s.page, pageCount() - 1);
      return;
    }
    if (f.path.startsWith('anim.')) {
      target.anim = { in: 'none', loop: 'none', speed: 1, delay: 0, ...(target.anim || {}) };
      setPath(target, f.path, v);
      if (target.anim.in === 'none' && target.anim.loop === 'none') delete target.anim;
      return;
    }
    if (f.kind === 'page') { if (v === -1) delete target.page; else target.page = v; return; }
    if (f.kind === 'time' || f.kind === 'days') {
      const show = { ...(target.show || {}) };
      if (f.kind === 'time') { delete show.from; delete show.to; if (v) Object.assign(show, v); }
      else if (v) show.days = v; else delete show.days;
      if (Object.keys(show).length) target.show = show; else delete target.show;
      return;
    }
    if ((f.path === 'opacity' && v === 100) || (f.path === 'scale' && v === 100)) { delete target[f.path]; return; }
    if (f.path === 'bg.type' && v === 'gradient' && !target.bg.grad) target.bg.grad = Form().DEFAULT_GRAD();
    setPath(target, f.path, v === null ? undefined : v);
  }
  function onField(f, v, final) {
    const target = s.panel === 'scene' ? s.scene : selected();
    if (!target) return;
    begin();
    applyField(target, f, v);
    if (f.live) placeItem(target); else repaint(final);
    if (final) { commit(); renderPanel(); syncBar(); }
  }

  // ── panel ───────────────────────────────────────────────────────────────
  function renderPanel() {
    const p = s.dom.panel;
    const c = selected();
    const mode = s.panel === 'element' && c ? 'element' : s.panel === 'scene' ? 'scene' : null;
    p.hidden = !mode;
    overlay().classList.toggle('ace-panel-open', !!mode);
    if (!mode) return;
    const scroll = s.dom.form.scrollTop;
    const pkg = c && c.type === 'sdk' ? installedWidgets().find(w => w.id === c.props.pkgId) : null;
    s.dom.title.textContent = mode === 'scene' ? tt('ace_scene') : pkg ? (pkg.name || pkg.id) : tt('ace_t_' + c.type);
    s.dom.acts.hidden = mode !== 'element';
    const groups = mode === 'scene' ? F().sceneGroups() : F().elementGroups(c);
    Form().build(s.dom.form, mode === 'scene' ? s.scene : c, groups, { pageCount: pageCount() }, onField);
    s.dom.form.scrollTop = scroll;
  }
  function openScenePanel() {
    s.sel = null;
    s.panel = s.panel === 'scene' ? null : 'scene';
    placeSelection();
    renderPanel();
  }

  // ── add menu ────────────────────────────────────────────────────────────
  function installedWidgets() {
    const list = window.CustomWidget && CustomWidget.cachedPackages ? CustomWidget.cachedPackages() : [];
    return list.filter(p => p && p.id && p.surface !== 'ambient');
  }
  function toggleAdd(open) {
    s.addOpen = open == null ? !s.addOpen : open;
    s.dom.add.hidden = !s.addOpen;
    s.dom.addBtn.setAttribute('aria-expanded', String(s.addOpen));
    if (!s.addOpen) return;
    const full = comps().length >= AS().MAX_COMPONENTS;
    const frag = document.createDocumentFragment();
    if (full) frag.appendChild(el('p', 'ace-add-note', tt('ace_full')));
    const grid = frag.appendChild(el('div', 'ace-add-grid'));
    for (const type of F().ADD_ORDER) {
      const b = el('button', 'ace-add-item', tt('ace_t_' + type));
      b.type = 'button';
      b.disabled = full;
      b.addEventListener('click', () => addElement(type));
      grid.appendChild(b);
    }
    const widgets = installedWidgets();
    if (widgets.length) {
      frag.appendChild(el('h3', 'ace-sec-title', tt('ace_widgets')));
      const wgrid = frag.appendChild(el('div', 'ace-add-grid'));
      for (const pkg of widgets) {
        const b = el('button', 'ace-add-item', pkg.name || pkg.id);   // untrusted → textContent
        b.type = 'button';
        b.disabled = full;
        b.addEventListener('click', () => addElement('sdk', pkg));
        wgrid.appendChild(b);
      }
    }
    s.dom.add.replaceChildren(frag);
  }

  // ── toolbar ─────────────────────────────────────────────────────────────
  function setPage(p) {
    s.page = (p + pageCount()) % pageCount();
    if (s.sel && !AS().onPage(selected(), s.page)) s.sel = null;
    repaint(true);
    renderPanel();
    syncBar();
  }
  function syncBar() {
    const n = pageCount();
    s.dom.pager.hidden = n < 2;
    s.dom.pageLabel.textContent = tt('ace_page_of').replace('{n}', String(s.page + 1)).replace('{count}', String(n));
    s.dom.undoBtn.disabled = !s.undo.length;
    s.dom.saveBtn.disabled = !dirty();
    if (s.confirmCancel && !dirty()) s.confirmCancel = false;
    s.dom.cancelBtn.querySelector('.ace-btn-label').textContent = tt(s.confirmCancel ? 'ace_discard' : 'ace_cancel');
    s.dom.cancelBtn.classList.toggle('is-danger', !!s.confirmCancel);
  }
  function setStatus(key, kind) {
    s.dom.status.textContent = key ? tt(key) : '';
    s.dom.status.dataset.kind = kind || '';
  }
  function onCancel() {
    if (dirty() && !s.confirmCancel) {
      // First tap on unsaved changes asks; the button says what a second one does.
      s.confirmCancel = true;
      syncBar();
      clearTimeout(s.confirmTimer);
      s.confirmTimer = setTimeout(() => { if (s) { s.confirmCancel = false; syncBar(); } }, 4000);
      return;
    }
    close();
  }
  function onSave() {
    const scene = AS().normalizeScene(s.scene);
    const ok = typeof window.saveAmbientScene === 'function' && window.saveAmbientScene(scene);
    if (!ok) { setStatus('ace_save_failed', 'error'); return; }
    close();
    if (window.XenonToast) window.XenonToast.show({ type: 'success', title: tt('ace_saved') });
  }

  function buildChrome() {
    const o = overlay();
    const layer = el('div', 'ace-layer');
    const sel = layer.appendChild(el('div', 'ace-sel'));
    sel.hidden = true;
    for (const h of ['nw', 'ne', 'sw', 'se']) {
      const handle = sel.appendChild(el('span', 'ace-handle ace-handle-' + h));
      handle.dataset.h = h;
    }
    const bar = el('div', 'ace-bar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', tt('ace_title'));
    const addBtn = iconBtn('ace-btn-add', 'add', tt('ace_add'), () => toggleAdd(), true);
    addBtn.setAttribute('aria-haspopup', 'true');
    const sceneBtn = iconBtn('', 'scene', tt('ace_scene'), openScenePanel, true);
    const undoBtn = iconBtn('', 'undo', tt('ace_undo'), undo, true);
    const pager = el('div', 'ace-pager');
    const pageLabel = el('span', 'ace-page-label');
    pager.append(iconBtn('ace-btn-icon', 'prev', tt('ace_prev_page'), () => setPage(s.page - 1)), pageLabel, iconBtn('ace-btn-icon', 'next', tt('ace_next_page'), () => setPage(s.page + 1)));
    const status = el('span', 'ace-status');
    status.setAttribute('role', 'status');
    const cancelBtn = iconBtn('', 'close', tt('ace_cancel'), onCancel, true);
    const saveBtn = el('button', 'ace-btn ace-btn-save', tt('ace_save'));
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', onSave);
    bar.append(addBtn, sceneBtn, undoBtn, pager, status, cancelBtn, saveBtn);
    const add = el('div', 'ace-add');
    add.hidden = true;
    const panel = el('aside', 'ace-panel');
    panel.hidden = true;
    const head = panel.appendChild(el('div', 'ace-panel-head'));
    const title = head.appendChild(el('h2', 'ace-panel-title'));
    head.appendChild(iconBtn('ace-btn-icon', 'close', tt('ace_close_panel'), () => { s.panel = null; s.sel = null; placeSelection(); renderPanel(); }));
    const acts = panel.appendChild(el('div', 'ace-acts'));
    acts.append(
      iconBtn('ace-btn-icon', 'copy', tt('ace_duplicate'), duplicateSelected),
      iconBtn('ace-btn-icon', 'up', tt('ace_forward'), () => moveLayer(1)),
      iconBtn('ace-btn-icon', 'down', tt('ace_backward'), () => moveLayer(-1)),
      iconBtn('ace-btn-icon is-danger', 'trash', tt('ace_delete'), removeSelected),
    );
    const form = panel.appendChild(el('div', 'ace-form'));
    const chrome = [layer, add, panel, bar];
    o.append(...chrome);
    s.dom = { chrome, layer, sel, bar, add, addBtn, sceneBtn, undoBtn, pager, pageLabel, status, cancelBtn, saveBtn, panel, title, acts, form };
  }

  // ── open / close ────────────────────────────────────────────────────────
  // Edit the installed scene `id`. Returns false when it cannot be opened.
  function open(id) {
    if (s || !window.AmbientCanvas || !AS() || !F() || !Form()) return false;
    const list = (typeof hubSettings === 'object' && hubSettings && Array.isArray(hubSettings.ambientScenes)) ? hubSettings.ambientScenes : [];
    const found = list.find(x => x && x.id === id);
    if (!found) return false;
    if (window.AmbientMode && AmbientMode.isOpen && AmbientMode.isOpen()) AmbientMode.close();
    const scene = AS().normalizeScene(clone(found));
    const fromSettings = !!(document.getElementById('settings-overlay') && !document.getElementById('settings-overlay').hidden);
    if (fromSettings && typeof closeSettings === 'function') closeSettings();
    s = { id, scene, original: JSON.stringify(scene), page: 0, sel: null, panel: null, undo: [], pending: null, drag: null, addOpen: false, fromSettings, dom: null };
    // Anything else that closes the overlay (Ambient switched off, another
    // surface) takes the editor down with it instead of leaving it orphaned.
    if (!window.AmbientCanvas.mount(clone(scene), { edit: { page: 0 }, onUnmount: () => close() })) { s = null; return false; }
    buildChrome();
    overlay().addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    document.addEventListener('keydown', onKey);
    syncBar();
    return true;
  }
  function close() {
    if (!s || s.closing) return;
    s.closing = true;
    const o = overlay();
    o.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    document.removeEventListener('keydown', onKey);
    clearTimeout(s.confirmTimer);
    for (const n of s.dom.chrome) n.remove();
    o.classList.remove('ace-panel-open');
    const back = s.fromSettings;
    s = null;
    window.AmbientCanvas.unmount();
    if (back && typeof openSettings === 'function') openSettings('lock');
  }

  window.AmbientCanvasEditor = { open, close, isOpen: () => !!s };
})();
