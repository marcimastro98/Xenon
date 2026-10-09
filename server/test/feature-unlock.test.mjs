import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { createFeatureUnlock } = require('../feature-unlock.js');

// Supporter-only features unlock through the hub's /redeem on a `feature-<id>`
// entry. The redeem is injected: no network.

const tmp = () => mkdtempSync(path.join(tmpdir(), 'xenon-feature-'));

test('locked until a redeem succeeds, then persisted across instances', async () => {
  const dir = tmp();
  const calls = [];
  const redeem = async (args) => { calls.push(args); return { ok: true, cek: 'k', saved: true }; };
  const fu = createFeatureUnlock({ dataDir: dir, redeem });
  assert.equal(await fu.isUnlocked('devclean'), false);
  const out = await fu.unlock('devclean');
  assert.deepEqual(out, { ok: true, unlocked: true, saved: true });
  assert.equal(calls[0].entryId, 'feature-devclean');
  assert.equal(calls[0].code, undefined, 'no code: the saved pass is used server-side');
  assert.equal(await fu.isUnlocked('devclean'), true);

  const again = createFeatureUnlock({ dataDir: dir, redeem: async () => assert.fail('must not call the hub') });
  assert.equal(await again.isUnlocked('devclean'), true);
  assert.deepEqual(await again.unlock('devclean'), { ok: true, unlocked: true });
  const onDisk = JSON.parse(readFileSync(path.join(dir, 'feature-unlocks.json'), 'utf8'));
  assert.ok(Number.isFinite(onDisk.unlocked.devclean));
});

test('a refused redeem stays locked and passes the hub error through', async () => {
  const dir = tmp();
  const fu = createFeatureUnlock({ dataDir: dir, redeem: async () => ({ ok: false, error: 'expired' }) });
  assert.deepEqual(await fu.unlock('devclean'), { ok: false, error: 'expired', forgot: false });
  assert.equal(await fu.isUnlocked('devclean'), false);
});

test('unknown features are never unlockable, and junk on disk is ignored', async () => {
  const dir = tmp();
  const fu = createFeatureUnlock({ dataDir: dir, redeem: async () => assert.fail('must not call the hub') });
  assert.deepEqual(await fu.unlock('anything'), { ok: false, error: 'bad_request' });
  assert.equal(await fu.isUnlocked('__proto__'), false);
});
