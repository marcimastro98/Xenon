// Where a box is while it is edited: px inside the window's root, what the person sees of it,
// fractions for the wire, and how far a drag moves or stretches it.

(() => {
  'use strict';

  const SMALLEST_PX = 48;      // a box with no size of its own in the stylesheet

  // The box of the performance words: their letters go from 12 to 30 px at 5.5% of it
  // (PerfWidget.css), so they stay readable and nothing is left to pull past these.
  const WORDS_WIDTH = Object.freeze({ min: 218, max: 545 });
  const SNAP_PX = 10;          // a box is pulled onto a line this close

  function boxOf(slot, origin) {
    const r = slot.getBoundingClientRect();
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
  }

  const wordsOf = (slot) => slot.querySelector(':scope > [data-dashboard-widget] [data-layer-fit]');

  // What the person sees of a box: its words when it is only words. Their box may be far
  // bigger (five times, on one line), and only a place on the screen can be measured.
  function seenBox(slot, origin) {
    const words = wordsOf(slot);
    const r = words ? words.getBoundingClientRect() : null;
    if (!r || r.width < 1 || r.height < 1) return boxOf(slot, origin);
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
  }

  const smallestOf = (slot) => {
    const style = getComputedStyle(slot);
    return { w: parseFloat(style.getPropertyValue('--layer-min-w')) || SMALLEST_PX, h: parseFloat(style.getPropertyValue('--layer-min-h')) || SMALLEST_PX };
  };

  const fractionOf = (v, of) => Math.round(v / of * 10000) / 10000;

  function rectOf(b, origin) {
    return { x: fractionOf(b.x, origin.width), y: fractionOf(b.y, origin.height), w: fractionOf(b.w, origin.width), h: fractionOf(b.h, origin.height) };
  }

  function fractions(b, origin) {
    const r = rectOf(b, origin);
    return [r.x, r.y, r.w, r.h].join(',');
  }

  // A move writes the saved size back, never the drawn one: a box is drawn bigger than it
  // is saved (the words on one line, the smallest a tile can draw), and saving that grew
  // the widget with every drag.
  function moved(d, dx, dy) {
    if (!d.words) return window.LayerDrag.move({ ...d.seen, ...d.size }, dx, dy, d.area, d.lines, SNAP_PX);
    const step = window.LayerDrag.move(d.seen, dx, dy, d.area, d.lines, SNAP_PX);
    return { box: window.LayerDrag.holdWords(step.box, d.size, d.area), guides: step.guides };
  }

  function stretched(d, dx, dy) {
    if (d.words) return { box: window.LayerDrag.scaleWords(d.seen, d.size, dx, d.area, WORDS_WIDTH), guides: { x: null, y: null } };
    return window.LayerDrag.stretch(d.seen, dx, dy, d.area, d.lines, SNAP_PX, smallestOf(d.entry.slot));
  }

  window.LayerEditGeometry = { wordsOf, seenBox, rectOf, fractions, moved, stretched };
})();
