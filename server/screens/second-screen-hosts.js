// The check of what a second screen needs and the host that shows the PC's picture on it, made
// when the engine starts: the helper that captures the picture is started only when a screen
// asks.

const { createSecondScreen } = require('../second-screen.js');
const { createScreenCapture } = require('../screen-capture.js');
const { HELPER_EXE } = require('../engine/paths.js');

// Second-screen prerequisite check + one-click VDD install (UI not wired yet).
const secondScreen = createSecondScreen();
// Second-screen capture host: spawns the Xenon Helper `screen-serve` mode on
// demand and relays its JPEG frames over the /second-screen/ws loopback socket.
const screenCapture = createScreenCapture({ helperExe: HELPER_EXE });

module.exports = { secondScreen, screenCapture };
