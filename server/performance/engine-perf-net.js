// The engine's ping and packet loss for the performance tile, read only when someone chose to
// see them.

const { createPerfNet } = require('./perf-net.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const PerfHud = require('../js/performance/perf-hud.js');
const { getNetworkInfo } = require('../system/network-info.js');
const { hub } = require('../settings/current.js');
const { perfWanted } = require('./feeds-wanted.js');

// Ping and packet loss for the same tile, only when someone chose to see them.
const _perfNet = createPerfNet({
  read: getNetworkInfo,
  wanted: () => {
    const hud = PerfHud.normalizePerfHud(hub.settings && hub.settings.perfHud);
    return (hud.ping || hud.loss) && perfWanted();
  },
  broadcast: (d) => broadcastSSE('perf_net', d),
});

module.exports = { _perfNet };
