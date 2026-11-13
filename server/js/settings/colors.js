// Color pickers, sliders, presets and the small switches of the Look page.
'use strict';

function setThemePreset(id) {
  const preset = SETTINGS_PRESETS.find(item => item.id === id);
  if (!preset) return;
  const reset = {};
  for (const key of APPEARANCE_COLOR_KEYS) reset[key] = null;
  hubSettings = normalizeSettings({ ...hubSettings, ...reset, autoPalette: false, paletteVariants: null, accent: preset.accent, background: preset.background, text: preset.text, contrastGuard: true });
  saveHubSettings();
  applyHubSettings();
  renderSettingsModal();
  setSettingsStatus('settings_saved', 'ok');
}

function updateSettingsColor(key, value) {
  if (!['accent', 'background', 'surface', 'surfaceAlt', 'controlColor', 'text', 'mutedText',
    'lineColor', 'accentText', 'successColor', 'warningColor', 'dangerColor', 'infoColor'].includes(key)) return;
  const hex = normalizeHex(value, null);
  if (!hex) return;
  hubSettings = normalizeSettings({ ...freezePaletteVariants(hubSettings), [key]: hex, autoPalette: false });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
  renderThemeGallery(); // aggiorna solo l'evidenziazione delle card, senza resettare i colori aperti
}

// Reset an optional semantic role to the palette engine's automatic value.
function clearSettingsColor(key) {
  if (!['surface', 'surfaceAlt', 'controlColor', 'mutedText', 'lineColor', 'accentText',
    'successColor', 'warningColor', 'dangerColor', 'infoColor'].includes(key)) return;
  hubSettings = normalizeSettings({ ...freezePaletteVariants(hubSettings), [key]: null, autoPalette: false });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
  renderThemeGallery();
}

function updateContrastGuard(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, contrastGuard: enabled !== false });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
  renderThemeGallery();
}

function updateBootSplash(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, bootSplash: enabled !== false });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
}

function updateIdleAnimationPause(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, idleAnimationPause: enabled !== false });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
}

// Safe mode: everything imported goes quiet (widgets, custom theme/skin, custom
// backgrounds) without touching any stored key — applyHubSettings derives the
// factory look while the flag is on, so toggling off restores the prior state.
function setSafeMode(on) {
  hubSettings = normalizeSettings({ ...hubSettings, safeMode: on === true });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
  if (window.CustomWidget && CustomWidget.renderWidgets) CustomWidget.renderWidgets();
}



function updateHybridGpuAnimationPause(enabled) {
  hubSettings = normalizeSettings({ ...hubSettings, hybridGpuAnimationPause: enabled !== false });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
  // The background editor's "frozen on this machine" note is driven by the same
  // signal, so refresh it in the same gesture instead of on the next repaint.
  renderBgFrozenNote();
}

/* ── Hex text input helper ───────────────────────────────── */

/**
 * Chiamata da oninput/onchange del campo hex testuale.
 * Applica il colore solo se il valore è un hex valido.
 */
function onHexInput(key, rawValue) {
  const input = $(`settings-${key}`);
  const raw = rawValue.trim();
  const hex = normalizeHex(raw.startsWith('#') ? raw : `#${raw}`, null);
  if (!hex) {
    if (input) input.classList.add('invalid');
    return;
  }
  if (input) input.classList.remove('invalid');
  const preview = $(`settings-${key}-swatch`);
  if (preview) preview.style.background = hex;
  updateSettingsColor(key, hex);
}

function updateSettingsRange(key, value) {
  if (!['panelAlpha', 'bgDim', 'bgBlur', 'uiRoundness', 'glassBlur', 'glassSaturate', 'panelBorderStrength', 'tileShadowStrength', 'clockScale', 'clockDateScale'].includes(key)) return;
  hubSettings = normalizeSettings({ ...hubSettings, [key]: value });
  saveHubSettings();
  applyHubSettings();
  syncSettingsControls();
  // A bigger clock makes the minimal island's capsule taller, and the tiles that
  // sit under it inset themselves by its MEASURED height — so the measurement has
  // to be retaken or the top row keeps clearing the old pill.
  if ((key === 'clockScale' || key === 'clockDateScale')
    && window.TopbarMinimal && typeof window.TopbarMinimal.reflowIsland === 'function') {
    window.TopbarMinimal.reflowIsland();
  }
}

// Open the in-app ColorPicker from a settings colour preview (the native colour
// dialog is blocked in the iCUE WebView). `key` is a hub colour key ('accent',
// 'background', 'text') or 'grid' for the neon-grid background colour. Wired
// via onclick on the .settings-color-preview divs in index.html.
function openSettingsColorPicker(key, anchor) {
  if (!window.ColorPicker) return;
  const input = $(key === 'grid' ? 'settings-grid-color' : `settings-${key}`);
  const raw = input ? input.value.trim() : '';
  const cssVars = {
    accent: '--accent', background: '--bg', surface: '--surface', surfaceAlt: '--surface-alt',
    controlColor: '--control-bg', text: '--text', mutedText: '--muted-text', lineColor: '--line',
    accentText: '--on-accent', successColor: '--color-success', warningColor: '--color-warn',
    dangerColor: '--color-danger', infoColor: '--color-info',
  };
  const effective = key === 'grid' ? '#1ed760'
    : getComputedStyle(document.documentElement).getPropertyValue(cssVars[key] || '--accent').trim();
  const value = normalizeHex(raw.startsWith('#') ? raw : `#${raw}`, normalizeHex(effective, '#1ed760'));
  window.ColorPicker.open({
    anchor, value,
    onPick: (hex) => {
      if (input) input.value = hex.toUpperCase();
      if (key === 'grid') updateGridColor(hex);
      else onHexInput(key, hex);
    },
  });
}
