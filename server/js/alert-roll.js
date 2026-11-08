// Closing a card on the on-screen alerts window, on Windows.
//
// There the window is see-through and the shell's cut decides what shows. A card
// that fades, or leaves before the cut closes, uncovers bare window for a moment,
// and that moment was seen as a white box. So the card stays where it is, opaque,
// while the shell rolls the cut shut over it (layers/roll.rs), and it leaves the
// page only once nothing of it shows. No screenshot tool can check this: the window
// stays out of captures on purpose.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.AlertRoll = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Pinned equal to ROLL_MS in layers/roll.rs (test/alert-roll.test.mjs).
  const ROLL_MS = 220;
  // The shell starts a frame or two after the page asks.
  const MARGIN_MS = 40;

  const after = (ms) => new Promise((done) => { setTimeout(done, ms); });

  // `rectsOf(el)`: what the cut holds for that element, as "x,y,w,h" strings.
  // `send(rects)`: asks the shell to roll them. Two signals in one task overwrite
  // each other, so cards closing together (Clear all) go out as one.
  function create({ rectsOf, send, changed, wait = after, later = queueMicrotask }) {
    let queued = [];

    function flush() {
      const rects = queued.join(';');
      queued = [];
      send(rects);
    }

    // Null when nothing of `el` is in the cut: the caller just removes it.
    function away(el) {
      const rects = rectsOf(el);
      if (!rects.length) return null;
      el.classList.add('is-rolling');
      if (!queued.length) later(flush);
      queued.push(...rects);
      return {
        done: wait(ROLL_MS + MARGIN_MS),
        cancel() { el.classList.remove('is-rolling'); changed(); },
      };
    }

    return { away };
  }

  return { create, ROLL_MS, MARGIN_MS };
});
