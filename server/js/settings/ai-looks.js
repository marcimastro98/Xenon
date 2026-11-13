// What Bit may change about the look when asked: colors, style, an animated background and
// preferences.
'use strict';

// ── Xenon AI programmatic customization ───────────────────────────
// Apply any subset of the semantic palette in one
// save+repaint, reusing the same validation as the manual controls. Called by
// the AI's customize_appearance tool. Returns true if anything changed.
function applyAiAppearance(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  let changed = false;
  // Skin switch — routes through the same setter the
  // gallery uses, so it persists and repaints exactly like a manual switch.
  if (STYLE_MODES.includes(o.style) && typeof setStyleMode === 'function') { setStyleMode(o.style); changed = true; }
  const patch = {};
  if (['light', 'dark', 'auto'].includes(o.appearance)) {
    const resolved = o.appearance === 'auto' ? resolveAppearance('auto') : o.appearance;
    // Mirror setAppearance(): a dual-palette theme swaps to its authored variant
    // rather than being replaced by the stock palette.
    if (hubSettings.paletteVariants && hubSettings.paletteVariants[resolved]) {
      Object.assign(patch, { appearance: o.appearance, autoPalette: false });
    } else {
      const stock = ThemePalette.STOCK[resolved];
      for (const key of APPEARANCE_COLOR_KEYS) patch[key] = null;
      for (const key of ['background', 'surface', 'surfaceAlt', 'controlColor', 'text']) patch[key] = stock[key];
      Object.assign(patch, { appearance: o.appearance, autoPalette: o.appearance === 'auto', paletteVariants: null, contrastGuard: true });
    }
  }
  if (typeof o.preset === 'string') {
    const preset = SETTINGS_PRESETS.find(p => p.id === o.preset.trim().toLowerCase());
    if (preset) { patch.accent = preset.accent; patch.background = preset.background; patch.text = preset.text; }
  }
  const colorMap = {
    accent: 'accent', background: 'background', surface: 'surface', surface_alt: 'surfaceAlt',
    control_color: 'controlColor', text: 'text', muted_text: 'mutedText', line_color: 'lineColor',
    accent_text: 'accentText', success_color: 'successColor', warning_color: 'warningColor',
    danger_color: 'dangerColor', info_color: 'infoColor',
  };
  let colorEdited = false;
  for (const [arg, key] of Object.entries(colorMap)) {
    const hex = normalizeHex(o[arg], null);
    if (hex) { patch[key] = hex; patch.autoPalette = false; colorEdited = true; }
  }
  if (typeof o.contrast_guard === 'boolean') patch.contrastGuard = o.contrast_guard;
  if (Object.keys(patch).length) {
    // An exact colour is a manual edit: freeze a dual-palette theme first, exactly
    // like updateSettingsColor(), so the AI's colour isn't overpainted by the
    // variant overlay (or reverted by the next OS flip).
    const base = colorEdited ? freezePaletteVariants(hubSettings) : hubSettings;
    hubSettings = normalizeSettings({ ...base, ...patch });
    saveHubSettings();
    applyHubSettings();
    changed = true;
  }
  if (changed) {
    if (typeof renderSettingsModal === 'function') renderSettingsModal();
    setSettingsStatus('settings_saved', 'ok');
  }
  return changed;
}

