'use strict';

// Settings → Top bar: the ready-made looks, "Customize", the clock's font and
// where notifications appear. Every control writes hubSettings.topbarLook through
// set(), and the bar at the top of the screen is the preview: it changes as the
// user picks. The rules (what each value is) live in js/topbar-look.js; this file
// only draws the controls for them. Text is built with textContent and carries
// its data-i18n key, so a language change re-translates it in place.
(function () {
  const L = window.TopbarLook;

  const seg = (prefix, values) => values.map((v) => [v, prefix + v.replace(/-/g, '_')]);

  // The fine controls, in the order they appear under "Customize".
  const CUSTOM_ROWS = [
    { key: 'surface', label: 'tbl_surface', values: seg('tbl_surface_', L.CHOICES.surface) },
    { key: 'color', type: 'color', label: 'tbl_color', when: (l) => l.surface === 'solid' || l.surface === 'glass' },
    { key: 'opacity', type: 'range', label: 'tbl_opacity', min: 20, max: 100, step: 5, unit: '%', when: (l) => l.surface === 'solid' || l.surface === 'glass' },
    { key: 'blur', type: 'range', label: 'tbl_blur', min: 0, max: 30, step: 1, unit: 'px', when: (l) => l.surface === 'glass' },
    { key: 'border', label: 'tbl_border', values: seg('tbl_border_', L.CHOICES.border) },
    { key: 'shape', label: 'tbl_shape', values: seg('tbl_shape_', L.CHOICES.shape) },
    { key: 'shadow', type: 'toggle', label: 'tbl_shadow' },
    { key: 'size', label: 'tbl_size', hint: 'tbl_size_hint', values: seg('tbl_size_', L.CHOICES.size) },
    { key: 'buttonStyle', label: 'tbl_buttons', values: seg('tbl_buttons_', L.CHOICES.buttonStyle) },
    { key: 'labels', label: 'tbl_labels', hint: 'tbl_labels_hint', values: seg('tbl_labels_', L.CHOICES.labels) },
    { key: 'accent', type: 'accent', label: 'tbl_accent' },
    { key: 'separator', label: 'tbl_separator', hint: 'tbl_separator_hint', values: seg('tbl_sep_', L.CHOICES.separator) },
    { key: 'gap', label: 'tbl_gap', values: seg('tbl_gap_', L.CHOICES.gap) },
  ];
  const CLOCK_ROWS = [
    { key: 'clockFont', label: 'tbl_clock_font', values: seg('tbl_font_', L.CHOICES.clockFont) },
    { key: 'colonBlink', type: 'toggle', label: 'tbl_colon_blink' },
  ];
  // The edge rails of Minimal and None. A side that holds Settings or Layout
  // says so under its switch: the guard in TopbarLook.css keeps it on screen.
  const autoHide = () => typeof hubSettings === 'undefined' || !hubSettings || hubSettings.topbarRailsAutoHide !== false;
  const keeperNote = (side) => () => (keeperSides().includes(side) ? 'tbl_rail_keeps' : '');
  const RAIL_ROWS = [
    { key: 'railLeft', label: 'tbl_rail_left', note: keeperNote('left'), values: seg('tbl_rail_', L.CHOICES.railLeft) },
    { key: 'railRight', label: 'tbl_rail_right', note: keeperNote('right'), values: seg('tbl_rail_', L.CHOICES.railRight) },
    { key: 'railAlign', label: 'tbl_rail_align', values: seg('tbl_rail_align_', L.CHOICES.railAlign) },
    { key: 'railMotion', label: 'tbl_rail_motion', values: seg('tbl_rail_motion_', L.CHOICES.railMotion) },
    { key: 'railDelay', type: 'range', label: 'tbl_rail_delay', min: 3, max: 60, step: 1, unit: ' s', when: autoHide },
    { key: 'railPeek', label: 'tbl_rail_peek', hint: 'tbl_rail_peek_hint', values: seg('tbl_rail_peek_', L.CHOICES.railPeek), when: autoHide },
  ];
  const NOTIFY_ROWS = [
    { key: 'toastPlace', type: 'select', label: 'tbl_toast_place', hint: 'tbl_toast_place_hint', values: seg('tbl_toast_', L.CHOICES.toastPlace) },
  ];
  // Names of the buttons for the accent list (keys shared with the button editor).
  const BUTTON_NAMES = {
    lock: 'topbar_btn_lock', ambient: 'topbar_btn_ambient', xenon: 'topbar_btn_xenon', search: 'topbar_btn_search',
    layout: 'topbar_btn_layout', settings: 'topbar_btn_settings', apps: 'topbar_btn_apps',
  };

  // hubSettings is settings.js's top-level `let`: shared by name, not on window.
  const look = () => L.normalize(typeof hubSettings !== 'undefined' && hubSettings ? hubSettings.topbarLook : null);

  // The sides Settings and Layout sit on (topbarClock.actions).
  function keeperSides() {
    const actions = typeof hubSettings !== 'undefined' && hubSettings && hubSettings.topbarClock
      ? hubSettings.topbarClock.actions : null;
    if (!Array.isArray(actions)) return ['right'];
    return actions.filter((a) => a && L.RAIL_KEEPERS.includes(a.id)).map((a) => a.side);
  }

  function text(tag, key, cls) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    el.setAttribute('data-i18n', key);
    el.textContent = t(key);
    return el;
  }

  function labelLine(row) {
    const line = document.createElement('span');
    line.className = 'settings-label-line';
    line.append(text('span', row.label));
    if (row.hint) line.append(text('span', row.hint, 'settings-hint'));
    if (row.note) {
      const note = document.createElement('span');
      note.className = 'settings-hint tbl-note';
      note.hidden = true;
      line.append(note);
    }
    return line;
  }

  function segmented(row) {
    const wrap = document.createElement('div');
    wrap.className = 'settings-segmented tbl-seg';
    wrap.setAttribute('role', 'group');
    wrap.dataset.count = String(row.values.length);
    for (const [value, key] of row.values) {
      const b = text('button', key, 'settings-segment-btn');
      b.type = 'button';
      b.dataset.tbValue = value;
      b.addEventListener('click', () => set({ [row.key]: value }));
      wrap.append(b);
    }
    return wrap;
  }

  function range(row) {
    const box = document.createElement('label');
    box.className = 'settings-row';
    const line = labelLine(row);
    const value = document.createElement('span');
    value.className = 'settings-value';
    line.append(value);
    const input = document.createElement('input');
    input.className = 'settings-range';
    input.type = 'range';
    Object.assign(input, { min: row.min, max: row.max, step: row.step });
    // Live while dragging, saved once on release.
    input.addEventListener('input', () => {
      value.textContent = input.value + row.unit;
      L.apply({ ...look(), [row.key]: Number(input.value) });
    });
    input.addEventListener('change', () => set({ [row.key]: Number(input.value) }));
    box.append(line, input);
    box._tbSync = (l) => { input.value = l[row.key]; value.textContent = l[row.key] + row.unit; };
    return box;
  }

  function toggle(row) {
    const box = document.createElement('label');
    box.className = 'settings-toggle-row full';
    const input = document.createElement('input');
    input.className = 'settings-check';
    input.type = 'checkbox';
    input.addEventListener('change', () => set({ [row.key]: input.checked }));
    box.append(input, labelLine(row));
    box._tbSync = (l) => { input.checked = l[row.key] === true; };
    return box;
  }

  function select(row, options) {
    const sel = document.createElement('select');
    sel.className = 'settings-select';
    sel.setAttribute('data-custom-select', '');
    sel.setAttribute('data-cs-fixed', '');
    for (const [value, key] of options) {
      const o = text('option', key);
      o.value = value;
      sel.append(o);
    }
    sel.addEventListener('change', () => set({ [row.key]: sel.value }));
    return sel;
  }

  // A swatch that opens the in-app picker (the native dialog does not work in
  // the iCUE WebView), and a way back to the theme's own colour.
  function color(row) {
    const wrap = document.createElement('div');
    wrap.className = 'tbl-color';
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'tbl-swatch';
    swatch.setAttribute('aria-label', t(row.label));
    swatch.addEventListener('click', () => {
      if (!window.ColorPicker) return;
      ColorPicker.open({ anchor: swatch, value: look()[row.key] || '#1e2428', onPick: (hex) => set({ [row.key]: hex }) });
    });
    const state = text('span', 'tbl_preset_theme', 'settings-hint tbl-color-state');
    const reset = text('button', 'tbl_color_theme', 'settings-btn subtle');
    reset.type = 'button';
    reset.addEventListener('click', () => set({ [row.key]: '' }));
    wrap.append(swatch, state, reset);
    wrap._tbSync = (l) => {
      swatch.classList.toggle('is-theme', !l[row.key]);
      if (l[row.key]) swatch.style.setProperty('--tbl-swatch', l[row.key]); else swatch.style.removeProperty('--tbl-swatch');
      reset.hidden = !l[row.key];
      state.hidden = !!l[row.key];
    };
    return wrap;
  }

  function buildRow(row) {
    if (row.type === 'range') return range(row);
    if (row.type === 'toggle') return toggle(row);
    const box = document.createElement('div');
    box.className = 'settings-row full';
    let control;
    if (row.type === 'color') control = color(row);
    else if (row.type === 'select') control = select(row, row.values);
    else if (row.type === 'accent') {
      control = select(row, [...Object.entries(BUTTON_NAMES), ['none', 'tbl_accent_none']]);
    } else control = segmented(row);
    box.append(labelLine(row), control);
    box._tbControl = control;
    return box;
  }

  function syncNote(el, row, l) {
    const note = row.note && el.querySelector('.tbl-note');
    if (!note) return;
    const key = row.note(l);
    note.hidden = !key;
    if (key) { note.setAttribute('data-i18n', key); note.textContent = t(key); } else note.removeAttribute('data-i18n');
  }

  function syncRow(el, row, l) {
    el.hidden = typeof row.when === 'function' && !row.when(l);
    syncNote(el, row, l);
    if (el._tbSync) return el._tbSync(l);
    const control = el._tbControl;
    if (!control) return;
    if (control._tbSync) return control._tbSync(l);
    if (control.tagName === 'SELECT') {
      control.value = l[row.key];
      if (typeof control._csSync === 'function') control._csSync();
      return;
    }
    // A side that must stay cannot be switched off: its "Off" is greyed out and
    // the note under the name says why, instead of a choice that does nothing.
    const locked = row.note ? !!row.note(l) : false;
    for (const b of control.querySelectorAll('[data-tb-value]')) {
      const on = locked ? b.dataset.tbValue === 'show' : b.dataset.tbValue === l[row.key];
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
      b.disabled = locked && b.dataset.tbValue === 'off';
    }
  }

  // A ready-made look as a card: a small drawing of the bar in that look (the
  // same plates, in the theme's own colours) and its name.
  function presetCard(id) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tbl-preset';
    b.dataset.tbPreset = id;
    const prev = document.createElement('span');
    prev.className = 'tbl-prev';
    prev.setAttribute('aria-hidden', 'true');
    for (const part of ['btn', 'btn', 'island', 'btn']) {
      const p = document.createElement('i');
      p.className = 'tbl-prev-' + part;
      prev.append(p);
    }
    b.append(prev, text('span', 'tbl_preset_' + id, 'tbl-preset-name'));
    b.addEventListener('click', () => set(L.withPreset(look(), id), true));
    return b;
  }

  const mounted = [];

  function mountRows(host, rows) {
    if (!host || host.childElementCount) return;
    const els = rows.map(buildRow);
    host.append(...els);
    els.forEach((el, i) => mounted.push([el, rows[i]]));
    if (typeof initAllCustomSelects === 'function') initAllCustomSelects(host);
  }
  const mount = (hostId, rows) => mountRows(document.getElementById(hostId), rows);

  function mountPresets(host) {
    if (!host || host.childElementCount) return;
    host.append(...L.PRESET_IDS.map(presetCard));
  }

  // The same controls somewhere else (the bar panel of Layout mode,
  // js/topbar-layout-panel.js). Repainted by sync() while they are on the page;
  // once their panel is closed they drop out of the list.
  function mountInto(host, kind) {
    if (kind === 'presets') mountPresets(host);
    else if (kind === 'rails') mountRows(host, RAIL_ROWS);
    sync();
  }

  // Repaint every control from the stored look. Called on every settings sync.
  function sync() {
    if (!L || !document.getElementById('settings-topbar-look')) return;
    mountPresets(document.getElementById('tbl-presets'));
    mount('tbl-custom-rows', CUSTOM_ROWS);
    mount('tbl-rail-rows', RAIL_ROWS);
    mount('tbl-clock-rows', CLOCK_ROWS);
    mount('tbl-notify-rows', NOTIFY_ROWS);
    for (let i = mounted.length - 1; i >= 0; i -= 1) if (!mounted[i][0].isConnected) mounted.splice(i, 1);
    const l = look();
    for (const [el, row] of mounted) syncRow(el, row, l);
    const current = L.presetOf(l);
    for (const card of document.querySelectorAll('.tbl-preset')) {
      const on = card.dataset.tbPreset === current;
      card.classList.toggle('active', on);
      card.setAttribute('aria-pressed', String(on));
    }
    const custom = document.getElementById('tbl-custom-state');
    if (custom) custom.hidden = current !== '';
  }

  // The one writer. `replace` takes `patch` as the whole look (a preset);
  // otherwise it is merged into the stored one.
  function set(patch, replace) {
    const next = replace ? patch : { ...look(), ...patch };
    hubSettings = normalizeSettings({ ...hubSettings, topbarLook: next });
    saveHubSettings();
    L.apply(hubSettings.topbarLook);
    sync();
    if (window.TopbarButtonOptions) TopbarButtonOptions.sync();
    setSettingsStatus('settings_saved', 'ok');
  }

  function testToast() {
    if (window.XenonToast) XenonToast.show({ type: 'info', title: t('tbl_toast_sample_title'), message: t('tbl_toast_sample') });
  }

  window.TopbarLookSettings = { sync, set, testToast, mountInto };
})();
