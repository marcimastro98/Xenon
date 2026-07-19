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
    assert.deepEqual(S.sanitizeSlideshow(v), {
      images: [], source: 'library', folder: '', shuffle: false,
      pauseGame: true,
      intervalMs: S.INTERVAL_DEFAULT, fit: 'cover',
    });
  }
});

test('sanitizeSlideshow: source falls back to the uploaded library', () => {
  assert.equal(S.sanitizeSlideshow({ source: 'folder' }).source, 'folder');
  for (const v of ['network', '', null, 42, 'FOLDER']) {
    assert.equal(S.sanitizeSlideshow({ source: v }).source, 'library');
  }
});

test('sanitizeSlideshow: the GIF-freeze option defaults ON and only false disables', () => {
  // A settings blob that predates the key must come back with it ON, not off.
  assert.equal(S.sanitizeSlideshow({}).pauseGame, true);
  assert.equal(S.sanitizeSlideshow({ pauseGame: false }).pauseGame, false);
  // Anything that is not exactly false leaves the protection on.
  for (const v of [0, '', null, 'no']) {
    assert.equal(S.sanitizeSlideshow({ pauseGame: v }).pauseGame, true);
  }
});

test('sanitizeSlideshow: there is no inactivity-based freeze option', () => {
  // `ambient-idle` means "no input for a while", which on the Edge is how this
  // widget is normally watched — freezing on it stopped the slideshow dead. The
  // key must stay gone, not come back as an unused leftover (see globalFreeze).
  const out = S.sanitizeSlideshow({ pauseIdle: true });
  assert.equal('pauseIdle' in out, false);
});

test('sanitizeSlideshow: shuffle is strictly boolean', () => {
  assert.equal(S.sanitizeSlideshow({ shuffle: true }).shuffle, true);
  // Truthy-but-not-true must NOT enable it: the value round-trips through JSON and
  // a stale mirror carrying `1` should not silently turn shuffle on.
  for (const v of [1, 'true', {}, 'yes']) {
    assert.equal(S.sanitizeSlideshow({ shuffle: v }).shuffle, false);
  }
});

test('sanitizeSlideshow: folder path is trimmed, bounded, and control-char free', () => {
  assert.equal(S.sanitizeSlideshow({ folder: '  C:\\gifs  ' }).folder, 'C:\\gifs');
  assert.equal(S.sanitizeSlideshow({ folder: 42 }).folder, '');
  // A path carrying a NUL or a newline must never reach an fs call.
  for (const ch of [String.fromCharCode(0), String.fromCharCode(10), String.fromCharCode(13), String.fromCharCode(127)]) {
    assert.equal(S.sanitizeSlideshow({ folder: 'C:\\a' + ch + 'b' }).folder, '');
  }
  assert.equal(
    S.sanitizeSlideshow({ folder: 'C:\\' + 'x'.repeat(S.SLIDE_FOLDER_MAX_CHARS + 100) }).folder.length,
    S.SLIDE_FOLDER_MAX_CHARS,
  );
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

test('sanitizeSlideshow: disk-backed /uploads/slideshow-* refs are kept as-is', () => {
  const out = S.sanitizeSlideshow({
    images: [
      { name: 'a.gif', uri: '/uploads/slideshow-1700000000000-abc123.gif' },
      { name: 'b.png', uri: '/uploads/slideshow-1700000000001-def456.png' },
    ],
  });
  assert.equal(out.images.length, 2);
  assert.equal(out.images[0].uri, '/uploads/slideshow-1700000000000-abc123.gif');
  assert.equal(out.images[0].name, 'a.gif');
});

test('sanitizeSlideshow: only the slideshow- upload prefix is accepted, not other paths', () => {
  const out = S.sanitizeSlideshow({
    images: [
      { uri: '/uploads/tileasset-1-x.png' },          // another feature's assets
      { uri: '/uploads/../secret.png' },              // traversal-shaped
      { uri: '/uploads/slideshow-9-ok.webp' },        // the one good ref
      { uri: 'uploads/slideshow-9-ok.webp' },         // missing leading slash
    ],
  });
  assert.equal(out.images.length, 1);
  assert.equal(out.images[0].uri, '/uploads/slideshow-9-ok.webp');
});

test('sanitizeSlideshow: disk-backed refs do NOT count against the byte budget', () => {
  // The total-size cap only guards legacy inline base64; a full set of disk refs
  // (each a tiny path) is bounded by the count ceiling, not by SLIDES_TOTAL_MAX.
  const many = Array.from({ length: S.SLIDE_MAX_COUNT }, (_, i) => ({ uri: `/uploads/slideshow-${i}-x.gif` }));
  const out = S.sanitizeSlideshow({ images: many });
  assert.equal(out.images.length, S.SLIDE_MAX_COUNT);
});

test('sanitizeSlideshow: legacy inline and disk-backed images coexist in order', () => {
  const out = S.sanitizeSlideshow({
    images: [
      { name: 'legacy', uri: uri(20, 'gif') },
      { name: 'disk', uri: '/uploads/slideshow-1-y.png' },
    ],
  });
  assert.equal(out.images.length, 2);
  assert.equal(out.images[0].name, 'legacy');
  assert.equal(out.images[1].uri, '/uploads/slideshow-1-y.png');
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
