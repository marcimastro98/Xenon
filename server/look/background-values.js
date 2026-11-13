// What the background settings may hold: the built-in styles, the limits of a pasted picture or
// drawing code, and the lowest panel opacity.

const SETTINGS_MIN_PANEL_ALPHA = 0.18;

// Mirror of the client sanitizeBackgroundMedia. A pasted-SVG wallpaper is stored
// inline as a bounded base64 data:image/svg+xml URI (rendered only as an <img>
// source — secure static mode, no scripts); anything else must be a
// server-generated /uploads/ path.
const BG_SVG_DATA_RE = /^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/;
const BG_SVG_MAX_CHARS = 512 * 1024;

const BG_STATIC_STYLES = ['none', 'nebulosa', 'prisma', 'halo', 'dusk'];

// Code-defined animated background. The code is a client-only, sandboxed-iframe
// concern (see server/js/custom-bg.js) — the server just stores it as a bounded
// string, never executes it. It may bundle its own images as data: URIs
// (assets), so a shared background is self-contained: the sandbox CSP still
// blocks every remote load. Asset validation is the required custom-bg.js
// sanitizeBgAssets — the SAME code the browser and the sandbox use, so the
// rules cannot drift between the two sides.
const BG_CUSTOM_CODE_MAX = 60000; // keep in step with CODE_MAX in js/custom-bg.js

module.exports = {
  SETTINGS_MIN_PANEL_ALPHA, BG_SVG_DATA_RE, BG_SVG_MAX_CHARS, BG_STATIC_STYLES, BG_CUSTOM_CODE_MAX,
};
