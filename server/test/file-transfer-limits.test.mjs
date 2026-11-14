// The transfer store's caps after they are changed, and its list of uploads in flight.
//
// The caps are set once when the store is made and changed again when the settings change:
// `limits(next)` writes them, and `begin`, `prune`, `stats` and `inflightList` read them. These
// tests pin that what `limits` writes is what the others then read, which is the part of the
// store no other test reaches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const FT = require(join(HERE, '..', 'file-transfer.js'));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-xfer-limits-'));
}

function seqRand() {
  let n = 0;
  return () => (n++).toString(16).padStart(16, '0');
}

async function land(store, name, bytes) {
  const began = store.begin({ name, declaredLength: bytes.length });
  assert.ok(!began.error, `begin refused: ${began.error}`);
  fs.writeFileSync(began.target, bytes);
  return store.commit(began.id, bytes.length);
}

test('limits() with nothing to change answers the caps the store was made with', async () => {
  const store = FT.createFileTransfer({
    dir: tmpDir(), rand: seqRand(), maxBytes: 500, quotaBytes: 2000, keepMs: 9000, maxFiles: 7, maxInflight: 3,
  });
  await store.init();
  assert.deepEqual(store.limits(), { maxBytes: 500, quotaBytes: 2000, keepMs: 9000, maxFiles: 7, maxInflight: 3 });
  assert.deepEqual(store.limits({}), store.limits(), 'an empty change must change nothing');
});

test('a store made without caps takes the defaults the module exports', async () => {
  const store = FT.createFileTransfer({ dir: tmpDir(), rand: seqRand() });
  await store.init();
  const caps = store.limits();
  assert.equal(caps.maxBytes, FT.DEFAULT_MAX_BYTES);
  assert.equal(caps.quotaBytes, FT.DEFAULT_QUOTA_BYTES);
  assert.equal(caps.keepMs, 14 * 24 * 60 * 60 * 1000, 'fourteen days');
});

test('a cap that is zero, negative or not a number is not taken', async () => {
  const store = FT.createFileTransfer({ dir: tmpDir(), rand: seqRand(), maxBytes: 500, quotaBytes: 2000, keepMs: 9000 });
  await store.init();
  const before = store.limits();
  for (const bad of [0, -1, 'many', null, undefined, NaN]) {
    assert.deepEqual(store.limits({ maxBytes: bad, quotaBytes: bad, keepMs: bad }), before, `took ${String(bad)}`);
  }
});

test('the upload cap limits() writes is the one begin() then refuses by', async () => {
  const store = FT.createFileTransfer({ dir: tmpDir(), rand: seqRand(), maxBytes: 500, quotaBytes: 100000 });
  await store.init();
  assert.ok(!store.begin({ name: 'a.bin', declaredLength: 400 }).error);

  assert.equal(store.limits({ maxBytes: 300 }).maxBytes, 300);
  const refused = store.begin({ name: 'b.bin', declaredLength: 400 });
  assert.deepEqual(refused, { error: 'too_big', status: 413, max: 300 });
  const taken = store.begin({ name: 'c.bin', declaredLength: 300 });
  assert.equal(taken.limit, 300, 'the limit handed to the receiving stream must be the new cap');
  assert.equal(store.stats().maxBytes, 300);
});

test('the quota limits() writes is the one begin() then refuses by', async () => {
  const store = FT.createFileTransfer({ dir: tmpDir(), rand: seqRand(), maxBytes: 100, quotaBytes: 1000 });
  await store.init();
  await land(store, 'a.bin', Buffer.alloc(60));

  assert.equal(store.limits({ quotaBytes: 100 }).quotaBytes, 100);
  assert.equal(store.stats().quotaBytes, 100);
  const refused = store.begin({ name: 'b.bin', declaredLength: 60 });
  assert.deepEqual(refused, { error: 'quota', status: 507, max: 100 });
  assert.equal(store.list().length, 1, 'a smaller quota must refuse the next upload, never remove a file');

  store.limits({ quotaBytes: 1000 });
  assert.ok(!store.begin({ name: 'b.bin', declaredLength: 60 }).error);
});

test('the keeping time limits() writes is the one prune() then goes by', async () => {
  const inbox = tmpDir();
  let t = 1_700_000_000_000;
  const store = FT.createFileTransfer({ dir: tmpDir(), now: () => t, rand: seqRand(), keepMs: 1_000_000, quotaBytes: 1e9 });
  await store.init();
  const rec = await land(store, 'delivered.bin', Buffer.alloc(10));
  const copy = path.join(inbox, 'delivered.bin');
  fs.writeFileSync(copy, Buffer.alloc(10));
  await store.markDelivered(rec.id, copy);

  t += 5000;
  assert.deepEqual(await store.prune(), { removed: 0, bytes: 0 }, 'five seconds is inside the first keeping time');
  assert.equal(store.limits({ keepMs: 1000 }).keepMs, 1000);
  assert.deepEqual(await store.prune(), { removed: 1, bytes: 10 });
  assert.equal(store.get(rec.id), null);
  assert.equal(store.stats().bytes, 0, 'the bytes of the removed copy must come off the count');
  assert.ok(fs.existsSync(copy), 'the delivered copy is the user’s own file');
});

test('uploads in flight are listed with their size, or 0 when the size was never said', async () => {
  const store = FT.createFileTransfer({ dir: tmpDir(), rand: seqRand(), maxBytes: 500, quotaBytes: 100000 });
  await store.init();
  assert.deepEqual(store.inflightList(), []);

  const known = store.begin({ name: 'photo.jpg', declaredLength: 120, from: 'Phone' });
  const unknown = store.begin({ name: 'clip.mp4', direction: 'out', from: 'Desk' });
  assert.deepEqual(store.inflightList(), [
    { id: known.id, name: 'photo.jpg', direction: 'in', from: 'Phone', received: 0, total: 120, pending: true },
    { id: unknown.id, name: 'clip.mp4', direction: 'out', from: 'Desk', received: 0, total: 0, pending: true },
  ]);
  assert.equal(store.stats().reserved, 620, 'an upload of unknown size holds the whole upload cap');

  store.noteProgress(known.id, 64);
  assert.equal(store.inflightList()[0].received, 64);
});

test('abort() takes an upload off the list and gives its room back', async () => {
  const store = FT.createFileTransfer({ dir: tmpDir(), rand: seqRand(), maxBytes: 100, quotaBytes: 100 });
  await store.init();
  const first = store.begin({ name: 'a.bin', declaredLength: 100 });
  assert.equal(store.begin({ name: 'b.bin', declaredLength: 100 }).error, 'quota');

  store.abort(first.id);
  assert.deepEqual(store.inflightList(), []);
  assert.equal(store.stats().reserved, 0);
  assert.ok(!store.begin({ name: 'b.bin', declaredLength: 100 }).error, 'the aborted upload still held its room');
});
