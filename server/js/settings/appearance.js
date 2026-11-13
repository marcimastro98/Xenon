// Light or dark, the style mode and the accent color, including the accent taken from the album
// cover.
'use strict';

// ── Appearance (light / dark / auto) ──────────────────────────────
// Mode buttons seed an accessible stock palette. After that every colour is a
// normal editable theme field: no mode-specific constant is allowed to override
// what the user or an imported theme selected.
const APPEARANCE_COLOR_KEYS = Object.freeze([
  'background', 'surface', 'surfaceAlt', 'controlColor', 'text',
  'mutedText', 'lineColor', 'accentText',
  'successColor', 'warningColor', 'dangerColor', 'infoColor',
]);

// The OS colour scheme, read server-side from the OS itself (server/os-theme.js:
// the Windows registry, macOS `defaults`, GNOME `gsettings`) rather than from the
// WebView's unreliable prefers-color-scheme. Cached in localStorage so a reload
// starts on the correct scheme immediately, instead of flashing the dashboard
// white on 'auto' until the first /system/theme fetch landed (up to 30s).
// `null` means no platform reading — only then does the media query decide.
const OS_THEME_KEY = 'xeneonedge.osDark.v1';

function resolveAppearance(mode) {
  if (mode === 'light' || mode === 'dark') return mode;
  // 'auto' follows the OS colour scheme. Prefer the server's reading of the OS
  // itself (the embedded WebView's prefers-color-scheme is unreliable, and on
  // macOS reports light for a moment after every display wake); fall back to the
  // media query only until that value is available, or where there is none.
  if (typeof _osPrefersDark === 'boolean') return _osPrefersDark ? 'dark' : 'light';
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}

// ── Dual-palette themes (paletteVariants) ─────────────────────────
// The variant a settings object is currently showing, or null when the theme
// carries no pair (or has no half for the resolved tone). resolveAppearance()
// already turns 'auto' into the live OS tone, so Auto follows Windows through the
// same matchMedia / refreshOsTheme repaints that autoPalette uses — no extra
// listener, and nothing is persisted when the OS flips.
function activePaletteVariant(settings) {
  if (!settings || !settings.paletteVariants) return null;
  return ThemePalette.variantFor(settings.paletteVariants, resolveAppearance(settings.appearance));
}

// Bake the variant that's on screen into the real colour keys and drop the pair.
// Every path where the user picks a colour themselves goes through this first:
// otherwise their edit lives on the frozen base palette while the overlay keeps
// painting the variant over it, so the change would look ignored — and the next
// OS flip would silently revert it. Returns a plain patch source for
// normalizeSettings (never mutates the input).
function freezePaletteVariants(settings) {
  const base = settings || {};
  if (!base.paletteVariants) return base;
  const frozen = ThemePalette.applyVariant(base, activePaletteVariant(base));
  frozen.paletteVariants = null;
  return frozen;
}

function setAppearance(mode) {
  if (!['light', 'dark', 'auto'].includes(mode)) return;
  const resolved = mode === 'auto' ? resolveAppearance(mode) : mode;
  // A dual-palette theme already answers this question: the author drew both
  // tones, so switching mode swaps to the authored variant instead of throwing
  // the theme away for the stock palette. autoPalette stays false — the variants
  // ARE the palette, and on 'auto' the overlay follows Windows by itself.
  if (hubSettings.paletteVariants && hubSettings.paletteVariants[resolved]) {
    hubSettings = normalizeSettings({ ...hubSettings, appearance: mode, autoPalette: false });
    saveHubSettings();
    applyHubSettings();
    syncSettingsControls();
    if (mode === 'auto') refreshOsTheme();
    return;
  }
  // No variant for the requested tone: the pair can't describe this look, so it
  // is dropped along with the rest of the previous palette below.
  const stock = window.ThemePalette && ThemePalette.STOCK[resolved];
  const patch = { appearance: mode, autoPalette: mode === 'auto', paletteVariants: null };
  // A mode switch is an intentional request for a usable light/dark starting
  // point. Keep the chosen accent, but reset every surface/foreground role so
  // Light really becomes light and Dark really becomes dark. Subsequent colour
  // edits remain exact and are never replaced inside applyHubSettings().
  if (stock) {
    for (const key of APPEARANCE_COLOR_KEYS) patch[key] = null;
    for (const key of ['background', 'surface', 'surfaceAlt', 'controlColor', 'text']) patch[key] = stock[key];
    patch.contrastGuard = true;
  }
  hubSettings = normalizeSettings({ ...hubSettings, ...patch });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
  if (mode === 'auto') refreshOsTheme();   // fetch the current OS scheme right away
}

