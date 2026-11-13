// Where the SoundVolumeView program sits.

const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

const SVV = path.join(SERVER_DIR, 'soundvolumeview-x64', 'SoundVolumeView.exe');

module.exports = { SVV };
