// What the assistant does when asked about the calendar: list the events, add, change, delete
// one or all.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

const AgendaAi = require('../agenda-ai.js');

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'list_calendar_events': async (_context, { readEvents }) => {
      let fnResult;
      // Return ALL events (past included): the model needs every event to be
      // able to delete or reference them. Past events were previously filtered
      // out, which made "delete all events" wrongly report an empty calendar.
      const events = await readEvents();
      const sorted = events
        .slice()
        .sort((a, b) => (a.startsAt || '').localeCompare(b.startsAt || ''))
        .slice(0, 50);
      fnResult = { count: events.length, events: sorted.map(e => ({ id: e.id, title: e.title, startsAt: e.startsAt, notes: e.notes })) };
      return fnResult;
  },

  'create_calendar_event': async ({ fnArgs, clientActions }, { updateEvents }) => {
      let fnResult;
      const evTitle = String(fnArgs.title || '').trim();
      if (!evTitle) { fnResult = { error: 'empty title' }; }
      else {
        const newEvent = {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          title: evTitle.slice(0, 120),
          notes: String(fnArgs.notes || '').trim().slice(0, 600),
          startsAt: String(fnArgs.starts_at || '').trim(),
          reminderAt: String(fnArgs.reminder_at || '').trim(),
          notifiedAt: '',
          createdAt: new Date().toISOString(),
        };
        await updateEvents((events) => ({ next: events.concat([newEvent]) }));
        clientActions.push({ action: 'refresh_calendar', args: {} });
        fnResult = { ok: true, event: { id: newEvent.id, title: newEvent.title, startsAt: newEvent.startsAt } };
      }
      return fnResult;
  },

  'edit_calendar_event': async ({ fnArgs, clientActions }, { aiActionLog, updateEvents }) => {
      let fnResult;
      const r = await updateEvents((events) => {
        const { next, result } = AgendaAi.editEvent(events, fnArgs);
        return next ? { next, result, prev: events } : { result };
      });
      if (r.changed) {
        clientActions.push({ action: 'refresh_calendar', args: {} });
        aiActionLog.record({ name: 'edit_calendar_event', label: `Evento modificato: "${r.result.event.title}"`, undo: { kind: 'restore_events', prev: r.prev } });
      }
      fnResult = r.result;
      return fnResult;
  },

  'delete_calendar_event': async ({ fnArgs, clientActions }, { updateEvents }) => {
      let fnResult;
      const evId = String(fnArgs.id || '').trim();
      if (!evId) { fnResult = { error: 'missing id' }; }
      else {
        const r = await updateEvents((events) => {
          const remaining = events.filter(e => e.id !== evId);
          return remaining.length === events.length ? { found: false } : { found: true, next: remaining };
        });
        if (!r.found) { fnResult = { error: 'event not found', id: evId }; }
        else {
          clientActions.push({ action: 'refresh_calendar', args: {} });
          fnResult = { ok: true, deleted: evId };
        }
      }
      return fnResult;
  },

  'clear_all_calendar_events': async ({ clientActions }, { aiActionLog, updateEvents }) => {
      let fnResult;
      const { prevEvents } = await updateEvents((events) => ({ prevEvents: events, next: [] }));
      clientActions.push({ action: 'refresh_calendar', args: {} });
      aiActionLog.record({ name: 'clear_all_calendar_events', label: 'Tutti gli eventi cancellati', undo: { kind: 'restore_events', prev: prevEvents } });
      fnResult = { ok: true, deleted: 'all', count: prevEvents.length };
      return fnResult;
  },
};

module.exports = { branches };
