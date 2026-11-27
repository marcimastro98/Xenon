'use strict';
// Bit moving the way only something made of bits can: it crumbles into its cells and builds itself
// again elsewhere, pinches into a line of light and beams away, shrinks into one packet of data that
// runs along the screen, glitches out, or downloads in row by row. Each effect is a few numbers per
// cell (LEAVE), played on a canvas made for that effect alone and removed when it ends: nothing runs
// while Bit stands. The cells are read off the sprite as drawn, what it wears and its tint included,
// and keep Bit's own colours. Arriving plays the leaving backwards. With reduced motion Bit simply
// shows in its new place. Used by stroll.js (a stroll that teleports) and moments.js (the day's first
// hello, a very hot PC). send() is the packet alone: news running from Bit to the island. A move
// it wears (bit-wardrobe.js, place 'move') takes over its teleports: its base effect, its time, and its
// own bits flying instead of square cells.
(() => {
  const NAMES = ['crumble', 'beam', 'packet', 'glitch']; // what the person can pick; 'any' is one of them
  const MS = { crumble: 650, beam: 560, packet: 380, glitch: 480, download: 900 };
  const PAD = 90; // room around Bit the cells may fly into
  const PACKET_PX_S = 900;
  const PACKET_PX = 6; // about two of its cells: one alone reads as dust
  const TAIL = 6; // steps of the packet's tail
  const TAIL_GAP_PX = 6;
  const SEND_PX_S = 2400; // news runs faster than Bit does
  const SEND_MS = [250, 600]; // and lands about when the island has opened (js/alerts/toast-island.js)
  const EDGE_PX = 4; // news runs this far under the screen's top edge, above the bar's buttons
  const RECT = /M(-?[\d.]+) (-?[\d.]+)h(-?[\d.]+)v(-?[\d.]+)/g;
  const MOVE = /translate\((-?[\d.]+) (-?[\d.]+)\) scale\((-?[\d.]+) (-?[\d.]+)\)/;
  const busy = new WeakSet();
  const HEX = /^#[0-9a-f]{6}$/i;
  const BIT_K = 0.5; // one cell of a move's bits, in Bit's cells

  const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp01 = (n) => Math.min(1, Math.max(0, n));
  const easeIn = (t) => t * t * t;
  const lerp = (a, b, t) => a + (b - a) * t;
  const pick = (name) => (NAMES.includes(name) || name === 'download' ? name : NAMES[Math.floor(Math.random() * NAMES.length)]);

  /** The cells of the frame on screen, in page pixels. @returns {{x,y,w,h,c,o}[]} */
  function cellsOf(sprite) {
    const svg = sprite?.querySelector?.('svg');
    const vb = svg?.viewBox?.baseVal;
    const box = svg?.getBoundingClientRect();
    if (!vb?.width || !box?.width) return [];
    const k = box.width / vb.width;
    const flip = !!sprite.closest?.('.is-left'); // the CSS mirror of a Bit walking left
    const out = [];
    for (const path of svg.querySelectorAll('path')) {
      const m = MOVE.exec(path.parentNode?.getAttribute?.('transform') || '');
      const [tx, ty, sx, sy] = m ? m.slice(1).map(Number) : [0, 0, 1, 1];
      const c = path.getAttribute('fill');
      const o = Number(path.getAttribute('opacity') || 1);
      for (const r of (path.getAttribute('d') || '').matchAll(RECT)) {
        const [x, y, w, h] = r.slice(1).map(Number);
        for (let j = 0; j < h - 1e-6; j += 1) {
          for (let i = 0; i < w - 1e-6; i += 1) {
            const pw = Math.min(1, w - i) * sx * k;
            const px = (tx + sx * (x + i) - vb.x) * k;
            out.push({ x: box.left + (flip ? box.width - px - pw : px), y: box.top + (ty + sy * (y + j) - vb.y) * k, w: pw, h: Math.min(1, h - j) * sy * k, c, o });
          }
        }
      }
    }
    return out;
  }

  function boundsOf(cells) {
    const left = Math.min(...cells.map((c) => c.x));
    const top = Math.min(...cells.map((c) => c.y));
    const w = Math.max(...cells.map((c) => c.x + c.w)) - left;
    const h = Math.max(...cells.map((c) => c.y + c.h)) - top;
    const counts = new Map();
    for (const c of cells) counts.set(c.c, (counts.get(c.c) || 0) + 1);
    const main = [...counts].sort((a, b) => b[1] - a[1])[0][0]; // its body colour
    return { left, top, w, h, cx: left + w / 2, cy: top + h / 2, main };
  }

  // Where a cell is at t (0 → 1) while Bit leaves: {x, y, k: its size, a: its alpha, ghost: px}.
  const LEAVE = {
    crumble(p, t) {
      const l = clamp01((t - p.order * 0.4) / 0.6);
      return { x: p.x + p.vx * l, y: p.y + p.vy * l + 140 * l * l, k: 1 - 0.5 * l, a: 1 - l };
    },
    beam(p, t, b) {
      const pinch = easeIn(clamp01(t / 0.5));
      const rise = clamp01((t - 0.45) / 0.55);
      return { x: lerp(p.x, b.cx - p.w / 2, pinch), y: p.y - rise * rise * (b.h * 3 + p.r * 40), k: 1 - 0.4 * pinch, a: 1 - rise };
    },
    packet(p, t, b) {
      const e = easeIn(t);
      return { x: lerp(p.x, b.cx - p.w / 2, e), y: lerp(p.y, b.cy - p.h / 2, e), k: lerp(1, 0.4, e), a: 1 };
    },
    glitch(p, t) {
      const hit = (Math.floor(p.order * 6) * 7 + Math.floor(t * 14) * 3) % 5 === 0; // a band slips, now and then
      const gone = t > 0.55 && p.r < ((t - 0.55) / 0.45) * 1.1;
      return { x: p.x + (hit ? (p.r - 0.5) * 24 : 0), y: p.y, k: 1, a: gone ? 0 : hit ? 0.55 : 1, ghost: hit ? 3 : 0 };
    },
    download(p, t) { // leaving is uninstalling: the rows go from the bottom up
      return { x: p.x, y: p.y, k: 1, a: t < (1 - p.order) * 0.85 ? 1 : 0 };
    },
  };

  // What an effect draws besides the cells: the beam's light, the download's bar.
  const AROUND = {
    beam(ctx, t, b) {
      ctx.globalAlpha = Math.sin(Math.PI * t) * 0.8;
      ctx.fillStyle = b.main;
      ctx.fillRect(b.cx - 1.5, b.top - b.h * 3, 3, b.h * 4);
    },
    download(ctx, t, b) {
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = b.main;
      ctx.fillRect(b.left, b.top + b.h + 6, b.w * (1 - t), 3);
    },
  };

  function sheet(area) {
    const canvas = document.createElement('canvas');
    canvas.className = 'bit-warp';
    canvas.setAttribute('aria-hidden', 'true');
    const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    canvas.width = Math.ceil(area.w * dpr);
    canvas.height = Math.ceil(area.h * dpr);
    for (const [k, v] of Object.entries({ x: area.x, y: area.y, w: area.w, h: area.h })) canvas.style.setProperty(`--warp-${k}`, `${Math.round(v)}px`);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d canvas');
    ctx.setTransform(dpr, 0, 0, dpr, -area.x * dpr, -area.y * dpr); // drawn in page pixels
    document.body.append(canvas); // only once it can draw: never one left behind
    return { canvas, ctx };
  }

  function animate(ms, paint) {
    return new Promise((resolve) => {
      const start = performance.now();
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const tick = (now) => {
        if (done) return;
        const t = clamp01((now - start) / ms);
        paint(t);
        if (t < 1) requestAnimationFrame(tick); else finish();
      };
      requestAnimationFrame(tick);
      setTimeout(finish, ms + 300); // a hidden page draws no frame: never wait on one
    });
  }

  // The move it wears, or null.
  function ownMove() {
    const W = window.Xenon?.bitWardrobe;
    const worn = window.BitApp?.state?.()?.worn;
    return (W && Array.isArray(worn) && W.outfit(worn).find((it) => it.slot === 'move' && it.params)) || null;
  }

  // A move's bits at (x, y), k px a cell: its own colours, the cell's where a part takes the Bit's.
  function bits(ctx, own, x, y, k, colour) {
    for (const part of own.layers) {
      ctx.fillStyle = HEX.test(part.fill) ? part.fill : colour;
      for (const [cx, cy, w = 1, h = 1] of part.cells) ctx.fillRect(x + cx * k, y + cy * k, w * k, h * k);
    }
  }

  /** One half of an effect over the sprite, which stays hidden after it. `own`: a move's bits. */
  async function play(sprite, name, arriving, own = null) {
    const cells = cellsOf(sprite);
    sprite.classList.add('bit-warping');
    if (!cells.length) return;
    const b = boundsOf(cells);
    const parts = cells.map((c) => ({ ...c, r: Math.random(), order: ((c.y - b.top) / b.h) * 0.8 + Math.random() * 0.2,
      vx: (c.x + c.w / 2 - b.cx) * 1.2 + (Math.random() - 0.5) * 50, vy: -30 - Math.random() * 50 }));
    const area = { x: b.left - PAD, y: b.top - b.h * 3 - 20, w: b.w + 2 * PAD, h: b.h * 4 + 20 + PAD };
    const { canvas, ctx } = sheet(area);
    canvas.classList.toggle('is-top', !!sprite.closest?.('.bitc-overlay')); // the room's Bit: over the room
    try {
      await animate(own?.params.ms || MS[name], (t) => {
        const at = arriving ? 1 - t : t;
        ctx.clearRect(area.x, area.y, area.w, area.h);
        for (const p of parts) {
          const s = LEAVE[name](p, at, b);
          if (s.a <= 0) continue;
          const w = p.w * s.k + 0.4;
          const h = p.h * s.k + 0.4;
          if (own && Math.hypot(s.x - p.x, s.y - p.y) > p.w) { // on its way: one of the move's bits
            ctx.globalAlpha = s.a * p.o;
            bits(ctx, own, s.x, s.y, p.w * s.k * BIT_K, p.c);
            continue;
          }
          ctx.fillStyle = p.c;
          if (s.ghost) { ctx.globalAlpha = s.a * p.o * 0.35; ctx.fillRect(s.x - s.ghost, s.y, w, h); ctx.fillRect(s.x + s.ghost, s.y, w, h); }
          ctx.globalAlpha = s.a * p.o;
          ctx.fillRect(s.x + (p.w - w) / 2, s.y + (p.h - h) / 2, w, h);
        }
        AROUND[name]?.(ctx, at, b);
      });
    } finally {
      canvas.remove();
    }
    return b;
  }

  const lengthOf = (points) => points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0);

  // The point d px along a path of points.
  function along(points, d) {
    let rest = d;
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (rest <= len) return { x: lerp(a.x, b.x, len ? rest / len : 1), y: lerp(a.y, b.y, len ? rest / len : 1) };
      rest -= len;
    }
    return points[points.length - 1];
  }

  /** The packet running along a path with a short tail, on a canvas the size of the tail that
   *  travels with it (a transform): never one the size of the screen. */
  async function dash(points, colour, ms) {
    const length = lengthOf(points);
    if (length < 4) return;
    const half = TAIL * TAIL_GAP_PX + PACKET_PX;
    const { canvas, ctx } = sheet({ x: 0, y: 0, w: half * 2, h: half * 2 });
    try {
      await animate(ms, (t) => {
        const head = along(points, t * length);
        const ox = Math.round(head.x) - half;
        const oy = Math.round(head.y) - half;
        canvas.style.setProperty('--warp-tx', `${ox}px`);
        canvas.style.setProperty('--warp-ty', `${oy}px`);
        ctx.clearRect(0, 0, half * 2, half * 2);
        ctx.fillStyle = colour;
        for (let i = TAIL; i >= 0; i -= 1) {
          const p = along(points, Math.max(0, t * length - i * TAIL_GAP_PX));
          ctx.globalAlpha = i ? (1 - i / (TAIL + 1)) * 0.5 : 1;
          ctx.fillRect(p.x - ox - PACKET_PX / 2, p.y - oy - PACKET_PX / 2, PACKET_PX, PACKET_PX);
        }
      });
    } finally {
      canvas.remove();
    }
  }

  const centreOf = (sprite) => { const r = sprite.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

  /**
   * Bit leaves where it stands, relocate() moves it, and it arrives there. Without anything to draw
   * (reduced motion, an effect already running on it) it only moves. Resolves when it shows again.
   * @param {Element} sprite @param {string} name an effect, or 'any' @param {() => void} relocate
   * @param {{leave?: boolean, own?: boolean|object}} [opts] leave: false hides it at once and only plays the
   *   arriving; own: true goes the way of the move it wears, if any, or of this move item (a try-on)
   */
  async function move(sprite, name, relocate = () => {}, opts = {}) {
    if (!sprite || busy.has(sprite) || reduced() || typeof requestAnimationFrame !== 'function') { relocate(); return; }
    const own = opts.own === true ? ownMove() : opts.own || null;
    const effect = own ? own.params.base : pick(name);
    let moved = false;
    const go = () => { if (!moved) { moved = true; relocate(); } };
    busy.add(sprite);
    try {
      const from = centreOf(sprite);
      if (opts.leave === false) sprite.classList.add('bit-warping');
      const b = opts.leave === false ? null : await play(sprite, effect, false, own);
      go();
      if (effect === 'packet' && b) {
        const to = centreOf(sprite);
        const path = [from, { x: from.x, y: to.y }, to]; // down or up first, then along
        await dash(path, b.main, (lengthOf(path) / PACKET_PX_S) * 1000);
      }
      await play(sprite, effect, true, own);
    } catch (err) {
      console.warn('[bit] an effect stopped:', err.message);
      go();
    } finally {
      sprite.classList.remove('bit-warping');
      busy.delete(sprite);
    }
  }

  /**
   * News: a packet leaves the top of Bit, runs up and along the screen's top edge and into box (the
   * island a notification just opened). Bit stays where it is; with reduced motion nothing runs.
   * @param {Element} sprite @param {{left: number, top: number, width: number, height: number}} box
   */
  async function send(sprite, box) {
    if (!sprite || !box?.width || reduced() || typeof requestAnimationFrame !== 'function') return;
    const cells = cellsOf(sprite);
    if (!cells.length) return;
    const b = boundsOf(cells);
    const to = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    const edge = Math.min(EDGE_PX + PACKET_PX / 2, to.y);
    const path = [{ x: b.cx, y: b.top }, { x: b.cx, y: edge }, { x: to.x, y: edge }, to];
    const ms = Math.min(SEND_MS[1], Math.max(SEND_MS[0], (lengthOf(path) / SEND_PX_S) * 1000));
    try {
      await dash(path, b.main, ms);
    } catch (err) {
      console.warn('[bit] the news stopped:', err.message);
    }
  }

  window.BitWarp = { NAMES, move, send, cellsOf };
})();
