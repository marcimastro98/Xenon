// The controls a form of the ambient scene editor is built from: a row with its label, a colour
// input, a slider, a switch, a list, a row of choices, and a time of day as text and as minutes.
'use strict';

(() => {
  const tt = (key) => (typeof window.t === 'function' ? window.t(key) : key);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const minutesOf = (s) => { const [h, m] = String(s).split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null; };

  // One labelled row: <label> on the left, the control on the right.
  function row(label, control, wide) {
    const r = el('div', 'ace-field' + (wide ? ' is-wide' : ''));
    const id = 'ace-f-' + Math.random().toString(36).slice(2, 8);
    const l = el('label', 'ace-field-label', label);
    const target = control.matches && control.matches('input, select, textarea') ? control : control.querySelector('input, select, textarea, button');
    if (target) { target.id = id; l.htmlFor = id; }
    r.append(l, control);
    return r;
  }

  function swatch(value, onPick) {
    const c = el('input', 'ace-color');
    c.type = 'color';
    c.value = /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#ffffff';
    c.addEventListener('input', () => onPick(c.value, false));
    c.addEventListener('change', () => onPick(c.value, true));
    return c;
  }

  function slider(f, value, onSet) {
    const box = el('div', 'ace-range');
    const r = el('input');
    r.type = 'range';
    r.min = f.min; r.max = f.max; r.step = f.step || 1;
    r.value = value;
    const out = el('output', 'ace-range-val', value + (f.unit || ''));
    r.addEventListener('input', () => { out.textContent = r.value + (f.unit || ''); onSet(Number(r.value), false); });
    r.addEventListener('change', () => onSet(Number(r.value), true));
    box.append(r, out);
    return box;
  }

  function toggle(on, onSet) {
    const b = el('button', 'ace-switch');
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', String(!!on));
    b.addEventListener('click', () => onSet(b.getAttribute('aria-checked') !== 'true', true));
    return b;
  }

  function select(options, value, onSet) {
    const s = el('select', 'ace-select');
    for (const [v, key] of options) s.appendChild(Object.assign(el('option', '', tt(key)), { value: String(v) }));
    s.value = String(value);
    s.addEventListener('change', () => {
      const pickV = options.find(([v]) => String(v) === s.value);
      onSet(pickV ? pickV[0] : s.value, true);
    });
    return s;
  }

  // Up to three choices read better as one row of buttons.
  function segmented(options, value, onSet) {
    const g = el('div', 'ace-seg');
    g.setAttribute('role', 'radiogroup');
    for (const [v, key] of options) {
      const b = el('button', 'ace-seg-btn', tt(key));
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(v === value));
      b.addEventListener('click', () => onSet(v, true));
      g.appendChild(b);
    }
    return g;
  }

  window.AmbientCanvasEditorFormControls = {
    tt, el, hhmm, minutesOf, row, swatch, slider, toggle, select, segmented,
  };
})();
