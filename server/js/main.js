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
  // First server version seen on this page load. A LATER status event carrying a
  // different version means the server self-updated while this page stayed open
  // (typical for the Xeneon Edge screen) — the stale client JS must reload, or
  // its outdated normalizers can corrupt shared state on its next save (the
  // v3.7→v4 "all widgets full screen" layout corruption).
  let serverVersionSeen = '';
  // Reload FORWARD only, once per version, per tab session. A duplicate/stale
  // OLD server still answering the port (e.g. left running after an update)
  // makes the reported version flip-flop old↔new; reloading toward it would
  // loop forever — the symptom behind issue #78 in the iCUE iframe (whose SSE
  // reconnects often, so the fence is re-evaluated constantly). The
  // sessionStorage floor survives the reload so we never re-act on a jump we
  // already handled; the in-memory flag stops a double reload from several
  // status events arriving in the same tick.
  let versionReloadFired = false;
  const versionParts = (v) => String(v || '').split('.').map(n => parseInt(n, 10) || 0);
  const versionIsNewer = (a, b) => {
    const pa = versionParts(a), pb = versionParts(b);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return true;
      if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
  };
  const versionReloadFloor = () => {
    try { return sessionStorage.getItem('xenon.versionReloadedTo') || ''; } catch { return ''; }
  };

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

    let lastFgProcess = null;
    es.addEventListener('status', e => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      // Each consumer is isolated: a throw in one (e.g. Performance Mode) must NOT
      // skip the others below it (the Game Companion pill stopped updating because
      // it sat after PerfMode in a shared try/catch).
      const step = (fn) => { try { fn(); } catch (err) { /* one consumer's error must not block the rest */ } };
      // applyUI is the mic.js function for mic mute state; setOnline marks connectivity.
      step(() => { if (typeof applyUI === 'function') applyUI(data.muted); });
      // Relay to sandboxed SDK widgets (the bridge forwards only granted streams).
      step(() => { if (window.CustomWidget) window.CustomWidget.onData('status', data); });
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
      // Bit (vitals pet): gaming truce + system-idle presence (idleSec rides the
      // status payload only while the pet is enabled server-side).
      step(() => { if (window.VitalsPet && typeof window.VitalsPet.onStatus === 'function') window.VitalsPet.onStatus(data); });
      // Ambient screensaver: whole-PC idle (idleSec) decides auto-start/dismiss so
      // it never fires while the user is active on another screen (only the
      // dashboard window's own events would otherwise be seen).
      step(() => { if (window.AmbientMode && typeof window.AmbientMode.onStatus === 'function') window.AmbientMode.onStatus(data); });
      // Deck Smart Profiles: auto-switch the shown profile to match the app in
      // focus. Guarded on change here so the 3s status beat costs nothing idle.
      step(() => {
        if (!hasGameInfo || data.process === undefined || data.process === lastFgProcess) return;
        lastFgProcess = data.process;
        if (window.Deck && typeof window.Deck.onForegroundProcess === 'function') window.Deck.onForegroundProcess(data.process);
      });
      // Vitals meters: bootAt is the boot fence — a last-refill stamp older than
      // the server's start reseeds to full (PC-off downtime is not neglect).
      step(() => { if (window.VitalsWidget && typeof window.VitalsWidget.onStatus === 'function') window.VitalsWidget.onStatus(data); });
      // Version fence: reload once when the server updated under this page (see
      // serverVersionSeen above). Deferred — not dropped — while the layout
      // editor is open or the user is typing (notes, chat, a settings field):
      // a reload would kill the gesture / lose the un-flushed text. Status
      // events keep coming every few seconds, so the reload lands as soon as
      // the user pauses.
      step(() => {
        if (!data.version || typeof data.version !== 'string') return;
        if (!serverVersionSeen) { serverVersionSeen = data.version; return; }
        if (data.version === serverVersionSeen) return;
        // Only ever reload toward a strictly NEWER version. A downgrade means a
        // stale/duplicate old server is answering — ignore it (and don't lower
        // the tracked version), or old↔new flip-flops would reload us forever (#78).
        if (!versionIsNewer(data.version, serverVersionSeen)) return;
        serverVersionSeen = data.version;
        // Already reloaded to this version (or newer) earlier this tab session?
        // Then this forward jump is the one we already acted on — don't reload
        // again (this is what actually breaks the iCUE dual-server loop).
        const floor = versionReloadFloor();
        if (floor && !versionIsNewer(data.version, floor)) return;
        if (versionReloadFired) return;
        if (document.body && document.body.classList.contains('layout-editing')) return;
        const ae = document.activeElement;
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
        versionReloadFired = true;
        try { sessionStorage.setItem('xenon.versionReloadedTo', data.version); } catch { /* best-effort */ }
        location.reload();
      });
    });
    es.addEventListener('media', e => {
      try {
        const d = JSON.parse(e.data);
        applyMedia(d);
        // Deck keys bound to mediaPlaying/spotifyPlaying follow the live stream.
        if (window.Deck) window.Deck.refreshStates({
          mediaPlaying: !!(d && d.active && d.playbackStatus === 'Playing'),
          mediaSource: (d && d.app) || '',
        });
        // Relay to sandboxed SDK widgets (the bridge forwards only granted streams).
        if (window.CustomWidget) window.CustomWidget.onData('media', d);
      } catch {}
    });
    es.addEventListener('system', e => {
      try {
        const d = JSON.parse(e.data);
        applySystem(d);
        if (window.CustomWidget) window.CustomWidget.onData('system', d);
      } catch {}
    });
    es.addEventListener('audio', e => {
      try {
        const d = JSON.parse(e.data);
        applyAudio(d);
        // Deck volume sliders track the live master volume while idle.
        if (window.Deck && d && d.speaker && Number.isFinite(Number(d.speaker.volume))) {
          window.Deck.refreshStates({ masterVolume: Number(d.speaker.volume) });
        }
        if (window.CustomWidget) window.CustomWidget.onData('audio', d);
      } catch {}
    });
    es.addEventListener('discord', e => {
      // Live Discord voice state (event-driven, not polled) → the dashboard widget
      // and the Deck snapshot (keys bound to discordMuted/discordDeafened).
      try {
        const d = JSON.parse(e.data);
        if (window.DiscordWidget) window.DiscordWidget.onSSE(d);
        if (window.Deck) window.Deck.refreshStates({
          discordMuted: !!(d && d.voice && d.voice.mute),
          discordDeafened: !!(d && d.voice && d.voice.deaf),
          discordInputVolume: (d && d.voice && Number.isFinite(d.voice.inputVolume)) ? d.voice.inputVolume : NaN,
          discordOutputVolume: (d && d.voice && Number.isFinite(d.voice.outputVolume)) ? d.voice.outputVolume : NaN,
        });
        if (window.CustomWidget) window.CustomWidget.onData('discord', d);
      } catch {}
    });
    es.addEventListener('discord_notification', e => {
      // A single mirrored Discord notification (DM/mention) → the widget's feed.
      try { if (window.DiscordWidget && typeof window.DiscordWidget.onNotification === 'function') window.DiscordWidget.onNotification(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('homeassistant', e => {
      // Live Home Assistant state (event-driven, not polled) → the Smart Home tile.
      try { const d = JSON.parse(e.data); if (window.SmartHome) window.SmartHome.onSSE(d); if (window.CustomWidget) window.CustomWidget.onData('homeassistant', d); } catch {}
    });
    es.addEventListener('ha_states', e => {
      // Live states for the HA entities Deck keys are bound to (the server
      // watches only the entity set the deck subscribed via /ha/deck-watch).
      try {
        const d = JSON.parse(e.data);
        if (window.Deck) window.Deck.refreshStates({ haStates: (d && d.states) || {} });
      } catch {}
    });
    es.addEventListener('wavelink', e => {
      // Live Wave Link mixer state → the Wave Link tile AND sandboxed SDK widgets
      // (the bridge forwards it only to packages granted the `wavelink` stream).
      try {
        const d = JSON.parse(e.data);
        if (window.WaveLinkWidget) window.WaveLinkWidget.onSSE(d);
        if (window.CustomWidget) window.CustomWidget.onData('wavelink', d);
      } catch {}
    });
    es.addEventListener('stocks', e => {
      // Live stock quotes → the Borsa widget and the ticker bar.
      try {
        const d = JSON.parse(e.data);
        if (window.StockWidget) window.StockWidget.onSSE(d);
        if (window.Ticker) window.Ticker.onStocks(d);
        if (window.CustomWidget) window.CustomWidget.onData('stocks', d);
      } catch {}
    });
    es.addEventListener('stocks_alert', e => {
      // A watched symbol crossed ±alertPercent → a toast (gated by the master
      // Notifiche switch, like every other pop-up). The server handles the LED.
      try {
        const d = JSON.parse(e.data);
        const master = (typeof hubSettings === 'object' && hubSettings && hubSettings.notifications) || null;
        if (master && (master.enabled === false || master.popups === false)) return;
        if (!window.XenonToast) return;
        const pct = (Number(d.changePct) >= 0 ? '+' : '') + (Number(d.changePct) || 0).toFixed(2) + '%';
        const arrow = d.dir === 'up' ? '▲' : '▼';
        window.XenonToast.show({
          type: 'notification',
          kicker: t('stocks_alert_kicker', 'Borsa'),
          title: (d.name || d.symbol) + '  ' + arrow + ' ' + pct,
          message: d.dir === 'up' ? t('stocks_alert_up', 'Up sharply today') : t('stocks_alert_down', 'Down sharply today'),
          duration: 6000,
        });
      } catch {}
    });
    es.addEventListener('unifi_event', e => {
      // A UniFi Protect camera detected something (person/vehicle/motion/ring). The
      // tile badge flashes regardless (the server only emits this when the user
      // enabled camera notifications); the toast pop-up is additionally gated by the
      // master Notifiche switch, like every other pop-up.
      try {
        const d = JSON.parse(e.data);
        if (window.UnifiProtect && typeof window.UnifiProtect.onNotification === 'function') window.UnifiProtect.onNotification(d);
        const master = (typeof hubSettings === 'object' && hubSettings && hubSettings.notifications) || null;
        if (master && (master.enabled === false || master.popups === false)) return;
        if (!window.XenonToast) return;
        // The kind→label map lives in unifi-widget.js (NOTIFY_KINDS) — one source.
        const title = (window.UnifiProtect && window.UnifiProtect.kindLabel)
          ? window.UnifiProtect.kindLabel(d.kind) : String(d.kind || '');
        window.XenonToast.show({
          type: 'notification',
          kicker: t('unifi_notify_kicker', 'Cameras'),
          title,
          message: d.name || d.camId,
          duration: 6000,
        });
      } catch {}
    });
    es.addEventListener('football', e => {
      // Live fixtures/results for the favorite teams → the Calcio widget. The
      // widget feeds the ticker itself (it composes the score chips).
      try { const d = JSON.parse(e.data); if (window.FootballWidget) window.FootballWidget.onSSE(d); if (window.CustomWidget) window.CustomWidget.onData('football', d); } catch {}
    });
    es.addEventListener('claude', e => {
      // Local Claude Code usage aggregate → the Xenon Pulse reactor widget.
      try { const d = JSON.parse(e.data); if (window.ClaudeWidget) window.ClaudeWidget.onSSE(d); if (window.CustomWidget) window.CustomWidget.onData('claude', d); } catch {}
    });
    es.addEventListener('football_alert', e => {
      // A followed team scored or the match ended → a toast (gated by the master
      // Notifiche switch). The server handles the LED reaction.
      try {
        const d = JSON.parse(e.data);
        const master = (typeof hubSettings === 'object' && hubSettings && hubSettings.notifications) || null;
        if (master && (master.enabled === false || master.popups === false)) return;
        if (!window.XenonToast) return;
        const score = (d.homeScore != null && d.awayScore != null) ? d.home + ' ' + d.homeScore + '–' + d.awayScore + ' ' + d.away : d.home + ' vs ' + d.away;
        window.XenonToast.show({
          type: 'notification',
          kicker: t('football_alert_kicker', 'Calcio'),
          title: score,
          message: d.status === 'ft' ? t('football_alert_ft', 'Full time') : t('football_alert_goal', 'Score update'),
          duration: 6000,
        });
      } catch {}
    });
    es.addEventListener('news', e => {
      // Merged headlines → the News widget (which feeds the ticker itself).
      try { const d = JSON.parse(e.data); if (window.NewsWidget) window.NewsWidget.onSSE(d); if (window.CustomWidget) window.CustomWidget.onData('news', d); } catch {}
    });
    // Tasks / calendar events: broadcast on save, consumed only by granted SDK
    // widgets (the dashboard's own tiles keep their local state). Notes ALSO
    // live-sync the real notes widget: without it a long-lived surface (the
    // Xeneon Edge kiosk) showed its boot-time snapshot forever (GitHub #72).
    es.addEventListener('tasks', e => { try { if (window.CustomWidget) window.CustomWidget.onData('tasks', JSON.parse(e.data)); } catch {} });
    es.addEventListener('notes', e => {
      try {
        const d = JSON.parse(e.data);
        if (typeof onNotesServerPush === 'function') onNotesServerPush(d);
        if (window.CustomWidget) window.CustomWidget.onData('notes', d);
      } catch {}
    });
    es.addEventListener('agenda', e => { try { if (window.CustomWidget) window.CustomWidget.onData('agenda', JSON.parse(e.data)); } catch {} });
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
    es.addEventListener('briefing', e => {
      // Proactive moment (game-session recap / sustained-thermal alert). The
      // server gates each type on its Settings toggle before broadcasting.
      try {
        if (window.Ambient && typeof window.Ambient.onBriefingMoment === 'function') window.Ambient.onBriefingMoment(JSON.parse(e.data));
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
    es.addEventListener('settings', e => {
      // Another surface (Edge screen / browser / native app) saved the settings —
      // re-hydrate when the rev is newer than ours, so surfaces stay in sync live
      // instead of clobbering each other's whole-blob saves between reloads.
      try {
        const d = JSON.parse(e.data);
        if (typeof window._onServerSettingsRev === 'function') window._onServerSettingsRev(d.rev);
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
        if (window.CustomWidget) window.CustomWidget.onData('obs', d);
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
        if (window.CustomWidget) window.CustomWidget.onData('streamerbot', d);
      } catch {}
    });
    es.addEventListener('streamerbot_event', e => {
      // A single new Streamer.bot activity item (follow/sub/raid/cheer/…) → feed.
      try { if (window.StreamerbotWidget && typeof window.StreamerbotWidget.onEvent === 'function') window.StreamerbotWidget.onEvent(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('sdk_hook', e => {
      // Local webhook event for an SDK widget (POST /sdk/hook/<pkg>/<id>) — the
      // custom-widget host forwards it only to granted frames of that package.
      try { if (window.CustomWidget && typeof window.CustomWidget.onHook === 'function') window.CustomWidget.onHook(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('sdk_handler', e => {
      // A deck key bound to a widget handler was pressed — deliver the call to
      // the package's live frames; the first ack resolves the parked key press.
      try { if (window.CustomWidget && typeof window.CustomWidget.onHandler === 'function') window.CustomWidget.onHandler(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('windows_notifications', e => {
      // Windows notification mirror: reader state change / full feed replacement.
      try { if (window.NotificationsWidget && typeof window.NotificationsWidget.onState === 'function') window.NotificationsWidget.onState(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('windows_notification', e => {
      // A single new Windows toast → prepend to the Notifications tile feed.
      try { if (window.NotificationsWidget && typeof window.NotificationsWidget.onItem === 'function') window.NotificationsWidget.onItem(JSON.parse(e.data)); } catch {}
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
    es.addEventListener('wake', () => {
      // The server heard "Hey Xenon" — open the voice session (no-op when one
      // is already live; the server-side 409 guard covers multi-tab races).
      if (typeof window._aiHandleWake === 'function') window._aiHandleWake();
    });
    es.addEventListener('speak_start', () => {
      // The server's voice playback actually began — switch the UI to "speaking".
      if (typeof window._aiOnSpeakStart === 'function') window._aiOnSpeakStart();
    });
    es.addEventListener('timer_update', e => {
      try {
        const data = JSON.parse(e.data);
        if (typeof onTimerUpdate === 'function') onTimerUpdate(data.timers);
        // Deck snapshot: timers keyed by label (shared projection in deck-model,
        // so the dashboard and the Virtual Deck popup count down identically).
        if (window.Deck && window.DeckModel && window.DeckModel.timersByLabel) {
          window.Deck.refreshStates({ timers: window.DeckModel.timersByLabel(data.timers) });
        }
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
      // A `settings` broadcast may have fired while we were disconnected — SSE
      // has no replay, so pull the current server rev and reconcile if we fell
      // behind. Fixes the native app showing stale/default settings (and a dead
      // ticker) after its stream dropped during a backend restart (issue #72).
      if (typeof window._reconcileSettingsAfterReconnect === 'function') {
        window._reconcileSettingsAfterReconnect();
      }
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
    // The check spawns winget/Tailscale/Sunshine processes server-side, so don't
    // run it while the tab is hidden — nobody's watching the remote-state pill.
    setInterval(() => { if (!document.hidden) fetchRemoteStatus().then(applyRemoteSnapshot); }, 15000);
  })();
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
    if (document.body.classList.contains('layout-editing') && typeof setDashboardLayoutEditMode === 'function') {
      e.preventDefault();
      setDashboardLayoutEditMode(false);
      return;
    }
    if (window.AmbientMode && AmbientMode.isOpen()) {
      e.preventDefault();
      AmbientMode.close();
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
