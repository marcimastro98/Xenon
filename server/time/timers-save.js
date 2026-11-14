// Writes the running timers to disk.

const { TIMERS_FILE } = require('./store-files.js');
const { writeFileAtomic } = require('../atomic-write.js');
const { timerState } = require('./timer-list.js');

async function _saveTimers() {
  try {
    await writeFileAtomic(TIMERS_FILE, JSON.stringify(timerState.list, null, 2));
  } catch {}
}

module.exports = { _saveTimers };
