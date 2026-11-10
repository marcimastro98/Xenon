'use strict';

// What a creation costs on every frame: a background's draw() and the
// requestAnimationFrame callbacks of a canvas widget. The other critiques see
// that a loop exists; this one reads what the loop does each time, where one
// wrong call costs the whole screen 30 times a second.
//
// The same shapes as the Store audit's canvas-cost pass in the supporter hub
// (its drift test compares the two): the ones that cost the whole screen are a
// 'fix', the ones that depend on how much is drawn a 'consider'. Static and
// approximate on purpose; the Store review measures the real cost.

const { finding } = require('./ai-preset-critique-core.js');

const SCRIPT_EXT = /\.(js|mjs|cjs|html?)$/i;
const VENDOR_PATH = /(^|\/)(vendor|vendors|third[-_]?party|node_modules)\/|\.min\.js$/i;
// A literal loop bound from this many iterations per frame is worth a look.
const BIG_LOOP = 3000;

const IDENT = '[A-Za-z_$][\\w$]*';
const WIDTH = /<=?\s*(?:[\w$]+\.)*(?:w|W|width|cw|innerWidth)\b(?!\s*[*/])/;
const HEIGHT = /<=?\s*(?:[\w$]+\.)*(?:h|H|height|ch|innerHeight)\b(?!\s*[*/])/;
const AREA = /<=?\s*(?:(?:[\w$]+\.)*(?:w|W|width|cw)\s*\*\s*(?:[\w$]+\.)*(?:h|H|height|ch)\b|(?:[\w$]+\.)*data\.length\b)/;
const UNIT_STEP = /(?:\+\+|\+=\s*1\b|=\s*[\w$]+\s*\+\s*1\b)/;

// Index just past the brace that closes the one at `open`, skipping strings,
// template literals and comments; -1 when it never closes.
function closingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); if (end < 0) return -1; i = end + 1; continue; }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

// [start, end) of the body of the function named `name`, declared or assigned.
function namedBodies(text, name) {
  const out = [];
  const decl = new RegExp('(?:function\\s+' + name + '\\s*\\(|\\b' + name + '\\s*[:=]\\s*(?:async\\s*)?(?:function\\b[^(]*\\(|\\([^)]*\\)\\s*=>|' + IDENT + '\\s*=>))', 'g');
  let m;
  while ((m = decl.exec(text))) {
    const open = text.indexOf('{', m.index + m[0].length);
    if (open < 0) continue;
    const end = closingBrace(text, open);
    if (end > 0) out.push([open, end]);
  }
  return out;
}

