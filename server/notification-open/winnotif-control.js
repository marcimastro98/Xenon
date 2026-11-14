'use strict';
// What the notification reader is asked from outside while its child runs: stop the child and
// forget what it read, look less often through a game, and say what state it is in.

const { notifWatch } = require('./winnotif-state.js');

const POLL_MS = 2000;            // child polling cadence
const POLL_GAME_MS = 5000;       // through a game, see setPace()

function _stopChild() {
  if (notifWatch.restartTimer) { clearTimeout(notifWatch.restartTimer); notifWatch.restartTimer = null; }
  if (notifWatch.linuxFlushTimer) { clearTimeout(notifWatch.linuxFlushTimer); notifWatch.linuxFlushTimer = null; }
  if (notifWatch.proc) {
    const p = notifWatch.proc;
    notifWatch.proc = null;                     // detach first so 'close' won't restart
    try { p.stdin.end(); } catch { /* helper exits on EOF */ }
    try { p.kill(); } catch { /* the PS loop needs the kill */ }
  }
  notifWatch.buffer = '';
  // Privacy: drop the buffered notification text the moment nobody watches.
  notifWatch.items = [];
  notifWatch.state = 'off';
}

// Through a game the reader looks less often: every look is a call into the Windows
// notification service. Only the helper listens. The PowerShell fallback keeps its
// pace, and Linux has nothing to slow: dbus-monitor is told, it does not ask.
function setPace(slow) {
  const ms = slow ? POLL_GAME_MS : POLL_MS;
  if (ms === notifWatch.pollMs) return;
  notifWatch.pollMs = ms;
  if (notifWatch.proc && notifWatch.lastSpawnWasHelper) {
    try { notifWatch.proc.stdin.write(`${ms}\n`); } catch { /* the child is going away */ }
  }
}

function getState() { return notifWatch.state; }
function getFeed() { return notifWatch.items; }

// The mirror has one reader per platform: WinRT's UserNotificationListener on
// Windows, the Notify method on the session bus on Linux. Anywhere else there
// is no reader at all, so no child is ever spawned.
function isSupported() { return process.platform === 'win32' || process.platform === 'linux'; }

// What a dashboard should be told the state is. `getState()` stays the raw child
// state — the reader's own logic and its tests depend on that — but where there
// is no reader the child never runs, so that state sits at 'off' forever, which
// the tile renders as "Connecting…" and never leaves (its self-heal loop then
// re-seeds against 'off' indefinitely). Report a terminal, honest state instead.
function reportedState() { return isSupported() ? notifWatch.state : 'unavailable'; }

module.exports = {
  POLL_MS, POLL_GAME_MS, _stopChild, setPace, getState, getFeed, isSupported, reportedState,
};
