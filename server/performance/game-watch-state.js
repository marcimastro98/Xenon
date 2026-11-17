'use strict';
// What the game detector remembers between two readings of the window in front: the probe and
// its restarts, the last reading, the game it follows, the user's own list and who is told of a
// change.

const gameWatch = {
  proc: null,
  stopped: false,
  buffer: '',
  restartTimer: null,
  fastFails: 0,
  helperDisabled: false,     // helper exe died young repeatedly → pin the PS probe
  linuxProbe: null,          // in-process foreground probe (Linux; see start())
  lastSpawnWasHelper: false, // what the most recent start() actually launched
  last: null,            // { fullscreen, process, pid, at }
  lastGamingAt: 0,       // last moment we considered a game active (grace window)
  hint: null,        // injected: () => { name, fps } | null (PresentMon's busiest presenter)
  // The user's own "not a game" list (the gameIgnore setting, js/performance/game-ignore.js
  // shape). Read through a getter server.js injects, so every path that replaces
  // the settings is covered without a push on each one; the Set is rebuilt only
  // when the array itself changes.
  ignoreSource: null,
  ignoreRef: null,
  ignoreSet: new Set(),
  // The user's own "this is a game" list (gameAlways), read the same way.
  alwaysSource: null,
  alwaysRef: null,
  userGames: new Set(),
  // Fires right after the gaming state flips (entered/left a game). Wired by
  // server.js to broadcast the status immediately: with the native probe pushing
  // a line the instant the foreground changes, state flips no longer wait for
  // the next 3s status tick in either direction.
  onChange: null,
  notified: false,
  // The bare name + PID of the game we last saw in the foreground. Kept even after
  // it loses focus (the user tapping the dashboard, or the game minimising) so the
  // Game Companion can tell "still running, just not focused" from "closed".
  gameProc: '',
  gamePid: 0,
  gameSeenAt: 0,            // last time the game was CONFIRMED alive (foreground or PID-alive)
  pidFirstDeadAt: 0,        // first liveness probe that reported the PID gone (0 = alive)
};

module.exports = { gameWatch };
