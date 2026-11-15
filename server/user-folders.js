// Moved to server/platform/user-folders.js. This line hands the same module to anything that still asks for the old place.
module.exports = require('./platform/user-folders.js');
