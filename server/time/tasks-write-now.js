// Writes the list of tasks to disk and tells every dashboard, without waiting in the queue of
// writes.

const { _nextListSeq } = require('./list-seq.js');
const { normalizeTasks } = require('./tasks-normalize.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const { TASKS_FILE } = require('./store-files.js');
const { writeFileAtomic } = require('../atomic-write.js');
const { agendaState } = require('./agenda-state.js');

async function _writeTasksNow(tasks) {
  const safe = normalizeTasks(tasks);
  await writeFileAtomic(TASKS_FILE, JSON.stringify(safe));
  agendaState.tasksSeq = _nextListSeq(agendaState.tasksSeq);
  // Every dashboard repaints its Tasks tile from this, and so does the SDK
  // `tasks` stream.
  broadcastSSE('tasks', { tasks: safe, seq: agendaState.tasksSeq });
  return safe;
}

module.exports = { _writeTasksNow };
