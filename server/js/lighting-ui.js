// Shared building blocks of the lighting hub (Settings → Illuminazione): the
// /api/lighting/* POST helper and the card/row/control builders used by
// lighting-page.js, lighting-map.js and lighting-connections.js. They build the
// same settings-* components as every other Settings page, so the hub looks and
// behaves like the rest of the app.
(function () {
  'use strict';

  // Project the server status onto the persistable client `lighting` shape, so the
  // settings mirror stays in sync with server-side changes (no clobber).
  function lightingFromStatus(s) {
    const devices = {};
    (s.devices || []).forEach(d => { if (d.optedIn === false) devices[d.id] = false; });
    return {
      enabled: !!s.enabled,
      brightness: typeof s.brightness === 'number' ? s.brightness : 1,
      pauseDuringGame: !!s.pauseDuringGame,
      effects: { ...(s.effects || {}) },
      animation: s.animation ? { ...s.animation } : undefined,
      manualColor: typeof s.manualColor === 'string' ? s.manualColor : '',
      devices,
    };
  }

  async function fetchStatus() {
    try { return await (await fetch('/api/lighting/status')).json(); }
    catch { return { available: false, reason: 'offline', providers: [], devices: [] }; }
  }

  // POST a lighting command. Endpoints return either a full status or { status }.
  // Mirror whichever we get into the client settings store.
  async function post(path, body) {
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      const status = (data && data.status && Array.isArray(data.status.providers)) ? data.status
                   : (data && Array.isArray(data.providers)) ? data : null;
      if (status && window.syncHubLighting) window.syncHubLighting(lightingFromStatus(status));
      return data;
    } catch (e) { console.error('lighting post failed', e); return null; }
  }

  // t() with a fallback for keys that may not exist (t returns the key itself then).
  function tr(key, fallback) {
    if (typeof t !== 'function') return fallback;
    const v = t(key);
    return (v && v !== key) ? v : fallback;
  }

  // Scoped i18n pass: mirror applyTranslations() but confined to `root` so it
  // can never trigger a settings-modal re-render (renderSettingsModal →
  // syncSettingsControls → LightingPage.init → render would recurse forever).
  function localizeSubtree(root) {
    if (!root || typeof t !== 'function') return;
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.getAttribute('data-i18n-title')); });
  }

  function el(tag, className, i18nKey, fallback) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (i18nKey) node.setAttribute('data-i18n', i18nKey);
    if (fallback) node.textContent = fallback;
    return node;
  }

  function button(className, i18nKey, fallback, onClick) {
    const b = el('button', className, i18nKey, fallback);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  // A card of the Settings page: the same .settings-group every other section
  // uses, with its title bar and a padded body. Returns the card; content goes
  // into card.body. `aside` (optional) sits at the right of the title bar.
  function card(i18nKey, fallback, aside) {
    const group = el('section', 'settings-group lighting-card');
    if (i18nKey || fallback) {
      const head = el('div', 'settings-group-head');
      head.appendChild(el('span', '', i18nKey, fallback));
      if (aside) head.appendChild(aside);
      group.appendChild(head);
    }
    group.body = el('div', 'lighting-card-body');
    group.appendChild(group.body);
    return group;
  }

  // Settings toggle: checkbox, bold label, optional explanation under it.
  function toggleRow(i18nKey, checked, onChange, hintKey) {
    const row = el('label', 'settings-toggle-row');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.className = 'settings-check'; input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    const text = el('span', 'settings-label-line');
    text.appendChild(el('span', '', i18nKey));
    if (hintKey) text.appendChild(el('span', 'settings-hint', hintKey));
    row.append(input, text);
    return row;
  }

  // Segmented control — replaces dropdowns for small option sets. Native
  // <select> popups render blank on the Xeneon Edge WebView, so we avoid them.
  // options: [[value, i18nKey, fallback], …]. onSelect(value) fires on tap.
  // `cols` sets how many fit on one line (CSS halves it on a phone).
  function segmented(options, current, onSelect, cols) {
    const seg = el('div', 'settings-segmented lighting-seg');
    seg.dataset.cols = String(cols || Math.min(options.length, 4));
    options.forEach(([val, key, fb]) => {
      const b = button('settings-segment-btn' + (val === current ? ' active' : ''), key, fb, () => {
        seg.querySelectorAll('.settings-segment-btn').forEach((x) => {
          x.classList.remove('active');
          x.setAttribute('aria-pressed', 'false');
        });
        b.classList.add('active');
        b.setAttribute('aria-pressed', 'true');
        onSelect(val);
      });
      b.setAttribute('aria-pressed', String(val === current));
      seg.appendChild(b);
    });
    return seg;
  }

  function segmentedRow(i18nKey, options, current, onSelect, cols) {
    return labeledRow(i18nKey, segmented(options, current, onSelect, cols));
  }

  function speedSlider(value, onChange) {
    const sp = document.createElement('input');
    sp.type = 'range'; sp.className = 'settings-range'; sp.min = '1'; sp.max = '100'; sp.value = String(value || 50);
    sp.addEventListener('change', () => onChange(Number(sp.value)));
    return sp;
  }

  // Label line above its control, like every Settings row.
  // NOTE: a plain <div>, not a <label> — wrapping a range in a <label> makes the
  // slider hard to drag (the label hijacks pointer events) and can double-trigger
  // the control on touch.
  function labeledRow(i18nKey, control) {
    const row = el('div', 'settings-row lighting-row');
    if (i18nKey) row.appendChild(el('span', 'settings-label-line', i18nKey));
    row.appendChild(control);
    return row;
  }

  // Hex colour input + live swatch (the native colour picker is unreliable on the
  // Xeneon Edge WebView — tapping the swatch opens the in-app ColorPicker instead).
  // Accepts "#rrggbb" or "rrggbb". Returns the box; box.setValue(hex) updates it
  // without firing onValid.
  function hexColorControl(initial, onValid) {
    const box = el('span', 'settings-color-wrap lighting-color-ctl');
    const start = /^#?[0-9a-f]{6}$/i.test(String(initial || '')) ? ('#' + String(initial).replace(/^#/, '')) : '#1ed760';
    const swatch = el('span', 'settings-color-preview');
    swatch.style.background = start;
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'settings-hex-input'; input.maxLength = 7;
    input.spellcheck = false; input.placeholder = '#1ed760'; input.value = start;
    const show = (v) => { input.value = v; input.classList.remove('invalid'); swatch.style.background = v; };
    const accept = (v) => { show(v); onValid(v); };
    input.addEventListener('change', () => {
      let v = input.value.trim();
      if (/^[0-9a-f]{6}$/i.test(v)) v = '#' + v; // tolerate a missing leading #
      if (/^#[0-9a-f]{6}$/i.test(v)) accept(v.toLowerCase());
      else input.classList.add('invalid');
    });
    if (window.ColorPicker) {
      swatch.title = tr('color_custom', '');
      swatch.addEventListener('click', () => window.ColorPicker.open({ anchor: swatch, value: input.value, onPick: accept }));
    }
    box.append(swatch, input);
    box.setValue = show;
    box.getValue = () => input.value;
    return box;
  }

  // Quick colours for touch (the full-saturation hues people reach for most)
  // next to the hex control. onPick(hex) fires on a tap or a valid hex.
  const QUICK_COLORS = ['#ff0000', '#ff7a00', '#ffd400', '#00ff40', '#00e5ff', '#0050ff', '#a000ff', '#ffffff'];
  function colorChoice(initial, onPick) {
    const pick = el('div', 'lighting-color-choice');
    const ctl = hexColorControl(initial, onPick);
    QUICK_COLORS.forEach((hex) => {
      const b = button('lighting-quick-color', '', '', () => { ctl.setValue(hex); onPick(hex); });
      b.style.background = hex;
      b.setAttribute('aria-label', hex);
      pick.appendChild(b);
    });
    pick.appendChild(ctl);
    return pick;
  }

  // The effects a whole device or a group of LEDs can run. 'wave' runs across
  // LEDs, so only a LED selection offers it (a device-wide wave would look like
  // the rainbow). Styles that use a colour and that loop, for the sub-controls.
  const EFFECTS = [
    ['breathing', 'lighting_anim_breathing', 'Respiro'], ['cycle', 'lighting_anim_cycle', 'Arcobaleno'],
    ['wave', 'lighting_anim_wave', 'Onda'], ['aurora', 'lighting_anim_aurora', 'Aurora'],
    ['candle', 'lighting_anim_candle', 'Candela'], ['temperature', 'lighting_fx_temperature', 'Temperatura CPU'],
    ['album', 'lighting_fx_album', 'Copertina album'],
  ];
  const COLOR_EFFECTS = ['breathing', 'candle'];
  const LOOPING_EFFECTS = ['breathing', 'cycle', 'wave', 'aurora', 'candle'];

  // Colour + speed for an effect, only the ones that style uses.
  // value: { style, color, speed }; onChange(patch).
  function effectExtras(value, onChange) {
    const out = [];
    if (COLOR_EFFECTS.includes(value.style)) {
      out.push(labeledRow('lighting_anim_color', hexColorControl(value.color || '#1ed760', (v) => onChange({ color: v }))));
    }
    if (LOOPING_EFFECTS.includes(value.style)) {
      out.push(labeledRow('lighting_anim_speed', speedSlider(value.speed, (v) => onChange({ speed: v }))));
    }
    return out;
  }

  function hintP(text, i18nKey) {
    const p = el('p', 'settings-hint lighting-hint', i18nKey);
    p.textContent = text;
    return p;
  }

  window.LightingUI = {
    lightingFromStatus, fetchStatus, post, tr, localizeSubtree,
    el, button, card, toggleRow, segmented, segmentedRow, speedSlider, labeledRow, hexColorControl, colorChoice, hintP,
    EFFECTS, effectExtras,
  };
})();
