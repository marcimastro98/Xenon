'use strict';
// Writes animated GIFs, so a moving picture too big for where it goes can be
// made smaller and still move. Browsers can only encode still pictures; this
// is the encoder they lack. Input is what GifRead.decodeGif() returns:
// { width, height, loop, frames: [{ data: RGBA, delay ms }] }.
//
// One palette for the whole animation (no colour flicker between frames, one
// table instead of one per frame). Frames after the first only carry the
// pixels that changed, marked by a transparent index, unless the picture has
// see-through parts of its own: then every frame is whole and replaces the last.

const GIF_MAX_COLORS = 256;
const _SAMPLE_PIXELS = 60000;

// The animation as GIF bytes. colors (2..256) is the palette size.
function encodeGif(anim, opts) {
  const o = opts || {};
  const colors = Math.max(2, Math.min(GIF_MAX_COLORS, o.colors || GIF_MAX_COLORS));
  const { width: W, height: H, frames } = anim;
  const seeThrough = frames.some(f => _hasAlpha(f.data));
  // The last index is kept for "transparent".
  const samples = _sample(frames);
  const palette = _medianCut(samples, colors - 1);
  const tIndex = palette.length / 3;
  const bitsPerIndex = Math.max(1, Math.ceil(Math.log2(tIndex + 1)));
  const tableSize = 1 << bitsPerIndex;
  const out = new _Bytes();
  out.str('GIF89a');
  out.u16(W); out.u16(H);
  out.u8(0x80 | (bitsPerIndex - 1)); out.u8(0); out.u8(0);
  for (let i = 0; i < tableSize; i++) {
    out.u8(palette[i * 3] || 0); out.u8(palette[i * 3 + 1] || 0); out.u8(palette[i * 3 + 2] || 0);
  }
  if (frames.length > 1) {
    out.u8(0x21); out.u8(0xff); out.u8(11); out.str('NETSCAPE2.0');
    out.u8(3); out.u8(1); out.u16(anim.loop == null ? 0 : anim.loop); out.u8(0);
  }
  const map = _nearestMap(palette, new Set(samples).size <= palette.length / 3);
  let prev = null;
  for (const f of frames) {
    const idx = _indexFrame(f.data, map, tIndex);
    let rect = { left: 0, top: 0, w: W, h: H };
    let pixels = idx;
    if (prev && !seeThrough) {
      rect = _changedRect(idx, prev, W, H);
      pixels = _cropUnchanged(idx, prev, W, rect, tIndex);
    }
    // Disposal 1 keeps the frame under the next one; 2 clears it first.
    out.u8(0x21); out.u8(0xf9); out.u8(4);
    out.u8(((seeThrough ? 2 : 1) << 2) | 1);
    out.u16(Math.max(2, Math.round(f.delay / 10))); out.u8(tIndex); out.u8(0);
    out.u8(0x2c); out.u16(rect.left); out.u16(rect.top); out.u16(rect.w); out.u16(rect.h); out.u8(0);
    const minSize = Math.max(2, bitsPerIndex);
    out.u8(minSize);
    _lzwEncode(minSize, pixels, out);
    prev = idx;
  }
  out.u8(0x3b);
  return out.bytes();
}

// The animation made to fit `maxBytes` as a GIF, or null when even the
// smallest try does not. Shrinks first (the longer side never above maxSide,
// never below minSide), then plays every other frame, then uses fewer colours.
// Async so a page stays responsive between tries.
async function shrinkGif(anim, maxBytes, opts) {
  const o = opts || {};
  const maxSide = o.maxSide || 2560;
  const minSide = o.minSide || 48;
  const longest = Math.max(anim.width, anim.height);
  let side = Math.min(longest, maxSide);
  let source = anim;
  let colors = GIF_MAX_COLORS;
  for (let tries = 0; tries < 14; tries++) {
    const sized = _scaled(source, side / longest);
    await _breathe();
    const bytes = encodeGif(sized, { colors });
    if (bytes.length <= maxBytes) return { bytes, width: sized.width, height: sized.height };
    // Area, and so roughly the bytes, follows the square of the side.
    const next = Math.floor(side * Math.sqrt(maxBytes / bytes.length) * 0.94);
    if (next >= minSide && next < side) { side = next; continue; }
    if (source.frames.length > 2) { source = _everyOther(source); continue; }
    if (colors > 32) { colors >>= 1; continue; }
    return null;
  }
  return null;
}

