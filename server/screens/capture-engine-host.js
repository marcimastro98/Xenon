// The host of the capture program that records the screen and keeps the replay, made when the
// engine starts: the program itself is started only when a capture is asked for.

const { createCaptureHost } = require('./capture-host.js');
const { CAPTURE_EXE } = require('./capture-exe.js');

const _captureHost = createCaptureHost({ exe: CAPTURE_EXE, log: (m) => console.warn(m) });

module.exports = { _captureHost };
