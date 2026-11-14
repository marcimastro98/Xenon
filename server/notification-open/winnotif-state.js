'use strict';
// What the notification reader remembers while it runs: its child process, what it has read so
// far, and how its last starts went.

const notifWatch = {
  proc: null,
  wanted: false,             // desired state from the last sync()
  stopped: false,            // process shutdown — never restart after
  buffer: '',
  restartTimer: null,
  linuxFlushTimer: null,     // idle flush for the last dbus-monitor block
  consecutiveFastFails: 0,
  helperDisabled: false,
  lastSpawnWasHelper: false,
  pollMs: undefined, // given its first value where the engine loads
  state: 'off',              // 'off'|'starting'|'allowed'|'denied'|'unavailable'
  seq: 0,
  items: [],                 // newest first, capped at FEED_MAX
};

module.exports = { notifWatch };
