// Decor tab, part 1 (tile-style-decor-panes.js composes the tab): the ready-made
// looks and the frame. `ctx` is the editor's: { work, commit, tt, TDP, pal,
// busyPick }; `rerender` rebuilds the whole tab after a look replaced it.
(() => {
  'use strict';

  const mk = (tag, cls, text) => makeEl(tag, cls, text);
  const F = () => window.TileStyleFields;
  const pct = (v) => `${Math.round(v)}%`;
  const px = (v) => `${v} px`;

  // A look's thumbnail: its frame art over its first overlay, the look's name
  // under it. Drawn from the same assets the tile will use.
  function lookThumb(ctx, look) {
    const { TDP, tt } = ctx;
    const b = mk('button', 'decor-look');
    b.type = 'button';
    b.dataset.look = look.id;
    const art = mk('span', 'decor-look-art');
    const d = look.decor || {};
    const layers = [];
    if (d.overlays && d.overlays[0]) layers.push(cssUrl(TDP.tileOverlayPresetUrl(d.overlays[0].preset)));
    if (d.frame) layers.push(cssUrl(TDP.tileFramePresetUrl(d.frame.preset)));
    art.style.backgroundImage = layers.join(', ');
    art.style.backgroundSize = layers.length > 1 ? '46% auto, 100% 100%' : (d.frame ? '100% 100%' : '56% auto');
    const tint = (d.frame && d.frame.tint) || (d.glow && d.glow.color) || (d.bar && d.bar.color) || '';
    art.style.setProperty('--look-c', tint === 'accent' || !tint ? 'var(--accent)' : tint);
    b.append(art, mk('span', 'decor-look-name', tt(look.labelKey, look.label)));
    return b;
  }

  function looksRow(ctx, pane, rerender) {
    const { work, commit, tt, TDP } = ctx;
    const Model = window.TileStyleDecorModel;
    const looks = TDP.TILE_DECOR_LOOKS || [];
    if (!looks.length || !Model) return;
    const row = mk('div', 'decor-looks');
    const none = mk('button', 'decor-look none');
    none.type = 'button';
    none.append(mk('span', 'decor-look-art'), mk('span', 'decor-look-name', tt('decor_none', 'None')));
    none.addEventListener('click', () => { Model.clearLook(work.decor); commit(); rerender(); });
    row.appendChild(none);
    looks.forEach((look) => {
      const b = lookThumb(ctx, look);
      b.addEventListener('click', () => { Model.applyLook(work.decor, look); commit(); rerender(); });
      row.appendChild(b);
    });
    pane.append(mk('div', 'tile-style-subhead', tt('decor_looks', 'Ready-made looks')), row);
  }

  function frameThumbs(ctx, sync) {
    const { work, commit, tt, TDP } = ctx;
    const frame = work.decor.frame;
    const thumbs = mk('div', 'decor-thumbs');
    const addThumb = (preset, url, label) => {
      const b = mk('button', 'decor-thumb'); b.type = 'button'; b.dataset.preset = preset; b.title = label || '';
      b.setAttribute('aria-label', label || '');
      if (url) b.style.backgroundImage = cssUrl(url); else b.classList.add('none');
      b.addEventListener('click', () => { frame.preset = preset === '__none' ? '' : preset; frame.src = ''; sync(); commit(); });
      thumbs.appendChild(b);
    };
    addThumb('__none', '', tt('decor_none', 'None'));
    (TDP.TILE_DECOR_FRAMES || []).forEach((f) => addThumb(f.id, TDP.tileFramePresetUrl(f.id), tt(f.labelKey, f.label)));
    const file = mk('input'); file.type = 'file'; file.accept = 'image/*'; file.hidden = true;
    const up = mk('button', 'decor-thumb upload', '+'); up.type = 'button'; up.dataset.preset = '__upload';
    up.title = tt('decor_upload', 'Upload'); up.setAttribute('aria-label', up.title);
    up.addEventListener('click', () => file.click());
    const useCustom = (u) => { frame.src = u; frame.preset = ''; up.style.backgroundImage = cssUrl(u); sync(); commit(); };
    file.addEventListener('change', () => {
      const f = file.files && file.files[0]; file.value = '';
      if (f) ctx.busyPick(up, async () => useCustom(await uploadTileAsset(f, 512)));
    });
    const svg = mk('button', 'decor-thumb upload', '</>'); svg.type = 'button';
    svg.title = tt('svg_paste', 'Paste SVG'); svg.setAttribute('aria-label', svg.title);
    svg.addEventListener('click', async () => { const uri = await openSvgPasteDialog(); if (uri) useCustom(uri); });
    thumbs.append(up, svg, file);
    if (frame.src) up.style.backgroundImage = cssUrl(frame.src);
    return thumbs;
  }

  function frameSection(ctx, pane) {
    const { work, commit, tt } = ctx;
    const frame = work.decor.frame;
    const adjust = mk('div', 'tsf-section');
    let thumbs = null;
    const second = F().decorColorField({
      label: tt('decor_tint2', 'Second colour'), get: () => frame.tint2, set: (v) => { frame.tint2 = v === 'accent' ? '' : v; },
      onChange: commit, tt, accentHex: ctx.pal.accent, emptyText: tt('decor_none', 'None'),
    });
    // A gradient needs a first colour, and 'accent' is not a hex the second can take.
    second.row.querySelector('.tsf-chip').hidden = true;
    const sync = () => {
      thumbs.querySelectorAll('.decor-thumb').forEach((el) => {
        el.classList.toggle('active', el.dataset.preset === (frame.preset || (frame.src ? '__upload' : '__none')));
      });
      adjust.hidden = !(frame.preset || frame.src);
      second.row.hidden = !frame.tint;
    };
    thumbs = frameThumbs(ctx, sync);
    [
      F().decorColorField({
        label: tt('decor_tint', 'Colour'), get: () => frame.tint, set: (v) => { frame.tint = v; },
        onChange: () => { sync(); commit(); }, tt, accentHex: ctx.pal.accent, emptyText: tt('decor_tint_own', 'Its own'),
      }),
      second,
      F().amountField({ label: tt('decor_frame_width', 'Frame width'), min: 2, max: 40, step: 1, get: () => frame.width, set: (v) => { frame.width = v; }, format: px, onChange: commit }),
      F().amountField({ label: tt('decor_opacity', 'Opacity'), min: 10, max: 100, step: 1, get: () => frame.opacity, set: (v) => { frame.opacity = v; }, format: pct, onChange: commit }),
      F().amountField({ label: tt('decor_glow', 'Glow'), min: 0, max: 24, step: 1, get: () => frame.glow, set: (v) => { frame.glow = v; }, format: px, onChange: commit }),
      F().amountField({ label: tt('decor_inset', 'Inset'), min: 0, max: 24, step: 1, get: () => frame.inset, set: (v) => { frame.inset = v; }, format: px, onChange: commit }),
      F().toggleField({ label: tt('decor_anim_pulse', 'Pulse slowly'), get: () => frame.anim === 'pulse', set: (v) => { frame.anim = v ? 'pulse' : ''; }, onChange: commit }),
    ].forEach((f) => adjust.appendChild(f.row));
    pane.append(mk('div', 'tile-style-subhead', tt('decor_frame', 'Frame')), thumbs, adjust);
    sync();
  }

  window.TileStyleDecorFrame = { looksRow, frameSection };
})();
