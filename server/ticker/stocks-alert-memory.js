// The memory of which price alerts were already shown, made when the engine starts, so that a
// price that stays past its mark is told once.

const stocks = require('./stocks.js');

const _stocksAlerts = stocks.createAlertTracker();

module.exports = { _stocksAlerts };
