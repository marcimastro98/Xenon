// What was last sent to the dashboards about the music playing.

const mediaSent = {
  // Same change-only rule for 'media': with nothing playing (or a paused track)
  // the payload is byte-identical every 2s, yet each broadcast made every client
  // re-run applyMedia — textContent rewrites invalidate layout even when the text
  // is the same string, so the compositor presented a fresh frame every 2s for a
  // picture that never changed. A reconnecting client is never left stale: the
  // SSE connect-seed pushes the full current media state directly. Also used by
  // the native helper's instant track-change push (_onMediaChangedPush).
  json: '',
};

module.exports = { mediaSent };
