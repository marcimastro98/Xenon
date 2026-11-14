// Sets the app the user wants the media tile to follow, and forgets the last answer when it
// changes.

const { sanitizeMediaSourcePreference } = require('./snapshot.js');
const { mediaNow } = require('./now-state.js');
const { mediaChoice } = require('./preferred-source.js');

function setMediaPreferredSource(value) {
  const next = sanitizeMediaSourcePreference(value);
  if (next !== mediaChoice.source) {
    mediaChoice.source = next;
    mediaNow.cache.updatedAt = 0;
  }
  return mediaChoice.source;
}

module.exports = { setMediaPreferredSource };
