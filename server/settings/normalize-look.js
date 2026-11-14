// What stored settings are turned into before they are saved or sent, first part: colours,
// style, glass, clock size, the font and the lock screen's widgets.

const { clampNumber, normalizeHex } = require('./values.js');
const { SETTINGS_MIN_PANEL_ALPHA } = require('../look/background-values.js');
const { sanitizeSettingsUiFont } = require('../look/font-setting.js');
const themePalette = require('../js/theme-palette.js');
const { sanitizeSettingsBackgroundMedia } = require('../look/background-media.js');
const { DEFAULT_HUB_SETTINGS } = require('./defaults.js');
const { normalizeLockWidgets } = require('./normalize-lock-widgets.js');

function normalizeHubLook(source) {
  return {
    appearance: ['light', 'dark', 'auto'].includes(source.appearance) ? source.appearance : DEFAULT_HUB_SETTINGS.appearance,
    autoPalette: source.autoPalette === true || (source.autoPalette == null && source.appearance === 'auto'),
    styleMode: ['liquid', 'glass', 'retro', 'comic'].includes(source.styleMode) ? source.styleMode : 'glass',
    retroScanlines: source.retroScanlines !== false,
    accent: normalizeHex(source.accent, DEFAULT_HUB_SETTINGS.accent),
    // Album-art accent toggle. Must be round-tripped here (mirrors the client's
    // normalizeSettings): without it the known-key rebuild strips a saved `false`,
    // so the feature re-enabled itself on every restart. Default ON via !== false.
    dynamicAlbumTheme: source.dynamicAlbumTheme !== false,
    background: normalizeHex(source.background, DEFAULT_HUB_SETTINGS.background),
    surface: normalizeHex(source.surface, null),
    surfaceAlt: normalizeHex(source.surfaceAlt, null),
    controlColor: normalizeHex(source.controlColor, null),
    text: normalizeHex(source.text, DEFAULT_HUB_SETTINGS.text),
    accentText: normalizeHex(source.accentText, null),
    successColor: normalizeHex(source.successColor, null),
    warningColor: normalizeHex(source.warningColor, null),
    dangerColor: normalizeHex(source.dangerColor, null),
    infoColor: normalizeHex(source.infoColor, null),
    // Dual-palette theme ({ light, dark }). Both sides persist the field, so both
    // rebuild it through the same engine — otherwise a restart, another surface or
    // a backup restore would strip or corrupt the pair.
    paletteVariants: themePalette.normalizeVariants(source.paletteVariants),
    contrastGuard: source.contrastGuard !== false,
    panelAlpha: clampNumber(source.panelAlpha, SETTINGS_MIN_PANEL_ALPHA, 1, DEFAULT_HUB_SETTINGS.panelAlpha),
    bgDim: clampNumber(source.bgDim, 0.05, 0.9, DEFAULT_HUB_SETTINGS.bgDim),
    bgBlur: clampNumber(source.bgBlur, 0, 24, DEFAULT_HUB_SETTINGS.bgBlur),
    idleAnimationPause: source.idleAnimationPause !== false,
    bootSplash: source.bootSplash !== false,
    hybridGpuAnimationPause: source.hybridGpuAnimationPause !== false,
    uiRoundness: clampNumber(source.uiRoundness, 0, 2, DEFAULT_HUB_SETTINGS.uiRoundness),
    glassBlur: clampNumber(source.glassBlur, 0, 40, DEFAULT_HUB_SETTINGS.glassBlur),
    glassSaturate: clampNumber(source.glassSaturate, 100, 220, DEFAULT_HUB_SETTINGS.glassSaturate),
    clockScale: clampNumber(source.clockScale, 0.8, 2, DEFAULT_HUB_SETTINGS.clockScale),
    clockDateScale: clampNumber(source.clockDateScale, 0.8, 2, DEFAULT_HUB_SETTINGS.clockDateScale),
    clockDateFormat: ['full', 'medium', 'short'].includes(source.clockDateFormat) ? source.clockDateFormat : 'full',
    panelBorderStrength: clampNumber(source.panelBorderStrength, 0, 2, DEFAULT_HUB_SETTINGS.panelBorderStrength),
    tileShadowStrength: clampNumber(source.tileShadowStrength, 0, 2, DEFAULT_HUB_SETTINGS.tileShadowStrength),
    mutedText: normalizeHex(source.mutedText, null),
    lineColor: normalizeHex(source.lineColor, null),
    backgroundMedia: sanitizeSettingsBackgroundMedia(source.backgroundMedia),
    uiFont: sanitizeSettingsUiFont(source.uiFont),
    lockWidgets: normalizeLockWidgets(source.lockWidgets),
  };
}

module.exports = { normalizeHubLook };
