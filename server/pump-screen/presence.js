'use strict';
// Which pump screens show Xenon right now. The face page on a pump says hello when it
// starts and again every half minute (BEAT_MS in js/pump/pump-face.js); a screen not heard
// for AWAY_MS is away: its widget was taken off in iCUE, iCUE or NZXT CAM was closed, or
// the PC slept. An away screen keeps its settings for when it comes back, but the menu
// stops drawing it, its moments stop asking for readings and its ring of lights goes back
// to iCUE. In memory only: after a restart every page says hello again.

const AWAY_MS = 75_000;

/**
 * @param {{ clock?: () => number, later?: (fn: () => void, ms: number) => any,
 *   cancel?: (timer: any) => void, changed?: () => void }} [opts]
 *   changed: told when a screen comes or goes, never on a beat of one already here.
 */
function createPumpPresence({ clock = Date.now, later = setTimeout, cancel = clearTimeout, changed = () => {} } = {}) {
  const heard = new Map();   // screen id -> when its page last spoke
  let timer = null;

  const here = (id) => heard.has(id) && clock() - heard.get(id) < AWAY_MS;

  // Wakes when the first screen would go away, never on a fixed tick.
  function arm() {
    if (timer) cancel(timer);
    timer = null;
    if (!heard.size) return;
    const first = Math.min(...heard.values());
    timer = later(sweep, Math.max(0, first + AWAY_MS - clock()) + 50);
    timer?.unref?.();
  }

  function sweep() {
    timer = null;
    let gone = false;
    for (const [id, at] of heard) {
      if (clock() - at >= AWAY_MS) { heard.delete(id); gone = true; }
    }
    arm();
    if (gone) changed();
  }

  // A page on this screen spoke (its hello, a beat, its colours).
  function note(id) {
    const came = !here(id);
    heard.set(id, clock());
    arm();
    if (came) changed();
  }

  function stop() {
    if (timer) cancel(timer);
    timer = null;
    heard.clear();
  }

  return { note, here, stop };
}

module.exports = { createPumpPresence, AWAY_MS };
