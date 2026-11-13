// Where automatic updates keep their state, and how long this PC has been idle as they count
// it.

const path = require('node:path');
const { AUTO_UPDATE_ASSUME_IDLE } = require('./check-values.js');
const { DATA_DIR } = require('../engine/paths.js');
const { readIdleSeconds, _idleProbe } = require('../system/idle-seconds.js');

// Automatic updates: decides WHEN to run the same prepare/apply as the button.
// Everything it reads about the machine is gathered here, the policy lives in
// server/auto-update.js. Each blocker is one thing a restart would break for
// someone: a game, a Performance Mode session, a file on its way, a disk
// cleanup, Claude waiting on an answer, a live voice session, a ringing call.
const AUTO_UPDATE_STATE_PATH = path.join(DATA_DIR, 'auto-update.json');

async function autoUpdateIdleSeconds() {
  if (AUTO_UPDATE_ASSUME_IDLE) return 24 * 3600;
  // A sample the idle probe took in the last minute is as good as a new one.
  if (_idleProbe.at > 0 && Date.now() - _idleProbe.at < 60000 && typeof _idleProbe.sec === 'number') return _idleProbe.sec;
  return readIdleSeconds();
}

module.exports = { AUTO_UPDATE_STATE_PATH, autoUpdateIdleSeconds };
