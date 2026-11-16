'use strict';
// A moving picture someone picks, made to fit where it goes and still move.
// Editors used to draw every picture on a canvas to make it smaller, which
// keeps only the first frame: a GIF turned into a still without a word.
// fitAnimatedPicture() is the step before that: a still picture returns null
// (the caller shrinks it as before); a GIF, an animated WebP or an APNG stays
// as it is when it fits, and otherwise comes back as a smaller GIF.
// Needs GifRead (gif-read.js) and GifWrite (gif-write.js) loaded first.

// Frames kept while shrinking, all together (40M pixels is 160 MB of RGBA).
const ANIM_MAX_PIXELS = 40000000;

// file: a File or Blob. opts.maxChars: the room for the data: URL, in
// characters. opts.maxSide: the longest side the picture ever needs.
// opts.gifOnly: an animated WebP or APNG always comes back as a GIF, for a
// canvas that can only play GIFs (the animated background's image layer).
// Resolves to null (not moving), { dataUrl, width, height, shrunk } or
// { refused: 'room' | 'frames' | 'broken' }: 'frames' when this browser cannot
// read the frames of an animated WebP or APNG too big to keep as it is.
async function fitAnimatedPicture(file, opts) {
  const o = opts || {};
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { return { refused: 'broken' }; }
  const kind = GifRead.animatedKind(bytes);
  if (!kind) return null;
  const mime = kind === 'gif' ? 'image/gif' : kind === 'webp' ? 'image/webp' : 'image/png';
  const maxSide = o.maxSide || 2560;
  const keep = kind === 'gif' || !o.gifOnly;
  if (keep && _dataUrlChars(bytes.length, mime) <= o.maxChars) {
    const size = await _naturalSize(file);
    if (!size) return { refused: 'broken' };
    return { dataUrl: await _dataUrl(new Blob([bytes], { type: mime })), width: size.w, height: size.h, shrunk: false };
  }
  const anim = kind === 'gif'
    ? GifRead.decodeGif(bytes, { maxSide, maxPixels: ANIM_MAX_PIXELS })
    : await _framesFromDecoder(bytes, mime, maxSide);
  if (!anim) return { refused: kind === 'gif' ? 'broken' : 'frames' };
  const maxBytes = Math.floor((o.maxChars - 'data:image/gif;base64,'.length) * 3 / 4);
  const out = maxBytes > 0 ? await GifWrite.shrinkGif(anim, maxBytes, { maxSide }) : null;
  if (!out) return { refused: 'room' };
  return { dataUrl: await _dataUrl(new Blob([out.bytes], { type: 'image/gif' })), width: out.width, height: out.height, shrunk: true };
}

function _dataUrlChars(bytes, mime) {
  return `data:${mime};base64,`.length + Math.ceil(bytes / 3) * 4;
}

function _dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function _naturalSize(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const size = { w: bmp.width, h: bmp.height };
    bmp.close();
    return size;
  } catch {
    return null;
  }
}

// The frames of an animated WebP or APNG through the browser's ImageDecoder
// (Chromium and Firefox; WebKit has none), or null.
async function _framesFromDecoder(bytes, mime, maxSide) {
  if (typeof ImageDecoder === 'undefined') return null;
  let dec = null;
  try {
    if (!(await ImageDecoder.isTypeSupported(mime))) return null;
    dec = new ImageDecoder({ data: bytes, type: mime });
    await dec.tracks.ready;
    const track = dec.tracks.selectedTrack;
    const count = Math.max(1, track ? track.frameCount : 1);
    const first = (await dec.decode({ frameIndex: 0 })).image;
    const W = first.displayWidth;
    const H = first.displayHeight;
    first.close();
    const k = Math.min(1, maxSide / Math.max(W, H));
    const sw = Math.max(1, Math.round(W * k));
    const sh = Math.max(1, Math.round(H * k));
    const step = Math.max(1, Math.ceil((count * sw * sh) / ANIM_MAX_PIXELS));
    // OffscreenCanvas also works in a worker, where there is no document.
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(sw, sh)
      : Object.assign(document.createElement('canvas'), { width: sw, height: sh });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const frames = [];
    for (let i = 0; i < count; i += step) {
      const { image } = await dec.decode({ frameIndex: i });
      ctx.clearRect(0, 0, sw, sh);
      ctx.drawImage(image, 0, 0, sw, sh);
      // VideoFrame.duration is in microseconds; skipped frames give theirs to this one.
      const ms = image.duration ? image.duration / 1000 : 100;
      frames.push({ data: ctx.getImageData(0, 0, sw, sh).data, delay: Math.round(ms * Math.min(step, count - i)) });
      image.close();
    }
    const reps = track ? track.repetitionCount : Infinity;
    return { width: sw, height: sh, loop: reps === Infinity ? 0 : Math.max(0, Math.round(reps)), frames };
  } catch {
    return null;
  } finally {
    if (dec) dec.close();
  }
}

const AnimPicture = { ANIM_MAX_PIXELS, fitAnimatedPicture };
if (typeof window !== 'undefined') window.AnimPicture = AnimPicture;
if (typeof module !== 'undefined' && module.exports) module.exports = AnimPicture;
