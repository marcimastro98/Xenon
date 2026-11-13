// The saved themes: recognising the one in use, applying, saving, renaming, removing and drawing
// their cards.
'use strict';

// ── Temi gallery (built-in styles + saved/imported themes) ───────────
// The saved/imported themes as stored on hubSettings (always an array).
function getCustomThemes() {
  return Array.isArray(hubSettings.customThemes) ? hubSettings.customThemes : [];
}

// A theme's display name: built-ins carry a translation key, saved ones a literal
// name the user (or the sharer) gave it.
function themeName(theme) {
  if (theme.nameKey) return t(theme.nameKey);
  return String(theme.name || '').trim() || t('theme_imported_default');
}

// Canonical signature of a look over THEME_SETTING_KEYS — both sides are already
// normalized, so a stable string compare tells whether two looks are identical.
function themeSignature(src) {
  return JSON.stringify(THEME_SETTING_KEYS.map(k => {
    const v = src ? src[k] : undefined;
    if (k === 'uiFont') return (v && v.url) ? String(v.url) : '';
    // Provenance belongs to the install receipt, not to the visual identity.
    // Re-importing the same look must still dedupe even when its installId differs.
    if (k === 'bgCustom' && v && typeof v === 'object') {
      const clean = Object.assign({}, v);
      delete clean.imported;
      delete clean.installId;
      return JSON.stringify(clean);
    }
    if (['accent', 'background', 'surface', 'surfaceAlt', 'controlColor', 'text', 'mutedText',
      'lineColor', 'accentText', 'successColor', 'warningColor', 'dangerColor', 'infoColor'].includes(k)) {
      return normalizeHex(v, '');
    }
    if (v && typeof v === 'object') return JSON.stringify(v);
    return v == null ? null : v;
  }));
}

// Exactly one card is highlighted: the saved theme whose full snapshot matches
// the live look, or — if none does (you're on a bare style with your own
// colours) — the current style.
// The bar's share of a look. A theme without one matches any bar: it does not
// change the bar when applied, so the bar cannot tell it apart either.
function themeBarSignature(src) {
  return JSON.stringify(TopbarLook.themePart(src && src.topbarLook));
}
function themeMatchesLive(theme) {
  return themeSignature(theme) === themeSignature(hubSettings)
    && (!theme.topbarLook || themeBarSignature(theme) === themeBarSignature(hubSettings));
}

function findActiveThemeId() {
  const match = getCustomThemes().find(themeMatchesLive);
  if (match) return match.id;
  return BUILTIN_THEMES.some(x => x.id === hubSettings.styleMode) ? hubSettings.styleMode : 'glass';
}

// Copy the live look (every THEME_SETTING_KEYS field) into a plain object.
function snapshotCurrentTheme() {
  const snap = {};
  for (const k of THEME_SETTING_KEYS) snap[k] = hubSettings[k];
  const bar = TopbarLook.themePart(hubSettings.topbarLook);
  if (bar) snap.topbarLook = bar;
  return snap;
}

// Apply a gallery card. A built-in STYLE resets to its stock look; a saved THEME
// applies its whole snapshot. Routed through normalizeSettings + applyHubSettings,
// exactly like the manual controls.
function applyThemeById(id) {
  const builtin = BUILTIN_THEMES.find(x => x.id === id);
  let patch;
  if (builtin) {
    // A built-in style resets to that style's STOCK look: every theme token back
    // to its default, then the style's own declared colours (if any) and its skin
    // on top. (Previously skin-only — it kept your custom colours, so clicking
    // "Liquid Glass" changed nothing visible and left the gallery highlight stuck
    // on a matching saved card.)
    patch = {};
    for (const k of THEME_SETTING_KEYS) if (k in DEFAULT_HUB_SETTINGS) patch[k] = DEFAULT_HUB_SETTINGS[k];
    for (const k of THEME_SETTING_KEYS) if (k in builtin) patch[k] = builtin[k];
    patch.styleMode = builtin.skin;
  } else {
    const theme = getCustomThemes().find(x => x.id === id);
    if (!theme) return;
    patch = {};
    for (const k of THEME_SETTING_KEYS) patch[k] = theme[k];
    // Only the bar's style; the user's buttons and rails stay theirs.
    if (theme.topbarLook) patch.topbarLook = TopbarLook.withThemePart(hubSettings.topbarLook, theme.topbarLook);
  }
  hubSettings = normalizeSettings({ ...hubSettings, ...patch });
  saveHubSettings();
  applyHubSettings();
  renderSettingsModal();
  setSettingsStatus('settings_saved', 'ok');
}

