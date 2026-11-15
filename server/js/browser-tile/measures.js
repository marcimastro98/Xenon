// The sums of the browser tile that touch nothing: where a pointer lands on the page, the modifier
// keys as the page wants them, whether a frame has the size asked for, and which hidden tile to
// bring into view.
'use strict';

(() => {
  // CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
  function cdpModifiers(e) {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }

  // Pure: map a pointer position on the canvas to page CSS coordinates using the
  // latest screencast frame metadata (falls back to the tile size).
  function mapPointerToPage(clientX, clientY, rect, meta, fallbackW, fallbackH) {
    const rx = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    const ry = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
    const w = (meta && meta.deviceWidth) || fallbackW || rect.width;
    const h = (meta && meta.deviceHeight) || fallbackH || rect.height;
    return {
      x: Math.max(0, Math.min(1, rx)) * w,
      y: Math.max(0, Math.min(1, ry)) * h,
    };
  }

  // A tile's size reaches the page as a fire-and-forget 'resize', and two things can
  // leave the page rendering at a viewport the tile no longer has, with nothing to
  // correct it: the message is dropped (relaySend just returns false while the relay
  // reconnects), or the single repaint the server forces afterwards is captured while
  // the page is still relaying out. The screencast is CHANGE-DRIVEN, so on a page that
  // then sits still no further frame ever arrives and the tile keeps that frame
  // forever — the "Hide toolbar leaves the page filling a quarter of the tile, Show
  // toolbar puts it right" report (GitHub #116); showing the toolbar only helped
  // because it resized the stage again.
  //
  // So a resize is VERIFIED rather than assumed. Every frame carries the viewport it
  // was rendered at (CDP screencast metadata, CSS px), we compare it with the size we
  // last asked for, and re-ask when they disagree. A watchdog covers the other half —
  // a resize that produces no frame at all, where there is nothing to compare.
  const RESIZE_TOLERANCE_PX = 2;
  const RESIZE_RETRY_MS = 900;
  const RESIZE_MAX_RETRIES = 4;

  // Pure: does a frame's own viewport match the size we asked the page to render at?
  // A frame without usable metadata (older server) can't be judged, so it passes.
  function frameMatchesSize(meta, w, h) {
    if (!meta || !(w > 0) || !(h > 0)) return true;
    const dw = Number(meta.deviceWidth);
    const dh = Number(meta.deviceHeight);
    if (!(dw > 0) || !(dh > 0)) return true;
    return Math.abs(dw - w) <= RESIZE_TOLERANCE_PX && Math.abs(dh - h) <= RESIZE_TOLERANCE_PX;
  }

  function groupMetrics(group) {
    const rect = group.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return { w: Math.max(64, Math.round(rect.width)), h: Math.max(64, Math.round(rect.height)), dpr };
  }

  // Identity from the ATOM (data-dashboard-instance), not the enclosing grid
  // item: inside a tab group the item's gs-id is the GROUP's, so two browser
  // tabs would share one favorites/session state. Standalone values are
  // unchanged (primary gs-id = 'browser', copy gs-id = its instance id).
  function instanceIdOf(section) {
    return section.getAttribute('data-dashboard-instance') || 'browser';
  }

  // Which hidden tile to bring into view. Pure so the rule is testable: prefer one
  // already on the page the user is looking at, so a tab switch is preferred over a
  // page change, and fall back to the first mounted tile anywhere. Ties keep source
  // order, which is the dashboard's own order.
  function pickRevealTarget(candidates) {
    const list = Array.isArray(candidates) ? candidates : [];
    let first = null;
    for (const c of list) {
      if (!c) continue;
      if (c.onPage === true) return c;
      if (!first) first = c;
    }
    return first;
  }

  window.BrowserTileMeasures = {
    cdpModifiers, mapPointerToPage, RESIZE_RETRY_MS, RESIZE_MAX_RETRIES, frameMatchesSize,
    groupMetrics, instanceIdOf, pickRevealTarget,
  };
})();
