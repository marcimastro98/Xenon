'use strict';
// What the phone-call relay remembers while the engine runs: who gave it its helpers, the calls
// in progress, and the timer that drops old ones.

const callState = {
  deps: null,
  active: [],          // newest first, capped at MAX_ACTIVE
  recent: new Map(),   // dedupe key → last ring time
  seq: 0,
  timer: null,
  stopped: false,
};

module.exports = { callState };
