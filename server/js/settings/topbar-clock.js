// The top bar style and the clock, date, upcoming-events, week-start and temperature-unit settings.
'use strict';

// Reflect the active clock format (Auto / 12h / 24h) on its segmented control.
// How much of the date the top bar spells out. Display-only, like the time
// format beside it: redraw now rather than at the next tick, or the segmented
// control moves and nothing else does for up to a second.
function updateClockDateFormat(fmt) {
  if (!['full', 'medium', 'short'].includes(fmt)) return;
  hubSettings = normalizeSettings({ ...hubSettings, clockDateFormat: fmt });
  saveHubSettings();
  syncClockFormatControls();
  if (typeof tickClock === 'function') tickClock();
  // SDK widgets that print a date of their own read the shape from the theme
  // bridge (theme.dateFormat) — re-push it, exactly as the time format beside
  // this does, so a live widget follows instead of waiting for a reload.
  if (window.CustomWidget && typeof window.CustomWidget.refreshTheme === 'function') window.CustomWidget.refreshTheme();
  // A shorter date makes the island's capsule narrower, and the tiles beneath it
  // clear a pill whose width was measured before the change.
  if (window.TopbarMinimal && typeof window.TopbarMinimal.reflowIsland === 'function') {
    window.TopbarMinimal.reflowIsland();
  }
  setSettingsStatus('settings_saved', 'ok');
}

