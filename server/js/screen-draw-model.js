'use strict';

// Drawing on the screen where the capture engine has no sheet of its own
// (macOS, Linux): the strokes, the tools and the keys of the /draw page
// (js/screen-draw-page.js). The same rules as the engine's sheet on Windows
// (apps/capture/src/sketch, win/draw): six colours, pen, highlighter, arrow and
// box; Shift draws a straight line, Ctrl a box, Ctrl+Shift an arrow; Ctrl+Z
// undoes, E or Delete clears, R Y G B W K pick a colour, Esc closes. Pure, so
// the rules are tested alone; the page only paints what this returns.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ScreenDrawModel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const PALETTE = Object.freeze([
    Object.freeze({ id: 'red', key: 'R', rgb: [232, 64, 64], label: 'cann_red' }),
    Object.freeze({ id: 'yellow', key: 'Y', rgb: [245, 197, 24], label: 'cann_yellow' }),
    Object.freeze({ id: 'green', key: 'G', rgb: [46, 184, 114], label: 'draw_green' }),
    Object.freeze({ id: 'blue', key: 'B', rgb: [47, 128, 237], label: 'draw_blue' }),
    Object.freeze({ id: 'white', key: 'W', rgb: [255, 255, 255], label: 'cann_white' }),
    Object.freeze({ id: 'black', key: 'K', rgb: [17, 17, 17], label: 'draw_black' }),
  ]);
  const TOOLS = Object.freeze(['pen', 'marker', 'arrow', 'box']);
  // Half the thickness at 100% scale, and how much shows through: the engine's.
  const RADIUS = Object.freeze({ pen: 2.5, marker: 11, arrow: 3, box: 2.5 });
  const ALPHA = Object.freeze({ pen: 1, marker: 0.4, arrow: 1, box: 1 });
  // A long stroke is thinned, never cut: past this a point replaces the last.
  const MAX_POINTS = 4000;
  const MAX_STROKES = 500;

  function create() {
    let colour = 0;
    let tool = 'pen';
    let strokes = [];
    let live = null;

    // The tool a press starts: Ctrl a box, Ctrl+Shift an arrow, Shift keeps the
    // tool but draws straight (the pen and the highlighter only).
    function begin(point, mods) {
      const m = mods || {};
      const t = m.ctrl ? (m.shift ? 'arrow' : 'box') : tool;
      live = {
        tool: t,
        rgb: PALETTE[colour].rgb.slice(),
        straight: !m.ctrl && !!m.shift && (t === 'pen' || t === 'marker'),
        points: [point],
      };
      return live;
    }

    function extend(point) {
      if (!live) return null;
      const shaped = live.tool === 'arrow' || live.tool === 'box' || live.straight;
      if (shaped) live.points = [live.points[0], point];
      else if (live.points.length < MAX_POINTS) live.points.push(point);
      else live.points[live.points.length - 1] = point;
      return live;
    }

    // A box or arrow that never left its start draws nothing; a dot does.
    function end() {
      const s = live;
      live = null;
      if (!s) return false;
      const shaped = s.tool === 'arrow' || s.tool === 'box';
      if (shaped && (s.points.length < 2 || same(s.points[0], s.points[1]))) return false;
      strokes.push(s);
      if (strokes.length > MAX_STROKES) strokes = strokes.slice(-MAX_STROKES);
      return true;
    }

    function undo() {
      if (live) { live = null; return true; }
      return strokes.pop() !== undefined;
    }

    function clear() {
      const had = strokes.length > 0 || !!live;
      strokes = [];
      live = null;
      return had;
    }

    function pick(item) {
      if (Number.isInteger(item.colour) && item.colour >= 0 && item.colour < PALETTE.length) colour = item.colour;
      if (TOOLS.includes(item.tool)) tool = item.tool;
    }

    return {
      begin, extend, end, undo, clear, pick,
      get colour() { return colour; },
      get tool() { return tool; },
      get strokes() { return strokes; },
      get live() { return live; },
    };
  }

  function same(a, b) {
    return Math.abs(a[0] - b[0]) < 1 && Math.abs(a[1] - b[1]) < 1;
  }

  // What a key does: { act: 'undo' | 'clear' | 'close' } or { colour: i }, or
  // null for a key the sheet leaves alone.
  function keyAction(key, mods) {
    const m = mods || {};
    const k = String(key || '');
    if (k === 'Escape') return { act: 'close' };
    if (m.ctrl && (k === 'z' || k === 'Z')) return { act: 'undo' };
    if (m.ctrl || m.alt || m.meta) return null;
    if (k === 'e' || k === 'E' || k === 'Delete') return { act: 'clear' };
    const i = PALETTE.findIndex((p) => p.key === k.toUpperCase());
    return k.length === 1 && i >= 0 ? { colour: i } : null;
  }

  // The two lines of an arrow's head at `b`, as the engine draws them.
  function arrowHead(a, b, r) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1) return [];
    const size = Math.min(Math.max(r * 6, 14), len * 0.6);
    const ux = dx / len;
    const uy = dy / len;
    return [0.5, -0.5].map((angle) => {
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      return [b[0] - size * (ux * c - uy * s), b[1] - size * (uy * c + ux * s)];
    });
  }

  // The polylines a stroke is painted as, each a list of points.
  function paths(stroke, scale) {
    const p = stroke.points;
    const a = p[0];
    const b = p[p.length - 1];
    if (stroke.tool === 'box') return [[a, [b[0], a[1]], b, [a[0], b[1]], a]];
    if (stroke.tool === 'arrow') {
      return [[a, b]].concat(arrowHead(a, b, RADIUS.arrow * (scale || 1)).map((h) => [b, h]));
    }
    if (stroke.straight) return [[a, b]];
    return [p];
  }

  function width(stroke, scale) {
    return RADIUS[stroke.tool] * 2 * (scale || 1);
  }

  return Object.freeze({ PALETTE, TOOLS, ALPHA, create, keyAction, arrowHead, paths, width });
});
