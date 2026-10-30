'use strict';
// Reads moving pictures without the browser's help. A canvas only ever draws
// the first frame of an animated GIF (Chromium, Firefox and WebKit alike), so
// anything that paints a GIF on a canvas, or makes one smaller, needs its
// frames: decodeGif() returns them already composited, one full picture per
// frame. animatedKind() tells a moving picture from a still one by its bytes,
// for GIF, WebP and PNG (APNG).
//
// Only line comments in this file: the Maker embeds it in the code of an
// animated background, whose build drops comment lines one at a time.

// 'gif' | 'webp' | 'png' when the bytes are a picture with more than one
// frame, '' otherwise (a still picture, or not a picture at all).
function animatedKind(bytes) {
  const b = bytes;
  if (!b || b.length < 16) return '';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return _gifFrameCount(b, 2) > 1 ? 'gif' : '';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    // VP8X carries an "animation" flag; an animated WebP always starts with it.
    const isVp8x = b[12] === 0x56 && b[13] === 0x50 && b[14] === 0x38 && b[15] === 0x58;
    return isVp8x && b.length > 20 && (b[20] & 0x02) ? 'webp' : '';
  }
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    // An APNG has an acTL chunk before its first IDAT.
    let p = 8;
    while (p + 8 <= b.length) {
      const len = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      if (type === 'acTL') {
        const frames = p + 12 <= b.length ? ((b[p + 8] << 24) | (b[p + 9] << 16) | (b[p + 10] << 8) | b[p + 11]) >>> 0 : 0;
        return frames > 1 ? 'png' : '';
      }
      if (type === 'IDAT') return '';
      p += 12 + len;
    }
  }
  return '';
}

// How many frames a GIF has, counting no further than `stop`.
function _gifFrameCount(b, stop) {
  let n = 0;
  _gifWalk(b, () => { n++; return n < stop; });
  return n;
}

// Walks a GIF's blocks. onImage(at, gce) gets the offset of each image
// descriptor and the graphic control values before it; returning false stops.
// Returns the screen and loop values, or null when the bytes are not a GIF.
function _gifWalk(b, onImage) {
  if (b.length < 13 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) return null;
  const info = { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8), palette: null, background: b[11], loop: 1 };
  let p = 13;
  if (b[10] & 0x80) {
    const size = 3 * (1 << ((b[10] & 7) + 1));
    info.palette = b.subarray(p, p + size);
    p += size;
  }
  let gce = null;
  while (p < b.length) {
    const block = b[p++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = b[p++];
      if (label === 0xf9 && b[p] >= 4) {
        const packed = b[p + 1];
        gce = { disposal: (packed >> 2) & 7, transparent: packed & 1 ? b[p + 4] : -1, delay: (b[p + 2] | (b[p + 3] << 8)) * 10 };
      } else if (label === 0xff && b[p] === 11 && String.fromCharCode(...b.subarray(p + 1, p + 9)) === 'NETSCAPE'
        && b[p + 12] >= 3 && b[p + 13] === 1) {
        info.loop = b[p + 14] | (b[p + 15] << 8);
      }
      p = _skipBlocks(b, p);
      continue;
    }
    if (block !== 0x2c) break;
    if (p + 9 > b.length) break;
    if (onImage(p, gce) === false) return info;
    gce = null;
    const packed = b[p + 8];
    p += 9;
    if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1));
    p = _skipBlocks(b, p + 1);
  }
  return info;
}

// The offset just past a run of data sub-blocks.
function _skipBlocks(b, p) {
  while (p < b.length) {
    const n = b[p++];
    if (!n) break;
    p += n;
  }
  return p;
}

// The frames of a GIF, composited the way a browser shows them:
// { width, height, loop, frames: [{ data: RGBA Uint8ClampedArray, delay ms }] }.
// maxSide scales every stored frame down so its longer side fits; maxPixels
// bounds what is kept (all frames together): past it, every other frame is
// dropped and its time given to the one before, so the motion keeps its pace.
// Returns null when the bytes are not a readable GIF.
function decodeGif(bytes, opts) {
  if (!bytes || bytes.length < 13) return null;
  const screen = _gifWalk(bytes, () => false);
  if (!screen) return null;
  return _decodeGifRun(bytes, opts || {}, screen);
}

