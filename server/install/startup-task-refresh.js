// Checks the sign-in task of this install again, keeps the answer and writes to the start-up
// log what was repaired or is still wrong.

const startupLog = require('../startup-log.js');
const startupTask = require('../startup-task.js');
const { DATA_DIR } = require('../engine/paths.js');
const { startupTaskCheck } = require('./startup-task-state.js');

async function refreshStartupTaskState() {
  const res = await startupTask.checkStartupTask({ dataDir: DATA_DIR }).catch(() => null);
  if (!res) return startupTaskCheck.last;
  startupTaskCheck.last = { ...res, at: Date.now() };
  // Both halves belong in the log, and for opposite reasons: a repair is a
  // change made to this PC without the user asking, and an unrepaired problem is
  // the reason Xenon will not be there tomorrow.
  if (res.repaired.length) {
    startupLog.write('startup task: put back ' + res.repaired.join(', ')
      + ' on "' + startupTask.TASK_NAME + '": something had changed settings this install owns.');
  }
  if (res.failed) {
    startupLog.write('startup task: could not repair "' + startupTask.TASK_NAME + '": ' + res.failed);
  }
  if (res.problems.includes('disabled')) {
    startupLog.write('startup task: "' + startupTask.TASK_NAME + '" is switched OFF.'
      + ' Xenon will not start at the next sign-in until it is switched back on'
      + ' (Task Manager > Startup apps). Xenon never switches it off itself.');
  }
  return startupTaskCheck.last;
}

module.exports = { refreshStartupTaskState };
