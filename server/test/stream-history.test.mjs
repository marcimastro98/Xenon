// The short history a widget receives at start (the `processes` stream first).
// It must stay bounded by age AND count, and speak in ages rather than clock
// times, because a paired phone's clock is not this PC's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { createStreamHistory } = require(join(ROOT, 'server', 'stream-history.js'));

test('an empty history reads as an empty list', () => {
  const h = createStreamHistory();
  assert.deepEqual(h.toWire(1000), []);
  assert.equal(h.size, 0);
});

test('the wire form carries ages, oldest first', () => {
  const h = createStreamHistory();
  h.push({ n: 1 }, 10_000);
  h.push({ n: 2 }, 12_000);
  assert.deepEqual(h.toWire(15_000), [
    { age: 5000, data: { n: 1 } },
    { age: 3000, data: { n: 2 } },
  ]);
});

test('readings older than the age limit are dropped', () => {
  const h = createStreamHistory({ maxAgeMs: 5000 });
  h.push('a', 0);
  h.push('b', 4000);
  h.push('c', 8000);
  assert.deepEqual(h.toWire(8000).map((x) => x.data), ['b', 'c']);
  assert.deepEqual(h.toWire(20_000), []);
});

test('the count limit holds even inside the age window', () => {
  const h = createStreamHistory({ maxAgeMs: 60_000, maxItems: 3 });
  for (let i = 0; i < 10; i++) h.push(i, 1000 + i);
  assert.deepEqual(h.toWire(1010).map((x) => x.data), [7, 8, 9]);
});

test('a clock stepping backwards restarts the history instead of mixing it', () => {
  const h = createStreamHistory();
  h.push('before', 50_000);
  h.push('after', 10_000);
  assert.deepEqual(h.toWire(10_000).map((x) => x.data), ['after']);
});

test('null readings are not stored', () => {
  const h = createStreamHistory();
  h.push(null, 1000);
  h.push(undefined, 1000);
  assert.equal(h.size, 0);
});
