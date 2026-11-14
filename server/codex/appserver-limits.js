'use strict';
// The waits of the Codex app-server child: how long without demand before it is stopped, when a
// death counts as a failure and how many keep it down, the grace it is given to stop, and how
// often each thing is read while a tile is seen and while none is.

const IDLE_MS = 3 * 60 * 1000;          // no demand for this long → stop the child
const FAST_FAIL_MS = 10000;             // a child that dies younger than this counts as a failure
const MAX_FAST_FAILS = 5;               // then stay down for PIN_MS
const PIN_MS = 10 * 60 * 1000;
const STOP_GRACE_MS = 2000;

// Refresh cadence. "visible" = a tile is on the current page of some surface.
const LIMITS_VISIBLE_MS = 60 * 1000;
const LIMITS_HIDDEN_MS = 5 * 60 * 1000;
const USAGE_MS = 10 * 60 * 1000;
const THREADS_VISIBLE_MS = 20 * 1000;
const THREADS_HIDDEN_MS = 2 * 60 * 1000;
const HOOKS_TTL_MS = 30 * 1000;

module.exports = {
  IDLE_MS, FAST_FAIL_MS, MAX_FAST_FAILS, PIN_MS, STOP_GRACE_MS, LIMITS_VISIBLE_MS, LIMITS_HIDDEN_MS,
  USAGE_MS, THREADS_VISIBLE_MS, THREADS_HIDDEN_MS, HOOKS_TTL_MS,
};
