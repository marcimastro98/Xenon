// A Windows .ico holding PNG images (supported since Windows Vista, and by every
// current browser for favicon.ico). Each entry is a ready PNG file.

/** @param {{ size: number, png: Uint8Array }[]} images  sizes 1..256 */
export function encodeIco(images) {
  if (!images.length) throw new Error('An .ico needs at least one image');
  const header = new Uint8Array(6 + 16 * images.length);
  const view = new DataView(header.buffer);
  view.setUint16(2, 1, true); // type 1 = icon
  view.setUint16(4, images.length, true);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    if (!(size >= 1 && size <= 256)) throw new Error(`Icon size out of range: ${size}`);
    const at = 6 + 16 * i;
    header[at] = size === 256 ? 0 : size; // 0 means 256
    header[at + 1] = size === 256 ? 0 : size;
    view.setUint16(at + 4, 1, true); // colour planes
    view.setUint16(at + 6, 32, true); // bits per pixel
    view.setUint32(at + 8, png.length, true);
    view.setUint32(at + 12, offset, true);
    offset += png.length;
  });
  const out = new Uint8Array(offset);
  out.set(header, 0);
  let at = header.length;
  for (const { png } of images) {
    out.set(png, at);
    at += png.length;
  }
  return out;
}
