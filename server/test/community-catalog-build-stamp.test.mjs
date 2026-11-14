// The Store's disk copy of the catalog remembers which Xenon build wrote it. A
// copy written by 4.11.13 had lost `sparks` (that build's normalizer did not know
// it), and after the update to 5.0.0 the site answered 304 to its etag, so the app
// kept showing Sparks drops (Culprit) as supporter drops and the hub refused the
// pass. A copy from another build is now only a fallback: no etag, and the first
// read awaits a full fetch.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const cat = require('../community-catalog.js');

const ENTRY = { id: 'drop', kind: 'theme', name: 'Drop', code: 'abc', locked: true };
const LIVE = JSON.stringify({ entries: [{ ...ENTRY, sparks: 300 }] });

// The site: 304 to a matching etag, the full file otherwise.
function site() {
  const fn = async (_url, validators) => {
    fn.etags.push(validators && validators.etag || '');
    if (validators && validators.etag === 'W/"live"') return { notModified: true };
    return { notModified: false, text: LIVE, etag: 'W/"live"' };
  };
  fn.etags = [];
  return fn;
}

let dir;
const writeCache = (extra) => fs.writeFileSync(path.join(dir, 'community-catalog-cache.json'), JSON.stringify({
  entries: [ENTRY], fetchedAt: Date.now(), etag: 'W/"live"', ...extra,
}));
const readCache = () => JSON.parse(fs.readFileSync(path.join(dir, 'community-catalog-cache.json'), 'utf8'));
const settle = () => new Promise((r) => setTimeout(r, 50));
// The refetched copy is saved after fetchCatalog resolves, and a busy machine can take longer than
// one pause (a CI runner did): ask again until the saved copy says what is waited for.
async function savedCopy(ready) {
  for (let tries = 0; tries < 100; tries += 1) {
    try { const copy = readCache(); if (ready(copy)) return copy; } catch { /* being written */ }
    await settle();
  }
  return readCache();
}

beforeEach(() => { cat._resetCache(); cat._setFetcher(null); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xcat-')); });
// The refetched copy is saved after fetchCatalog resolves: let that write land
// before the folder goes, or Windows refuses to remove it under a loaded run.
afterEach(async () => {
  await settle();
  cat._resetCache();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

test('a copy written by an older build is refetched in full before it is served', async () => {
  writeCache({});                       // 4.11.13 wrote no appVersion
  const f = site();
  cat._setFetcher(f);
  cat.initCache({ dataDir: dir, appVersion: '5.1.0' });
  const out = await cat.fetchCatalog();
  assert.deepEqual(f.etags, [''], 'no If-None-Match: a 304 would keep the old copy');
  assert.equal(out.entries[0].sparks, 300, 'the Sparks price is back on the first read');
  const copy = await savedCopy((saved) => saved.appVersion === '5.1.0');
  assert.equal(copy.appVersion, '5.1.0', 'the new copy is stamped with this build');
});

test('a copy from another stamped build is treated the same way', async () => {
  writeCache({ appVersion: '5.0.0' });
  const f = site();
  cat._setFetcher(f);
  cat.initCache({ dataDir: dir, appVersion: '5.1.0' });
  const out = await cat.fetchCatalog();
  assert.deepEqual(f.etags, ['']);
  assert.equal(out.entries[0].sparks, 300);
});

test('a copy from this build is served at once, as before', async () => {
  writeCache({ appVersion: '5.1.0', entries: [{ ...ENTRY, sparks: 300 }] });
  const f = site();
  cat._setFetcher(f);
  cat.initCache({ dataDir: dir, appVersion: '5.1.0' });
  const out = await cat.fetchCatalog();
  assert.equal(out.cached, true);
  assert.deepEqual(f.etags, [], 'fresh copy of this build: no network');
});

test('offline right after an update, the old copy still opens the Store', async () => {
  writeCache({});
  cat._setFetcher(async () => { throw new Error('offline'); });
  cat.initCache({ dataDir: dir, appVersion: '5.1.0' });
  const out = await cat.fetchCatalog();
  assert.equal(out.ok, true);
  assert.equal(out.stale, true);
  assert.deepEqual(out.entries.map((e) => e.id), ['drop']);
});

test('the server passes its version to the cache', () => {
  const src = engineSource();
  assert.match(src, /communityCatalog\.initCache\(\{ dataDir: DATA_DIR, appVersion: APP_VERSION \}\)/);
});
