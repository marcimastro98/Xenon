// Where the capture engine sits.

const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

// The capture engine (apps/capture), started on the first screenshot and gone
// after a minute without one. Windows only for now; elsewhere it is absent and
// the capture keys and AI functions are hidden.
const CAPTURE_EXE = path.join(SERVER_DIR, 'capture', process.platform === 'win32' ? 'xenon-capture.exe' : 'xenon-capture');

module.exports = { CAPTURE_EXE };
