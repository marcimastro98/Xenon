// Field builders for the per-tile style editor (tile-style-editor.js).
//
// Every field shows the value the tile REALLY uses: the theme's value, marked
// "Theme", until the user changes it, then the user's value with a reset next
// to it. The old editor put a checkbox in front of every control and disabled
// the control until it was ticked, so on a touchscreen a slider or a swatch
// looked broken (it ignored the finger) and nothing said why.
//
// Each builder returns { row, refresh } and calls `onChange` after every edit;
// the editor repaints the tile from there.
(() => {
  'use strict';

  const mk = (tag, cls, text) => makeEl(tag, cls, text);

  // A row's right-hand end: the current value as text and a reset button that
  // only exists while the user's own value is set.
  function valueTail(tt, onReset) {
    const value = mk('span', 'tsf-value');
    const reset = mk('button', 'tsf-reset');
    reset.type = 'button';
    reset.title = tt('tile_style_reset_row', 'Back to theme');
    reset.setAttribute('aria-label', reset.title);
    reset.textContent = '↺';
    reset.addEventListener('click', onReset);
    return { value, reset };
  }
  function showValue(tail, own, text, tt) {
    tail.value.textContent = own ? text : tt('tile_style_from_theme', 'Theme');
    tail.value.classList.toggle('is-theme', !own);
    tail.reset.hidden = !own;
  }

  // { label, get, set, theme, onChange, tt } → a swatch that is always live.
  // refresh(effective) also says when the contrast guard moved the colour.
  function colorField(o) {
    const row = mk('div', 'tsf-row');
    const swatch = mk('input', 'tsf-swatch');
    swatch.type = 'color';
    swatch.setAttribute('aria-label', o.label);
    const label = mk('span', 'tsf-label', o.label);
    const note = mk('span', 'tsf-note');
    note.hidden = true;
    const text = mk('span', 'tsf-text');
    text.append(label, note);
    const tail = valueTail(o.tt, () => { o.set(''); refresh(); o.onChange(); });
    if (window.ColorPicker) window.ColorPicker.bind(swatch);
    swatch.addEventListener('input', () => { o.set(swatch.value); refresh(); o.onChange(); });
    function refresh(effective) {
      const own = o.get();
      swatch.value = own || o.theme || '#000000';
      showValue(tail, !!own, own, o.tt);
      const moved = !!(own && effective && effective.toLowerCase() !== own.toLowerCase());
      note.hidden = !moved;
      if (moved) note.textContent = `${o.tt('tile_style_adjusted', 'Adjusted for readability')} ${effective}`;
    }
    row.append(swatch, text, tail.value, tail.reset);
    refresh();
    return { row, refresh };
  }

  // { label, get, set, min, max, step, theme, format, onChange, tt }
  function rangeField(o) {
    const row = mk('div', 'tsf-row tsf-range');
    const label = mk('span', 'tsf-label', o.label);
    const range = mk('input', 'tsf-slider');
    range.type = 'range';
    range.min = String(o.min); range.max = String(o.max); range.step = String(o.step);
    range.setAttribute('aria-label', o.label);
    const tail = valueTail(o.tt, () => { o.set(null); refresh(); o.onChange(); });
    range.addEventListener('input', () => { o.set(Number(range.value)); refresh(); o.onChange(); });
    function refresh() {
      const own = o.get();
      const v = own != null ? own : o.theme;
      range.value = String(v);
      showValue(tail, own != null, o.format(v), o.tt);
      if (own == null) tail.value.textContent = o.themeUnknown ? o.tt('tile_style_from_theme', 'Theme') : `${o.tt('tile_style_from_theme', 'Theme')} · ${o.format(v)}`;
    }
    row.append(label, range, tail.value, tail.reset);
    refresh();
    return { row, refresh };
  }

  // A plain slider with no theme value behind it (decor amounts).
  // { label, get, set, min, max, step, format, onChange }
  function amountField(o) {
    const row = mk('div', 'tsf-row tsf-range');
    const label = mk('span', 'tsf-label', o.label);
    const range = mk('input', 'tsf-slider');
    range.type = 'range';
    range.min = String(o.min); range.max = String(o.max); range.step = String(o.step);
    range.setAttribute('aria-label', o.label);
    const value = mk('span', 'tsf-value');
    range.addEventListener('input', () => { o.set(Number(range.value)); refresh(); o.onChange(); });
    function refresh() { range.value = String(o.get()); value.textContent = o.format(o.get()); }
    row.append(label, range, value);
    refresh();
    return { row, refresh };
  }

  // Two-colour gradient bound to a { c1, c2, angle } object. Touching a swatch
  // turns it on; the angle only shows while it is on.
  // { label, obj, seed1, seed2, onChange, tt }
  function gradientField(o) {
    const wrap = mk('div', 'tsf-grad');
    const row = mk('div', 'tsf-row');
    const c1 = mk('input', 'tsf-swatch'); c1.type = 'color';
    const c2 = mk('input', 'tsf-swatch'); c2.type = 'color';
    c1.setAttribute('aria-label', `${o.label} 1`);
    c2.setAttribute('aria-label', `${o.label} 2`);
    const label = mk('span', 'tsf-label', o.label);
    const text = mk('span', 'tsf-text');
    text.appendChild(label);
    const tail = valueTail(o.tt, () => { o.obj.c1 = ''; o.obj.c2 = ''; refresh(); o.onChange(); });
    const angle = rangeLine(o.tt('decor_gradient_angle', 'Gradient angle'), 0, 360, 5, () => o.obj.angle, (v) => { o.obj.angle = v; o.onChange(); }, (v) => `${v}°`);
    if (window.ColorPicker) { window.ColorPicker.bind(c1); window.ColorPicker.bind(c2); }
    const pick = () => { o.obj.c1 = c1.value; o.obj.c2 = c2.value; refresh(); o.onChange(); };
    c1.addEventListener('input', pick);
    c2.addEventListener('input', pick);
    function refresh() {
      const on = !!(o.obj.c1 && o.obj.c2);
      c1.value = o.obj.c1 || o.seed1 || '#1ed760';
      c2.value = o.obj.c2 || o.seed2 || '#101216';
      tail.value.textContent = on ? '' : o.tt('decor_none', 'None');
      tail.value.classList.toggle('is-theme', !on);
      tail.reset.hidden = !on;
      angle.row.hidden = !on;
      angle.refresh();
    }
    row.append(c1, c2, text, tail.value, tail.reset);
    wrap.append(row, angle.row);
    refresh();
    return { row: wrap, refresh };
  }
  function rangeLine(label, min, max, step, get, set, format) {
    return amountField({ label, min, max, step, get, set, format, onChange: () => {} });
  }

  // { label, get, set, onChange }
  function toggleField(o) {
    const row = mk('label', 'tsf-row tsf-toggle');
    const box = mk('input', 'tsf-check');
    box.type = 'checkbox';
    const label = mk('span', 'tsf-label', o.label);
    box.addEventListener('change', () => { o.set(box.checked); o.onChange(); });
    function refresh() { box.checked = !!o.get(); }
    row.append(label, box);
    refresh();
    return { row, refresh };
  }

  // { label, options: [[value, text]], get, set, onChange }
  function selectField(o) {
    const row = mk('div', 'tsf-row');
    const label = mk('span', 'tsf-label', o.label);
    const sel = mk('select', 'tsf-select');
    sel.setAttribute('aria-label', o.label);
    o.options.forEach(([v, text]) => { const opt = mk('option', '', text); opt.value = v; sel.appendChild(opt); });
    sel.addEventListener('change', () => { o.set(sel.value); o.onChange(); });
    function refresh() { sel.value = o.get(); }
    row.append(label, sel);
    refresh();
    return { row, refresh };
  }

  // A decor colour: a hex, the word 'accent' (follows the tile's accent), or
  // empty (the part's own default). { label, get, set, onChange, tt, accentHex, emptyText }
  function decorColorField(o) {
    const row = mk('div', 'tsf-row');
    const swatch = mk('input', 'tsf-swatch');
    swatch.type = 'color';
    swatch.setAttribute('aria-label', o.label);
    const label = mk('span', 'tsf-label', o.label);
    const accent = mk('button', 'tsf-chip', o.tt('decor_color_accent', 'Accent'));
    accent.type = 'button';
    accent.title = o.tt('decor_color_accent_hint', 'Follow the widget accent');
    const tail = valueTail(o.tt, () => { o.set(''); refresh(); o.onChange(); });
    if (window.ColorPicker) window.ColorPicker.bind(swatch);
    swatch.addEventListener('input', () => { o.set(swatch.value); refresh(); o.onChange(); });
    accent.addEventListener('click', () => { o.set(o.get() === 'accent' ? '' : 'accent'); refresh(); o.onChange(); });
    function refresh() {
      const v = o.get();
      const isAccent = v === 'accent';
      swatch.value = (v && !isAccent) ? v : (o.accentHex || '#888888');
      accent.classList.toggle('active', isAccent);
      accent.setAttribute('aria-pressed', String(isAccent));
      tail.value.textContent = v ? (isAccent ? '' : v) : (o.emptyText || o.tt('decor_color_auto', 'Auto'));
      tail.value.classList.toggle('is-theme', !v);
      tail.reset.hidden = !v;
    }
    row.append(swatch, label, accent, tail.value, tail.reset);
    refresh();
    return { row, refresh };
  }

  // A row of buttons, one per option: on a touchscreen every choice is one tap
  // away and visible. { label, options: [[value, text, title?]], get, set, onChange }
  function choiceField(o) {
    const row = mk('div', 'tsf-row tsf-col');
    if (o.label) row.appendChild(mk('span', 'tsf-label', o.label));
    const group = mk('div', 'tsf-choice');
    group.setAttribute('role', 'group');
    if (o.label) group.setAttribute('aria-label', o.label);
    const btns = o.options.map(([v, text, title]) => {
      const b = mk('button', 'tsf-choice-btn', text);
      b.type = 'button';
      b.dataset.value = v;
      if (title) b.title = title;
      b.addEventListener('click', () => { o.set(v); refresh(); o.onChange(); });
      group.appendChild(b);
      return b;
    });
    function refresh() {
      const cur = o.get();
      btns.forEach((b) => {
        const on = b.dataset.value === cur;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
    }
    row.appendChild(group);
    refresh();
    return { row, refresh };
  }

  function section(title) {
    const wrap = mk('div', 'tsf-section');
    wrap.appendChild(mk('div', 'tile-style-subhead', title));
    return wrap;
  }

  window.TileStyleFields = {
    colorField, rangeField, amountField, gradientField, toggleField, selectField, decorColorField, choiceField, section,
  };
})();
