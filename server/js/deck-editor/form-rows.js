// The rows the deck editor's forms are built from: a section, a field, a switch, a sub-row and the
// row of colour swatches.
'use strict';

(() => {
  const t = (k) => (typeof window.t === 'function' ? window.t(k) : k);

  // Shared preset palette for every Deck colour picker (accent, tap-effect colour,
  // LED colour). Ordered as a spectrum — red → orange → yellow → green → teal →
  // blue → indigo → purple → pink — then the neutrals (white, grey), so the row
  // reads as an organised rainbow instead of a scattered set. The native colour
  // dialog was unreliable in the WebView, so these presets are the picker.
  const DECK_SWATCHES = [
    '#ff3b30', // red
    '#ff6b22', // red-orange
    '#ff9500', // orange
    '#ffcc00', // yellow
    '#a2e635', // lime
    '#34c759', // green
    '#00c7be', // teal
    '#5ac8fa', // sky
    '#2b6cff', // blue
    '#5e5ce6', // indigo
    '#af52de', // purple
    '#ff2d92', // pink
    '#e7e9ee', // white
    '#8e8e93', // grey
  ];

  // Append a rainbow "any colour" swatch that opens the in-app ColorPicker —
  // the escape hatch beyond the presets (the native dialog stays unusable in
  // the iCUE WebView). `getValue`/`apply` bridge to the row's local state.
  function addCustomSwatch(row, getValue, apply) {
    if (!window.ColorPicker) return null;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'deck-ed-swatch cp-open-swatch';
    b.title = t('color_custom');
    b.addEventListener('click', () => window.ColorPicker.open({
      anchor: b, value: getValue() || '#1ed760', onPick: apply,
    }));
    row.appendChild(b);
    return b;
  }

  // True when `hex` came from the picker rather than the preset row.
  const isCustomColor = (hex) => !!hex && !DECK_SWATCHES.includes(hex);

  // A reusable swatch row: optional "none" cell, the preset palette, and the
  // custom picker. get/set bridge the caller's local state. Returns {el, refresh}.
  function swatchRow(getVal, setVal, opts) {
    const row = document.createElement('div'); row.className = 'deck-ed-swatches';
    let customBtn = null;
    const refresh = () => {
      const want = getVal() || '';
      row.querySelectorAll('.deck-ed-swatch').forEach((s) => s.classList.toggle('sel', s.dataset.c === want));
      if (customBtn) customBtn.classList.toggle('sel', !!want && isCustomColor(want));
    };
    if (!opts || opts.allowNone !== false) {
      const none = document.createElement('button');
      none.type = 'button'; none.className = 'deck-ed-swatch deck-ed-swatch-none'; none.dataset.c = ''; none.innerHTML = window.DeckIcons.CLOSE_MARK; none.title = '—';
      none.addEventListener('click', () => { setVal(''); refresh(); });
      row.appendChild(none);
    }
    DECK_SWATCHES.forEach((c) => {
      const s = document.createElement('button'); s.type = 'button'; s.className = 'deck-ed-swatch';
      s.dataset.c = c; s.style.background = c; s.title = c;
      s.addEventListener('click', () => { setVal(c); refresh(); });
      row.appendChild(s);
    });
    customBtn = addCustomSwatch(row, () => getVal() || '#1ed760', (hex) => { setVal(hex); refresh(); });
    refresh();
    return { el: row, refresh };
  }

  function field(labelKey) {
    const wrap = document.createElement('label');
    wrap.className = 'deck-ed-field';
    const span = document.createElement('span');
    span.className = 'deck-ed-label';
    span.setAttribute('data-i18n', labelKey);
    span.textContent = t(labelKey);
    wrap.appendChild(span);
    return wrap;
  }

  // A field that holds buttons is a <div>, not field()'s <label>: a label
  // forwards a click on its text to its first button.
  function section(labelKey) {
    const wrap = document.createElement('div');
    wrap.className = 'deck-ed-field';
    const span = document.createElement('span');
    span.className = 'deck-ed-label';
    span.setAttribute('data-i18n', labelKey);
    span.textContent = t(labelKey);
    wrap.appendChild(span);
    return wrap;
  }

  // One on/off row: the text, then a switch. onChange(on) after each flip.
  function switchRow(labelKey, value, onChange) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'deck-ed-switchrow'; b.setAttribute('role', 'switch');
    const txt = document.createElement('span'); txt.className = 'deck-ed-switchtxt';
    txt.setAttribute('data-i18n', labelKey); txt.textContent = t(labelKey);
    const knob = document.createElement('span'); knob.className = 'deck-ed-switch'; knob.setAttribute('aria-hidden', 'true');
    b.appendChild(txt); b.appendChild(knob);
    let on = !!value;
    const paint = () => b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.addEventListener('click', () => { on = !on; paint(); if (onChange) onChange(on); });
    paint();
    return { el: b, get: () => on, set: (v) => { on = !!v; paint(); } };
  }

  // A labelled sub-row inside a section.
  function subRow(labelKey, child) {
    const w = document.createElement('div'); w.className = 'deck-ed-subfield';
    const l = document.createElement('span'); l.className = 'deck-ed-label';
    l.setAttribute('data-i18n', labelKey); l.textContent = t(labelKey);
    w.appendChild(l); w.appendChild(child);
    return w;
  }

  window.DeckEditorFormRows = {
    t, DECK_SWATCHES, addCustomSwatch, isCustomColor, swatchRow, field, section, switchRow, subRow,
  };
})();
