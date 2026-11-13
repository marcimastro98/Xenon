// Where the settings are kept in the user's data folder.

const path = require('node:path');
const { DATA_DIR } = require('../engine/paths.js');

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

module.exports = { SETTINGS_FILE };
