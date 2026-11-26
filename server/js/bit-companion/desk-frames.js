'use strict';
// Bit on the desktop, its pictures: the clips in the person's own look as cells on one fixed grid
// (shared/src/bit-cells.js), and its ways of going and coming (shared/src/bit-cells-warp.js), as the
// frames of one `xenon-app:bit-desk` message. desk.js decides what it does and when; this only
// draws. Loaded by companion.js with desk.js, only in the shell that can draw it.
(() => {
  // One grid for every clip, so a clip never resizes the window: room for what Bit holds up and
  // out, its feet on the bottom rows. BODY rows (from just over its head down) must fit the bar.
  const BOX = { x0: -4, x1: 15, y0: -8, y1: 12, max: 24 };
  const BODY = BOX.y1 + 2;
  const MAX_FRAMES = 24;
  const NOTHING = { clip: { frames: [{ ms: 1000 }] }, maps: [new Map()] }; // the loop between going and coming
  const cache = new WeakMap(); // look -> Map(clip id -> cells of each frame)

  const engine = () => window.Xenon || {};

  /** The cells of every frame of a clip in this look, or null for a clip the shell can't take. */
  function cellsOf(id, look) {
    const { bit, bitCells } = engine();
    const clip = bit?.clip(id);
    if (!clip || !bitCells || clip.frames.length > MAX_FRAMES) return null;
    if (!cache.has(look)) cache.set(look, new Map());
    const byClip = cache.get(look);
    if (!byClip.has(id)) byClip.set(id, clip.frames.map((_, i) => bitCells.cells(bit.renderFrame(clip, i, { look }).layers)));
    return { clip, maps: byClip.get(id) };
  }

  // A way of going or coming, made once (kept on the `once` desk.js holds) from the frame it stands in.
  function warpCells(w, stand) {
    if (!w.cells) {
      const made = engine().bitCellsWarp?.frames(w.kind, stand.maps[0], w.seq);
      w.cells = made ? { clip: { frames: made.maps.map(() => ({ ms: made.ms })) }, maps: made.maps } : null;
    }
    return w.cells;
  }

  // Its sign (signs.js) over its head on the right, on every frame of Bit itself: not on a way of going.
  const SIGN_AT = { x: BOX.x1 - 4, y: BOX.y0 };
  function signed(part, sign) {
    return sign && part ? { clip: part.clip, maps: part.maps.map((m) => new Map([...m, ...sign])) } : part;
  }

  // Frames on the common grid: the loop, then the clip played once when one is on.
  function framesOn(loop, extra, reduced) {
    const maps = loop.maps.concat(extra ? extra.maps : []);
    const g = engine().bitCells.grid(maps, BOX);
    if (!g) return null;
    const rows = (clip, from) => clip.frames.map((f, i) => ({ ms: Math.round(f.ms), rows: g.frames[from + i] }));
    const still = reduced ? 1 : loop.clip.frames.length;
    return { pal: g.palette, loop: rows(loop.clip, 0).slice(0, still), once: extra ? rows(extra.clip, loop.maps.length) : null };
  }

  /**
   * The frames of one message: its loop (nothing at all while it is gone), and the clip or the way
   * of going or coming played once. Null when the look gives nothing the shell can take.
   * @param {{ look: object, loopId: string, once: object|null, gone: boolean, reduced: boolean, sign?: string }} now
   */
  function picture({ look, loopId, once, gone, reduced, sign }) {
    const stand = cellsOf(loopId, look) || cellsOf('idle', look);
    if (!stand) return null;
    const extra = once && (once.kind ? warpCells(once, stand) : cellsOf(once.id, look));
    // Gone: one empty frame, with its own frame after it (never played) so the grid keeps its colours.
    const loop = gone ? { clip: NOTHING.clip, maps: [...NOTHING.maps, stand.maps[0]] } : stand;
    const mark = !gone && sign ? window.BitSigns?.at(sign, SIGN_AT.x, SIGN_AT.y) : null;
    // A sign whose colours do not fit the grid's palette is left out, never the Bit.
    const withSign = mark && framesOn(signed(loop, mark), once?.kind ? extra : signed(extra, mark), reduced);
    return withSign || framesOn(loop, extra, reduced) || framesOn(stand, null, reduced);
  }

  window.BitDeskFrames = Object.freeze({ BODY, COLS: BOX.x1 - BOX.x0 + 1, cellsOf, picture });
})();
