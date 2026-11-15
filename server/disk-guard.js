// Moved to server/disk/disk-guard.js. This line hands the same module to anything that still asks for the old place.
module.exports = require('./disk/disk-guard.js');
