// The counters that tell pages the events or the tasks changed, and the calendars read last
// from outside.

const agendaState = {
  eventsSeq: undefined, // given its first value where the engine loads
  tasksSeq: undefined, // given its first value where the engine loads
  // ── External calendar feeds (read-only ICS subscriptions) ──────────────────
  // In-memory only: parsed feed events are never written to disk.
  externalFeeds: { feeds: [], events: [], refreshedAt: 0 },
};

module.exports = { agendaState };
