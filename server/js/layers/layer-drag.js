'use strict';

// One way to drag a widget, for the map of the Xenon menu and for the real screen.
// A move never changes the size, a box reaches the true edge, and where it is at the
// release is where it stays: nothing here jumps afterwards, and nothing makes tabs.
// Pure and in the caller's units: pixels on the screen, fractions on the map.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LayerDrag = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Where the bar of edit mode may go, the first ones first.
  const SPOTS = Object.freeze(['top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right']);

  const clamp = (v, low, high) => Math.min(Math.max(v, low), Math.max(low, high));
  const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  // What a box is pulled to: the edges and the middle of its screen, and the sides of
  // the boxes around it.
  function linesFor(area, others) {
    const xs = [0, area.w / 2, area.w];
    const ys = [0, area.h / 2, area.h];
    for (const b of others || []) {
      xs.push(b.x, b.x + b.w);
      ys.push(b.y, b.y + b.h);
    }
    return { xs, ys };
  }

  // The nearest line to the box's near edge, middle or far edge, within `snap`.
  function pull(pos, size, lines, snap) {
    let best = null;
    for (const off of [0, size / 2, size]) {
      for (const line of lines) {
        const gap = Math.abs(line - (pos + off));
        if (gap <= snap && (!best || gap < best.gap)) best = { gap, pos: line - off, line };
      }
    }
    return best ? { pos: best.pos, line: best.line } : { pos, line: null };
  }

  // The box `dx`, `dy` from where it started, and the lines it sits on (null for none).
  function move(start, dx, dy, area, lines, snap) {
    const x = pull(start.x + dx, start.w, lines.xs, snap);
    const y = pull(start.y + dy, start.h, lines.ys, snap);
    return {
      box: { x: clamp(x.pos, 0, area.w - start.w), y: clamp(y.pos, 0, area.h - start.h), w: start.w, h: start.h },
      guides: { x: x.line, y: y.line },
    };
  }

  // The corner of a box: the top left stays put, the corner meets the same lines a move
  // does, and the box never gets under `min`.
  function stretch(start, dx, dy, area, lines, snap, min) {
    const right = pull(start.x + start.w + dx, 0, lines.xs, snap);
    const bottom = pull(start.y + start.h + dy, 0, lines.ys, snap);
    return {
      box: { x: start.x, y: start.y, w: clamp(right.pos - start.x, min.w, area.w - start.x), h: clamp(bottom.pos - start.y, min.h, area.h - start.y) },
      guides: { x: right.line, y: bottom.line },
    };
  }

  const sameShare = (at, seen, size, whole) => (seen < whole ? at / (whole - seen) * (whole - size) : 0);

  // Words stand at the same share of the room the screen leaves them as their box does
  // (LayersModel.shareOf). The box of `size` that shows them at `seen`: one for every spot
  // on the screen, so they follow the pointer anywhere and stay where they are let go.
  function holdWords(seen, size, area) {
    return { x: sameShare(seen.x, seen.w, size.w, area.w), y: sameShare(seen.y, seen.h, size.h, area.h), ...size };
  }

  // Words grow with their box, as a whole: `seen` is where they are, `size` their box,
  // `range` the widths of the box between which their letters change at all.
  function scaleWords(seen, size, dx, area, range) {
    const most = Math.min(range.max / size.w, area.w / seen.w, area.h / seen.h);
    const factor = clamp((seen.w + dx) / seen.w, Math.min(1, range.min / size.w), Math.max(1, most));
    const w = seen.w * factor;
    const h = seen.h * factor;
    // Against the far edge they grow back from it: a corner must not stop them growing.
    const at = { x: Math.min(seen.x, area.w - w), y: Math.min(seen.y, area.h - h), w, h };
    return holdWords(at, { w: size.w * factor, h: size.h * factor }, area);
  }

  // The same box on another screen: as big in real pixels, the grab point kept in the
  // middle of it. Fractions in, fractions out; `from` and `to` are sizes in pixels.
  function carry(box, from, to, grab) {
    const w = Math.min(1, box.w * from.w / to.w);
    const h = Math.min(1, box.h * from.h / to.h);
    return { x: clamp(grab.x - w / 2, 0, 1 - w), y: clamp(grab.y - h / 2, 0, 1 - h), w, h };
  }

  function spotBox(spot, area, size, edge) {
    const x = spot.endsWith('left') ? edge : spot.endsWith('right') ? area.w - size.w - edge : (area.w - size.w) / 2;
    return { x, y: spot.startsWith('bottom') ? area.h - size.h - edge : edge, ...size };
  }

  // The first spot for something of `size` that covers none of `boxes`; the first of
  // all when the screen is full.
  function freeSpot(area, size, boxes, edge) {
    return SPOTS.find((spot) => !boxes.some((b) => overlap(spotBox(spot, area, size, edge), b))) || SPOTS[0];
  }

  return Object.freeze({ linesFor, pull, move, stretch, holdWords, scaleWords, carry, freeSpot });
});
