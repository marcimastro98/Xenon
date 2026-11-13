// What a pressed global shortcut tells the dashboards: flip to a page, or say that nothing can
// open over a game in exclusive full screen.

const fpsMonitor = require('../fps-monitor.js');
const { overExclusive } = require('../capabilities/over-screen.js');
const { broadcastSSE } = require('../http/sse-clients.js');

// A page shortcut fires on the PC running the server, and every dashboard
// watching it flips. The target is resolved on the CLIENT: pages belong to a
// device's own layout, so the server would have to guess which device's page
// ids these are, and a phone with different pages simply ignores an id it does
// not have.
function routePageHotkey(binding) {
  if (!binding || !binding.target) return;
  broadcastSSE('page_hotkey', { target: binding.target, at: Date.now() });
}

// A shortcut has no key to answer on: over a game in exclusive full screen
// (capabilities/over-screen.js) the card says why nothing opened.
function saysOverExclusive() {
  if (!overExclusive(fpsMonitor)) return false;
  broadcastSSE('xenon_menu_failed', { error: 'over_exclusive' });
  return true;
}

module.exports = { routePageHotkey, saysOverExclusive };
