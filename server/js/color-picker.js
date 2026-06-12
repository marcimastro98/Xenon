'use strict';
// color-picker.js — in-app colour picker popover. The native <input type="color">
// dialog is blocked/unreliable inside the iCUE WebView, so this is a pure-DOM
// replacement that works everywhere (and is touch-friendly for the Xeneon Edge).
//
// Usage:  ColorPicker.open({ anchor, value, onPick })
//   anchor : element the popover is positioned near (required)
//   value  : starting hex ('#rrggbb'; invalid/missing → accent green)
//   onPick : called with the new '#rrggbb' on every committed change (drag
//            release, swatch tap, valid hex entry) — debounced, never spammed
//            mid-drag, so callers may POST from it directly.
//
// One singleton popover: opening it again (or tapping outside / Escape) closes
// the previous instance. window.ColorPicker.
(function () {
  // Same spectrum-ordered presets as the Deck editor, for one-tap common picks.
  const SWATCHES = [
    '#ff3b30', '#ff6b22', '#ff9500', '#ffcc00', '#a2e635', '#34c759', '#00c7be',
    '#5ac8fa', '#2b6cff', '#5e5ce6', '#af52de', '#ff2d92', '#e7e9ee', '#8e8e93',
  ];

  // ── colour math (HSV; the SV square is the natural picker space) ──────────
  function hexToRgb(hex) {
    const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return null;
    const h = m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }
  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, max ? d / max : 0, max];
  }
  function hsvToRgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }

  // Recently picked custom colours (most recent first, max 6). Presets are
  // excluded — they're always one tap away anyway. Stored per browser.
  const RECENT_KEY = 'xeneonedge.cp.recent.v1';
  function loadRecents() {
    try {
      const arr = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(arr) ? arr.filter(c => /^#[0-9a-f]{6}$/i.test(String(c))).slice(0, 6) : [];
    } catch { return []; }
  }
  function saveRecent(hex) {
    if (SWATCHES.includes(hex)) return;
    try {
      const next = [hex, ...loadRecents().filter(c => c.toLowerCase() !== hex.toLowerCase())].slice(0, 6);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch { /* storage blocked/full — recents are a nicety, not a feature */ }
  }

  let pop = null;          // the open popover element, or null
  let cleanupFns = [];     // listeners to detach on close

  function close() {
    if (!pop) return;
    cleanupFns.forEach(fn => { try { fn(); } catch { /* ignore */ } });
    cleanupFns = [];
    pop.remove();
    pop = null;
  }

  function open(opts) {
    const o = opts || {};
    const anchor = o.anchor;
    if (!anchor || typeof o.onPick !== 'function') return;
    close();

    let [h, s, v] = rgbToHsv(...(hexToRgb(o.value) || hexToRgb('#1ed760')));
    let committed = rgbToHex(...hsvToRgb(h, s, v));

    pop = document.createElement('div');
    pop.className = 'cp-pop';
    pop.innerHTML =
      '<div class="cp-sv"><div class="cp-sv-white"></div><div class="cp-sv-black"></div><div class="cp-knob cp-sv-knob"></div></div>' +
      '<div class="cp-hue"><div class="cp-knob cp-hue-knob"></div></div>' +
      '<div class="cp-row">' +
        '<span class="cp-preview"></span>' +
        '<input class="cp-hex" type="text" maxlength="7" spellcheck="false" autocomplete="off">' +
      '</div>' +
      '<div class="cp-swatches"></div>';
    document.body.appendChild(pop);

    const sv = pop.querySelector('.cp-sv');
    const svKnob = pop.querySelector('.cp-sv-knob');
    const hue = pop.querySelector('.cp-hue');
    const hueKnob = pop.querySelector('.cp-hue-knob');
    const preview = pop.querySelector('.cp-preview');
    const hexInput = pop.querySelector('.cp-hex');
    const swatchRow = pop.querySelector('.cp-swatches');

    const addSwatch = (row, c) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'cp-swatch'; b.style.background = c; b.title = c;
      b.addEventListener('click', () => { [h, s, v] = rgbToHsv(...hexToRgb(c)); paint(); commit(); });
      row.appendChild(b);
    };
    SWATCHES.forEach(c => addSwatch(swatchRow, c));
    // Recently picked custom colours, below the presets (only when there are any).
    const recents = loadRecents();
    if (recents.length) {
      const recentRow = document.createElement('div');
      recentRow.className = 'cp-swatches cp-recents';
      recents.forEach(c => addSwatch(recentRow, c));
      pop.appendChild(recentRow);
    }

    // Position near the anchor, clamped to the viewport (fixed positioning so it
    // escapes any overflow:hidden ancestor, e.g. the settings modal body).
    const r = anchor.getBoundingClientRect();
    pop.style.visibility = 'hidden';
    requestAnimationFrame(() => {
      const pw = pop.offsetWidth, ph = pop.offsetHeight, pad = 8;
      let left = Math.min(Math.max(pad, r.left), window.innerWidth - pw - pad);
      let top = r.bottom + 6;
      if (top + ph > window.innerHeight - pad) top = Math.max(pad, r.top - ph - 6);
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
      pop.style.visibility = '';
    });

    function paint() {
      const hex = rgbToHex(...hsvToRgb(h, s, v));
      sv.style.background = 'hsl(' + Math.round(h) + ', 100%, 50%)';
      svKnob.style.left = (s * 100) + '%';
      svKnob.style.top = ((1 - v) * 100) + '%';
      svKnob.style.background = hex;
      hueKnob.style.left = (h / 360 * 100) + '%';
      hueKnob.style.background = 'hsl(' + Math.round(h) + ', 100%, 50%)';
      preview.style.background = hex;
      if (document.activeElement !== hexInput) hexInput.value = hex.toUpperCase();
      hexInput.classList.remove('invalid');
    }

    function commit() {
      const hex = rgbToHex(...hsvToRgb(h, s, v));
      if (hex === committed) return;
      committed = hex;
      saveRecent(hex);
      try { o.onPick(hex); } catch { /* caller's problem */ }
      // Auto-close after every committed pick so the caller's form never gets a
      // stray click on the "no colour" swatch when the user dismisses the popover.
      close();
    }

    // Shared drag handler: pointer capture so the drag survives leaving the box.
    function drag(el, onMove) {
      const move = (ev) => {
        const b = el.getBoundingClientRect();
        onMove(
          Math.max(0, Math.min(1, (ev.clientX - b.left) / b.width)),
          Math.max(0, Math.min(1, (ev.clientY - b.top) / b.height))
        );
        paint();
      };
      el.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        el.setPointerCapture(ev.pointerId);
        move(ev);
        const onUp = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', onUp);
          el.removeEventListener('pointercancel', onUp);
          commit(); // fire once per gesture, not per move tick
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
      });
    }
    drag(sv, (x, y) => { s = x; v = 1 - y; });
    drag(hue, (x) => { h = Math.min(359.9, x * 360); });

    hexInput.addEventListener('change', () => {
      let val = hexInput.value.trim();
      if (/^[0-9a-f]{6}$/i.test(val)) val = '#' + val;
      const rgb = hexToRgb(val);
      if (!rgb) { hexInput.classList.add('invalid'); return; }
      [h, s, v] = rgbToHsv(...rgb);
      paint(); commit();
    });

    // Close on outside tap / Escape. Deferred so the opening tap doesn't
    // immediately re-close it.
    const onDocDown = (ev) => { if (pop && !pop.contains(ev.target) && ev.target !== anchor && !anchor.contains(ev.target)) close(); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    setTimeout(() => {
      if (!pop) return;
      document.addEventListener('pointerdown', onDocDown, true);
      document.addEventListener('keydown', onKey);
      cleanupFns.push(() => document.removeEventListener('pointerdown', onDocDown, true));
      cleanupFns.push(() => document.removeEventListener('keydown', onKey));
    }, 0);

    paint();
  }

  if (typeof window !== 'undefined') window.ColorPicker = { open, close };
  // Node (unit tests): expose the DOM-free colour math.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb };
  }
})();
