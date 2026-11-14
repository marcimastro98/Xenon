// The function that stops the live connection to Streamer.bot, held while that connection is
// open.

const sbWatching = {
  // ── Streamer.bot live global variables ───────────────────────────────────────
  // A snapshot of Streamer.bot's global variables is pushed to the client over the
  // `streamerbot` SSE event, so a Deck key can REFLECT a global (its on/off follows
  // the real value) — the "stateful key" of phase 2. The socket subscribes to
  // GlobalVariable* events (push, no polling) and is held open only while a dashboard
  // is open (SSE clients > 0) AND Streamer.bot is configured, mirroring OBS/HA. The
  // password never leaves the server — only the projected globals do.
  stop: null,
};

module.exports = { sbWatching };
