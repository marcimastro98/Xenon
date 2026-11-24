'use strict';
// When the fans have settled after the fan check (calibrate.js) changed a duty:
// the check reads a speed only once the hands have applied the new duty (a few
// seconds pass between a target and the fan getting it) and the readings have
// stopped moving. A fan that ramps slowly (an iCUE LINK hub: about 45 rpm a second)
// moves little from one reading to the next, so a reading still moving one way is
// never settled, and such a channel may give a longer maxMs. Its readings are then
// judged over a longer stretch too, in proportion: a ramp of 20 rpm a second hides in
// three readings a second apart, never in ten.

// Settled: the last `samples` readings, all taken after the hands applied the new
// duty, sit within `rpm` or `frac` of each other; never sooner than minMs after
// that, never later than maxMs after the change.
const SETTLE = Object.freeze({ minMs: 3000, maxMs: 12000, samples: 3, rpm: 40, frac: 0.03 });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const mean = (h) => h.reduce((a, b) => a + b, 0) / h.length;

// Still moving one way by more than SETTLE.rpm across the samples: not settled yet.
function moving(h) {
  if (Math.abs(h.at(-1) - h[0]) <= SETTLE.rpm) return false;
  const up = h.every((v, i) => i === 0 || v >= h[i - 1]);
  const down = h.every((v, i) => i === 0 || v <= h[i - 1]);
  return up || down;
}

function createSettle() {
  let changedAt = 0;
  let limitMs = /** @type {number} */ (SETTLE.maxMs);
  let count = /** @type {number} */ (SETTLE.samples);
  let appliedAt = null;
  /** @type {Set<string>} */
  let pending = new Set();
  /** @type {Map<string, number[]>} */
  const hist = new Map();

  return {
    /**
     * A new duty for these controls: the speeds settle again from here.
     * @param {number} now @param {string[]} ids @param {number} [maxMs] the slowest of them
     */
    change(now, ids, maxMs = SETTLE.maxMs) {
      if (!ids.length) return;
      changedAt = now;
      limitMs = Math.max(SETTLE.maxMs, maxMs);
      count = Math.round((SETTLE.samples * limitMs) / SETTLE.maxMs);
      appliedAt = null;
      pending = new Set(ids);
      hist.clear();
    },

    /**
     * One reading in. A control the driver reports no duty for, or one no longer
     * asked for, counts as applied.
     * @param {number} now @param {{ tachs: Record<string, number|null>, duty?: Record<string, number|null> }} reading
     * @param {Record<string, number>} targets
     */
    record(now, reading, targets) {
      for (const id of [...pending]) {
        const d = reading.duty?.[id];
        if (!isNum(d) || !(id in targets) || Math.abs(d - targets[id]) <= 1) pending.delete(id);
      }
      if (pending.size) return;
      if (appliedAt == null) appliedAt = now;
      for (const [id, v] of Object.entries(reading.tachs)) {
        if (!isNum(v)) continue;
        const h = hist.get(id) || [];
        h.push(v);
        if (h.length > count) h.shift();
        hist.set(id, h);
      }
    },

    /** @param {number} now @param {string[]} watch the readings that must have settled */
    settled(now, watch) {
      if (now - changedAt >= limitMs) return true;
      if (appliedAt == null || now - appliedAt < SETTLE.minMs) return false;
      for (const id of watch) {
        const h = hist.get(id);
        if (!h || h.length < count) return false;
        if (Math.max(...h) - Math.min(...h) > Math.max(SETTLE.rpm, SETTLE.frac * mean(h)) || moving(h)) return false;
      }
      return true;
    },

    /** The settled speed of each reading: the mean of its last few samples (a slow channel is
     * judged on more, but read on the newest). @param {string[]} ids */
    snapshot: (ids) => Object.fromEntries(ids.filter((id) => hist.has(id)).map((id) => [id, mean(hist.get(id).slice(-SETTLE.samples))])),
  };
}

module.exports = { createSettle, SETTLE };
