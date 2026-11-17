'use strict';

/*
 * Xenon — Copyright (c) 2026 Marcello Mastroeni (marcimastro98).
 * Custom non-commercial license. Personal use only; no commercial use or
 * redistribution as your own. Attribution required. See LICENSE for terms.
 */

// ── Panel routing ─────────────────────────────────────────────
const panelParam = (new URLSearchParams(window.location.search).get('panel') || '').toLowerCase();
const VALID_PANELS = ['media', 'agenda', 'mic', 'notes', 'tasks', 'system', 'audio', 'sheet'];
const activePanel = VALID_PANELS.includes(panelParam) ? panelParam : 'full';
if (activePanel !== 'full') document.body.dataset.panel = activePanel;

// Single-panel embeds of extractable widgets (audio/mic/notes/tasks are shown
// as tabs by default) must render their standalone panel — force that widget
// visible for this embed only (in-memory, never persisted).
if (['audio', 'mic', 'notes', 'tasks'].includes(activePanel)
    && typeof hubSettings === 'object' && hubSettings && hubSettings.dashboardLayout
    && hubSettings.dashboardLayout.widgets[activePanel]) {
  hubSettings.dashboardLayout.widgets[activePanel].visible = true;
}

// ── Initial render ────────────────────────────────────────────
tickClock();
applyTranslations();
initAllCustomSelects();
// The authoritative initial layout pass runs once, after DashboardPages.init()
// (below) builds the page grids. Applying here too would lay out against a
// grid-less DOM and trigger a second round of every widget's render hooks. Keep
// a direct apply only as a fallback when the pages module isn't present.
if (typeof initDashboardLayout === 'function' && !window.DashboardPages) initDashboardLayout();
if (typeof initMediaChat === 'function') initMediaChat();
refreshSlider(50);
refreshMicSlider(50);
renderTabSwitcher();

// ── Per-panel data needs ──────────────────────────────────────
const need = {
  status: ['full', 'mic', 'media'].includes(activePanel),
  audio:  ['full', 'audio', 'mic'].includes(activePanel),
  media:  ['full', 'media'].includes(activePanel),
  system: ['full', 'system'].includes(activePanel),
  events: ['full', 'agenda'].includes(activePanel),
  notes:  ['full', 'notes'].includes(activePanel),
  tasks:  ['full', 'agenda', 'tasks'].includes(activePanel),
};

setInterval(() => {
  tickClock();
  // Vitals piggyback the clock tick (change-detected DOM writes, cheap math).
  if (window.VitalsWidget && typeof window.VitalsWidget.tick === 'function') window.VitalsWidget.tick();
  // Advance the calendar's "today" highlight when the local day rolls over past
  // midnight (no-op the rest of the day — just a string compare).
  if (typeof checkCalendarDayRollover === 'function') checkCalendarDayRollover();
}, 1000);

