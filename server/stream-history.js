'use strict';
// A short, in-memory history of one SDK stream, so a widget that draws the
// last few minutes opens with them already there instead of an empty chart.
//
// Two limits, both hard: an age (older readings are dropped) and a count (a
// clock that jumps or a burst of readings cannot grow the buffer). Nothing is
// written to disk: this is what the dashboard was already showing, kept a
// little longer, and it dies with the process.
//
// The wire form carries AGE, not a timestamp. The reader may be a paired phone
// whose clock is minutes off this PC's; "this reading is 42 s old" survives
// that, "this reading is from 14:03:12" does not.

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ITEMS = 160;

function createStreamHistory(opts) {
  const maxAgeMs = Math.max(1000, Number(opts && opts.maxAgeMs) || DEFAULT_MAX_AGE_MS);
  const maxItems = Math.max(1, Math.floor(Number(opts && opts.maxItems) || DEFAULT_MAX_ITEMS));
  const items = [];

  function prune(now) {
    while (items.length && now - items[0].t > maxAgeMs) items.shift();
    while (items.length > maxItems) items.shift();
  }

  return {
    // Readings are kept in arrival order. A reading older than the newest one
    // (a clock stepped backwards) restarts the buffer rather than interleaving.
    push(data, now = Date.now()) {
      if (data == null) return;
      const last = items[items.length - 1];
      if (last && now < last.t) items.length = 0;
      items.push({ t: now, data });
      prune(now);
    },
    toWire(now = Date.now()) {
      prune(now);
      return items.map((it) => ({ age: Math.max(0, now - it.t), data: it.data }));
    },
    clear() { items.length = 0; },
    get size() { return items.length; },
  };
}

module.exports = { createStreamHistory, DEFAULT_MAX_AGE_MS, DEFAULT_MAX_ITEMS };
