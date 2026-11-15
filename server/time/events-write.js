// The saves of the calendar events, one after the other.

const calendarReminders = require('./calendar-reminders.js');
const { normalizeEvents } = require('./events-normalize.js');
const { readEvents } = require('./store-read.js');
const { timeWrites } = require('./write-state.js');
const { agendaState } = require('./agenda-state.js');
const { _saveEvents } = require('./events-save.js');

function withEventsWrite(fn) {
  const run = timeWrites.events.then(fn, fn);
  timeWrites.events = run.catch(() => {});
  return run;
}

function writeEvents(events) {
  return withEventsWrite(async () => {
    const prev = await readEvents().catch(() => []);
    return _saveEvents(calendarReminders.keepNotified(normalizeEvents(events), prev));
  });
}

// Read, change and write the events as one step, so nothing else writes in
// between. `edit(events)` answers { next, ...result } to save `next`, or
// { ...result } without `next` to leave the file alone. A file that cannot be
// read fails the edit instead of starting from an empty list.
function updateEvents(edit) {
  return withEventsWrite(async () => {
    const prev = await readEvents();
    const out = (await edit(prev)) || {};
    if (!Array.isArray(out.next)) return { ...out, events: prev, seq: agendaState.eventsSeq, changed: false };
    const events = await _saveEvents(calendarReminders.keepNotified(normalizeEvents(out.next), prev));
    return { ...out, events, seq: agendaState.eventsSeq, changed: true };
  });
}

function markEventReminders(now) {
  return withEventsWrite(async () => {
    const events = await readEvents();
    const due = calendarReminders.markDueEvents(events, now);
    if (due.length) await _saveEvents(events);
    return due;
  });
}


module.exports = { withEventsWrite, writeEvents, updateEvents, markEventReminders };
