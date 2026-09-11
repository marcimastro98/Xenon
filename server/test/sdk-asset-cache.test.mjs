import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ac = require('../sdk-asset-cache.js');

// A widget showing album art, game art or video thumbnails can only keep them
// today by base64-ing them into its store, where a value caps at 16 KB and the
// whole store at 256 KB. Nothing real fits. This is the disk cache that fixes
// that — and the reason it took a module rather than a route is the bound.
//
// The request that prompted it came with a working implementation whose author
// flagged its own hole: an index capped at 512 entries, and nothing deleting
// the FILES. An entry pushed out of the index leaves a file nothing can ever
// find again. With 96 packages allowed and a 1 MB response cap that is ~49 GB
// of tracked files plus an unbounded tail of invisible ones, on a user's disk.
//
// So these tests are mostly about deletion, not about caching.

const mkroot = () => mkdtempSync(join(tmpdir(), 'xenon-assets-'));
const img = (n) => Buffer.alloc(n, 1);

// ── The policy, pure ────────────────────────────────────────────────────────

test('planEviction drops what expired, whether or not anyone reads it', () => {
  const now = 1_000_000;
  const entries = {
    a: { status: 'positive', file: 'a'.repeat(64) + '.jpg', bytes: 10, expiresAt: now - 1, lastUsedAt: now },
    b: { status: 'positive', file: 'b'.repeat(64) + '.jpg', bytes: 10, expiresAt: now + 1000, lastUsedAt: now },
  };
  assert.deepEqual(ac.planEviction(entries, { now, maxBytes: 1e9 }), ['a']);
});

test('planEviction evicts least-recently-USED, not least-recently-written', () => {
  // A cover fetched once and shown daily must outlive one fetched yesterday and
  // never looked at again. That distinction is the whole reason a hit writes
  // lastUsedAt back to the index.
  const now = 1_000_000;
  const e = (used) => ({ status: 'positive', file: 'f'.repeat(64) + '.jpg', bytes: 100, expiresAt: now + 1e6, at: now, lastUsedAt: used });
  const entries = { old: e(1), fresh: e(999), middle: e(500) };
  assert.deepEqual(ac.planEviction(entries, { now, maxBytes: 250 }), ['old']);
  assert.deepEqual(ac.planEviction(entries, { now, maxBytes: 150 }).sort(), ['middle', 'old']);
});

test('planEviction refuses an entry whose filename is not one we write', () => {
  // The only file shape ever written is sha256 + a validated extension. Anything
  // else in the index is not ours, and is dropped rather than served or joined
  // onto a path.
  const now = 1_000_000;
  const bad = {
    trav: { status: 'positive', file: '../../etc/passwd', bytes: 1, expiresAt: now + 1e6 },
    abs: { status: 'positive', file: '/etc/passwd', bytes: 1, expiresAt: now + 1e6 },
    ext: { status: 'positive', file: 'a'.repeat(64) + '.exe', bytes: 1, expiresAt: now + 1e6 },
    short: { status: 'positive', file: 'abc.jpg', bytes: 1, expiresAt: now + 1e6 },
    junk: { status: 'positive', bytes: 1, expiresAt: now + 1e6 },
  };
  assert.deepEqual(ac.planEviction(bad, { now, maxBytes: 1e9 }).sort(), ['abs', 'ext', 'junk', 'short', 'trav']);
});

test('planGlobalEviction takes from whoever was looked at longest ago', () => {
  // A per-package cap alone lets ninety-six well-behaved widgets add up to the
  // problem one greedy widget was stopped from causing.
  const all = [
    { pkgId: 'idle', key: 'k1', bytes: 100, lastUsedAt: 1 },
    { pkgId: 'busy', key: 'k2', bytes: 100, lastUsedAt: 900 },
    { pkgId: 'busy', key: 'k3', bytes: 100, lastUsedAt: 800 },
  ];
  assert.deepEqual(ac.planGlobalEviction(all, 1000), [], 'under the cap, nothing moves');
  const dropped = ac.planGlobalEviction(all, 250);
  assert.deepEqual(dropped.map((d) => d.key), ['k1'], 'the widget nobody opens loses its art first');
});

test('extFor accepts only formats a browser renders, and reads the type we validated', () => {
  assert.equal(ac.extFor('image/jpeg'), 'jpg');
  assert.equal(ac.extFor('IMAGE/PNG; charset=binary'), 'png');
  assert.equal(ac.extFor('image/svg+xml'), null, 'SVG carries script — never stored as an image');
  assert.equal(ac.extFor('text/html'), null);
  assert.equal(ac.extFor(''), null);
});

