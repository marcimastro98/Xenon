'use strict';
// Is there a motherboard whose lights Xenon could drive (an RGB Fusion 2 chip) while it does
// not? Then the Lighting page can offer it when nothing else lights the board, as when iCUE is
// closed and every flash reached only the lights Xenon already holds. It only lists the USB
// devices, never opens one: opening wakes the chip (session.js wakeForVendor). Looked at again
// at most once a minute, and a list that does not answer in time counts as none found.

const SPAN_MS = 60000;
const LIST_LIMIT_MS = 2000;

/** @param {{ discover: () => Promise<any[]>, now?: () => number, later?: typeof setTimeout, cancel?: typeof clearTimeout }} o */
function createBoardProbe(o) {
  const now = o.now || Date.now;
  const later = o.later || setTimeout;
  const cancel = o.cancel || clearTimeout;
  let at = -Infinity;
  let found = 0;
  let running = null;

  function listInTime() {
    return new Promise((resolve) => {
      const timer = later(() => resolve(null), LIST_LIMIT_MS);
      timer?.unref?.();
      o.discover().then((list) => { cancel(timer); resolve(list); }, () => { cancel(timer); resolve(null); });
    });
  }

  /** How many boards were found, looking again when the last look is old. */
  function refresh() {
    if (now() - at < SPAN_MS) return Promise.resolve(found);
    if (!running) {
      running = listInTime().then((list) => {
        found = Array.isArray(list) ? list.length : 0;
        at = now();
        running = null;
        return found;
      });
    }
    return running;
  }

  return { refresh, found: () => found };
}

const probe = createBoardProbe({ discover: () => require('./fusion2.js').discover() });

module.exports = { createBoardProbe, probe, SPAN_MS, LIST_LIMIT_MS };
