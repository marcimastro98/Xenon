;(function (root, factory) {
  'use strict';
  const clips = typeof module === 'object' && module.exports ? require('./bit-clips.js') : root.Xenon.bitClips;
  const mod = factory(clips);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bit = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (data) {
  'use strict';

  /* Bit's renderer: a clip frame in, plain rectangles out. Pure, so the same
   * output feeds the live SVG player, the export tool and the tests. Layers
   * are drawn in order: shadow, back extras, glitch ghosts, body (with its
   * face and attached extras, moved by the frame's transform), front extras. */

  const { INK, MOOD_RGB, BODY, EYES, MOUTHS, BROWS, CHEEKS, PARTS, CLIPS, POKES } = data;

  // The stage around Bit's 12x12 grid; see bit-clips.js for the coordinates.
  const STAGE = Object.freeze({ x: -3, y: -5, w: 18, h: 17 });
  const PIVOT_X = 6;
  const FLOOR_Y = 11;
  const GLITCH = ['255,90,95', '94,234,212'];

  const BY_ID = new Map(CLIPS.map((c) => [c.id, c]));

  function clip(id) {
    return BY_ID.get(id) || null;
  }

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
  function extra(entry, bodyFill) {
    const [name, dx = 0, dy = 0, op = 1] = Array.isArray(entry) ? entry : [entry];
    const part = PARTS[name];
    if (!part || op <= 0) return null;
    const fill = part.fill === 'body' ? bodyFill : part.fill;
    const o = op * (part.opacity == null ? 1 : part.opacity);
    return { part, rects: rects(part.cells, fill, dx, dy, o) };
  }

  function face(frame) {
    const eyes = shapeCells(EYES[frame.eyes || 'open'] || EYES.open);
    const mouth = shapeCells(MOUTHS[frame.mouth || 'flat'] || MOUTHS.flat);
    const brows = shapeCells(BROWS[frame.brows || 'none'] || BROWS.none);
    const out = [...rects(eyes.cells, eyes.fill), ...rects(mouth.cells, mouth.fill), ...rects(brows.cells, brows.fill)];
    if (frame.cheeks) out.unshift(...rects(CHEEKS.cells, CHEEKS.fill, 0, 0, CHEEKS.opacity));
    return out;
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

  /**
   * Render one frame of a clip to layers of rectangles.
   * @param {object|string} clipOrId  a clip from bit-clips.js or its id
   * @param {number} index            frame index (wraps)
   * @param {{tint?: string}} [opts]  tint overrides the clip's color
   * @returns {{ layers: Array<{ transform: object|null, clipFloor: boolean, rects: Array }> }}
   */
  function renderFrame(clipOrId, index = 0, opts = {}) {
    const c = typeof clipOrId === 'string' ? clip(clipOrId) : clipOrId;
    if (!c || !c.frames.length) throw new Error(`Unknown Bit clip: ${clipOrId}`);
    const frame = c.frames[((index % c.frames.length) + c.frames.length) % c.frames.length];
    const fill = `rgb(${rgb(frame.tint || opts.tint || c.tint)})`;
    const t = transform(frame);

    const back = [];
    const front = [];
    const attached = [];
    for (const entry of frame.ex || []) {
      const e = extra(entry, fill);
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
    layers.push({ transform: t, clipFloor: true, rects: [...rects(BODY, fill), ...attached, ...face(frame)] });
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
   * One frame as standalone SVG markup, for the export tool and static
   * images. Only numbers and colors from bit-clips.js go in, never user text.
   */
  function frameSvg(clipOrId, index = 0, opts = {}) {
    const { layers } = renderFrame(clipOrId, index, opts);
    const size = opts.size || 144;
    const clipId = /^[A-Za-z][\w-]{0,40}$/.test(opts.clipId || '') ? opts.clipId : 'bitfloor';
    const body = layers
      .map((l) => {
        const rs = l.rects
          .map((r) => `<rect x="${round(r.x)}" y="${round(r.y)}" width="${round(r.w)}" height="${round(r.h)}" fill="${r.fill}"${r.o < 1 ? ` opacity="${round(r.o)}"` : ''}/>`)
          .join('');
        const tr = transformAttr(l.transform);
        const g = `<g${tr ? ` transform="${tr}"` : ''}>${rs}</g>`;
        return l.clipFloor ? `<g clip-path="url(#${clipId})">${g}</g>` : g;
      })
      .join('');
    const bg = opts.background ? `<rect x="${STAGE.x}" y="${STAGE.y}" width="${STAGE.w}" height="${STAGE.h}" fill="${opts.background}"/>` : '';
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${STAGE.x} ${STAGE.y} ${STAGE.w} ${STAGE.h}" width="${size}" height="${round((size * STAGE.h) / STAGE.w)}" shape-rendering="crispEdges">` +
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

  // ── choosing what Bit does next ───────────────────────────────

  function inHours(range, hour) {
    const [a, b] = range;
    return a <= b ? hour >= a && hour <= b : hour >= a || hour <= b;
  }

  function oneOf(want, have) {
    return Array.isArray(want) ? want.includes(have) : want === have;
  }

  /** Does a clip's `when` fit the moment? Clips without `when` always fit. */
  function fits(c, ctx = {}) {
    const w = c.when;
    if (!w) return true;
    if (w.hours && !(Number.isFinite(ctx.hour) && inHours(w.hours, ctx.hour))) return false;
    if (w.weather && !oneOf(w.weather, ctx.weather)) return false;
    if (w.season && !oneOf(w.season, ctx.season)) return false;
    for (const flag of ['hot', 'cold', 'music', 'gaming', 'cpuHot']) {
      if (w[flag] && !ctx[flag]) return false;
    }
    return true;
  }

  /**
   * Pick the next idle fidget: weighted, fitted to the moment, never one of
   * the last few played, rare ones only now and then.
   * @param {object} ctx        { hour, weather, season, hot, cold, music, gaming, cpuHot }
   * @param {string[]} recent   ids played lately, newest last
   * @param {() => number} rand Math.random or a seeded stand-in
   */
  function pickFidget(ctx = {}, recent = [], rand = Math.random) {
    const memory = new Set(recent.slice(-6));
    let pool = CLIPS.filter((c) => c.kind === 'fidget' && fits(c, ctx) && !memory.has(c.id));
    if (!pool.length) pool = CLIPS.filter((c) => c.kind === 'fidget' && fits(c, ctx) && c.id !== recent[recent.length - 1]);
    if (!pool.length) return null;
    const total = pool.reduce((s, c) => s + c.weight, 0);
    let roll = rand() * total;
    for (const c of pool) {
      roll -= c.weight;
      if (roll < 0) return c.id;
    }
    return pool[pool.length - 1].id;
  }

  /** The season a date falls in, for seasonal fidgets; null most days. */
  function seasonOf(date, birthday) {
    const m = date.getMonth() + 1;
    const d = date.getDate();
    if (birthday && birthday.month === m && birthday.day === d) return 'birthday';
    if ((m === 12 && d === 31) || (m === 1 && d === 1)) return 'newyear';
    if (m === 10 && d >= 24) return 'halloween';
    if (m === 12 && d >= 20 && d <= 26) return 'christmas';
    return null;
  }

  return {
    STAGE,
    MOOD_RGB,
    POKES,
    clips: CLIPS,
    clip,
    rgb,
    renderFrame,
    frameSvg,
    transformAttr,
    duration,
    fits,
    pickFidget,
    seasonOf,
  };
});
