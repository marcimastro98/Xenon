// Moved to server/performance/process-stats.js. This line hands the same module to anything that still asks for the old place.
module.exports = require('./performance/process-stats.js');
