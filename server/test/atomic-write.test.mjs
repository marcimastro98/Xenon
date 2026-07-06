import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Tests for the shared durable-store write primitive: atomic replace,
// serialized concurrent writers, temp-file cleanup, and the read-modify-write
// path that fixed the OAuth token-store lost-update race.
const require = createRequire(import.meta.url);
const { writeFileAtomic, updateFileAtomic } = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'atomic-write.js'));

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
