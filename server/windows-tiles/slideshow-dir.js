// The folder the slideshow shows pictures from, read from the settings once and remembered.

const { readHubSettings } = require('../settings/read.js');
const { slideshowCache } = require('./slideshow-cache.js');

async function getSlideshowDir() {
  if (slideshowCache.folder !== null) return slideshowCache.folder;
  const s = (await readHubSettings().catch(() => null)) || {};
  slideshowCache.folder = (s.slideshow && typeof s.slideshow.folder === 'string') ? s.slideshow.folder : '';
  return slideshowCache.folder;
}

module.exports = { getSlideshowDir };
