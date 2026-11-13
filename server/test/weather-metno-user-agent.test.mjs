// met.no asks every client to say who it is and which version it runs. The
// header used to carry a fixed "3.3" long after the app had moved on; it now
// carries the version of the app that is asking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

import { declarationSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { METNO_HEADERS } = require('../weather/met-norway.js');

test('the header names the app, the version it was given and where to reach the project', () => {
  assert.match(METNO_HEADERS('5.1.0')['User-Agent'], /^XenonEdgeHub\/5\.1\.0 \(github\.com\/[^)\s]+\/Xenon\)$/);
  assert.match(METNO_HEADERS('12.0.3')['User-Agent'], /^XenonEdgeHub\/12\.0\.3 \(/);
  assert.deepEqual(Object.keys(METNO_HEADERS('5.1.0')), ['User-Agent']);
});

test('an unreadable version still gives a well-formed header', () => {
  for (const missing of ['', undefined, null]) {
    assert.match(METNO_HEADERS(missing)['User-Agent'], /^XenonEdgeHub\/0 \(/);
  }
});

test('the engine hands over its own version, and no number is written in the module', () => {
  assert.match(declarationSource('fetchMetnoWeather'), /fetchJson\(url, 3500, METNO_HEADERS\(APP_VERSION\)\)/);
  const moduleText = readFileSync(new URL('../weather/met-norway.js', import.meta.url), 'utf8');
  assert.doesNotMatch(moduleText, /XenonEdgeHub\/\d/);
});
