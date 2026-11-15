// The engine's proactive moments: heat that lasts and the recap of a game session.

const fpsMonitor = require('../performance/fps-monitor.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const { createBriefingEngine } = require('./briefing.js');
const { hub } = require('../settings/current.js');

// Briefing — proactive moments (sustained-thermal alerts, game-session recaps).
// Passive: fed from the existing status/system SSE ticks below, so it does no
// work while no dashboard is connected and needs no shutdown handling. Each
// moment type is individually toggleable (Settings → Momenti proattivi).
const briefing = createBriefingEngine({
  emit: (type, data) => broadcastSSE('briefing', Object.assign({ type }, data)),
  isTypeEnabled: (type) => {
    const p = hub.settings && hub.settings.proactive;
    return !p || p[type] !== false;
  },
  getFps: () => fpsMonitor.getCurrentFps(),
});

module.exports = { briefing };
