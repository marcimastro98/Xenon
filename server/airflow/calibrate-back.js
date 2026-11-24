'use strict';
// The fan check's last step, only for controls Xenon has never tried on real hardware
// (a driver's beta channels): proof that letting one go gives its fan back to the PC.
// Every such control goes to full until its speeds settle, then all are let go at once.
// A fan whose speed then falls clearly under its full speed is with its firmware again
// (a BIOS curve, the card's own control, a hub's default). One that stays at full proves
// nothing (the PC may want it there, or the control kept Xenon's last value), so it
// gets no proof, and inventory.js never drives a beta control without one.

// A fall of a tenth of the full speed: well over a reading's noise, well under what a
// firmware at rest sets (a pump going from 100 % to its 60 % default falls about a quarter).
const DROP = 0.1;
// The longest a firmware may take to slow a fan it has back (a BIOS step-down delay, a
// card spinning down); a slow driver's own settle time counts when it is longer.
const BACK_MS = 20000;
// Under this a fan is not turning: a full speed this low cannot show a fall.
const MIN_TOP_RPM = 200;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {{ ids: string[], waitMs?: number }} o ids: the beta controls the check paired;
 *   waitMs: how long their fans may take to settle
 */
function createBackStep({ ids, waitMs = 0 }) {
  const wait = Math.max(BACK_MS, waitMs);
  /** @type {Map<string, number>} */
  const top = new Map();
  const proven = new Set();
  let downAt = null;

  return {
    ids: [...ids],
    /** The duties to hold: every control at full until it is let go, then none (the PC's). */
    targets: () => (downAt == null ? Object.fromEntries(ids.map((id) => [id, 100])) : {}),
    get down() { return downAt != null; },
    /** At full and settled: each fan's full speed is kept, and from now the PC has them. */
    letGo(now, speeds) {
      for (const id of ids) if (isNum(speeds[id]) && speeds[id] >= MIN_TOP_RPM) top.set(id, speeds[id]);
      downAt = now;
    },
    /** One reading after letting go; true once every fan is proven or the wait is over. */
    watch(now, speeds) {
      for (const id of ids) {
        const t = top.get(id);
        if (t != null && isNum(speeds[id]) && speeds[id] <= t * (1 - DROP)) proven.add(id);
      }
      return proven.size === ids.length || now - /** @type {number} */ (downAt) >= wait;
    },
    proven: (id) => proven.has(id),
    progress: () => (downAt == null ? 0 : 0.5 + (0.5 * proven.size) / Math.max(1, ids.length)),
  };
}

module.exports = { createBackStep, DROP, BACK_MS, MIN_TOP_RPM };
