'use strict';
// How big and how often the browser tile's picture is drawn: the frame rate cap, the size
// limits and the sharpness for a small tile.

// Screencast frame-rate cap (see the deferred-ack logic in onEvent). 24 fps
// keeps embedded video film-smooth and sits above typical IP-camera rates
// (10–15 fps), so camera and video tiles look unchanged — while a page whose
// compositor changes every frame can no longer pin CPU cores at the display's
// own 60/75/144 Hz (GitHub #99).
const MAX_STREAM_FPS = 24;
const FRAME_INTERVAL_MS = Math.round(1000 / MAX_STREAM_FPS);

function clampDim(v, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(64, Math.min(n, 4096));
}

// ── Render resolution ────────────────────────────────────────────────────────
// The tile's sharpness is bounded by the resolution the page is rasterised at:
// deviceScaleFactor × the tile's CSS size. The client reports window.devicePixelRatio,
// but on the embedded (iCUE) surface that reading is flaky and frequently UNDER-reports
// (1.0 when the panel is really ~1.2), so a small dashboard tile ends up rendered at too
// few pixels and looks soft when scaled onto the display.
//
// renderScale() therefore SUPERSAMPLES: it aims to rasterise small tiles at up to
// MIN_SUPERSAMPLE× device pixels (which the canvas then downsamples crisply, and which
// also nudges resolution-aware sites like YouTube to serve sharper assets), while a
// MAX_FRAME_PX budget caps the total raster so a large/expanded tile never renders more
// pixels than we can cheaply JPEG-encode on the software renderer. The result never drops
// below the display's own dpr, so a big tile keeps exactly its native resolution — no
// regression for the already-good expanded case.
const MIN_SUPERSAMPLE = 2;       // target at least 2× device pixels on small tiles…
const MAX_FRAME_PX = 2_600_000;  // …but never rasterise more than ~1920×1350 worth of pixels
function renderScale(w, h, dpr) {
  const base = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 3) : 1;
  const budget = Math.sqrt(MAX_FRAME_PX / Math.max(1, w * h));
  return Math.min(3, Math.max(base, Math.min(MIN_SUPERSAMPLE, budget)));
}

module.exports = {
  MAX_STREAM_FPS, FRAME_INTERVAL_MS, clampDim, MIN_SUPERSAMPLE, MAX_FRAME_PX, renderScale,
};
