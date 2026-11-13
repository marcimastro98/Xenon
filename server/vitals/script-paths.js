// Where the script for Bit's reminder popup on Windows sits.

const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

const VITALS_NAG_SCRIPT = path.join(SERVER_DIR, 'vitals-nag.ps1');

module.exports = { VITALS_NAG_SCRIPT };
