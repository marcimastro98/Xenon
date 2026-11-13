// Keeps a track's cover picture on screen when a reading comes without it, and leaves the
// picture out of an update when the screens already have it.

const { _sameStickyTrack } = require('./snapshot.js');
const { thumbMemory } = require('./thumb-memory.js');

function applyStickyThumb(data) {
  if (!data || !data.active) return data;
  const title = (data && data.title) || '';
  if (!title) return data; // no reliable track identity → don't stick
  if (data.thumbnail) {
    thumbMemory.lastGood = { title, artist: data.artist || '', album: data.album || '', value: data.thumbnail };
  } else if (thumbMemory.lastGood.value && _sameStickyTrack(data, thumbMemory.lastGood)) {
    data.thumbnail = thumbMemory.lastGood.value;
  }
  return data;
}

function mediaForBroadcast(info) {
  if (!info) return info;
  if (!info.thumbnail) {
    if (!info.active) thumbMemory.lastSentKey = null; // reset so the next track re-sends
    return info;
  }
  const key = `${info.title || ''}|${info.artist || info.album || ''}`;
  if (key === thumbMemory.lastSentKey) {
    const { thumbnail, ...rest } = info;             // same track → drop the heavy payload
    return rest;
  }
  thumbMemory.lastSentKey = key;
  return info;
}

module.exports = { applyStickyThumb, mediaForBroadcast };
