'use strict';

/**
 * modules/app.js — Main lifecycle wiring, iCUE event bridge and hybrid server bridge.
 *
 * Load order (enforced by index.html / loader.js):
 *   common/plugins/* → state → i18n → storage → ui → clock
 *   → calendar → notes → sensors → media → app  ← THIS FILE
 *
 * Hybrid model:
 *   - Always uses iCUE SDK for sensors (title/artist, hardware sensors).
 *   - When local server is reachable, enriches with: mic mute, audio volume,
 *     artwork, exact system stats, network, notes/events sync.
 *   - Features requiring the server show a disabled overlay + settings link when offline.
 */
(function () {
  const Hub = window.XenonEdgeHub;

  // Polling intervals
  const INTERVAL_SERVER_CHECK  = 30 * 1000; // recheck server every 30 s
  const INTERVAL_MEDIA_ICUE    =  5 * 1000; // iCUE media poll (offline mode)
  const INTERVAL_SERVER_DATA   =  5 * 1000; // server full refresh
  const INTERVAL_REMINDER      = 30 * 1000; // calendar reminder check

  let _intervalServerCheck = null;
  let _intervalServerData  = null;
  let _intervalMediaIcue   = null;
  let _intervalReminder    = null;

  // ── iCUE event bridge ─────────────────────────────────────────────────────
  // Bare assignment — do NOT prefix with var/let/const.
  // If iCUE evaluates this in a sandboxed Function() context, a declared
  // variable stays local and window.icueEvents is never set.
  icueEvents = {
    onICUEInitialized: _onIcueInitialized,
    onDataUpdated:     _onIcueDataUpdated
  };

  function _onIcueInitialized () {
    // Detect and apply UI language before any DOM text is rendered
    Hub.setLang(Hub.detectLang());
    _onIcueDataUpdated();
    _boot();
  }

  function _onIcueDataUpdated () {
    const prevUrl = Hub.state.serverUrl;
    Hub.readProps();
    Hub.applyAppearance();
    // Re-bind sensors in case the user changed a sensor combobox
    Hub.bindSensors();
    // If the server URL changed, re-check connectivity immediately instead of
    // waiting for the next 30-second poll cycle.
    if (Hub.state.serverUrl !== prevUrl) _checkServer();
  }

  // ── Plugin initialisation ─────────────────────────────────────────────────

  // Wire up Sensorsdataprovider
  pluginSensorsdataproviderEvents = {
    onInitialized: _onSensorsReady
  };
  // Catch the case where plugin was already initialised before this script ran
  if (typeof pluginSensorsdataprovider_initialized !== 'undefined' && pluginSensorsdataprovider_initialized) {
    _onSensorsReady();
  }

  function _onSensorsReady () {
    Hub.log('app', 'Sensorsdataprovider ready');
    const provider = window.plugins && window.plugins.Sensorsdataprovider;
    if (!provider) return;
    Hub.state.sensorWrapper = new SimpleSensorApiWrapper(provider, 5000);
    Hub.connectSensorSignals();
    Hub.bindSensors();
  }

  // Wire up Mediadataprovider
  pluginMediadataproviderEvents = {
    onInitialized: _onMediaReady
  };
  if (typeof pluginMediadataprovider_initialized !== 'undefined' && pluginMediadataprovider_initialized) {
    _onMediaReady();
  }

  function _onMediaReady () {
    Hub.log('app', 'Mediadataprovider ready');
    const provider = window.plugins && window.plugins.Mediadataprovider;
    if (!provider) return;
    Hub.state.mediaWrapper = new SimpleMediaApiWrapper(provider, 5000);
    Hub.refreshMediaState();
  }

  // ── Boot sequence ─────────────────────────────────────────────────────────

  async function _boot () {
    Hub.state.calendarViewDate = new Date();
    Hub.startClock();
    Hub.loadEvents();
    Hub.loadNotes();
    if (Hub.initLayoutCustomization) Hub.initLayoutCustomization();
    Hub.applyTranslations();
    Hub.renderUpcoming();
    Hub.renderMicState();
    Hub.renderAudioState();
    Hub.showNetworkOffline();

    // Initial server check
    await _checkServer();

    // Start polling cycles
    _intervalServerCheck = setInterval(_checkServer, INTERVAL_SERVER_CHECK);
    _intervalReminder    = setInterval(Hub.checkReminders, INTERVAL_REMINDER);
    Hub.checkReminders();
  }

  // ── Server hybrid ─────────────────────────────────────────────────────────

  async function _checkServer () {
    const wasOnline  = Hub.state.serverOnline;
    const online     = await _pingServer();
    Hub.state.serverOnline = online;
    Hub.updateServerBadge();

    if (online && !wasOnline) {
      Hub.log('app', 'server came online → full refresh');
      _startServerPolling();
      await _serverFullRefresh();
    } else if (!online && wasOnline) {
      Hub.log('app', 'server went offline → iCUE-only mode');
      _stopServerPolling();
      _startIcueMediaPolling();
      Hub.renderMicState();
      Hub.renderAudioState();
      Hub.showNetworkOffline();
    } else if (!online) {
      // Still offline — ensure iCUE polling is running
      _startIcueMediaPolling();
      Hub.renderMicState();
      Hub.renderAudioState();
    }
  }

  async function _pingServer () {
    // Use Image() instead of fetch() to probe server availability.
    // In Qt WebEngine (iCUE's rendering engine), LocalContentCanAccessRemoteUrls
    // is false by default, which silently blocks fetch()/XHR from file:// contexts.
    // Image subresource loads use a different code path and are not blocked.
    return new Promise(function (resolve) {
      var img    = new Image();
      var timer  = setTimeout(function () { img.src = ''; resolve(false); }, 2500);
      img.onload = function () { clearTimeout(timer); resolve(true); };
      img.onerror = function () { clearTimeout(timer); resolve(false); };
      // Cache-bust so the browser always makes a real network request
      img.src = Hub.state.serverUrl + '/ping?' + Date.now();
    });
  }

  async function _fetchJson (path) {
    // fetch() is blocked by Qt WebEngine LocalContentCanAccessRemoteUrls.
    // Use JSONP via dynamic <script> injection as a fallback.
    // The server wraps JSON in a callback: ?cb=XEH_<n>({"key":"val"})
    return new Promise(function (resolve) {
      var cbName = 'XEH_cb_' + (Date.now() % 1e9);
      var script = document.createElement('script');
      var timer  = setTimeout(function () {
        cleanup();
        resolve(null);
      }, 3000);

      function cleanup () {
        try { delete window[cbName]; } catch (_) {}
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      window[cbName] = function (data) {
        clearTimeout(timer);
        cleanup();
        resolve(data);
      };

      script.onerror = function () { clearTimeout(timer); cleanup(); resolve(null); };
      script.src = Hub.state.serverUrl + path +
        (path.indexOf('?') >= 0 ? '&' : '?') + 'cb=' + cbName;
      document.head.appendChild(script);
    });
  }

  async function _serverFullRefresh () {
    await Promise.allSettled([
      Hub.fetchMediaFromServer(),
      Hub.fetchAudioFromServer(),
      Hub.fetchMicStateFromServer(),
      _fetchSystemFromServer(),
      _fetchNetworkFromServer(),
      Hub.syncEventsFromServer(),
      Hub.initNotes()
    ]);
    if (Hub.state.calendarMode) Hub.renderCalendar();
    Hub.renderUpcoming();
  }

  function _startServerPolling () {
    if (_intervalServerData) return;
    _stopIcueMediaPolling();
    _intervalServerData = setInterval(async () => {
      if (!Hub.state.serverOnline) return;
      await Promise.allSettled([
        Hub.fetchMediaFromServer(),
        Hub.fetchMicStateFromServer(),
        _fetchSystemFromServer(),
        _fetchNetworkFromServer()
      ]);
    }, INTERVAL_SERVER_DATA);
  }

  function _stopServerPolling () {
    clearInterval(_intervalServerData);
    _intervalServerData = null;
  }

  function _startIcueMediaPolling () {
    if (_intervalMediaIcue) return;
    Hub.refreshMediaState();
    _intervalMediaIcue = setInterval(Hub.refreshMediaState, INTERVAL_MEDIA_ICUE);
  }

  function _stopIcueMediaPolling () {
    clearInterval(_intervalMediaIcue);
    _intervalMediaIcue = null;
  }

  // ── Server data fetchers ──────────────────────────────────────────────────

  // Expose JSONP helper for other modules (media.js, storage.js, notes.js)
  Hub.fetchJson = _fetchJson;

  async function _fetchSystemFromServer () {
    try {
      const data = await _fetchJson('/system');
      if (data) Hub.renderSystemFromServer(data);
    } catch (_) { /* ignore */ }
  }

  async function _fetchNetworkFromServer () {
    try {
      const data = await _fetchJson('/network');
      if (data) Hub.renderNetworkFromServer(data);
    } catch (_) { /* ignore */ }
  }

  // ── Public UI handlers (called from HTML) ─────────────────────────────────

  // Calendar
  window.showCalendar      = (show)  => Hub.showCalendar(show);
  window.moveCalendarMonth = (delta) => Hub.moveCalendarMonth(delta);
  window.jumpCalendarToday = ()      => Hub.jumpCalendarToday();
  window.openDayModal      = (date)  => Hub.openDayModal(date);
  window.closeDayModal     = ()      => Hub.closeDayModal();
  window.saveCalendarEvent = ()      => Hub.saveCalendarEvent();
  window.deleteEvent       = (id)    => Hub.deleteEvent(id);
  window.dismissReminderToast = ()   => Hub.dismissReminderToast();

  // Notes
  window.onNotesInput = (value) => Hub.onNotesInput(value);

  // Media
  window.mediaAction = (action) => Hub.mediaAction(action);

  // Mic
  window.handleMicTap     = ()      => Hub.toggleMicMute();
  window.onMicVolumeInput = (value) => Hub.setMicVolume(Number(value));

  // Audio
  window.toggleSpeakerMute = () => Hub.toggleSpeakerMute();
  window.onSliderInput     = (value) => Hub.setSpeakerVolume(Number(value));
  window.openAudioSettings = () => Hub.tryOpenLink('ms-settings:sound');

  // System
  window.setSystemTab = (tab)  => Hub.setSystemTab(tab);
  window.cycleDisk    = ()     => Hub.cycleDisk();

  // Layout customisation
  window.toggleLayoutEditor = () => Hub.toggleLayoutEditor();

  // Language
  window.setLang = (lang) => Hub.setLang(lang);

  // ── Browser fallback (dev mode without iCUE) ─────────────────────────────
  if (typeof iCUE_initialized !== 'undefined' && iCUE_initialized) {
    _onIcueInitialized();
  } else {
    _onIcueDataUpdated();
    _boot();
  }
}());
