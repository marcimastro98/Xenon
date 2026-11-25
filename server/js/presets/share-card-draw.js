'use strict';
// How the "Share my setup" card is drawn (presets/share-card.js owns the dialog): the dashboard on
// a plate, the person's own Bit with it, the Xenon mark, the name, the theme's colours and the QR, on
// one flat ground (the Bit's ink, else the brand's). Personal tiles are blurred here, on the canvas,
// so the PNG that leaves the app never holds them sharp.
(() => {
  // BRAND.md: the card stays recognisably Xenon whatever the theme, so the ground and type are the
  // brand's own unless the person's Bit stands on the card (its ink, BitDna.colors).
  const BRAND = Object.freeze({ ink: '#070808', text: '#f0f3f1', muted: '#9aa8a1', line: '#2a302d' });
  const FAMILY = '"Sofia Sans", sans-serif';
  const FALLBACK = '"Segoe UI", system-ui, sans-serif';

  // Capture on top as the hero, the words in a band under it. The plate is a BOX the capture is
  // contain-fitted into, so a 32:9 bar and a 16:10 laptop both land without letterbox bars. The
  // person's Bit stands beside the screen in a post and sits on its top edge in a story; its name
  // goes under the card's title.
  const LAYOUTS = Object.freeze({
    post: {
      plate: { x: 48, y: 48, w: 1504, h: 556 },
      logo: { x: 64, y: 646, s: 48 },
      brand: { x: 124, midY: 670, size: 30 },
      name: { x: 64, baseline: 752, lineH: 54, size: 46, maxW: 1180, lines: 1 },
      sub: { gap: 44, size: 26 },
      swatch: { x: 80, r: 16, gap: 44 },
      footer: { x: 64, baseline: 880, size: 22, maxW: 1180 },
      qr: { x: 1364, y: 646, s: 188 },
      qrCap: { x: 1458, baseline: 874, size: 20, maxW: 240, align: 'center' },
      bit: { w: 360, gap: -24, at: 'side' },
    },
    story: {
      plate: { x: 56, y: 360, w: 968, h: 860 },
      logo: { x: 72, y: 116, s: 76 },
      brand: { x: 168, midY: 154, size: 44 },
      name: { x: 72, baseline: 1340, lineH: 80, size: 66, maxW: 936, lines: 2 },
      sub: { gap: 60, size: 34 },
      swatch: { x: 96, r: 24, gap: 64 },
      footer: { x: 344, baseline: 1748, size: 26, maxW: 660 },
      qr: { x: 72, y: 1592, s: 236 },
      qrCap: { x: 344, baseline: 1690, size: 28, maxW: 660, align: 'left' },
      bit: { w: 300, max: 460, fill: 760, at: 'top' },
      // Between the wordmark and the QR; the words take about this much under the screen.
      stack: { top: 230, bottom: 1552, words: 280, gap: 130 },
    },
  });
  // Where the Bit's stand is in its picture (bit.js STAGE: 17 rows, the stand on the last ones).
  const FEET = 0.96;

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)));
  }

  function drawQr(ctx, qr, x, y, size) {
    const count = qr.getModuleCount();
    const cell = size / count;
    ctx.fillStyle = '#101214';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(x + c * cell, y + r * cell, Math.ceil(cell), Math.ceil(cell));
      }
    }
  }

  // Contain-fit `aspect` inside `box`, centred.
  function fitPlate(box, aspect) {
    const a = (Number.isFinite(aspect) && aspect > 0) ? aspect : 16 / 9;
    let w = box.h * a;
    let h = box.h;
    if (w > box.w) { w = box.w; h = box.w / a; }
    return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
  }

  // The no-capture plate: the user's own background with the bento grid drawn over it, in the
  // same rect as a real capture, so the fallback is one branch and not a second card.
  function drawSilhouette(ctx, r, colors) {
    ctx.fillStyle = colors.background;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    const rows = [[6, 10, 8], [10, 6, 4, 4], [8, 8, 8]];
    const pad = Math.max(8, Math.round(r.h * 0.06));
    const gap = pad * 0.62;
    const rowH = (r.h - pad * (rows.length + 1)) / rows.length;
    let y = r.y + pad;
    for (const row of rows) {
      const units = row.reduce((a, b) => a + b, 0);
      const avail = r.w - pad * 2 - gap * (row.length - 1);
      let x = r.x + pad;
      for (const span of row) {
        const w = avail * (span / units);
        roundRect(ctx, x, y, w, rowH, Math.min(16, rowH * 0.16));
        ctx.fillStyle = colors.surface + '80';
        ctx.fill();
        ctx.strokeStyle = colors.accent + '2e';
        ctx.lineWidth = 2;
        ctx.stroke();
        x += w + gap;
      }
      y += rowH + pad;
    }
  }

  function surface(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    const g = c.getContext('2d');
    if (g) { g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; }
    return { c, g };
  }

  // A soft, strong blur that draws the same on every canvas (no ctx.filter): halve the region down
  // to a few cells across, then double it back up. The cell is in CARD pixels, a fifth of the tile's
  // short side, so words become colour whatever the size of the captured screen.
  function softened(img, src, dw, dh) {
    const cell = Math.max(24, Math.min(dw, dh) / 5);
    const tw = Math.max(2, Math.round(dw / cell));
    const th = Math.max(2, Math.round(dh / cell));
    let cur = surface(dw, dh);
    if (!cur.g) return null;
    cur.g.drawImage(img, src.x, src.y, src.w, src.h, 0, 0, cur.c.width, cur.c.height);
    const sizes = [];
    for (let w = cur.c.width, h = cur.c.height; w > tw || h > th;) {
      w = Math.max(tw, Math.round(w / 2));
      h = Math.max(th, Math.round(h / 2));
      sizes.push([w, h]);
    }
    const up = sizes.slice(0, -1).reverse().concat([[dw, dh]]);
    for (const [w, h] of sizes.concat(up)) {
      const next = surface(w, h);
      if (!next.g) return null;
      next.g.drawImage(cur.c, 0, 0, next.c.width, next.c.height);
      cur = next;
    }
    return cur.c;
  }

  // Blur the personal tiles, each inside its own rounded corners. `rects` are fractions of the
  // captured screen; `r` is the tile's corner as a fraction of the screen's height.
  function drawBlurBoxes(ctx, img, plate, rects) {
    for (const b of rects) {
      const dx = plate.x + b.x * plate.w;
      const dy = plate.y + b.y * plate.h;
      const dw = b.w * plate.w;
      const dh = b.h * plate.h;
      if (dw < 2 || dh < 2) continue;
      const soft = softened(img, { x: b.x * img.width, y: b.y * img.height, w: b.w * img.width, h: b.h * img.height }, dw, dh);
      if (!soft) continue;
      ctx.save();
      roundRect(ctx, dx, dy, dw, dh, (b.r || 0) * plate.h);
      ctx.clip();
      ctx.drawImage(soft, dx, dy, dw, dh);
      ctx.restore();
    }
  }

  function text(ctx, value, at, font) {
    ctx.font = font;
    ctx.textAlign = at.align || 'left';
    ctx.fillText(value, at.x, at.baseline, at.maxW);
    ctx.textAlign = 'left';
  }

  // The screen's rect, the Bit's when there is one, and how far the words move with them. In a
  // post the Bit stands beside the screen and the pair is centred together.
  function placeOf(L, o, lines) {
    const p = o.bit?.picture;
    if (L.stack) return stackOf(L, o, p, lines);
    if (!p) return { plate: fitPlate(L.plate, o.captureAspect), bit: null, dy: 0 };
    const w = L.bit.w;
    const h = p.height * (w / p.width);
    const fit = fitPlate({ ...L.plate, w: L.plate.w - w - L.bit.gap }, o.captureAspect);
    const plate = { ...fit, x: L.plate.x + (L.plate.w - fit.w - L.bit.gap - w) / 2 };
    return { plate, bit: { x: plate.x + fit.w + L.bit.gap, y: plate.y + plate.h - h * FEET, w, h }, dy: 0 };
  }

  // A story: the Bit sits on the screen's top edge, bigger when the screen is short, and Bit, screen
  // and words are centred together between the wordmark and the QR, so a 32:9 bar leaves no hole.
  function stackOf(L, o, p, lines) {
    const room = L.stack;
    const words = room.words + (lines - 1) * L.name.lineH;
    const w = p ? Math.max(L.bit.w, Math.min(L.bit.max, L.bit.fill - fitPlate(L.plate, o.captureAspect).h * 0.75)) : 0;
    const h = p ? p.height * (w / p.width) : 0;
    const above = h * FEET;
    const fit = fitPlate({ ...L.plate, h: Math.min(L.plate.h, room.bottom - room.top - above - words) }, o.captureAspect);
    const top = room.top + Math.max(0, (room.bottom - room.top - above - fit.h - words) / 2);
    const plate = { ...fit, y: top + above };
    const bit = p ? { x: plate.x + plate.w - w - 8, y: top, w, h } : null;
    return { plate, bit, dy: plate.y + plate.h + room.gap - L.name.baseline };
  }

  function drawPlate(ctx, plate, o, tone) {
    const radius = Math.min(20, plate.h * 0.05);
    ctx.save();
    roundRect(ctx, plate.x, plate.y, plate.w, plate.h, radius);
    ctx.clip();
    if (o.capture) {
      ctx.drawImage(o.capture, plate.x, plate.y, plate.w, plate.h);
      if (o.blurRects?.length) drawBlurBoxes(ctx, o.capture, plate, o.blurRects);
    } else {
      drawSilhouette(ctx, plate, o.colors);
    }
    ctx.restore();
    roundRect(ctx, plate.x + 1, plate.y + 1, plate.w - 2, plate.h - 2, radius);
    ctx.strokeStyle = tone.line;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // The mark, the wordmark (only in the brand's face, never a system font) and what kind it is.
  function drawBrand(ctx, L, o, tone, font) {
    if (o.logo) ctx.drawImage(o.logo, L.logo.x, L.logo.y, L.logo.s, L.logo.s);
    ctx.textBaseline = 'middle';
    let x = L.brand.x;
    if (o.fontOk) {
      ctx.font = font(800, L.brand.size);
      ctx.fillStyle = tone.text;
      ctx.fillText('Xenon', x, L.brand.midY);
      x += ctx.measureText('Xenon').width + L.brand.size * 0.6;
    }
    if (o.kindLabel) {
      ctx.font = font(600, Math.round(L.brand.size * 0.8));
      ctx.fillStyle = tone.muted;
      ctx.fillText(o.kindLabel, x, L.brand.midY + 1);
    }
    ctx.textBaseline = 'alphabetic';
  }

  function drawSwatches(ctx, L, colors, tone, after) {
    const cy = after + L.swatch.r * 2.5;
    [colors.accent, colors.background, colors.surface, colors.text, colors.onAccent].forEach((c, i) => {
      ctx.beginPath();
      ctx.arc(L.swatch.x + i * L.swatch.gap, cy, L.swatch.r, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
      ctx.strokeStyle = tone.line;
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }

  function drawQrBlock(ctx, L, o, tone, font) {
    if (!o.qr) return;
    const pad = Math.round(L.qr.s * 0.1);
    roundRect(ctx, L.qr.x, L.qr.y, L.qr.s, L.qr.s, 18);
    ctx.fillStyle = '#f4f6f5';
    ctx.fill();
    drawQr(ctx, o.qr, L.qr.x + pad, L.qr.y + pad, L.qr.s - pad * 2);
    if (!o.qrCaption) return;
    ctx.fillStyle = tone.muted;
    text(ctx, o.qrCaption, L.qrCap, font(500, L.qrCap.size));
  }

  // The title, then the line that says whose Bit stands there. Returns where the words end.
  function drawName(ctx, L, o, tone, font, lines, dy) {
    ctx.font = font(800, L.name.size);
    ctx.fillStyle = tone.text;
    lines.forEach((line, i) => { ctx.fillText(line, L.name.x, L.name.baseline + dy + i * L.name.lineH); });
    const end = L.name.baseline + dy + (lines.length - 1) * L.name.lineH;
    if (!o.bit?.picture || !o.bit.line) return end;
    ctx.fillStyle = tone.muted;
    text(ctx, o.bit.line, { x: L.name.x, baseline: end + L.sub.gap, maxW: nameWidth(L) }, font(600, L.sub.size));
    return end + L.sub.gap;
  }

  const nameWidth = (L) => Math.max(L.name.maxW, L.qr.x - L.name.x - 48);

  /**
   * Draws the card.
   * @param {HTMLCanvasElement} canvas
   * @param {{ format: string, size: { w: number, h: number }, name: string, kindLabel?: string, byline?: string,
   *   colors: object, qr: object|null, qrCaption?: string, capture: CanvasImageSource|null, captureAspect: number,
   *   blurRects?: object[], logo: CanvasImageSource|null, fontOk: boolean, note?: string,
   *   wrap: (measure: (s: string) => number, name: string, maxW: number, lines: number) => string[],
   *   bit?: { picture: HTMLImageElement, line: string, tone: object }|null }} o
   */
  function render(canvas, o) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const L = LAYOUTS[o.format] || LAYOUTS.post;
    const tone = o.bit?.tone || BRAND;
    const font = (weight, px) => `${weight} ${px}px ${o.fontOk ? FAMILY : FALLBACK}`;
    canvas.width = o.size.w;
    canvas.height = o.size.h;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = tone.ink;
    ctx.fillRect(0, 0, o.size.w, o.size.h);
    ctx.font = font(800, L.name.size);
    const lines = o.wrap((s) => ctx.measureText(s).width, o.name, nameWidth(L), L.name.lines);
    const at = placeOf(L, o, lines.length);
    drawPlate(ctx, at.plate, o, tone);
    if (at.bit) ctx.drawImage(o.bit.picture, at.bit.x, at.bit.y, at.bit.w, at.bit.h);
    drawBrand(ctx, L, o, tone, font);
    drawSwatches(ctx, L, o.colors, tone, drawName(ctx, L, o, tone, font, lines, at.dy));
    drawQrBlock(ctx, L, o, tone, font);
    // The site, or the note that the code travels beside the card when the QR could not hold it.
    ctx.fillStyle = tone.muted;
    text(ctx, o.note || 'xenon-app.com' + (o.byline || ''), L.footer, font(o.note ? 500 : 600, L.footer.size));
  }

  window.ShareCardDraw = { render, drawQr };
})();
