// What the engine remembers of finding this PC's place for the weather: the place found, the
// lookups under way, the last failure and where the answer came from.

const weatherGeo = {
  place: { value: null, updatedAt: 0 },
  load: null, // shared promise — concurrent boot fetches read the file once
  refresh: null, // in-flight lookup, shared across concurrent callers
  failAt: 0,     // last failed lookup — skip retrying for a cooldown
  // Which source answered / how the last attempt went. Diagnostics only: it rides
  // the failure payload of /weather so a support report says WHY instead of just
  // "unavailable" — the whole reason this class of bug took three reports to place.
  source: '',
  attempts: '',
};

module.exports = { weatherGeo };
