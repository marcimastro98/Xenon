// Decor tab, part 3: a drawn pattern, a glow and an edge bar. Each section
// shows its settings only once it is switched on, so an unused one is a single
// row. `ctx` is the editor's: { work, commit, tt, pal }.
(() => {
  'use strict';

  const mk = (tag, cls, text) => makeEl(tag, cls, text);
  const F = () => window.TileStyleFields;
  const pct = (v) => `${Math.round(v)}%`;
  const px = (v) => `${v} px`;
  const KINDS = ['dots', 'grid', 'lines', 'crosshatch', 'checker', 'scanlines', 'zigzag', 'noise'];

  // The pattern picker draws each kind with the same CSS the tile will use.
  function patternThumbs(ctx, p, onPick) {
    const { tt } = ctx;
    const TDL = window.TileDecorLayers;
    const row = mk('div', 'decor-thumbs');
    const btns = [];
    const add = (kind, label) => {
      const b = mk('button', 'decor-thumb decor-pattern-thumb'); b.type = 'button';
      b.dataset.kind = kind; b.title = label; b.setAttribute('aria-label', label);
      if (!kind) b.classList.add('none');
      else if (TDL) {
        const ink = TDL.buildPatternLayer({ kind, opacity: 100, size: 12, weight: kind === 'dots' ? 2 : 1 });
        if (ink) { ink.style.setProperty('--tile-pattern-c', 'var(--text)'); ink.style.opacity = '0.75'; b.appendChild(ink); }
      }
      b.addEventListener('click', () => onPick(kind));
      row.appendChild(b);
      btns.push(b);
    };
    add('', tt('decor_none', 'None'));
    KINDS.forEach((k) => add(k, tt(`decor_pattern_${k}`, k)));
    const mark = () => btns.forEach((b) => b.classList.toggle('active', b.dataset.kind === (p.kind || '')));
    return { row, mark };
  }

  function patternSection(ctx, pane) {
    const { work, commit, tt } = ctx;
    const p = work.decor.pattern;
    const adjust = mk('div', 'tsf-section');
    const angled = () => p.kind === 'lines' || p.kind === 'crosshatch';
    const sized = () => p.kind !== 'noise' && p.kind !== 'scanlines';
    const lined = () => p.kind !== 'noise' && p.kind !== 'checker' && p.kind !== 'zigzag';
    const size = F().amountField({ label: tt('decor_pattern_size', 'Spacing'), min: 4, max: 96, step: 1, get: () => p.size, set: (v) => { p.size = v; }, format: px, onChange: commit });
    const weight = F().amountField({ label: tt('decor_pattern_weight', 'Thickness'), min: 1, max: 8, step: 1, get: () => p.weight, set: (v) => { p.weight = v; }, format: px, onChange: commit });
    const angle = F().amountField({ label: tt('decor_pattern_angle', 'Angle'), min: 0, max: 180, step: 5, get: () => p.angle, set: (v) => { p.angle = v; }, format: (v) => `${v}°`, onChange: commit });
    const sync = () => {
      thumbs.mark();
      adjust.hidden = !p.kind;
      size.row.hidden = !sized();
      weight.row.hidden = !lined();
      angle.row.hidden = !angled();
    };
    const thumbs = patternThumbs(ctx, p, (kind) => { p.kind = kind; sync(); commit(); });
    [
      F().decorColorField({ label: tt('decor_tint', 'Colour'), get: () => p.color, set: (v) => { p.color = v; }, onChange: commit, tt, accentHex: ctx.pal.accent, emptyText: tt('decor_color_text', 'Text colour') }),
      F().amountField({ label: tt('decor_opacity', 'Opacity'), min: 1, max: 100, step: 1, get: () => p.opacity, set: (v) => { p.opacity = v; }, format: pct, onChange: commit }),
      size, weight, angle,
      F().choiceField({
        label: tt('decor_fade', 'Fade'),
        options: [
          ['', tt('decor_none', 'None')], ['top', tt('decor_side_top', 'Top')], ['bottom', tt('decor_side_bottom', 'Bottom')],
          ['left', tt('decor_side_left', 'Left')], ['right', tt('decor_side_right', 'Right')],
          ['center', tt('decor_fade_center', 'Centre')], ['edges', tt('decor_fade_edges', 'Edges')],
        ],
        get: () => p.fade, set: (v) => { p.fade = v; }, onChange: commit,
      }),
      F().choiceField({
        label: tt('decor_layer', 'Layer'),
        options: [['behind', tt('decor_layer_behind', 'Behind the widget')], ['above', tt('decor_layer_above', 'Over the widget')]],
        get: () => p.layer, set: (v) => { p.layer = v; }, onChange: commit,
      }),
    ].forEach((f) => adjust.appendChild(f.row));
    pane.append(mk('div', 'tile-style-subhead', tt('decor_pattern', 'Pattern')), thumbs.row, adjust);
    sync();
  }

  function glowSection(ctx, pane) {
    const { work, commit, tt } = ctx;
    const g = work.decor.glow;
    const sec = F().section(tt('decor_glow_tile', 'Glow'));
    [
      F().amountField({ label: tt('decor_glow_inner', 'Inside'), min: 0, max: 60, step: 1, get: () => g.inner, set: (v) => { g.inner = v; }, format: px, onChange: commit }),
      F().amountField({ label: tt('decor_glow_outer', 'Around'), min: 0, max: 40, step: 1, get: () => g.outer, set: (v) => { g.outer = v; }, format: px, onChange: commit }),
      F().decorColorField({ label: tt('decor_tint', 'Colour'), get: () => g.color, set: (v) => { g.color = v; }, onChange: commit, tt, accentHex: ctx.pal.accent, emptyText: tt('decor_color_accent', 'Accent') }),
    ].forEach((f) => sec.appendChild(f.row));
    pane.appendChild(sec);
  }

  function barSection(ctx, pane) {
    const { work, commit, tt } = ctx;
    const b = work.decor.bar;
    const adjust = mk('div', 'tsf-section');
    const sync = () => { adjust.hidden = !b.side; };
    const side = F().choiceField({
      label: '',
      options: [
        ['', tt('decor_none', 'None')], ['top', tt('decor_side_top', 'Top')], ['bottom', tt('decor_side_bottom', 'Bottom')],
        ['left', tt('decor_side_left', 'Left')], ['right', tt('decor_side_right', 'Right')],
      ],
      get: () => b.side, set: (v) => { b.side = v; }, onChange: () => { sync(); commit(); },
    });
    [
      F().decorColorField({ label: tt('decor_tint', 'Colour'), get: () => b.color, set: (v) => { b.color = v; }, onChange: commit, tt, accentHex: ctx.pal.accent, emptyText: tt('decor_color_accent', 'Accent') }),
      F().amountField({ label: tt('decor_bar_size', 'Thickness'), min: 1, max: 16, step: 1, get: () => b.size, set: (v) => { b.size = v; }, format: px, onChange: commit }),
      F().amountField({ label: tt('decor_bar_length', 'Length'), min: 10, max: 100, step: 5, get: () => b.length, set: (v) => { b.length = v; }, format: pct, onChange: commit }),
      F().choiceField({
        label: tt('decor_bar_align', 'Position'),
        options: [['start', tt('decor_align_start', 'Start')], ['center', tt('decor_align_center', 'Centre')], ['end', tt('decor_align_end', 'End')]],
        get: () => b.align, set: (v) => { b.align = v; }, onChange: commit,
      }),
    ].forEach((f) => adjust.appendChild(f.row));
    pane.append(mk('div', 'tile-style-subhead', tt('decor_bar', 'Edge bar')), side.row, adjust);
    sync();
  }

  window.TileStyleDecorExtras = { patternSection, glowSection, barSection };
})();
