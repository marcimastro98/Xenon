// The memory of which goals and final whistles were already shown, made when the engine starts,
// so that each is told once.

const football = require('../football.js');

const _footballAlerts = football.createAlertTracker();

module.exports = { _footballAlerts };
