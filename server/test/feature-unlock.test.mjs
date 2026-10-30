import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

// ── Trials ──────────────────────────────────────────────────────────────────

const seedLocalTrial = (dir, startedAt) =>
  writeFileSync(path.join(dir, 'feature-unlocks.json'), JSON.stringify({ unlocked: {}, trials: { lyrics: startedAt } }));
const passTrial = (state, endsAt = 9e12) => ({ status: async () => ({ ok: true, state, used: state !== 'none', endsAt }) });

test('no new local Lyrics trial starts; one already running is honored to its end', async () => {
  const fresh = createFeatureUnlock({ dataDir: tmp(), redeem: async () => assert.fail() });
  assert.equal((await fresh.status('lyrics')).trialAvailable, false);
  assert.deepEqual(await fresh.startTrial('lyrics'), { ok: false, error: 'bad_request' });

  const dir = tmp();
  let clock = 1_000_000;
  seedLocalTrial(dir, clock);
  const fu = createFeatureUnlock({ dataDir: dir, now: () => clock, redeem: async () => assert.fail() });
  clock += 6 * 86400000;
  assert.equal(await fu.isUnlocked('lyrics'), true);
  assert.equal((await fu.status('lyrics')).trialEndsAt, 1_000_000 + 7 * 86400000);
  clock += 2 * 86400000;
  assert.equal(await fu.isUnlocked('lyrics'), false);
});

test('moving the clock back ends a local trial instead of stretching it', async () => {
  const dir = tmp();
  const clock = 5_000_000_000;
  seedLocalTrial(dir, clock + 86400000);
  const fu = createFeatureUnlock({ dataDir: dir, now: () => clock, redeem: async () => assert.fail() });
  assert.equal(await fu.isUnlocked('lyrics'), false);
});

test('the pass trial opens Lyrics while the hub says it runs, never Dev cleanup', async () => {
  const on = createFeatureUnlock({ dataDir: tmp(), trialPass: passTrial('active', 123), redeem: async () => assert.fail() });
  assert.deepEqual(await on.status('lyrics'), {
    unlocked: true, owned: false, trialEndsAt: 123, trialAvailable: false, passTrial: true, passTrialAvailable: false, trialEnded: false,
  });
  assert.equal(await on.isUnlocked('devclean'), false);
  for (const state of ['unverified', 'ended', 'none']) {
    const off = createFeatureUnlock({ dataDir: tmp(), trialPass: passTrial(state), redeem: async () => assert.fail() });
    assert.equal(await off.isUnlocked('lyrics'), false, state);
  }
});

test('the tile offers the pass trial only to an install that never had it, and says when one is over', async () => {
  const st = async (state) => createFeatureUnlock({ dataDir: tmp(), trialPass: passTrial(state), redeem: async () => assert.fail() }).status('lyrics');
  assert.equal((await st('none')).passTrialAvailable, true);
  assert.equal((await st('none')).trialEnded, false);
  assert.equal((await st('ended')).passTrialAvailable, false);
  assert.equal((await st('ended')).trialEnded, true);
  assert.equal((await st('unverified')).trialEnded, false, 'paused, not over');

  const dir = tmp();
  seedLocalTrial(dir, 1_000_000);
  const old = createFeatureUnlock({ dataDir: dir, now: () => 1_000_000 + 8 * 86400000, redeem: async () => assert.fail() });
  assert.equal((await old.status('lyrics')).trialEnded, true, 'the old local week counts too');
});

test('a trial code typed into the Lyrics unlock opens it for the trial, without owning it', async () => {
  const dir = tmp();
  const fu = createFeatureUnlock({ dataDir: dir, redeem: async () => ({ ok: true, cek: 'k', trialEndsAt: 777 }) });
  assert.deepEqual(await fu.unlock('lyrics', 'XT-AAAA-BBBB-CCCC'), { ok: true, unlocked: true, passTrial: true, trialEndsAt: 777 });
  assert.equal((await fu.status('lyrics')).owned, false);
});

test('two unlocks landing together never lose each other, and buying makes it owned', async () => {
  const dir = tmp();
  const fu = createFeatureUnlock({ dataDir: dir, redeem: async () => ({ ok: true, saved: true }) });
  await Promise.all([fu.unlock('lyrics'), fu.unlock('devclean')]);
  const onDisk = JSON.parse(readFileSync(path.join(dir, 'feature-unlocks.json'), 'utf8'));
  assert.ok(Number.isFinite(onDisk.unlocked.lyrics));
  assert.ok(Number.isFinite(onDisk.unlocked.devclean));
  const s = await fu.status('lyrics');
  assert.equal(s.owned, true);
  assert.equal(s.trialEndsAt, null);
});
