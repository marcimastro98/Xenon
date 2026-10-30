'use strict';
// Canvas Ambient editor — the options form (fields from js/ambient-canvas-
// editor-fields.js). Builds plain labelled controls into a host; every change
// goes through `onChange(path, value, final)`: `final` false while a slider is
// dragged (repaint only), true once a value is set (keep it, rebuild the form
// if fields appear or go). Untrusted text only ever reaches .value/textContent.

(function () {
  if (typeof window === 'undefined') return;

  const tt = (key) => (typeof window.t === 'function' ? window.t(key) : key);
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function getPath(obj, path) {
    return path.split('.').reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), obj);
  }
  function setPath(obj, path, value) {
    const keys = path.split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    const last = keys[keys.length - 1];
    if (value === undefined) delete cur[last]; else cur[last] = value;
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

  // Gradient: linear/radial, angle, 2 to 5 colours each at a position.
  const DEFAULT_GRAD = () => ({ from: '#0b1020', to: '#1d2b64', angle: 180, stops: [{ color: '#0b1020', at: 0 }, { color: '#1d2b64', at: 100 }] });
  function stopsOf(g) { return g.stops ? g.stops.map(s => ({ ...s })) : [{ color: g.from, at: 0 }, { color: g.to, at: 100 }]; }
  function stopsEditor(f, grad, optional, onSet) {
    const box = el('div', 'ace-stops');
    if (optional) box.appendChild(row(tt('ace_f_gradient'), toggle(!!grad, (on) => onSet(on ? DEFAULT_GRAD() : null, true))));
    if (!grad) return box;
    const g = { ...grad, stops: stopsOf(grad) };
    const commit = (final) => onSet({ ...g, stops: g.stops.slice().sort((a, b) => a.at - b.at) }, final);
    box.appendChild(row(tt('ace_f_grad_kind'), segmented([['linear', 'ace_o_linear'], ['radial', 'ace_o_radial']], g.kind || 'linear', (v) => {
      if (v === 'radial') g.kind = 'radial'; else delete g.kind;
      commit(true);
    })));
    if (g.kind !== 'radial') box.appendChild(row(tt('ace_f_angle'), slider({ min: 0, max: 360, step: 5, unit: '°' }, g.angle, (v, fin) => { g.angle = v; commit(fin); })));
    g.stops.forEach((s, i) => {
      const line = el('div', 'ace-stop');
      line.append(
        swatch(s.color, (c, fin) => { s.color = c; commit(fin); }),
        slider({ min: 0, max: 100, step: 1, unit: '%' }, s.at, (v, fin) => { s.at = v; commit(fin); }),
      );
      if (g.stops.length > 2) {
        const rm = el('button', 'ace-icon-btn', '×');
        rm.type = 'button';
        rm.setAttribute('aria-label', tt('ace_stop_remove'));
        rm.title = tt('ace_stop_remove');
        rm.addEventListener('click', () => { g.stops.splice(i, 1); commit(true); });
        line.appendChild(rm);
      }
      box.appendChild(line);
    });
    if (g.stops.length < 5) {
      const add = el('button', 'ace-btn ace-btn-quiet', tt('ace_stop_add'));
      add.type = 'button';
      add.addEventListener('click', () => {
        const last = g.stops[g.stops.length - 1];
        g.stops.push({ color: last.color, at: Math.min(100, last.at) });
        g.stops.sort((a, b) => a.at - b.at);
        commit(true);
      });
      box.appendChild(add);
    }
    return box;
  }

  // A picture from this PC, shrunk and stored inside the scene (a data: image),
  // so the scene can still be shared and no upload clean-up can remove it.
  // A moving picture keeps moving (anim-picture.js): a canvas would keep only
  // its first frame. Resolves to { url } or { why } (the i18n key to show).
  const PICTURE_EDGES = [1600, 1200, 900];
  const PICTURE_MAX_CHARS = 1400000;   // under the tile image cap (TILE_BG_MAX_CHARS)
  const PICTURE_REFUSALS = { room: 'picture_too_big', frames: 'picture_frames', broken: 'ace_picture_failed' };
  async function pictureData(file) {
    const moving = typeof AnimPicture !== 'undefined'
      ? await AnimPicture.fitAnimatedPicture(file, { maxChars: PICTURE_MAX_CHARS, maxSide: PICTURE_EDGES[0] })
      : null;
    if (moving) return moving.dataUrl ? { url: moving.dataUrl } : { why: PICTURE_REFUSALS[moving.refused] };
    for (const edge of PICTURE_EDGES) {
      const cv = typeof rasterToCanvas === 'function' ? await rasterToCanvas(file, edge) : null;
      if (!cv) return { why: 'ace_picture_failed' };
      const url = cv.toDataURL('image/webp', 0.85);
      if (url.length <= PICTURE_MAX_CHARS) return { url };
    }
    return { why: 'picture_too_big' };
  }
  function picturePicker(value, onSet) {
    const box = el('div', 'ace-picture');
    const thumb = box.appendChild(el('span', 'ace-picture-thumb'));
    if (value) thumb.style.backgroundImage = `url("${value}")`;   // already allowlisted by the normalizer
    const input = el('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.hidden = true;
    const pick = el('button', 'ace-btn', tt(value ? 'ace_picture_change' : 'ace_picture_choose'));
    pick.type = 'button';
    pick.addEventListener('click', () => input.click());
    const note = el('span', 'ace-picture-note');
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      note.textContent = tt('ace_picture_working');
      const got = await pictureData(file).catch(() => ({ why: 'ace_picture_failed' }));
      note.textContent = got.url ? '' : tt(got.why);
      if (got.url) onSet(got.url, true);
    });
    box.append(input, pick, note);
    return box;
  }

  function timeWindow(show, onSet) {
    const box = el('div', 'ace-hours');
    const has = !!(show && show.from != null);
    box.appendChild(toggle(has, (on) => onSet(on ? { from: 8 * 60, to: 22 * 60 } : null, true)));
    if (!has) { box.appendChild(el('span', 'ace-hours-note', tt('ace_always'))); return box; }
    const at = (val, key) => {
      const i = el('input', 'ace-time');
      i.type = 'time';
      i.value = hhmm(val);
      i.setAttribute('aria-label', tt(key));
      i.addEventListener('change', () => {
        const m = minutesOf(i.value);
        if (m == null) return;
        onSet({ from: key === 'ace_f_from' ? m : show.from, to: key === 'ace_f_to' ? m : show.to }, true);
      });
      return i;
    };
    box.append(at(show.from, 'ace_f_from'), el('span', 'ace-hours-dash'), at(show.to, 'ace_f_to'));
    return box;
  }
  function weekdays(days, onSet) {
    const box = el('div', 'ace-days');
    const on = new Set(Array.isArray(days) ? days : [0, 1, 2, 3, 4, 5, 6]);
    let fmt = null;
    try { fmt = new Intl.DateTimeFormat(tt('locale'), { weekday: 'short' }); } catch { /* fallback below */ }
    // Monday first; 4 Jan 2026 was a Sunday.
    for (const d of [1, 2, 3, 4, 5, 6, 0]) {
      const b = el('button', 'ace-day', fmt ? fmt.format(new Date(2026, 0, 4 + d)) : String(d));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(on.has(d)));
      b.addEventListener('click', () => {
        if (on.has(d)) on.delete(d); else on.add(d);
        onSet(on.size === 7 || !on.size ? undefined : [...on].sort(), true);
      });
      box.appendChild(b);
    }
    return box;
  }

  function control(f, target, ctx, onChange) {
    const raw = getPath(target, f.path);
    const value = raw === undefined || raw === null ? f.fallback : raw;
    const set = (v, fin) => onChange(f, v, fin);
    switch (f.kind) {
      case 'pick': return f.options.length <= 3 ? segmented(f.options, value, set) : select(f.options, value, set);
      case 'bool': return toggle(value, set);
      case 'range': return slider(f, value == null ? f.min : value, set);
      case 'num': {
        const i = el('input', 'ace-num');
        i.type = 'number';
        i.min = f.min; i.max = f.max; i.step = 1; i.inputMode = 'numeric';
        i.value = value;
        i.addEventListener('change', () => { if (i.value !== '') set(Number(i.value), true); });
        return i;
      }
      case 'color': return swatch(value, set);
      case 'line': {
        const i = el('input', 'ace-line');
        i.type = 'text';
        i.maxLength = 60;
        i.value = value || '';
        i.addEventListener('change', () => set(i.value, true));
        return i;
      }
      case 'text': {
        const a = el('textarea', 'ace-textarea');
        a.rows = 3;
        a.maxLength = 400;
        a.value = value || '';
        a.addEventListener('input', () => set(a.value, false));
        a.addEventListener('change', () => set(a.value, true));
        return a;
      }
      case 'stops': return stopsEditor(f, raw || null, ctx.optionalGrad !== false && f.path !== 'bg.grad', set);
      case 'image': return picturePicker(value, set);
      case 'time': return timeWindow(raw, set);
      case 'days': return weekdays(raw, set);
      case 'page': {
        const opts = [[-1, 'ace_o_all_pages']];
        for (let p = 0; p < ctx.pageCount; p++) opts.push([p, '']);
        const s = select(opts, value == null ? -1 : value, set);
        Array.from(s.options).forEach((op, i) => { if (i) op.textContent = tt('ace_page_n').replace('{n}', String(i)); });
        return s;
      }
      default: return el('span');
    }
  }

  // Render `groups` for `target` into `host`. ctx: { pageCount }.
  function build(host, target, groups, ctx, onChange) {
    const frag = document.createDocumentFragment();
    for (const g of groups) {
      const fields = g.fields.filter(f => (!f.when || f.when(target)) && (f.kind !== 'page' || ctx.pageCount > 1));
      if (!fields.length) continue;
      const sec = frag.appendChild(el('section', 'ace-sec'));
      if (g.title) sec.appendChild(el('h3', 'ace-sec-title', tt(g.title)));
      let pair = null;   // number boxes (x, y, w, h) sit two to a row
      for (const f of fields) {
        const c = control(f, target, ctx, onChange);
        if (f.kind === 'num') {
          if (!pair) pair = sec.appendChild(el('div', 'ace-pair'));
          pair.appendChild(row(tt(f.label), c));
          continue;
        }
        pair = null;
        const wide = ['stops', 'text', 'days', 'image'].includes(f.kind);
        if (f.kind === 'stops' && f.path === 'bg.grad') { sec.appendChild(c); continue; }
        if (f.kind === 'stops' && c.firstChild && c.firstChild.classList.contains('ace-field')) { sec.appendChild(c); continue; }
        sec.appendChild(row(tt(f.label), c, wide));
      }
    }
    host.replaceChildren(frag);
  }

  window.AmbientEditorForm = { build, getPath, setPath, DEFAULT_GRAD };
})();
