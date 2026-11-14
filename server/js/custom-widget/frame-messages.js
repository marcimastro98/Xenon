// The messages the host posts into a widget's frame about the tile it sits in: its size in pixels,
// the safe rectangle inside its shape, and whether it is expanded.
'use strict';

(() => {
  function post(entry, msg) {
    try {
      if (entry.frame && entry.frame.contentWindow) entry.frame.contentWindow.postMessage({ xenonSdk: 1, ...msg }, '*');
    } catch { /* frame mid-teardown */ }
  }

  // Tell a widget its tile's pixel box + devicePixelRatio, so it can scale its
  // content to fit (see the "scale to fit" pattern in docs/WIDGET_SDK.md). This is
  // what lets a widget look IDENTICAL on the desktop browser and the Xeneon Edge —
  // the two surfaces give a tile a different pixel size and DPR, and viewport
  // units (vw/vh) resolve against the iframe's own box, so a fixed-design widget
  // scales by width/REF instead of reflowing. Change-detected (no spam), sent on
  // mount and on every tile resize via a per-entry ResizeObserver.
  function postSize(entry) {
    if (!entry || !entry.ready || !entry.frame) return;
    let r;
    try { r = entry.frame.getBoundingClientRect(); } catch { return; }
    const width = Math.round(r.width);
    const height = Math.round(r.height);
    if (!width || !height) return;   // not laid out / hidden — skip
    const dpr = window.devicePixelRatio || 1;
    if (entry.szW === width && entry.szH === height && entry.szDpr === dpr) return;
    entry.szW = width; entry.szH = height; entry.szDpr = dpr;
    post(entry, { type: 'size', width, height, dpr });
  }

  // A silhouette cuts the corners off the tile, and a guest cannot see what the
  // host did to its frame: introspection stops at the iframe boundary. So the
  // host hands it the safe rectangle to lay out inside, in percent, the same way
  // it hands over size and visibility. A widget that ignores the message is
  // simply clipped, which is what happens today. Change-detected; sent on the
  // handshake and whenever the resolved shape changes.
  function postShape(entry) {
    if (!entry || !entry.ready || !entry.frame) return;
    const info = (typeof window.tileShapeInfoOf === 'function') ? window.tileShapeInfoOf(entry.frame) : null;
    const key = info ? JSON.stringify(info) : '';
    if (entry.shapeKey === key) return;
    entry.shapeKey = key;
    post(entry, info
      ? { type: 'shape', path: info.d, fit: info.fit, safe: info.safe }
      : { type: 'shape', path: '', fit: 'stretch', safe: { t: 0, r: 0, b: 0, l: 0 } });
  }

  // Attach a ResizeObserver that lives ONLY on the entry (no shared registry), so
  // when the entry is dropped from `frames` and its frame from the DOM the whole
  // graph is unreferenced and GC'd — no leak, no explicit teardown at the ~13
  // frame-removal sites. No-op where ResizeObserver is unavailable.
  function observeSize(entry) {
    if (typeof ResizeObserver === 'undefined' || entry.ro) return;
    try { entry.ro = new ResizeObserver(() => postSize(entry)); entry.ro.observe(entry.frame); } catch { /* ignore */ }
  }

  function postExpandState(entry, expanded) {
    if (!entry || !entry.frame || !entry.frame.isConnected) return;
    post(entry, { type: 'expand_state', expanded: !!expanded });
  }

  window.CustomWidgetFrameMessages = { post, postSize, postShape, observeSize, postExpandState };
})();
