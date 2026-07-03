import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { encodePreset, decodePreset } = require('../js/preset-share.js');

// Portable-preset format: encode → decode round-trip + rejection of junk. The
// browser dialogs/apply layer is skipped under node (no window).

test('encode → decode round-trips kind, name and data (incl. non-ASCII)', () => {
  const data = { accent: '#ff7eb6', background: '#16101a', appearance: 'dark' };
  const code = encodePreset('theme', '테마 · 私の', data, { exportedAt: '2026-07-03', appVersion: '4.0.0' });
  const env = decodePreset(code);
  assert.ok(env);
  assert.equal(env.kind, 'theme');
  assert.equal(env.name, '테마 · 私の');
  assert.deepEqual(env.data, data);
});

test('decode accepts a full link, a bare code and raw JSON', () => {
  const code = encodePreset('page', 'Gaming', { items: [{ type: 'widget', widget: 'system', x: 0, y: 0, w: 4, h: 3 }] });
  assert.equal(decodePreset('http://127.0.0.1:3030/#preset=' + code).kind, 'page');
  assert.equal(decodePreset(code).name, 'Gaming');
  const rawJson = JSON.stringify({ xenonPreset: 1, kind: 'theme', name: 'x', data: { accent: '#000' } });
  assert.equal(decodePreset(rawJson).kind, 'theme');
});

test('decode rejects malformed / wrong-format / wrong-kind input', () => {
  assert.equal(decodePreset(''), null);
  assert.equal(decodePreset('not base64 @@@ !!!'), null);
  assert.equal(decodePreset(null), null);
  // wrong format version
  const badVer = Buffer.from(JSON.stringify({ xenonPreset: 2, kind: 'theme', name: 'x', data: {} }), 'utf8').toString('base64url');
  assert.equal(decodePreset(badVer), null);
  // unknown kind (deck sharing is deliberately not supported by this format)
  const badKind = Buffer.from(JSON.stringify({ xenonPreset: 1, kind: 'deck', name: 'x', data: {} }), 'utf8').toString('base64url');
  assert.equal(decodePreset(badKind), null);
  // missing data object
  const noData = Buffer.from(JSON.stringify({ xenonPreset: 1, kind: 'theme', name: 'x' }), 'utf8').toString('base64url');
  assert.equal(decodePreset(noData), null);
});

test('name is bounded to 60 chars on encode', () => {
  const env = decodePreset(encodePreset('theme', 'x'.repeat(200), { accent: '#000' }));
  assert.equal(env.name.length, 60);
});
