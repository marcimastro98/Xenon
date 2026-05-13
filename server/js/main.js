'use strict';

// ── Panel routing ─────────────────────────────────────────────
const panelParam = (new URLSearchParams(window.location.search).get('panel') || '').toLowerCase();
const VALID_PANELS = ['media', 'mic', 'notes', 'system', 'audio'];
const activePanel = VALID_PANELS.includes(panelParam) ? panelParam : 'full';
if (activePanel !== 'full') document.body.dataset.panel = activePanel;

// ── Initial render ────────────────────────────────────────────
tickClock();
applyTranslations();
if (typeof initDashboardLayout === 'function') initDashboardLayout();
refreshSlider(50);
refreshMicSlider(50);
renderTabSwitcher();

// ── Per-panel data needs ──────────────────────────────────────
const need = {
  status: ['full', 'mic', 'media'].includes(activePanel),
  audio:  ['full', 'audio', 'mic'].includes(activePanel),
  media:  ['full', 'media'].includes(activePanel),
  system: ['full', 'system'].includes(activePanel),
  events: ['full', 'media'].includes(activePanel),
  notes:  ['full', 'notes'].includes(activePanel),
};

setInterval(tickClock, 1000);
if (need.status) { pollStatus(); setInterval(pollStatus, 3000); }
if (need.audio)  { fetchAudio(); setInterval(fetchAudio, 5000); }
if (need.media)  { fetchMedia(); setInterval(fetchMedia, 2000); }
if (need.system) { fetchSystem(); setInterval(fetchSystem, 7000); }
if (need.system) { fetchWeather(); setInterval(fetchWeather, 30 * 60 * 1000); }
if (need.events) { loadCalendarEvents(); setInterval(checkReminders, 15000); }
if (need.notes)  { loadNotes(); }

// ── Init app favorites buttons ───────────────────────────────
renderAppFavorites();

// ── Keyboard listener (Escape) ────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.body.classList.contains('layout-editing') && typeof setDashboardLayoutEditMode === 'function') {
      e.preventDefault();
      setDashboardLayoutEditMode(false);
      return;
    }
    const lockScreen = document.getElementById('lockscreen-overlay');
    if (lockScreen && !lockScreen.hidden) {
      e.preventDefault();
      closeWidgetLockScreen();
      return;
    }
    const weatherOverlay = document.getElementById('weather-overlay');
    if (weatherOverlay && !weatherOverlay.hidden) {
      e.preventDefault();
      closeWeatherDetails();
      return;
    }
    const settingsOverlay = document.getElementById('settings-overlay');
    if (settingsOverlay && !settingsOverlay.hidden) {
      e.preventDefault();
      closeSettings();
      return;
    }
    const appSwitcher = document.getElementById('app-switcher');
    if (appSwitcher && !appSwitcher.hidden) {
      e.preventDefault();
      closeAppSwitcher();
      return;
    }
    const tabSwitcher = document.getElementById('tab-switcher');
    if (tabSwitcher && !tabSwitcher.hidden) {
      e.preventDefault();
      closeTabSwitcher();
      return;
    }
  }
}, true);

// ── Sync language across iframes via storage event ────────────
window.addEventListener('storage', e => {
  if (e.key === 'uiLang' && e.newValue && e.newValue !== lang && i18n[e.newValue]) {
    lang = e.newValue;
    applyTranslations();
  }
  if (e.key === 'appFavorites') {
    appFavorites = parseAppFavorites(e.newValue || '[]');
    renderAppFavorites();
    if ($('app-switcher') && !$('app-switcher').hidden) renderAppWindows();
  }
  if (e.key === window.SETTINGS_STORAGE_KEY) reloadHubSettingsFromStorage();
});

// ── Quick-action buttons ──────────────────────────────────────
async function quickLock() {
  try { await fetch('/lock', { method: 'POST' }); } catch {}
}

// ── Save notes on unload ──────────────────────────────────────
window.addEventListener('beforeunload', () => {
  if (notesSaveTimer) {
    clearTimeout(notesSaveTimer);
    const ta = document.getElementById('notes-area');
    if (ta && notesLoaded) {
      try {
        navigator.sendBeacon('/notes', new Blob([JSON.stringify({ text: ta.value })], { type: 'application/json' }));
      } catch {}
    }
  }
});