test('the caps are sized for artwork that really exists, not for a guess', () => {
  // 32 MB was derived from album and game art at 20-30 KB. Artist covers turned
  // out to reach 200 KB, and a realistic mixed library — 500 albums plus 100
  // artists — comes to 31.7 MB: exactly the old ceiling, so a heavy user would
  // have lived permanently at the eviction boundary, re-downloading what they
  // had just been shown. Sized off the real numbers now, with headroom.
  const mixed = (500 * 25 + 100 * 200) * 1024;
  assert.ok(ac.MAX_BYTES_PER_PKG > mixed * 1.5,
    `a realistic library is ${(mixed / 1048576).toFixed(1)} MB and the cap is ${(ac.MAX_BYTES_PER_PKG / 1048576)} MB — too close to churn`);
  // And the total still protects the disk: one widget may claim a share of it,
  // never all of it.
  assert.ok(ac.MAX_BYTES_TOTAL >= ac.MAX_BYTES_PER_PKG * 4,
    'a single widget must not be able to claim most of the total');
});

// ── The disk side ───────────────────────────────────────────────────────────

test('a stored image comes back, and a second widget cannot see it', async () => {
  const root = mkroot();
  const store = ac.createAssetStore({ root });
  await store.put('widget-a', 'https://cdn.test/cover.jpg', 'image/jpeg', img(1024));

  const hit = await store.get('widget-a', 'https://cdn.test/cover.jpg');
  assert.ok(hit && hit.buffer.length === 1024);
  assert.equal(hit.contentType, 'image/jpeg');
  // Same url, different package: caches are per widget, so one cannot learn what
  // another fetched, nor be served a file it never had permission to request.
  assert.equal(await store.get('widget-b', 'https://cdn.test/cover.jpg'), null);
});

test('eviction deletes the FILE, not just the row that mentions it', async () => {
  // This is the defect the whole module exists for.
  const root = mkroot();
  const store = ac.createAssetStore({ root, maxBytesPerPkg: 2500 });
  for (let i = 0; i < 5; i++) await store.put('art', 'https://cdn.test/' + i + '.jpg', 'image/jpeg', img(1000));

  const files = readdirSync(join(root, 'art')).filter((f) => f !== 'index.json');
  assert.ok(files.length <= 3, `cap not enforced on disk: ${files.length} files left`);
  const bytes = files.length * 1000;
  assert.ok(bytes <= 2500, `${bytes} bytes on disk over a 2500 cap`);
});

test('an expired entry stops being served and stops taking space', async () => {
  const root = mkroot();
  let clock = 1_000_000;
  const store = ac.createAssetStore({ root, now: () => clock, positiveTtlMs: 1000 });
  await store.put('art', 'https://cdn.test/x.jpg', 'image/jpeg', img(512));
  assert.ok(await store.get('art', 'https://cdn.test/x.jpg'));

  clock += 5000;
  assert.equal(await store.get('art', 'https://cdn.test/x.jpg'), null, 'expired is not served');
  await store.sweep();
  assert.deepEqual(readdirSync(join(root, 'art')).filter((f) => f !== 'index.json'), [], 'nor kept');
});

test('the sweep deletes files no index knows about', async () => {
  // The tail the original design could never reach: a file left by an
  // interrupted write, or by an eviction that only touched metadata.
  const root = mkroot();
  const store = ac.createAssetStore({ root });
  await store.put('art', 'https://cdn.test/keep.jpg', 'image/jpeg', img(256));
  const orphan = join(root, 'art', 'c'.repeat(64) + '.jpg');
  writeFileSync(orphan, img(4096));
  assert.ok(existsSync(orphan));

  const out = await store.sweep();
  assert.ok(!existsSync(orphan), 'the orphan survived the sweep');
  assert.equal(out.files, 1);
  assert.equal(out.bytes, 4096);
  assert.ok(await store.get('art', 'https://cdn.test/keep.jpg'), 'and the live one was left alone');
});

