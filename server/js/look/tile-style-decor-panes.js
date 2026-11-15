// The Background and Decor tabs of the per-tile style editor
// (tile-style-editor.js): a picture or gradient behind the widget, and the
// decor tab composed from tile-style-decor-frame/-overlays/-extras.js.
//
// Both build on `ctx`: { work, commit, tt, TDP, toast, busyPick, seedAccent }.
// `work.decor` is the editor's loose working copy; normalizeTileStyle() cleans
// it on commit, so nothing here validates sources or clamps numbers.
(() => {
  'use strict';

  const mk = (tag, cls, text) => makeEl(tag, cls, text);
  const F = () => window.TileStyleFields;
  const pct = (v) => `${Math.round(v)}%`;

  function backgroundPane(ctx) {
    const { work, commit, tt } = ctx;
    const bg = work.decor.bg;
    const pane = mk('div', 'tile-style-body');
    const prev = mk('div', 'decor-preview');
    const adjust = mk('div', 'tsf-section');
    const emptyHint = mk('div', 'tile-style-hint', tt('tile_style_bg_empty', 'Choose a picture or a gradient to adjust it here.'));
    const fields = [];
    // Dim, blur and opacity act on the picture: with nothing to act on they
    // would be three sliders that do nothing, so they wait for one.
    const refresh = () => {
      const g = tileGradCss(bg.grad);
      prev.style.backgroundImage = [g, cssUrl(bg.src)].filter(Boolean).join(', ');
      prev.classList.toggle('empty', !bg.src && !g);
      const any = !!(bg.src || g);
      adjust.hidden = !any;
      emptyHint.hidden = any;
      clear.hidden = !bg.src;
    };
    const change = () => { refresh(); commit(); };

    const btns = mk('div', 'decor-btnrow');
    const file = mk('input'); file.type = 'file'; file.accept = 'image/*'; file.hidden = true;
    const up = mk('button', 'tile-style-btn', tt('decor_choose_image', 'Choose image')); up.type = 'button';
    up.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files && file.files[0]; file.value = '';
      if (f) ctx.busyPick(up, async () => { bg.src = await uploadTileAsset(f, 1600); change(); });
    });
    const svg = mk('button', 'tile-style-btn', tt('svg_paste', 'Paste SVG')); svg.type = 'button';
    svg.addEventListener('click', async () => { const uri = await openSvgPasteDialog(); if (uri) { bg.src = uri; change(); } });
    const clear = mk('button', 'tile-style-btn', tt('decor_remove', 'Remove')); clear.type = 'button';
    clear.addEventListener('click', () => { bg.src = ''; change(); });
    btns.append(up, svg, clear, file);

    const grad = F().gradientField({ label: tt('decor_gradient', 'Gradient'), obj: bg.grad, seed1: ctx.seedAccent, seed2: '#101216', onChange: change, tt });
    fields.push(
      F().selectField({
        label: tt('decor_fit', 'Fit'),
        options: [['cover', tt('decor_fit_cover', 'Cover')], ['contain', tt('decor_fit_contain', 'Contain')], ['tile', tt('decor_fit_tile', 'Tile')]],
        get: () => bg.fit, set: (v) => { bg.fit = v; }, onChange: commit,
      }),
      F().amountField({ label: tt('decor_opacity', 'Opacity'), min: 0, max: 100, step: 1, get: () => bg.opacity, set: (v) => { bg.opacity = v; }, format: pct, onChange: commit }),
      F().amountField({ label: tt('decor_dim', 'Dim'), min: 0, max: 100, step: 1, get: () => bg.dim, set: (v) => { bg.dim = v; }, format: pct, onChange: commit }),
      F().amountField({ label: tt('decor_blur', 'Blur'), min: 0, max: 20, step: 1, get: () => bg.blur, set: (v) => { bg.blur = v; }, format: (v) => `${v} px`, onChange: commit }),
    );
    fields.forEach((f) => adjust.appendChild(f.row));
    pane.append(prev, btns, grad.row, emptyHint, adjust);
    refresh();
    return pane;
  }

  // The Decor tab: looks, frame, overlays, pattern, glow, edge bar. A look
  // replaces most of the working copy, so the tab rebuilds itself after one.
  function decorPane(ctx) {
    const pane = mk('div', 'tile-style-body');
    const render = () => {
      const keep = pane.closest('.tile-style-pop');
      const top = keep ? keep.scrollTop : 0;
      pane.replaceChildren();
      window.TileStyleDecorFrame.looksRow(ctx, pane, render);
      window.TileStyleDecorFrame.frameSection(ctx, pane);
      window.TileStyleDecorOverlays.overlaySection(ctx, pane);
      window.TileStyleDecorExtras.patternSection(ctx, pane);
      window.TileStyleDecorExtras.glowSection(ctx, pane);
      window.TileStyleDecorExtras.barSection(ctx, pane);
      if (typeof window.initCustomSelect === 'function') {
        pane.querySelectorAll('select').forEach((s) => { if (!s.dataset.csInit) { s.setAttribute('data-cs-fixed', ''); window.initCustomSelect(s); } });
      }
      if (keep) keep.scrollTop = top;
    };
    render();
    return pane;
  }

  window.TileStyleDecorPanes = { backgroundPane, decorPane };
})();