// AI: build a COMPLETE custom theme from a description, apply it live, and save it
// as a named card in the Temi gallery (so the user can switch back). Every field
// is optional and defaults to the current look; all route through the same
// normalizer + snapshot the manual editor uses. Called by create_dashboard_style.
function applyAiCreateStyle(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const patch = {};
  if (STYLE_MODES.includes(o.skin)) patch.styleMode = o.skin;
  if (['light', 'dark'].includes(o.base_appearance)) {
    patch.appearance = o.base_appearance;
    patch.autoPalette = false;
  }
  const colorMap = {
    accent: 'accent', background: 'background', surface: 'surface', surface_alt: 'surfaceAlt',
    control_color: 'controlColor', text: 'text', muted_text: 'mutedText', line_color: 'lineColor',
    accent_text: 'accentText', success_color: 'successColor', warning_color: 'warningColor',
    danger_color: 'dangerColor', info_color: 'infoColor',
  };
  let colorEdited = false;
  for (const [arg, key] of Object.entries(colorMap)) {
    const hex = normalizeHex(o[arg], null);
    if (hex) { patch[key] = hex; patch.autoPalette = false; colorEdited = true; }
  }
  const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null; };
  const nums = {
    panelAlpha: num(o.panel_opacity, 0.05, 1),
    uiRoundness: num(o.corner_radius, 0, 2),
    glassBlur: num(o.glass_blur, 0, 40),
    glassSaturate: num(o.glass_saturation, 100, 220),
    panelBorderStrength: num(o.border_strength, 0, 2),
    tileShadowStrength: num(o.shadow_strength, 0, 2),
  };
  for (const [key, val] of Object.entries(nums)) if (val != null) patch[key] = val;
  if (typeof o.contrast_guard === 'boolean') patch.contrastGuard = o.contrast_guard;
  // Authoring a new look on top of a dual-palette theme replaces its palette: bake
  // the visible variant in first, so the snapshot saved as a card is exactly what
  // ends up on screen rather than the other tone's colours.
  const base = (colorEdited || patch.appearance) ? freezePaletteVariants(hubSettings) : hubSettings;
  hubSettings = normalizeSettings({ ...base, ...patch });
  saveHubSettings();
  applyHubSettings();
  // Snapshot the resulting look into a named gallery card (dedupes by signature),
  // which then reads as the active theme.
  const name = (typeof o.name === 'string' && o.name.trim()) ? o.name.trim() : null;
  if (typeof addThemeCard === 'function') addThemeCard(snapshotCurrentTheme(), name);
  if (typeof renderSettingsModal === 'function') renderSettingsModal();
  setSettingsStatus('settings_saved', 'ok');
  return true;
}

// Apply an AI-authored animated background. The model wrote the draw() code; we
// drop it into bgCustom through the SAME normalize/persist path as the manual
// editor (code capped, enabled only when non-empty) and repaint live. The code
// still runs only inside the isolated sandbox iframe — see js/custom-bg.js.
function applyAiAnimatedBackground(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const code = typeof o.code === 'string' ? o.code : '';
  if (!code.trim()) return false;
  const current = hubSettings.bgCustom && typeof hubSettings.bgCustom === 'object' ? hubSettings.bgCustom : {};
  const name = (typeof o.name === 'string' && o.name.trim()) ? o.name.trim().slice(0, 60) : (current.name || '');
  // Fresh AI-authored code = the user's own background again → drop the marker.
  hubSettings = normalizeSettings({ ...hubSettings, bgCustom: { ...current, code, name, enabled: true, imported: false } });
  saveHubSettings();
  applyHubSettings();
  syncBgFxControls();
  if (typeof setSettingsStatus === 'function') setSettingsStatus('settings_saved', 'ok');
  return true;
}

// Apply any subset of dashboard preferences the AI's configure_preferences tool
// passed. Each field routes through its existing setter so validation, live
// repaint and persistence match the manual controls exactly.
function applyAiPreferences(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  let changed = false;
  if (['auto', '12', '24'].includes(o.clock_format)) { updateClockFormat(o.clock_format); changed = true; }
  if (['c', 'f'].includes(o.temp_unit)) { updateTempUnit(o.temp_unit); changed = true; }
  if (typeof o.language === 'string' && SUPPORTED_LANGS.includes(o.language) && typeof setLang === 'function') { setLang(o.language); changed = true; }
  if (typeof o.weather_city === 'string' && o.weather_city.trim()) {
    updateWeatherMode('manual');
    updateWeatherCity(o.weather_city.trim(), true);
    changed = true;
  } else if (['auto', 'manual'].includes(o.weather_mode)) {
    updateWeatherMode(o.weather_mode); changed = true;
  }
  if (o.lock_widgets && typeof o.lock_widgets === 'object') {
    ['clock', 'weather', 'media', 'calendar'].forEach(key => {
      if (typeof o.lock_widgets[key] === 'boolean') { updateLockWidgetSetting(key, o.lock_widgets[key]); changed = true; }
    });
  }
  return changed;
}
