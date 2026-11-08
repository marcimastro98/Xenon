'use strict';
// Edit mode of the widget layers: while it is on, every layer window takes the
// whole screen's clicks so its widgets can be moved, resized and grouped by
// hand. A runtime state, never saved: a restart always comes back with the
// widgets in place and the screen clickable again.
//
// It turns itself off after IDLE_MS without an edit, so a window left in edit
// mode (the user walked away, the "Done" button is on another screen) never
// keeps blocking the desktop or a game.
const IDLE_MS = 10 * 60 * 1000;
const MAX_STEPS = 40;

// `onEnd(kept)` runs when the mode goes off (by hand or by the idle timer) with
// what `keep()` stored when it went on: the surfaces the user had hidden, which
// editing showed, go back to hidden. `onOff(byHand)` runs last, and says which.
function createLayersEdit({ broadcast = () => {}, onEnd = () => {}, onOff = () => {}, idleMs = IDLE_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let on = false;
  let timer = null;
  let kept = null;
  let before = null;   // the widgets as they were when the mode went on
  let past = [];       // what they were before each change, oldest first: "Undo"

  function stopTimer() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  function arm() {
    stopTimer();
    timer = setTimer(() => { timer = null; set(false, false); }, idleMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function set(next, byHand = true) {
    const want = next === true;
    if (want) arm(); else stopTimer();
    if (want === on) return on;
    on = want;
    if (!on) before = null;
    broadcast(on);
    if (!on && kept !== null) {
      const was = kept;
      kept = null;
      try { onEnd(was); } catch { /* the widgets stay shown: still usable */ }
    }
    if (!on) onOff(byHand);
    return on;
  }

  function keep(value) {
    kept = value;
  }

  // "Put it back" in edit mode: only while the mode lasts.
  function remember(layers) {
    before = layers;
  }

  // Every change is a step back, wherever it came from (the screen, the menu, Bit), so
  // these outlive the mode. Never saved: a restart starts with no steps.
  function step(layers) {
    past.push(layers);
    if (past.length > MAX_STEPS) past.shift();
  }

  function forget() {
    past = [];
  }

  // An edit made while editing keeps the mode open for another IDLE_MS.
  function touch() {
    if (on) arm();
  }

  return { get: () => on, set, touch, keep, remember, earlier: () => before, step, back: () => past.pop() || null, forget, steps: () => past.length, stop: stopTimer };
}

module.exports = { createLayersEdit, IDLE_MS, MAX_STEPS };
