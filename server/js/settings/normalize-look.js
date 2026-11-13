// Cleans the saved values that decide the look: colors, background picture or video, font,
// background effects, slideshow and saved themes.
'use strict';

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeHex(value, fallback) {
  const raw = String(value || '').trim();
  const short = raw.match(/^#?([0-9a-f]{3})$/i);
  if (short) {
    return '#' + short[1].split('').map(ch => ch + ch).join('').toLowerCase();
  }
  const full = raw.match(/^#?([0-9a-f]{6})$/i);
  return full ? '#' + full[1].toLowerCase() : fallback;
}

function hexToRgb(hex) {
  const safe = normalizeHex(hex, DEFAULT_HUB_SETTINGS.accent).slice(1);
  return [0, 2, 4].map(index => parseInt(safe.slice(index, index + 2), 16));
}

function sanitizeBackgroundMedia(value) {
  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || '').trim();
  const name = String(value.name || '').trim().slice(0, 120);
  const type = String(value.type || '').trim().slice(0, 60);
  const version = String(value.version || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  // A pasted SVG wallpaper lives inline as a base64 data: URI. It is only ever
  // rendered as an <img> source (secure static mode — no scripts/fetches), so it
  // is safe; bounded so it can't bloat the settings blob.
  let out;
  if (url.startsWith('data:')) {
    if (url.length > BG_SVG_MAX_CHARS || !BG_SVG_DATA_RE.test(url)) return null;
    out = { url, name: name || 'svg', type: 'image/svg+xml', version };
  } else {
    if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return null;
    if (!/^(image|video)\//.test(type)) return null;
    out = { url, name: name || url.split('/').pop(), type, version };
  }
  // Redistribution marker, as on bgCustom: a wallpaper that came in a package is
  // someone else's picture, so it is never offered back in an export.
  if (value.imported === true) out.imported = true;
  if (out.imported && typeof ContentInstalls !== 'undefined'
      && ContentInstalls.INSTALL_ID_RE.test(String(value.installId || ''))) {
    out.installId = String(value.installId);
  }
  return out;
}

// Custom UI font reference — mirrors sanitizeBackgroundMedia (server-side twin:
// sanitizeSettingsUiFont). Only a server-generated /uploads/ path with a known
// font extension survives; anything else resets to the default typeface.
function sanitizeUiFont(value) {
  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || '').trim();
  const name = String(value.name || '').trim().slice(0, 120);
  const version = String(value.version || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return null;
  const ext = url.slice(url.lastIndexOf('.') + 1).toLowerCase();
  if (!SETTINGS_FONT_EXTENSIONS.has(ext)) return null;
  return { url, name: name || url.split('/').pop(), version };
}

function normalizeBgAurora(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.bgAurora;
  return {
    enabled: source.enabled == null ? defaults.enabled : source.enabled !== false,
    intensity: clampNumber(source.intensity, 0, 100, defaults.intensity),
    speed: clampNumber(source.speed, 0, 100, defaults.speed),
  };
}

function normalizeBgGrid(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.bgGrid;
  return {
    enabled: source.enabled == null ? defaults.enabled : source.enabled !== false,
    color: normalizeHex(source.color, defaults.color),
    intensity: clampNumber(source.intensity, 0, 100, defaults.intensity),
    speed: clampNumber(source.speed, 0, 100, defaults.speed),
  };
}

function normalizeBgStatic(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.bgStatic;
  return {
    style: BG_STATIC_STYLES.includes(source.style) ? source.style : defaults.style,
    intensity: clampNumber(source.intensity, 0, 100, defaults.intensity),
  };
}

// Bundled image assets ({name → data:image URI}) the draw() code can paint via
// drawImage. Embedded — never fetched — so a background stays self-contained and
// the sandbox CSP (connect-src 'none') is untouched. The rules live in ONE
// place: CustomBg.sanitizeBgAssets (js/custom-bg.js, loaded before this file;
// the server require()s the same module), so client, server and sandbox can
// never drift. Fail-closed: without CustomBg no asset survives normalization.
function normalizeBgAssets(value) {
  return (window.CustomBg && CustomBg.sanitizeBgAssets) ? CustomBg.sanitizeBgAssets(value) : {};
}
function normalizeBgCustom(value) {
  const source = value && typeof value === 'object' ? value : {};
  const code = typeof source.code === 'string' ? source.code.slice(0, BG_CUSTOM_CODE_MAX) : '';
  const out = {
    // No code → can't be "enabled" (nothing to render).
    enabled: !!source.enabled && !!code,
    name: typeof source.name === 'string' ? source.name.trim().slice(0, 60) : '',
    code,
    assets: normalizeBgAssets(source.assets),
    // Frame-rate cap (paints per second). Rule owner is CustomBg.sanitizeBgFps
    // (same single-owner shape as the assets above); fail-closed to the default.
    fps: (window.CustomBg && CustomBg.sanitizeBgFps) ? CustomBg.sanitizeBgFps(source.fps) : 30,
  };
  // Redistribution marker: set when the background arrived via a share code
  // (someone else's work → not re-exportable); cleared when the user replaces
  // the code with their own from the editor/presets.
  if (source.imported === true && code) out.imported = true;
  if (out.imported && typeof ContentInstalls !== 'undefined'
      && ContentInstalls.INSTALL_ID_RE.test(String(source.installId || ''))) {
    out.installId = String(source.installId);
  }
  return out;
}

// Slideshow config. The rules (MIME allowlist, per-image + total + count caps,
// interval clamp, fit mode) live in ONE place — SlideshowWidget.sanitizeSlideshow
// (js/slideshow-widget.js, loaded before this file; the server require()s the same
// module) — so client, server and normalizer never drift. Fail-closed: without the
// module nothing survives, matching normalizeBgAssets above.
function normalizeSlideshow(value) {
  return (window.SlideshowWidget && SlideshowWidget.sanitizeSlideshow)
    ? SlideshowWidget.sanitizeSlideshow(value)
    : { images: [], intervalMs: 6000, fit: 'cover' };
}

// Rebuild the imported-themes list from untrusted input (localStorage, server
// hydration, or a freshly imported preset): known keys only, every value coerced
// through the same helpers the live settings use, so a crafted theme can't slip
// an unclamped number or a non-hex colour into the store. Bounded to keep the
// gallery (and the synced settings blob) from growing without limit.
function normalizeCustomThemes(list) {
  if (!Array.isArray(list)) return [];
  const D = DEFAULT_HUB_SETTINGS;
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    // A full visual snapshot, every field coerced with the same helpers the live
    // settings use and keyed identically (styleMode, not skin) so applyThemeById
    // can hand it straight to normalizeSettings. Defaults fill any missing field,
    // so all cards carry the complete THEME_SETTING_KEYS set and compare cleanly.
    // The backdrop is the exception: a card that says nothing of it is older than the
    // new look, and the promise is that an old look stays as it was.
    const theme = {
      id: String(raw.id || '').trim().slice(0, 40)
        || ('ct_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      name: String(raw.name || '').trim().slice(0, 40),
      appearance: ['light', 'dark', 'auto'].includes(raw.appearance) ? raw.appearance : D.appearance,
      autoPalette: raw.autoPalette === true || (raw.autoPalette == null && raw.appearance === 'auto'),
      styleMode: normStyleMode(raw.styleMode),
      retroScanlines: raw.retroScanlines !== false,
      accent: normalizeHex(raw.accent, D.accent),
      background: normalizeHex(raw.background, D.background),
      surface: normalizeHex(raw.surface, null),
      surfaceAlt: normalizeHex(raw.surfaceAlt, null),
      controlColor: normalizeHex(raw.controlColor, null),
      text: normalizeHex(raw.text, D.text),
      accentText: normalizeHex(raw.accentText, null),
      successColor: normalizeHex(raw.successColor, null),
      warningColor: normalizeHex(raw.warningColor, null),
      dangerColor: normalizeHex(raw.dangerColor, null),
      infoColor: normalizeHex(raw.infoColor, null),
      paletteVariants: normalizePaletteVariants(raw.paletteVariants),
      contrastGuard: raw.contrastGuard !== false,
      dynamicAlbumTheme: raw.dynamicAlbumTheme !== false,
      panelAlpha: clampNumber(raw.panelAlpha, SETTINGS_MIN_PANEL_ALPHA, 1, CLASSIC_BACKDROP.panelAlpha),
      panelBorderStrength: clampNumber(raw.panelBorderStrength, 0, 2, D.panelBorderStrength),
      tileShadowStrength: clampNumber(raw.tileShadowStrength, 0, 2, D.tileShadowStrength),
      uiRoundness: clampNumber(raw.uiRoundness, 0, 2, D.uiRoundness),
      glassBlur: clampNumber(raw.glassBlur, 0, 40, D.glassBlur),
      glassSaturate: clampNumber(raw.glassSaturate, 100, 220, D.glassSaturate),
      mutedText: normalizeHex(raw.mutedText, null),
      lineColor: normalizeHex(raw.lineColor, null),
      bgDim: clampNumber(raw.bgDim, 0.05, 0.9, D.bgDim),
      bgBlur: clampNumber(raw.bgBlur, 0, 24, D.bgBlur),
      bgAurora: normalizeBgAurora(raw.bgAurora ?? CLASSIC_BACKDROP.bgAurora),
      bgGrid: normalizeBgGrid(raw.bgGrid ?? CLASSIC_BACKDROP.bgGrid),
      bgStatic: normalizeBgStatic(raw.bgStatic ?? CLASSIC_BACKDROP.bgStatic),
      bgCustom: normalizeBgCustom(raw.bgCustom),
      uiFont: sanitizeUiFont(raw.uiFont),
    };
    // Redistribution marker: themes that arrived via a share code are someone
    // else's work — export blocks re-sharing them (see exportTheme guard).
    // The bar's style, when the theme was made on a changed bar (TopbarLook
    // .themePart: never the user's buttons, rails or notification place).
    const bar = TopbarLook.themePart(raw.topbarLook);
    if (bar) theme.topbarLook = bar;
    if (raw.imported === true) theme.imported = true;
    if (theme.imported && typeof ContentInstalls !== 'undefined'
        && ContentInstalls.INSTALL_ID_RE.test(String(raw.installId || ''))) {
      theme.installId = String(raw.installId);
    }
    out.push(theme);
    if (out.length >= 24) break;
  }
  return out;
}

// Dual-palette themes ({ light, dark }). ThemePalette owns the rules so client
// and server can't drift; theme-palette.js loads before this module. A function
// declaration (not a const): loadHubSettings() normalizes at module load, far
// above this line, and a const would still be in the temporal dead zone there.
function normalizePaletteVariants(value) {
  return ThemePalette.normalizeVariants(value);
}
