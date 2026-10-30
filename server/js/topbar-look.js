'use strict';

// The top bar's LOOK (Settings → Top bar), as opposed to its CONTENT, which is
// topbarClock (what the island shows, which buttons, on which side). One owner
// for the rules: the dashboard (window.TopbarLook), the server's settings
// normalizer (require) and the tests all read this file, so a value accepted in
// one place can never be dropped by the other on the next save.
//
// Every default reproduces the bar as it was before this setting existed, and
// apply() writes nothing for a default value: an existing user sees no change,
// and the CSS for each choice lives behind its own :root[data-tb-*] attribute.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TopbarLook = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const CHOICES = Object.freeze({
    surface: ['theme', 'solid', 'glass', 'clear'],
    border: ['theme', 'none', 'accent'],
    shape: ['rounded', 'square', 'pill'],
    size: ['compact', 'normal', 'large'],
    buttonStyle: ['plate', 'ghost'],
    labels: ['auto', 'always', 'never'],
    clockFont: ['theme', 'mono', 'light'],
    separator: ['line', 'dot', 'none'],
    gap: ['tight', 'normal', 'wide'],
    // 'auto' is the behaviour from before: the toast grows out of the Minimal
    // capsule, and drops in at the top centre everywhere else.
    toastPlace: ['auto', 'top', 'top-left', 'top-right', 'bottom-left', 'bottom-right'],
    // The two edge rails of Minimal and None. A rail switched off still shows
    // while it holds Settings or Layout (a CSS guard in TopbarLook.css), so no
    // look can leave the dashboard without its way back in.
    railLeft: ['show', 'off'],
    railRight: ['show', 'off'],
    railAlign: ['center', 'top', 'bottom'],
    railMotion: ['slide', 'fade', 'instant'],
    // What stays on screen once a rail has hidden itself: the handle, or nothing
    // (a touch on the screen edge always brings it back).
    railPeek: ['handle', 'edge'],
  });
  // The buttons a rail can never be taken away from.
  const RAIL_KEEPERS = Object.freeze(['settings', 'layout']);

  // The buttons a user can restyle one by one. The favourites strip and the
  // widget slot are containers, not buttons, so they take the bar's look only.
  // Selectors match ACTION_SELECTORS in js/topbar-minimal.js (pinned by a test).
  const BUTTON_SELECTORS = Object.freeze({
    lock: '.qbtn-lock',
    ambient: '#ambient-topbtn',
    xenon: '.topbtn-xenon',
    search: '.qbtn-search',
    mail: '#bit-mail-btn',
    layout: '#layout-edit-toggle',
    settings: '.qbtn-settings',
    apps: '.qbtn-apps',
  });
  const BUTTON_IDS = Object.freeze(Object.keys(BUTTON_SELECTORS));
  // A widget's own bar button (manifest "topbarButton"), keyed by package id.
  const SDK_BUTTON_RE = /^sdk:[a-z0-9][a-z0-9-]{1,40}$/;
  // A Deck icon id (js/deck-icons.js). Only the id is stored, never markup; the
  // renderer looks it up in the fixed library and ignores an unknown one.
  const ICON_RE = /^[a-zA-Z][a-zA-Z0-9]{0,31}$/;
  const LABEL_MAX = 24;
  const MAX_BUTTONS = 32;
  const LABEL_MODES = ['auto', 'always', 'never'];

  const DEFAULTS = Object.freeze({
    version: 1,
    surface: 'theme',
    color: '',        // '' = the theme's own surface colour
    opacity: 70,      // %, for solid and glass
    blur: 10,         // px, for glass
    border: 'theme',
    shape: 'rounded',
    shadow: true,
    size: 'normal',
    buttonStyle: 'plate',
    labels: 'auto',
    accent: 'xenon',  // the button drawn in the accent colour, or 'none'
    clockFont: 'theme',
    colonBlink: true,
    separator: 'line',
    gap: 'normal',
    toastPlace: 'auto',
    railLeft: 'show',
    railRight: 'show',
    railAlign: 'center',
    railMotion: 'slide',
    railPeek: 'handle',
    railDelay: 10,    // seconds before an untouched rail hides itself
    buttons: Object.freeze({}),
  });

  function pick(list, value, fallback) {
    return list.includes(value) ? value : fallback;
  }

  function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  }

  // '#abc' / '#AABBCC' → '#aabbcc'; anything else → ''.
  function normalizeHex(value) {
    if (typeof value !== 'string') return '';
    const s = value.trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return '';
  }

  // Plain text only (it is rendered with textContent): control characters out,
  // whitespace collapsed, capped by characters rather than UTF-16 units so an
  // accented or CJK label is not cut in half.
  function normalizeLabel(value) {
    if (typeof value !== 'string') return '';
    const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
    return Array.from(clean).slice(0, LABEL_MAX).join('').trim();
  }

  function isButtonId(id) {
    return BUTTON_IDS.includes(id) || (typeof id === 'string' && SDK_BUTTON_RE.test(id));
  }

  // One button's overrides, or null when nothing differs from the default (so
  // an untouched button costs nothing in the settings file).
  function normalizeButton(raw) {
    const v = raw && typeof raw === 'object' ? raw : {};
    const out = {
      icon: typeof v.icon === 'string' && ICON_RE.test(v.icon) ? v.icon : '',
      label: normalizeLabel(v.label),
      labelMode: pick(LABEL_MODES, v.labelMode, 'auto'),
      color: normalizeHex(v.color),
      bg: normalizeHex(v.bg),
    };
    const touched = out.icon || out.label || out.labelMode !== 'auto' || out.color || out.bg;
    return touched ? out : null;
  }

  function normalizeButtons(value) {
    const out = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
    let n = 0;
    for (const id of Object.keys(value)) {
      if (n >= MAX_BUTTONS) break;
      if (!isButtonId(id)) continue;
      const b = normalizeButton(value[id]);
      if (!b) continue;
      out[id] = b;
      n++;
    }
    return out;
  }

  // The ready-made looks on Settings → Top bar. A preset owns the bar-wide keys
  // below and nothing else: picking one keeps the accent button, the clock, where
  // notifications go and every button's own options.
  const PRESET_KEYS = ['surface', 'color', 'opacity', 'blur', 'border', 'shape', 'shadow', 'size', 'buttonStyle', 'labels', 'separator', 'gap'];
  const PRESETS = Object.freeze({
    theme: Object.freeze({}),
    glass: Object.freeze({ surface: 'glass', opacity: 45, blur: 18 }),
    solid: Object.freeze({ surface: 'solid', opacity: 100, border: 'none', shadow: false }),
    floating: Object.freeze({ surface: 'glass', opacity: 60, blur: 14, border: 'none', shape: 'pill', gap: 'wide' }),
    line: Object.freeze({ surface: 'clear', buttonStyle: 'ghost', separator: 'dot' }),
    compact: Object.freeze({ size: 'compact', gap: 'tight', labels: 'never' }),
  });
  const PRESET_IDS = Object.freeze(Object.keys(PRESETS));

  // The part of the look a theme carries (saved themes, theme codes, the theme
  // of a bundle): the bar-wide style and the clock face. Never the user's own
  // buttons, which one is highlighted, the side rails or where notifications go.
  const THEME_KEYS = Object.freeze([...PRESET_KEYS, 'clockFont', 'colonBlink']);

  // That part of `value`, or null when it is the default bar: a theme made on a
  // bar nobody changed leaves the bar of whoever applies it alone.
  function themePart(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const look = normalize(value);
    if (THEME_KEYS.every((key) => look[key] === DEFAULTS[key])) return null;
    const part = {};
    for (const key of THEME_KEYS) part[key] = look[key];
    return part;
  }

  // `look` with a theme's part laid over it; everything else is kept.
  function withThemePart(value, part) {
    const look = normalize(value);
    if (!part || typeof part !== 'object' || Array.isArray(part)) return look;
    const p = normalize(part);
    for (const key of THEME_KEYS) look[key] = p[key];
    return look;
  }

  // `look` with preset `id` laid over the defaults of the keys a preset owns.
  function withPreset(value, id) {
    const look = normalize(value);
    const preset = PRESETS[id];
    if (!preset) return look;
    for (const key of PRESET_KEYS) look[key] = key in preset ? preset[key] : DEFAULTS[key];
    return normalize(look);
  }

  // The preset `look` matches exactly, or '' once the user has changed any of
  // its keys by hand.
  function presetOf(value) {
    const look = normalize(value);
    for (const id of PRESET_IDS) {
      const ref = withPreset(look, id);
      if (PRESET_KEYS.every((key) => ref[key] === look[key])) return id;
    }
    return '';
  }

  // Known keys only, every value coerced; never spreads its input.
  function normalize(value) {
    const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const d = DEFAULTS;
    const out = { version: 1 };
    for (const key of Object.keys(CHOICES)) out[key] = pick(CHOICES[key], v[key], d[key]);
    out.color = normalizeHex(v.color);
    out.opacity = clampInt(v.opacity, 20, 100, d.opacity);
    out.blur = clampInt(v.blur, 0, 30, d.blur);
    out.railDelay = clampInt(v.railDelay, 3, 60, d.railDelay);
    out.shadow = v.shadow !== false;
    out.colonBlink = v.colonBlink !== false;
    out.accent = v.accent === 'none' || BUTTON_IDS.includes(v.accent) ? v.accent : d.accent;
    out.buttons = normalizeButtons(v.buttons);
    return out;
  }

  // The look as attributes and custom properties for :root. A default value is
  // `null`, which apply() turns into "remove": the stylesheet then draws the bar
  // exactly as it did before, with no rule of this setting involved.
  function tokens(value) {
    const look = normalize(value);
    const attrs = {};
    for (const key of Object.keys(CHOICES)) attrs[key] = look[key] === DEFAULTS[key] ? null : look[key];
    attrs.shadow = look.shadow ? null : 'none';
    attrs.colonBlink = look.colonBlink ? null : 'off';
    attrs.accent = look.accent === DEFAULTS.accent ? null : look.accent;
    const tinted = look.surface === 'solid' || look.surface === 'glass';
    const vars = {
      '--tb-color': tinted && look.color ? hexToTriplet(look.color) : null,
      '--tb-alpha': tinted ? (look.opacity / 100).toFixed(2) : null,
      '--tb-blur': look.surface === 'glass' ? look.blur + 'px' : null,
    };
    return { attrs, vars };
  }

  function hexToTriplet(hex) {
    const n = parseInt(hex.slice(1), 16);
    return ((n >> 16) & 255) + ', ' + ((n >> 8) & 255) + ', ' + (n & 255);
  }

  // data-tb-<kebab> attribute name for a look key.
  function attrName(key) {
    return 'data-tb-' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  }

  // ── Browser side ──────────────────────────────────────────────────────────

  // The visible label of a bar button: its first plain <span> (the update dot
  // and the Store dot carry classes and are left alone).
  function labelSpan(el) {
    for (const child of el.children) {
      if (child.tagName === 'SPAN' && !child.className) return child;
    }
    return null;
  }

  function applyLabel(el, text) {
    const span = labelSpan(el);
    if (!span) return;
    if (text) {
      // Keep the translation key aside so a reset gets the translated word back,
      // and drop it so a language change does not overwrite the user's label.
      if (!span.hasAttribute('data-tb-key')) {
        span.setAttribute('data-tb-key', span.getAttribute('data-i18n') || '');
        span.setAttribute('data-tb-text', span.textContent);
      }
      span.removeAttribute('data-i18n');
      span.textContent = text;
      return;
    }
    if (!span.hasAttribute('data-tb-key')) return;
    const key = span.getAttribute('data-tb-key');
    const text0 = span.getAttribute('data-tb-text') || '';
    if (key) span.setAttribute('data-i18n', key);
    span.textContent = key && typeof window.t === 'function' ? window.t(key) : text0;
    span.removeAttribute('data-tb-key');
    span.removeAttribute('data-tb-text');
  }

  function applyIcon(el, icon) {
    const own = el.querySelector(':scope > svg:not(.tb-icon)');
    const prev = el.querySelector(':scope > svg.tb-icon');
    const lib = typeof window.DeckIcons === 'object' && window.DeckIcons;
    const wanted = icon && lib && lib.has(icon) ? icon : '';
    if (prev && prev.getAttribute('data-icon') === wanted) return;
    if (prev) prev.remove();
    // A class, not `hidden`: the hidden property does nothing on an SVG element.
    if (own) own.classList.toggle('tb-icon-off', !!wanted);
    if (!wanted) return;
    const svg = lib.el(wanted);
    svg.classList.add('tb-icon');
    svg.setAttribute('data-icon', wanted);
    el.insertBefore(svg, el.firstChild);
  }

  function applyButton(el, b) {
    const o = b || { icon: '', label: '', labelMode: 'auto', color: '', bg: '' };
    if (o.color) el.style.setProperty('--tb-btn-fg', o.color); else el.style.removeProperty('--tb-btn-fg');
    if (o.bg) el.style.setProperty('--tb-btn-bg', o.bg); else el.style.removeProperty('--tb-btn-bg');
    el.classList.toggle('tb-btn-fg', !!o.color);
    el.classList.toggle('tb-btn-bg', !!o.bg);
    el.classList.toggle('tb-label-always', o.labelMode === 'always');
    el.classList.toggle('tb-label-never', o.labelMode === 'never');
    applyLabel(el, o.label);
    applyIcon(el, o.icon);
  }

  // The element of a button id: a built-in one by its selector, a widget's by
  // its data-tb-id (set where the widget button is created).
  function buttonEl(doc, id) {
    if (BUTTON_SELECTORS[id]) return doc.querySelector(BUTTON_SELECTORS[id]);
    return SDK_BUTTON_RE.test(id) ? doc.querySelector('[data-tb-id="' + id + '"]') : null;
  }

  function apply(value, doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.documentElement) return;
    const rootEl = d.documentElement;
    const look = normalize(value);
    const { attrs, vars } = tokens(look);
    const toastBefore = rootEl.getAttribute(attrName('toastPlace'));
    for (const key of Object.keys(attrs)) {
      if (attrs[key] === null) rootEl.removeAttribute(attrName(key));
      else rootEl.setAttribute(attrName(key), attrs[key]);
    }
    for (const name of Object.keys(vars)) {
      if (vars[name] === null) rootEl.style.removeProperty(name);
      else rootEl.style.setProperty(name, vars[name]);
    }
    for (const id of BUTTON_IDS) {
      const el = buttonEl(d, id);
      if (!el) continue;
      el.classList.toggle('tb-accent', look.accent === id && id !== DEFAULTS.accent);
      applyButton(el, look.buttons[id]);
    }
    for (const el of d.querySelectorAll('[data-tb-id]')) {
      applyButton(el, look.buttons[el.getAttribute('data-tb-id')]);
    }
    // The capsule's size and corners shape the cutout in the tile beneath it,
    // which is measured, not derived: measure again.
    const minimal = typeof window !== 'undefined' && window.TopbarMinimal;
    if (minimal && typeof minimal.reflowIsland === 'function') minimal.reflowIsland();
    // A toast already on screen moves out of (or back into) the capsule at once.
    const toast = typeof window !== 'undefined' && window.XenonToast;
    if (toastBefore !== attrs.toastPlace && toast && typeof toast.refresh === 'function') toast.refresh();
  }

  return {
    CHOICES, DEFAULTS, BUTTON_IDS, BUTTON_SELECTORS, LABEL_MAX, MAX_BUTTONS, RAIL_KEEPERS,
    PRESETS, PRESET_IDS, PRESET_KEYS, withPreset, presetOf, THEME_KEYS, themePart, withThemePart,
    normalize, normalizeButton, normalizeHex, normalizeLabel, isButtonId,
    tokens, attrName, apply, buttonEl,
  };
});
