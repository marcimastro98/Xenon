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

// ── The one-week Lyrics trial ───────────────────────────────────────────────

test('a trial unlocks Lyrics for a week, once per install, and survives a restart', async () => {
  const dir = tmp();
  let clock = 1_000_000;
  const now = () => clock;
  const fu = createFeatureUnlock({ dataDir: dir, now, redeem: async () => assert.fail('a trial never calls the hub') });
  assert.deepEqual(await fu.status('lyrics'), { unlocked: false, owned: false, trialEndsAt: null, trialAvailable: true });

  const out = await fu.startTrial('lyrics');
  assert.equal(out.ok, true);
  assert.equal(out.unlocked, true);
  assert.equal(out.trialEndsAt, 1_000_000 + 7 * 86400000);
  assert.equal(await fu.isUnlocked('lyrics'), true);

  // Reading it again after a restart, still inside the week.
  clock += 6 * 86400000;
  const later = createFeatureUnlock({ dataDir: dir, now, redeem: async () => assert.fail() });
  assert.equal(await later.isUnlocked('lyrics'), true);

  // The week is over: locked again, and it cannot be started a second time.
  clock += 2 * 86400000;
  assert.deepEqual(await later.status('lyrics'), { unlocked: false, owned: false, trialEndsAt: null, trialAvailable: false });
  assert.deepEqual(await later.startTrial('lyrics'), { ok: false, error: 'trial_used' });
});

test('moving the clock back ends a trial instead of stretching it', async () => {
  const dir = tmp();
  let clock = 5_000_000_000;
  const fu = createFeatureUnlock({ dataDir: dir, now: () => clock, redeem: async () => assert.fail() });
  await fu.startTrial('lyrics');
  clock -= 86400000;
  assert.equal(await fu.isUnlocked('lyrics'), false);
});

test('Dev cleanup has no trial, and unlocking keeps a trial already on disk', async () => {
  const dir = tmp();
  const fu = createFeatureUnlock({ dataDir: dir, redeem: async () => ({ ok: true, saved: true }) });
  assert.deepEqual(await fu.startTrial('devclean'), { ok: false, error: 'bad_request' });
  assert.equal((await fu.status('devclean')).trialAvailable, false);

  // Started together: neither write may lose the other.
  await Promise.all([fu.startTrial('lyrics'), fu.unlock('devclean')]);
  const onDisk = JSON.parse(readFileSync(path.join(dir, 'feature-unlocks.json'), 'utf8'));
  assert.ok(Number.isFinite(onDisk.trials.lyrics));
  assert.ok(Number.isFinite(onDisk.unlocked.devclean));

  // Buying Lyrics during the trial makes it owned, with no end date.
  await fu.unlock('lyrics');
  const s = await fu.status('lyrics');
  assert.equal(s.owned, true);
  assert.equal(s.trialEndsAt, null);
});
