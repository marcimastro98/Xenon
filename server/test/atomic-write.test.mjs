import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';

// Tests for the shared durable-store write primitive: atomic replace,
// serialized concurrent writers, temp-file cleanup, and the read-modify-write
// path that fixed the OAuth token-store lost-update race.
const require = createRequire(import.meta.url);
const { writeFileAtomic, updateFileAtomic, openAtomicWriteStream } = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'atomic-write.js'));

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'xenon-atomic-'));
}

test('writeFileAtomic writes the content and leaves no temp file', async () => {
  const dir = freshDir();
  try {
    const file = join(dir, 'store.json');
    await writeFileAtomic(file, '{"a":1}');
    assert.equal(readFileSync(file, 'utf8'), '{"a":1}');
    assert.deepEqual(readdirSync(dir), ['store.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeFileAtomic replaces an existing file', async () => {
  const dir = freshDir();
  try {
    const file = join(dir, 'store.json');
    writeFileSync(file, 'old');
    await writeFileAtomic(file, 'new');
    assert.equal(readFileSync(file, 'utf8'), 'new');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writeFileAtomic accepts Buffers (binary uploads)', async () => {
  const dir = freshDir();
  try {
    const file = join(dir, 'bg.png');
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await writeFileAtomic(file, buf);
    assert.deepEqual(readFileSync(file), buf);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent writers to the same path serialize — last write wins, file always whole', async () => {
  const dir = freshDir();
  try {
    const file = join(dir, 'store.json');
    const writes = [];
    for (let i = 0; i < 20; i++) writes.push(writeFileAtomic(file, JSON.stringify({ i })));
    await Promise.all(writes);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { i: 19 });
    assert.deepEqual(readdirSync(dir), ['store.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed write does not break the chain for the next writer', async () => {
  const dir = freshDir();
  try {
    const missing = join(dir, 'no-such-subdir', 'store.json');
    await assert.rejects(() => writeFileAtomic(missing, 'x'));
    const file = join(dir, 'store.json');
    await writeFileAtomic(file, 'ok');
    assert.equal(readFileSync(file, 'utf8'), 'ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('updateFileAtomic passes null for a missing file and writes the result', async () => {
  const dir = freshDir();
  try {
    const file = join(dir, 'tokens.json');
    await updateFileAtomic(file, (raw) => {
      assert.equal(raw, null);
      return '{"twitch":{"a":1}}';
    });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { twitch: { a: 1 } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('updateFileAtomic returning null leaves the file untouched', async () => {
  const dir = freshDir();
  try {
    const file = join(dir, 'tokens.json');
    writeFileSync(file, 'keep');
    await updateFileAtomic(file, () => null);
    assert.equal(readFileSync(file, 'utf8'), 'keep');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a transient Windows lock on the rename (EPERM) is retried, not lost', async () => {
  // Reproduces the "settings never persist" bug: another process (AV scan, the
  // Search indexer, a concurrent reader of the same store) briefly held the
  // destination open, so the temp→file rename threw EPERM on Windows. The old
  // single-attempt rename failed the whole write; it must now retry and land.
  const dir = freshDir();
  const realRename = fs.promises.rename;
  try {
    const file = join(dir, 'store.json');
    let calls = 0;
    fs.promises.rename = async (from, to) => {
      calls += 1;
      if (calls <= 2) { const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; }
      return realRename(from, to);
    };
    await writeFileAtomic(file, '{"saved":true}');
    assert.equal(calls, 3, 'should have retried the rename past the transient locks');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { saved: true });
    assert.deepEqual(readdirSync(dir), ['store.json'], 'no temp file left behind');
  } finally {
    fs.promises.rename = realRename;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-lock rename error is NOT retried and surfaces immediately', async () => {
  const dir = freshDir();
  const realRename = fs.promises.rename;
  try {
    const file = join(dir, 'store.json');
    let calls = 0;
    fs.promises.rename = async () => { calls += 1; const e = new Error('ENOSPC: no space left'); e.code = 'ENOSPC'; throw e; };
    await assert.rejects(() => writeFileAtomic(file, 'x'), /ENOSPC/);
    assert.equal(calls, 1, 'a genuine error must fail fast, not spin the retry loop');
    assert.deepEqual(readdirSync(dir), [], 'temp file cleaned up on failure');
  } finally {
    fs.promises.rename = realRename;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent read-modify-write updates never lose each other (token-store race)', async () => {
  const dir = freshDir();
  try {
    const file = join(dir, 'tokens.json');
    writeFileSync(file, '{}');
    // Two "providers" patching their own key at the same moment: with the old
    // read-then-write-outside-the-lock shape the second clobbered the first.
    const patch = (key) => updateFileAtomic(file, (raw) => {
      const all = JSON.parse(raw || '{}');
      all[key] = { refreshToken: `rt-${key}` };
      return JSON.stringify(all);
    });
    await Promise.all([patch('twitch'), patch('spotify'), patch('youtube'), patch('discord')]);
    const all = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(all).sort(), ['discord', 'spotify', 'twitch', 'youtube']);
    for (const k of Object.keys(all)) assert.equal(all[k].refreshToken, `rt-${k}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── openAtomicWriteStream ────────────────────────────────────────────────────
// The streaming twin, added for the file-transfer upload: a 2 GB video cannot
// be held in memory, but it still needs the guarantee the buffer version gives.
// The failure it prevents is a half-received file that looks complete — the
// list shows it, the phone offers it for download, and it is truncated.

test('a streamed write is invisible until it is committed', async () => {
  const dir = freshDir();
  const dest = join(dir, 'video.bin');
  const handle = await openAtomicWriteStream(dest);

  handle.stream.write(Buffer.alloc(1024, 7));

  assert.equal(fs.existsSync(dest), false,
    'a partly written file must not exist under its real name — anything listing the '
    + 'directory would offer a truncated file as a finished one');
  assert.ok(readdirSync(dir).some((n) => n.endsWith('.part')),
    'the temp must be recognisable as an in-flight upload without knowing which process wrote it');

  await new Promise((r) => handle.stream.end(r));
  await handle.commit();

  assert.equal(readFileSync(dest).length, 1024);
  assert.deepEqual(readdirSync(dir), ['video.bin'], 'the .part must be gone after a commit');
  rmSync(dir, { recursive: true, force: true });
});

test('an aborted stream leaves neither the file nor its temp behind', async () => {
  const dir = freshDir();
  const dest = join(dir, 'dropped.bin');
  const handle = await openAtomicWriteStream(dest);
  handle.stream.write(Buffer.alloc(512, 3));

  await handle.abort();

  assert.equal(fs.existsSync(dest), false);
  assert.deepEqual(readdirSync(dir), [],
    'a phone that slept mid-upload must not leave half a video occupying disk');
  rmSync(dir, { recursive: true, force: true });
});

test('commit and abort are each once, and never both', async () => {
  const dir = freshDir();
  const dest = join(dir, 'once.bin');
  const handle = await openAtomicWriteStream(dest);
  await new Promise((r) => handle.stream.end(Buffer.from('done'), r));
  await handle.commit();
  // The upload route aborts on every failure path, including one that can fire
  // after a successful commit (a broadcast throwing). That must not delete the
  // file that was just committed.
  await handle.abort();
  assert.equal(readFileSync(dest, 'utf8'), 'done',
    'an abort after a successful commit deleted the committed file');
  rmSync(dir, { recursive: true, force: true });
});

test('two streamed writes to different names do not serialize behind each other', async () => {
  // Deliberately NOT on the per-path chain: a 2 GB upload holding the queue
  // would stall settings, notes and deck saves for the whole transfer.
  const dir = freshDir();
  const a = await openAtomicWriteStream(join(dir, 'a.bin'));
  const b = await openAtomicWriteStream(join(dir, 'b.bin'));
  await new Promise((r) => a.stream.end(Buffer.from('aaa'), r));
  await new Promise((r) => b.stream.end(Buffer.from('bbb'), r));
  await Promise.all([a.commit(), b.commit()]);
  assert.equal(readFileSync(join(dir, 'a.bin'), 'utf8'), 'aaa');
  assert.equal(readFileSync(join(dir, 'b.bin'), 'utf8'), 'bbb');
  rmSync(dir, { recursive: true, force: true });
});
