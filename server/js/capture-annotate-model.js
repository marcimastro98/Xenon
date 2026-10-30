'use strict';
// The screenshot editor's pure parts (js/capture-annotate.js draws them): the
// shapes a user adds, in the PICTURE's own pixels, and how each is painted on a
// 2D canvas. The same `paint` draws the preview and the saved PNG, so what the
// user sees is what gets written.
//   arrow      a line with a head, from where the drag started to where it ended
//   box        an outlined rectangle
//   text       a label with a dark plate behind it, so it reads on any picture
//   highlight  a see-through marker rectangle
//   cover      a solid black rectangle: nothing under it survives in the copy
(function (root) {
  const TOOLS = Object.freeze(['arrow', 'box', 'text', 'highlight', 'cover']);
  // Red for pointing, yellow for marking, white for a dark picture.
  const COLORS = Object.freeze(['#e84040', '#f5c518', '#ffffff']);
  const COVER_INK = '#000000';
  const MAX_SHAPES = 400;
  const MAX_TEXT = 200;
  // Below this (in screen pixels) a drag is a tap.
  const TAP_PX = 6;

  // Line width and text size grow with the picture, so an arrow on a 4K shot
  // looks like one on a 1080p shot once both are shown at the same size.
  function strokeFor(width, height) {
    return Math.max(3, Math.round(Math.max(width, height) / 400));
  }
  function fontFor(width, height) {
    return Math.max(16, Math.round(Math.max(width, height) / 55));
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // A rectangle from two corners in any order, kept inside the picture.
  function rectOf(a, b, width, height) {
    const x1 = clamp(Math.min(a.x, b.x), 0, width);
    const y1 = clamp(Math.min(a.y, b.y), 0, height);
    const x2 = clamp(Math.max(a.x, b.x), 0, width);
    const y2 = clamp(Math.max(a.y, b.y), 0, height);
    return { x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) };
  }

  // The shape a drag from `a` to `b` makes with `tool`; null when it is too
  // small to mean anything (`minSize` in picture pixels).
  function shapeFrom(tool, a, b, color, size, minSize) {
    const { width, height } = size;
    const min = Math.max(1, minSize || 1);
    if (tool === 'arrow') {
      const p = { x: clamp(a.x, 0, width), y: clamp(a.y, 0, height) };
      const q = { x: clamp(b.x, 0, width), y: clamp(b.y, 0, height) };
      if (Math.hypot(q.x - p.x, q.y - p.y) < min) return null;
      return { tool, color, x1: Math.round(p.x), y1: Math.round(p.y), x2: Math.round(q.x), y2: Math.round(q.y) };
    }
    if (tool === 'box' || tool === 'highlight' || tool === 'cover') {
      const r = rectOf(a, b, width, height);
      if (r.w < min || r.h < min) return null;
      return tool === 'cover' ? { tool, ...r } : { tool, color, ...r };
    }
    return null;
  }

  function textShape(at, text, color, size) {
    const value = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!value) return null;
    return { tool: 'text', color, text: value, x: Math.round(clamp(at.x, 0, size.width)), y: Math.round(clamp(at.y, 0, size.height)) };
  }

  // The engine's private spots (capture-covers.js) as covers, skipping one
  // that is already covered exactly.
  function coversFrom(spots, shapes) {
    const have = new Set(shapes.filter(s => s.tool === 'cover').map(s => [s.x, s.y, s.w, s.h].join(',')));
    const out = [];
    for (const s of Array.isArray(spots) ? spots : []) {
      const key = [s.x, s.y, s.w, s.h].join(',');
      if (have.has(key)) continue;
      have.add(key);
      out.push({ tool: 'cover', x: s.x, y: s.y, w: s.w, h: s.h });
    }
    return out;
  }

  // The rectangle a shape covers, for hit tests (`textWidth` measures a label).
  function boundsOf(s, size, textWidth) {
    if (s.tool === 'arrow') {
      return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
    }
    if (s.tool === 'text') {
      const f = fontFor(size.width, size.height);
      const w = typeof textWidth === 'function' ? textWidth(s.text, f) : s.text.length * f * 0.6;
      return { x: s.x, y: s.y, w: w + f * 0.6, h: f * 1.4 };
    }
    return { x: s.x, y: s.y, w: s.w, h: s.h };
  }

  // The index of the topmost shape under `p` (within `slop` picture pixels), or -1.
  function hitTest(shapes, p, size, slop, textWidth) {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const b = boundsOf(shapes[i], size, textWidth);
      if (p.x >= b.x - slop && p.x <= b.x + b.w + slop && p.y >= b.y - slop && p.y <= b.y + b.h + slop) return i;
    }
    return -1;
  }

  // ── Painting ──────────────────────────────────────────────────────────────
  function paintArrow(ctx, s, line) {
    const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
    const head = line * 4.5;
    // The line stops where the head starts, so the tip stays sharp.
    const ex = s.x2 - Math.cos(angle) * head * 0.8;
    const ey = s.y2 - Math.sin(angle) * head * 0.8;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = line;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(s.x1, s.y1);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x2, s.y2);
    ctx.lineTo(s.x2 - head * Math.cos(angle - Math.PI / 7), s.y2 - head * Math.sin(angle - Math.PI / 7));
    ctx.lineTo(s.x2 - head * Math.cos(angle + Math.PI / 7), s.y2 - head * Math.sin(angle + Math.PI / 7));
    ctx.closePath();
    ctx.fill();
  }

  function paintText(ctx, s, font) {
    ctx.font = '600 ' + font + 'px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const w = ctx.measureText(s.text).width;
    const pad = font * 0.3;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.fillRect(s.x, s.y, w + pad * 2, font * 1.4);
    ctx.fillStyle = s.color;
    ctx.fillText(s.text, s.x + pad, s.y + font * 0.2);
  }

  function paintShape(ctx, s, size) {
    const line = strokeFor(size.width, size.height);
    ctx.save();
    if (s.tool === 'arrow') paintArrow(ctx, s, line);
    else if (s.tool === 'box') {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = line;
      ctx.strokeRect(s.x + line / 2, s.y + line / 2, Math.max(0, s.w - line), Math.max(0, s.h - line));
    } else if (s.tool === 'highlight') {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = s.color;
      ctx.fillRect(s.x, s.y, s.w, s.h);
    } else if (s.tool === 'cover') {
      ctx.fillStyle = COVER_INK;
      ctx.fillRect(s.x, s.y, s.w, s.h);
    } else if (s.tool === 'text') paintText(ctx, s, fontFor(size.width, size.height));
    ctx.restore();
  }

  // Every shape over whatever the canvas already holds (the picture), in the
  // picture's pixels: the caller scales the context for a smaller preview.
  function paint(ctx, shapes, size) {
    for (const s of shapes) paintShape(ctx, s, size);
  }

  // ── History ───────────────────────────────────────────────────────────────
  // Each step is the whole list (they are small), so undo takes back one
  // gesture, and "find private data" (many covers at once) is one step too.
  function createHistory() {
    let shapes = [];
    const steps = [];
    return {
      get shapes() { return shapes; },
      get canUndo() { return steps.length > 0; },
      push(next) {
        if (next.length > MAX_SHAPES) return false;
        steps.push(shapes);
        shapes = next;
        return true;
      },
      add(list) { return list.length ? this.push(shapes.concat(list)) : false; },
      removeAt(i) { return i >= 0 && i < shapes.length ? this.push(shapes.filter((_, k) => k !== i)) : false; },
      undo() { if (steps.length) shapes = steps.pop(); },
    };
  }

  const api = {
    TOOLS, COLORS, MAX_SHAPES, MAX_TEXT, TAP_PX,
    strokeFor, fontFor, rectOf, shapeFrom, textShape, coversFrom, boundsOf, hitTest, paint, createHistory,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaptureAnnotateModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
