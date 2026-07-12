'use strict';
// Ambient Scene Editor — the fullscreen WYSIWYG composer.
//
// Lets the user build a native canvas Ambient scene (js/ambient-scene.js) by
// direct manipulation: drop components from a palette onto a device-true 32:9
// stage, move/resize/rotate them freely, and tune per-component properties and
// style in the inspector. The result is saved into hubSettings.ambientScenes and
// referenced by ambientMode.sceneId as "canvas:<id>".
//
// It renders through js/ambient-canvas.js's EXACT build pipeline
// (AmbientCanvas.preview.*), so the composing preview can never drift from what
// the screensaver actually shows. All geometry is PERCENT of the stage (never
// pixels), so a scene stays responsive from the 14.5" ultrawide down to a browser
// window. Style edits go through DashboardInstances.normalizeTileStyle — the same
// validator the dashboard tiles use. Untrusted text is only ever rendered by the
// canvas renderer via textContent; the editor stores raw strings in props.
//
// window.AmbientEditor = { open(sceneId?), close, isOpen }.

(function () {
  if (typeof window === 'undefined') return;

  const AS = () => window.AmbientScene;
  const ACP = () => (window.AmbientCanvas && window.AmbientCanvas.preview) || null;
  const DI = () => window.DashboardInstances || null;

  // Palette catalog: groups → component types with an icon and a sensible default
  // size (percent of the stage). Order mirrors the design brief (Base / Dashboard
  // / Free) so the most-reached-for components sit first.
  const CATALOG = [
    { group: ['ambient_editor_grp_base', 'Base'], items: [
      { type: 'clock', ico: '🕐', w: 32, h: 26 },
      { type: 'date', ico: '📅', w: 30, h: 12 },
      { type: 'weather', ico: '🌤️', w: 26, h: 24 },
      { type: 'media', ico: '🎵', w: 42, h: 16 },
      { type: 'agenda', ico: '🗓️', w: 34, h: 28 },
    ] },
    { group: ['ambient_editor_grp_dash', 'Dashboard'], items: [
      { type: 'tasks', ico: '✅', w: 30, h: 28 },
      { type: 'notes', ico: '📝', w: 32, h: 26 },
      { type: 'system', ico: '📊', w: 24, h: 22 },
      { type: 'network', ico: '🌐', w: 22, h: 16 },
    ] },
    { group: ['ambient_editor_grp_free', 'Elementi liberi'], items: [
      { type: 'text', ico: '🅣', w: 44, h: 14 },
      { type: 'image', ico: '🖼️', w: 28, h: 40 },
      { type: 'shape', ico: '⬛', w: 30, h: 24 },
      { type: 'sdk', ico: '🧩', w: 32, h: 34 },
    ] },
  ];
  const ICON_OF = {};
  const NAME_KEY = {};
  CATALOG.forEach(g => g.items.forEach(it => {
    ICON_OF[it.type] = it.ico;
    NAME_KEY[it.type] = 'ambient_cmp_' + it.type;
  }));
  const DEF_OF = (type) => {
    for (const g of CATALOG) for (const it of g.items) if (it.type === type) return it;
    return { type, w: 30, h: 20 };
  };

  // ── module state ─────────────────────────────────────────────────────────
  let built = false;
  let overlay, stage, stageFrame, nameInput, paletteEl, inspectorEl, captionEl, selbox;
  let scene = null;          // working copy (always normalized)
  let items = [];            // [{ comp, el, body, sig, dynamic }] — mirror of the stage
  let selId = null;
  let previewTimer = null;
  const undoStack = [];
  const redoStack = [];
  let armed = null;          // JSON snapshot captured at the start of an interaction

  function tt(key, fb) {
    const v = (typeof window.t === 'function') ? window.t(key) : key;
    return (v === key && fb != null) ? fb : v;
  }
  function toast(titleKey, fb, type) {
    if (window.XenonToast) window.XenonToast.show({ type: type || 'info', title: tt(titleKey, fb) });
  }
  function el(tag, cls, txt) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function isOpen() { return !!(overlay && !overlay.hidden); }
  function savedScenes() {
    const arr = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.ambientScenes : null;
    return Array.isArray(arr) ? arr : [];
  }
  function sel() { return scene && scene.components.find(c => c.id === selId) || null; }
  function maxZ() { return scene.components.reduce((m, c) => Math.max(m, c.z || 0), -1); }
  function cachedPkgs() {
    return (window.CustomWidget && typeof CustomWidget.cachedPackages === 'function')
      ? CustomWidget.cachedPackages() : [];
  }

  // ── undo / redo ───────────────────────────────────────────────────────────
  function armUndo() { if (armed == null) armed = JSON.stringify(scene); }
  function commitUndo() {
    if (armed == null) return;
    if (armed !== JSON.stringify(scene)) {
      undoStack.push(armed);
      if (undoStack.length > 60) undoStack.shift();
      redoStack.length = 0;
    }
    armed = null;
  }
  function pushUndo() { armUndo(); commitUndo(); }
  function restore(json) {
    scene = AS().normalizeScene(JSON.parse(json));
    selId = scene.components.some(c => c.id === selId) ? selId : null;
    renderStage(); renderInspector(); updateCaption();
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(scene));
    restore(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(scene));
    restore(redoStack.pop());
  }

  // ── build the editor shell once ────────────────────────────────────────────
  function ensureShell() {
    if (built) return true;
    overlay = document.getElementById('ambient-editor-overlay');
    if (!overlay) return false;

    const bar = el('div', 'ae-topbar');
    const title = el('div', 'ae-title');
    title.append(el('span', 'ae-dot'), el('span', null, tt('ambient_editor_title', 'Editor scena Ambient')));
    nameInput = el('input', 'ae-name-input');
    nameInput.type = 'text';
    nameInput.maxLength = (AS() && AS().MAX_NAME) || 60;
    nameInput.placeholder = tt('ambient_editor_name_ph', 'Nome scena');
    nameInput.addEventListener('input', updateCaption);
    const spacer = el('div', 'ae-spacer');
    const actions = el('div', 'ae-actions');
    const undoBtn = el('button', 'ae-btn ghost', '↶');
    undoBtn.title = tt('ambient_editor_undo', 'Annulla (Ctrl+Z)');
    undoBtn.addEventListener('click', undo);
    const redoBtn = el('button', 'ae-btn ghost', '↷');
    redoBtn.title = tt('ambient_editor_redo', 'Ripeti (Ctrl+Shift+Z)');
    redoBtn.addEventListener('click', redo);
    const cancelBtn = el('button', 'ae-btn ghost', tt('cancel', 'Annulla'));
    cancelBtn.addEventListener('click', requestClose);
    const saveBtn = el('button', 'ae-btn primary', tt('save', 'Salva'));
    saveBtn.addEventListener('click', save);
    actions.append(undoBtn, redoBtn, cancelBtn, saveBtn);
    bar.append(title, nameInput, spacer, actions);

    const main = el('div', 'ae-main');
    paletteEl = el('aside', 'ae-rail ae-palette');
    const area = el('div', 'ae-canvas-area');
    stageFrame = el('div', 'ae-stage-frame');
    stage = el('div', 'ambient-editor-stage ae-show-guides');
    stage.id = 'ambient-editor-stage';
    stageFrame.appendChild(stage);
    captionEl = el('div', 'ae-stage-caption');
    area.append(stageFrame, captionEl);
    inspectorEl = el('aside', 'ae-rail ae-inspector');
    main.append(paletteEl, area, inspectorEl);

    // Selection box lives inside the stage, positioned over the selected item.
    selbox = el('div', 'ae-selbox');
    selbox.hidden = true;
    ['nw', 'ne', 'se', 'sw'].forEach(h => {
      const handle = el('div', 'ae-handle');
      handle.dataset.h = h;
      handle.addEventListener('pointerdown', onHandleDown);
      selbox.appendChild(handle);
    });
    selbox.appendChild(el('div', 'ae-rot-stem'));
    const rot = el('div', 'ae-handle-rot');
    rot.dataset.h = 'rot';
    rot.addEventListener('pointerdown', onHandleDown);
    selbox.appendChild(rot);
    selbox.addEventListener('pointerdown', onSelboxDown);

    stage.addEventListener('pointerdown', onStageDown);
    overlay.replaceChildren(bar, main);
    built = true;
    return true;
  }

  // ── palette ────────────────────────────────────────────────────────────────
  function buildPalette() {
    const frag = document.createDocumentFragment();
    const hasPkgs = cachedPkgs().length > 0;
    CATALOG.forEach(g => {
      const grp = el('div', 'ae-pal-group');
      grp.appendChild(el('div', 'ae-rail-title', tt(g.group[0], g.group[1])));
      const grid = el('div', 'ae-pal-grid');
      g.items.forEach(it => {
        const btn = el('button', 'ae-pal-item');
        btn.type = 'button';
        btn.append(el('span', 'ae-pal-ico', it.ico), el('span', null, tt(NAME_KEY[it.type], it.type)));
        if (it.type === 'sdk' && !hasPkgs) { btn.disabled = true; btn.title = tt('ambient_editor_no_sdk', 'Nessun widget della community installato'); }
        btn.addEventListener('click', () => addComponent(it.type));
        grid.appendChild(btn);
      });
      grp.appendChild(grid);
      frag.appendChild(grp);
    });
    paletteEl.replaceChildren(frag);
  }

  // ── stage rendering ─────────────────────────────────────────────────────────
  function makeItem(comp) {
    const acp = ACP();
    if (!acp) return null;
    const item = acp.buildItem(comp);
    if (!item) return null;
    acp.update(item);   // one pass so dynamic components paint real data
    item.el.dataset.cid = comp.id;
    return item;
  }
  function renderStage() {
    const acp = ACP();
    if (!acp) return;
    const frag = document.createDocumentFragment();
    frag.appendChild(acp.buildBg(scene.bg));
    items = [];
    scene.components.slice().sort((a, b) => (a.z || 0) - (b.z || 0)).forEach(comp => {
      const item = makeItem(comp);
      if (item) { frag.appendChild(item.el); items.push(item); }
    });
    stage.replaceChildren(frag);
    stage.appendChild(selbox);
    markSelected();
    syncSelbox();
  }
  function applyBg() {
    const acp = ACP();
    scene.bg = AS().normalizeBg(scene.bg);
    const old = stage.querySelector('.ac-bg');
    const fresh = acp.buildBg(scene.bg);
    if (old) old.replaceWith(fresh); else stage.insertBefore(fresh, stage.firstChild);
  }
  function rebuildItem(comp) {
    const idx = items.findIndex(it => it.comp.id === comp.id);
    const fresh = makeItem(comp);
    if (!fresh) return;
    if (idx >= 0) { items[idx].el.replaceWith(fresh.el); items[idx] = fresh; }
    else stage.insertBefore(fresh.el, selbox);
    markSelected();
    syncSelbox();
  }
  function applyGeom(comp) {
    const it = items.find(x => x.comp.id === comp.id);
    if (it) {
      it.el.style.left = comp.x + '%';
      it.el.style.top = comp.y + '%';
      it.el.style.width = comp.w + '%';
      it.el.style.height = comp.h + '%';
      it.el.style.transform = comp.rot ? `rotate(${comp.rot}deg)` : '';
    }
    if (comp.id === selId) syncSelbox();
  }
  function markSelected() {
    items.forEach(it => it.el.classList.toggle('ae-selected', it.comp.id === selId));
  }
  function syncSelbox() {
    const comp = sel();
    if (!comp) { selbox.hidden = true; return; }
    selbox.style.left = comp.x + '%';
    selbox.style.top = comp.y + '%';
    selbox.style.width = comp.w + '%';
    selbox.style.height = comp.h + '%';
    selbox.style.transform = comp.rot ? `rotate(${comp.rot}deg)` : '';
    selbox.hidden = false;
  }
  function select(id) {
    selId = id;
    markSelected();
    syncSelbox();
    renderInspector();
    updateCaption();
  }

  // ── pointer interactions ────────────────────────────────────────────────────
  function stageRect() { return stage.getBoundingClientRect(); }
  function onStageDown(e) {
    // Empty background (stage itself or the .ac-bg layer) deselects.
    if (e.target === stage || (e.target.classList && e.target.classList.contains('ac-bg'))) {
      select(null);
      return;
    }
    const itemEl = e.target.closest && e.target.closest('.ac-item');
    if (itemEl && itemEl.dataset.cid) {
      e.preventDefault();
      const comp = scene.components.find(c => c.id === itemEl.dataset.cid);
      if (!comp) return;
      if (comp.id !== selId) select(comp.id);
      beginMove(e, comp);
    }
  }
  function onSelboxDown(e) {
    if (e.target !== selbox) return;   // a handle child → its own listener
    const comp = sel();
    if (comp) { e.preventDefault(); beginMove(e, comp); }
  }
  function onHandleDown(e) {
    const comp = sel();
    if (!comp) return;
    e.preventDefault();
    e.stopPropagation();
    const h = e.currentTarget.dataset.h;
    if (h === 'rot') beginRotate(comp);
    else beginResize(comp, h);
  }

  function dragLoop(onMove) {
    armUndo();
    const move = (ev) => onMove(ev);
    const up = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      commitUndo();
      renderInspector();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  }
  function beginMove(e, comp) {
    const r = stageRect();
    const sx = e.clientX, sy = e.clientY, cx = comp.x, cy = comp.y;
    dragLoop((ev) => {
      const dx = (ev.clientX - sx) / r.width * 100;
      const dy = (ev.clientY - sy) / r.height * 100;
      comp.x = Math.round(clamp(cx + dx, 0, 100));
      comp.y = Math.round(clamp(cy + dy, 0, 100));
      applyGeom(comp);
    });
  }
  // Rotation-aware corner resize. All math in PIXELS (percent space is skewed
  // because width≠height in px), converted back to percent on commit. The corner
  // opposite the handle stays pinned; size clamps to the normalizer's 2% floor.
  function beginResize(comp, corner) {
    const r = stageRect();
    const W = r.width, H = r.height;
    const hx = corner === 'ne' || corner === 'se' ? 1 : -1;
    const hy = corner === 'sw' || corner === 'se' ? 1 : -1;
    const ang = (comp.rot || 0) * Math.PI / 180;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const w0 = comp.w / 100 * W, h0 = comp.h / 100 * H;
    const cx0 = (comp.x + comp.w / 2) / 100 * W;
    const cy0 = (comp.y + comp.h / 2) / 100 * H;
    // World position of the pinned (opposite) corner.
    const fx = cx0 + (-hx * w0 / 2) * cos - (-hy * h0 / 2) * sin;
    const fy = cy0 + (-hx * w0 / 2) * sin + (-hy * h0 / 2) * cos;
    const minW = 2 / 100 * W, minH = 2 / 100 * H;
    dragLoop((ev) => {
      const px = ev.clientX - r.left, py = ev.clientY - r.top;
      const vx = px - fx, vy = py - fy;
      const lx = vx * cos + vy * sin;    // rotate delta into the item's local axes
      const ly = -vx * sin + vy * cos;
      const nw = Math.max(minW, Math.abs(lx));
      const nh = Math.max(minH, Math.abs(ly));
      const ncx = fx + (hx * nw / 2) * cos - (hy * nh / 2) * sin;
      const ncy = fy + (hx * nw / 2) * sin + (hy * nh / 2) * cos;
      comp.w = Math.round(clamp(nw / W * 100, 2, 100));
      comp.h = Math.round(clamp(nh / H * 100, 2, 100));
      comp.x = Math.round(clamp(ncx / W * 100 - comp.w / 2, 0, 100));
      comp.y = Math.round(clamp(ncy / H * 100 - comp.h / 2, 0, 100));
      applyGeom(comp);
    });
  }
  function beginRotate(comp) {
    const r = stageRect();
    const cx = r.left + (comp.x + comp.w / 2) / 100 * r.width;
    const cy = r.top + (comp.y + comp.h / 2) / 100 * r.height;
    dragLoop((ev) => {
      let deg = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90;
      if (deg > 180) deg -= 360;
      if (deg < -180) deg += 360;
      for (const s of [-180, -90, 0, 90, 180]) if (Math.abs(deg - s) < 4) deg = s;
      comp.rot = Math.round(deg);
      applyGeom(comp);
    });
  }

  // ── add / remove / order ────────────────────────────────────────────────────
  function addComponent(type) {
    if (scene.components.length >= AS().MAX_COMPONENTS) {
      toast('ambient_editor_limit', 'Limite componenti raggiunto', 'error');
      return;
    }
    const def = DEF_OF(type);
    const raw = { type, x: Math.round(50 - def.w / 2), y: Math.round(50 - def.h / 2), w: def.w, h: def.h };
    if (type === 'text') raw.props = { text: tt('ambient_editor_sample_text', 'Testo') };
    if (type === 'sdk') {
      const pkg = cachedPkgs()[0];
      if (!pkg) { toast('ambient_editor_no_sdk', 'Nessun widget della community installato', 'error'); return; }
      raw.props = { pkgId: pkg.id, entry: pkg.entry || 'index.html' };
    }
    const comp = AS().normalizeComponent(raw);
    if (!comp) return;
    pushUndo();
    comp.z = Math.min(AS().MAX_COMPONENTS, maxZ() + 1);
    scene.components.push(comp);
    renderStage();
    select(comp.id);
    updateCaption();
  }
  function deleteSelected() {
    const comp = sel();
    if (!comp) return;
    pushUndo();
    scene.components = scene.components.filter(c => c.id !== comp.id);
    selId = null;
    renderStage();
    renderInspector();
    updateCaption();
  }
  function duplicateSelected() {
    const comp = sel();
    if (!comp || scene.components.length >= AS().MAX_COMPONENTS) return;
    pushUndo();
    const clone = AS().normalizeComponent({
      ...JSON.parse(JSON.stringify(comp)),
      id: '', // force a fresh id
      x: Math.round(clamp(comp.x + 3, 0, 100)),
      y: Math.round(clamp(comp.y + 3, 0, 100)),
    });
    if (!clone) return;
    clone.z = Math.min(AS().MAX_COMPONENTS, maxZ() + 1);
    scene.components.push(clone);
    renderStage();
    select(clone.id);
  }
  function reorder(dir) {
    const comp = sel();
    if (!comp) return;
    pushUndo();
    const sorted = scene.components.slice().sort((a, b) => (a.z || 0) - (b.z || 0));
    const i = sorted.indexOf(comp);
    sorted.splice(i, 1);
    if (dir === 'front') sorted.push(comp); else sorted.unshift(comp);
    sorted.forEach((c, idx) => { c.z = idx; });
    renderStage();
  }

  // ── inspector ────────────────────────────────────────────────────────────────
  function row(labelKey, fb, control, col) {
    const r = el('label', 'ae-field' + (col ? ' col' : ''));
    r.appendChild(el('span', null, tt(labelKey, fb)));
    r.appendChild(control);
    return r;
  }
  function selectCtl(options, current, onChange) {
    const s = el('select', 'ae-select');
    options.forEach(o => {
      const opt = el('option', null, tt(o[1], o[2] || o[0]));
      opt.value = o[0];
      if (o[0] === String(current)) opt.selected = true;
      s.appendChild(opt);
    });
    s.addEventListener('focus', armUndo);
    s.addEventListener('change', () => { onChange(s.value); commitUndo(); });
    return s;
  }
  function seg(options, current, onChange) {
    const wrap = el('div', 'ae-seg');
    options.forEach(o => {
      const b = el('button', current === o[0] ? 'on' : '', tt(o[1], o[2] || o[0]));
      b.type = 'button';
      b.addEventListener('click', () => {
        pushUndo();
        wrap.querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        onChange(o[0]);
      });
      wrap.appendChild(b);
    });
    return wrap;
  }
  function toggleCtl(checked, onChange) {
    const c = el('input', 'ae-toggle');
    c.type = 'checkbox';
    c.checked = !!checked;
    c.addEventListener('change', () => { pushUndo(); onChange(c.checked); });
    return c;
  }
  function numberCtl(value, min, max, onChange) {
    const n = el('input', 'ae-input mini');
    n.type = 'number';
    n.min = min; n.max = max; n.value = value;
    n.addEventListener('focus', armUndo);
    n.addEventListener('input', () => { const v = Number(n.value); if (Number.isFinite(v)) onChange(clamp(v, min, max)); });
    n.addEventListener('change', commitUndo);
    return n;
  }
  function colorCtl(value, onInput) {
    const c = el('input', 'ae-color');
    c.type = 'color';
    c.value = /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#1ed760';
    c.addEventListener('focus', armUndo);
    c.addEventListener('input', () => onInput(c.value));
    c.addEventListener('change', commitUndo);
    return c;
  }
  function rangeCtl(value, min, max, step, onInput) {
    const s = el('input', 'ae-range');
    s.type = 'range';
    s.min = min; s.max = max; s.step = step; s.value = value;
    s.addEventListener('pointerdown', armUndo);
    s.addEventListener('input', () => onInput(Number(s.value)));
    s.addEventListener('change', commitUndo);
    return s;
  }
  // Read a picked image file as a bounded data: URL (validated again by the
  // normalizer's imageSrc allowlist before it lands in props).
  function imageInput(onData) {
    const wrap = el('div', 'ae-field col');
    const f = el('input');
    f.type = 'file';
    f.accept = 'image/png,image/jpeg,image/webp,image/gif';
    f.className = 'ae-input';
    f.addEventListener('change', () => {
      const file = f.files && f.files[0];
      if (!file) return;
      if (file.size > 1000000) { toast('ambient_editor_img_big', 'Immagine troppo grande (max 1 MB)', 'error'); f.value = ''; return; }
      const rd = new FileReader();
      rd.onload = () => { pushUndo(); onData(String(rd.result || '')); };
      rd.readAsDataURL(file);
      f.value = '';
    });
    wrap.append(f, el('div', 'ae-file-hint', tt('ambient_editor_img_hint', 'PNG/JPG/WebP/GIF · max 1 MB')));
    return wrap;
  }

  // Mutate a component's props, re-normalize the whole component so props stay
  // bounded, and rebuild just that item.
  function setProp(comp, patch) {
    const nextProps = Object.assign({}, comp.props, patch);
    const fresh = AS().normalizeComponent({ ...comp, props: nextProps });
    if (fresh) { comp.props = fresh.props; rebuildItem(comp); }
  }
  function setStyle(comp, key, val) {
    const s = Object.assign({ mode: 'custom' }, comp.style || {});
    s.mode = 'custom';
    if (val == null || val === '') delete s[key]; else s[key] = val;
    comp.style = DI() ? DI().normalizeTileStyle(s) : null;
    rebuildItem(comp);
  }

  function section(titleKey, fb) {
    const s = el('div', 'ae-section');
    s.appendChild(el('div', 'ae-section-title', tt(titleKey, fb)));
    return s;
  }
  function propControls(comp) {
    const s = section('ambient_editor_props', 'Proprietà');
    const p = comp.props || {};
    const add = (r) => s.appendChild(r);
    switch (comp.type) {
      case 'clock':
        add(row('ambient_prop_format', 'Formato', seg([['auto', 'ambient_fmt_auto', 'Auto'], ['24', 'ambient_fmt_24', '24h'], ['12', 'ambient_fmt_12', '12h']], p.format, v => setProp(comp, { format: v }))));
        add(row('ambient_prop_seconds', 'Secondi', toggleCtl(p.seconds, v => setProp(comp, { seconds: v }))));
        break;
      case 'date':
        add(row('ambient_prop_variant', 'Stile', selectCtl([['full', 'ambient_date_full', 'Completa'], ['weekday', 'ambient_date_weekday', 'Giorno'], ['short', 'ambient_date_short', 'Breve'], ['numeric', 'ambient_date_numeric', 'Numerica']], p.variant, v => setProp(comp, { variant: v }))));
        break;
      case 'weather':
        add(row('ambient_prop_detail', 'Condizione', toggleCtl(p.detail, v => setProp(comp, { detail: v }))));
        add(row('ambient_prop_art', 'Icona', toggleCtl(p.art, v => setProp(comp, { art: v }))));
        break;
      case 'media':
        add(row('ambient_prop_art', 'Copertina', toggleCtl(p.art, v => setProp(comp, { art: v }))));
        break;
      case 'agenda':
        add(row('ambient_prop_count', 'Righe', numberCtl(p.count, 1, 6, v => setProp(comp, { count: v }))));
        break;
      case 'tasks':
        add(row('ambient_prop_count', 'Righe', numberCtl(p.count, 1, 8, v => setProp(comp, { count: v }))));
        add(row('ambient_prop_showdone', 'Mostra completate', toggleCtl(p.showDone, v => setProp(comp, { showDone: v }))));
        break;
      case 'system':
        add(row('ambient_prop_metric', 'Metrica', selectCtl([['all', 'ambient_metric_all', 'Tutte'], ['cpu', 'ambient_metric_cpu', 'CPU'], ['gpu', 'ambient_metric_gpu', 'GPU'], ['ram', 'ambient_metric_ram', 'RAM']], p.metric, v => setProp(comp, { metric: v }))));
        break;
      case 'text': {
        const ta = el('textarea', 'ae-input');
        ta.rows = 3;
        ta.maxLength = (AS() && AS().MAX_TEXT) || 400;
        ta.value = p.text || '';
        ta.addEventListener('focus', armUndo);
        ta.addEventListener('input', () => setProp(comp, { text: ta.value }));
        ta.addEventListener('change', commitUndo);
        add(row('ambient_prop_text', 'Testo', ta, true));
        add(row('ambient_prop_size', 'Dimensione', rangeCtl(p.size, 8, 240, 2, v => setProp(comp, { size: v })), true));
        add(row('ambient_prop_weight', 'Peso', selectCtl([['300', '', 'Light'], ['400', '', 'Regular'], ['600', '', 'Semibold'], ['700', '', 'Bold'], ['800', '', 'Heavy']], p.weight, v => setProp(comp, { weight: Number(v) }))));
        add(row('ambient_prop_align', 'Allineamento', seg([['left', 'ambient_align_left', '⟸'], ['center', 'ambient_align_center', '≡'], ['right', 'ambient_align_right', '⟹']], p.align, v => setProp(comp, { align: v }))));
        add(row('ambient_prop_color', 'Colore', colorCtl(p.color, v => setProp(comp, { color: v }))));
        add(row('ambient_prop_italic', 'Corsivo', toggleCtl(p.italic, v => setProp(comp, { italic: v }))));
        add(row('ambient_prop_upper', 'Maiuscole', toggleCtl(p.uppercase, v => setProp(comp, { uppercase: v }))));
        break;
      }
      case 'image':
        add(imageInput(data => setProp(comp, { url: data })));
        add(row('ambient_prop_fit', 'Adatta', seg([['cover', 'ambient_fit_cover', 'Riempi'], ['contain', 'ambient_fit_contain', 'Contieni'], ['fill', 'ambient_fit_fill', 'Deforma']], p.fit, v => setProp(comp, { fit: v }))));
        add(row('ambient_prop_radius', 'Angoli', rangeCtl(p.radius, 0, 50, 1, v => setProp(comp, { radius: v })), true));
        break;
      case 'shape':
        add(row('ambient_prop_kind', 'Forma', seg([['rect', 'ambient_shape_rect', '▭'], ['ellipse', 'ambient_shape_ellipse', '◯'], ['line', 'ambient_shape_line', '─']], p.kind, v => setProp(comp, { kind: v }))));
        add(row('ambient_prop_color', 'Colore', colorCtl(p.color, v => setProp(comp, { color: v, grad: null }))));
        if (p.kind !== 'line' && p.kind !== 'ellipse') add(row('ambient_prop_radius', 'Angoli', rangeCtl(p.radius, 0, 50, 1, v => setProp(comp, { radius: v })), true));
        break;
      case 'sdk': {
        const pkgs = cachedPkgs();
        const opts = pkgs.length ? pkgs.map(pk => [pk.id, '', pk.name || pk.id]) : [[p.pkgId, '', p.pkgId]];
        add(row('ambient_prop_widget', 'Widget', selectCtl(opts, p.pkgId, v => {
          const pk = pkgs.find(x => x.id === v);
          setProp(comp, { pkgId: v, entry: (pk && pk.entry) || 'index.html' });
        })));
        s.appendChild(el('div', 'ae-file-hint', tt('ambient_editor_sdk_hint', 'Il widget appare se i Community widget sono attivi e concessi.')));
        break;
      }
      default:
        s.appendChild(el('div', 'ae-file-hint', tt('ambient_editor_no_props', 'Nessuna proprietà — usa posizione e stile.')));
    }
    return s;
  }
  function geomControls(comp) {
    const s = section('ambient_editor_geometry', 'Posizione e dimensione');
    const grid = el('div', 'ae-num-row');
    grid.append(
      row('ambient_geo_x', 'X %', numberCtl(comp.x, 0, 100, v => { comp.x = v; applyGeom(comp); })),
      row('ambient_geo_y', 'Y %', numberCtl(comp.y, 0, 100, v => { comp.y = v; applyGeom(comp); })),
      row('ambient_geo_w', 'L %', numberCtl(comp.w, 2, 100, v => { comp.w = v; applyGeom(comp); })),
      row('ambient_geo_h', 'A %', numberCtl(comp.h, 2, 100, v => { comp.h = v; applyGeom(comp); })),
    );
    s.appendChild(grid);
    s.appendChild(row('ambient_geo_rot', 'Rotazione', numberCtl(comp.rot, -180, 180, v => { comp.rot = v; applyGeom(comp); })));
    const zrow = el('div', 'ae-zrow');
    const front = el('button', 'ae-btn ghost', tt('ambient_geo_front', 'Porta avanti'));
    front.type = 'button'; front.addEventListener('click', () => reorder('front'));
    const back = el('button', 'ae-btn ghost', tt('ambient_geo_back', 'Porta indietro'));
    back.type = 'button'; back.addEventListener('click', () => reorder('back'));
    zrow.append(front, back);
    s.appendChild(zrow);
    return s;
  }
  function styleControls(comp) {
    const s = section('ambient_editor_style', 'Stile');
    const st = comp.style || {};
    s.appendChild(row('ambient_style_accent', 'Accento', colorCtl(st.accent || '#1ed760', v => setStyle(comp, 'accent', v))));
    s.appendChild(row('ambient_style_panel', 'Sfondo tile', colorCtl(st.panel || '#12151f', v => setStyle(comp, 'panel', v))));
    s.appendChild(row('ambient_style_opacity', 'Opacità sfondo', rangeCtl(st.panelAlpha != null ? st.panelAlpha : 0, 0, 1, 0.05, v => setStyle(comp, 'panelAlpha', v > 0 ? v : null)), true));
    s.appendChild(row('ambient_style_text', 'Testo', colorCtl(st.text || '#e8ecf4', v => setStyle(comp, 'text', v))));
    const reset = el('button', 'ae-btn ghost', tt('ambient_style_reset', 'Azzera stile'));
    reset.type = 'button';
    reset.addEventListener('click', () => { pushUndo(); comp.style = null; rebuildItem(comp); renderInspector(); });
    s.appendChild(reset);
    return s;
  }
  function actionControls() {
    const s = el('div', 'ae-section');
    const grid = el('div', 'ae-zrow');
    const dup = el('button', 'ae-btn ghost', tt('ambient_scene_duplicate', 'Duplica'));
    dup.type = 'button'; dup.addEventListener('click', duplicateSelected);
    const del = el('button', 'ae-btn ghost ae-danger', tt('ambient_scene_delete', 'Elimina'));
    del.type = 'button'; del.addEventListener('click', deleteSelected);
    grid.append(dup, del);
    s.appendChild(grid);
    return s;
  }
  function backgroundControls() {
    const bg = scene.bg || {};
    const s = section('ambient_editor_background', 'Sfondo scena');
    s.appendChild(row('ambient_bg_type', 'Tipo', seg([
      ['color', 'ambient_bg_color', 'Colore'], ['gradient', 'ambient_bg_gradient', 'Gradiente'], ['image', 'ambient_bg_image', 'Immagine'],
    ], bg.type || 'color', v => { scene.bg.type = v; applyBg(); renderInspector(); })));
    if ((bg.type || 'color') === 'color') {
      s.appendChild(row('ambient_bg_colour', 'Colore', colorCtl(bg.color || '#05060a', v => { scene.bg.color = v; applyBg(); })));
    } else if (bg.type === 'gradient') {
      const g = bg.grad || { from: '#0b1020', to: '#05060a', angle: 180 };
      s.appendChild(row('ambient_bg_from', 'Da', colorCtl(g.from, v => { scene.bg.grad = Object.assign({}, scene.bg.grad || g, { from: v }); applyBg(); })));
      s.appendChild(row('ambient_bg_to', 'A', colorCtl(g.to, v => { scene.bg.grad = Object.assign({}, scene.bg.grad || g, { to: v }); applyBg(); })));
      s.appendChild(row('ambient_bg_angle', 'Angolo', rangeCtl(g.angle != null ? g.angle : 180, 0, 360, 1, v => { scene.bg.grad = Object.assign({}, scene.bg.grad || g, { angle: v }); applyBg(); }), true));
    } else if (bg.type === 'image') {
      s.appendChild(imageInput(data => { scene.bg.url = data; applyBg(); }));
      if (bg.url) {
        const clr = el('button', 'ae-btn ghost', tt('ambient_bg_clear', 'Rimuovi immagine'));
        clr.type = 'button';
        clr.addEventListener('click', () => { pushUndo(); scene.bg.url = ''; scene.bg.type = 'color'; applyBg(); renderInspector(); });
        s.appendChild(clr);
      }
    }
    s.appendChild(row('ambient_bg_dim', 'Oscuramento', rangeCtl(bg.dim || 0, 0, 100, 1, v => { scene.bg.dim = v; applyBg(); }), true));
    s.appendChild(row('ambient_bg_blur', 'Sfocatura', rangeCtl(bg.blur || 0, 0, 30, 1, v => { scene.bg.blur = v; applyBg(); }), true));
    return s;
  }

  function renderInspector() {
    const comp = sel();
    if (!comp) {
      const frag = document.createDocumentFragment();
      frag.appendChild(backgroundControls());
      const hint = el('div', 'ae-insp-empty', tt('ambient_editor_empty', 'Aggiungi un componente dalla palette, oppure selezionane uno per modificarlo.'));
      frag.appendChild(hint);
      inspectorEl.replaceChildren(frag);
      return;
    }
    const frag = document.createDocumentFragment();
    const head = el('div', 'ae-insp-head');
    head.append(el('span', 'ae-pal-ico', ICON_OF[comp.type] || '◆'), el('span', null, tt(NAME_KEY[comp.type], comp.type)));
    frag.appendChild(head);
    frag.appendChild(propControls(comp));
    frag.appendChild(styleControls(comp));
    frag.appendChild(geomControls(comp));
    frag.appendChild(actionControls());
    inspectorEl.replaceChildren(frag);
  }

  function updateCaption() {
    const n = scene ? scene.components.length : 0;
    const name = (nameInput.value || '').trim();
    captionEl.replaceChildren();
    const b = el('b', null, name || tt('ambient_editor_untitled', 'Scena senza nome'));
    captionEl.append(b, document.createTextNode(' · 2560×720 · ' + tt('ambient_editor_count', '{n} componenti').replace('{n}', n)));
  }

  // ── keyboard ─────────────────────────────────────────────────────────────────
  function typingIn(t) {
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }
  function onKey(e) {
    if (!isOpen()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
    if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateSelected(); return; }
    if (typingIn(e.target)) return;
    if (e.key === 'Escape') { e.preventDefault(); selId ? select(null) : requestClose(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selId) { e.preventDefault(); deleteSelected(); return; }
    const comp = sel();
    if (comp && e.key.indexOf('Arrow') === 0) {
      e.preventDefault();
      const step = e.shiftKey ? 5 : 1;
      pushUndo();
      if (e.key === 'ArrowLeft') comp.x = Math.round(clamp(comp.x - step, 0, 100));
      if (e.key === 'ArrowRight') comp.x = Math.round(clamp(comp.x + step, 0, 100));
      if (e.key === 'ArrowUp') comp.y = Math.round(clamp(comp.y - step, 0, 100));
      if (e.key === 'ArrowDown') comp.y = Math.round(clamp(comp.y + step, 0, 100));
      applyGeom(comp);
    }
  }

  // ── preview ticking (dynamic components) ──────────────────────────────────────
  function startPreview() {
    stopPreview();
    previewTimer = setInterval(() => {
      if (document.hidden) return;
      const acp = ACP();
      if (acp) items.forEach(it => { if (it.dynamic) acp.update(it); });
    }, 1000);
  }
  function stopPreview() { if (previewTimer) { clearInterval(previewTimer); previewTimer = null; } }

  // ── open / save / close ───────────────────────────────────────────────────────
  function open(sceneId) {
    if (!ensureShell()) return;
    if (!AS() || !ACP()) { toast('ambient_editor_unavailable', 'Editor non disponibile', 'error'); return; }
    // Warm the SDK package cache so the palette's SDK button and picker are live.
    if (window.CustomWidget && typeof CustomWidget.getPackages === 'function' && !cachedPkgs().length) {
      CustomWidget.getPackages(false).then(() => { if (isOpen()) buildPalette(); }).catch(() => {});
    }
    if (sceneId) {
      const found = savedScenes().find(x => x && x.id === sceneId);
      scene = AS().normalizeScene(found ? JSON.parse(JSON.stringify(found)) : {});
    } else {
      scene = AS().normalizeScene({ name: '' });
    }
    delete scene.imported;   // editing makes it the user's own work (re-exportable)
    undoStack.length = 0; redoStack.length = 0; armed = null; selId = null;
    nameInput.value = scene.name || '';
    buildPalette();
    renderStage();
    renderInspector();
    updateCaption();
    overlay.hidden = false;
    document.body.classList.add('ambient-editor-open');
    startPreview();
    window.addEventListener('keydown', onKey, true);
  }
  function doClose() {
    stopPreview();
    window.removeEventListener('keydown', onKey, true);
    // Drop any SDK preview frames we registered — but never a LIVE canvas scene's
    // frames (the editor shouldn't be open over one, but guard regardless).
    if (window.CustomWidget && CustomWidget.unregisterCanvasFrames
      && !(window.AmbientCanvas && AmbientCanvas.isOpen && AmbientCanvas.isOpen())) {
      CustomWidget.unregisterCanvasFrames();
    }
    if (stage) stage.replaceChildren();
    overlay.hidden = true;
    document.body.classList.remove('ambient-editor-open');
    scene = null; selId = null; items = [];
  }
  function requestClose() {
    if (undoStack.length && !window.confirm(tt('ambient_editor_discard', 'Chiudere senza salvare? Le modifiche andranno perse.'))) return;
    doClose();
  }
  function save() {
    const name = (nameInput.value || '').trim().slice(0, (AS().MAX_NAME) || 60);
    const toSave = Object.assign({}, scene, { name });
    delete toSave.imported;
    const norm = AS().normalizeScene(toSave);
    const list = savedScenes().slice();
    const idx = list.findIndex(s => s && s.id === norm.id);
    if (idx >= 0) list[idx] = norm; else list.push(norm);
    hubSettings = normalizeSettings({ ...hubSettings, ambientScenes: list });
    if (typeof saveHubSettings === 'function') saveHubSettings();
    doClose();
    if (typeof window.onAmbientScenesChanged === 'function') window.onAmbientScenesChanged(norm.id);
    toast('settings_saved', 'Salvato', 'ok');
  }

  window.AmbientEditor = { open, close: doClose, isOpen };
})();
