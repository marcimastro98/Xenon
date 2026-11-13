// Whether background work should wait because a game is running with Game Mode or Performance
// Mode on.

const gameDetect = require('../gamedetect.js');
const { hub } = require('../settings/current.js');

// With Game Mode on, or in a Performance Mode session, the background work that can
// wait does, for as long as a game runs. Everything that answers a person keeps answering.
function backgroundHeld() {
  const wanted = hub.settings?.gameMode !== false || hub.settings?.performance?.active === true;
  return wanted && gameDetect.isGameRunning();
}

module.exports = { backgroundHeld };
