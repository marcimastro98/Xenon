// What may be uploaded: the largest size and the accepted file types for backgrounds, fonts,
// tile pictures and slideshow pictures.

const BACKGROUND_MAX_BYTES = 200 * 1024 * 1024;
const BACKGROUND_TRANSCODE_TIMEOUT_MS = 10 * 60 * 1000;

const BACKGROUND_MIME_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
]);

// Custom UI font upload. Fonts are tiny next to backgrounds (a full TTF/OTF is a
// few MB at most), so a modest cap is plenty and keeps them small enough to embed
// in a full backup and a shared theme code.
const FONT_MAX_BYTES = 8 * 1024 * 1024;
const FONT_MIME_BY_EXT = new Map([
  ['.woff2', 'font/woff2'], ['.woff', 'font/woff'], ['.ttf', 'font/ttf'], ['.otf', 'font/otf'],
]);

// Per-tile decoration image upload (widget backgrounds / frames / overlays).
// Images only (no video). Unlike backgrounds/fonts there is NO one-live-file
// policy — many tiles hold many pictures — so orphans are swept by a
// reference-counted GC on every dashboard-layout save (see below).
const TILE_ASSET_MAX_BYTES = 10 * 1024 * 1024;
const TILE_ASSET_MIME_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'],
]);

// Slideshow images. Same disk-backed, reference-counted model as tile decorations
// (many images, no one-live-file policy), but referenced from hubSettings.slideshow
// rather than the dashboard layout, and with their own `slideshow-*` name prefix so
// the two GCs never reclaim each other's files. Animated GIFs are the whole point of
// the widget and run large, so the per-file cap is roomier than a tile decoration's.
const SLIDESHOW_ASSET_MAX_BYTES = 20 * 1024 * 1024;
const SLIDESHOW_ASSET_MIME_BY_EXT = TILE_ASSET_MIME_BY_EXT;   // same image allowlist

module.exports = {
  BACKGROUND_MAX_BYTES, BACKGROUND_TRANSCODE_TIMEOUT_MS, BACKGROUND_MIME_BY_EXT, FONT_MAX_BYTES,
  FONT_MIME_BY_EXT, TILE_ASSET_MAX_BYTES, TILE_ASSET_MIME_BY_EXT, SLIDESHOW_ASSET_MAX_BYTES,
  SLIDESHOW_ASSET_MIME_BY_EXT,
};
