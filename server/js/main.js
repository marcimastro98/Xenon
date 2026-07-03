'use strict';

/*
 * Xenon — Copyright (c) 2026 Marcello Mastroeni (marcimastro98).
 * Custom non-commercial license. Personal use only; no commercial use or
 * redistribution as your own. Attribution required. See LICENSE for terms.
 */

// ── Panel routing ─────────────────────────────────────────────
const panelParam = (new URLSearchParams(window.location.search).get('panel') || '').toLowerCase();
const VALID_PANELS = ['media', 'agenda', 'mic', 'notes', 'tasks', 'system', 'audio'];
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

setInterval(tickClock, 1000);

// Weather and events always use polling (long intervals, no benefit from SSE).
// The weather cadence is user-configurable (Settings → Meteo → aggiornamento);
// startWeatherPolling() is re-callable so a settings change restarts the timer
// without a reload. Exposed globally for updateWeatherRefresh().
let weatherPollTimer = null;
function startWeatherPolling() {
  if (!need.system) return;
  if (weatherPollTimer) clearInterval(weatherPollTimer);
  const ws = (typeof hubSettings !== 'undefined' && hubSettings.weather) ? hubSettings.weather : null;
  const min = Math.max(10, Number(ws && ws.refreshMin) || 30);
  weatherPollTimer = setInterval(fetchWeather, min * 60 * 1000);
}
window.startWeatherPolling = startWeatherPolling;
if (need.system) { fetchWeather(); startWeatherPolling(); }
if (need.events) { loadCalendarEvents(); loadExternalEvents(); setInterval(loadExternalEvents, 5 * 60 * 1000); setInterval(checkReminders, 15000); }
if (need.notes)  { loadNotes(); }
if (need.tasks)  { loadTasks(); }
if (['full', 'agenda'].includes(activePanel)) { if (typeof loadTimers === 'function') loadTimers(); }

