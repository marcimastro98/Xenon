// The picture of the second screen tile: how large a frame the tile asks for, how often and how
// sharp, drawing a frame on the canvas with only the newest one waiting, where on the mirrored
// screen a point of the canvas is, and which tile a section is.
'use strict';

(() => {
  function tileMetrics(tile) {
    const rect = tile.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return {
      maxWidth: Math.max(320, Math.round(rect.width * dpr)),
      maxHeight: Math.max(240, Math.round(rect.height * dpr)),
    };
  }

  // Capture knobs come from Settings → Second screen (fps/quality), falling back
  // to sane defaults if settings aren't loaded yet.
  function captureCfg() {
    let fps = 15, quality = 55;
    try {
      const s = hubSettings && hubSettings.secondScreen;
      if (s) { if (Number.isFinite(s.fps)) fps = s.fps; if (Number.isFinite(s.quality)) quality = s.quality; }
    } catch (e) { /* defaults */ }
    return { fps, quality };
  }

  // `data` is the JPEG as a Uint8Array (binary relay) or a base64 string (older
  // server fallback).
  function drawFrame(tile, data) {
    if (!data || !tile.canvas) return;
    let bytes = data;
    if (typeof data === 'string') {
      try { const bin = atob(data); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
      catch (e) { return; }
    }
    // One decode in flight, latest-frame-wins — same guard as browser-tile.js
    // (GitHub #99): a busy mirror (video, moving cursor) can emit frames faster
    // than createImageBitmap settles; queuing every frame piles up decode work
    // only to paint already-stale frames.
    if (tile._decoding) { tile._pendingFrame = bytes; return; }
    decodeFrame(tile, bytes);
  }

  function decodeFrame(tile, bytes) {
    tile._decoding = true;
    createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })).then((bmp) => {
      if (!tile.canvas) { bmp.close && bmp.close(); return; }   // tile torn down mid-decode
      if (tile.canvas.width !== bmp.width || tile.canvas.height !== bmp.height) {
        tile.canvas.width = bmp.width; tile.canvas.height = bmp.height;
      }
      const ctx = tile.ctx || (tile.ctx = tile.canvas.getContext('2d'));
      ctx.drawImage(bmp, 0, 0);
      bmp.close && bmp.close();
      // Only touch the overlay when it's actually shown — re-assigning
      // `hidden = true` still schedules a style recalc on every frame (#99).
      if (tile.loadingEl && !tile.loadingEl.hidden && tile.streaming) tile.loadingEl.hidden = true;
    }).catch(() => {}).then(() => {
      tile._decoding = false;
      const next = tile._pendingFrame;
      tile._pendingFrame = null;
      if (next && tile.canvas) decodeFrame(tile, next);
    });
  }

  // Pure: a pointer position on the canvas → fractional 0..1 coords over the
  // *displayed frame*. The canvas may be object-fit:contain (frame letterboxed
  // inside the box) or :cover (frame fills the box and overflows). Either way we
  // compute the displayed frame rect and its offset so clicks land where the user
  // sees them. The helper turns the fractions into absolute virtual-desktop
  // coordinates for SendInput.
  function frac(clientX, clientY, canvas, cover) {
    const rect = canvas.getBoundingClientRect();
    const fw = canvas.width || rect.width;        // frame (bitmap) dimensions
    const fh = canvas.height || rect.height;
    if (rect.width <= 0 || rect.height <= 0 || fw <= 0 || fh <= 0) return { fx: 0, fy: 0 };
    const boxA = rect.width / rect.height;
    const imgA = fw / fh;
    let dispW, dispH;
    // contain: fit inside (letterbox); cover: fill the box (overflow cropped).
    if ((imgA > boxA) !== !!cover) { dispW = rect.width; dispH = rect.width / imgA; }
    else { dispH = rect.height; dispW = rect.height * imgA; }
    const offX = (rect.width - dispW) / 2;
    const offY = (rect.height - dispH) / 2;
    const fx = (clientX - rect.left - offX) / dispW;
    const fy = (clientY - rect.top - offY) / dispH;
    return { fx: Math.max(0, Math.min(1, fx)), fy: Math.max(0, Math.min(1, fy)) };
  }

  // Movement (px) / time (ms) under which a press counts as a tap, not a swipe.
  const TAP_MOVE_PX = 10;
  const TAP_TIME_MS = 600;

  // Identity from the ATOM (data-dashboard-instance), not the enclosing grid
  // item: inside a tab group the item's gs-id is the GROUP's, so two second
  // screen tabs would share one capture state. Standalone values are unchanged
  // (primary gs-id = 'secondscreen', copy gs-id = its instance id).
  function instanceIdOf(section) {
    return section.getAttribute('data-dashboard-instance') || 'secondscreen';
  }

  window.SecondScreenTileFrames = {
    tileMetrics, captureCfg, drawFrame, frac, TAP_MOVE_PX, TAP_TIME_MS, instanceIdOf,
  };
})();
