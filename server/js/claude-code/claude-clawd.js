'use strict';
// Clawd, Claude Code's pixel mascot, as an SVG the Claude tile and the topbar
// marker both draw. One sprite, animated by CSS from the state class its
// container carries (ClaudeWidget.css): walking while a session works, hopping
// when it is blocked on you, blinking when it is done, asleep when it ended.
//
// The geometry is not a drawing from memory. It was read back out of the
// sprite: the PNG was decoded, the body colour measured (#D77757, which is the
// orange this codebase already carries as #D97757; see ClaudeWidget.css), the
// cell edges found from the pixel runs, and the whole thing resampled onto its
// real 16x12 grid:
//
//     ..############..      rows 0-1   head
//     ..############..
//     ..##.######.##..      rows 2-4   eyes, as HOLES at cols 4 and 11
//     ..##.######.##..
//     ..##.######.##..
//     ################      rows 5-6   arms, two cells proud on each side
//     ################
//     ..############..      rows 7-9   body
//     ..############..
//     ..############..
//     ...#.#....#.#...      rows 10-11 four legs, at cols 3, 5, 10, 12
//     ...#.#....#.#...
//
// Drawn as merged runs rather than 150 one-unit rects, split into the groups
// the animation moves independently: the shell, each pair of legs, and two eye
// covers painted in the body colour to blink or sleep.
(function () {
  const CLAWD = Object.freeze({
    shell: [[2, 0, 12, 2], [2, 2, 2, 3], [5, 2, 6, 3], [12, 2, 2, 3], [0, 5, 16, 2], [2, 7, 12, 3]],
    legL: [[3, 10, 1, 2], [5, 10, 1, 2]],
    legR: [[10, 10, 1, 2], [12, 10, 1, 2]],
    eyes: [[4, 2, 1, 3], [11, 2, 1, 3]],
  });
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function rects(parent, list, cls) {
    const g = document.createElementNS(SVG_NS, 'g');
    if (cls) g.setAttribute('class', cls);
    for (const [x, y, w, h] of list) {
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', x); r.setAttribute('y', y);
      r.setAttribute('width', w); r.setAttribute('height', h);
      g.appendChild(r);
    }
    parent.appendChild(g);
    return g;
  }

  /** A fresh sprite. `cls` sizes it; colour is `currentColor`. */
  function make(cls) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 12');
    svg.setAttribute('class', cls || 'cw-clawd-svg');
    svg.setAttribute('aria-hidden', 'true');
    // Square pixels, whatever the device ratio: the whole point of the thing.
    svg.setAttribute('shape-rendering', 'crispEdges');
    rects(svg, CLAWD.shell, 'cw-cl-shell');
    rects(svg, CLAWD.legL, 'cw-cl-leg cw-cl-legl');
    rects(svg, CLAWD.legR, 'cw-cl-leg cw-cl-legr');
    // Same colour as the shell, revealed only to blink or sleep. An eye is a
    // hole in this sprite, so closing one means filling it back in.
    rects(svg, CLAWD.eyes, 'cw-cl-eyes');
    return svg;
  }

  window.ClaudeClawd = { make };
})();
