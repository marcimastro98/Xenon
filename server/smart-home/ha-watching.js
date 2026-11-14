// The function that stops the live connection to Home Assistant, held while that connection is
// open.

const haWatching = {
  // ── Home Assistant live state ────────────────────────────────────────────────
  // A compact snapshot of the user's SELECTED entities is pushed to the Smart Home
  // tile over the `homeassistant` SSE event. The persistent HA socket is held only
  // while a dashboard is open (SSE clients > 0) AND HA is configured, so a closed
  // dashboard or an unconfigured HA keeps zero sockets open. The token never leaves
  // the server — only this projected state does.
  stop: null,
};

module.exports = { haWatching };
