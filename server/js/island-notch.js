// Island notch — the shape a tile takes where the Minimal clock island sits on it.
//
// A tile under the floating island used to shrink from the top so its header
// cleared the clock, which left a dead band beside the island and, when the fit
// pass missed a beat, nothing at all (the clock simply covered the header). The
// tile now keeps its full height and the island bites into its top edge: a cutout
// one ring wider than the island, rounded where it meets the tile, with the tile's
// own hairline drawn along it. The content starts under the cutout.
//
// Pure geometry only, in the tile ITEM's own pixel space (origin at the GridStack
// item's top-left, the visible tile starting `margin` inside it), so it is unit-
// testable and the caller decides when to read the DOM. topbar-minimal.js owns
// the measuring and the writes.
(() => {
  'use strict';

  const GAP = 8;        // ring of wallpaper between the island and the tile
  const SHOULDER = 12;  // radius where the tile's top edge turns into the cutout
  const SPILL = 48;     // clip reaches this far past the tile, so its shadow stays
  const FAR = 10000;    // "the rest of the tile": right/bottom need no measuring
  const MIN_OVERLAP = 12;

  const r1 = (n) => Math.round(n * 2) / 2; // half-pixel steps: stable strings, no churn

  // in: { width, margin, radius, pill: { left, right, bottom, height } }, every
  //     number in item-local px (pill already translated into this item's space).
  // out: null when the island does not sit on this tile, else the cutout:
  //     left/right walls, bottom, corner radii, which sides run off the tile, and
  //     `inset`, how far down the content must start.
  function geometry(m) {
    if (!m || !m.pill) return null;
    const width = Number(m.width) || 0;
    const margin = Math.max(0, Number(m.margin) || 0);
    const radius = Math.max(0, Number(m.radius) || 0);
    const p = m.pill;
    if (!(width > 0) || !(p.right > p.left) || !(p.height > 0)) return null;
    const tileLeft = margin, tileRight = width - margin;
    const left = p.left - GAP, right = p.right + GAP, bottom = p.bottom + GAP;
    if (bottom <= margin + 2) return null;   // the island ends above this tile
    if (Math.min(right, tileRight) - Math.max(left, tileLeft) < MIN_OVERLAP) return null;
    // A cutout that reaches the tile's own rounded corner takes the whole corner.
    const openLeft = left - SHOULDER < tileLeft + radius;
    const openRight = right + SHOULDER > tileRight - radius;
    const depth = bottom - margin;
    const cornerR = Math.max(0, Math.min(p.height / 2 + GAP, depth, (right - left) / 2));
    return {
      left: openLeft ? -SPILL : r1(left),
      right: openRight ? width + SPILL : r1(right),
      bottom: r1(bottom),
      cornerR: r1(cornerR),
      shoulderL: openLeft ? 0 : SHOULDER,
      shoulderR: openRight ? 0 : SHOULDER,
      openLeft, openRight,
      width, margin, radius,
      inset: Math.ceil(depth),
    };
  }

  // The same cutout shrunk to nothing at its own centre: where a notch grows
  // from and shrinks back into, so it can animate (same commands as clipPath).
  function collapsed(g) {
    if (!g) return null;
    const mid = r1((g.left + g.right) / 2);
    return { ...g, left: mid, right: mid, bottom: g.margin, cornerR: 0, shoulderL: 0, shoulderR: 0 };
  }

  // clip-path for the item. ALWAYS the same command list, whatever the case, so
  // the browser can interpolate between two cutouts instead of jumping.
  function clipPath(g) {
    if (!g) return '';
    const { left: a, right: b, bottom: d, cornerR: R, shoulderL: fl, shoulderR: fr, margin: m, width: w } = g;
    return 'path("'
      + `M ${-SPILL} ${-SPILL} H ${a - fl} V ${m} A ${fl} ${fl} 0 0 1 ${a} ${m + fl}`
      + ` V ${d - R} A ${R} ${R} 0 0 0 ${a + R} ${d} H ${b - R} A ${R} ${R} 0 0 0 ${b} ${d - R}`
      + ` V ${m + fr} A ${fr} ${fr} 0 0 1 ${b + fr} ${m} V ${-SPILL} H ${w + SPILL} V ${FAR} H ${-SPILL} Z`
      + '")';
  }

  // The tile's top hairline, redrawn along the cutout (the tile's own top border
  // is spent on the content inset). Drawn half a line inside the edge, so a
  // `line`-px stroke lands exactly where the tile's border would.
  function edgePath(g, line) {
    if (!g) return '';
    const o = Math.max(0, Number(line) || 1) / 2;
    const { left, right, bottom, cornerR, shoulderL, shoulderR, margin: m, width: w, radius } = g;
    const top = m + o, tl = m + o, tr = w - m - o;
    const rt = Math.max(0, radius - o);
    const a = left - o, b = right + o, d = bottom + o;
    const R = cornerR + o;
    // Shoulder radii a half line smaller: same centres as the clip's corners.
    const sl = Math.max(0, shoulderL - o), sr = Math.max(0, shoulderR - o);
    // Each closed side keeps its arcs even at radius 0, so a growing or shrinking
    // cutout keeps one command list and the line can animate with the clip.
    const head = g.openLeft
      ? `M ${tl} ${d}`
      : `M ${tl} ${top + rt} A ${rt} ${rt} 0 0 1 ${tl + rt} ${top} H ${a - sl}`
        + ` A ${sl} ${sl} 0 0 1 ${a} ${top + sl} V ${d - R} A ${R} ${R} 0 0 0 ${a + R} ${d}`;
    const tail = g.openRight
      ? ` H ${tr}`
      : ` H ${b - R} A ${R} ${R} 0 0 0 ${b} ${d - R} V ${top + sr} A ${sr} ${sr} 0 0 1 ${b + sr} ${top}`
        + ` H ${tr - rt} A ${rt} ${rt} 0 0 1 ${tr} ${top + rt}`;
    return head + tail;
  }

  const api = { geometry, collapsed, clipPath, edgePath, GAP };
  if (typeof window !== 'undefined') window.IslandNotch = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
