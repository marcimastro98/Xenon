'use strict';
// What the person saw of their Bit, as anonymous counts (engine/usage-stats.js, a no-op while
// usageStats is off): its pocket opened, something from the room tried on the desktop, and the
// sign in its hand when the pocket opened. Only these ids reach the hub, never what a sign was
// about; the hub's src/usage-features.js lists the same (server/test/usage-stats.test.mjs).

const { KINDS } = require('../shared/src/bit-signs.js');
const usageStats = require('../engine/usage-stats.js');

const SEEN = Object.freeze(['pocket', 'tryon', ...KINDS.map((kind) => `sign.${kind}`)]);
/** The usage ids they become ('bit.pocket', 'bit.sign.done'...). */
const IDS = Object.freeze(SEEN.map((what) => `bit.${what}`));

/** One thing seen; false for anything off the list, or while counting is off. */
function seen(what) {
  return typeof what === 'string' && SEEN.includes(what) && usageStats.record(`bit.${what}`);
}

module.exports = { SEEN, IDS, seen };
