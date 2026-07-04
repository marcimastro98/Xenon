import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fmt = require('../src/format.js');

test('pad2 zero-pads to two digits', () => {
  assert.equal(fmt.pad2(3), '03');
  assert.equal(fmt.pad2(12), '12');
});

test('toNumber tolerates comma decimals and non-numbers', () => {
  assert.equal(fmt.toNumber(42), 42);
  assert.equal(fmt.toNumber('78,3'), 78.3);
  assert.equal(fmt.toNumber('nope'), 0);
  assert.equal(fmt.toNumber(null), 0);
});

test('clampPercent rounds into [0,100]', () => {
  assert.equal(fmt.clampPercent('78,6'), 79);
  assert.equal(fmt.clampPercent(-5), 0);
  assert.equal(fmt.clampPercent(250), 100);
  assert.equal(fmt.clampPercent('x'), 0);
});

test('clampRange clamps with a default for non-finite input', () => {
  assert.equal(fmt.clampRange(5, 0, 10, 1), 5);
  assert.equal(fmt.clampRange(-1, 0, 10, 1), 0);
  assert.equal(fmt.clampRange(99, 0, 10, 1), 10);
  assert.equal(fmt.clampRange('x', 0, 10, 7), 7);
});

test('formatBytes uses TB/GB/MB/B (dashboard semantics)', () => {
  assert.equal(fmt.formatBytes(0), '0 B');
  assert.equal(fmt.formatBytes(1536), '1536 B');
  assert.equal(fmt.formatBytes(5 * 1024 ** 2), '5 MB');
  assert.equal(fmt.formatBytes(2 * 1024 ** 3), '2.0 GB');
  assert.equal(fmt.formatBytes(3 * 1024 ** 4), '3.0 TB');
});

test('formatBytesCompact uses GB/MB and empty string for falsy (widget semantics)', () => {
  assert.equal(fmt.formatBytesCompact(0), '');
  assert.equal(fmt.formatBytesCompact(512 * 1024 ** 2), '512 MB');
  assert.equal(fmt.formatBytesCompact(4 * 1024 ** 3), '4.0 GB');
});

test('formatUptime prints Hh Mm, or Mm under an hour', () => {
  assert.equal(fmt.formatUptime(0), '0m');
  assert.equal(fmt.formatUptime(59), '0m');
  assert.equal(fmt.formatUptime(3600), '1h 0m');
  assert.equal(fmt.formatUptime(3661), '1h 1m');
});

test('formatBandwidth returns bit-rate value/unit', () => {
  assert.deepEqual(fmt.formatBandwidth(null), { value: '--', unit: 'Mbps' });
  assert.deepEqual(fmt.formatBandwidth(100), { value: '800', unit: 'bps' });
  assert.deepEqual(fmt.formatBandwidth(125), { value: '1', unit: 'Kbps' });
  assert.deepEqual(fmt.formatBandwidth(1e6), { value: '8.0', unit: 'Mbps' });
  assert.deepEqual(fmt.formatBandwidth(1e9), { value: '8.00', unit: 'Gbps' });
});

test('toDateInputValue produces a local YYYY-MM-DD', () => {
  const d = new Date(2026, 0, 5); // 5 Jan 2026, local
  assert.equal(fmt.toDateInputValue(d), '2026-01-05');
});
