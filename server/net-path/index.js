'use strict';
// net-path's public entry: the one reader the server uses, on the backend for
// this OS, picked here once and never by the callers. The logic is net-path.js;
// requiring this starts nothing (koffi and every child wait for the first read).

const { createNetPath } = require('./net-path.js');

function pickBackend(platform) {
  if (platform === 'win32') return require('./windows.js');
  if (platform === 'linux') return require('./linux.js');
  if (platform === 'darwin') return require('./darwin.js');
  return null;
}

const netPath = createNetPath(pickBackend(process.platform));

module.exports = { read: netPath.read, stop: netPath.stop };
