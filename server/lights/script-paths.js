// Where the script that sharpens the iCUE picture sits.

const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

const ICUE_SHARPEN_SCRIPT = path.join(SERVER_DIR, 'icue-sharpen.ps1');

module.exports = { ICUE_SHARPEN_SCRIPT };
