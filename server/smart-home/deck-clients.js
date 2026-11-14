// The connections to Home Assistant and to the UniFi console, made when the engine starts and
// opened only when something asks: each reads its address and its token or password from the
// settings every time it connects, and neither leaves the engine.

const { createHomeAssistant } = require('../actions/home-assistant.js');
const { createHaQuery } = require('../actions/home-assistant-query.js');
const { createUnifiProtect } = require('../actions/unifi.js');
const { createUnifiEvents } = require('../unifi-events.js');
const { readHubSettings } = require('../settings/read.js');

// Lazy Home Assistant WebSocket client — same on-demand/idle-close/watch model as
// OBS. Holds ONE live socket only while the Smart Home tile is on screen AND HA is
// configured; reads the base URL + long-lived token from live settings on each
// connection, so saving them in Settings takes effect with no restart.
const deckHa = createHomeAssistant(async () => {
  const s = (await readHubSettings().catch(() => null)) || {};
  return { baseUrl: (s.homeAssistant && s.homeAssistant.url) || '', token: (s.homeAssistant && s.homeAssistant.token) || '' };
});

// SDK widget reads (history, camera frames) over the same connection.
const haQuery = createHaQuery(deckHa);

// Lazy UniFi Protect client — logs into the user's UniFi OS console on demand and
// pulls camera JPEG snapshots for the Cameras tile. No persistent socket: an
// unused/hidden tile pulls nothing, so it costs nothing. The console password is
// read fresh from live settings and never leaves the server (only the projected
// camera list + JPEG bytes reach the browser, via the loopback snapshot proxy).
const deckUnifi = createUnifiProtect(async () => {
  const s = (await readHubSettings().catch(() => null)) || {};
  const u = (s && s.unifi) || {};
  return { host: u.host || '', username: u.username || '', password: u.password || '' };
});

// UniFi Protect realtime-events client. UNLIKE the snapshot pulls above, this holds
// ONE live WebSocket to the console's updates stream — but only while a Cameras tile
// is on screen (SSE clients > 0) AND the user turned notifications on. It reuses
// deckUnifi's authenticated session (password stays server-side) and surfaces
// smart-detections (person/vehicle/…), motion and doorbell rings as `unifi_event`.
const deckUnifiEvents = createUnifiEvents(deckUnifi);

module.exports = { deckHa, haQuery, deckUnifi, deckUnifiEvents };
