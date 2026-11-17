// The engine's wait for the first full reading of the system, so a painting page can get what
// is known now.

const { createFirstReading } = require('./first-reading.js');

const firstSystemReading = createFirstReading();

module.exports = { firstSystemReading };
