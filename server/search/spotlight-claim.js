'use strict';
// The engine's one claim clock for the search shortcut (spotlight-hotkey/claim.js): the shortcut
// is broadcast to every dashboard, and the Edge popup opens only when no native window claims it.

const { broadcastSSE } = require('../http/sse-clients.js');
const { createSpotlightClaim } = require('../spotlight-hotkey/claim.js');

const spotlightClaim = createSpotlightClaim({
  broadcast: () => broadcastSSE('spotlight_hotkey', { at: Date.now() }),
  // Required when the popup is due, not at load: spotlight-window.js requires this module.
  openFallback: () => { try { require('./spotlight-window.js').openSpotlightPopupWindow(); } catch { /* best-effort */ } },
});

module.exports = { spotlightClaim };
