// The Controls tab of the per-tile style editor: the widget's own buttons,
// tabs and chips, their selected state, and its text fields. The preview at the
// top is painted from the same mapping the tile uses (tile-controls.js), and
// the tile itself repaints on every change. `ctx` is the editor's.
(() => {
  'use strict';

  const mk = (tag, cls, text) => makeEl(tag, cls, text);
  const F = () => window.TileStyleFields;
  const px = (v) => `${v} px`;

  function preview(ctx) {
    const { tt } = ctx;
    const box = mk('div', 'tsc-preview');
    const btn = mk('span', 'tsc-btn', tt('tile_style_ctrl_sample_btn', 'Button'));
    const on = mk('span', 'tsc-btn is-on', tt('tile_style_ctrl_sample_on', 'Selected'));
    const hover = mk('span', 'tsc-btn is-hover', tt('tile_style_ctrl_sample_hover', 'Hover'));
    const field = mk('span', 'tsc-field', tt('tile_style_ctrl_sample_field', 'Text field'));
    const row = mk('div', 'tsc-preview-row');
    row.append(btn, hover, on);
    box.append(row, field);
    const TC = window.TileControls;
    const paint = () => {
      if (!TC) return;
      TC.TILE_CONTROL_VARS.forEach((p) => box.style.removeProperty(p));
      const { vars } = TC.resolveTileControls(ctx.work.controls);
      Object.keys(vars).forEach((k) => box.style.setProperty(k, vars[k]));
    };
    paint();
    return { box, paint };
  }

  function controlsPane(ctx) {
    const { work, tt, pal } = ctx;
    const c = work.controls;
    const pane = mk('div', 'tile-style-body');
    const pv = preview(ctx);
    const commit = () => { pv.paint(); ctx.commit(); };
    const color = (key, label, theme) => F().colorField({ label, get: () => c[key], set: (v) => { c[key] = v; }, theme, onChange: commit, tt });

    const look = F().section(tt('tile_style_ctrl_buttons', 'Buttons, tabs and chips'));
    [
      F().choiceField({
        label: tt('tile_style_ctrl_variant', 'Style'),
        options: [
          ['', tt('tile_style_from_theme', 'Theme')], ['filled', tt('tile_style_ctrl_filled', 'Filled')],
          ['soft', tt('tile_style_ctrl_soft', 'Soft')], ['outline', tt('tile_style_ctrl_outline', 'Outline')],
          ['ghost', tt('tile_style_ctrl_ghost', 'Plain')],
        ],
        get: () => c.variant, set: (v) => { c.variant = v; }, onChange: commit,
      }),
      color('bg', tt('tile_style_ctrl_bg', 'Background'), pal.control),
      color('text', tt('tile_style_ctrl_text', 'Text and icons'), pal.text),
      color('border', tt('tile_style_ctrl_border', 'Border'), pal.line),
      color('hover', tt('tile_style_ctrl_hover', 'Under the finger or pointer'), pal.control),
      F().rangeField({ label: tt('tile_style_ctrl_radius', 'Corners'), min: 0, max: 40, step: 1, theme: 8, themeUnknown: true, get: () => c.radius, set: (v) => { c.radius = v; }, format: px, onChange: commit, tt }),
      F().rangeField({ label: tt('tile_style_ctrl_bw', 'Border width'), min: 0, max: 4, step: 1, theme: 1, themeUnknown: true, get: () => c.borderWidth, set: (v) => { c.borderWidth = v; }, format: px, onChange: commit, tt }),
    ].forEach((f) => look.appendChild(f.row));

    const active = F().section(tt('tile_style_ctrl_active', 'Selected'));
    [
      color('activeBg', tt('tile_style_ctrl_bg', 'Background'), pal.accent),
      color('activeText', tt('tile_style_ctrl_text', 'Text and icons'), pal.onAccent),
    ].forEach((f) => active.appendChild(f.row));

    const fields = F().section(tt('tile_style_ctrl_fields', 'Text fields and menus'));
    [
      color('fieldBg', tt('tile_style_ctrl_bg', 'Background'), pal.control),
      color('fieldText', tt('tile_style_ctrl_text', 'Text and icons'), pal.text),
      color('fieldBorder', tt('tile_style_ctrl_border', 'Border'), pal.line),
    ].forEach((f) => fields.appendChild(f.row));

    pane.append(pv.box, look, active, fields);
    return pane;
  }

  window.TileStyleControlsPane = { controlsPane };
})();
