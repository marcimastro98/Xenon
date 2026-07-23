import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const ratings = require('../community-ratings.js');
const { HUB_BASE } = require('../supporter-redeem.js');

// Transport stub: records every outbound call, answers from a script.
let calls;
let responder;
beforeEach(() => {
  calls = [];
  responder = () => ({ ok: true, minDisplayCount: 3, ratings: { 'neon-theme': { avg: 4.5, count: 7 } } });
  ratings._setTransport(async (url, opts) => { calls.push({ url, opts }); return responder(url, opts); });
  ratings._resetCache();
});

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-ratings-'));
}

test('cleanIds validates, dedupes and caps the id list', () => {
  assert.deepEqual(ratings.cleanIds('neon-theme, neon-theme, BAD ID,../up,stingers'), ['neon-theme', 'stingers']);
  assert.equal(ratings.cleanIds(Array.from({ length: 300 }, (_, i) => 'id-' + i).join(',')).length, 100);
});

test('fetchRatings validates ids before any network and caches the aggregate read', async () => {
  const dir = tmpDataDir();
  const empty = await ratings.fetchRatings({ ids: 'NOT VALID,also bad', dataDir: dir });
  assert.deepEqual(empty, { ok: true, ratings: {} });
  assert.equal(calls.length, 0, 'no outbound call for junk ids');

  const a = await ratings.fetchRatings({ ids: 'neon-theme', dataDir: dir });
  assert.equal(a.ok, true);
  assert.equal(a.ratings['neon-theme'].avg, 4.5);
  const b = await ratings.fetchRatings({ ids: 'neon-theme', dataDir: dir });
  assert.equal(b.ok, true);
  assert.equal(calls.length, 1, 'second read served from the TTL cache');
  assert.ok(calls[0].url.startsWith(HUB_BASE + '/ratings?ids='), 'fixed hub base');
  assert.ok(!calls[0].url.includes('installId='), 'anonymous read carries no install id');
});

test('mine=1 attaches the ratings-scoped id server-side and skips the shared cache', async () => {
  const dir = tmpDataDir();
  await ratings.fetchRatings({ ids: 'neon-theme', mine: true, dataDir: dir });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  const scopedId = url.searchParams.get('scopedId');
  assert.match(scopedId, /^[0-9a-f]{64}$/, 'a hashed, ratings-scoped id rides along');
  assert.equal(url.searchParams.get('installId'), null, 'the raw install id never leaves this machine');
  // The same id must persist across calls (it identifies THIS install's votes).
  await ratings.fetchRatings({ ids: 'neon-theme', mine: true, dataDir: dir });
  assert.equal(new URL(calls[1].url).searchParams.get('scopedId'), scopedId);
});

test('submitRating validates shape locally and invalidates cached sets containing the entry', async () => {
  const dir = tmpDataDir();
  for (const bad of [
    { entryId: 'BAD ID', stars: 5 }, { entryId: 'neon-theme', stars: 0 },
    { entryId: 'neon-theme', stars: 6 }, { entryId: 'neon-theme', stars: 3.5 },
  ]) {
    const out = await ratings.submitRating({ ...bad, dataDir: dir });
    assert.equal(out.error, 'bad_request', JSON.stringify(bad));
  }
  assert.equal(calls.length, 0, 'invalid votes never reach the network');

  await ratings.fetchRatings({ ids: 'neon-theme', dataDir: dir }); // warm the cache
  responder = () => ({ ok: true });
  const out = await ratings.submitRating({ entryId: 'neon-theme', stars: 5, dataDir: dir });
  assert.equal(out.ok, true);
  const post = calls[calls.length - 1];
  assert.equal(post.opts.method, 'POST');
  assert.equal(post.opts.body.entryId, 'neon-theme');
  assert.equal(post.opts.body.stars, 5);
  assert.match(post.opts.body.scopedId, /^[0-9a-f]{64}$/);
  assert.equal(post.opts.body.installId, undefined, 'the raw install id is never posted');

  // The warmed cache was invalidated → next read goes out again.
  responder = () => ({ ok: true, minDisplayCount: 3, ratings: { 'neon-theme': { avg: 5, count: 8 } } });
  const fresh = await ratings.fetchRatings({ ids: 'neon-theme', dataDir: dir });
  assert.equal(fresh.ratings['neon-theme'].count, 8, 'post-vote read reflects the new aggregate');
});

test('hub errors pass through the known set; junk maps to network', async () => {
  const dir = tmpDataDir();
  responder = () => ({ ok: false, error: 'rate_limited' });
  assert.equal((await ratings.submitRating({ entryId: 'neon-theme', stars: 4, dataDir: dir })).error, 'rate_limited');
  responder = () => ({ ok: false, error: 'weird_internal_thing' });
  assert.equal((await ratings.submitRating({ entryId: 'neon-theme', stars: 4, dataDir: dir })).error, 'network');
});
