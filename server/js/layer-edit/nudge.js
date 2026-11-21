// The arrow keys on the widget picked in edit mode: 1 px a press, 10 with Shift, and Shift+Alt
// changes its size instead. Clamped to the screen like a drag, without the pull onto guides
// (it would undo a 1 px step), and saved like a drag, once the keys rest.
// Loaded by js/layers/layer-host.js before js/layer-edit/layer-edit.js, which hands it each key.

(() => {
  'use strict';

  const SAVE_MS = 400;         // one save after the last press, never one per press
  const NO_GUIDES = Object.freeze({ xs: Object.freeze([]), ys: Object.freeze([]) });

  let pending = null;          // { key, mode, d, dx, dy, box, ctx, timer }

  // A key typed into a field stays the field's.
  function typing(target) {
    if (!target || typeof target !== 'object') return false;
    if (target.isContentEditable) return true;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(String(target.tagName || ''));
  }

  // What a key asks: one rule with the map in Xenon (js/layers/layer-drag.js `keyStep`).
  const stepOf = (e) => window.LayerDrag.keyStep(e);

  // The same start a drag takes (js/layer-edit/layer-edit.js `begin`), with no guides.
  function startOf(entry, origin, G) {
    const area = { w: origin.width, h: origin.height };
    const { rect } = entry.box.lead;
    return {
      entry, origin, area, seen: G.seenBox(entry.slot, origin), size: { w: rect.w * area.w, h: rect.h * area.h },
      words: !!G.wordsOf(entry.slot), lines: NO_GUIDES,
    };
  }

  // From moving to sizing or back, before the save: the next steps start from the box drawn
  // now, not from the saved rect, which the server has not changed yet.
  function rebase(p, mode) {
    // Words are measured where they are drawn now; a box is the one just drawn.
    const seen = p.d.words ? p.ctx.geometry.seenBox(p.d.entry.slot, p.d.origin) : p.box;
    p.d = { ...p.d, seen, size: { w: p.box.w, h: p.box.h } };
    Object.assign(p, { mode, dx: 0, dy: 0 });
  }

  function boxAfter(p) {
    const G = p.ctx.geometry;
    return (p.mode === 'move' ? G.moved(p.d, p.dx, p.dy) : G.stretched(p.d, p.dx, p.dy)).box;
  }

  function flush() {
    const p = pending;
    pending = null;
    if (!p) return;
    clearTimeout(p.timer);
    document.removeEventListener('pointerdown', flush, true);
    const rect = p.ctx.geometry.fractions(p.box, p.d.origin);
    p.ctx.run({ type: 'layerMove', target: p.d.entry.box.lead.id, position: 'keep', size: 'keep', rect });
  }

  // Handles one keydown. True when the key was an arrow for the picked widget.
  function key(e, ctx) {
    const step = stepOf(e);
    if (!step || typing(e.target)) return false;
    const entry = ctx.entry();
    if (!entry) return false;
    e.preventDefault();
    if (pending && pending.key !== entry.key) flush();
    if (pending && pending.mode !== step.mode) rebase(pending, step.mode);
    if (!pending) {
      pending = { key: entry.key, mode: step.mode, d: startOf(entry, ctx.api.root().getBoundingClientRect(), ctx.geometry), dx: 0, dy: 0, ctx };
      // A drag or a tap saves the steps first: a save after it would undo it.
      document.addEventListener('pointerdown', flush, true);
    }
    // A step is a pixel of the screen, as on the map: at 150% scale a page pixel is 1.5 of them.
    const scale = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    pending.dx += step.dx / scale;
    pending.dy += step.dy / scale;
    pending.box = boxAfter(pending);
    ctx.show(entry.slot, pending.box, pending.d.origin);
    clearTimeout(pending.timer);
    pending.timer = setTimeout(flush, SAVE_MS);
    return true;
  }

  // A mouse or touchpad on this PC, so most likely a keyboard too: the hint names the keys.
  // On a touch screen alone it keeps to what a finger can do.
  function hasKeys() {
    try { return typeof matchMedia === 'function' && matchMedia('(any-pointer: fine)').matches; } catch (e) { return false; }
  }

  window.LayerEditNudge = Object.freeze({ key, flush, stepOf, typing, hasKeys, SAVE_MS });
})();
