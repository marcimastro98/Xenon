// What Performance Mode remembers while the page runs, the app a session is for, and who listens
// for a change of activity.
'use strict';

(() => {
  const state = {
    _sheetEl: null,
    _suppressBanner: false, // "don't ask again" for this page session
    _snoozedActivities: new Set(), // already asked: not again until the game closes or a settings change
    _lastActivity: 'other', // last foreground activity we reacted to (transition tracking)
    _reevaluate: true,      // weigh the next activity even if it did not change (load, refresh())
    _lastActivityProcess: '', // bare process name of the last non-'other' activity (priority target)
    _lastServerActivity: 'other', // last raw status payload, so onObs can re-classify
    _lastProcess: '',
    _gameRunning: false,    // server-side PID liveness: false = the game truly exited
    _gameProcess: '',       // the running game's bare process name, from the server
    _obsStreaming: false,   // live OBS streaming/recording flag (via the obs SSE event)
    _autoRestoreTimer: null, // pending auto-restore once an auto session's activity ends
    _sheetWindows: [],      // windows listed on the open sheet (for choice learning)
    _sheetStats: null,      // process stats snapshot behind the open sheet (for impact)
    _sheetMeta: { by: 'manual' }, // how the open sheet was triggered: manual, or auto (then it auto-restores)
    _stateSig: '',
    _stalePoll: null,
    _staleRecheck: null,
    _idleSince: 0,
    _idleTimer: null,
    _suggesting: false,
  };

  const tr = (key, fallback) => (typeof t === 'function' && t(key)) || fallback;

  // The page that shows this mode when it is not a dashboard (driver-perf.js).
  const surface = () => window.PerfModeSurface || null;
  // Periodic checks run on the surface someone looks at. The driver page is
  // hidden by design and is the only owner while there is no dashboard.
  const nobodyLooking = () => !surface() && document.hidden;

  // The power plan, process priority and the background app list exist only on
  // Windows. Anything else would only come back as a failure. XenonPlatform is ''
  // until the server has said.
  const windowsLevers = () => !window.XenonPlatform || window.XenonPlatform === 'win32';
  const closesApps = (p) => p.opts.manageApps && windowsLevers();

  function _procKey(name) {
    return String(name || '').toLowerCase().trim().replace(/\.exe$/, '');
  }

  // The game while one runs: the last activity app may be the editor someone Alt-Tabbed to.
  const _boostTarget = () => (state._gameRunning && state._gameProcess) || state._lastActivityProcess;

  function _fmtMB(mb) {
    return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB';
  }

  function _cancelAutoRestore() {
    if (state._autoRestoreTimer) { clearTimeout(state._autoRestoreTimer); state._autoRestoreTimer = null; }
  }

  function _idleEligible(p) {
    return !!(p.active && p.activatedBy === 'manual' && !(p.applied && p.applied.boostedProc));
  }

  function _busyNow(p) {
    if (state._gameRunning) return true;
    return state._lastActivity !== 'other' && !!(p.autoActivities && p.autoActivities[state._lastActivity]);
  }

  // React to a (classified) activity transition. In 'suggest' mode this shows
  // the question; in 'auto' mode it applies the safe tweaks directly, or opens the
  // confirmation sheet when app-closing is enabled (a real choice to make). Auto
  // sessions also retire themselves: when their activity ends (and no other
  // enabled one took over), everything is restored after a grace period.
  // Subscribers notified on every CLASSIFIED activity transition, regardless of
  // whether the optimizer itself acts (Smart context profiles hooks in here so
  // there is a single activity concept). Kept lightweight; listeners must not throw.
  const _activityListeners = [];

  function onActivityChange(fn) { if (typeof fn === 'function') _activityListeners.push(fn); }

  function activity() { return state._lastActivity; }

  window.PerformanceSessionState = {
    state, tr, surface, nobodyLooking, windowsLevers, closesApps, _procKey, _boostTarget, _fmtMB,
    _cancelAutoRestore, _idleEligible, _busyNow, _activityListeners, onActivityChange, activity,
  };
})();