function syncClockFormatControls() {
  const fmt = ['auto', '12', '24'].includes(hubSettings.clockFormat) ? hubSettings.clockFormat : 'auto';
  document.querySelectorAll('.settings-clock-format[data-clock-format]').forEach(btn => {
    const active = btn.dataset.clockFormat === fmt;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  const dfmt = ['full', 'medium', 'short'].includes(hubSettings.clockDateFormat) ? hubSettings.clockDateFormat : 'full';
  document.querySelectorAll('.settings-clock-date-format[data-clock-date-format]').forEach(btn => {
    const active = btn.dataset.clockDateFormat === dfmt;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

function syncTopbarStyleControls() {
  // Two different things: whether the bar is there at all (the layout flag, also
  // toggled from the Layout editor) and what it looks like when it is. Hidden wins,
  // so the segment agrees with the screen however the bar was switched off.
  const layout = (hubSettings && hubSettings.dashboardLayout) || {};
  const style = layout.topbarHidden === true ? 'none'
    : (hubSettings.topbarStyle === 'minimal' ? 'minimal' : 'full');
  document.querySelectorAll('.settings-topbar-style[data-topbar-style]').forEach(btn => {
    const active = btn.dataset.topbarStyle === style;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  // Built-in visibility applies to Full and Minimal. Position only belongs to
  // Minimal; edge rails exist in Minimal and None (the user's existing no-pill
  // mode deliberately keeps those controls reachable).
  const personalize = document.getElementById('topbar-personalize');
  if (personalize) personalize.hidden = false;
  const alignRow = document.getElementById('topbar-align-personalize');
  if (alignRow) alignRow.hidden = style !== 'minimal';
  const railsRow = document.getElementById('topbar-rails-personalize');
  setSettingsCardAvailable(railsRow, style !== 'full');
  syncTopbarRailsAutoHide();
}

// Reflect the "auto-hide edge rails" toggle (minimal mode only). Default on.
function syncTopbarRailsAutoHide() {
  const el = $('settings-rails-autohide');
  if (el) el.checked = hubSettings.topbarRailsAutoHide !== false;
}

// Toggle whether the minimal edge rails hide themselves when untouched
// (after topbarLook.railDelay seconds).
function updateTopbarRailsAutoHide(checked) {
  hubSettings = normalizeSettings({ ...hubSettings, topbarRailsAutoHide: checked === true });
  saveHubSettings();
  syncTopbarRailsAutoHide();
  // The delay and "what stays on the edge" rows only apply while this is on.
  if (window.TopbarLookSettings) window.TopbarLookSettings.sync();
  if (window.TopbarMinimal) window.TopbarMinimal.apply();
  if (window.SdkIsland) window.SdkIsland.apply();
  setSettingsStatus('settings_saved', 'ok');
}

// Switch between the full glass topbar, the minimal chrome (edge rails + island
// pill), and no bar at all. Re-applies the dashboard layout so the grid reclaims/
// returns the bar's row with a smooth transition.
// "None" is deliberately NOT a third topbarStyle: it writes the same
// dashboardLayout.topbarHidden flag the Layout editor's hide button already owns.
// A second flag for the same question would let the two controls disagree, and the
// existing one is what the body class, TopbarMinimal and the floating Layout button
// (the way back in once the bar is gone) all read.
function updateTopbarStyle(style) {
  if (!['full', 'minimal', 'none'].includes(style)) return;
  const hide = style === 'none';
  hubSettings = normalizeSettings({
    ...hubSettings,
    // Hiding keeps the style underneath, so bringing the bar back restores the look
    // the user had instead of dropping them on Full.
    topbarStyle: hide ? hubSettings.topbarStyle : style,
    dashboardLayout: { ...getDashboardLayout(), topbarHidden: hide },
  });
  saveHubSettings();
  syncTopbarStyleControls();
  syncTopbarClockControls();
  if (window.TopbarMinimal) window.TopbarMinimal.apply();
  if (window.SdkIsland) window.SdkIsland.apply();
  applyTopbarClockSettings();
  if (typeof applyDashboardLayoutWithTransition === 'function') applyDashboardLayoutWithTransition();
  setSettingsStatus('settings_saved', 'ok');
}

// A whole bar at once (a `topbar` share code, js/topbar-share.js): look, style,
// island, buttons and rails land together, then every control and both chromes
// repaint. `share` comes from TopbarShare.read(); normalizeSettings still
// rebuilds each list.
function applyTopbarSetup(share) {
  hubSettings = normalizeSettings({ ...hubSettings, ...TopbarShare.patch(hubSettings, share) });
  saveHubSettings();
  TopbarLook.apply(hubSettings.topbarLook);
  syncTopbarStyleControls();
  syncTopbarClockControls();
  if (window.TopbarLookSettings) window.TopbarLookSettings.sync();
  if (window.TopbarButtonOptions) window.TopbarButtonOptions.sync();
  if (window.TopbarMinimal) window.TopbarMinimal.apply();
  if (window.SdkIsland) window.SdkIsland.apply();
  applyTopbarClockSettings();
  if (typeof applyDashboardLayoutWithTransition === 'function') applyDashboardLayoutWithTransition();
}

// Anchor the minimal island left/centre/right. Display-only.
function updateTopbarAlign(align) {
  if (!['center', 'left', 'right'].includes(align)) return;
  hubSettings = normalizeSettings({ ...hubSettings, topbarClock: { ...(hubSettings.topbarClock || {}), align } });
  saveHubSettings();
  syncTopbarClockControls();
  applyTopbarClockSettings();
  setSettingsStatus('settings_saved', 'ok');
}

// Switch the dashboard/lock-screen clock between 12h and 24h. Display-only —
// repaint both clocks immediately so the change is visible without waiting for
// the next tick.
function updateClockFormat(fmt) {
  if (!['auto', '12', '24'].includes(fmt)) return;
  hubSettings = normalizeSettings({ ...hubSettings, clockFormat: fmt });
  saveHubSettings();
  syncClockFormatControls();
  if (typeof tickClock === 'function') tickClock();
  if (typeof renderLockClock === 'function') renderLockClock();
  // SDK widgets that render their own clock (e.g. the POW! Ambient scene) read
  // the resolved 12h/24h flag from the theme bridge — re-push it so they follow.
  if (window.CustomWidget && typeof window.CustomWidget.refreshTheme === 'function') window.CustomWidget.refreshTheme();
  setSettingsStatus('settings_saved', 'ok');
}

// How many upcoming events the Calendar tile lists, and how far ahead it looks.
// Display-only, like the first-day-of-week beside them: repaint immediately so
// the change is visible without waiting for the next calendar refresh.
function updateUpcomingCount(value) {
  const n = Number(value);
  if (![3, 5, 8, 10].includes(n)) return;
  hubSettings = normalizeSettings({ ...hubSettings, upcomingCount: n });
  saveHubSettings();
  syncUpcomingControls();
  if (typeof renderUpcoming === 'function') renderUpcoming();
  setSettingsStatus('settings_saved', 'ok');
}

function updateUpcomingDays(value) {
  const n = Number(value);
  if (![0, 7, 14, 30].includes(n)) return;
  hubSettings = normalizeSettings({ ...hubSettings, upcomingDays: n });
  saveHubSettings();
  syncUpcomingControls();
  if (typeof renderUpcoming === 'function') renderUpcoming();
  setSettingsStatus('settings_saved', 'ok');
}

function updateUpcomingColumns(value) {
  const n = Number(value);
  if (![0, 1, 2].includes(n)) return;
  hubSettings = normalizeSettings({ ...hubSettings, upcomingColumns: n });
  saveHubSettings();
  syncUpcomingControls();
  if (typeof renderUpcoming === 'function') renderUpcoming();
  setSettingsStatus('settings_saved', 'ok');
}

function syncUpcomingControls() {
  for (const [id, value] of [['settings-upcoming-count', hubSettings.upcomingCount],
    ['settings-upcoming-days', hubSettings.upcomingDays],
    ['settings-upcoming-cols', hubSettings.upcomingColumns]]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.value = String(value);
    // The native <select> is hidden behind the custom dropdown, so setting
    // .value alone leaves the visible label on the old option.
    if (typeof el._csSync === 'function') el._csSync();
  }
}

// Reflect the active first-day-of-week (Mon / Sun) on its segmented control.
function syncWeekStartControls() {
  const val = ['mon', 'sun'].includes(hubSettings.weekStart) ? hubSettings.weekStart : 'mon';
  document.querySelectorAll('.settings-week-start[data-week-start]').forEach(btn => {
    const active = btn.dataset.weekStart === val;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

// Switch the calendar's first day of week (Monday/Sunday). Display-only —
// repaint the calendar immediately so the change is visible.
function updateWeekStart(val) {
  if (!['mon', 'sun'].includes(val)) return;
  hubSettings = normalizeSettings({ ...hubSettings, weekStart: val });
  saveHubSettings();
  syncWeekStartControls();
  if (typeof renderCalendar === 'function') renderCalendar();
  setSettingsStatus('settings_saved', 'ok');
}

// Switch the weather temperature unit (°C/°F). The unit is display-only: the
// server keeps reporting Celsius and the client converts on render, so no
// re-fetch is needed — just re-paint the already-loaded weather.
function updateTempUnit(unit) {
  if (!['c', 'f'].includes(unit)) return;
  hubSettings = normalizeSettings({ ...hubSettings, tempUnit: unit });
  saveHubSettings();
  syncWeatherSettingsControls();
  if (typeof applyWeather === 'function') applyWeather(typeof weatherData !== 'undefined' ? weatherData : null);
  if (typeof renderLockScreen === 'function') renderLockScreen();
  repaintTempUnits();
  setSettingsStatus('settings_weather_saved', 'ok');
}

// The unit for hardware readings: 'auto' follows the weather unit above, 'c' and
// 'f' pin it, for people who read the forecast in °F and their CPU in °C.
function updateHwTempUnit(unit) {
  if (!['auto', 'c', 'f'].includes(unit)) return;
  hubSettings = normalizeSettings({ ...hubSettings, hwTempUnit: unit });
  saveHubSettings();
  syncWeatherSettingsControls();
  repaintTempUnits();
  setSettingsStatus('settings_saved', 'ok');
}

// Either unit can change what the CPU/GPU headers say (hardware 'auto' follows
// the weather one), so both setters repaint them and tell installed widgets.
function repaintTempUnits() {
  if (typeof applySystem === 'function' && typeof lastSystemData !== 'undefined' && lastSystemData) applySystem(lastSystemData);
  // Widgets draw temperatures too (a monitor tile, a weather tile). Tell them,
  // the same way a theme or language change is told — see refreshTempUnit.
  if (window.CustomWidget && typeof window.CustomWidget.refreshTempUnit === 'function') {
    window.CustomWidget.refreshTempUnit();
  }
}
