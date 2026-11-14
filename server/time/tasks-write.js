// The saves of the tasks, one after the other.

const { _writeTasksNow } = require('./tasks-write-now.js');
const { timeWrites } = require('./write-state.js');

function withTasksWrite(fn) {
  const run = timeWrites.tasks.then(fn, fn);
  timeWrites.tasks = run.catch(() => {});
  return run;
}

function writeTasks(tasks) {
  return withTasksWrite(() => _writeTasksNow(tasks));
}

module.exports = { withTasksWrite, writeTasks };
