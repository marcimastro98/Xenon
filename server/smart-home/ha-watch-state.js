// What was last sent to the dashboards about Home Assistant, and the clock that groups the
// changes.

const haWatch = {
  notifyTimer: null,
  // Change guard for the ha_states deck broadcast: the shared HA watch fires on
  // EVERY state_changed of the whole instance (one chatty power sensor is enough),
  // while the ≤32 deck-bound entities rarely move — comparing the serialized
  // payload keeps idle churn off the wire and off the clients' DOM passes.
  deckStatesLast: '',
  // Coalesce bursts of state_changed events into at most one broadcast per ~250ms —
  // a single HA scene can flip a dozen entities at once, and the tile only needs the
  // settled result. Keeps SSE traffic tiny even in a busy home.
  // The watch fires for EVERY entity of the instance, so the payload is compared
  // with the last one sent: a power meter nobody picked ticking every second must
  // not repaint every tile and widget that reads the selected ones.
  stateLast: '',
};

module.exports = { haWatch };
