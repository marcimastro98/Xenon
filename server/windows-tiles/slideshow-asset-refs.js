// Finds which uploaded slideshow pictures the settings still use.

// Slideshow images are the same kind of reference-counted upload as tile assets,
// but their references live in hubSettings.slideshow.images[].uri (a `/uploads/
// slideshow-*` string per image). Sweep the `slideshow-*` files no surviving image
// still names, reusing the tile-asset grace window + throttle constants.
function collectSlideshowAssetRefs(slideshow) {
  const set = new Set();
  const imgs = slideshow && Array.isArray(slideshow.images) ? slideshow.images : [];
  for (const it of imgs) {
    const src = it && typeof it.uri === 'string' ? it.uri : '';
    const m = src.match(/^\/uploads\/(slideshow-[A-Za-z0-9._-]+)$/);
    if (m) set.add(m[1]);
  }
  return set;
}

module.exports = { collectSlideshowAssetRefs };
