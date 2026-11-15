// The engine's memory of the last steps document and bug report, for after a restart.

const fs = require('node:fs');
const path = require('node:path');
const { createCaptureLast } = require('../capture-last.js');
const { DATA_DIR } = require('../engine/paths.js');

// "Open" / "Show" the last steps document or bug report after a restart (capture-last.js).
const _captureLast = createCaptureLast({
  file: path.join(DATA_DIR, 'capture-last.json'),
  readFile: (p) => fs.promises.readFile(p, 'utf8'),
});

module.exports = { _captureLast };
