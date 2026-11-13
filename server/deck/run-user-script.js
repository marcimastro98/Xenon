// Runs a script the user put on a Deck key, with the interpreter that fits its kind.

const { spawn } = require('node:child_process');
const path = require('node:path');
const { POSIX_SCRIPT_RUNNERS } = require('./script-runners.js');
const { DECK_ACTIONS_SCRIPT } = require('./script-paths.js');
const { runPowerShellScript } = require('../powershell/run-command.js');

function runUserScript(p, hidden) {
  if (process.platform === 'win32') {
    return runPowerShellScript(DECK_ACTIONS_SCRIPT, ['runscript', p, hidden ? 'hidden' : 'visible'], 8000);
  }
  const ext = path.extname(String(p)).toLowerCase();
  const runner = POSIX_SCRIPT_RUNNERS[ext];
  if (!runner) return Promise.reject(new Error(`no interpreter for "${ext}" on this platform`));
  return new Promise((resolve, reject) => {
    // Detached, like the Windows path: a Deck key starts a script, it does not
    // wait for it. stdio is discarded so a chatty script cannot fill a pipe and
    // wedge on a full buffer.
    try {
      const child = spawn(runner[0], [...runner.slice(1), String(p)], {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', reject);
      child.unref();
      resolve({ ok: true });
    } catch (e) { reject(e); }
  });
}

module.exports = { runUserScript };
