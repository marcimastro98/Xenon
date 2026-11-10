'use strict';

// A Store widget that declares `fit` (manifest) sizes its own box on the desktop and
// over everything: it posts { type: 'layer', fit: { w, h } } in CSS px, js/custom-widget.js
// passes it here, and the box takes that size from the corner it leans on, so a
// counter in the top right grows to the left and down, never off the screen. The size
// is saved through the same layerMove capability every other move uses, so the
// server's rules decide what is stored. A tab group, an anchored window and edit mode
// keep their own size.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) root.LayerFit = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const MIN_PX = 16;
  const SAME_PX = 1.5;      // a box within a pixel and a half is already the asked size
  const SAVE_DELAY_MS = 400; // a widget that settles in a few steps is saved once
  const round = (v) => Math.round(v * 10000) / 10000;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // The asked px size as fractions of the window, held to the corner the box leans on
  // (lean: { h: left|middle|right, v: top|bottom }) and kept inside the window.
  function rectFor(box, want, win, lean) {
    const w = clamp(want.w, MIN_PX, win.width) / win.width;
    const h = clamp(want.h, MIN_PX, win.height) / win.height;
    const right = box.x + box.w;
    const bottom = box.y + box.h;
    let x = lean.h === 'right' ? right - w : lean.h === 'middle' ? box.x + box.w / 2 - w / 2 : box.x;
    let y = lean.v === 'bottom' ? bottom - h : box.y;
    x = clamp(x, 0, 1 - w);
    y = clamp(y, 0, 1 - h);
    return { x: round(x), y: round(y), w: round(w), h: round(h) };
  }

  const sameSize = (box, want, win) => Math.abs(box.w * win.width - want.w) < SAME_PX && Math.abs(box.h * win.height - want.h) < SAME_PX;

  // The asked size, or null: two finite px numbers, nothing else.
  function cleanWant(fit) {
    if (!fit || typeof fit !== 'object') return null;
    const w = Number(fit.w);
    const h = Number(fit.h);
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : null;
  }

  // ── Browser side ─────────────────────────────────────────────────────────
  const timers = new WeakMap();

  function boxOf(slot) {
    const v = (name) => (parseFloat(slot.style.getPropertyValue(name)) || 0) / 100;
    return { x: v('--layer-x'), y: v('--layer-y'), w: v('--layer-w'), h: v('--layer-h') };
  }

  function show(slot, r) {
    slot.style.setProperty('--layer-x', (r.x * 100) + '%');
    slot.style.setProperty('--layer-y', (r.y * 100) + '%');
    slot.style.setProperty('--layer-w', (r.w * 100) + '%');
    slot.style.setProperty('--layer-h', (r.h * 100) + '%');
  }

  function save(slot, r) {
    clearTimeout(timers.get(slot));
    timers.set(slot, setTimeout(() => {
      const action = { type: 'layerMove', target: slot.dataset.layerId, rect: [r.x, r.y, r.w, r.h].join(',') };
      fetch('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) })
        .catch(() => { /* shown now; the stored size returns at the next placement */ });
    }, SAVE_DELAY_MS));
  }

  // From the widget's frame: '' when done (or already that size), else why not.
  function request(frame, fit) {
    const host = window.LayerHost;
    const asked = cleanWant(fit);
    if (!asked) return 'bad_request';
    if (!host || !host.active) return 'not_in_layer';
    if (host.surface === 'anchor') return 'unavailable';
    if (host.editing()) return 'busy';
    const slot = frame.closest('.layer-slot');
    if (!slot || slot.querySelector('.layer-tabs')) return 'unavailable';
    const area = slot.parentElement ? slot.parentElement.getBoundingClientRect() : null;
    if (!area || !area.width || !area.height) return 'unavailable';
    const win = { width: area.width, height: area.height };
    // The widget measured its own content: the box also holds the tile's edge around the frame.
    const outer = slot.getBoundingClientRect();
    const inner = frame.getBoundingClientRect();
    const want = { w: asked.w + Math.max(0, outer.width - inner.width), h: asked.h + Math.max(0, outer.height - inner.height) };
    const box = boxOf(slot);
    if (sameSize(box, want, win)) return '';
    const next = rectFor(box, want, win, { h: slot.dataset.h, v: slot.dataset.v });
    show(slot, next);
    if (host.refreshRects) host.refreshRects();
    save(slot, next);
    return '';
  }

  return Object.freeze({ rectFor, sameSize, cleanWant, request });
});
