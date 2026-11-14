// The counters that tell pages the events or the tasks changed, and the calendars read last
// from outside.

const agendaState = {
  // Each starts at the time the engine loaded, so it is above every number of the run before
  // (list-seq.js keeps it rising). Given here, so the saves work whoever loads them.
  eventsSeq: Date.now(),
  tasksSeq: Date.now(),
  // ── External calendar feeds (read-only ICS subscriptions) ──────────────────
  // In-memory only: parsed feed events are never written to disk.
  externalFeeds: { feeds: [], events: [], refreshedAt: 0 },
};

module.exports = { agendaState };
