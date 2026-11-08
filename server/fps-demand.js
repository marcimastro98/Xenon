'use strict';

// When the frame reader runs. It reads while a dashboard is connected or a recording
// marks stutters, and pauses a while after the last of them goes: the grace rides out
// a page reload, which would otherwise tear the trace down and build it again.
//
// A game in progress keeps a reader that is already running, and never starts one.
// Some games refuse every new trace session while they run (FC 27 answered "access
// denied", 7 Nov 2026), so a reader paused mid-game stayed dead until the game
// closed. With nobody watching when a game starts, nothing reads.

const PAUSE_GRACE_MS = 45000;

function createFpsDemand({ resume, pause, graceMs = PAUSE_GRACE_MS, timers = { setTimeout, clearTimeout } }) {
  let clients = 0;
  let capture = false;
  let game = false;
  let timer = null;

  function cancel() {
    if (!timer) return;
    timers.clearTimeout(timer);
    timer = null;
  }

  function sync() {
    if (clients > 0 || capture) {
      cancel();
      resume();
      return;
    }
    if (game) {
      cancel();
      return;
    }
    if (timer) return;
    timer = timers.setTimeout(() => {
      timer = null;
      pause();
    }, graceMs);
    timer.unref();
  }

  return {
    clients(count) { clients = count; sync(); },
    // Both are asked on every status tick: only a change reaches the reader, or each
    // tick would cut a failing reader's back-off short.
    capture(on) { if (on === capture) return; capture = on; sync(); },
    game(on) { if (on === game) return; game = on; sync(); },
    stop: cancel,
  };
}

module.exports = { createFpsDemand, PAUSE_GRACE_MS };
