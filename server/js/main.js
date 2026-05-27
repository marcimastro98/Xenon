'use strict';

// ── Panel routing ─────────────────────────────────────────────
const panelParam = (new URLSearchParams(window.location.search).get('panel') || '').toLowerCase();
const VALID_PANELS = ['media', 'mic', 'notes', 'tasks', 'system', 'audio'];
const activePanel = VALID_PANELS.includes(panelParam) ? panelParam : 'full';
if (activePanel !== 'full') document.body.dataset.panel = activePanel;

// ── Initial render ────────────────────────────────────────────
tickClock();
applyTranslations();
initAllCustomSelects();
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
  tasks:  ['full', 'media', 'tasks'].includes(activePanel),
};

setInterval(tickClock, 1000);

// Weather and events always use polling (long intervals, no benefit from SSE).
if (need.system) { fetchWeather(); setInterval(fetchWeather, 30 * 60 * 1000); }
if (need.events) { loadCalendarEvents(); setInterval(checkReminders, 15000); }
if (need.notes)  { loadNotes(); }
if (need.tasks)  { loadTasks(); }
if (['full', 'media'].includes(activePanel)) { if (typeof loadTimers === 'function') loadTimers(); }

// Real-time data (status, media, system, audio) uses Server-Sent Events.
// Falls back to conventional polling if EventSource is unavailable or the
// connection fails (e.g. older server build without /sse support).
(function initDataStream() {
  if (typeof EventSource === 'undefined') {
    startPollingFallback();
    return;
  }

  let es = null;
  let pollFallbackTimer = null;
  let reconnectDelay = 2000;

  function stopPollFallback() {
    if (pollFallbackTimer) { clearInterval(pollFallbackTimer); pollFallbackTimer = null; }
  }

  function startPollingFallback() {
    if (pollFallbackTimer) return;
    if (need.status) { pollStatus(); pollFallbackTimer = setInterval(pollStatus, 3000); }
    if (need.audio)  fetchAudio();
    if (need.media)  fetchMedia();
    if (need.system) fetchSystem();
    if (!need.status && !need.audio && !need.media && !need.system) return;
    if (!pollFallbackTimer) {
      if (need.audio)  setInterval(fetchAudio,  5000);
      if (need.media)  setInterval(fetchMedia,  2000);
      if (need.system) setInterval(fetchSystem, 7000);
    }
  }

  function connect() {
    if (es) { try { es.close(); } catch {} }
    es = new EventSource('/sse');

    es.addEventListener('status', e => {
      try {
        const data = JSON.parse(e.data);
        // applyUI is the mic.js function for mic mute state; setOnline marks connectivity.
        if (typeof applyUI === 'function') { applyUI(data.muted); }
        if (typeof setOnline === 'function') setOnline();
      } catch {}
    });
    es.addEventListener('media', e => {
      try { applyMedia(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('system', e => {
      try { applySystem(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('audio', e => {
      try { applyAudio(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('wake_word', () => {
      if (typeof window._aiWakeWordTrigger === 'function') window._aiWakeWordTrigger();
    });
    es.addEventListener('stt_silence', e => {
      // Server detected the user finished speaking — stop recording right away.
      try {
        const data = JSON.parse(e.data);
        if (typeof window._aiOnSttSilence === 'function') window._aiOnSttSilence(data.id);
      } catch {}
    });
    es.addEventListener('stop_session', () => {
      // Wake word loop heard a dismissal word ("stop", "basta"…) — end voice session.
      if (typeof _aiStopSpeaking    === 'function') _aiStopSpeaking();
      if (typeof _aiEndVoiceSession === 'function') _aiEndVoiceSession();
      fetch('/api/volume/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    });
    es.addEventListener('timer_update', e => {
      try {
        const data = JSON.parse(e.data);
        if (typeof onTimerUpdate === 'function') onTimerUpdate(data.timers);
      } catch {}
    });
    es.addEventListener('timer_done', e => {
      try {
        const data = JSON.parse(e.data);
        if (typeof onTimerDone === 'function') onTimerDone(data.id, data.label);
      } catch {}
    });

    es.onopen = () => {
      reconnectDelay = 2000;
      stopPollFallback();
    };

    es.onerror = () => {
      // On error EventSource auto-reconnects, but if we get repeated failures
      // fall back to polling so the UI never stays stale.
      if (es.readyState === EventSource.CLOSED) {
        startPollingFallback();
        setTimeout(() => { stopPollFallback(); connect(); }, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
      }
    };
  }

  // Trigger an immediate fetch for each needed data type so the UI is populated
  // before the first SSE push arrives.
  if (need.status) pollStatus();
  if (need.audio)  fetchAudio();
  if (need.media)  fetchMedia();
  if (need.system) fetchSystem();

  connect();
}());

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
  const storageLang = normalizeLangCode(e.newValue);
  if (e.key === 'uiLang' && storageLang && storageLang !== lang && i18n[storageLang]) {
    lang = storageLang;
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
