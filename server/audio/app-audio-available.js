// Whether this system can set the volume of one app.

const fs = require('node:fs');
const { nativeCollectors } = require('../system/native-collectors.js');
const { SVV } = require('./svv-path.js');

// Per-app volume: macOS has no per-process mixer (docs/MACOS_PORTABILITY.md).
async function _appAudioAvailable() {
  if (process.platform === 'darwin') return false;
  return nativeCollectors ? nativeCollectors.audioAvailable() : fs.promises.access(SVV).then(() => true, () => false);
}

module.exports = { _appAudioAvailable };
