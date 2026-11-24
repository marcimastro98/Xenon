'use strict';
// Puts together the real parts of direct.js: the USB list (detect.js), the vendor programs
// (direct-apps.js), the screen's driver over hid/ (lcd-link.js), and a hidden Edge or Chrome
// of its own (direct-browser.js, a profile in DATA_DIR) that films /pump-face. Windows and
// Linux, the two systems hid/ writes reports on; elsewhere nothing starts.
//
// Only the real Xenon writes to a real screen: not a copy run beside it on another port
// (XENON_PORT), not a test process (node --test sets NODE_TEST_CONTEXT, and the servers tests
// start inherit it). XENON_PUMP_DIRECT=1 lets a copy draw anyway (a try on a real pump),
// XENON_PUMP_DIRECT=0 keeps the real one off.

const path = require('path');
const Lcd = require('./lcd-corsair.js');
const { createPumpDirect } = require('./direct.js');
const { createPumpApps } = require('./direct-apps.js');
const { createLcdLink } = require('./lcd-link.js');
const { createDirectBrowser } = require('./direct-browser.js');

// Enough for a moving ring and a crossfade; iCUE sends 25.
const FPS = 20;
const QUALITY = 80;
// 'pump' is the name the iCUE widget and the CAM address use when none is given, so a
// screen set up through iCUE keeps its settings when Xenon draws on it itself.
const DEFAULT_SCREEN = 'pump';
const REAL_PORT = 3030;

function directAllowed(env, port) {
  if (!env || !Number.isInteger(port)) return false;
  if (env.XENON_PUMP_DIRECT === '1') return true;
  if (env.XENON_PUMP_DIRECT === '0' || env.NODE_TEST_CONTEXT) return false;
  return port === REAL_PORT;
}

// Whether this Xenon draws on pump screens itself: Windows or Linux, and the real one.
/** @param {{ platform?: string, env?: Record<string, string | undefined>, port?: number }} [o] */
function directAvailable({ platform = process.platform, env = process.env, port = require('../engine/port.js').PORT } = {}) {
  return (platform === 'win32' || platform === 'linux') && directAllowed(env, port);
}

// Flags only the pump's browser adds to the Browser tile's (browser-launch.js edgeArgs): it
// shows one page and plays no sound, so no spare page process is kept warm (the limit gives way
// to site isolation, so a widget's frame still gets its own). Measured with
// tools/pump-direct/cost.mjs: one process and about 30 MB less. --in-process-gpu and an
// in-process network service saved one more and ~20 MB but take those services out of their
// sandboxed processes, on a page that can show community widget code: left out.
const PUMP_BROWSER_FLAGS = Object.freeze(['--renderer-process-limit=1', '--mute-audio']);

// The page the pump's browser films: told the pace it is filmed at, so a moving picture is drawn
// no more often than that (js/pump/face-picture.js).
const faceUrl = (port, screen, panel) => `http://127.0.0.1:${port}/pump-face?` + new URLSearchParams({ screen, via: 'direct', shape: panel.shape, fps: String(FPS) });

// The pump browser's command line, with `extra` flags to try (cost.mjs).
function pumpBrowserArgs(profileDir, extra = []) {
  const { edgeArgs } = require('../windows-tiles/browser-launch.js');
  const args = edgeArgs(profileDir, []);
  args.splice(args.length - 1, 0, ...PUMP_BROWSER_FLAGS, ...extra);
  return args;
}

/**
 * The real parts direct.js runs on: also what tools/pump-direct/live.mjs tries on a real pump.
 * @param {{ platform: string, port: number, dataDir: string, screen: () => string }} o
 */
function realParts({ platform, port, dataDir, screen }) {
  const win = platform === 'win32';
  const hid = require(win ? '../hid/hid-windows.js' : '../hid/hid-linux.js');
  const { openReports } = require(win ? '../hid/hid-reports-windows.js' : '../hid/hid-reports-linux.js');
  const { defaultLaunch, killProcessTree } = require('../windows-tiles/browser-launch.js');
  const profileDir = path.join(dataDir, 'pump-screen-browser');
  return {
    panelOf: (p) => (p?.direct ? Lcd.panelOf(p.vendorId, p.productId) : null),
    holding: createPumpApps({ platform }),
    faceUrl: (panel) => faceUrl(port, screen(), panel),
    makeLink: ({ panel, onError }) => createLcdLink({ panel, hid, openReports, onError }),
    makeBrowser: ({ panel, url, onFrame, onError }) => createDirectBrowser({
      launch: () => defaultLaunch(profileDir, null, pumpBrowserArgs), WebSocketImpl: require('ws'), kill: killProcessTree,
      url, width: panel.width, height: panel.height, fps: FPS, quality: QUALITY, onFrame, onError,
    }),
  };
}

/**
 * @param {{ store: any, detect: () => Promise<any[]>, port: number, dataDir: string,
 *   changed: () => void, platform?: string, env?: Record<string, string | undefined> }} o
 */
function startPumpDirect({ store, detect, port, dataDir, changed, platform = process.platform, env = process.env }) {
  if (!directAvailable({ platform, env, port })) return null;
  const screen = () => Object.keys(store.peek()?.screens || {})[0] || DEFAULT_SCREEN;
  const direct = createPumpDirect({
    wanted: () => store.peek()?.direct === true,
    detect,
    ...realParts({ platform, port, dataDir, screen }),
    changed,
  });
  // Starts once the saved settings are read: before that `direct` is not known.
  store.ready().then(() => direct.refresh()).catch(() => {});
  return direct;
}

module.exports = { startPumpDirect, realParts, directAllowed, directAvailable, pumpBrowserArgs, faceUrl, DEFAULT_SCREEN, FPS, QUALITY, PUMP_BROWSER_FLAGS };
