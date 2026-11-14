// The reader of the sensor service that the engine itself reads through, taken when the engine
// starts: the same one the routes of the service report on.

const sensorService = require('./reader.js').instance();

module.exports = { sensorService };