// Real-time data (status, media, system, audio) uses Server-Sent Events.
// Falls back to conventional polling if EventSource is unavailable or the
// connection fails (e.g. older server build without /sse support).
(function initDataStream() {
  if (typeof EventSource === 'undefined') {
    startPollingFallback();
    return;
  }

  let es = null;
  let pollFallbackTimers = [];
  let reconnectDelay = 2000;

  function stopPollFallback() {
    if (pollFallbackTimers.length === 0) return;
    for (const id of pollFallbackTimers) clearInterval(id);
    pollFallbackTimers = [];
  }

  function startPollingFallback() {
    if (pollFallbackTimers.length > 0) return;
    if (need.status) { pollStatus();  pollFallbackTimers.push(setInterval(pollStatus,  3000)); }
    if (need.audio)  { fetchAudio();  pollFallbackTimers.push(setInterval(fetchAudio,  5000)); }
    if (need.media)  { fetchMedia();  pollFallbackTimers.push(setInterval(fetchMedia,  2000)); }
    if (need.system) { fetchSystem(); pollFallbackTimers.push(setInterval(fetchSystem, 7000)); }
  }

  function connect() {
    if (es) { try { es.close(); } catch {} }
    es = new EventSource('/sse');

    es.addEventListener('status', e => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      // Each consumer is isolated: a throw in one (e.g. Performance Mode) must NOT
      // skip the others below it (the Game Companion pill stopped updating because
      // it sat after PerfMode in a shared try/catch).
      const step = (fn) => { try { fn(); } catch (err) { /* one consumer's error must not block the rest */ } };
      // applyUI is the mic.js function for mic mute state; setOnline marks connectivity.
      step(() => { if (typeof applyUI === 'function') applyUI(data.muted); });
      step(() => { if (window.StreamingPage && typeof window.StreamingPage.onMic === 'function') window.StreamingPage.onMic(data.muted); });
      step(() => { if (typeof setOnline === 'function') setOnline(); });
      // A partial status event (e.g. a bare {muted} from an older server's SSE
      // connect-seed) carries NO game info — reading `gaming`/`activity` from it
      // would register as "game ended" and hide the Companion pill / confuse
      // Performance Mode. Only feed the game-driven consumers from full payloads.
      const hasGameInfo = (data.gaming != null) || (data.gameRunning != null);
      // Pause ambient FX while a game / intensive app is presenting frames.
      step(() => { if (hasGameInfo && typeof applyGameMode === 'function') applyGameMode(!!data.gaming); });
      // Performance Mode: suggest optimizing on a foreground-activity change.
      step(() => {
        if (!hasGameInfo || !window.PerfMode) return;
        if (typeof window.PerfMode.onStatus === 'function') window.PerfMode.onStatus(data.activity, data.process, data.gameRunning === true);
        else if (typeof window.PerfMode.onGaming === 'function') window.PerfMode.onGaming(!!data.gaming);
      });
      // Game Companion (opt-in): the pill follows the game being RUNNING (alive in
      // foreground OR background), not focused — so tapping the touchscreen doesn't
      // drop it, and it vanishes when the game exits. The name is the game process,
      // never a bystander like iCUE. Falls back to the old field for an older server.
      step(() => {
        if (!hasGameInfo || !window.GameCompanion) return;
        const running = (data.gameRunning != null) ? !!data.gameRunning : !!data.gaming;
        window.GameCompanion.onStatus(running, data.gameProcess || data.process);
      });
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
    es.addEventListener('discord', e => {
      // Live Discord voice state (event-driven, not polled) → the dashboard widget.
      try { if (window.DiscordWidget) window.DiscordWidget.onSSE(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('homeassistant', e => {
      // Live Home Assistant state (event-driven, not polled) → the Smart Home tile.
      try { if (window.SmartHome) window.SmartHome.onSSE(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('guardian_alert', e => {
      // Guardian (opt-in): server-side threshold alert → friendly toast.
      try {
        if (typeof aiFeatureEnabled === 'function' && !aiFeatureEnabled('guardian')) return;
        const d = JSON.parse(e.data);
        const key = d.type === 'gpu' ? 'guardian_alert_gpu' : d.type === 'mem' ? 'guardian_alert_mem' : 'guardian_alert_cpu';
        if (typeof showHubToast === 'function') showHubToast('Guardian', t(key).replace('{v}', d.value), '');
        if (window.Ambient && typeof window.Ambient.onGuardianAlert === 'function') window.Ambient.onGuardianAlert(t(key).replace('{v}', d.value));
      } catch {}
    });
    es.addEventListener('deck', e => {
      // Another open dashboard saved a Deck change — adopt the server copy live,
      // so two clients can never drift apart between reloads.
      try {
        const d = JSON.parse(e.data);
        if (window.Deck && typeof window.Deck.onServerDeckRev === 'function') window.Deck.onServerDeckRev(d.rev);
      } catch {}
    });
    es.addEventListener('obs', e => {
      try {
        const d = JSON.parse(e.data);
        if (window.Deck) window.Deck.refreshStates(d);
        if (window.StreamingPage && typeof window.StreamingPage.onObs === 'function') window.StreamingPage.onObs(d);
        if (window.ObsWidget && typeof window.ObsWidget.onObs === 'function') window.ObsWidget.onObs(d);
        // Performance Mode: a live OBS stream/recording counts as a streaming session.
        if (window.PerfMode && typeof window.PerfMode.onObs === 'function') window.PerfMode.onObs(d);
      } catch {}
    });
    es.addEventListener('streamerbot', e => {
      // Live Streamer.bot global variables — Deck keys bound with an 'sbGlobal'
      // state reflect these (on/off follows the real value). Full map each push, so
      // a wholesale replace of the snapshot's sbGlobals is correct.
      try {
        const d = JSON.parse(e.data);
        if (window.Deck && typeof window.Deck.refreshStates === 'function') window.Deck.refreshStates({ sbGlobals: (d && d.globals) || {} });
        if (window.StreamerbotWidget && typeof window.StreamerbotWidget.onState === 'function') window.StreamerbotWidget.onState(d);
      } catch {}
    });
    es.addEventListener('streamerbot_event', e => {
      // A single new Streamer.bot activity item (follow/sub/raid/cheer/…) → feed.
      try { if (window.StreamerbotWidget && typeof window.StreamerbotWidget.onEvent === 'function') window.StreamerbotWidget.onEvent(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('obs_preview', e => {
      try {
        const d = JSON.parse(e.data);
        if (window.Deck) window.Deck.setScenePreview(d);
        if (window.StreamingPage && typeof window.StreamingPage.onObsPreview === 'function') window.StreamingPage.onObsPreview(d);
        if (window.ObsWidget && typeof window.ObsWidget.onObsPreview === 'function') window.ObsWidget.onObsPreview(d);
      } catch {}
    });
    es.addEventListener('obs_launching', e => {
      try { if (window.Deck) window.Deck.setObsLaunching(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('stt_silence', e => {
      // Server detected the user finished speaking — stop recording right away.
      try {
        const data = JSON.parse(e.data);
        if (typeof window._aiOnSttSilence === 'function') window._aiOnSttSilence(data.id);
      } catch {}
    });
    es.addEventListener('speak_start', () => {
      // The server's voice playback actually began — switch the UI to "speaking".
      if (typeof window._aiOnSpeakStart === 'function') window._aiOnSpeakStart();
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

// ── Remote state for Deck live-state keys ────────────────────
// Deck keys can bind to remoteConnected/remoteActive. /remote/status runs a
// real check (winget + Tailscale CLI + Sunshine HTTP), so it is NOT cheap.
// Therefore: do ONE check at startup and only keep polling if the remote
// feature is actually installed — users who never set up remote control pay
// nothing beyond that single call. Only on the full dashboard (single-panel
// embeds never host a Deck).
if (activePanel === 'full') {
  function applyRemoteSnapshot(st) {
    if (!st || !window.Deck || typeof window.Deck.refreshStates !== 'function') return;
    const remoteConnected = !!(Array.isArray(st.connectedClients) && st.connectedClients.length > 0);
    const remoteActive    = !!(st.ready && !st.blocked);
    window.Deck.refreshStates({ remoteConnected, remoteActive });
  }
  function fetchRemoteStatus() {
    return fetch('/remote/status').then(r => (r.ok ? r.json() : null)).catch(() => null);
  }
  (async () => {
    const st = await fetchRemoteStatus();
    applyRemoteSnapshot(st);
    // If neither tool is installed the feature isn't in use — never start the
    // recurring poll (avoids winget/CLI spawns for users without remote control).
    const installed = st && st.installed && (st.installed.sunshine || st.installed.tailscale);
    if (!installed) return;
    setInterval(() => { fetchRemoteStatus().then(applyRemoteSnapshot); }, 15000);
  })();
}

// ── Init app favorites buttons ───────────────────────────────
renderAppFavorites();

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
    // Use the first visible notes textarea (covers primary + clones).
    const ta = document.querySelector('[data-notesf="area"]');
    if (ta && notesLoaded) {
      try {
        navigator.sendBeacon('/notes', new Blob([JSON.stringify({ text: ta.value })], { type: 'application/json' }));
      } catch {}
    }
  }
});
