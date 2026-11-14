'use strict';
// Where the script Codex runs as our hook sits in the install.

const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');

const HOOK_SCRIPT = path.join(SERVER_DIR, 'codex-hook.js');

module.exports = { HOOK_SCRIPT };
