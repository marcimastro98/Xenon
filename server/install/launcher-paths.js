// Where the script that opened the dashboard in a browser at logon sat. It no longer ships (Windows
// Defender took it for a trojan), so nothing is there on a new install: the task code reads this only to
// remove a task an older install left behind, and to refuse a new one.

const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

const OPEN_DASHBOARD_VBS = path.join(SERVER_DIR, 'open-dashboard.vbs');

module.exports = { OPEN_DASHBOARD_VBS };
