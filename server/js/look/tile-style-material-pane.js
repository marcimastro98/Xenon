// The first tab of the style window: what the tile is made of. Six named materials
// in one tap and the colour of the glass (tile-material.js holds both lists); the
// numbers behind them wait in a fold for whoever wants them. Every card is a real
// sample of glass over a picture, so nobody has to guess what a value will do.
(() => {
  'use strict';

  const mk = (tag, cls, text) => makeEl(tag, cls, text);
  const F = () => window.TileStyleFields;
  const M = () => window.TileMaterial;
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  // A card is about a fifth of a tile: the tile's own blur would wipe the picture out.
  const SAMPLE_BLUR = 0.4;

  // What a tile takes when it sets nothing of its own. Blur belongs to Liquid Glass:
  // the other looks paint their tiles without it.
  function themeValues(hs) {
    const liquid = document.documentElement.dataset.style === 'liquid';
    return {
      panelAlpha: num(hs.panelAlpha, 0.94),
      glassBlur: liquid ? num(hs.glassBlur, 22) : 0,
      glassSaturate: num(hs.glassSaturate, 160),
    };
  }

  function sampleArt(look) {
    const art = mk('span', 'tsm-art');
    const sheet = mk('span', 'tsm-sheet');
    sheet.classList.toggle('is-glass', look.glassBlur > 0 && look.panelAlpha > 0.02);
    sheet.style.setProperty('--tsm-alpha', String(look.panelAlpha));
    sheet.style.setProperty('--tsm-blur', `${look.glassBlur * SAMPLE_BLUR}px`);
    sheet.style.setProperty('--tsm-sat', `${look.glassSaturate == null ? 100 : look.glassSaturate}%`);
    sheet.append(mk('i'), mk('i'));
    art.appendChild(sheet);
    return art;
  }

  function materialCards(ctx) {
    const { work, commit, tt, hs, pal } = ctx;
    const grid = mk('div', 'tsm-cards');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', tt('tile_style_group_material', 'Material'));
    const theme = themeValues(hs);
    const cards = M().MATERIALS.map((material) => {
      const btn = mk('button', 'tsm-card');
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.append(sampleArt(material.id === 'theme' ? theme : material), mk('span', 'tsm-name', tt(material.labelKey, material.label)));
      btn.addEventListener('click', () => { M().applyMaterial(work, material.id); commit(); });
      grid.appendChild(btn);
      return { btn, id: material.id };
    });
    ctx.afterPaint.push(() => {
      const on = M().materialOf(work);
      cards.forEach(({ btn, id }) => {
        btn.classList.toggle('active', id === on);
        btn.setAttribute('aria-checked', String(id === on));
      });
      grid.style.setProperty('--tsm-panel', work.panel || pal.surface || '');
    });
    return grid;
  }

  function tintRow(ctx) {
    const { work, commit, tt, pal } = ctx;
    const sec = F().section(tt('tile_style_tint', 'Colour of the glass'));
    const row = mk('div', 'tsm-tints');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', tt('tile_style_tint', 'Colour of the glass'));
    const chip = (value, title, paint) => {
      const btn = mk('button', 'tsm-tint');
      btn.type = 'button';
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.style.setProperty('--tsm-tint', paint);
      btn.addEventListener('click', () => { work.panel = value; commit(); });
      row.appendChild(btn);
      return { btn, value };
    };
    const chips = [chip('', tt('tile_style_from_theme', 'Theme'), pal.surface || 'transparent')];
    M().tintsFor(pal.tone).forEach((hex) => chips.push(chip(hex, hex, hex)));
    const custom = mk('input', 'tsf-swatch tsm-any');
    custom.type = 'color';
    custom.setAttribute('aria-label', tt('tile_style_panel', 'Panel background'));
    if (window.ColorPicker) window.ColorPicker.bind(custom);
    custom.addEventListener('input', () => { work.panel = custom.value; commit(); });
    row.appendChild(custom);
    sec.appendChild(row);
    ctx.afterPaint.push(() => {
      chips.forEach(({ btn, value }) => {
        btn.classList.toggle('active', value === work.panel);
        btn.setAttribute('aria-pressed', String(value === work.panel));
      });
      custom.value = work.panel || pal.surface || '#000000';
      custom.classList.toggle('active', !!work.panel && !chips.some(({ value }) => value === work.panel));
    });
    return sec;
  }

  // Two things that can make a card look like it did nothing, said only where true.
  function truthHints(ctx) {
    const { tt, leaveFor } = ctx;
    const wrap = mk('div', 'tsm-hints');
    const hint = (text, link, category) => {
      const row = mk('div', 'tile-style-hint');
      row.appendChild(mk('span', '', text));
      const go = mk('button', 'tsf-link', link);
      go.type = 'button';
      go.addEventListener('click', () => leaveFor(category));
      row.appendChild(go);
      wrap.appendChild(row);
    };
    if (document.body.classList.contains('low-power-gpu')) {
      hint(tt('tile_style_hint_low_power', 'Blur is off on this screen, to keep the graphics card free.'), tt('tile_style_hint_low_power_go', 'Change'), 'appearance');
    } else if (typeof window.backdropIsPlain === 'function' && window.backdropIsPlain()) {
      hint(tt('tile_style_hint_plain', 'Glass shows what is behind it, and here that is a plain colour.'), tt('tile_style_hint_plain_go', 'Choose a background'), 'background');
    }
    return wrap;
  }

  function fineTune(ctx) {
    const { work, commit, hs, tt } = ctx;
    const fold = mk('details', 'tsm-fold');
    fold.appendChild(mk('summary', '', tt('tile_style_fine_tune', 'Fine tune')));
    const theme = themeValues(hs);
    const fields = [];
    const fx = (key, label, min, max, step, value, format) => {
      const field = F().rangeField({ label, tt, min, max, step, theme: value, format, get: () => work[key], set: (v) => { work[key] = v; }, onChange: commit });
      fields.push(field);
      fold.appendChild(field.row);
      return field;
    };
    const pct = (v) => `${Math.round(v * 100)}%`;
    const opacity = fx('panelAlpha', tt('tile_style_opacity', 'Panel opacity'), 0, 1, 0.01, theme.panelAlpha, pct);
    fx('glassBlur', tt('tile_style_glass_blur', 'Blur'), 0, 40, 1, theme.glassBlur, (v) => `${Math.round(v)} px`);
    fx('glassSaturate', tt('tile_style_glass_saturate', 'Saturation'), 100, 220, 5, theme.glassSaturate, (v) => `${Math.round(v)}%`);
    // Blur shows only THROUGH the panel. Rather than lowering the opacity behind
    // the user's back, the hint offers to do it.
    const hint = mk('div', 'tile-style-hint');
    hint.appendChild(mk('span', '', tt('tile_style_glass_hint', 'Blur only shows through a translucent panel.')));
    const fix = mk('button', 'tsf-link', tt('tile_style_glass_fix', 'Make the panel translucent'));
    fix.type = 'button';
    fix.addEventListener('click', () => { work.panelAlpha = 0.55; opacity.refresh(); commit(); });
    hint.appendChild(fix);
    fold.appendChild(hint);
    fx('radius', tt('tile_style_radius', 'Corner radius'), 0, 2, 0.05, num(hs.uiRoundness, 1), (v) => `${Math.round(16 * v)} px`);
    fx('borderStrength', tt('tile_style_border', 'Panel border'), 0, 2, 0.05, num(hs.panelBorderStrength, 1), pct);
    fx('shadowStrength', tt('tile_style_shadow', 'Panel shadow'), 0, 2, 0.05, num(hs.tileShadowStrength, 0), pct);
    ctx.afterPaint.push(() => {
      fields.forEach((f) => f.refresh());
      const alpha = work.panelAlpha != null ? work.panelAlpha : theme.panelAlpha;
      hint.hidden = !(work.glassBlur > 0 && alpha >= 0.95);
    });
    // Numbers no card makes stay in sight: nothing the user set may look lost.
    fold.open = M().materialOf(work) === '';
    return fold;
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

  // The code door: any closed SVG path in a 0..1 square. A rejected path is named,
  // never swallowed: an ignored path looks like a shape that broke.
  function pathFold(ctx, sync) {
    const { work, commit, tt } = ctx;
    const shape = work.shape;
    const DI = window.DashboardInstances || {};
    const fold = mk('details', 'tsm-fold');
    const label = tt('tile_shape_path', 'Custom path (SVG, 0–1 square)');
    fold.appendChild(mk('summary', '', label));
    const input = mk('input', 'tile-shape-path');
    input.type = 'text';
    input.placeholder = 'M 0.5 0 L 1 0.5 L 0.5 1 L 0 0.5 Z';
    input.value = shape.path || '';
    input.setAttribute('aria-label', label);
    const err = mk('div', 'tile-style-hint tile-style-hint-err', tt('tile_shape_path_bad', 'That is not a usable path: it must start with M, end closed with Z, and contain only path commands and numbers.'));
    err.hidden = true;
    input.addEventListener('input', () => {
      const v = input.value.trim();
      shape.path = v;
      if (v) shape.preset = '';
      const ok = !v || !!(DI.normalizeTileShape && DI.normalizeTileShape({ path: v }));
      err.hidden = ok;
      if (ok) { sync(); commit(); }
    });
    fold.append(input, err);
    fold.open = !!shape.path;
    return { fold, input };
  }

  function shapeSection(ctx) {
    const { work, commit, tt } = ctx;
    const shape = work.shape;
    const sec = F().section(tt('tile_style_shape', 'Shape'));
    const grid = mk('div', 'tile-shape-grid');
    const chips = [];
    const extra = mk('div', 'tsf-section');
    const sync = () => {
      chips.forEach(({ btn, id }) => btn.classList.toggle('active', shape.preset === id && (id || !shape.path)));
      extra.hidden = !(shape.preset || shape.path);
    };
    const { fold, input } = pathFold(ctx, sync);
    const chip = (id, label, d) => {
      const btn = mk('button', 'tile-shape-chip');
      btn.type = 'button';
      btn.title = label;
      btn.append(shapeThumb(d), mk('span', '', label));
      btn.addEventListener('click', () => { shape.preset = id; if (id) shape.path = ''; input.value = shape.path; sync(); commit(); });
      grid.appendChild(btn);
      chips.push({ btn, id });
    };
    chip('', tt('tile_shape_none', 'Rectangle'), '');
    ((window.TileShapePresets && window.TileShapePresets.TILE_SHAPES) || []).forEach((s) => chip(s.id, tt(s.labelKey, s.label), s.d));
    extra.append(
      F().rangeField({ label: tt('tile_shape_inset', 'Safe margin'), tt, min: 0, max: 25, step: 1, theme: 6, format: (v) => `${v}%`, get: () => shape.inset, set: (v) => { shape.inset = v; }, onChange: commit }).row,
      F().toggleField({ label: tt('tile_shape_fit', 'Keep proportions'), get: () => shape.fit === 'fit', set: (v) => { shape.fit = v ? 'fit' : 'stretch'; }, onChange: commit }).row,
    );
    sec.append(grid, extra, fold);
    sync();
    return sec;
  }

  function materialPane(ctx) {
    const pane = mk('div', 'tile-style-body');
    pane.append(materialCards(ctx), truthHints(ctx), tintRow(ctx), fineTune(ctx), shapeSection(ctx));
    return pane;
  }

  window.TileStyleMaterialPane = { materialPane };
})();
