// The numbers of the Performance Mode sheet, read from the process table; PowerShell answers
// only when the table cannot be read.

const { PERFORMANCE_SCRIPT } = require('./script-paths.js');
const { runPowerShellScript } = require('../powershell/run-command.js');
const { perfSession } = require('../perf-session/engine-session.js');

// The sheet's numbers from the process table. PowerShell only answers when the table
// cannot be read.
async function perfStats() {
  return (await perfSession.stats()) || runPowerShellScript(PERFORMANCE_SCRIPT, ['stats'], 9000);
}

module.exports = { perfStats };
