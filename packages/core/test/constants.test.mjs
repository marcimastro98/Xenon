import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const c = require('../src/constants.js');

test('loopback origin points at the local server', () => {
  assert.equal(c.LOOPBACK_ORIGIN, 'http://127.0.0.1:3030');
});

test('supported languages are the shipped set', () => {
  assert.deepEqual([...c.SUPPORTED_LANGS].sort(), ['en', 'it', 'ja', 'ko', 'zh']);
  assert.ok(Object.isFrozen(c.SUPPORTED_LANGS));
  assert.ok(c.SUPPORTED_LANGS.includes(c.DEFAULT_LANG));
});

test('normalizeLangCode maps locales to a supported code or empty', () => {
  assert.equal(c.normalizeLangCode('en-US'), 'en');
  assert.equal(c.normalizeLangCode('IT'), 'it');
  assert.equal(c.normalizeLangCode('ja-JP'), 'ja');
  assert.equal(c.normalizeLangCode('fr'), '');
  assert.equal(c.normalizeLangCode(null), '');
});

test('barrel re-exports both namespaces', () => {
  const core = require('../src/index.js');
  assert.equal(typeof core.constants.normalizeLangCode, 'function');
  assert.equal(typeof core.format.formatBytes, 'function');
});
