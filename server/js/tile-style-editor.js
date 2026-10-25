// Per-tile style editor: one tile's own colours, material, shape, background
// picture, frame and overlays. Opened from the edit bar (dashboard-grid.js).
//
// Every change repaints the tile at once and persists through setTileStyle()
// after a short pause; normalizeTileStyle() (dashboard-instances.js) is the one
// validator on the way to the store, and the online Maker uses the same one.
//
// There is no "Follow theme / Customize" switch any more. A colour the user
// picks is in effect, a colour they did not pick is the theme's, and every row
// says which. The style is stored with mode "custom" exactly when it carries a
// colour, a gradient or a font, which is what applyTileStyle() has always
// required before painting them.
(() => {
  'use strict';

  const mk = (tag, cls, text) => makeEl(tag, cls, text);
  const F = () => window.TileStyleFields;
  const tt = (k, fb) => (typeof t === 'function' ? t(k) : fb) || fb;
  const COPY_KEY = 'xenon.tileStyleClipboard';

  // Style field → the palette key it overrides and the token the tile paints.
  const COLORS = {
    panel: ['surface', '--surface'], surfaceAlt: ['surfaceAlt', '--surface-alt'],
    controlColor: ['control', '--control-bg'], text: ['text', '--text'],
    mutedText: ['muted', '--muted-text'], accentText: ['onAccent', '--on-accent'],
    accent: ['accent', '--accent'], lineColor: ['line', '--line'],
    successColor: ['success', '--color-success'], warningColor: ['warning', '--color-warn'],
    dangerColor: ['danger', '--color-danger'], infoColor: ['info', '--color-info'],
  };
  const EFFECTS = ['panelAlpha', 'radius', 'glassBlur', 'glassSaturate', 'borderStrength', 'shadowStrength'];
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const Model = (typeof window !== 'undefined' && window.TileStyleDecorModel)
    || (typeof require === 'function' ? require('./tile-style-decor-model.js') : null);

  // The stored style → the editor's working copy. Colours saved without
  // mode "custom" were never painted, so they are not shown as the tile's.
  function workingCopy(cur) {
    const custom = cur.mode === 'custom';
    const work = {
      contrastGuard: custom && typeof cur.contrastGuard === 'boolean' ? cur.contrastGuard : null,
      panelGrad: {
        c1: (custom && cur.panelGrad && cur.panelGrad.c1) || '', c2: (custom && cur.panelGrad && cur.panelGrad.c2) || '',
        angle: num(cur.panelGrad && cur.panelGrad.angle, 135),
      },
      font: (custom && cur.font) || 'inherit',
      shape: {
        preset: (cur.shape && cur.shape.preset) || '', path: (cur.shape && cur.shape.path) || '',
        fit: (cur.shape && cur.shape.fit === 'fit') ? 'fit' : 'stretch',
        inset: (cur.shape && typeof cur.shape.inset === 'number') ? cur.shape.inset : null,
      },
      decor: Model.decorWorkingCopy(cur.decor),
      controls: Model.controlsWorkingCopy(cur.controls),
      tabs: tabsWorkingCopy(cur.tabs),
    };
    Object.keys(COLORS).forEach((k) => { work[k] = (custom && cur[k]) || ''; });
    EFFECTS.forEach((k) => { work[k] = typeof cur[k] === 'number' ? cur[k] : null; });
    return work;
  }

  // A tab group's tab colours: every tab gets an entry as its fields are built.
  function tabsWorkingCopy(t) {
    const items = {};
    const src = (t && t.items) || {};
    Object.keys(src).forEach((mid) => { items[mid] = Object.assign({}, src[mid]); });
    return { barBg: (t && t.barBg) || '', items };
  }

  function buildStyle(work) {
    const raw = {};
    Object.keys(COLORS).forEach((k) => { if (work[k]) raw[k] = work[k]; });
    if (work.panelGrad.c1 && work.panelGrad.c2) raw.panelGrad = work.panelGrad;
    if (work.font && work.font !== 'inherit') raw.font = work.font;
    const custom = Object.keys(raw).length > 0;
    raw.mode = custom ? 'custom' : 'inherit';
    if (custom && typeof work.contrastGuard === 'boolean') raw.contrastGuard = work.contrastGuard;
    EFFECTS.forEach((k) => { if (work[k] != null) raw[k] = work[k]; });
    if (work.shape.preset || work.shape.path) {
      const s = work.shape.preset ? { preset: work.shape.preset } : { path: work.shape.path };
      if (work.shape.fit === 'fit') s.fit = 'fit';
      if (work.shape.inset != null) s.inset = work.shape.inset;
      raw.shape = s;
    }
    raw.decor = Model.compactDecor(work.decor);
    raw.controls = work.controls;
    if (work.tabs) raw.tabs = work.tabs;
    const DI = window.DashboardInstances || {};
    return DI.normalizeTileStyle ? DI.normalizeTileStyle(raw) : raw;
  }

  function tileEl(id) {
    // By attribute: copy ids contain '~', which breaks CSS selectors.
    for (const n of document.querySelectorAll('.grid-stack-item[gs-id]')) {
      if (n.getAttribute('gs-id') === id) return n;
    }
    return null;
  }

  // A tab group's tabs as [{ id, label }], named as the bar shows them; [] for
  // any other tile.
  function groupTabs(id) {
    const layout = getDashboardLayout();
    const group = layout && layout.groups && layout.groups[id];
    if (!group || !Array.isArray(group.members)) return [];
    const el = tileEl(id);
    const shown = {};
    if (el) el.querySelectorAll('.tabgroup-tab[data-member]').forEach((tab) => {
      const lab = tab.querySelector('.tabgroup-tab-label');
      shown[tab.dataset.member] = (lab && lab.textContent.trim()) || '';
    });
    return group.members.map((mid) => ({ id: mid, label: shown[mid] || mid }));
  }

  function colorsPane(ctx) {
    const { work, commit, pal } = ctx;
    const pane = mk('div', 'tile-style-body');
    const el = tileEl(ctx.id);
    // A mounted SDK widget paints its own look edge to edge: it receives these
    // colours as its theme and uses them only if its author made it do so.
    if (el && el.querySelector('.cw-wrap.cw-mounted')) {
      pane.appendChild(mk('div', 'tile-style-hint', tt('tile_style_sdk_hint', 'This widget draws its own colours. It receives the ones chosen here and uses them if it supports them.')));
    }
    const fields = [];
    const color = (key, label) => {
      const f = F().colorField({ label, tt, theme: pal[COLORS[key][0]], get: () => work[key], set: (v) => { work[key] = v; }, onChange: commit });
      fields.push([key, f]);
      return f.row;
    };
    const group = (title, rows) => { const s = F().section(title); rows.forEach((r) => s.appendChild(r)); pane.appendChild(s); };
    group(tt('tile_style_group_panel', 'Panel'), [
      color('panel', tt('tile_style_panel', 'Panel background')),
      F().gradientField({ label: tt('decor_gradient', 'Gradient'), obj: work.panelGrad, seed1: pal.accent, seed2: pal.surface, onChange: commit, tt }).row,
      color('surfaceAlt', tt('tile_style_surface_alt', 'Secondary surface')),
      color('controlColor', tt('tile_style_control', 'Fields & controls')),
    ]);
    group(tt('tile_style_group_text', 'Text'), [
      color('text', tt('tile_style_text', 'Text')),
      color('mutedText', tt('tile_style_muted', 'Muted text')),
      color('accentText', tt('tile_style_accent_text', 'Text on accent')),
      F().selectField({
        label: tt('tile_style_font', 'Font'),
        options: [['inherit', tt('tile_font_inherit', 'Default (global)')], ['inter', 'Inter'], ['pressstart', 'Press Start 2P'], ['vt323', 'VT323']],
        get: () => work.font, set: (v) => { work.font = v; }, onChange: commit,
      }).row,
      F().toggleField({
        label: tt('tile_style_contrast', 'Keep text readable'),
        get: () => (typeof work.contrastGuard === 'boolean' ? work.contrastGuard : !!pal.guard),
        set: (v) => { work.contrastGuard = v; }, onChange: commit,
      }).row,
    ]);
    group(tt('tile_style_group_states', 'Accent and states'), [
      color('accent', tt('tile_style_accent', 'Accent')),
      color('lineColor', tt('tile_style_line', 'Lines & borders')),
      color('successColor', tt('tile_style_success', 'Success')),
      color('warningColor', tt('tile_style_warning', 'Warning')),
      color('dangerColor', tt('tile_style_danger', 'Danger')),
      color('infoColor', tt('tile_style_info', 'Information')),
    ]);
    // After each repaint: what the tile really shows, so a colour the contrast
    // guard moved says so instead of looking like the pick did not take.
    ctx.afterPaint.push(() => {
      const tile = tileEl(ctx.id);
      const cs = tile ? getComputedStyle(tile) : null;
      fields.forEach(([key, f]) => f.refresh(cs ? cs.getPropertyValue(COLORS[key][1]).trim() : ''));
    });
    return pane;
  }

  function effectsPane(ctx) {
    const { work, commit, hs } = ctx;
    const pane = mk('div', 'tile-style-body');
    const fx = (key, label, min, max, step, theme, format) => F().rangeField({
      label, tt, min, max, step, theme, format, get: () => work[key], set: (v) => { work[key] = v; }, onChange: () => { syncHint(); commit(); },
    });
    const pct = (v) => `${Math.round(v * 100)}%`;
    const opacity = fx('panelAlpha', tt('tile_style_opacity', 'Panel opacity'), 0, 1, 0.01, num(hs.panelAlpha, 0.94), pct);
    const blur = fx('glassBlur', tt('tile_style_glass_blur', 'Glass blur'), 0, 40, 1, 0, (v) => `${Math.round(v)} px`);
    const sat = fx('glassSaturate', tt('tile_style_glass_saturate', 'Glass saturation'), 100, 220, 5, num(hs.glassSaturate, 160), (v) => `${Math.round(v)}%`);
    // Blur shows only THROUGH the panel. Rather than lowering the opacity behind
    // the user's back, the hint offers to do it.
    const hint = mk('div', 'tile-style-hint');
    hint.appendChild(mk('span', '', tt('tile_style_glass_hint', 'Blur only shows through a translucent panel.')));
    const fix = mk('button', 'tsf-link', tt('tile_style_glass_fix', 'Make the panel translucent'));
    fix.type = 'button';
    fix.addEventListener('click', () => { work.panelAlpha = 0.55; opacity.refresh(); syncHint(); commit(); });
    hint.appendChild(fix);
    const syncHint = () => {
      const alpha = work.panelAlpha != null ? work.panelAlpha : num(hs.panelAlpha, 0.94);
      hint.hidden = !(work.glassBlur > 0 && alpha >= 0.95);
    };
    const material = F().section(tt('tile_style_group_material', 'Material'));
    [opacity, blur, sat].forEach((f) => material.appendChild(f.row));
    material.appendChild(hint);
    const edges = F().section(tt('tile_style_group_edges', 'Edges'));
    [
      fx('radius', tt('tile_style_radius', 'Corner radius'), 0, 2, 0.05, num(hs.uiRoundness, 1), (v) => `${Math.round(16 * v)} px`),
      fx('borderStrength', tt('tile_style_border', 'Panel border'), 0, 2, 0.05, num(hs.panelBorderStrength, 1), pct),
      fx('shadowStrength', tt('tile_style_shadow', 'Panel shadow'), 0, 2, 0.05, num(hs.tileShadowStrength, 0), pct),
    ].forEach((f) => edges.appendChild(f.row));
    pane.append(material, edges);
    shapeSection(ctx, pane);
    syncHint();
    return pane;
  }

  function shapeThumb(d) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 1 1');
    // Keep the shape's own proportions in the chip: squashed flat, a circle, a
    // blob and an arch all read as the same ellipse.
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d || 'M 0 0 L 1 0 L 1 1 L 0 1 Z');
    p.setAttribute('fill', 'currentColor');
    svg.appendChild(p);
    return svg;
  }

  function shapeSection(ctx, pane) {
    const { work, commit } = ctx;
    const DI = window.DashboardInstances || {};
    const shape = work.shape;
    const sec = F().section(tt('tile_style_shape', 'Shape'));
    const grid = mk('div', 'tile-shape-grid');
    const chips = [];
    const pathInput = mk('input', 'tile-shape-path');
    const extra = mk('div', 'tsf-section');
    const sync = () => {
      chips.forEach(({ btn, id }) => btn.classList.toggle('active', shape.preset === id && (id || !shape.path)));
      extra.hidden = !(shape.preset || shape.path);
    };
    const chip = (id, label, d) => {
      const btn = mk('button', 'tile-shape-chip'); btn.type = 'button'; btn.title = label;
      btn.append(shapeThumb(d), mk('span', '', label));
      btn.addEventListener('click', () => { shape.preset = id; if (id) shape.path = ''; pathInput.value = shape.path; sync(); commit(); });
      grid.appendChild(btn);
      chips.push({ btn, id });
    };
    chip('', tt('tile_shape_none', 'Rectangle'), '');
    ((window.TileShapePresets && window.TileShapePresets.TILE_SHAPES) || []).forEach((s) => chip(s.id, tt(s.labelKey, s.label), s.d));
    // The code door: any closed SVG path in a 0..1 square. A rejected path is
    // named, never swallowed: an ignored path looks like a shape that broke.
    const pathRow = mk('div', 'tsf-row tsf-col');
    pathInput.type = 'text';
    pathInput.placeholder = 'M 0.5 0 L 1 0.5 L 0.5 1 L 0 0.5 Z';
    pathInput.value = shape.path || '';
    pathInput.setAttribute('aria-label', tt('tile_shape_path', 'Custom path (SVG, 0–1 square)'));
    const err = mk('div', 'tile-style-hint tile-style-hint-err', tt('tile_shape_path_bad', 'That is not a usable path: it must start with M, end closed with Z, and contain only path commands and numbers.'));
    err.hidden = true;
    pathInput.addEventListener('input', () => {
      const v = pathInput.value.trim();
      shape.path = v;
      if (v) shape.preset = '';
      const ok = !v || !!(DI.normalizeTileShape && DI.normalizeTileShape({ path: v }));
      err.hidden = ok;
      if (ok) { sync(); commit(); }
    });
    pathRow.append(mk('span', 'tsf-label', tt('tile_shape_path', 'Custom path (SVG, 0–1 square)')), pathInput, err);
    extra.append(
      F().rangeField({ label: tt('tile_shape_inset', 'Safe margin'), tt, min: 0, max: 25, step: 1, theme: 6, format: (v) => `${v}%`, get: () => shape.inset, set: (v) => { shape.inset = v; }, onChange: commit }).row,
      F().toggleField({ label: tt('tile_shape_fit', 'Keep proportions'), get: () => shape.fit === 'fit', set: (v) => { shape.fit = v ? 'fit' : 'stretch'; }, onChange: commit }).row,
    );
    sec.append(grid, pathRow, extra);
    pane.appendChild(sec);
    sync();
  }

  // ── Shell ─────────────────────────────────────────────────────────────────
  let overlayEl = null;
  let flush = null;

  function close() {
    // Flush a pending persist so closing right after a drag never drops it.
    if (flush) { const f = flush; flush = null; try { f(); } catch (_) {} }
    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  }

  function readClipboard() {
    try { const raw = localStorage.getItem(COPY_KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }

  function makeDraggable(pop, head, overlay) {
    let from = null;
    head.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      const r = pop.getBoundingClientRect();
      pop.style.position = 'fixed'; pop.style.margin = '0';
      pop.style.left = `${r.left}px`; pop.style.top = `${r.top}px`;
      overlay.classList.add('is-moved');
      from = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      try { head.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    head.addEventListener('pointermove', (e) => {
      if (!from) return;
      const w = pop.offsetWidth, h = Math.min(pop.offsetHeight, window.innerHeight - 12);
      pop.style.left = `${Math.max(6, Math.min(window.innerWidth - w - 6, from.left + e.clientX - from.x))}px`;
      pop.style.top = `${Math.max(6, Math.min(window.innerHeight - h - 6, from.top + e.clientY - from.y))}px`;
    });
    const end = (e) => { from = null; try { head.releasePointerCapture(e.pointerId); } catch (_) {} };
    head.addEventListener('pointerup', end);
    head.addEventListener('pointercancel', end);
  }

  function tabs(pop, list) {
    const bar = mk('div', 'tile-style-tabs');
    bar.setAttribute('role', 'tablist');
    list.forEach(([label, pane], i) => {
      const b = mk('button', i === 0 ? 'active' : '', label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      pane.hidden = i !== 0;
      b.addEventListener('click', () => {
        list.forEach(([, p]) => { p.hidden = p !== pane; });
        bar.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      });
      bar.appendChild(b);
    });
    pop.appendChild(bar);
    list.forEach(([, pane]) => pop.appendChild(pane));
  }

  function footer(ctx) {
    const foot = mk('div', 'tile-style-foot');
    const reset = mk('button', 'tile-style-btn', tt('tile_style_reset', 'Reset')); reset.type = 'button';
    reset.addEventListener('click', () => {
      // Drop the pending persist FIRST, or closing would write it back.
      ctx.cancel();
      setTileStyle(ctx.id, null);
      close();
    });
    const copy = mk('button', 'tile-style-btn', tt('tile_style_copy', 'Copy style')); copy.type = 'button';
    const paste = mk('button', 'tile-style-btn', tt('tile_style_paste', 'Paste style')); paste.type = 'button';
    paste.disabled = !readClipboard();
    copy.addEventListener('click', () => {
      try { localStorage.setItem(COPY_KEY, JSON.stringify(buildStyle(ctx.work))); } catch (_) { return; }
      paste.disabled = false;
      if (window.XenonToast) window.XenonToast.show({ type: 'success', kicker: tt('tile_style_title', 'Widget style'), message: tt('tile_style_copied', 'Style copied. Open another widget and paste it.') });
    });
    paste.addEventListener('click', () => {
      const DI = window.DashboardInstances || {};
      const style = DI.normalizeTileStyle ? DI.normalizeTileStyle(readClipboard()) : null;
      if (!style) return;
      ctx.cancel();
      setTileStyle(ctx.id, style);
      open(ctx.id);   // rebuild every field from the pasted style
    });
    const done = mk('button', 'tile-style-btn primary', tt('tile_style_done', 'Done')); done.type = 'button';
    done.addEventListener('click', close);
    const left = mk('div', 'tile-style-foot-group');
    left.append(reset, copy, paste);
    foot.append(left, done);
    return foot;
  }

  function open(id) {
    if (!id) return;
    close();
    const hs = (typeof hubSettings !== 'undefined' && hubSettings) || {};
    const pal = (typeof window.getEffectiveThemePalette === 'function' && window.getEffectiveThemePalette()) || {};
    const work = workingCopy(tileStyleForId(getDashboardLayout(), id) || {});
    const afterPaint = [];
    // Continuous inputs fire dozens of times a second: repaint only this tile
    // now, persist (store write, all-tile repaint, settings save) once it settles.
    let timer = null;
    const persist = () => { timer = null; setTileStyle(id, buildStyle(work)); };
    const commit = () => {
      const el = tileEl(id);
      if (el) applyTileStyle(el, buildStyle(work));
      afterPaint.forEach((fn) => fn());
      clearTimeout(timer);
      timer = setTimeout(persist, 250);
    };
    const cancel = () => { clearTimeout(timer); timer = null; flush = null; };
    flush = () => { if (timer) { clearTimeout(timer); persist(); } };
    const TDP = window.TileDecorPresets || {
      TILE_DECOR_FRAMES: [], TILE_DECOR_OVERLAYS: [], TILE_DECOR_OVERLAY_CATS: [], TILE_DECOR_LOOKS: [],
      tileFramePresetUrl: () => '', tileOverlayPresetUrl: () => '',
    };
    const toast = (m) => { if (window.XenonToast) window.XenonToast.show({ type: 'error', kicker: tt('tile_style_title', 'Widget style'), message: String(m).slice(0, 200) }); };
    const busyPick = (btn, fn) => {
      btn.disabled = true;
      Promise.resolve().then(fn).catch((e) => toast(tt('decor_upload_failed', 'Upload failed') + (e && e.message ? `: ${e.message}` : '')))
        .finally(() => { btn.disabled = false; });
    };
    const ctx = { id, work, commit, cancel, hs, pal, afterPaint, TDP, tt, toast, busyPick, seedAccent: pal.accent };

    const overlay = mk('div', 'tile-style-overlay');
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
    const pop = mk('div', 'tile-style-pop wide');
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', tt('tile_style_title', 'Widget style'));
    const head = mk('div', 'tile-style-head tile-style-drag', tt('tile_style_title', 'Widget style'));
    pop.appendChild(head);
    makeDraggable(pop, head, overlay);
    const panes = [
      [tt('tile_style_tab_colors', 'Colours'), colorsPane(ctx)],
      [tt('tile_style_tab_fx', 'Effects'), effectsPane(ctx)],
      [tt('tile_style_tab_bg', 'Background'), window.TileStyleDecorPanes.backgroundPane(ctx)],
      [tt('tile_style_tab_decor', 'Decor'), window.TileStyleDecorPanes.decorPane(ctx)],
      [tt('tile_style_tab_controls', 'Controls'), window.TileStyleControlsPane.controlsPane(ctx)],
    ];
    // Only a tab group has tabs to colour, one by one.
    const members = groupTabs(id);
    if (members.length && window.TileStyleTabsPane) panes.push([tt('tile_style_tab_tabs', 'Tabs'), window.TileStyleTabsPane.tabsPane(ctx, members)]);
    tabs(pop, panes);
    pop.appendChild(footer(ctx));
    overlay.appendChild(pop);
    document.body.appendChild(overlay);
    // The shared dropdown instead of the native list, which the OS places and
    // which drops off the bottom of the Edge. data-cs-fixed: this panel scrolls.
    if (typeof window.initCustomSelect === 'function') {
      pop.querySelectorAll('select').forEach((s) => {
        if (s.dataset.csInit) return;
        s.setAttribute('data-cs-fixed', '');
        window.initCustomSelect(s);
      });
    }
    overlayEl = overlay;
    afterPaint.forEach((fn) => fn());
  }

  if (typeof window !== 'undefined') {
    window.openTileStyleEditor = open;
    window.closeTileStyleEditor = close;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { workingCopy, buildStyle };
})();
