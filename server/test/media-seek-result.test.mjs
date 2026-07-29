'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mediaSeekFailure, normalizeMediaSeekResult } = require('../media-seek-result.js');

test('media seek result preserves the stable player/host failure distinction', () => {
  assert.equal(mediaSeekFailure({ ok: false, error: 'not_seekable' }), 'not_seekable');
  assert.equal(mediaSeekFailure({ ok: false, error: 'unavailable' }), 'unavailable');
  assert.equal(mediaSeekFailure({ ok: false, error: 'bad_position' }), 'bad_position');
  assert.equal(mediaSeekFailure({ ok: false, error: 'native_broker_died' }), 'unavailable');
  assert.equal(mediaSeekFailure(null), 'unavailable');
});

test('media seek result keeps a native clamp and falls back to the requested position', () => {
  assert.deepEqual(
    normalizeMediaSeekResult({ ok: true, seekProtocol: 1, position: 42 }, 80),
    { ok: true, seekProtocol: 1, position: 42 },
  );
  assert.deepEqual(
    normalizeMediaSeekResult({ ok: true, seekProtocol: 1 }, 80),
    { ok: true, seekProtocol: 1, position: 80 },
  );
  assert.deepEqual(
    normalizeMediaSeekResult({ ok: false, error: 'not_seekable' }, 80),
    { ok: false, error: 'not_seekable' },
  );
  assert.deepEqual(
    normalizeMediaSeekResult(undefined, 80),
    { ok: false, error: 'unavailable' },
  );
});
