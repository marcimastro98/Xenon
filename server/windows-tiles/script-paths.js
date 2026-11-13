// Where the script that lists and moves windows sits.

const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

const WINDOWS_SCRIPT = path.join(SERVER_DIR, 'windows.ps1');

module.exports = { WINDOWS_SCRIPT };
