'use strict';
// What kind of file a transferred file is: the closed list of types served as themselves, the
// ones always served as a plain download, and the ones that get a thumbnail.

// The MIME a download is served with, keyed on the extension WE stored — never
// on the `?mime=` the client declared. This is not cosmetic: iOS Safari routes
// a download by MIME plus extension, and `video/mp4` is what puts "Save to
// Photos" in the share sheet. Served as `application/octet-stream` the video
// lands in Files as an opaque blob, which is exactly the friction this feature
// exists to remove. On Android the MIME decides the MediaStore collection.
const MEDIA_MIME = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.bmp', 'image/bmp'],
  ['.avif', 'image/avif'], ['.heic', 'image/heic'], ['.heif', 'image/heif'],
  ['.tif', 'image/tiff'], ['.tiff', 'image/tiff'],
  ['.mp4', 'video/mp4'], ['.m4v', 'video/mp4'], ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'], ['.mkv', 'video/x-matroska'], ['.avi', 'video/x-msvideo'],
  ['.mp3', 'audio/mpeg'], ['.m4a', 'audio/mp4'], ['.aac', 'audio/aac'],
  ['.wav', 'audio/wav'], ['.flac', 'audio/flac'], ['.ogg', 'audio/ogg'],
  ['.opus', 'audio/opus'],
  ['.pdf', 'application/pdf'],
]);

// Types whose real MIME must never be sent, however well known it is. These are
// the ones where a stripped header or a sniffing quirk turns a file the user
// received into script running in OUR origin. The download disposition and
// nosniff already say so; this is the layer that does not depend on a header
// surviving. Listed rather than merely omitted, so nobody "completes" the map
// above by adding text/html to it.
const FORCED_OCTET = new Set([
  '.html', '.htm', '.xhtml', '.shtml', '.svg', '.svgz', '.xml',
  '.js', '.mjs', '.css', '.wasm',
]);

// What a browser will actually decode in an <img>. HEIC is deliberately absent:
// an iPhone photo that reached the PC untranscoded cannot be shown, and a
// broken image is a worse answer than an extension chip.
const THUMBABLE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.avif']);

/** The MIME a download is served with. Unknown or risky → octet-stream. */
function downloadMimeFor(ext) {
  const e = String(ext || '').toLowerCase();
  if (FORCED_OCTET.has(e)) return 'application/octet-stream';
  return MEDIA_MIME.get(e) || 'application/octet-stream';
}

function isThumbable(ext) {
  return THUMBABLE.has(String(ext || '').toLowerCase());
}

function kindOf(ext) {
  const m = downloadMimeFor(ext);
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'file';
}

module.exports = { MEDIA_MIME, FORCED_OCTET, THUMBABLE, downloadMimeFor, isThumbable, kindOf };
