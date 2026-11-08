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

test('forget drops the cached sets holding the entry, so the new average shows', async () => {
  const dir = tmpDataDir();
  await ratings.fetchRatings({ ids: 'neon-theme', dataDir: dir });
  ratings.forget('other-entry');
  await ratings.fetchRatings({ ids: 'neon-theme', dataDir: dir });
  assert.equal(calls.length, 1, 'another entry leaves the cache alone');
  ratings.forget('neon-theme');
  await ratings.fetchRatings({ ids: 'neon-theme', dataDir: dir });
  assert.equal(calls.length, 2, 'the next read goes out again');
});
