'use strict';
// Who opens the search on its shortcut. The hotkey is broadcast to every
// dashboard; the native kiosk opens the frameless window and claims it (POST
// /spotlight/claimed). Without a claim in time the Edge app-mode popup opens,
// so a browser-only install still gets its search.
//
// The wait was 450 ms for everyone. A busy kiosk page, or its claim fetch raced
// by the scheme navigation that opens the window, sometimes answered later:
// the native window opened AND Edge opened over it, took the focus, and the
// native window closed on that focus loss ("sometimes Edge opens"). So once
// this server has seen a native claim it waits longer, and the search page
// claims too when it shows (a second path that never navigates away). The cost:
// with the native app closed after that, the popup comes NATIVE_CLAIM_MS later.

const CLAIM_MS = 450;
const NATIVE_CLAIM_MS = 3000;

function createSpotlightClaim({ broadcast, openFallback, timers }) {
  const t = timers || { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) };
  let timer = null;
  let claimed = false;
  let nativeSeen = false;

  function stopTimer() {
    if (timer) t.clear(timer);
    timer = null;
  }

  function route() {
    claimed = false;
    broadcast();
    stopTimer();
    timer = t.set(() => {
      timer = null;
      if (!claimed) openFallback();
    }, nativeSeen ? NATIVE_CLAIM_MS : CLAIM_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function claim() {
    claimed = true;
    nativeSeen = true;
    stopTimer();
  }

  return { route, claim };
}

module.exports = { createSpotlightClaim, CLAIM_MS, NATIVE_CLAIM_MS };