// Store a snapshot as a new gallery card (deduped by signature so re-saving /
// re-importing the same look doesn't stack). Returns the new card, or null if it
// already existed. `name` falls back to an auto-numbered default.
function addThemeCard(snapshot, name, opts) {
  const existing = getCustomThemes();
  const sig = themeSignature(snapshot);
  const bar = themeBarSignature(snapshot);
  if (existing.some(theme => themeSignature(theme) === sig && themeBarSignature(theme) === bar)) { renderThemeGallery(); return null; }
  const card = {
    ...snapshot,
    id: 'ct_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(name || '').trim().slice(0, 40)
      || (t('theme_custom_default') + ' ' + (existing.length + 1)),
  };
  // Redistribution marker for imported looks — export refuses to re-share them
  // (ContentInstalls.themeCardMark: an imported background inside counts too).
  if (typeof ContentInstalls !== 'undefined') Object.assign(card, ContentInstalls.themeCardMark(snapshot, opts));
  else if (opts && opts.imported === true) card.imported = true;
  hubSettings = normalizeSettings({ ...hubSettings, customThemes: existing.concat([card]) });
  saveHubSettings();
  renderThemeGallery();
  refreshThemeConsumers();
  return card;
}

// Save the current look as a theme so you can come back to it later — the button
// that lets "import theme 2, then return to theme 1" actually work. Prompts for a
// name (in-app modal); empty falls back to an auto-numbered default, Cancel aborts.
async function saveCurrentTheme() {
  const fallback = t('theme_custom_default') + ' ' + (getCustomThemes().length + 1);
  const name = await settingsPrompt({ title: t('theme_name_prompt'), value: fallback, maxLength: 40 });
  if (name === null) return; // cancelled
  addThemeCard(snapshotCurrentTheme(), name);
  setSettingsStatus('settings_saved', 'ok');
}

// Persist the just-imported look as a card. preset-share has already applied the
// code, so we snapshot the resulting live settings — the card reproduces exactly
// what the user now sees, font included.
function saveImportedThemeCard(name, installId) {
  return addThemeCard(snapshotCurrentTheme(), name, { imported: true, installId });
}

// Keep import receipts truthful when the user removes one imported resource by
// hand instead of using "Remove all". Empty receipts disappear automatically.
function forgetInstalledContentResource(field, value) {
  if (typeof ContentInstalls === 'undefined' || !Array.isArray(hubSettings.contentInstalls)) return;
  const listFields = new Set(['themeIds', 'pagePresetIds', 'pageIds', 'deckPresetIds', 'widgetIds', 'ambientSceneIds', 'fontUrls']);
  if (!listFields.has(field) && field !== 'deckProfiles' && field !== 'background') return;
  const next = hubSettings.contentInstalls.map((record) => {
    const resources = ContentInstalls.normalizeResources(record.resources);
    if (field === 'deckProfiles' && value && typeof value === 'object') {
      resources.deckProfiles = resources.deckProfiles.filter(ref => !(ref.instanceId === value.instanceId && ref.profileId === value.profileId));
    } else if (field === 'background') {
      resources.background = false;
    } else {
      resources[field] = resources[field].filter(item => item !== value);
    }
    return Object.assign({}, record, { resources });
  }).filter(record => ContentInstalls.resourceCount(record.resources));
  if (JSON.stringify(next) === JSON.stringify(hubSettings.contentInstalls)) return;
  hubSettings = normalizeSettings(Object.assign({}, hubSettings, { contentInstalls: next }));
  saveHubSettings();
}
window.forgetInstalledContentResource = forgetInstalledContentResource;

