// Assembles still WebP files into one animated WebP (RIFF: VP8X, ANIM, one
// ANMF per frame) with exact per-frame durations and an endless loop.

const u24 = (n) => Buffer.from([n & 255, (n >> 8) & 255, (n >> 16) & 255]);

function chunk(id, payload) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload, payload.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** The image chunks of a still WebP (VP8L, or ALPH + VP8), headers dropped. */
export function imageChunks(webp) {
  if (webp.subarray(0, 4).toString('ascii') !== 'RIFF' || webp.subarray(8, 12).toString('ascii') !== 'WEBP') {
    throw new Error('Not a WebP file');
  }
  const out = [];
  for (let p = 12; p + 8 <= webp.length; ) {
    const id = webp.subarray(p, p + 4).toString('ascii');
    const len = webp.readUInt32LE(p + 4);
    const end = p + 8 + len + (len & 1);
    if (id === 'VP8L' || id === 'VP8 ' || id === 'ALPH') out.push(webp.subarray(p, end));
    p = end;
  }
  if (!out.length) throw new Error('WebP has no image data');
  return Buffer.concat(out);
}

/**
 * @param {Buffer[]} stills   one still WebP per frame, all width x height
 * @param {number[]} durations milliseconds per frame
 */
export function muxAnimatedWebp(stills, durations, width, height) {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x10 | 0x02; // alpha + animation
  u24(width - 1).copy(vp8x, 4);
  u24(height - 1).copy(vp8x, 7);
  const anim = Buffer.from([0, 0, 0, 0, 0, 0]); // transparent background, loop forever
  const frames = stills.map((still, i) => {
    const head = Buffer.concat([u24(0), u24(0), u24(width - 1), u24(height - 1), u24(Math.min(0xffffff, Math.round(durations[i]))), Buffer.from([0x02])]); // 0x02: replace, no blend
    return chunk('ANMF', Buffer.concat([head, imageChunks(still)]));
  });
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), chunk('VP8X', vp8x), chunk('ANIM', anim), ...frames]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}
