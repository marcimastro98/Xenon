'use strict';
// What makes the person's own Bit its own on the card and in the video (bit-companion/card.js,
// clip.js): a ground in its own colour, its DNA as a strip of genes with their true odds, and
// the pose it strikes. The pose is its favourite fidget from the DNA, unless the person picked
// another in the sheet (prefs.pose, POST /api/bit/prefs). Pure drawing on a canvas the caller
// owns; the words come from the caller's `say`.
(() => {
  // The frame of each pose that reads best as a still, picked on a sheet of every frame.
  const POSE_FRAME = Object.freeze({
    hop: 1, spin: 1, wave: 2, antennaSpark: 1, dance: 1, sneeze: 1, wink: 0, peek: 5, whistle: 0, juggle: 3, cool: 1, reading: 2, pose: 3,
  });
  const POSES = Object.freeze(Object.keys(POSE_FRAME));
  const FALLBACK = Object.freeze({ ink: '#0e1116', text: '#f2f4f7', muted: '#9aa3b2', line: '#2a303a' });

  const X = () => window.Xenon;
  const own = (bit) => (POSES.includes(bit?.genes?.quirk) ? bit.genes.quirk : 'pose');

  /** The pose the card and the video end on. */
  const poseOf = (bit) => (POSES.includes(bit?.prefs?.pose) ? bit.prefs.pose : own(bit));

  /** The pose after this one, '' when the turn comes back to its own. */
  function nextPose(bit) {
    const next = POSES[(POSES.indexOf(poseOf(bit)) + 1) % POSES.length];
    return next === own(bit) ? '' : next;
  }

  /** A pose's clip and the frame it is photographed on. */
  function pose(id) {
    const B = X()?.bit;
    const c = B?.clip(id) || B?.clip('idle');
    if (!c) return null;
    return { clip: c, frame: Math.min(POSE_FRAME[id] ?? 0, c.frames.length - 1) };
  }

  // The ground and its type in the Bit's own hue: deep enough for light text on every palette.
  function colors(bit) {
    const C = X()?.bitColor;
    const pal = bit?.genes && X()?.bitGenome?.palette(bit.genes.palette);
    if (!C || !pal) return FALLBACK;
    const [, chroma, h] = C.toOklch(pal.body);
    const c = Math.min(chroma, 0.12);
    return Object.freeze({
      ink: C.oklch(0.22, c * 0.45, h),
      text: C.oklch(0.97, c * 0.12, h),
      muted: C.oklch(0.8, c * 0.35, h),
      line: C.oklch(0.34, c * 0.5, h),
    });
  }

  // The genes the strip shows, with their true odds: the pattern counts with its colour.
  function genes(bit) {
    const by = new Map((Array.isArray(bit?.rarity) ? bit.rarity : []).map((t) => [t.gene, t]));
    const odds = (...keys) => {
      const chance = keys.map((k) => by.get(k)?.chance).filter((v) => v > 0).reduce((a, b) => a * b, 1);
      return chance < 1 ? Math.round(1 / chance) : 0;
    };
    const out = [];
    if (bit?.genes?.shiny) out.push({ key: 'shiny', oneIn: odds('shiny') });
    out.push({ key: bit?.genes?.classic ? 'classic' : 'palette', oneIn: odds('palette') });
    out.push({ key: 'pattern', oneIn: odds('pattern', 'patternColor') });
    for (const key of ['tip', 'eyes', 'cheeks']) out.push({ key, oneIn: odds(key) });
    return out.filter((g) => g.oneIn > 1);
  }

  // Part of the Bit standing still, from cell (x, y), `cells` wide, into a square of `size` px.
  function crop(ctx, look, x, y, cells, at, size) {
    const B = X().bit;
    const c = B.clip('idle');
    const k = size / cells;
    ctx.save();
    ctx.beginPath();
    ctx.rect(at.x, at.y, size, size);
    ctx.clip();
    for (const layer of B.renderFrame(c, 0, { look }).layers) {
      for (const r of layer.rects) {
        ctx.globalAlpha = typeof r.o === 'number' ? r.o : 1;
        ctx.fillStyle = r.fill;
        ctx.fillRect(at.x + (r.x - x) * k, at.y + (r.y - y) * k, r.w * k, r.h * k);
      }
    }
    ctx.restore();
  }

  function swatch(ctx, key, look, at, size) {
    const fill = (color, x = 0, y = 0, w = size, h = size) => { ctx.fillStyle = color; ctx.fillRect(at.x + x, at.y + y, w, h); };
    const u = size / 8;
    if (key === 'pattern') return crop(ctx, look, 1, 1.5, 10, at, size); // the whole body: a marking may sit anywhere on it
    if (key === 'tip') return crop(ctx, look, 3.5, -3.5, 5, at, size);
    fill(look.body);
    if (key === 'eyes') { fill(look.eyes, 2 * u, 3 * u, u, 2 * u); fill(look.eyes, 5 * u, 3 * u, u, 2 * u); }
    if (key === 'cheeks') { fill(look.cheeks.fill, u, 4 * u, 2 * u, u); fill(look.cheeks.fill, 5 * u, 4 * u, 2 * u, u); }
    if (key === 'shiny') { fill('#ffffff', u, u, u, u); fill('#ffffff', 2 * u, 2 * u, u, u); fill('#ffffff', 5 * u, 5 * u, u, u); }
    return undefined;
  }

  /**
   * The strip of genes across `w` px from (x, y): a swatch from this Bit, the gene's name and
   * "1 in N". Returns its height.
   */
  function strip(ctx, bit, opts) {
    const { x, y, w, say, num, font, tone, sizes } = opts;
    const list = genes(bit);
    const B = X();
    if (!list.length || !B?.bitLook || !bit.genes) return 0;
    const look = B.bitLook.lookOf(bit.genes, { background: tone.ink });
    const step = w / list.length;
    const side = Math.min(sizes.swatch, step - 24);
    ctx.textAlign = 'center';
    list.forEach((g, i) => {
      const cx = x + step * i + step / 2;
      ctx.fillStyle = tone.line;
      ctx.fillRect(cx - side / 2 - 4, y - 4, side + 8, side + 8);
      swatch(ctx, g.key, look, { x: cx - side / 2, y }, side);
      ctx.globalAlpha = 1;
      ctx.fillStyle = tone.muted;
      ctx.font = `500 ${sizes.label}px ${font}`;
      ctx.fillText(say(`mybit_dna_${g.key}`), cx, y + side + sizes.label + 14);
      ctx.fillStyle = tone.text;
      ctx.font = `700 ${sizes.odds}px ${font}`;
      ctx.fillText(say('mybit_one_in', { n: num(g.oneIn) }), cx, y + side + sizes.label + sizes.odds + 24);
    });
    ctx.textAlign = 'start';
    return side + sizes.label + sizes.odds + 30;
  }

  window.BitDna = { POSES, poseOf, nextPose, pose, colors, genes, strip };
})();
