'use strict';
// What the FPS reader remembers while it runs: its PresentMon child, whether it is paused or
// stopped, and how its last starts went.

const fpsWatch = {
  proc: null,
  consecutiveFastFails: 0,
  stopped: false,            // terminal: server shutting down, never restart
  // Paused starts TRUE: PresentMon runs an admin ETW tracing session, so it stays
  // idle until a dashboard actually connects (resumeFpsMonitor) and is torn back
  // down when the last one leaves (pauseFpsMonitor) — no system-wide cost while
  // nobody is watching FPS / game-mode. Distinct from fpsWatch.stopped: pause is reversible.
  paused: true,
  restartTimer: null,        // pending relaunch timer, so reload() can pre-empt it
  lastGamingAt: 0,           // last time a real app was presenting (for grace window)
};

module.exports = { fpsWatch };
