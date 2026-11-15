'use strict';

// One top bar button's own options, opened from its chevron in Settings → Top
// bar → Bar buttons: icon (from the Deck's icon library), label, whether the
// label shows, text and background colour, and a reset. Stored in
// topbarLook.buttons[id] (rules in js/topbar-look.js) and written through
// TopbarLookSettings.set, the same writer as the rest of the page.
(function () {
  const L = window.TopbarLook;

  const look = () => L.normalize(typeof hubSettings !== 'undefined' && hubSettings ? hubSettings.topbarLook : null);
  const blank = () => ({ icon: '', label: '', labelMode: 'auto', color: '', bg: '' });
  const current = (id) => ({ ...blank(), ...(look().buttons[id] || {}) });
  // Which panels have their icon grid open: view-only, survives a re-render.
  const openGrids = new Set();

  function text(tag, key, cls) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    el.setAttribute('data-i18n', key);
    el.textContent = t(key);
    return el;
  }

  function write(id, patch) {
    const buttons = { ...look().buttons, [id]: { ...current(id), ...patch } };
    window.TopbarLookSettings.set({ buttons });
  }

  // What the button says when the user has not renamed it, read from the bar
  // itself so it is always the real word in the current language.
  function defaultLabel(id) {
    const el = L.buttonEl(document, id);
    const span = el && [...el.children].find((c) => c.tagName === 'SPAN' && !c.className);
    if (!span) return '';
    const key = span.getAttribute('data-tb-key') || span.getAttribute('data-i18n');
    return key ? t(key) : (span.getAttribute('data-tb-text') || span.textContent);
  }

  function row(labelKey, control, hintKey) {
    const box = document.createElement('div');
    box.className = 'tbo-row';
    const line = document.createElement('span');
    line.className = 'settings-label-line';
    line.append(text('span', labelKey));
    if (hintKey) line.append(text('span', hintKey, 'settings-hint'));
    box.append(line, control);
    return box;
  }

  function iconControl(id, b) {
    const wrap = document.createElement('div');
    wrap.className = 'tbo-icon';
    const head = document.createElement('div');
    head.className = 'tbo-icon-head';
    const toggle = text('button', 'tbl_btn_icon_change', 'settings-btn subtle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(openGrids.has(id)));
    const original = text('button', 'tbl_btn_icon_default', 'settings-btn subtle');
    original.type = 'button';
    original.hidden = !b.icon;
    original.addEventListener('click', () => write(id, { icon: '' }));
    head.append(toggle, original);

    const grid = document.createElement('div');
    grid.className = 'tbo-icon-grid';
    grid.hidden = !openGrids.has(id);
    toggle.addEventListener('click', () => {
      const open = !openGrids.has(id);
      if (open) openGrids.add(id); else openGrids.delete(id);
      grid.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open && !grid.childElementCount) fillGrid(grid, id, b.icon);
    });
    if (!grid.hidden) fillGrid(grid, id, b.icon);
    wrap.append(head, grid);
    return wrap;
  }

  // The Deck's icon set, in the Deck's own groups (Media, Audio, System...), so
  // an icon is found by what it is for rather than by scanning 50 shapes.
  function fillGrid(grid, id, selected) {
    const lib = window.DeckIcons;
    if (!lib) return;
    const seen = new Set();
    const groups = (lib.CATEGORIES || []).map((c) => ({ labelKey: c.labelKey, ids: c.ids }));
    groups.push({ labelKey: '', ids: lib.ids() });
    for (const group of groups) {
      const ids = group.ids.filter((name) => lib.has(name) && !seen.has(name));
      if (!ids.length) continue;
      if (group.labelKey) grid.append(text('span', group.labelKey, 'tbo-icon-cat'));
      for (const name of ids) {
        seen.add(name);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'tbo-icon-cell';
        cell.setAttribute('aria-label', name);
        cell.setAttribute('aria-pressed', String(name === selected));
        cell.append(lib.el(name));
        cell.addEventListener('click', () => write(id, { icon: name }));
        grid.append(cell);
      }
    }
  }

  function labelControl(id, b) {
    const input = document.createElement('input');
    input.className = 'settings-text-input';
    input.type = 'text';
    input.maxLength = L.LABEL_MAX;
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.value = b.label;
    input.placeholder = defaultLabel(id);
    // Saved when the field is left (or Enter), not on every key: saving
    // re-renders the list, which would take the cursor away mid-word.
    // A first label on a button that follows the bar also turns its label on:
    // someone who types a word expects to see it, and on a bar that shows
    // icons only "Automatic" would hide it. Later edits leave the choice alone.
    input.addEventListener('change', () => {
      const first = !current(id).label && input.value.trim() && current(id).labelMode === 'auto';
      write(id, first ? { label: input.value, labelMode: 'always' } : { label: input.value });
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    return input;
  }

  function modeControl(id, b) {
    const wrap = document.createElement('div');
    wrap.className = 'settings-segmented tbl-seg';
    wrap.setAttribute('role', 'group');
    wrap.dataset.count = '3';
    for (const mode of ['auto', 'always', 'never']) {
      const btn = text('button', 'tbl_labels_' + mode, 'settings-segment-btn');
      btn.type = 'button';
      const on = b.labelMode === mode;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.addEventListener('click', () => write(id, { labelMode: mode }));
      wrap.append(btn);
    }
    return wrap;
  }

  function colorControl(id, key, value) {
    const wrap = document.createElement('div');
    wrap.className = 'tbl-color';
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'tbl-swatch';
    swatch.classList.toggle('is-theme', !value);
    if (value) swatch.style.setProperty('--tbl-swatch', value);
    swatch.setAttribute('aria-label', t(key === 'color' ? 'tbl_btn_color' : 'tbl_btn_bg'));
    swatch.addEventListener('click', () => {
      if (!window.ColorPicker) return;
      ColorPicker.open({ anchor: swatch, value: value || '#2b6cff', onPick: (hex) => write(id, { [key]: hex }) });
    });
    // Says what an empty swatch means; once a colour is picked, the way back.
    const state = text('span', 'tbl_btn_default', 'settings-hint tbl-color-state');
    state.hidden = !!value;
    const reset = text('button', 'tbl_btn_default', 'settings-btn subtle');
    reset.type = 'button';
    reset.hidden = !value;
    reset.addEventListener('click', () => write(id, { [key]: '' }));
    wrap.append(swatch, state, reset);
    return wrap;
  }

  // The panel for one button, or null for an id that is not a button (the
  // favourites strip and the widget slot take the bar's look only).
  function panel(id) {
    if (!L || !L.isButtonId(id)) return null;
    const b = current(id);
    const box = document.createElement('div');
    box.className = 'island-edit-sub tbo-panel';
    box.append(
      row('tbl_btn_icon', iconControl(id, b)),
      row('tbl_btn_label', labelControl(id, b)),
      row('tbl_btn_label_mode', modeControl(id, b), 'tbl_btn_label_hint'),
      row('tbl_btn_color', colorControl(id, 'color', b.color)),
      row('tbl_btn_bg', colorControl(id, 'bg', b.bg)),
    );
    if (look().buttons[id]) {
      const reset = text('button', 'tbl_btn_reset', 'settings-btn subtle tbo-reset');
      reset.type = 'button';
      reset.addEventListener('click', () => {
        const buttons = { ...look().buttons };
        delete buttons[id];
        window.TopbarLookSettings.set({ buttons });
      });
      box.append(reset);
    }
    return box;
  }

  // The panels are rebuilt with the list, which already re-renders on save.
  function sync() {
    if (typeof renderTopbarActionsEditor === 'function') renderTopbarActionsEditor();
  }

  window.TopbarButtonOptions = { panel, sync };
})();
