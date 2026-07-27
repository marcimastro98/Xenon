import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sc = require('../js/share-card.js');

// ── The QR target ladder: gallery anchor > small-code landing > site root. ──

test('gallery entries win regardless of code size', () => {
  const r = sc.pickQrTarget({ galleryId: 'ember-nights', code: 'x'.repeat(500000) });
  assert.equal(r.type, 'gallery');
  // The permalink contract is the catalog page; index.html#<id> is a dead link.
  assert.equal(r.url, sc.SHARE_SITE_BASE + 'catalog/#ember-nights');
});

test('gallery id must match the strict charset or it falls through', () => {
  const r = sc.pickQrTarget({ galleryId: '../evil', code: 'abc' });
  assert.equal(r.type, 'landing');
  assert.equal(sc.pickQrTarget({ galleryId: 'UPPER', code: '' }).type, 'site');
});

test('small codes get the docs landing with the code in the fragment', () => {
  const code = 'a'.repeat(sc.QR_CODE_MAX_BYTES);
  const r = sc.pickQrTarget({ code });
  assert.equal(r.type, 'landing');
  assert.equal(r.url, sc.SHARE_SITE_BASE + 'get/#code=' + code);
});

test('codes past the QR cap fall back to the site root (boundary exact)', () => {
  assert.equal(sc.pickQrTarget({ code: 'a'.repeat(sc.QR_CODE_MAX_BYTES) }).type, 'landing');
  const over = sc.pickQrTarget({ code: 'a'.repeat(sc.QR_CODE_MAX_BYTES + 1) });
  assert.equal(over.type, 'site');
  assert.equal(over.url, sc.SHARE_SITE_BASE);
});

// The cap is about what a phone can READ off a posted image, not what the format
// can hold. Raising it back produces a QR that looks fine in code review and is
// unscannable in the wild, which is exactly how the card this replaced shipped.
test('the QR cap stays inside what a phone can actually read', () => {
  assert.ok(sc.QR_CODE_MAX_BYTES <= 160,
    'above ~160 bytes the QR needs more modules than the card has pixels for');
  // A real preset code — even a minimal theme — is far past that, so it must
  // resolve to a short, scannable destination instead.
  const realisticThemeCode = 'a'.repeat(900);
  assert.equal(sc.pickQrTarget({ code: realisticThemeCode }).type, 'site');
  assert.ok(sc.pickQrTarget({ code: realisticThemeCode }).url.length < 60);
  // …and a published entry gives the good outcome: short and specific.
  assert.ok(sc.pickQrTarget({ galleryId: 'ember-nights', code: realisticThemeCode }).url.length < 60);
});

test('junk input still yields a scannable target, never null', () => {
  for (const input of [null, {}, { code: '' }, { galleryId: 42, code: 42 }]) {
    const r = sc.pickQrTarget(input);
    assert.equal(r.type, 'site');
    assert.equal(r.url, sc.SHARE_SITE_BASE);
  }
});

// The invariant with teeth: a phone scanning the card cannot reach the local
// dashboard, so no rung may ever emit a loopback deep link.
test('no rung ever emits a loopback URL', () => {
  const inputs = [
    { galleryId: 'ember-nights' },
    { code: 'a'.repeat(100) },
    { code: 'a'.repeat(sc.QR_CODE_MAX_BYTES + 1) },
    {}, null,
    { galleryId: '127.0.0.1', code: 'http://127.0.0.1:3030/#preset=abc' },
  ];
  for (const input of inputs) {
    const url = sc.pickQrTarget(input).url;
    assert.equal(url.includes('127.0.0.1'), false, 'loopback leaked for ' + JSON.stringify(input));
    assert.equal(url.startsWith(sc.SHARE_SITE_BASE), true);
  }
});

// ── matchScreen: which display holds the dashboard, by shape. ──

const S = (index, width, height, extra) => Object.assign({ index, width, height }, extra || {});

test('a uniquely-shaped display is matched among others', () => {
  const screens = [S(0, 1920, 1080), S(1, 2560, 720), S(2, 1920, 1080)];
  assert.equal(sc.matchScreen(2560 / 720, screens), 1);
});

// THE anti-DPI test. PowerShell and ffmpeg are DPI-unaware, so a 2560x720 panel
// on a 150%-scaled desktop enumerates as 1707x480. Matching on aspect ratio is
// what makes the two coordinate spaces meet.
test('matching is invariant to DPI virtualisation', () => {
  const screens = [S(0, 1280, 720), S(1, 1707, 480)];
  assert.equal(sc.matchScreen(2560 / 720, screens), 1);
});

test('two displays of the same shape refuse rather than guess', () => {
  const screens = [S(0, 1920, 1080), S(1, 1920, 1080)];
  assert.equal(sc.matchScreen(1920 / 1080, screens), null);
  // …even when their pixel counts differ but the shape does not.
  assert.equal(sc.matchScreen(16 / 9, [S(0, 1920, 1080), S(1, 3840, 2160)]), null);
});

test('16:10 does not collide with 16:9', () => {
  const screens = [S(0, 1920, 1080), S(1, 1920, 1200)];
  assert.equal(sc.matchScreen(1920 / 1200, screens), 1);
  assert.equal(sc.matchScreen(1920 / 1080, screens), 0);
});

test('negative origins do not affect matching', () => {
  const screens = [S(0, 1920, 1080, { x: 0, y: 0 }), S(1, 2560, 720, { x: -2560, y: -200 })];
  assert.equal(sc.matchScreen(2560 / 720, screens), 1);
});

