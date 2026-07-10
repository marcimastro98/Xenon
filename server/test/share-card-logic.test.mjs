import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sc = require('../js/share-card.js');

// The QR target ladder: gallery anchor > small-code landing > no QR.

test('gallery entries win regardless of code size', () => {
  const r = sc.pickQrTarget({ galleryId: 'ember-nights', code: 'x'.repeat(500000) });
  assert.equal(r.type, 'gallery');
  assert.equal(r.url, sc.SHARE_SITE_BASE + 'index.html#ember-nights');
});

test('gallery id must match the strict charset or it falls through', () => {
  const r = sc.pickQrTarget({ galleryId: '../evil', code: 'abc' });
  assert.equal(r.type, 'landing');
  assert.equal(sc.pickQrTarget({ galleryId: 'UPPER', code: '' }), null);
});

test('small codes get the docs landing with the code in the fragment', () => {
  const code = 'a'.repeat(sc.QR_CODE_MAX_BYTES);
  const r = sc.pickQrTarget({ code });
  assert.equal(r.type, 'landing');
  assert.equal(r.url, sc.SHARE_SITE_BASE + 'get/#code=' + code);
  assert.equal(r.url.includes('127.0.0.1'), false);
});

test('codes past the QR cap yield no QR (boundary exact)', () => {
  assert.ok(sc.pickQrTarget({ code: 'a'.repeat(sc.QR_CODE_MAX_BYTES) }));
  assert.equal(sc.pickQrTarget({ code: 'a'.repeat(sc.QR_CODE_MAX_BYTES + 1) }), null);
});

test('junk input yields no QR', () => {
  assert.equal(sc.pickQrTarget(null), null);
  assert.equal(sc.pickQrTarget({}), null);
  assert.equal(sc.pickQrTarget({ code: '' }), null);
  assert.equal(sc.pickQrTarget({ galleryId: 42, code: 42 }), null);
});
