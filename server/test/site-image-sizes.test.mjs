// The site's pictures change shape when they are re-shot: each page must state the size
// the picture really has, or the page jumps while it loads.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { stalePages, syncImageSizes, webpSize } = await import('../../tools/site-shots/image-sizes.mjs');

function riff(chunk, body) {
  const header = Buffer.from(`RIFF\0\0\0\0WEBP${chunk}`, 'latin1');
  return Buffer.concat([header, Buffer.alloc(4), body]);
}

test('the size of a lossy, a lossless and an extended WebP', () => {
  const lossy = Buffer.alloc(14);
  lossy.set([0x9d, 0x01, 0x2a], 3);
  lossy.writeUInt16LE(1400, 6);
  lossy.writeUInt16LE(1048, 8);
  assert.deepEqual(webpSize(riff('VP8 ', lossy)), [1400, 1048]);

  const lossless = Buffer.alloc(5);
  lossless[0] = 0x2f;
  lossless.writeUInt32LE((1399 | (1047 << 14)) >>> 0, 1);
  assert.deepEqual(webpSize(riff('VP8L', lossless)), [1400, 1048]);

  const extended = Buffer.alloc(10);
  extended.writeUIntLE(1399, 4, 3);
  extended.writeUIntLE(1047, 7, 3);
  assert.deepEqual(webpSize(riff('VP8X', extended)), [1400, 1048]);
});

test('a file that is not a WebP is an error, not a size', () => {
  assert.throws(() => webpSize(Buffer.from('not a picture at all, sorry')), /not a WebP/);
});

test('a stated size follows the picture, and everything else stays', () => {
  const sizeOf = () => [1400, 1048];
  const page = '<img class="a" src="/images/home/w-deck.webp" width="1" height="2" alt="x">';
  assert.equal(syncImageSizes(page, sizeOf), '<img class="a" src="/images/home/w-deck.webp" width="1400" height="1048" alt="x">');
  for (const kept of ['<img src="/images/home/w-deck.webp" alt="no size">', '<img src="/images/a.png" width="1" height="2">', '<p width="1" height="2">']) {
    assert.equal(syncImageSizes(kept, sizeOf), kept);
  }
});

test('every page states the real size of its pictures', () => {
  assert.deepEqual(stalePages().map((page) => page.name), []);
});
