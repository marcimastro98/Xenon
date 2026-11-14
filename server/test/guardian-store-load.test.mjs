// The sensor history's store is read from disk once. Two callers that ask for it before the first
// read has settled must get the one store, and a backup restored while the file is being read
// must not be replaced by what the file held before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createGuardian } = require('../guardian.js');

const HOUR = { h: '2026-11-07T12', m: {} };

function guardianIn(dir) {
  return createGuardian({ dataDir: dir, isEnabled: () => true, onAlert: () => {}, getSystemInfo: async () => ({}) });
}

test('two callers before the first read settles get the same store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-load-'));
  try {
    writeFileSync(join(dir, 'guardian.json'), JSON.stringify({ hours: [HOUR], days: [], apps: [], recent: [] }));
    const guardian = guardianIn(dir);
    const [first, second] = await Promise.all([guardian.exportStore(), guardian.exportStore()]);
    assert.deepEqual(first.hours, [HOUR]);
    assert.equal(first, second, 'the second caller built a store of its own, which replaced the first');
    assert.equal(await guardian.exportStore(), first, 'a later caller gets it too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that cannot be read gives both callers the same empty store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-load-'));
  try {
    const guardian = guardianIn(dir);
    const [first, second] = await Promise.all([guardian.exportStore(), guardian.exportStore()]);
    assert.deepEqual(first, { hours: [], days: [], apps: [], recent: [] });
    assert.equal(first, second);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a backup restored while the file is being read is the store that stays', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-load-'));
  const file = join(dir, 'guardian.json');
  try {
    writeFileSync(file, JSON.stringify({ hours: [], days: [], apps: [], recent: [] }));
    const guardian = guardianIn(dir);
    const reading = guardian.exportStore();
    const restored = await guardian.importStore({ hours: [HOUR] });
    await reading;
    assert.deepEqual(restored, { ok: true, hours: 1, days: 0 });
    assert.deepEqual((await guardian.exportStore()).hours, [HOUR], 'the read that was in flight put the old file back in memory');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).hours, [HOUR]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
