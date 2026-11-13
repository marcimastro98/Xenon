// Where the files a user uploaded (backgrounds, fonts, pictures for tiles) are kept.

const path = require('node:path');
const { DATA_DIR } = require('./paths.js');

const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

module.exports = { UPLOADS_DIR };
