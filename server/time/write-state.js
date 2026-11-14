// The queues the saves of events and tasks wait in, and the clock that reopens repeating tasks.

const timeWrites = {
  events: undefined, // given its first value where the engine loads
  tasks: undefined, // given its first value where the engine loads
  reopenTimer: null,
};

module.exports = { timeWrites };
