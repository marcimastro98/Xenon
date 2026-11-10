// A Store widget's own options (manifest `options`, widget-options/) on the Store's
// Installed page. The Xenon menu offers them only for a widget placed on the desktop or
// over a game, and only with the app: a widget used as a dashboard tile, in a browser,
// on a phone, a Mac or Linux had no place to change them. Here they are on every surface.
// Each change is the widgetOption action, checked by the server against what the widget
// declared; its copies on screen get the new values through the `sdk_options` event.
(function () {
  'use strict';

  const t = (k, fb) => {
    const v = typeof window.t === 'function' ? window.t(k) : k;
    return v === k && fb != null ? fb : v;
  };
  const el = makeEl;
  // Panels left open survive the list being painted again.
  const opened = new Set();

  // The widget's words, in the language of the page when it wrote them.
  function words(label) {
    if (typeof label === 'string') return label;
    if (!label || typeof label !== 'object') return '';
    const code = typeof lang === 'string' ? lang : 'en';
    return label[code] || label.en || Object.values(label)[0] || '';
  }

  const settable = (pkg) => (Array.isArray(pkg && pkg.options) ? pkg.options.filter((o) => o.kind !== 'group') : []);
  const has = (pkg) => settable(pkg).length > 0;

  async function send(pkg, option, value) {
    const d = await apiJson('/actions/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'widgetOption', widget: pkg.id, option, value }),
    });
    if (!d || !d.ok) throw new Error((d && d.error) || 'failed');
    pkg.optionValues = d.values || pkg.optionValues;
  }

  // One change: the control shows it at once and goes back if the server refused it.
  async function change(pkg, option, value, undo) {
    try {
      await send(pkg, option, value);
    } catch (e) {
      console.warn('[widget-options] not saved', option, e && e.message);
      undo();
      if (window.XenonToast) window.XenonToast.show({ type: 'error', title: t('wopt_not_saved', 'Not saved'), message: String(pkg.name || ''), duration: 3600 });
    }
  }

  function listLine(pkg, o, values) {
    const line = el('label', 'inst-opt-line');
    line.appendChild(el('span', 'inst-opt-name', words(o.label)));
    const pick = el('select', 'settings-select');
    for (const c of o.choices || []) {
      const opt = el('option', null, words(c.label));
      opt.value = c.value;
      pick.appendChild(opt);
    }
    pick.value = values[o.id];
    pick.addEventListener('change', () => {
      const before = values[o.id];
      values[o.id] = pick.value;
      change(pkg, o.id, pick.value, () => { values[o.id] = before; pick.value = before; });
    });
    line.appendChild(pick);
    return line;
  }

  function switchLine(pkg, o, values) {
    const line = el('label', 'settings-toggle-row');
    const box = el('input', 'settings-check');
    box.type = 'checkbox';
    box.checked = values[o.id] === true;
    box.addEventListener('change', () => {
      values[o.id] = box.checked;
      change(pkg, o.id, box.checked ? 'on' : 'off', () => { values[o.id] = !box.checked; box.checked = !box.checked; });
    });
    const text = el('span', 'settings-label-line');
    text.appendChild(el('span', null, words(o.label)));
    line.append(box, text);
    return line;
  }

  function panel(pkg) {
    const box = el('div', 'inst-opts');
    box.id = 'inst-opts-' + pkg.id;
    fill(box, pkg);
    return box;
  }

  // Lists first as the widget ordered them, then its switches under their groups.
  function fill(box, pkg) {
    box.replaceChildren();
    const values = { ...(pkg.optionValues || {}) };
    const groups = pkg.options.filter((o) => o.kind === 'group');
    const switches = settable(pkg).filter((o) => o.kind === 'toggle');
    for (const o of settable(pkg)) if (o.kind === 'select') box.appendChild(listLine(pkg, o, values));
    for (const g of [{ id: '' }, ...groups]) {
      const here = switches.filter((o) => (o.group || '') === g.id);
      if (!here.length) continue;
      if (g.label) box.appendChild(el('p', 'inst-opt-group', words(g.label)));
      const grid = el('div', 'inst-opt-switches');
      for (const o of here) grid.appendChild(switchLine(pkg, o, values));
      box.appendChild(grid);
    }
    box.appendChild(resetKey(pkg, box));
  }

  // Back to what the widget chose for itself: one change per option that differs.
  function resetKey(pkg, box) {
    const key = el('button', 'settings-btn subtle inst-opt-reset', t('wopt_reset', 'Back to defaults'));
    key.type = 'button';
    key.addEventListener('click', async () => {
      key.disabled = true;
      const now = pkg.optionValues || {};
      try {
        for (const o of settable(pkg)) {
          if (now[o.id] === o.default) continue;
          await send(pkg, o.id, o.kind === 'toggle' ? (o.default ? 'on' : 'off') : o.default);
        }
      } catch (e) {
        console.warn('[widget-options] reset stopped', e && e.message);
      }
      fill(box, pkg);
    });
    return key;
  }

  // The row's "Options" key and the panel it opens under the widget's name; nothing
  // for a widget that declares no options.
  function attach(pkg, info, btns) {
    if (!has(pkg)) return;
    const box = panel(pkg);
    const key = el('button', 'settings-btn', t('wopt_btn', 'Options'));
    key.type = 'button';
    key.setAttribute('aria-controls', box.id);
    const show = (on) => {
      box.hidden = !on;
      key.setAttribute('aria-expanded', String(on));
      if (on) opened.add(pkg.id); else opened.delete(pkg.id);
    };
    show(opened.has(pkg.id));
    key.addEventListener('click', () => show(box.hidden));
    info.appendChild(box);
    btns.appendChild(key);
  }

  window.WidgetOptionsPanel = { attach, has };
})();