// Weather and events always use polling (long intervals, no benefit from SSE).
// The weather cadence is user-configurable (Settings → Meteo → aggiornamento);
// startWeatherPolling() is re-callable so a settings change restarts the timer
// without a reload. Exposed globally for updateWeatherRefresh().
//
// The poll lands on the WALL CLOCK, not on "now + interval". One dashboard is
// rendered by several surfaces at once (the Xeneon Edge kiosk, a desktop browser
// tab, the iCUE WebView, a paired phone), each with its own timer started
// whenever that surface happened to open. With a plain setInterval a screen left
// on for hours and a tab opened a minute ago fetch at completely different
// instants, so on a 30-minute cadence they can legitimately sit half an hour
// apart — which is how two windows of the SAME dashboard on the SAME PC ended up
// showing "20° cloudy" and "19° drizzle" side by side, reported as the app being
// broken. Anchoring every surface to the same epoch grid makes them ask at the
// same moment; the server's in-flight dedup (weatherPending) then hands them all
// the identical answer, so in steady state they cannot disagree. Only a
// just-opened surface is briefly different, and it re-joins at the next boundary.
let weatherPollTimer = null;
function startWeatherPolling() {
  if (!need.system) return;
  if (weatherPollTimer) clearTimeout(weatherPollTimer);
  const ws = (typeof hubSettings !== 'undefined' && hubSettings.weather) ? hubSettings.weather : null;
  const min = Math.max(10, Number(ws && ws.refreshMin) || 30);
  const periodMs = min * 60 * 1000;
  const scheduleAligned = () => {
    // Epoch-based on purpose: the grid must be the same for every surface, not
    // tied to a local offset. A timer firing a hair early would otherwise
    // re-arm for a few milliseconds, so a sub-second delay skips to the next slot.
    let delay = periodMs - (Date.now() % periodMs);
    if (delay < 1000) delay += periodMs;
    weatherPollTimer = setTimeout(() => { fetchWeather(); scheduleAligned(); }, delay);
  };
  scheduleAligned();
}
window.startWeatherPolling = startWeatherPolling;
if (need.system) { fetchWeather(); startWeatherPolling(); }
// Reminders are decided by the server (SSE calendar_reminder, wired in
// initDataStream); a layer window stays quiet and never shows them.
if (need.events) { loadCalendarEvents(); loadExternalEvents(); setInterval(loadExternalEvents, 5 * 60 * 1000); }
if (need.notes)  { loadNotes(); }
if (need.tasks)  { loadTasks(); }
if (['full', 'agenda'].includes(activePanel)) { if (typeof loadTimers === 'function') loadTimers(); }

// Server-pushed alerts are worded in js/alerts/alert-toasts.js, shared with the
// on-screen alerts window of "Solo widget", so both say the same thing.
function alertToastCtx() {
  return { t, hwF: typeof hwTempIsF === 'function' && hwTempIsF() };
}
// Routine alerts follow the master Notifiche switch, like every other pop-up.
function showAlertToast(toast) {
  const master = (typeof hubSettings === 'object' && hubSettings && hubSettings.notifications) || null;
  if (!toast || !window.XenonToast || !window.AlertToasts.popupsAllowed(master)) return;
  window.XenonToast.show(toast);
}

