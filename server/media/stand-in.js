// What the media tile shows when no player reports a song: the app that is heard making sound,
// or the last reading while it is still fresh.

const { heardApp, nothingHeard, cachedReadUsable } = require('./media-read.js');
const { normalizeMedia } = require('./normalize.js');
const { liveMediaSnapshot } = require('./snapshot.js');
const { F } = require('../audio/svv-csv.js');
const gameDetect = require('../gamedetect.js');
const { mediaNow } = require('./now-state.js');
const { heardPlayer } = require('./heard.js');
const { hydrateArtwork } = require('./artwork-lookup.js');
const { applyStickyThumb } = require('./cover-memory.js');
const { soundingRows } = require('./sounding-rows.js');

async function mediaStandIn(error) {
  if (cachedReadUsable(mediaNow.cache, Date.now())) {
    // Aged like a cache hit: the raw copy carries a position seconds old,
    // which the lyrics would read as a seek back.
    return liveMediaSnapshot(mediaNow.cache.data, Date.now() - mediaNow.cache.updatedAt);
  }
  const fallback = applyStickyThumb(await hydrateArtwork(normalizeMedia(await getMediaFallback(error))));
  // Begun before a press, this read has not heard it.
  if (Date.now() < mediaNow.holdUntil) return mediaNow.cache.data;
  mediaNow.cache = { data: fallback, updatedAt: Date.now() };
  return fallback;
}

// Who is making sound right now, or paused a moment ago, as a media read; null until an
// app is heard twice.
async function heardNow(skip = []) {
  const rows = await soundingRows();
  const left = [gameDetect.getGameProcess(), ...skip];
  return heardPlayer.read(rows, heardApp(rows, F, left), left);
}

async function getMediaFallback(error) {
  try { return (await heardNow()) || nothingHeard(error); } catch { return nothingHeard(error); }
}

module.exports = { mediaStandIn, heardNow, getMediaFallback };
