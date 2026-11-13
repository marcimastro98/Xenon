// Presses a media key through the script for Windows.

const { MEDIA_KEY_SCRIPT } = require('./script-paths.js');
const { runPowerShellScript } = require('../powershell/run-command.js');

const runMediaKeyScript = (args) => runPowerShellScript(MEDIA_KEY_SCRIPT, args, 5000);

module.exports = { runMediaKeyScript };
