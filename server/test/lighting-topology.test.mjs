// The lighting map splits each iCUE device into fans, pumps, strips and RAM
// sticks. The fixtures are what a read-only SDK probe returned on real hardware
// (Oct 2026); the iCUE LINK case matters most, because its LED groups do not
// line up with its channels and a group-based split would colour the wrong fan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildSegments } = require('../lighting-topology.js');

const luid = (group, index) => ((group << 16) | index) >>> 0;
const ledsOf = (group, n, from = 1) => Array.from({ length: n }, (_, i) => ({ id: luid(group, from + i), cx: i * 20, cy: 5 }));

test('iCUE LINK hub: one channel, pump + three fans, split by count not by group', () => {
  const leds = [...ledsOf(11, 40), ...ledsOf(12, 24)];
  const segs = buildSegments({ type: 0x40, leds, channels: [{ ledCounts: [40, 8, 8, 8], types: [9, 6, 6, 6] }] });
  assert.deepEqual(segs.map(s => [s.kind, s.ledIds.length]), [['pump', 40], ['fan', 8], ['fan', 8], ['fan', 8]]);
  // The first fan starts right after the pump, inside group 12.
  assert.equal(segs[1].ledIds[0], luid(12, 1));
  assert.equal(segs[3].ledIds[7], luid(12, 24));
});

test('RAM: two channels of one stick each', () => {
  const segs = buildSegments({ type: 0x80, leds: ledsOf(8, 20), channels: [{ ledCounts: [10], types: [10] }, { ledCounts: [10], types: [10] }] });
  assert.deepEqual(segs.map(s => [s.kind, s.ledIds.length]), [['dram', 10], ['dram', 10]]);
});

test('LEDs are ordered by luid before the split, whatever order the SDK returned them in', () => {
  const leds = ledsOf(9, 5).reverse();
  const segs = buildSegments({ type: 0x400, leds, channels: [] });
  assert.deepEqual(segs[0].ledIds, ledsOf(9, 5).map(l => l.id));
  assert.equal(segs[0].kind, 'zone');
});

// The GIGABYTE board plugin reported 5 LEDs, one per zone (Zone1..Zone5 in iCUE).
test('a motherboard: each zone is a part of its own, in luid order', () => {
  const segs = buildSegments({ type: 0x200, leds: ledsOf(9, 5).reverse(), channels: [] });
  assert.deepEqual(segs.map(s => [s.kind, s.ledIds]), ledsOf(9, 5).map(l => ['zone', [l.id]]));
  // A board with a real per-LED strip stays one part, not dozens.
  assert.equal(buildSegments({ type: 0x200, leds: ledsOf(9, 40), channels: [] }).length, 1);
});

test('counts that do not add up fall back to the whole device, never a wrong split', () => {
  const segs = buildSegments({ type: 0x40, leds: ledsOf(11, 30), channels: [{ ledCounts: [40, 8], types: [9, 6] }] });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].ledIds.length, 30);
});

test('a malformed channel falls back to the whole device', () => {
  const segs = buildSegments({ type: 0x80, leds: ledsOf(8, 10), channels: [{ ledCounts: [10] }] });
  assert.deepEqual(segs.map(s => [s.kind, s.ledIds.length]), [['dram', 10]]);
});

test('a keyboard draws from its positions', () => {
  const segs = buildSegments({ type: 0x01, leds: [{ id: 1, cx: 10.04, cy: 3 }, { id: 2, cx: 29.96, cy: 3 }] });
  assert.equal(segs[0].kind, 'pos');
  assert.deepEqual(segs[0].pos, [[10, 3], [30, 3]]);
});

test('fan models come from the channel device type; unknown types draw as a strip', () => {
  const segs = buildSegments({ type: 0x20, leds: ledsOf(11, 34 + 10), channels: [{ ledCounts: [34, 10], types: [12, 99] }] });
  assert.deepEqual(segs.map(s => [s.kind, s.model]), [['fan', 'QX'], ['strip', '']]);
});

test('no LEDs → no segments; zero-count devices are skipped', () => {
  assert.deepEqual(buildSegments({ type: 0x40, leds: [] }), []);
  const segs = buildSegments({ type: 0x40, leds: ledsOf(11, 8), channels: [{ ledCounts: [0, 8], types: [6, 6] }] });
  assert.deepEqual(segs.map(s => s.ledIds.length), [8]);
});
