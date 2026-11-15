// Decor tab, part 2: the overlays (stickers). A strip of the tile's overlays,
// the selected one's settings under it, and the library to add more from,
// grouped by category. `ctx` is the editor's: { work, commit, tt, TDP, pal, busyPick }.
(() => {
  'use strict';

  const mk = (tag, cls, text) => makeEl(tag, cls, text);
  const F = () => window.TileStyleFields;
  const pct = (v) => `${Math.round(v)}%`;
  const px = (v) => `${v} px`;
  const MAX = 8;

  // Coarse anchor → centre coordinates, for an overlay with no explicit x/y yet.
  const ANCHOR_XY = {
    'top-left': [12, 12], 'top': [50, 12], 'top-right': [88, 12],
    'left': [12, 50], 'center': [50, 50], 'right': [88, 50],
    'bottom-left': [12, 88], 'bottom': [50, 88], 'bottom-right': [88, 88],
  };
  const ovXY = (ov) => (typeof ov.x === 'number' && typeof ov.y === 'number')
    ? [ov.x, ov.y] : (ANCHOR_XY[ov.anchor] || ANCHOR_XY['bottom-right']);

  // Free placement: the marker maps 1:1 to tile percent.
  function posPad(ctx, ov, src) {
    const pad = mk('div', 'decor-pospad'); pad.title = ctx.tt('decor_pos_hint', 'Drag to place');
    const dot = mk('div', 'decor-pospad-dot');
    if (src) dot.style.backgroundImage = cssUrl(src);
    pad.appendChild(dot);
    const place = () => { const [x, y] = ovXY(ov); dot.style.left = `${x}%`; dot.style.top = `${y}%`; };
    const setFrom = (e) => {
      const r = pad.getBoundingClientRect();
      ov.x = Math.round(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100)));
      ov.y = Math.round(Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100)));
      place(); ctx.commit();
    };
    let dragging = false;
    pad.addEventListener('pointerdown', (e) => { dragging = true; try { pad.setPointerCapture(e.pointerId); } catch (_) {} setFrom(e); e.preventDefault(); });
    pad.addEventListener('pointermove', (e) => { if (dragging) setFrom(e); });
    const stop = (e) => { dragging = false; try { pad.releasePointerCapture(e.pointerId); } catch (_) {} };
    pad.addEventListener('pointerup', stop);
    pad.addEventListener('pointercancel', stop);
    place();
    return pad;
  }

  function iconBtn(cls, text, title, onClick) {
    const b = mk('button', `decor-ov-act ${cls}`, text); b.type = 'button';
    b.title = title; b.setAttribute('aria-label', title);
    b.addEventListener('click', onClick);
    return b;
  }

  // The selected overlay's settings.
  function overlaySettings(ctx, ov, src) {
    const { commit, tt } = ctx;
    const box = mk('div', 'decor-ov-settings');
    box.appendChild(posPad(ctx, ov, src));
    [
      F().amountField({ label: tt('decor_size', 'Size'), min: 5, max: 100, step: 1, get: () => ov.size, set: (v) => { ov.size = v; }, format: pct, onChange: commit }),
      F().amountField({ label: tt('decor_opacity', 'Opacity'), min: 0, max: 100, step: 1, get: () => ov.opacity, set: (v) => { ov.opacity = v; }, format: pct, onChange: commit }),
      F().amountField({ label: tt('decor_rotate', 'Rotate'), min: -180, max: 180, step: 5, get: () => ov.rotate, set: (v) => { ov.rotate = v; }, format: (v) => `${v}°`, onChange: commit }),
      F().toggleField({ label: tt('decor_flip', 'Flip'), get: () => ov.flip, set: (v) => { ov.flip = v; }, onChange: commit }),
      F().decorColorField({
        label: tt('decor_tint', 'Colour'), get: () => ov.tint, set: (v) => { ov.tint = v; }, onChange: commit,
        tt, accentHex: ctx.pal.accent, emptyText: tt('decor_tint_own', 'Its own'),
      }),
      F().amountField({ label: tt('decor_glow', 'Glow'), min: 0, max: 24, step: 1, get: () => ov.glow, set: (v) => { ov.glow = v; }, format: px, onChange: commit }),
      F().amountField({ label: tt('decor_shadow', 'Shadow'), min: 0, max: 24, step: 1, get: () => ov.shadow, set: (v) => { ov.shadow = v; }, format: px, onChange: commit }),
      F().choiceField({
        label: tt('decor_motion', 'Motion'),
        options: [
          ['', tt('decor_none', 'None')], ['float', tt('decor_anim_float', 'Float')], ['sway', tt('decor_anim_sway', 'Sway')],
          ['spin', tt('decor_anim_spin', 'Spin')], ['pulse', tt('decor_anim_beat', 'Beat')], ['twinkle', tt('decor_anim_twinkle', 'Twinkle')],
        ],
        get: () => ov.anim, set: (v) => { ov.anim = v; }, onChange: commit,
      }),
      F().choiceField({
        label: tt('decor_layer', 'Layer'),
        options: [['above', tt('decor_layer_above', 'Over the widget')], ['behind', tt('decor_layer_behind', 'Behind the widget')]],
        get: () => ov.layer, set: (v) => { ov.layer = v; }, onChange: commit,
      }),
    ].forEach((f) => box.appendChild(f.row));
    return box;
  }

  function library(ctx, onPick) {
    const { tt, TDP } = ctx;
    const wrap = mk('div', 'decor-library');
    const cats = [{ id: '', labelKey: 'decor_cat_all', label: 'All' }].concat(TDP.TILE_DECOR_OVERLAY_CATS || []);
    let cat = '';
    const thumbs = mk('div', 'decor-thumbs');
    const fill = () => {
      thumbs.replaceChildren();
      (TDP.TILE_DECOR_OVERLAYS || []).filter((o) => !cat || o.cat === cat).forEach((o) => {
        const b = mk('button', 'decor-thumb'); b.type = 'button';
        b.title = tt(o.labelKey, o.label); b.setAttribute('aria-label', b.title);
        b.style.backgroundImage = cssUrl(TDP.tileOverlayPresetUrl(o.id));
        b.addEventListener('click', () => onPick({ preset: o.id }));
        thumbs.appendChild(b);
      });
    };
    const chips = F().choiceField({
      label: '', options: cats.map((c) => [c.id, tt(c.labelKey, c.label)]),
      get: () => cat, set: (v) => { cat = v; }, onChange: fill,
    });
    chips.row.classList.add('decor-cats');
    const file = mk('input'); file.type = 'file'; file.accept = 'image/*'; file.hidden = true;
    const up = mk('button', 'tile-style-btn', tt('decor_upload', 'Upload')); up.type = 'button';
    up.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files && file.files[0]; file.value = '';
      if (f) ctx.busyPick(up, async () => onPick({ src: await uploadTileAsset(f, 640) }));
    });
    const svg = mk('button', 'tile-style-btn', tt('svg_paste', 'Paste SVG')); svg.type = 'button';
    svg.addEventListener('click', async () => { const uri = await openSvgPasteDialog(); if (uri) onPick({ src: uri }); });
    const own = mk('div', 'decor-btnrow');
    own.append(up, svg, file);
    fill();
    wrap.append(chips.row, thumbs, own);
    return wrap;
  }

  function overlaySection(ctx, pane) {
    const { work, commit, tt, TDP } = ctx;
    const Model = window.TileStyleDecorModel;
    const list = work.decor.overlays;
    const srcOf = (ov) => (ov.preset ? TDP.tileOverlayPresetUrl(ov.preset) : ov.src);
    const strip = mk('div', 'decor-ov-strip');
    const tools = mk('div', 'decor-ov-tools');
    const settings = mk('div', 'decor-ov-slot');
    const count = mk('span', 'decor-ov-count');
    let sel = list.length ? 0 : -1;
    let lib = null;

    const render = () => {
      strip.replaceChildren();
      list.forEach((ov, i) => {
        const b = mk('button', 'decor-thumb'); b.type = 'button';
        const src = srcOf(ov); if (src) b.style.backgroundImage = cssUrl(src);
        b.classList.toggle('active', i === sel);
        b.title = `${tt('decor_overlay', 'Overlay')} ${i + 1}`; b.setAttribute('aria-label', b.title);
        b.addEventListener('click', () => { sel = i; render(); });
        strip.appendChild(b);
      });
      count.textContent = `${list.length} / ${MAX}`;
      tools.hidden = sel < 0;
      settings.replaceChildren();
      if (sel >= 0) settings.appendChild(overlaySettings(ctx, list[sel], srcOf(list[sel])));
      lib.hidden = list.length >= MAX;
    };
    const change = () => { render(); commit(); };
    const move = (d) => {
      const j = sel + d;
      if (sel < 0 || j < 0 || j >= list.length) return;
      [list[sel], list[j]] = [list[j], list[sel]];
      sel = j; change();
    };
    tools.append(
      iconBtn('', '‹', tt('decor_move_back', 'Move earlier'), () => move(-1)),
      iconBtn('', '›', tt('decor_move_forward', 'Move later'), () => move(1)),
      iconBtn('', '⧉', tt('decor_duplicate', 'Duplicate'), () => {
        if (sel < 0 || list.length >= MAX) return;
        const copy = Model.overlayWork(list[sel]);
        const [x, y] = ovXY(list[sel]);
        copy.x = Math.min(100, x + 8); copy.y = Math.min(100, y + 8);
        list.splice(sel + 1, 0, copy); sel += 1; change();
      }),
      iconBtn('is-danger', '×', tt('decor_remove', 'Remove'), () => {
        if (sel < 0) return;
        list.splice(sel, 1); sel = Math.min(sel, list.length - 1); change();
      }),
    );
    lib = library(ctx, (partial) => {
      if (list.length >= MAX) return;
      list.push(Model.overlayWork(Object.assign({ x: 50, y: 50, size: 30 }, partial)));
      sel = list.length - 1; change();
    });
    const head = mk('div', 'decor-ov-head');
    head.append(mk('div', 'tile-style-subhead', tt('decor_overlays', 'Overlays')), count);
    const bar = mk('div', 'decor-ov-bar');
    bar.append(strip, tools);
    pane.append(head, bar, settings, lib);
    render();
  }

  window.TileStyleDecorOverlays = { overlaySection };
})();