// ── Dashboard style (Liquid Glass / Classic / Pixel Retro / Comic) ─────────
function setStyleMode(mode) {
  if (!STYLE_MODES.includes(mode)) return;
  hubSettings.styleMode = mode;
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
}

function updateRetroScanlines(enabled) {
  hubSettings.retroScanlines = enabled !== false && enabled !== 'false';
  saveHubSettings();
  applyHubSettings();
}

function syncStyleModeControls() {
  const retro = hubSettings.styleMode === 'retro';
  // Refresh the gallery's active highlight (the skin lives on the cards now).
  renderThemeGallery();
  const scan = $('settings-retro-scanlines');
  if (scan) scan.checked = hubSettings.retroScanlines;
  const scanRow = $('settings-retro-scanlines-row');
  if (scanRow) {
    scanRow.hidden = !retro;
    // Hide the whole grid too, or the empty container leaves a blank strip.
    const grid = scanRow.closest('.settings-grid');
    if (grid) grid.hidden = !retro;
  }
  // Retro owns a fixed dark CRT palette. Comic is now palette-driven and may be
  // light or dark, so its mode buttons remain fully functional.
  const forcedAppearance = retro;
  const themeGroup = document.querySelector('.settings-theme-group');
  if (themeGroup) themeGroup.classList.toggle('is-disabled', forcedAppearance);
}

// ── Dynamic album-art accent ──────────────────────────────────────
// Runtime-only override of the accent colour, driven by the now-playing album
// art (album-theme.js extracts it, media.js feeds it in via setDynamicAccent).
// hubSettings.accent stays the persistent user choice — this only layers a
// visual tint on top, and clears back to it when music stops or the feature is
// off.
//
// Two sources feed the SAME visual tint through setDynamicAccent: the album art
// (media.js, source 'album') and a granted SDK widget with the `accent`
// capability (custom-widget.js, source 'widget'). They are kept in SEPARATE
// slots so neither can silently clobber or erase the other: a track starting
// while a widget owns the tint must not wipe the widget's colour, and a widget
// being torn down must not null out the album accent set after it. The effective
// value is widget-over-album — an explicit, granted, actively-pushed signal wins
// over the passive automatic one — and falls back the moment its owner clears.
let _albumAccent = null;
let _widgetAccent = null;
let _dynamicAccent = null;   // effective: _widgetAccent || _albumAccent

let _effectiveThemePalette = null;

// The palette, its CSS tokens and the tile drop shadow live in js/theme-tokens.js,
// shared with the light layer page; these keep the dashboard's own state around it.
function deriveEffectiveThemePalette() {
  return ThemeTokens.derivePalette(hubSettings, { resolve: resolveAppearance, dynamicAccent: _dynamicAccent });
}

function applyThemePaletteTokens(root, palette) {
  ThemeTokens.applyPalette(root, palette);
  _effectiveThemePalette = palette;
  return palette;
}

function applyAccentColor() {
  const root = document.documentElement;
  return applyThemePaletteTokens(root, deriveEffectiveThemePalette());
}

function getEffectiveThemePalette() {
  return _effectiveThemePalette || deriveEffectiveThemePalette();
}

