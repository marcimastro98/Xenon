// How often the sensors are read, as chosen in the settings, looked up at every reading so a
// change takes effect at once.

const { normalizeSensorRate } = require('./settings-normalize.js');
const { hub } = require('../settings/current.js');

// The chosen cadence, live. Read per tick and per cache check rather than
// captured once, so changing it in Settings takes effect on the next reading
// instead of at the next restart.
function sensorRateMs() {
  return normalizeSensorRate(hub.settings && hub.settings.sensorRateMs);
}

module.exports = { sensorRateMs };
