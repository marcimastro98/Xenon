// Which Home Assistant entities each open Deck wants to hear about, and their union.

const { HA_DECK_WATCH_MAX, HA_DECK_WATCH_TTL_MS } = require('./limits.js');

// Entity ids Deck keys are bound to (haEntity state bindings / haLight sliders).
// Posted by each SURFACE (dashboard, Virtual Deck popup, second browser) after
// its deck renders — kept PER CLIENT and broadcast as the union, so a surface
// posting a narrower set (a popup showing one folder) can never clobber another
// surface's watch list. Bounded + TTL-pruned; the shared HA watch already
// receives every state_changed, so this only widens what gets BROADCAST.
const _haDeckWatchClients = new Map();   // clientId → { ids, at }

function haDeckWatchUnion() {
  const now = Date.now();
  const ids = new Set();
  for (const [client, entry] of _haDeckWatchClients) {
    if (now - entry.at > HA_DECK_WATCH_TTL_MS) { _haDeckWatchClients.delete(client); continue; }
    for (const id of entry.ids) {
      if (ids.size >= HA_DECK_WATCH_MAX) break;
      ids.add(id);
    }
  }
  return Array.from(ids);
}

module.exports = { _haDeckWatchClients, haDeckWatchUnion };
