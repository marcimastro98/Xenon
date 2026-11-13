// Saving the events of the calendar and telling every dashboard.

const { _nextListSeq } = require('./list-seq.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const { EVENTS_FILE } = require('./store-files.js');
const { writeFileAtomic } = require('../atomic-write.js');
const { agendaState } = require('./agenda-state.js');

async function _saveEvents(safe) {
  await writeFileAtomic(EVENTS_FILE, JSON.stringify(safe));
  agendaState.eventsSeq = _nextListSeq(agendaState.eventsSeq);
  // Every dashboard repaints its calendar from this, and so does the SDK
  // `agenda` stream.
  broadcastSSE('agenda', { events: safe, seq: agendaState.eventsSeq });
  return safe;
}

module.exports = { _saveEvents };
