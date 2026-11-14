// The engine's rule for when the FPS reader runs and when it pauses.

const fpsMonitor = require('../fps-monitor.js');
const { createFpsDemand } = require('../fps-demand.js');
const { sseClients } = require('../http/sse-clients.js');

// PresentMon runs an ETW tracing session, so it reads only while a dashboard is
// connected or a recording marks stutters (holdFpsForMarkers), and pauses 45 s
// after the last one goes: the grace survives a page reload on the screen. A game
// keeps a running reader, since some games refuse every new trace session until
// they close. The rules are in fps-demand.js.
const _fpsDemand = createFpsDemand({
  resume: () => { try { fpsMonitor.resumeFpsMonitor(); } catch { /* PresentMon absent → no-op */ } },
  pause: () => { try { fpsMonitor.pauseFpsMonitor(); } catch { /* no-op */ } },
});
function _syncFpsMonitor() {
  _fpsDemand.clients(sseClients.size);
}

module.exports = { _fpsDemand, _syncFpsMonitor };
