// The engine's calendar reminders, decided once for every screen.

const path = require('node:path');
const calendarReminders = require('./calendar-reminders.js');
const { sseClients, broadcastSSE } = require('../http/sse-clients.js');
const lighting = require('../lights/lighting.js');
const { DATA_DIR } = require('../engine/paths.js');
const { writeFileAtomic } = require('../files/atomic-write.js');
const { agendaState } = require('./agenda-state.js');
const { markEventReminders } = require('./events-write.js');

// Calendar reminders are decided here, once for every surface (see the module).
const _calendarReminders = calendarReminders.createCalendarReminders({
  markLocal: markEventReminders,
  feedCache: () => agendaState.externalFeeds,
  firedFile: path.join(DATA_DIR, 'calendar-reminders.json'),
  writeFileAtomic,
  hasListeners: () => sseClients.size > 0,
  broadcast: broadcastSSE,
  onRing: () => lighting.onEvent('reminder'),
});

module.exports = { _calendarReminders };