// --- palette ---------------------------------------------------------------

function _hasAlpha(d) {
  for (let i = 3; i < d.length; i += 4) if (d[i] < 128) return true;
  return false;
}

// Opaque pixels spread evenly over every frame, as packed RGB.
function _sample(frames) {
  const total = frames.reduce((n, f) => n + f.data.length / 4, 0);
  const stride = Math.max(1, Math.floor(total / _SAMPLE_PIXELS));
  const out = [];
  let k = 0;
  for (const f of frames) {
    const d = f.data;
    for (let i = 0; i < d.length; i += 4) {
      if (k++ % stride || d[i + 3] < 128) continue;
      out.push((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
  }
  return out.length ? out : [0];
}

// Median cut: the box whose most spread channel spreads widest (weighted by
// how many pixels it holds) is split at its median until there are `count`
// boxes; each gives its average colour.
function _medianCut(samples, count) {
  const boxes = [_box(samples)];
  while (boxes.length < count) {
    let best = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].score > 0 && (best < 0 || boxes[i].score > boxes[best].score)) best = i;
    }
    if (best < 0) break;
    const { items, ch } = boxes[best];
    const shift = 16 - ch * 8;
    items.sort((x, y) => ((x >> shift) & 255) - ((y >> shift) & 255));
    // Split between two different values, so neither half is the whole box.
    let mid = items.length >> 1;
    const at = v => (v >> shift) & 255;
    while (mid < items.length && at(items[mid]) === at(items[mid - 1])) mid++;
    if (mid >= items.length) { mid = items.length >> 1; while (mid > 1 && at(items[mid]) === at(items[mid - 1])) mid--; }
    boxes.splice(best, 1, _box(items.slice(0, mid)), _box(items.slice(mid)));
  }
  const pal = [];
  for (const { items } of boxes) {
    let r = 0, g = 0, bl = 0;
    for (const c of items) { r += c >> 16; g += (c >> 8) & 255; bl += c & 255; }
    pal.push(Math.round(r / items.length), Math.round(g / items.length), Math.round(bl / items.length));
  }
  return pal;
}

// A box of packed colours with its most spread channel (0 r, 1 g, 2 b) and
// its split priority, worked out once.
function _box(items) {
  let r0 = 255, g0 = 255, b0 = 255, r1 = 0, g1 = 0, b1 = 0;
  for (const c of items) {
    const r = c >> 16, g = (c >> 8) & 255, b = c & 255;
    if (r < r0) r0 = r; if (r > r1) r1 = r;
    if (g < g0) g0 = g; if (g > g1) g1 = g;
    if (b < b0) b0 = b; if (b > b1) b1 = b;
  }
  const rr = r1 - r0, gr = g1 - g0, br = b1 - b0;
  const ch = rr >= gr && rr >= br ? 0 : gr >= br ? 1 : 2;
  const spread = [rr, gr, br][ch];
  return { items, ch, score: items.length > 1 ? spread * Math.sqrt(items.length) : 0 };
}

// Nearest palette index for a colour. When the picture has no more colours
// than the palette holds (every GIF read back, most drawings), each colour is
// matched exactly; otherwise colours 4 apart share one answer, cached on a
// 64-level grid, which is invisible next to the palette's own rounding.
function _nearestMap(pal, exact) {
  const n = pal.length / 3;
  const search = (r, g, b) => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const dr = pal[i * 3] - r, dg = pal[i * 3 + 1] - g, db = pal[i * 3 + 2] - b;
      const dist = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
      if (dist < bestD) { bestD = dist; best = i; }
    }
    return best;
  };
  if (exact) {
    const cache = new Map();
    return (r, g, b) => {
      const key = (r << 16) | (g << 8) | b;
      let hit = cache.get(key);
      if (hit === undefined) { hit = search(r, g, b); cache.set(key, hit); }
      return hit;
    };
  }
  const grid = new Int16Array(262144).fill(-1);
  return (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let hit = grid[key];
    if (hit < 0) { hit = search((r & 0xfc) | 2, (g & 0xfc) | 2, (b & 0xfc) | 2); grid[key] = hit; }
    return hit;
  };
}

