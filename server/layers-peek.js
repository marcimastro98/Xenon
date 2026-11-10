'use strict';
// The widget whose screen is open in the menu shows on the real screen even if its rule
// hides it right now, so a change made there can be seen. A runtime state, never saved.
//
// The menu repeats the id while the screen is in sight; without it the widget goes back
// to its rule after TTL_MS, so a menu that died never leaves a widget up in a game.
const TTL_MS = 20 * 1000;
const WIDGET_ID = /^lw_[a-z0-9]{1,40}$/;

function createLayersPeek({ broadcast = () => {}, ttlMs = TTL_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let id = null;
  let timer = null;

  function stopTimer() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  function set(next) {
    const want = typeof next === 'string' && WIDGET_ID.test(next) ? next : null;
    stopTimer();
    if (want) {
      timer = setTimer(() => { timer = null; set(null); }, ttlMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    if (want === id) return id;
    id = want;
    broadcast(id);
    return id;
  }

  return { set, get: () => id, stop: stopTimer };
}

module.exports = { createLayersPeek, TTL_MS };
