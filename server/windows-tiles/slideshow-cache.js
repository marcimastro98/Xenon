// The folder the slideshow tile shows, remembered so that serving a picture does not read the
// whole settings file again.

const slideshowCache = {
  // The slideshow tile requests /slideshow/file every few seconds per surface, and
  // each request only needs ONE string from settings. Re-reading + re-normalizing
  // the whole settings blob per image was steady synchronous event-loop work on
  // the same loop that serves SSE. The cache is refreshed on every settings write
  // above (the sole writer), so it can never serve a stale folder.
  folder: null,   // '' = no folder configured; null = not loaded yet
};

module.exports = { slideshowCache };
