// Starting the watch for shutdown, restart and sleep while Xenon drives lights itself, and
// stopping it when it does not.

const lighting = require('../lights/lighting.js');
const { _sessionWatch } = require('./session-watch-lights.js');

function _syncSessionWatch() {
  let on = false;
  try { on = lighting.getConfig().native.enabled === true; } catch { /* stays off */ }
  if (on) _sessionWatch.start(); else _sessionWatch.stop();
}

module.exports = { _syncSessionWatch };
