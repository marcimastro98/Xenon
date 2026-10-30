'use strict';
// The space limit for videos (Settings → Recording): after a recording or a
// replay clip is saved, the oldest videos Xenon made go until the rest fit in
// `maxGB`, never the one just saved. Only files in the captures index are
// touched (captures.js), never a scan of the folder.

const { VIDEO_KINDS } = require('./captures');

const GB = 1024 ** 3;

// Answers how many files went (0 when there is no limit or nothing to do).
async function pruneVideos(store, maxGB, keep) {
  const gb = Number(maxGB) || 0;
  if (!(gb > 0) || !store || typeof store.prune !== 'function') return 0;
  try {
    return (await store.prune({ kind: VIDEO_KINDS, maxBytes: gb * GB, keep })).removed || 0;
  } catch {
    return 0;
  }
}

module.exports = { pruneVideos, GB };
