'use strict';

/**
 * modules/state.js — Global namespace, shared state and utility helpers.
 * Must be the first project module loaded.
 */
(function () {
  window.XenonEdgeHub = window.XenonEdgeHub || {};
  const Hub = window.XenonEdgeHub;

  // ── Shared state ──────────────────────────────────────────────────────────

  Hub.state = {
    // iCUE sensor IDs resolved from property comboboxes
    sensorIds: {
      cpuLoad: '', cpuTemp: '',
      gpuLoad: '', gpuTemp: '', gpuMemLoad: '',
      ramLoad: '', diskTemp: '',
      netUp:   '', netDown: ''
    },

    // Latest sensor values (raw strings from iCUE or server)
    sensors: {
      cpuLoad: null, cpuTemp: null,
      gpuLoad: null, gpuTemp: null, gpuMemLoad: null,
      ramLoad: null, diskTemp: null,
      netUp:   null, netDown: null
    },

    // Device names resolved once after plugin init
    cpuName: '', gpuName: '', ramTotalBytes: 0,

    // Media state — filled by iCUE SDK (title/artist) + server (rest)
    media: {
      active: false, title: '', artist: '',
      album: '', app: '', thumbnail: '', playbackStatus: 'Paused'
    },

    // Plugin wrapper instances (set in app.js after plugin init)
    sensorWrapper: null,
    mediaWrapper:  null,

    // Audio — requires server; disabled in iCUE-only mode
    audio: {
      speakerVolume: 50, speakerMuted: false,
      micVolume:     50, micMuted:     false,
      speakerName:   '',  micName:      ''
    },

    // Persistent data (localStorage)
    notes: '',
    events: [],

    // Dashboard layout customisation (filled by modules/layout.js)
    layout: {
      editMode: false,
      widgets: {},
      cards: { main: {}, net: {} },
      tabs: { order: ['main', 'net'], active: 'main' }
    },

    // Calendar UI state
    calendarViewDate:     null,
    selectedCalendarDate: null,
    modalDateValue:       null,
    calendarLoaded:       false,
    calendarMode:         false,
    calendarAutoShown:    false,
    toastTimer:           null,

    // System data from server
    disksData:       [],
    currentDiskIdx:  0,
    networkData:     {},
    systemData:      {},

    // Server hybrid config
    serverUrl:    'http://localhost:3030',
    serverOnline: false,

    // iCUE behaviour properties
    use24h:      true,
    showSeconds: false,

    // Uptime
    startTime: Date.now()
  };

  // ── Utility helpers ───────────────────────────────────────────────────────

  /**
   * Clamps a number to [0, 100] and rounds to integer.
   * Handles comma-as-decimal-separator (e.g. "78,3").
   */
  Hub.clampPercent = function (v) {
    const n = parseFloat(String(v != null ? v : '').replace(',', '.'));
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n)));
  };

  /** Parses a sensor value string to float, handles "," decimal separator. */
  Hub.toNumber = function (v) {
    if (typeof v === 'number') return v;
    return parseFloat(String(v != null ? v : '').replace(',', '.')) || 0;
  };

  /**
   * Reads an iCUE-injected property by name.
   * iCUE may run the widget in a sandboxed Function() context where injected
   * properties are local variables, not window properties — so we need both paths.
   */
  Hub.getIcueProp = function (name) {
    // Path 1: window property (most environments)
    if (typeof window !== 'undefined' && Object.prototype.hasOwnProperty.call(window, name)) {
      const v = window[name];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    // Path 2: sandboxed function context
    try {
      // eslint-disable-next-line no-new-func
      const v = Function('return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')();
      if (v !== undefined && v !== null && v !== '') return v;
    } catch (_) { /* ignore */ }
    return undefined;
  };

  /** Clamps value to [min, max]; returns defaultVal if not finite. */
  Hub.clampRange = function (v, min, max, defaultVal) {
    const n = Number(v);
    if (!Number.isFinite(n)) return defaultVal;
    return Math.max(min, Math.min(max, n));
  };

  /** Formats bytes to human-readable string (GB / MB). */
  Hub.formatBytes = function (bytes) {
    if (!bytes) return '';
    const gb = bytes / (1024 ** 3);
    if (gb >= 1) return gb.toFixed(1) + ' GB';
    return (bytes / (1024 ** 2)).toFixed(0) + ' MB';
  };

  /** Returns a YYYY-MM-DD string for a Date (local time). */
  Hub.toDateValue = function (date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  /** Returns "YYYY-MM-DDTHH:mm" local datetime string. */
  Hub.toLocalDateTimeValue = function (date) {
    return Hub.toDateValue(date) + 'T' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
  };

  /** Combines a date string "YYYY-MM-DD" and time string "HH:mm" into a Date. */
  Hub.combineDateTime = function (dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    return new Date(dateStr + 'T' + timeStr);
  };

  // ── Debug helpers ─────────────────────────────────────────────────────────

  /** Set window.__XEH_DEBUG = true to enable verbose logging. */
  Hub.log = function (tag, ...args) {
    if (window.__XEH_DEBUG) console.log(`[XEH/${tag}]`, ...args);
  };

  Hub.warn = function (tag, ...args) {
    if (window.__XEH_DEBUG) console.warn(`[XEH/${tag}]`, ...args);
  };

  /** Dumps all sensor IDs and current bindings to the console. */
  Hub.debugSensors = function () {
    console.log('[XEH/sensors] current bindings:', Hub.state.sensorIds);
    console.log('[XEH/sensors] latest values:', Hub.state.sensors);
  };
}());
