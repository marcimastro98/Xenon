// Moved to server/ticker/stocks.js. This line hands the same module to anything that still asks for the old place.
module.exports = require('./ticker/stocks.js');
