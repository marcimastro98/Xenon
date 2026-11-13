// What the engine answers about game mode and the performance screen.

const fpsMonitor = require('../fps-monitor.js');
const gameDetect = require('../gamedetect.js');
const perfScreen = require('../perf-screen.js');
const { readBody } = require('../http/read-body.js');
const { broadcastSSE } = require('../http/sse-clients.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /api/gamemode/status': async (_req, _res, { json, err500 }) => {
    // Game mode runs off foreground full-screen detection (no PresentMon needed).
    // PresentMon is reported only so Settings can offer the optional FPS-readout
    // install button. The foreground field is a live diagnostic for false positives.
    //
    // fpsBackend names WHICH reader is behind that flag, because the two are not
    // interchangeable: PresentMon is a download Xenon can perform, MangoHud is a
    // package the user installs and then has to launch the game with. Settings
    // has to offer a button for one and an explanation for the other, and it
    // cannot tell them apart from an availability boolean alone.
    try {
      json({
        presentMonAvailable: fpsMonitor.isAvailable(),
        fpsBackend: fpsMonitor.backend || null,
        fpsAvailable: fpsMonitor.isAvailable(),
        gaming: gameDetect.isGaming(),
        gameRunning: gameDetect.isGameRunning(),
        gameProcess: gameDetect.getGameProcess(),
        activity: gameDetect.getActivity(),
        foreground: gameDetect.getGamingWindow(),
        diag: (typeof gameDetect.getGameDiag === 'function') ? gameDetect.getGameDiag() : null,
        fps: fpsMonitor.getGamingProcess(),
      });
    } catch (e) { err500(e.message); }
  },

  'POST /api/performance/screen': async (req, res, { json }) => {
    // "Widgets only": the hidden driver page runs Performance Mode and the
    // on-screen alerts window shows it; they talk through here (perf-screen.js).
    // This PC only (remote-access.js), and CSRF-guarded.
    let ev = null;
    try { ev = perfScreen.screenEvent(JSON.parse(await readBody(req) || '{}')); } catch (e) { ev = null; }
    if (!ev) { res.writeHead(400); res.end('Invalid event'); return; }
    broadcastSSE('perf_screen', ev);
    json({ ok: true });
  },
};

module.exports = { branches };
