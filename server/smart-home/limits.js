// Limits of the smart home links: Home Assistant devices watched for Deck keys, the shape of a
// device id, and remembered camera alerts.

const HA_DECK_WATCH_MAX = 32;
const HA_DECK_WATCH_CLIENTS_MAX = 8;
const HA_DECK_WATCH_TTL_MS = 15 * 60 * 1000;   // a vanished surface stops mattering
const HA_ENTITY_ID_RE = /^[a-z_]+\.[a-z0-9_]+$/;

const UNIFI_COOLDOWN_MAX = 200;           // bound the map (many cameras × kinds)

module.exports = {
  HA_DECK_WATCH_MAX, HA_DECK_WATCH_CLIENTS_MAX, HA_DECK_WATCH_TTL_MS, HA_ENTITY_ID_RE,
  UNIFI_COOLDOWN_MAX,
};