test('degenerate entries are skipped, never divided by', () => {
  const screens = [S(0, 0, 0), S(1, 1920, 0), S(2, 2560, 720), null];
  assert.equal(sc.matchScreen(2560 / 720, screens), 2);
});

test('no candidate, empty list and junk all refuse', () => {
  assert.equal(sc.matchScreen(2560 / 720, [S(0, 1920, 1080)]), null);
  assert.equal(sc.matchScreen(2560 / 720, []), null);
  assert.equal(sc.matchScreen(2560 / 720, null), null);
  assert.equal(sc.matchScreen(NaN, [S(0, 2560, 720)]), null);
  assert.equal(sc.matchScreen(0, [S(0, 2560, 720)]), null);
  assert.equal(sc.matchScreen(-3.5, [S(0, 2560, 720)]), null);
});

// ── wrapName ──

// Fixed-width measure so the expectations are arithmetic, not font-dependent.
const measure = (s) => s.length * 10;

test('a short name is one line, untouched', () => {
  assert.deepEqual(sc.wrapName(measure, 'Ember Nights', 300, 2), ['Ember Nights']);
});

test('a name wraps at the box and keeps both lines', () => {
  assert.deepEqual(sc.wrapName(measure, 'Ember Nights Aurora', 130, 2), ['Ember Nights', 'Aurora']);
});

test('a word wider than the box is hard-broken, never dropped', () => {
  const lines = sc.wrapName(measure, 'Supercalifragilistic', 100, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].length > 0, 'the over-wide word must produce output');
  // The old card measured it, never pushed it, and returned nothing at all.
  assert.ok(lines.join('').startsWith('Super'));
  lines.forEach((ln) => assert.ok(measure(ln) <= 100, 'line overflows the box: ' + ln));
});

test('overflow past the last line is marked with an ellipsis that still fits', () => {
  const lines = sc.wrapName(measure, 'one two three four five six seven eight', 100, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith('…'));
  lines.forEach((ln) => assert.ok(measure(ln) <= 100, 'line overflows the box: ' + ln));
});

test('empty and junk names fall back to the wordmark', () => {
  assert.deepEqual(sc.wrapName(measure, '', 300, 2), ['Xenon']);
  assert.deepEqual(sc.wrapName(measure, '   ', 300, 2), ['Xenon']);
  assert.deepEqual(sc.wrapName(measure, null, 300, 2), ['Xenon']);
  assert.deepEqual(sc.wrapName(measure, undefined, 300, 2), ['Xenon']);
});

test('a 60-char name (the encodePreset cap) fits in two lines of the real box', () => {
  // 1000px of name box against the composer's ~28px average glyph advance.
  const name = 'Aurora'.padEnd(60, ' x').slice(0, 60);
  const lines = sc.wrapName((s) => s.length * 28, name, 1000, 2);
  assert.ok(lines.length <= 2);
  lines.forEach((ln) => assert.ok(ln.length * 28 <= 1000));
});

// ── cardSize ──

test('cardSize knows two formats and defaults to post', () => {
  assert.deepEqual(sc.cardSize('post'), { w: 1600, h: 900 });
  assert.deepEqual(sc.cardSize('story'), { w: 1080, h: 1920 });
  assert.deepEqual(sc.cardSize('nonsense'), { w: 1600, h: 900 });
  assert.deepEqual(sc.cardSize(undefined), { w: 1600, h: 900 });
});

// ── clampBlurRects ──

// The clamp arithmetic goes through x + w, so exact float equality is the wrong
// assertion — these are canvas fractions, a 1e-16 drift is not a defect.
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' !~= ' + b);

test('in-range rects pass through unchanged', () => {
  const out = sc.clampBlurRects([{ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }]);
  assert.equal(out.length, 1);
  near(out[0].x, 0.1); near(out[0].y, 0.2); near(out[0].w, 0.3); near(out[0].h, 0.4);
});

test('rects are clamped into the plate, never painted outside it', () => {
  const out = sc.clampBlurRects([{ x: -0.5, y: 0.9, w: 2, h: 0.5 }]);
  assert.equal(out.length, 1);
  near(out[0].x, 0); near(out[0].y, 0.9); near(out[0].w, 1); near(out[0].h, 0.1);
  out.forEach((b) => {
    assert.ok(b.x >= 0 && b.y >= 0);
    assert.ok(b.x + b.w <= 1 + 1e-9 && b.y + b.h <= 1 + 1e-9);
  });
});

test('degenerate and fully off-plate rects are dropped', () => {
  assert.deepEqual(sc.clampBlurRects([{ x: 0.1, y: 0.1, w: 0, h: 0.2 }]), []);
  assert.deepEqual(sc.clampBlurRects([{ x: 0.1, y: 0.1, w: -0.2, h: 0.2 }]), []);
  assert.deepEqual(sc.clampBlurRects([{ x: 1.5, y: 0.1, w: 0.2, h: 0.2 }]), []);
  assert.deepEqual(sc.clampBlurRects([{ x: 0.1, y: 0.1, w: NaN, h: 0.2 }]), []);
  assert.deepEqual(sc.clampBlurRects([null, undefined]), []);
  assert.deepEqual(sc.clampBlurRects(null), []);
  assert.deepEqual(sc.clampBlurRects('nope'), []);
});
