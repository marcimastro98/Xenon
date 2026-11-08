// The width and height a page states for its WebP pictures, read from the pictures: a
// re-shot picture changes shape, and a stale pair makes the page jump while it loads.
// Run: node tools/site-shots/image-sizes.mjs [--check]   (docs/*.html, the English sources;
// the other languages follow with tools/build-i18n.mjs and tools/build-page-langs.mjs)

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS_DIR = fileURLToPath(new URL('../../docs/', import.meta.url));
const IMG_TAG = /<img\b[^>]*>/g;
const WEBP_SRC = /\bsrc="(\/images\/[^"?#]+\.webp)"/;

const CHUNK_READERS = {
  'VP8 ': (b) => [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff],
  VP8L: (b) => {
    const bits = b.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  },
  VP8X: (b) => [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1],
};

export function webpSize(buffer) {
  const isWebp = buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP';
  const read = isWebp ? CHUNK_READERS[buffer.toString('latin1', 12, 16).trimEnd().padEnd(4)] : null;
  if (!read) throw new Error('not a WebP picture');
  return read(buffer);
}

// Every WebP <img> that states a size gets its picture's. One with no size stays as it is.
export function syncImageSizes(html, sizeOf) {
  return html.replace(IMG_TAG, (tag) => {
    const src = WEBP_SRC.exec(tag);
    if (!src || !/\swidth="\d+"/.test(tag) || !/\sheight="\d+"/.test(tag)) return tag;
    const [width, height] = sizeOf(src[1]);
    return tag.replace(/(\swidth=")\d+"/, `$1${width}"`).replace(/(\sheight=")\d+"/, `$1${height}"`);
  });
}

export function pictureSizeReader(docsDir = DOCS_DIR) {
  const known = new Map();
  return (src) => {
    if (!known.has(src)) known.set(src, webpSize(readFileSync(path.join(docsDir, src))));
    return known.get(src);
  };
}

export function stalePages(docsDir = DOCS_DIR) {
  const sizeOf = pictureSizeReader(docsDir);
  const stale = [];
  for (const name of readdirSync(docsDir).filter((file) => file.endsWith('.html'))) {
    const file = path.join(docsDir, name);
    const before = readFileSync(file, 'utf8');
    const after = syncImageSizes(before, sizeOf);
    if (after !== before) stale.push({ name, file, after });
  }
  return stale;
}

function main() {
  const check = process.argv.includes('--check');
  const stale = stalePages();
  for (const { name, file, after } of stale) {
    console.log(`${check ? 'stale' : 'fixed'}: ${name}`);
    if (!check) writeFileSync(file, after);
  }
  if (check && stale.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
