// The slideshow tile's settings as the server keeps them, by the rules shared with the
// dashboard.

const { sanitizeSlideshow } = require('../js/slideshow-widget.js');

// Slideshow widget config. Rules (MIME allowlist + caps + interval clamp + fit)
// are owned by js/slideshow-widget.js and shared with the client, so the two can
// never drift — exactly like sanitizeBgAssets above.
function normalizeSlideshow(value) {
  return sanitizeSlideshow(value);
}

module.exports = { normalizeSlideshow };
