// Where the script that opens the dashboard at logon sits.

const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

const OPEN_DASHBOARD_VBS = path.join(SERVER_DIR, 'open-dashboard.vbs');

module.exports = { OPEN_DASHBOARD_VBS };