function _decodeGifRun(b, o, screen) {
  const W = screen.width;
  const H = screen.height;
  if (!W || !H || W * H > 16777216) return null;
  const k = Math.min(1, (o.maxSide || 1e9) / Math.max(W, H));
  const sw = Math.max(1, Math.round(W * k));
  const sh = Math.max(1, Math.round(H * k));
  const canvas = new Uint8ClampedArray(W * H * 4);
  const frames = [];
  let saved = null;
  let last = null;
  let step = 1;
  let seen = 0;
  _gifWalk(b, (at, gce) => {
    if (last) {
      if (last.disposal === 2) _clearRect(canvas, W, last);
      else if (last.disposal === 3 && saved) canvas.set(saved);
    }
    const g = gce || { disposal: 0, transparent: -1, delay: 0 };
    const left = b[at] | (b[at + 1] << 8);
    const top = b[at + 2] | (b[at + 3] << 8);
    const w = b[at + 4] | (b[at + 5] << 8);
    const h = b[at + 6] | (b[at + 7] << 8);
    const packed = b[at + 8];
    let p = at + 9;
    let palette = screen.palette;
    if (packed & 0x80) {
      const size = 3 * (1 << ((packed & 7) + 1));
      palette = b.subarray(p, p + size);
      p += size;
    }
    saved = g.disposal === 3 ? canvas.slice() : null;
    if (palette && w && h && p < b.length) {
      const indices = _lzwDecode(b[p], _joinBlocks(b, p + 1), w * h);
      _paint(canvas, W, H, indices, palette, { left, top, w, h, transparent: g.transparent, interlaced: !!(packed & 0x40) });
    }
    last = { disposal: g.disposal, left, top, w, h };
    // Browsers play a delay of 10 ms or less as 100 ms.
    const delay = g.delay <= 10 ? 100 : g.delay;
    if (seen++ % step !== 0 && frames.length) {
      frames[frames.length - 1].delay += delay;
      return true;
    }
    const data = sw === W && sh === H ? canvas.slice() : resizeRGBA(canvas, W, H, sw, sh);
    frames.push({ data, delay });
    if (o.maxPixels && frames.length > 1 && frames.length * sw * sh > o.maxPixels) {
      for (let i = 0; i + 1 < frames.length; i++) {
        frames[i].delay += frames[i + 1].delay;
        frames.splice(i + 1, 1);
      }
      step *= 2;
    }
    return true;
  });
  if (!frames.length) return null;
  return { width: sw, height: sh, loop: screen.loop, frames };
}

// Clears a frame's rectangle to transparent (disposal 2).
function _clearRect(canvas, W, r) {
  const H = canvas.length / 4 / W;
  for (let y = r.top; y < Math.min(H, r.top + r.h); y++) {
    canvas.fill(0, (y * W + r.left) * 4, (y * W + Math.min(W, r.left + r.w)) * 4);
  }
}

// One frame's palette indices painted onto the canvas, skipping the
// transparent index and anything outside the screen.
function _paint(canvas, W, H, indices, palette, f) {
  const colors = palette.length / 3;
  const rows = f.interlaced ? _interlacedRows(f.h) : null;
  for (let i = 0; i < f.h; i++) {
    const y = f.top + (rows ? rows[i] : i);
    if (y >= H) continue;
    const src = i * f.w;
    for (let x = 0; x < f.w; x++) {
      const cx = f.left + x;
      if (cx >= W) break;
      const ci = indices[src + x];
      if (ci === f.transparent || ci >= colors) continue;
      const d = (y * W + cx) * 4;
      canvas[d] = palette[ci * 3];
      canvas[d + 1] = palette[ci * 3 + 1];
      canvas[d + 2] = palette[ci * 3 + 2];
      canvas[d + 3] = 255;
    }
  }
}

// Where each stored row of an interlaced frame belongs.
function _interlacedRows(h) {
  const rows = new Array(h);
  let i = 0;
  for (const [start, gap] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < h; y += gap) rows[i++] = y;
  }
  return rows;
}

