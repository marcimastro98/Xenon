// Watching the UniFi console for a person, a vehicle, movement or a ring at the door: only
// while a dashboard is open and the person asked for those notices.

const { sseClients } = require('../http/sse-clients.js');
const { readHubSettings } = require('../settings/read.js');
const { deckUnifiEvents } = require('./deck-clients.js');
const { unifiWatching } = require('./unifi-events-watching.js');
const { unifiNotify } = require('./unifi-notify-state.js');
const { _unifiNotifyCooldown, _onUnifiDetection } = require('./unifi-detections.js');

async function refreshUnifiEventsWatch() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const u = (s && s.unifi) || {};
  const notify = u.notify || {};
  unifiNotify.snapshot = {
    enabled: notify.enabled === true,
    types: (notify.types && typeof notify.types === 'object') ? notify.types : {},
    cooldownMs: Math.max(5, Math.min(600, Number(notify.cooldownSec) || 45)) * 1000,
  };
  const configured = !!(u.host && u.username && u.password);
  const want = configured && notify.enabled === true && sseClients.size > 0;
  // Reconnect if the console credentials changed under an active watch (the socket
  // is bound to the old session); a mere toggle of the type checkboxes doesn't need it.
  const sig = want ? [u.host, u.username, u.password].join('\u0000') : '';
  if (want && !unifiWatching.stop) {
    unifiWatching.stop = deckUnifiEvents.watch(_onUnifiDetection);
  } else if (!want && unifiWatching.stop) {
    const stopUnifi = unifiWatching.stop; stopUnifi(); unifiWatching.stop = null;
    _unifiNotifyCooldown.clear();
  } else if (want && unifiWatching.stop && sig !== unifiNotify.configSig) {
    const stopUnifi = unifiWatching.stop; stopUnifi(); unifiWatching.stop = deckUnifiEvents.watch(_onUnifiDetection);
  }
  unifiNotify.configSig = sig;
}

module.exports = { refreshUnifiEventsWatch };
