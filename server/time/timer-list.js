// The timers that are set, kept in memory between saves, and the clock that checks them.

const timerState = {
  list: [], // in-memory timer list; persisted to TIMERS_FILE
  checking: null,
};

module.exports = { timerState };
