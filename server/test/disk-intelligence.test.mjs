import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DiskIntelligence = require('../js/disk-intelligence.js');

test('disk intelligence separates safe, review, permanent and duplicate opportunity', () => {
  const GIB = 1024 ** 3;
  const out = DiskIntelligence.analyze({
    root: 'C:\\',
    total: 700 * GIB,
    volume: { capacity: 1000 * GIB, free: 80 * GIB },
    categories: {
      temp: { bytes: 12 * GIB, count: 30 },
      buildOutput: { bytes: 20 * GIB, count: 4 },
      recycleBin: { bytes: 8 * GIB, count: 10 },
    },
    dupes: [{ wasted: 5 * GIB }],
    tree: [{ p: 'C:\\Games', s: 300 * GIB }],
  });

  assert.equal(out.state, 'low');
  assert.equal(out.safeBytes, 12 * GIB);
  assert.equal(out.reviewBytes, 20 * GIB);
  assert.equal(out.permanentBytes, 8 * GIB);
  assert.equal(out.duplicateBytes, 5 * GIB);
  assert.equal(out.opportunityBytes, 45 * GIB);
  assert.equal(out.recommendations.some((r) => r.type === 'large_folder'), true);
  assert.equal(out.recommendations.find((r) => r.category === 'recycleBin').risk, 'permanent');
});

test('disk intelligence does not invent cleanable space', () => {
  const out = DiskIntelligence.analyze({
    total: 1000,
    volume: { capacity: 2000, free: 1000 },
    categories: { unknownThing: { bytes: 900, count: 1 } },
    dupes: [],
  });

  assert.equal(out.safeBytes, 0);
  assert.equal(out.reviewBytes, 0);
  assert.equal(out.permanentBytes, 0);
  assert.deepEqual(out.categories, []);
});