function _indexFrame(d, map, tIndex) {
  const out = new Uint8Array(d.length / 4);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    out[p] = d[i + 3] < 128 ? tIndex : map(d[i], d[i + 1], d[i + 2]);
  }
  return out;
}

// --- frame differences -----------------------------------------------------

// The smallest rectangle holding every pixel that changed (at least 1x1).
function _changedRect(idx, prev, W, H) {
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      if (idx[row + x] === prev[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { left: 0, top: 0, w: 1, h: 1 };
  return { left: x0, top: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// The rectangle's indices, with unchanged pixels made transparent.
function _cropUnchanged(idx, prev, W, r, tIndex) {
  const out = new Uint8Array(r.w * r.h);
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const s = (r.top + y) * W + r.left + x;
      out[y * r.w + x] = idx[s] === prev[s] ? tIndex : idx[s];
    }
  }
  return out;
}

// --- LZW ---------------------------------------------------------------------

// Classic GIF LZW (the compress(1) scheme): a code is written at the current
// width, the width grows once the next free code no longer fits, the table
// restarts with a clear code when full.
function _lzwEncode(minSize, pixels, out) {
  const clear = 1 << minSize;
  const eoi = clear + 1;
  const table = new Map();
  const blocks = new _Blocks(out);
  let size = minSize + 1;
  let next = eoi + 1;
  let acc = 0;
  let bits = 0;
  const put = code => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) { blocks.u8(acc & 255); acc >>>= 8; bits -= 8; }
  };
  put(clear);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i];
    const key = (prefix << 8) | k;
    const hit = table.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    put(prefix);
    if (next < 4096) {
      table.set(key, next++);
      if (next > (1 << size) && size < 12) size++;
    } else {
      put(clear);
      table.clear();
      size = minSize + 1;
      next = eoi + 1;
    }
    prefix = k;
  }
  put(prefix);
  put(eoi);
  if (bits > 0) blocks.u8(acc & 255);
  blocks.end();
}

// --- helpers -----------------------------------------------------------------

function _scaled(anim, k) {
  if (k >= 1) return anim;
  const read = typeof GifRead !== 'undefined' ? GifRead : require('./gif-read.js');
  const w = Math.max(1, Math.round(anim.width * k));
  const h = Math.max(1, Math.round(anim.height * k));
  return {
    width: w, height: h, loop: anim.loop,
    frames: anim.frames.map(f => ({ data: read.resizeRGBA(f.data, anim.width, anim.height, w, h), delay: f.delay })),
  };
}

function _everyOther(anim) {
  const frames = [];
  for (let i = 0; i < anim.frames.length; i += 2) {
    const next = anim.frames[i + 1];
    frames.push({ data: anim.frames[i].data, delay: anim.frames[i].delay + (next ? next.delay : 0) });
  }
  return { ...anim, frames };
}

function _breathe() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

class _Bytes {
  constructor() { this.buf = new Uint8Array(65536); this.n = 0; }
  u8(v) {
    if (this.n === this.buf.length) {
      const grown = new Uint8Array(this.buf.length * 2);
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf[this.n++] = v;
  }
  u16(v) { this.u8(v & 255); this.u8((v >> 8) & 255); }
  str(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
  bytes() { return this.buf.slice(0, this.n); }
}

// Image data goes out in sub-blocks of at most 255 bytes.
class _Blocks {
  constructor(out) { this.out = out; this.chunk = new Uint8Array(255); this.n = 0; }
  u8(v) {
    this.chunk[this.n++] = v;
    if (this.n === 255) this.flush();
  }
  flush() {
    if (!this.n) return;
    this.out.u8(this.n);
    for (let i = 0; i < this.n; i++) this.out.u8(this.chunk[i]);
    this.n = 0;
  }
  end() { this.flush(); this.out.u8(0); }
}

const GifWrite = { GIF_MAX_COLORS, encodeGif, shrinkGif };
if (typeof window !== 'undefined') window.GifWrite = GifWrite;
if (typeof module !== 'undefined' && module.exports) module.exports = GifWrite;
