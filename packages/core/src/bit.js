;((root, factory) => {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const clips = node ? require('./bit-clips.js') : root.Xenon.bitClips;
  // Extra clip packs (the hatch, life moments). In a page a pack loaded before this file
  // waits in Xenon.bitPacks, one loaded after calls addPack(); a page that skips one just
  // lacks those clips.
  const packs = node ? [require('./bit-clips-life.js')] : (root.Xenon?.bitPacks) || [];
  const mod = factory(clips, packs);
  if (node) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bit = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, (data, packs) => {
  'use strict';

  /* Bit's renderer: a clip frame in, plain rectangles out. Pure, so the same
   * output feeds the live SVG player, the export tool and the tests. Layers
   * are drawn in order: shadow, back extras, glitch ghosts, body (with its
   * face and attached extras, moved by the frame's transform), front extras. */

  const { INK, MOOD_RGB, BODY, EYES, MOUTHS, BROWS, CHEEKS, POKES } = data;
  const PARTS = Object.assign({}, data.PARTS);
  const CLIPS = [...data.CLIPS];

  // The stage around Bit's 12x12 grid; see bit-clips.js for the coordinates.
  const STAGE = Object.freeze({ x: -3, y: -5, w: 18, h: 17 });
  const PIVOT_X = 6;
  const FLOOR_Y = 11;
  const GLITCH = ['255,90,95', '94,234,212'];

  const BY_ID = new Map(CLIPS.map((c) => [c.id, c]));

  function clip(id) {
    return BY_ID.get(id) || null;
  }

  /** Adds a clip pack's parts and clips; an id already known keeps its first definition. */
  function addPack(pack) {
    for (const [name, part] of Object.entries((pack?.PARTS) || {})) if (!(name in PARTS)) PARTS[name] = part;
    for (const c of (pack?.CLIPS) || []) {
      if (BY_ID.has(c.id)) continue;
      CLIPS.push(c);
      BY_ID.set(c.id, c);
    }
  }
  packs.forEach(addPack);

  function rgb(tint) {
    if (!tint) return MOOD_RGB.idle;
    return MOOD_RGB[tint] || (/^\d{1,3},\d{1,3},\d{1,3}$/.test(tint) ? tint : MOOD_RGB.idle);
  }

  function shapeCells(shape) {
    if (!shape) return { fill: INK, cells: [] };
    return Array.isArray(shape) ? { fill: INK, cells: shape } : shape;
  }

  function rects(cells, fill, dx = 0, dy = 0, o = 1) {
    return cells.map(([x, y, w = 1, h = 1]) => ({ x: x + dx, y: y + dy, w, h, fill, o }));
  }

  // An extra is 'name' or ['name', dx, dy, opacity]; unknown names are skipped.
  function extra(entry, bodyFill, accent) {
    const [name, dx = 0, dy = 0, op = 1] = Array.isArray(entry) ? entry : [entry];
    const part = PARTS[name];
    if (!part || op <= 0) return null;
    const fill = part.fill === 'body' ? bodyFill : part.fill === 'accent' ? accent : part.fill;
    const o = op * (part.opacity == null ? 1 : part.opacity);
    return { part, rects: rects(part.cells, fill, dx, dy, o) };
  }

  // A personal look (bit-look.js) recolours the ink eyes and brings its own cheeks.
  function face(frame, look) {
    const eyes = shapeCells(EYES[frame.eyes || 'open'] || EYES.open);
    const mouth = shapeCells(MOUTHS[frame.mouth || 'flat'] || MOUTHS.flat);
    const brows = shapeCells(BROWS[frame.brows || 'none'] || BROWS.none);
    const eyeFill = look && eyes.fill === INK ? look.eyes : eyes.fill;
    const out = [...rects(eyes.cells, eyeFill), ...rects(mouth.cells, mouth.fill), ...rects(brows.cells, brows.fill)];
    const ch = look ? look.cheeks : CHEEKS;
    if (frame.cheeks || ch.always) out.unshift(...rects(ch.cells, ch.fill, 0, 0, frame.cheeks ? Math.max(ch.opacity, CHEEKS.opacity) : ch.opacity));
    return out;
  }

  // The look's markings, antenna tip (its light shows the mood) and worn items.
  function personal(look, mood, over) {
    return [...look.marks, ...look.tip.stem, ...rects(look.tip.light, mood), ...over];
  }

  // A half-cell ring of the body shape, so a pale Bit stays visible on a pale background.
  function outline(fill) {
    return [[-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5]].flatMap(([dx, dy]) => rects(BODY, fill, dx, dy));
  }

  // Body transform: move by dx/dy, scale from the middle of the feet.
  function transform(frame) {
    const dx = frame.dx || 0;
    const dy = frame.dy || 0;
    const sx = frame.sx == null ? 1 : frame.sx;
    const sy = frame.sy == null ? 1 : frame.sy;
    if (!dx && !dy && sx === 1 && sy === 1) return null;
    return { dx, dy, sx, sy, px: PIVOT_X, py: FLOOR_Y };
  }

  /* A worn item that would leave the stage in any frame of a clip is set down
   * for that whole clip (a held mug in the moonwalk) instead of being cut off.
   * Cached per clip and item: the answer depends only on the item's cells. */
  const fitCache = new WeakMap();
  function inStage(frame, box) {
    const { dx, dy, sx, sy } = transform(frame) || { dx: 0, dy: 0, sx: 1, sy: 1 };
    const xs = [box.x0, box.x1].map((v) => dx + PIVOT_X + sx * (v - PIVOT_X));
    const top = dy + FLOOR_Y + sy * (box.y0 - FLOOR_Y);
    return Math.min(...xs) >= STAGE.x - 0.01 && Math.max(...xs) <= STAGE.x + STAGE.w + 0.01 && top >= STAGE.y - 0.01;
  }
  function wornFor(look, c) {
    if (!fitCache.has(c)) fitCache.set(c, new Map());
    const fits = fitCache.get(c);
    const out = { behind: [], over: [], face: [] };
    for (const w of look.worn) {
      if (!fits.has(w.id)) fits.set(w.id, c.frames.every((f) => inStage(f, w.box)));
      if (fits.get(w.id)) for (const k of Object.keys(out)) out[k].push(...w[k]);
    }
    return out;
  }

  /**
   * Render one frame of a clip to layers of rectangles.
   * @param {object|string} clipOrId  a clip from bit-clips.js or its id
   * @param {number} index            frame index (wraps)
   * @param {{tint?: string, look?: { body: string, accent: string, outline?: string } & Record<string, any>}} [opts]  tint overrides the clip's color;
   *   look (bit-look.js) draws a personal Bit, whose mood then lights the antenna tip
   * @returns {{ layers: Array<{ transform: object|null, clipFloor: boolean, rects: Array }> }}
   */
  function renderFrame(clipOrId, index = 0, opts = {}) {
    const c = typeof clipOrId === 'string' ? clip(clipOrId) : clipOrId;
    if (!c?.frames.length) throw new Error(`Unknown Bit clip: ${clipOrId}`);
    const frame = c.frames[((index % c.frames.length) + c.frames.length) % c.frames.length];
    const mood = `rgb(${rgb(frame.tint || opts.tint || c.tint)})`;
    const look = opts.look || null;
    const fill = look ? look.body : mood;
    const worn = look ? wornFor(look, c) : null;
    const t = transform(frame);

    const back = [];
    const front = [];
    const attached = [];
    for (const entry of frame.ex || []) {
      const e = extra(entry, fill, look ? look.accent : fill);
      if (!e) continue;
      if (e.part.back) back.push(...e.rects);
      else if (e.part.attach) attached.push(...e.rects);
      else front.push(...e.rects);
    }

    const layers = [];
    if (!frame.noShadow) {
      const lift = Math.max(0, -(frame.dy || 0));
      const w = Math.max(2, 6 - lift);
      layers.push({ transform: null, clipFloor: false, rects: [{ x: PIVOT_X - w / 2 + (frame.dx || 0), y: FLOOR_Y, w, h: 0.6, fill, o: 0.16 }] });
    }
    if (back.length) layers.push({ transform: null, clipFloor: false, rects: back });
    if (frame.glitch) {
      const off = frame.glitch;
      GLITCH.forEach((g, k) => {
        const shift = k ? off : -off;
        layers.push({ transform: t, clipFloor: true, rects: rects(BODY, `rgb(${g})`, shift, 0, 0.75) });
      });
    }
    if (look?.outline) layers.push({ transform: t, clipFloor: true, rects: outline(look.outline) });
    if (worn?.behind.length) layers.push({ transform: t, clipFloor: true, rects: worn.behind });
    const own = look ? personal(look, mood, worn.over) : [];
    layers.push({ transform: t, clipFloor: true, rects: [...rects(BODY, fill), ...own, ...attached, ...(worn ? worn.face : []), ...face(frame, look)] });
    if (front.length) layers.push({ transform: null, clipFloor: false, rects: front });
    return { layers };
  }

  function round(n) {
    return Math.round(n * 1000) / 1000;
  }

  function transformAttr(t) {
    if (!t) return '';
    const tx = round(t.dx + t.px - t.px * t.sx);
    const ty = round(t.dy + t.py - t.py * t.sy);
    return `translate(${tx} ${ty}) scale(${round(t.sx)} ${round(t.sy)})`;
  }

  /**
   * A layer's rects as paths, one per run of the same colour, in paint order.
   * Bit is painted anti-aliased on purpose: crispEdges snaps every cell on its
   * own, so at 2.5 device pixels a cell (a 20 px icon at 150%) one eye comes out
   * 2 px wide and the other 3. One path per colour leaves no seam between cells.
   * @returns {{d: string, fill: string, o: number}[]}
   */
  function paths(rects) {
    const out = [];
    for (const r of rects) {
      const seg = `M${round(r.x)} ${round(r.y)}h${round(r.w)}v${round(r.h)}h${round(-r.w)}z`;
      const last = out[out.length - 1];
      if (last && last.fill === r.fill && last.o === r.o) last.d += seg;
      else out.push({ d: seg, fill: r.fill, o: r.o });
    }
    return out;
  }

  /**
   * One frame as standalone SVG markup, for the export tool and static
   * images. Only numbers and colors from bit-clips.js go in, never user text.
   */
  function frameSvg(clipOrId, index = 0, opts = {}) {
    const { layers } = renderFrame(clipOrId, index, opts);
    const size = opts.size || 144;
    const clipId = /^[A-Za-z][\w-]{0,40}$/.test(opts.clipId || '') ? opts.clipId : 'bitfloor';
    const body = layers
      .map((l) => {
        const rs = paths(l.rects)
          .map((p) => `<path d="${p.d}" fill="${p.fill}"${p.o < 1 ? ` opacity="${round(p.o)}"` : ''}/>`)
          .join('');
        const tr = transformAttr(l.transform);
        const g = `<g${tr ? ` transform="${tr}"` : ''}>${rs}</g>`;
        return l.clipFloor ? `<g clip-path="url(#${clipId})">${g}</g>` : g;
      })
      .join('');
    const bg = opts.background ? `<rect x="${STAGE.x}" y="${STAGE.y}" width="${STAGE.w}" height="${STAGE.h}" fill="${opts.background}"/>` : '';
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${STAGE.x} ${STAGE.y} ${STAGE.w} ${STAGE.h}" width="${size}" height="${round((size * STAGE.h) / STAGE.w)}">` +
      `<defs><clipPath id="${clipId}"><rect x="${STAGE.x}" y="${STAGE.y}" width="${STAGE.w}" height="${FLOOR_Y - STAGE.y}"/></clipPath></defs>` +
      bg +
      body +
      '</svg>'
    );
  }

  function duration(clipOrId) {
    const c = typeof clipOrId === 'string' ? clip(clipOrId) : clipOrId;
    return c ? c.frames.reduce((s, f) => s + f.ms, 0) : 0;
  }

  return {
    STAGE,
    INK,
    MOOD_RGB,
    POKES,
    parts: PARTS,
    clips: CLIPS,
    clip,
    addPack,
    rgb,
    renderFrame,
    paths,
    frameSvg,
    transformAttr,
    duration,
  };
});