// The data sub-blocks after `p`, joined.
function _joinBlocks(b, p) {
  let total = 0;
  for (let q = p; q < b.length && b[q];) {
    total += b[q];
    q += b[q] + 1;
  }
  const out = new Uint8Array(total);
  let o = 0;
  while (p < b.length && b[p]) {
    const n = b[p];
    out.set(b.subarray(p + 1, p + 1 + n), o);
    o += n;
    p += n + 1;
  }
  return out.subarray(0, o);
}

// GIF's variable-width LZW, decoded into `count` palette indices. A stream
// that ends early leaves the rest at index 0, as browsers do.
function _lzwDecode(minSize, data, count) {
  const out = new Uint8Array(count);
  if (minSize < 2 || minSize > 11) return out;
  const clear = 1 << minSize;
  const eoi = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let c = 0; c < clear; c++) suffix[c] = c;
  let size = minSize + 1;
  let mask = (1 << size) - 1;
  let next = eoi + 1;
  let old = -1;
  let first = 0;
  let datum = 0;
  let bits = 0;
  let pos = 0;
  let op = 0;
  while (op < count) {
    while (bits < size && pos < data.length) {
      datum |= data[pos++] << bits;
      bits += 8;
    }
    if (bits < size) break;
    let code = datum & mask;
    datum >>>= size;
    bits -= size;
    if (code === clear) {
      size = minSize + 1;
      mask = (1 << size) - 1;
      next = eoi + 1;
      old = -1;
      continue;
    }
    if (code === eoi) break;
    if (old === -1) {
      if (code >= clear) break;
      out[op++] = suffix[code];
      old = code;
      first = code;
      continue;
    }
    const inCode = code;
    let sp = 0;
    if (code >= next) {
      if (code > next) break;
      stack[sp++] = first;
      code = old;
    }
    while (code > eoi && sp < 4096) {
      stack[sp++] = suffix[code];
      code = prefix[code];
    }
    first = suffix[code];
    stack[sp++] = first;
    if (next < 4096) {
      prefix[next] = old;
      suffix[next] = first;
      next++;
      if ((next & mask) === 0 && next < 4096) {
        size++;
        mask = (1 << size) - 1;
      }
    }
    old = inCode;
    while (sp > 0 && op < count) out[op++] = stack[--sp];
  }
  return out;
}

// RGBA pixels scaled down to dw x dh by averaging every source pixel each
// target pixel covers (alpha-weighted, so transparent edges do not darken).
// Scaling up repeats the nearest pixel.
function resizeRGBA(src, sw, sh, dw, dh) {
  const out = new Uint8ClampedArray(dw * dh * 4);
  if (dw >= sw && dh >= sh) {
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
      for (let x = 0; x < dw; x++) {
        const s = (sy * sw + Math.min(sw - 1, Math.floor((x * sw) / dw))) * 4;
        out.set(src.subarray(s, s + 4), (y * dw + x) * 4);
      }
    }
    return out;
  }
  const kx = sw / dw;
  const ky = sh / dh;
  const acc = new Float64Array(4);
  for (let y = 0; y < dh; y++) {
    const y0 = y * ky;
    const y1 = Math.min(sh, y0 + ky);
    for (let x = 0; x < dw; x++) {
      const x0 = x * kx;
      const x1 = Math.min(sw, x0 + kx);
      acc[0] = acc[1] = acc[2] = acc[3] = 0;
      let area = 0;
      for (let sy = Math.floor(y0); sy < y1; sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < x1; sx++) {
          const wgt = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          const s = (sy * sw + sx) * 4;
          const a = src[s + 3] * wgt;
          acc[0] += src[s] * a;
          acc[1] += src[s + 1] * a;
          acc[2] += src[s + 2] * a;
          acc[3] += a;
          area += wgt;
        }
      }
      const d = (y * dw + x) * 4;
      if (acc[3] > 0) {
        out[d] = acc[0] / acc[3];
        out[d + 1] = acc[1] / acc[3];
        out[d + 2] = acc[2] / acc[3];
      }
      out[d + 3] = area ? acc[3] / area : 0;
    }
  }
  return out;
}

const GifRead = { animatedKind, decodeGif, resizeRGBA };
if (typeof window !== 'undefined') window.GifRead = GifRead;
if (typeof module !== 'undefined' && module.exports) module.exports = GifRead;
