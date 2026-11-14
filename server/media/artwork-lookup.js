// Finds a cover for the playing track on the iTunes search when the host gave none, and
// remembers the answer.

const { artworkCache } = require('./artwork-cache.js');
const { fetchJson } = require('../http/fetch-json.js');

async function hydrateArtwork(data) {
  if (!data || !data.active || data.thumbnail) return data;
  const title = (data.title || '').trim();
  const artist = (data.artist || '').trim();
  if (!title || !artist) return data;

  const key = `${artist}::${title}`.toLowerCase();
  if (artworkCache.has(key)) {
    data.thumbnail = artworkCache.get(key);
    return data;
  }

  try {
    const term = encodeURIComponent(`${artist} ${title}`);
    const result = await fetchJson(`https://itunes.apple.com/search?term=${term}&entity=song&limit=1`, 2500);
    const art = result && result.results && result.results[0] && result.results[0].artworkUrl100;
    const bigArt = art ? art.replace('100x100bb', '600x600bb') : null;
    // LRU eviction: cap cache at 200 entries to prevent unbounded growth.
    if (artworkCache.size >= 200) artworkCache.delete(artworkCache.keys().next().value);
    artworkCache.set(key, bigArt);
    data.thumbnail = bigArt;
  } catch {
    if (artworkCache.size >= 200) artworkCache.delete(artworkCache.keys().next().value);
    artworkCache.set(key, null);
  }

  return data;
}

module.exports = { hydrateArtwork };
