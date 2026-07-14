import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../js/slideshow-widget.js');   // the shared sanitizer (client + server own the SAME rules)

// Build a syntactically-valid image data URI whose base64 body has `bodyLen`
// chars, so tests can push against the per-image / total size caps precisely.
function uri(bodyLen, mime = 'gif') {
  return `data:image/${mime};base64,` + 'A'.repeat(Math.max(1, bodyLen));
}

test('sanitizeSlideshow: junk input returns the safe defaults', () => {
  for (const v of [null, undefined, 42, 'x', [], {}]) {
    assert.deepEqual(S.sanitizeSlideshow(v), { images: [], intervalMs: S.INTERVAL_DEFAULT, fit: 'cover' });
  }
});

test('sanitizeSlideshow: valid images are kept in order, names trimmed/bounded', () => {
  const out = S.sanitizeSlideshow({
    images: [
      { name: '  hello.gif  ', uri: uri(20, 'gif') },
      { name: 'x'.repeat(200), uri: uri(20, 'png') },
      { name: 42, uri: uri(20, 'webp') },
    ],
  });
  assert.equal(out.images.length, 3);
  assert.equal(out.images[0].name, 'hello.gif');          // trimmed
  assert.equal(out.images[1].name.length, 80);            // sliced to 80
  assert.equal(out.images[2].name, '');                   // non-string → ''
  assert.equal(out.images[0].uri.startsWith('data:image/gif;base64,'), true);
});

test('sanitizeSlideshow: non-image / wrong-scheme / oversize URIs are dropped', () => {
  const out = S.sanitizeSlideshow({
    images: [
      { uri: 'https://example.com/a.gif' },               // not a data: URI
      { uri: 'data:text/html;base64,AAAA' },              // wrong MIME
      { uri: 'data:image/gif;base64,***' },               // illegal base64 chars
      { uri: uri(S.SLIDE_MAX_CHARS + 50) },               // over the per-image cap
      { uri: uri(30) },                                   // the one good one
    ],
  });
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].uri, uri(30));
});

test('sanitizeSlideshow: the count cap bounds the set', () => {
  const many = Array.from({ length: S.SLIDE_MAX_COUNT + 10 }, () => ({ uri: uri(20) }));
  const out = S.sanitizeSlideshow({ images: many });
  assert.equal(out.images.length, S.SLIDE_MAX_COUNT);
});

test('sanitizeSlideshow: the total-size cap stops adding, keeping what fits', () => {
  // Each image is under the per-image cap but big enough that the whole set blows
  // the total budget, so only the leading few that fit are kept.
  const body = Math.floor(S.SLIDE_MAX_CHARS * 0.9);       // < per-image cap
  const perUri = uri(body).length;
  const fits = Math.floor(S.SLIDES_TOTAL_MAX / perUri);   // how many fit under the total cap
  const out = S.sanitizeSlideshow({ images: Array.from({ length: fits + 3 }, () => ({ uri: uri(body) })) });
  assert.equal(out.images.length, fits);
  assert.ok(out.images.length >= 1 && out.images.length < fits + 3, 'some were dropped by the total cap');
  const total = out.images.reduce((s, im) => s + im.uri.length, 0);
  assert.ok(total <= S.SLIDES_TOTAL_MAX, 'kept set stays within the total budget');
});

test('sanitizeSlideshow: interval is clamped, non-numbers fall back to the default', () => {
  assert.equal(S.sanitizeSlideshow({ intervalMs: 10 }).intervalMs, S.INTERVAL_MIN);
  assert.equal(S.sanitizeSlideshow({ intervalMs: 9e9 }).intervalMs, S.INTERVAL_MAX);
  assert.equal(S.sanitizeSlideshow({ intervalMs: 'soon' }).intervalMs, S.INTERVAL_DEFAULT);
  assert.equal(S.sanitizeSlideshow({ intervalMs: 4000 }).intervalMs, 4000);
});

test('sanitizeSlideshow: fit is allow-listed', () => {
  assert.equal(S.sanitizeSlideshow({ fit: 'contain' }).fit, 'contain');
  assert.equal(S.sanitizeSlideshow({ fit: 'cover' }).fit, 'cover');
  assert.equal(S.sanitizeSlideshow({ fit: 'stretch' }).fit, 'cover');   // unknown → default
});
