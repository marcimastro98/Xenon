// Lyrics translation: prompt, reply validation, spending guard and cache.
// Fixture lines are invented, never real song text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const T = require('../lyrics-translate.js');
const { createLyricsTranslator, cleanCap, FAIL_TTL_MS } = require('../lyrics-translator.js');
const { createLyricsOffsets, cleanOffset } = require('../lyrics-offsets.js');

const plain = (v) => JSON.parse(JSON.stringify(v));
const SONG = ['paper boats at noon', '', 'paper boats at noon', 'the kettle hums a tune'];

test('uniqueLines sends a repeated line once and maps pauses to -1', () => {
  const { unique, index } = T.uniqueLines(SONG);
  assert.deepEqual(plain(unique), ['paper boats at noon', 'the kettle hums a tune']);
  assert.deepEqual(plain(index), [0, -1, 0, 1]);
});

test('needsReading spots kana, hangul and han, not Latin', () => {
  assert.equal(T.needsReading(['plain words']), false);
  assert.equal(T.needsReading(['ひかり']), true);
  assert.equal(T.needsReading(['바다']), true);
  assert.equal(T.needsReading(['月亮']), true);
});

test('buildPrompt names the target and asks for reading only when wanted', () => {
  const a = T.buildPrompt(['x'], 'it', false);
  assert.match(a.system, /Italian/);
  assert.doesNotMatch(a.system, /"read"/);
  assert.deepEqual(JSON.parse(a.user), ['x']);
  assert.match(T.buildPrompt(['x'], 'ja', true).system, /"read"/);
});

test('parseReply accepts a fenced object with the right lengths', () => {
  const out = T.parseReply('```json\n{"same":false,"tr":["uno","due"]}\n```', 2, false);
  assert.deepEqual(plain(out), { same: false, tr: ['uno', 'due'], read: [] });
});

test('parseReply refuses wrong lengths, broken JSON and missing reading', () => {
  assert.equal(T.parseReply('{"same":false,"tr":["uno"]}', 2, false), null);
  assert.equal(T.parseReply('{"same":false,"tr":["uno","due"', 2, false), null);
  assert.equal(T.parseReply('{"same":false,"tr":["a","b"]}', 2, true), null);
  assert.equal(T.parseReply('no json here', 2, false), null);
});

test('parseReply cleans control characters and caps the length', () => {
  const long = 'x'.repeat(T.MAX_OUT_CHARS + 50);
  const out = T.parseReply(JSON.stringify({ same: false, tr: ['a\u0007b', long] }), 2, false);
  assert.equal(out.tr[0], 'a b');
  assert.equal(out.tr[1].length, T.MAX_OUT_CHARS);
});

test('"same" needs no translation list', () => {
  assert.deepEqual(plain(T.parseReply('{"same":true,"tr":[]}', 3, false)), { same: true, tr: [], read: [] });
});

test('expand puts answers back on every line, nothing under pauses', () => {
  assert.deepEqual(plain(T.expand([0, -1, 0, 1], ['A', 'B'])), ['A', '', 'A', 'B']);
  assert.deepEqual(plain(T.expand([0, 1], [])), []);
});

test('fitsBudget refuses empty and oversized songs', () => {
  assert.equal(T.fitsBudget([]), false);
  assert.equal(T.fitsBudget(['a']), true);
  assert.equal(T.fitsBudget(['x'.repeat(T.MAX_INPUT_CHARS + 1)]), false);
});

function fakeProvider(replies) {
  const calls = [];
  const complete = async (req) => {
    calls.push(req);
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, complete };
}

const OK = (n) => ({ text: JSON.stringify({ same: false, tr: Array.from({ length: n }, (_, i) => 'tr' + i) }), tokens: 120 });
const ASK = { songKey: 'nova|glass|200', texts: SONG, lang: 'it', reading: true, cap: 200 };

test('a song is paid once: the second ask is served from the cache', async () => {
  const p = fakeProvider([OK(2)]);
  const t = createLyricsTranslator({ complete: p.complete });
  const first = await t.translate(ASK);
  assert.equal(first.ok, true);
  assert.deepEqual(plain(first.tr), ['tr0', '', 'tr0', 'tr1']);
  const again = await t.translate(ASK);
  assert.equal(again.ok, true);
  assert.equal(p.calls.length, 1);
  const u = await t.usage(200);
  assert.equal(u.songs, 1);
  assert.equal(u.tokens, 120);
});

