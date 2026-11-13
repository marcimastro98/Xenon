// Whether game sessions are recorded: on unless the user turned them off.

const { hub } = require('../settings/current.js');

function gameSessionsEnabled() {
  return !(hub.settings && hub.settings.gameSessions && hub.settings.gameSessions.enabled === false);
}

module.exports = { gameSessionsEnabled };
