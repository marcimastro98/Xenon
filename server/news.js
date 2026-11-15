// Moved to server/ticker/news.js. This line hands the same module to anything that still asks for the old place.
module.exports = require('./ticker/news.js');
