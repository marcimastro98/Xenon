// Telling Core Shield what the settings and the running game ask of it, and what a game session
// records about Performance Mode.

const gameDetect = require('../gamedetect.js');
const { shieldWish } = require('../perf-session/shield-wish.js');
const { perfSession } = require('../perf-session/engine-session.js');
const { hub } = require('../settings/current.js');

// What a game session records, on every path of the status tick.
function gameSessionFacts(running, game) {
  return { running, game, perf: { active: hub.settings?.performance?.active === true, moved: perfSession.shield.movedCount() } };
}

function syncCoreShield() {
  perfSession.shield.sync(shieldWish(hub.settings?.performance, {
    running: gameDetect.isGameRunning(),
    pid: gameDetect.getGameDiag().gamePid,
    name: gameDetect.getGameProcess(),
    foregroundPid: gameDetect.getForegroundPid(),
  }));
}

module.exports = { gameSessionFacts, syncCoreShield };