// Every callback handed to requestAnimationFrame, by name or written inline.
function rafBodies(text) {
  const out = [];
  const call = /requestAnimationFrame\s*\(\s*/g;
  let m;
  while ((m = call.exec(text))) {
    const rest = text.slice(m.index + m[0].length);
    const named = new RegExp('^(' + IDENT + ')\\s*\\)').exec(rest);
    if (named) { out.push(...namedBodies(text, named[1])); continue; }
    if (/^(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(rest)) {
      const open = text.indexOf('{', m.index + m[0].length);
      const end = open < 0 ? -1 : closingBrace(text, open);
      if (end > 0) out.push([open, end]);
    }
  }
  return out.filter(([a, b], i) => out.findIndex(([c, d]) => c === a && d === b) === i);
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

// → Map id → {id, line, count?}, the first hit of each shape in these bodies.
function scanBody(text, [start, end], hits) {
  const body = text.slice(start, end);
  const once = (id, i, extra) => { if (!hits.has(id)) hits.set(id, Object.assign({ id, line: lineAt(text, start + i) }, extra)); };
  const readback = /\.getImageData\s*\(/.exec(body);
  if (readback) once('pixel-readback', readback.index);
  const write = /\.(?:putImageData|createImageData)\s*\(/.exec(body);
  if (write) once('pixel-write-per-frame', write.index);
  const filter = /\.filter\s*=\s*(?:(['"`])(?!none\1)([^'"`]*)|(?![\s'"`]))/.exec(body);
  // A blur runs a kernel over every drawn pixel; a colour filter is one pass.
  // A value it cannot read (a variable) counts as a blur.
  if (filter) once(filter[2] !== undefined && !/blur|drop-shadow/i.test(filter[2]) ? 'canvas-filter-per-frame' : 'canvas-blur-per-frame', filter.index);
  const blur = /\.shadowBlur\s*=(?!\s*0\s*[;,\n)])/.exec(body);
  if (blur) once('shadow-blur-per-frame', blur.index);
  const alloc = /\bnew\s+(?:Image|OffscreenCanvas|(?:Float32|Float64|Uint8|Uint8Clamped|Uint16|Uint32|Int8|Int16|Int32)Array)\s*\(|\bdocument\.createElement\s*\(\s*['"`]canvas['"`]/.exec(body);
  if (alloc) once('alloc-per-frame', alloc.index);

  const loops = /\bfor\s*\(([^;)]*);([^;)]*);([^)]*)\)/g;
  let m, alongX = -1, alongY = -1;
  while ((m = loops.exec(body))) {
    const [, , cond, step] = m;
    const unit = UNIT_STEP.test(step);
    if (unit && AREA.test(cond)) once('per-pixel-loop', m.index);
    if (unit && WIDTH.test(cond)) alongX = m.index;
    if (unit && HEIGHT.test(cond)) alongY = m.index;
    const bound = /<=?\s*(\d{4,})\b/.exec(cond);
    if (bound && Number(bound[1]) >= BIG_LOOP) once('big-loop-per-frame', m.index, { count: Number(bound[1]) });
  }
  if (alongX >= 0 && alongY >= 0) once('per-pixel-loop', Math.min(alongX, alongY));
}

// id → [problem, hint]. HEAVY are a 'fix' (the Store marks them perf-heavy).
const SHAPES = {
  'pixel-readback': ['reads pixels back with getImageData on every frame: a full GPU stall each frame', 'keep the state in your own arrays instead of reading it back from the canvas'],
  'pixel-write-per-frame': ['writes pixels with putImageData/createImageData on every frame: a full-screen CPU copy each frame', 'draw with shapes, or render the pixel pass once into a small offscreen canvas and drawImage it scaled up'],
  'per-pixel-loop': ['loops over every pixel on every frame (1.8 million iterations at 2560x720)', 'work on a coarse grid (8 to 16 px) or a small offscreen canvas scaled up; do per-pixel work once, outside the frame'],
  'canvas-blur-per-frame': ['sets a blur filter on every frame: a kernel over every drawn pixel', 'blur once into an offscreen canvas outside the frame and drawImage it, or fake softness with transparency'],
  'canvas-filter-per-frame': ['sets a colour filter on every frame: one more pass over everything drawn', 'bake the colour grade into the image once, outside the frame'],
  'shadow-blur-per-frame': ['uses shadowBlur on every frame: each shape is blurred again', 'draw the glow once into an offscreen sprite and stamp it with drawImage'],
  'alloc-per-frame': ['creates a new image, canvas or typed array on every frame: memory grows until GC stutters', 'create them once, outside the frame, and reuse them'],
  'big-loop-per-frame': ['runs a loop of thousands of iterations on every frame', 'draw a few hundred items at most, or precompute what does not change'],
};
const HEAVY = ['pixel-readback', 'pixel-write-per-frame', 'per-pixel-loop', 'canvas-blur-per-frame'];

function toFindings(hits, where) {
  return [...hits.values()].map((h) => {
    const [problem, hint] = SHAPES[h.id];
    return finding(HEAVY.includes(h.id) ? 'fix' : 'consider', where + ':' + h.line,
      'performance: ' + (h.count ? problem.replace('thousands of', String(h.count)) : problem), hint);
  });
}

// The shapes found in one file: 'bg' reads draw(), 'raf' the rAF callbacks.
// Exported for the hub's drift test, which runs the same code through both.
function frameHits(text, mode) {
  const hits = new Map();
  for (const span of mode === 'bg' ? namedBodies(text, 'draw') : rafBodies(text)) scanBody(text, span, hits);
  return hits;
}

// A background's code (draw() is its per-frame body).
function critiqueBgFrame(code, where) {
  return toFindings(frameHits(String(code || ''), 'bg'), where);
}

// A widget or Ambient package: rAF callbacks, only when it draws on a 2d canvas.
// files: [{path, text}] already decoded.
function critiquePackageFrames(files) {
  const code = files.filter((f) => SCRIPT_EXT.test(f.path) && !VENDOR_PATH.test(f.path));
  if (!code.some((f) => /getContext\s*\(\s*['"]2d['"]/.test(f.text))) return [];
  return code.flatMap((f) => toFindings(frameHits(f.text, 'raf'), f.path));
}

module.exports = { critiqueBgFrame, critiquePackageFrames, frameHits, PERF_IDS: Object.freeze(Object.keys(SHAPES)), HEAVY_IDS: Object.freeze(HEAVY.slice()) };
