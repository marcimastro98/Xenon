// The function that stops the live connection to the UniFi console's events, held while that
// connection is open.

const unifiWatching = {
  // ── UniFi Protect camera notifications (person/vehicle/motion/ring) ───────────
  // While a Cameras tile is on screen (SSE clients > 0) AND notifications are enabled,
  // hold ONE live WebSocket to the console's updates stream and surface each new
  // detection as a `unifi_event` SSE → a dashboard toast (gated by the master Notifiche
  // switch on the client). Idle-closes otherwise, mirroring OBS/HA/Wave Link. The
  // per-camera+kind cooldown lives here so one person lingering can't spam the screen.
  stop: null,
};

module.exports = { unifiWatching };
