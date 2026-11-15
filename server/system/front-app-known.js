// Says whether this computer can name the app in the foreground.

const gameDetect = require('../performance/gamedetect.js');
const { frontApp } = require('./front-app-state.js');

function frontAppKnown() {
  if (!frontApp.seen) { try { frontApp.seen = !!gameDetect.getForegroundProcess(); } catch { /* not yet */ } }
  return frontApp.seen;
}

module.exports = { frontAppKnown };
