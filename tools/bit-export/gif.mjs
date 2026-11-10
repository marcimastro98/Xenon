// Animated GIF encoder for Bit's few flat colors: one global palette, LZW
// written out by hand (the classic GIF89a scheme), endless loop. Pixels under
// half opacity become transparent when there is no background.

const MAX_CODE = 4096;

// Shared palette for every frame; drops low color bits only when needed.
function buildPalette(frames, transparent) {
  const room = transparent ? 255 : 256;
  for (let drop = 0; drop < 8; drop++) {
    const mask = (0xff << drop) & 0xff;
    const seen = new Map();
    for (const { data } of frames) {
      for (let i = 0; i < data.length; i += 4) {
        if (transparent && data[i + 3] < 128) continue;
        const key = ((data[i] & mask) << 16) | ((data[i + 1] & mask) << 8) | (data[i + 2] & mask);
        if (!seen.has(key)) seen.set(key, seen.size + (transparent ? 1 : 0));
      }
    }
    if (seen.size <= room) return { mask, index: seen, colors: [...seen.keys()] };
  }
  throw new Error('GIF palette: too many colors');
}

function indexFrame({ data }, palette, transparent) {
  const out = new Uint8Array(data.length / 4);
  const m = palette.mask;
  for (let p = 0, i = 0; i < data.length; i += 4, p++) {
    if (transparent && data[i + 3] < 128) continue; // index 0 = transparent
    out[p] = palette.index.get(((data[i] & m) << 16) | ((data[i + 1] & m) << 8) | (data[i + 2] & m));
  }
  return out;
}

export function lzw(indices, minCodeSize) {
  const bytes = [];
  let acc = 0;
  let bits = 0;
  let size = minCodeSize + 1;
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let next = eoi + 1;
  let table = new Map();
  const emit = (code) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      bytes.push(acc & 255);
      acc >>>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const code = table.get(key);
    if (code !== undefined) {
      prefix = code;
      continue;
    }
    emit(prefix);
    if (next === MAX_CODE) {
      emit(clear);
      table = new Map();
      next = eoi + 1;
      size = minCodeSize + 1;
    } else {
      if (next >= 1 << size) size++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) bytes.push(acc & 255);
  return Uint8Array.from(bytes);
}

function subBlocks(data) {
  const parts = [];
  for (let i = 0; i < data.length; i += 255) {
    const piece = data.subarray(i, i + 255);
    parts.push(Buffer.from([piece.length]), Buffer.from(piece));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

const u16 = (n) => Buffer.from([n & 255, (n >> 8) & 255]);

/**
 * @param {Array<{ width: number, height: number, data: Uint8Array, ms: number }>} frames RGBA
 * @param {{ transparent?: boolean }} [opts]
 */
export function encodeGif(frames, opts = {}) {
  const { width, height } = frames[0];
  const transparent = !!opts.transparent;
  const palette = buildPalette(frames, transparent);
  const entries = palette.colors.length + (transparent ? 1 : 0);
  const tableBits = Math.max(1, Math.ceil(Math.log2(Math.max(2, entries))));
  const minCodeSize = Math.max(2, tableBits);
  const table = Buffer.alloc(3 << tableBits);
  palette.colors.forEach((c, k) => {
    const at = (k + (transparent ? 1 : 0)) * 3;
    table[at] = c >> 16;
    table[at + 1] = (c >> 8) & 255;
    table[at + 2] = c & 255;
  });

  const parts = [
    Buffer.from('GIF89a', 'ascii'),
    u16(width),
    u16(height),
    Buffer.from([0x80 | 0x70 | (tableBits - 1), 0, 0]),
    table,
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from('NETSCAPE2.0', 'ascii'),
    Buffer.from([3, 1, 0, 0, 0]),
  ];
  for (const frame of frames) {
    const delay = Math.max(2, Math.round(frame.ms / 10));
    const disposal = transparent ? 2 : 1;
    parts.push(Buffer.from([0x21, 0xf9, 4, (disposal << 2) | (transparent ? 1 : 0)]), u16(delay), Buffer.from([0, 0]));
    parts.push(Buffer.from([0x2c]), u16(0), u16(0), u16(width), u16(height), Buffer.from([0]));
    parts.push(Buffer.from([minCodeSize]), subBlocks(lzw(indexFrame(frame, palette, transparent), minCodeSize)));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
