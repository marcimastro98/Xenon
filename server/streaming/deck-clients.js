// The connections to OBS and to Streamer.bot, made when the engine starts and opened only when
// something asks: each reads its address and password from the settings every time it connects.

const { createObs } = require('../actions/obs.js');
const { createStreamerbot } = require('../actions/streamerbot.js');
const { readHubSettings } = require('../settings/read.js');

// Lazy OBS WebSocket client — reads live settings on each new connection so
// changes in Settings take effect without a server restart.
const deckObs = createObs(async () => {
  const s = (await readHubSettings().catch(() => null)) || {};
  return { host: s.obsHost, port: s.obsPort, password: s.obsPassword };
});

// Lazy Streamer.bot WebSocket client — same on-demand/idle-close model as OBS, so
// a closed dashboard or an unconfigured streamer.bot keeps zero sockets open.
// Reads live settings on each new connection (no restart needed after Settings).
const deckSb = createStreamerbot(async () => {
  const s = (await readHubSettings().catch(() => null)) || {};
  return { host: s.streamerbotHost, port: s.streamerbotPort, password: s.streamerbotPassword };
});

module.exports = { deckObs, deckSb };