test('two screens asking at once make one request', async () => {
  const p = fakeProvider([OK(2)]);
  const t = createLyricsTranslator({ complete: p.complete });
  await Promise.all([t.translate(ASK), t.translate(ASK)]);
  assert.equal(p.calls.length, 1);
});

test('cachedOnly never spends', async () => {
  const p = fakeProvider([]);
  const t = createLyricsTranslator({ complete: p.complete });
  assert.deepEqual(plain(await t.translate({ ...ASK, cachedOnly: true })), { ok: false, error: 'not_cached' });
  assert.equal(p.calls.length, 0);
});

test('the monthly cap stops new songs, and a new month resets it', async () => {
  let now = new Date(2026, 9, 15).getTime();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-lyrics-cap-'));
  fs.writeFileSync(path.join(dir, 'lyrics-translate-usage.json'), JSON.stringify({ month: '2026-10', songs: 50, tokens: 9000 }));
  const p = fakeProvider([OK(2)]);
  const t = createLyricsTranslator({ dataDir: dir, complete: p.complete, now: () => now });
  assert.deepEqual(plain(await t.translate({ ...ASK, cap: 50 })), { ok: false, error: 'cap' });
  assert.equal(p.calls.length, 0);
  // An unknown cap means the default (200), never "unlimited".
  assert.equal((await t.translate({ ...ASK, cap: 1e9 })).ok, true);
  assert.equal((await t.usage(1e9)).cap, 200);
  now = new Date(2026, 10, 2).getTime();
  const u = await t.usage(50);
  assert.equal(u.month, '2026-11');
  assert.equal(u.songs, 0);
});

test('a reply that does not fit is remembered as failed for a while', async () => {
  let now = 1_000_000;
  const p = fakeProvider([{ text: 'nonsense', tokens: 40 }, OK(2)]);
  const t = createLyricsTranslator({ complete: p.complete, now: () => now });
  const bad = await t.translate(ASK);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'failed');
  assert.equal((await t.translate(ASK)).error, 'failed', 'no second request inside the window');
  assert.equal(p.calls.length, 1);
  assert.equal((await t.usage(200)).songs, 1, 'a billed request counts even when unusable');
  now += FAIL_TTL_MS;
  assert.equal((await t.translate(ASK)).ok, true);
  assert.equal(p.calls.length, 2);
});

test('a provider that throws before answering costs nothing', async () => {
  const p = fakeProvider([new Error('offline')]);
  const t = createLyricsTranslator({ complete: p.complete });
  assert.equal((await t.translate(ASK)).ok, false);
  assert.equal((await t.usage(200)).songs, 0);
});

test('an unknown language is refused before any request', async () => {
  const p = fakeProvider([]);
  const t = createLyricsTranslator({ complete: p.complete });
  assert.equal((await t.translate({ ...ASK, lang: 'xx' })).error, 'bad_lang');
  assert.equal(p.calls.length, 0);
});

test('translations and the month counter survive a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-lyrics-tr-'));
  const p = fakeProvider([OK(2)]);
  const t = createLyricsTranslator({ dataDir: dir, complete: p.complete, debounceMs: 60_000 });
  await t.translate(ASK);
  await t.flush();
  t.stop();
  const again = createLyricsTranslator({ dataDir: dir, complete: p.complete });
  assert.equal((await again.translate(ASK)).ok, true);
  assert.equal(p.calls.length, 1);
  assert.equal((await again.usage(200)).songs, 1);
});

test('cleanCap keeps the offered choices only', () => {
  assert.equal(cleanCap(50), 50);
  assert.equal(cleanCap('500'), 500);
  assert.equal(cleanCap(10_000), 200);
  assert.equal(cleanCap(undefined), 200);
});

test('per-song offsets: steps, limits, 0 clears, restart keeps them', async () => {
  assert.equal(cleanOffset(149), 100);
  assert.equal(cleanOffset(-9000), -3000);
  assert.equal(cleanOffset('x'), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-lyrics-off-'));
  const o = createLyricsOffsets({ dataDir: dir, debounceMs: 60_000 });
  assert.equal(await o.get('song'), null);
  assert.equal(await o.set('song', 420), 400);
  assert.equal(await o.get('song'), 400);
  await o.flush();
  o.stop();
  const again = createLyricsOffsets({ dataDir: dir });
  assert.equal(await again.get('song'), 400);
  assert.equal(await again.set('song', 0), 0);
  assert.equal(await again.get('song'), null);
});
