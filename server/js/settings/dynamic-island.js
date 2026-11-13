// Which sources may take over the dynamic island.
'use strict';

const ISLAND_SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

function dynamicIslandHiddenSources() {
  const list = hubSettings.topbarClock && hubSettings.topbarClock.hiddenSources;
  return Array.isArray(list) ? list.slice() : [];
}

// Installed packages are the source of truth: an uninstalled Vanguard/Claude/
// Teleprompter contribution never leaves a stale switch behind in Settings.
async function renderDynamicIslandSources() {
  const host = $('settings-island-sources');
  if (!host || !window.CustomWidget || typeof CustomWidget.getPackages !== 'function') return;
  host.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'island-source-empty';
  loading.textContent = t('settings_island_loading');
  host.appendChild(loading);
  let payload;
  try { payload = await CustomWidget.getPackages(); }
  catch { payload = { packages: [] }; }
  if (!host.isConnected) return;
  const packages = (payload && Array.isArray(payload.packages) ? payload.packages : [])
    .filter((pkg) => pkg && (pkg.island === true || pkg.islandDynamic === true || pkg.badge === true || pkg.mini === true || pkg.topbarButton === true))
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  host.replaceChildren();
  if (!packages.length) {
    const empty = document.createElement('div');
    empty.className = 'island-source-empty';
    empty.textContent = t('settings_island_empty');
    host.appendChild(empty);
    return;
  }
  const hidden = new Set(dynamicIslandHiddenSources());
  packages.forEach((pkg) => {
    const row = document.createElement('label');
    row.className = 'island-source-row';

    const copy = document.createElement('span');
    copy.className = 'island-source-copy';
    const title = document.createElement('strong');
    title.textContent = String(pkg.name || pkg.id);
    const capabilities = document.createElement('span');
    capabilities.className = 'island-source-capabilities';
    const keys = [];
    if (pkg.islandFull === true) keys.push('island_source_full');
    else if (pkg.islandDynamic === true) keys.push('island_source_dynamic');
    else if (pkg.island === true) keys.push('island_source_live');
    if (pkg.badge === true) keys.push('island_source_badge');
    if (pkg.mini === true) keys.push('island_source_mini');
    capabilities.textContent = keys.map((key) => t(key)).join(' · ');
    copy.append(title, capabilities);

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'settings-check';
    toggle.checked = !hidden.has(pkg.id);
    toggle.setAttribute('aria-label', String(pkg.name || pkg.id));
    toggle.addEventListener('change', () => toggleDynamicIslandSource(pkg.id, toggle.checked));
    row.append(copy, toggle);
    host.appendChild(row);
  });
}

function toggleDynamicIslandSource(pkgId, enabled) {
  if (typeof pkgId !== 'string' || !ISLAND_SOURCE_ID_RE.test(pkgId)) return;
  const hidden = new Set(dynamicIslandHiddenSources());
  if (enabled) hidden.delete(pkgId);
  else hidden.add(pkgId);
  hubSettings = normalizeSettings({
    ...hubSettings,
    topbarClock: { ...(hubSettings.topbarClock || {}), hiddenSources: Array.from(hidden) },
  });
  saveHubSettings();
  ['SdkIsland', 'SdkBadges', 'SdkMini', 'SdkTopbarButton'].forEach((name) => { if (window[name]) window[name].apply(); });
  // Switched off there, a package also gives up its hidden background frame.
  if (window.CustomWidget && CustomWidget.syncBackground) CustomWidget.syncBackground();
  setSettingsStatus('settings_saved', 'ok');
}

function updateDynamicIslandTakeovers(checked) {
  hubSettings = normalizeSettings({
    ...hubSettings,
    topbarClock: { ...(hubSettings.topbarClock || {}), takeovers: checked === true },
  });
  saveHubSettings();
  syncTopbarClockControls();
  if (window.SdkIsland) window.SdkIsland.apply();
  setSettingsStatus('settings_saved', 'ok');
}

// Puts the WHOLE bar back to how it shipped: chrome style, island position,
// island elements, the button layout (hidden/order/side), the rails, the clock
// format and every per-package opt-out. It asks first — since v4.11.4 this throws
// away an arrangement the user may have spent real time on, and there is no undo.
async function resetDynamicIslandSettings() {
  if (typeof settingsPrompt === 'function') {
    const ok = await settingsPrompt({
      type: 'confirm',
      title: t('settings_island_reset'),
      message: t('settings_island_reset_confirm'),
      okLabel: t('settings_island_reset'),
    });
    if (ok !== true) return;
  }
  const items = DEFAULT_HUB_SETTINGS.topbarClock.items.map((item) => ({ ...item }));
  const actions = DEFAULT_HUB_SETTINGS.topbarClock.actions.map((item) => ({ ...item }));
  hubSettings = normalizeSettings({
    ...hubSettings,
    topbarStyle: DEFAULT_HUB_SETTINGS.topbarStyle,
    topbarRails: { ...DEFAULT_HUB_SETTINGS.topbarRails },
    topbarRailsAutoHide: DEFAULT_HUB_SETTINGS.topbarRailsAutoHide,
    topbarLook: DEFAULT_HUB_SETTINGS.topbarLook,
    clockFormat: DEFAULT_HUB_SETTINGS.clockFormat,
    topbarClock: { version: 2, align: 'center', takeovers: true, mediaTakeover: false, pageLabels: false, hiddenSources: [], items, actions },
    dashboardLayout: { ...getDashboardLayout(), topbarHidden: false },
    claudeWidget: { ...(hubSettings.claudeWidget || {}), topbar: true },
    vitals: { ...(hubSettings.vitals || {}), topbar: false },
  });
  saveHubSettings();
  syncTopbarStyleControls();
  syncTopbarClockControls();
  syncClockFormatControls();
  if (window.TopbarLook) TopbarLook.apply(hubSettings.topbarLook);
  if (window.TopbarMinimal) window.TopbarMinimal.apply();
  applyTopbarClockSettings();
  if (typeof tickClock === 'function') tickClock();
  if (typeof renderLockClock === 'function') renderLockClock();
  if (window.CustomWidget && typeof window.CustomWidget.refreshTheme === 'function') window.CustomWidget.refreshTheme();
  if (window.SdkIsland) window.SdkIsland.apply();
  if (window.SdkBadges) window.SdkBadges.apply();
  if (window.SdkMini) window.SdkMini.apply();
  if (window.SdkTopbarButton) window.SdkTopbarButton.apply();
  renderDynamicIslandSources();
  if (typeof applyDashboardLayoutWithTransition === 'function') applyDashboardLayoutWithTransition();
  setSettingsStatus('settings_saved', 'ok');
}