// The automatic update's last minute (server/updates/auto-update.js): one card, closed
// when the countdown ends any other way. A layer window stays quiet.
let autoUpdateToastId = 0;
function onAutoUpdate(d) {
  if (!window.XenonToast || !window.AlertToasts || isLayerPage()) return;
  if (d && d.phase === 'failed' && window.XenonUpdate) window.XenonUpdate.showNotices();
  if (autoUpdateToastId) window.XenonToast.dismiss(autoUpdateToastId);
  const toast = window.AlertToasts.autoUpdate(d, alertToastCtx(), postponeAutoUpdate);
  autoUpdateToastId = toast ? window.XenonToast.show(toast) : 0;
}
function postponeAutoUpdate() {
  fetch(SERVER + '/update/auto/postpone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
}

// ── Remote state for Deck live-state keys ────────────────────
// Deck keys can bind to remoteConnected/remoteActive. /remote/status runs a real
// check on the PC (Tailscale CLI, sc.exe, Sunshine HTTP, winget the first time), so
// only a key showing that state pays for it: the tick looks at the Deck and asks
// nothing while no key needs the answer, so one added later starts it. A machine
// with neither tool stops asking until the next load, and so does a hidden tab.
// Only on the full dashboard (single-panel embeds never host a Deck).
if (activePanel === 'full') {
  const REMOTE_POLL_MS = 15000;
  const REMOTE_STATES = ['remoteConnected', 'remoteActive'];
  let remoteToolsAbsent = false;
  function applyRemoteSnapshot(st) {
    if (!st || !window.Deck || typeof window.Deck.refreshStates !== 'function') return;
    const remoteConnected = !!(Array.isArray(st.connectedClients) && st.connectedClients.length > 0);
    const remoteActive    = !!(st.ready && !st.blocked);
    window.Deck.refreshStates({ remoteConnected, remoteActive });
  }
  function fetchRemoteStatus() {
    return fetch('/remote/status').then(r => (r.ok ? r.json() : null)).catch(() => null);
  }
  async function pollRemoteState() {
    if (remoteToolsAbsent || document.hidden) return;
    if (!window.Deck || !window.Deck.usesState(REMOTE_STATES)) return;
    const st = await fetchRemoteStatus();
    if (!st) return;
    applyRemoteSnapshot(st);
    remoteToolsAbsent = !(st.installed && (st.installed.sunshine || st.installed.tailscale));
  }
  pollRemoteState();
  setInterval(pollRemoteState, REMOTE_POLL_MS);
}

// ── Init app favorites buttons ───────────────────────────────
// The quick bar shows only favorites whose app is currently open, so it needs a
// window snapshot. Take one quietly at startup — but only if there ARE favorites,
// so a user who never stars an app pays no cost. Opening the switcher refreshes it.
if (Array.isArray(appFavorites) && appFavorites.length) loadAppWindows(false);
else renderAppFavorites();

// ── Dashboard pager ───────────────────────────────────────────
// Register pages and initialise after the rest of the DOM setup is done.
// The lighting plan replaces the placeholder and supplies an onEnter hook.
// dashboard-pages.js parks the authored tiles in a pool, generates a pager
// section per user page, registers them with the pager, and applies the layout
// (which distributes modules and sets the active-page set). The pager tolerates
// an empty viewport at init; pages are added by setPages().
if (window.DashboardPager) window.DashboardPager.init();
if (window.DashboardPages) window.DashboardPages.init();

// ── Keyboard listener (Escape) ────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    // The style window goes first: it sits over layout mode, and leaving layout
    // mode under it left the window open on a dashboard no longer being edited.
    if (typeof window.closeTileStyleEditor === 'function' && window.closeTileStyleEditor()) {
      e.preventDefault();
      return;
    }
    if (document.body.classList.contains('layout-editing') && typeof setDashboardLayoutEditMode === 'function') {
      e.preventDefault();
      setDashboardLayoutEditMode(false);
      return;
    }
    // The canvas scene editor handles its own Escape (deselect, close a panel).
    if (window.AmbientCanvasEditor && AmbientCanvasEditor.isOpen()) return;
    if (window.AmbientMode && AmbientMode.isOpen()) {
      e.preventDefault();
      AmbientMode.close();
      return;
    }
    const settingsOverlay = document.getElementById('settings-overlay');
    if (settingsOverlay && !settingsOverlay.hidden) {
      e.preventDefault();
      // A search in progress is cleared first; the next Esc closes Settings.
      if (window.SettingsSearch && SettingsSearch.handleEscape()) return;
      if (window.XenonMenuPanel?.escape()) return;   // a widget's screen of the menu
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
  const storageLang = normalizeLangCode(e.newValue);
  if (e.key === 'uiLang' && storageLang && storageLang !== lang) {
    // This page may not hold that language yet (/layer-i18n.js): fetch it first.
    const follow = () => { if (i18n[storageLang] && lang !== storageLang) { lang = storageLang; applyTranslations(); } };
    if (i18n[storageLang]) follow();
    else if (window.I18nLoad) window.I18nLoad.ensure([storageLang]).then(follow);
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
  // Flush the structured store on unload. Fire whenever notes are loaded (not
  // only when a typing debounce is pending): a structural edit (create/pin/delete/
  // select) persists via a plain fetch that can be cancelled if the tab closes
  // mid-flight, so the beacon is the reliable backstop for those too.
  if (notesLoaded && notesState && typeof notesState === 'object') {
    clearTimeout(notesSaveTimer);
    try {
      // baseRev lets the server refuse this beacon when the page is stale (it
      // missed newer saves from another surface) — better to drop an unload
      // flush than to overwrite fresher notes with an old snapshot.
      navigator.sendBeacon(
        '/notes/list',
        new Blob([JSON.stringify({ notes: notesState.notes, activeId: notesState.activeId, baseRev: notesRev })], { type: 'application/json' })
      );
    } catch {}
  }
});
