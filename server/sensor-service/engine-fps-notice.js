// The engine's one pop-up per version about the Windows permission that FPS needs.

const fpsMonitor = require('../fps-monitor.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const { APP_VERSION } = require('../updates/app-version.js');
const { DATA_DIR } = require('../engine/paths.js');

// FPS needs a Windows permission since 5.1.0: one pop-up per version (fps-notice.js).
const _fpsNotice = require('./fps-notice.js').createFpsNotice({
  access: require('./fps-access.js').instance(), dataDir: DATA_DIR, version: APP_VERSION,
  readerReady: () => fpsMonitor.backend === 'presentmon' && fpsMonitor.isAvailable(),
  broadcast: (payload) => broadcastSSE('fps_access', payload),
});

module.exports = { _fpsNotice };
