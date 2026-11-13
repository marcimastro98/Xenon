// Where the place found for the weather is kept between starts.

const path = require('node:path');
const { DATA_DIR } = require('../engine/paths.js');

const WEATHER_GEO_FILE = path.join(DATA_DIR, 'weather-geo.json');

module.exports = { WEATHER_GEO_FILE };
