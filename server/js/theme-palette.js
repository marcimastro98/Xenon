'use strict';

// Semantic colour engine shared by the dashboard, per-tile overrides and the
// widget SDK. Themes provide a small set of author colours; this module derives
// every UI role and, by default, repairs unsafe foreground/background pairs.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ThemePalette = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const STOCK = Object.freeze({
    dark: Object.freeze({
      background: '#070808', surface: '#111314', surfaceAlt: '#16191a', controlColor: '#1c2021',
      text: '#f0f3f1', accent: '#1ed760',
    }),
    light: Object.freeze({
      background: '#eceff3', surface: '#ffffff', surfaceAlt: '#f4f7fa', controlColor: '#e7ecef',
      text: '#171d1b', accent: '#1a8f4b',
    }),
  });
  const STATE = Object.freeze({
    dark: Object.freeze({ success: '#45d483', warning: '#f0b84f', danger: '#ff6268', info: '#62cbea' }),
    light: Object.freeze({ success: '#147a4a', warning: '#805800', danger: '#bd303b', info: '#176783' }),
  });

  function normalizeHex(value, fallback) {
    const raw = String(value || '').trim();
    const short = raw.match(/^#?([0-9a-f]{3})$/i);
    if (short) return '#' + short[1].split('').map((ch) => ch + ch).join('').toLowerCase();
    const full = raw.match(/^#?([0-9a-f]{6})$/i);
    return full ? '#' + full[1].toLowerCase() : fallback;
  }
  function rgb(hex) {
    const h = normalizeHex(hex, '#000000').slice(1);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  function hex(values) {
    return '#' + values.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  }
  function mix(a, b, amount) {
    const aa = rgb(a), bb = rgb(b), t = Math.max(0, Math.min(1, Number(amount) || 0));
    return hex(aa.map((v, i) => v + (bb[i] - v) * t));
  }
  function channel(v) {
    const n = v / 255;
    return n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  }
  function luminance(value) {
    const c = rgb(value).map(channel);
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    const l1 = luminance(a), l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function bestText(background) {
    return contrast('#111111', background) >= contrast('#ffffff', background) ? '#111111' : '#ffffff';
  }
  function ensureContrast(foreground, background, minimum) {
    const fg = normalizeHex(foreground, bestText(background));
    const bg = normalizeHex(background, '#000000');
    const min = Math.max(1, Number(minimum) || 4.5);
    if (contrast(fg, bg) >= min) return fg;
    const target = bestText(bg);
    let lo = 0, hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (contrast(mix(fg, target, mid), bg) >= min) hi = mid;
      else lo = mid;
    }
    return mix(fg, target, hi);
  }
  function ensureBackgroundContrast(background, foreground, safeBackground, minimum) {
    const bg = normalizeHex(background, safeBackground);
    const fg = normalizeHex(foreground, bestText(bg));
    const safe = normalizeHex(safeBackground, '#000000');
    const min = Math.max(1, Number(minimum) || 4.5);
    if (contrast(fg, bg) >= min) return bg;
    if (contrast(fg, safe) < min) return bg;
    let lo = 0, hi = 1;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (contrast(fg, mix(bg, safe, mid)) >= min) hi = mid;
      else lo = mid;
    }
    return mix(bg, safe, hi);
  }
  function toneFor(surface) {
    return luminance(surface) >= 0.47 ? 'light' : 'dark';
  }
  function optional(source, key) {
    return normalizeHex(source && source[key], null);
  }

  function derive(source, hint) {
    const s = source && typeof source === 'object' ? source : {};
    const hintedTone = hint === 'light' ? 'light' : 'dark';
    const stock = STOCK[hintedTone];
    const background = normalizeHex(s.background, stock.background);
    const provisionalTone = toneFor(background);
    const surface = optional(s, 'surface') || (provisionalTone === 'light'
      ? mix(background, '#ffffff', 0.72)
      : mix(background, '#ffffff', 0.055));
    const tone = toneFor(surface);
    const stateDefaults = STATE[tone];
    const guard = s.contrastGuard !== false;
    const rawText = normalizeHex(s.text, STOCK[tone].text);
    const text = guard ? ensureContrast(rawText, surface, 7) : rawText;
    const rawSurfaceAlt = optional(s, 'surfaceAlt') || mix(surface, text, tone === 'light' ? 0.045 : 0.06);
    const surfaceAlt = guard ? ensureBackgroundContrast(rawSurfaceAlt, text, surface, 4.5) : rawSurfaceAlt;
    const rawControl = optional(s, 'controlColor') || mix(surface, text, tone === 'light' ? 0.085 : 0.11);
    const control = guard ? ensureBackgroundContrast(rawControl, text, surface, 4.5) : rawControl;
    const rawMuted = optional(s, 'mutedText') || mix(text, surface, 0.34);
    let muted = guard ? ensureContrast(rawMuted, surface, 4.5) : rawMuted;
    if (guard) muted = ensureContrast(ensureContrast(muted, surfaceAlt, 4.5), control, 4.5);
    let dim = guard ? ensureContrast(mix(text, surface, 0.49), surface, 3) : mix(text, surface, 0.49);
    if (guard) dim = ensureContrast(ensureContrast(dim, surfaceAlt, 3), control, 3);
    const rawLine = optional(s, 'lineColor') || mix(text, surface, tone === 'light' ? 0.78 : 0.76);
    const line = guard ? ensureContrast(rawLine, surface, 3) : rawLine;
    const accent = normalizeHex(s.accent, STOCK[tone].accent);
    const rawOnAccent = optional(s, 'accentText') || bestText(accent);
    const onAccent = guard ? ensureContrast(rawOnAccent, accent, 4.5) : rawOnAccent;

    const state = {};
    for (const [role, key] of [['success', 'successColor'], ['warning', 'warningColor'], ['danger', 'dangerColor'], ['info', 'infoColor']]) {
      const raw = optional(s, key) || stateDefaults[role];
      state[role] = guard ? ensureContrast(raw, surface, 4.5) : raw;
      state['on' + role[0].toUpperCase() + role.slice(1)] = bestText(state[role]);
    }

    return Object.freeze({
      tone, guard, background, surface, surfaceAlt, control, text, muted, dim, line,
      accent, onAccent,
      success: state.success, onSuccess: state.onSuccess,
      warning: state.warning, onWarning: state.onWarning,
      danger: state.danger, onDanger: state.onDanger,
      info: state.info, onInfo: state.onInfo,
    });
  }

  function cssTokens(p) {
    const values = {
      '--bg': p.background,
      '--surface': p.surface,
      '--surface-alt': p.surfaceAlt,
      '--control-bg': p.control,
      '--surface-rgb': rgb(p.surface).join(', '),
      '--surface-alt-rgb': rgb(p.surfaceAlt).join(', '),
      '--control-rgb': rgb(p.control).join(', '),
      '--panel-rgb': rgb(p.surface).join(', '),
      '--panel-soft-rgb': rgb(p.surfaceAlt).join(', '),
      '--text': p.text,
      '--muted-text': p.muted,
      '--dim-text': p.dim,
      '--text-muted': p.muted,
      '--text-dim': p.dim,
      '--line': p.line,
      '--line-rgb': rgb(p.line).join(', '),
      '--border': p.line,
      '--accent': p.accent,
      '--green': p.accent,
      '--accent-rgb': rgb(p.accent).join(', '),
      '--on-accent': p.onAccent,
      '--color-success': p.success,
      '--color-warn': p.warning,
      '--color-danger': p.danger,
      '--color-info': p.info,
      '--success-rgb': rgb(p.success).join(', '),
      '--warning-rgb': rgb(p.warning).join(', '),
      '--danger-rgb': rgb(p.danger).join(', '),
      '--info-rgb': rgb(p.info).join(', '),
      '--success-bg': `rgba(${rgb(p.success).join(', ')}, 0.14)`,
      '--warning-bg': `rgba(${rgb(p.warning).join(', ')}, 0.14)`,
      '--danger-bg': `rgba(${rgb(p.danger).join(', ')}, 0.14)`,
      '--info-bg': `rgba(${rgb(p.info).join(', ')}, 0.14)`,
      '--on-success': p.onSuccess,
      '--on-warning': p.onWarning,
      '--on-danger': p.onDanger,
      '--on-info': p.onInfo,
      '--red': p.danger,
      '--amber': p.warning,
      '--cyan': p.info,
    };
    return values;
  }

  return { STOCK, STATE, normalizeHex, rgb, mix, luminance, contrast, bestText, ensureContrast, ensureBackgroundContrast, toneFor, derive, cssTokens };
});
