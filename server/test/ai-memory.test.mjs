import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Pure-logic tests for the persistent AI memory store — no network, isolated
// temp data dir per test. Covers add/dedup/cap, remove (id / key / substring),
// clear, prompt formatting, and durable reload from disk.
const require = createRequire(import.meta.url);
const { createAiMemory, normalizeText, dedupKey } = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'ai-memory.js'));

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'xenon-mem-'));
}

// A monotonic clock so ts values are deterministic and ordered.
function clock(start = 1000) {
  let t = start;
  return () => (t += 1);
}

test('normalizeText collapses whitespace and caps length', () => {
  assert.equal(normalizeText('  hello   world  '), 'hello world');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText('x'.repeat(500)).length, 240);
});

test('dedupKey ignores case and punctuation', () => {
  assert.equal(dedupKey('I have an RTX 4090'), dedupKey('i have an  rtx-4090!'));
});

test('add stores a fact and returns it', async () => {
  const dir = freshDir();
  try {
    const mem = createAiMemory({ dataDir: dir, now: clock() });
    const r = await mem.add('The user is Marcello');
    assert.equal(r.ok, true);
    assert.equal(r.text, 'The user is Marcello');
    assert.equal(mem.count(), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('add dedups by loose key and refreshes to the end', async () => {
  const dir = freshDir();
  try {
    const mem = createAiMemory({ dataDir: dir, now: clock() });
    await mem.add('The user has an RTX 4090');
    await mem.add('The user supports Napoli');
    const dup = await mem.add('the user has an  rtx-4090!');
    assert.equal(dup.ok, true);
    assert.equal(dup.duplicate, true);
    assert.equal(mem.count(), 2); // not re-stored
    // refreshed fact moved to the end
    const list = mem.list();
    assert.equal(list[list.length - 1].text, 'The user has an RTX 4090');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('add empties are rejected', async () => {
  const dir = freshDir();
  try {
    const mem = createAiMemory({ dataDir: dir, now: clock() });
    const r = await mem.add('   ');
    assert.equal(r.ok, false);
    assert.equal(mem.count(), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('remove works by id, by loose key and by substring', async () => {
  const dir = freshDir();
  try {
    const mem = createAiMemory({ dataDir: dir, now: clock() });
    const a = await mem.add('The user is Marcello');
    await mem.add('The user has an RTX 4090');
    await mem.add('The user supports Napoli');
    // by id
    assert.equal((await mem.remove(a.id)).ok, true);
    assert.equal(mem.count(), 2);
    // by substring
    const bySub = await mem.remove('RTX');
    assert.equal(bySub.ok, true);
    assert.match(bySub.removed, /RTX 4090/);
    assert.equal(mem.count(), 1);
    // not found
    assert.equal((await mem.remove('nonexistent')).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('clear empties the store', async () => {
  const dir = freshDir();
  try {
    const mem = createAiMemory({ dataDir: dir, now: clock() });
    await mem.add('a fact');
    await mem.add('another fact');
    assert.equal((await mem.clear()).ok, true);
    assert.equal(mem.count(), 0);
    assert.equal(mem.formatForPrompt(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('formatForPrompt is empty with no facts and lists facts otherwise', async () => {
  const dir = freshDir();
  try {
    const mem = createAiMemory({ dataDir: dir, now: clock() });
    assert.equal(mem.formatForPrompt(), '');
    await mem.add('The user is Marcello');
    const p = mem.formatForPrompt();
    assert.match(p, /PERSISTENT MEMORY/);
    assert.match(p, /- The user is Marcello/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('facts persist to disk and reload in a new instance', async () => {
  const dir = freshDir();
  try {
    const mem1 = createAiMemory({ dataDir: dir, now: clock() });
    await mem1.add('The user is Marcello');
    await mem1.add('The user has an RTX 4090');
    // new instance, same dir → loads from disk
    const mem2 = createAiMemory({ dataDir: dir, now: clock() });
    const list = mem2.list();
    assert.equal(list.length, 2);
    assert.deepEqual(list.map(f => f.text), ['The user is Marcello', 'The user has an RTX 4090']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the store is capped at MAX_FACTS, dropping the oldest', async () => {
  const dir = freshDir();
  try {
    const mem = createAiMemory({ dataDir: dir, now: clock() });
    for (let i = 0; i < 110; i++) await mem.add(`fact number ${i}`);
    assert.equal(mem.count(), 100);
    const list = mem.list();
    // oldest ten dropped → first remaining is "fact number 10"
    assert.equal(list[0].text, 'fact number 10');
    assert.equal(list[list.length - 1].text, 'fact number 109');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('importFacts (backup restore) replaces the store with normalized facts', async () => {
  const dir = freshDir();
  try {
    const mem = createAiMemory({ dataDir: dir, now: clock() });
    await mem.add('An old fact to be replaced');
    const r = await mem.importFacts([
      { id: 'f1', text: '  The user is   Marcello ', ts: 5 },
      { text: 'The user has an RTX 4090', ts: 6 },
      { text: '', ts: 7 },              // empty → dropped
      'plain string fact',              // legacy shape → normalized
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.count, 3);
    const list = mem.list();
    assert.deepEqual(list.map(f => f.text),
      ['The user is Marcello', 'The user has an RTX 4090', 'plain string fact']);
    // Survives a reload from disk in a fresh instance.
    const mem2 = createAiMemory({ dataDir: dir, now: clock() });
    assert.equal(mem2.count(), 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('importFacts rejects junk shapes gracefully (empty store, never throws)', async () => {
  const dir = freshDir();
  try {
    const mem = createAiMemory({ dataDir: dir, now: clock() });
    await mem.add('keep me? no — import replaces');
    const r = await mem.importFacts({ nope: true });
    assert.equal(r.ok, true);
    assert.equal(r.count, 0);
    assert.equal(mem.count(), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
