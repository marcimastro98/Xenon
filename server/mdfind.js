// Moved to server/search/mdfind.js. This line hands the same module to anything that still asks for the old place.
module.exports = require('./search/mdfind.js');