// Rename a saved/imported theme (double-tap its name). Built-in styles have no id
// match, so they can't be renamed.
async function renameCustomTheme(id) {
  const theme = getCustomThemes().find(x => x.id === id);
  if (!theme) return;
  const name = await settingsPrompt({ title: t('theme_name_prompt'), value: theme.name || '', maxLength: 40 });
  if (name === null) return; // cancelled
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean || clean === theme.name) return;
  const next = getCustomThemes().map(x => x.id === id ? { ...x, name: clean } : x);
  hubSettings = normalizeSettings({ ...hubSettings, customThemes: next });
  saveHubSettings();
  renderThemeGallery();
  refreshThemeConsumers();
  setSettingsStatus('settings_saved', 'ok');
}

// Remove one saved/imported theme card. Built-in styles can't be removed.
function removeCustomTheme(id) {
  // Was this the look currently on screen? Check BEFORE removing the card.
  const wasActive = findActiveThemeId() === id;
  const next = getCustomThemes().filter(theme => theme.id !== id);
  if (next.length === getCustomThemes().length) return;
  forgetInstalledContentResource('themeIds', id);
  hubSettings = normalizeSettings({ ...hubSettings, customThemes: next });
  saveHubSettings();
  if (wasActive && typeof applyThemeById === 'function') {
    // Deleting the theme you're using drops you back to the stock look: there's no
    // saved card left to sit on. applyThemeById re-renders the gallery itself;
    // refresh the other theme consumers too.
    applyThemeById(DEFAULT_HUB_SETTINGS.styleMode);
  } else {
    renderThemeGallery();
  }
  refreshThemeConsumers();
  setSettingsStatus('settings_saved', 'ok');
}

function makeThemeCard(theme, activeId, isCustom) {
  const wrap = document.createElement('div');
  wrap.className = 'theme-card-wrap';

  const card = document.createElement('button');
  card.type = 'button';
  const retro = (theme.styleMode || theme.skin || 'glass') === 'retro';
  card.className = 'theme-card' + (theme.id === activeId ? ' active' : '') + (retro ? ' theme-card--retro' : '')
    + (theme.id === 'liquid' ? ' theme-card--liquid' : '');
  card.setAttribute('aria-pressed', theme.id === activeId ? 'true' : 'false');
  card.setAttribute('aria-label', themeName(theme));
  card.style.setProperty('--tc-bg', theme.background);
  card.style.setProperty('--tc-accent', theme.accent);
  card.style.setProperty('--tc-text', theme.text);
  card.addEventListener('click', () => applyThemeById(theme.id));

  const swatch = document.createElement('span');
  swatch.className = 'theme-card-preview';
  const dot = document.createElement('span');
  dot.className = 'theme-card-dot';
  swatch.appendChild(dot);

  const foot = document.createElement('span');
  foot.className = 'theme-card-foot';
  const name = document.createElement('span');
  name.className = 'theme-card-name';
  name.textContent = themeName(theme);
  if (isCustom) {
    // Double-tap the name to rename this saved theme (single tap still applies it).
    name.title = t('settings_theme_rename');
    name.addEventListener('dblclick', (e) => { e.stopPropagation(); renameCustomTheme(theme.id); });
  }
  foot.appendChild(name);

  card.append(swatch, foot);
  wrap.appendChild(card);

  if (isCustom) {
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'theme-card-remove';
    rm.setAttribute('aria-label', t('settings_theme_remove'));
    rm.textContent = '✕';
    rm.addEventListener('click', (e) => { e.stopPropagation(); removeCustomTheme(theme.id); });
    wrap.appendChild(rm);
  }
  return wrap;
}

function renderThemeGallery() {
  const box = $('settings-theme-gallery');
  if (!box) return;
  const activeId = findActiveThemeId();
  const cards = BUILTIN_THEMES.map(theme => makeThemeCard(theme, activeId, false))
    .concat(getCustomThemes().map(theme => makeThemeCard(theme, activeId, true)));
  box.replaceChildren(...cards);
}

// Refresh UI OTHER than the gallery that lists saved themes (currently the
// contextual-profiles Style dropdown), so a theme added/renamed/removed appears
// or disappears there immediately — not only the next time Settings is opened.
// Guarded: no-ops when that section isn't in the DOM.
function refreshThemeConsumers() {
  try { if (typeof syncContextProfileControls === 'function') syncContextProfileControls(); } catch { /* section not mounted */ }
}
