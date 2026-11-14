// What the engine remembers of what is playing: the last answer, the read under way, the pauses
// it keeps and the rows of apps making sound.

const mediaNow = {
  // Track/playback changed at the OS level (pushed by the native helper):
  // invalidate the cache and broadcast right away instead of waiting for the
  // next 2s poll tick. The tiny debounce coalesces bursts into one refresh.
  pushTimer: null,
  cache: { data: null, updatedAt: 0 },
  pending: null,
  readerRestUntil: 0,
  listProbe: null,
  holdUntil: 0,
  soundRows: { rows: null, at: 0 },
};

module.exports = { mediaNow };
