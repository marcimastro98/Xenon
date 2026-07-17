import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const limited = require('../community-limited.js');
const { HUB_BASE } = require('../supporter-redeem.js');

let calls;
let responder;

beforeEach(() => {
  calls = [];
  responder = () => ({
    ok: true,
    drops: { signal: { total: 50, claimed: 7, left: 999, soldOut: true, numbered: true, channels: 'both', active: true } },
  });
  limited._setTransport(async (url) => { calls.push(url); return responder(url); });
  limited._resetCache();
});

test('cleanIds validates, deduplicates and caps ids', () => {
  assert.deepEqual(limited.cleanIds('signal,signal,BAD ID,../x,pow-50'), ['signal', 'pow-50']);
  assert.equal(limited.cleanIds(Array.from({ length: 150 }, (_, i) => 'drop-' + i).join(',')).length, 100);
});

test('fetchStatus uses the fixed hub, derives counters and short-caches reads', async () => {
  const first = await limited.fetchStatus('signal');
  assert.deepEqual(first.drops.signal, {
    total: 50, claimed: 7, left: 43, soldOut: false, numbered: true, channels: 'both', active: true,
  });
  await limited.fetchStatus('signal');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith(HUB_BASE + '/limited/status?ids='));
});

test('fetchStatus rejects malformed hub rows and degrades to network errors', async () => {
  responder = () => ({ ok: true, drops: { signal: { total: 0 }, injected: { total: 10 } } });
  assert.deepEqual((await limited.fetchStatus('signal')).drops, {});
  limited._resetCache();
  responder = () => ({ ok: false });
  assert.deepEqual(await limited.fetchStatus('signal'), { ok: false, error: 'network' });
});
