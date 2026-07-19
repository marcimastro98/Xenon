import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ca = require('../claude-attach.js');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-attach-'));
  let n = 0;
  const store = ca.createAttachments({ dir, now: () => 1700000000000, rand: () => 'r' + (++n) });
  return { dir, store };
}

test('a file lands under a server-built name, never the client\'s', async () => {
  const { dir, store } = makeStore();
  const out = await store.save('../../etc/passwd.png', Buffer.from([1, 2, 3]));
  assert.equal(out.ok, true);
  assert.equal(path.dirname(out.path), dir);
  assert.equal(path.basename(out.path), 'attach-1700000000000-r1.png');
  // The original survives only as a label, and with no separators in it.
  assert.equal(out.name.includes('/'), false);
  assert.equal(out.name.includes('\\'), false);
  assert.equal(fs.readFileSync(out.path).length, 3);
});

test('extensions are an allowlist', async () => {
  const { store } = makeStore();
  for (const bad of ['run.exe', 'x.ps1', 'x.bat', 'noextension', 'x.dll']) {
    assert.equal((await store.save(bad, Buffer.from([1]))).error, 'bad_type', bad);
  }
  for (const good of ['shot.png', 'notes.md', 'data.json', 'paper.pdf']) {
    assert.equal((await store.save(good, Buffer.from([1]))).ok, true, good);
  }
});

test('empty and oversized payloads are refused', async () => {
  const { store } = makeStore();
  assert.equal((await store.save('a.png', Buffer.alloc(0))).error, 'empty');
  assert.equal((await store.save('a.png', Buffer.alloc(ca.MAX_BYTES + 1))).error, 'too_big');
});

test('the label is stripped of control characters and bounded', async () => {
  const { store } = makeStore();
  const noisy = 'a' + String.fromCharCode(0, 27, 10) + 'b.png';
  const out = await store.save(noisy, Buffer.from([1]));
  assert.equal(out.name, 'ab.png');
  const long = 'x'.repeat(500) + '.png';
  assert.ok((await store.save(long, Buffer.from([1]))).name.length <= 80);
});

test('pruning keeps the directory from growing without bound', async () => {
  const { dir, store } = makeStore();
  for (let i = 0; i < 45; i++) await store.save('f.png', Buffer.from([i]));
  await store.prune();
  assert.ok(fs.readdirSync(dir).length <= 40);
});