// True when nothing but a colour lies behind the tiles, so glass has nothing to show.
function backdropIsPlain() {
  if (seeThroughWindowOn() || hubSettings.backgroundMedia) return false;
  const custom = normalizeBgCustom(hubSettings.bgCustom);
  if (custom.enabled && custom.code) return false;
  return normalizeBgStatic(hubSettings.bgStatic).style === 'none' && !normalizeBgAurora(hubSettings.bgAurora).enabled;
}

// Called by media.js on every media update (source 'album', the default) and by
// custom-widget.js for the SDK `accent` capability (source 'widget'). Pass a hex
// to tint the theme, or null to clear THAT source and fall back — to the other
// source if it is still set, else to the user's chosen accent. One toggle
// (dynamicAlbumTheme) governs both sources on purpose.
// Which override, if any, is painting over the accent the user picked.
//
// The colour is stored and kept either way — it is just not what is on screen,
// so the picker looks broken. Exactly the situation the "covered by an active
// background" note already exists for one row below; this is the same note for
// the same reason.
//
// Retro first: it wins in getEffectiveThemePalette(), where the dynamic tint is
// applied and then overwritten by the fixed CRT palette. Reporting them in the
// other order would name a cause that is not the one in effect.
function accentOverrideKey() {
  if (hubSettings.styleMode === 'retro') return 'settings_accent_covered_retro';
  if (hubSettings.dynamicAlbumTheme !== false && _dynamicAccent) return 'settings_accent_covered_album';
  return '';
}

function syncAccentOverrideNote() {
  const note = typeof $ === 'function' ? $('settings-accent-covered-note') : null;
  if (!note) return;
  const key = accentOverrideKey();
  note.hidden = !key;
  if (!key) { note.textContent = ''; note.removeAttribute('data-i18n'); return; }
  // data-i18n as well as the text: the language can change while Settings is
  // open, and the re-translate pass reads the attribute.
  note.setAttribute('data-i18n', key);
  note.textContent = t(key);
}

function setDynamicAccent(hex, source) {
  const valid = hubSettings.dynamicAlbumTheme !== false
    && typeof hex === 'string'
    && /^#[0-9a-fA-F]{6}$/.test(hex);
  const next = valid ? hex : null;
  if (source === 'widget') _widgetAccent = next;
  else _albumAccent = next;
  const eff = _widgetAccent || _albumAccent;
  if (eff === _dynamicAccent) return;
  _dynamicAccent = eff;
  applyAccentColor();
  // The note's wording depends on whether a tint is live right now, and this is
  // the only place that changes without a settings re-render.
  syncAccentOverrideNote();
  // A tile with a custom style carries a FROZEN copy of the palette inline
  // (dashboard-layout.js stamps --accent and friends on the wrapper), so
  // repainting :root alone left those tiles — and every SDK widget inside them,
  // since a widget reads its theme from its own frame's computed tokens — on the
  // accent of whatever was playing when the tile was last painted. Re-derive them
  // from the live palette; colorsOnly keeps decor layers untouched, because this
  // runs on every track change. applyAllTileStyles ends with
  // CustomWidget.refreshTheme(), so the widget payload goes out on the same pass.
  if (typeof applyAllTileStyles === 'function') applyAllTileStyles(null, { colorsOnly: true });
  else if (window.CustomWidget && typeof window.CustomWidget.refreshTheme === 'function') window.CustomWidget.refreshTheme();
}

// ── Dynamic album-art accent toggle ───────────────────────────────
function updateDynamicAlbumTheme(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, dynamicAlbumTheme: !!enabled });
  saveHubSettings();
  if (!enabled) { _albumAccent = null; _widgetAccent = null; _dynamicAccent = null; }
  applyAccentColor();
  syncDynamicAlbumControls();
  // Re-tint immediately from the current track when turning the feature on.
  if (enabled && typeof refreshAlbumAccent === 'function') refreshAlbumAccent();
  setSettingsStatus('settings_saved', 'ok');
}

function syncDynamicAlbumControls() {
  const el = $('settings-dynamic-album');
  if (el) el.checked = hubSettings.dynamicAlbumTheme !== false;
}