test('the total cap is enforced across widgets, not only within one', async () => {
  const root = mkroot();
  let clock = 1_000_000;
  const store = ac.createAssetStore({ root, now: () => clock, maxBytesPerPkg: 1e9, maxBytesTotal: 2500 });
  for (const pkg of ['w1', 'w2', 'w3', 'w4']) {
    await store.put(pkg, 'https://cdn.test/' + pkg + '.jpg', 'image/jpeg', img(1000));
    clock += 10;
  }
  await store.sweep();
  let total = 0;
  for (const pkg of ['w1', 'w2', 'w3', 'w4']) {
    for (const f of readdirSync(join(root, pkg)).filter((x) => x !== 'index.json')) total += 1000;
  }
  assert.ok(total <= 2500, `${total} bytes across widgets over a 2500 total cap`);
  // The one used most recently is the one that survives.
  assert.ok(await store.get('w4', 'https://cdn.test/w4.jpg'));
});

test('the cache survives the process — which is the whole point over the tile LRU', async () => {
  // A radar frame is worthless tomorrow; an album cover is the same next week.
  // A SECOND store over the same directory is what a restart looks like from
  // here: nothing carried over in memory, everything read back off the disk.
  const root = mkroot();
  const before = ac.createAssetStore({ root });
  await before.put('art', 'https://cdn.test/cover.jpg', 'image/jpeg', img(2048));

  const after = ac.createAssetStore({ root });
  const hit = await after.get('art', 'https://cdn.test/cover.jpg');
  assert.ok(hit, 'nothing came back after the restart');
  assert.equal(hit.buffer.length, 2048);
  assert.equal(hit.contentType, 'image/jpeg');
});

test('an uninstalled widget takes its cache with it', async () => {
  const root = mkroot();
  const store = ac.createAssetStore({ root });
  await store.put('stays', 'https://cdn.test/a.jpg', 'image/jpeg', img(64));
  await store.put('goes', 'https://cdn.test/b.jpg', 'image/jpeg', img(64));
  assert.equal(await store.dropPackages(['stays']), 1);
  assert.ok(!existsSync(join(root, 'goes')), 'a removed widget must not leave art behind');
  assert.ok(await store.get('stays', 'https://cdn.test/a.jpg'));
});

test('a package id can never be spelled to escape its directory', async () => {
  const root = mkroot();
  const store = ac.createAssetStore({ root });
  for (const bad of ['../evil', 'a/../../b', '.', '..', '', 'A-Upper', 'x'.repeat(64), 'has space']) {
    assert.equal(await store.put(bad, 'https://cdn.test/x.jpg', 'image/jpeg', img(16)), false, bad);
    assert.equal(await store.get(bad, 'https://cdn.test/x.jpg'), null, bad);
  }
  assert.deepEqual(readdirSync(root), [], 'nothing was created outside a valid package directory');
});

test('a remembered failure expires quickly, and holds no file', async () => {
  const root = mkroot();
  let clock = 1_000_000;
  const store = ac.createAssetStore({ root, now: () => clock, negativeTtlMs: 1000 });
  await store.putNegative('art', 'https://cdn.test/missing.jpg', 404);
  const miss = await store.get('art', 'https://cdn.test/missing.jpg');
  assert.deepEqual(miss, { negative: true, status: 404 });
  assert.deepEqual(readdirSync(join(root, 'art')), ['index.json'], 'a failure is metadata, never a file');

  clock += 5000;
  assert.equal(await store.get('art', 'https://cdn.test/missing.jpg'), null, 'and it is retried before long');
});

test('a corrupt index is an empty cache, never a crash', async () => {
  const root = mkroot();
  mkdirSync(join(root, 'art'), { recursive: true });
  writeFileSync(join(root, 'art', 'index.json'), '{ not json');
  const store = ac.createAssetStore({ root });
  assert.equal(await store.get('art', 'https://cdn.test/x.jpg'), null);
  assert.equal(await store.put('art', 'https://cdn.test/x.jpg', 'image/jpeg', img(32)), true);
  assert.ok(await store.get('art', 'https://cdn.test/x.jpg'), 'and it recovers by rewriting it');
});

test('a missing file behind a live entry reads as a miss, not an error', async () => {
  const root = mkroot();
  const store = ac.createAssetStore({ root });
  await store.put('art', 'https://cdn.test/x.jpg', 'image/jpeg', img(32));
  for (const f of readdirSync(join(root, 'art'))) {
    if (f !== 'index.json') require('node:fs').unlinkSync(join(root, 'art', f));
  }
  assert.equal(await store.get('art', 'https://cdn.test/x.jpg'), null);
});
