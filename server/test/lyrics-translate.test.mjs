// Lyrics translation: prompt, reply validation, spending guard and cache.
// Fixture lines are invented, never real song text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const T = require('../lyrics-translate.js');
const { createLyricsTranslator, cleanCap, FAIL_TTL_MS } = require('../lyrics-translator.js');
const { createLyricsOffsets, cleanOffset } = require('../lyrics-offsets.js');
const P = require('../lyrics-translate-price.js');

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

test('"same" comes from the language the model names, not from its yes/no', () => {
  assert.equal(T.parseReply('{"src":"it","tr":[]}', 3, false, 'it').same, true);
  assert.equal(T.parseReply('{"src":"en","tr":["a","b","c"]}', 3, false, 'it').same, false);
  // English lyrics with a wrong legacy "same":true still get translated.
  assert.equal(T.parseReply('{"src":"en","same":true,"tr":["a"]}', 1, false, 'it').same, false);
  assert.equal(T.parseReply('{"src":"en","tr":[]}', 3, false, 'it'), null);
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

// An English song, asked for an Italian dashboard. A small model has been seen
// answering "src":"it" for one, and that answer was kept for good.
const EN_SONG = [
  'I walk alone down the road to my house', "I don't know where I'm going but I'm fine",
  'The moon is high and the wind is talking', "I've looked for you in every town that I saw",
  'But you were not there, you were gone', 'A window is lit in the middle of the fog',
  'When you come back tell me what happened', 'I stay here and I make no sound',
  'All that I have is an old guitar', 'And I sing for us, for those who are gone',
];
const ASK_EN = { songKey: 'nova|glass|201', texts: EN_SONG, lang: 'it', reading: false, cap: 200 };
const EN_OK = { text: JSON.stringify({ src: 'en', tr: EN_SONG.map((_, i) => 'tr' + i) }), tokens: 200 };

test('a model that calls a surely English song Italian is not believed', async () => {
  const p = fakeProvider([{ text: '{"src":"it","tr":[]}', tokens: 50 }]);
  const t = createLyricsTranslator({ complete: p.complete });
  const out = await t.translate(ASK_EN);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'failed');
  assert.equal((await t.translate(ASK_EN)).error, 'failed', 'and the wrong answer is not kept as "same"');
});

test("the prompt names the language of a song that is surely not the user's", async () => {
  const p = fakeProvider([EN_OK]);
  const t = createLyricsTranslator({ complete: p.complete });
  const out = await t.translate(ASK_EN);
  assert.equal(out.ok, true);
  assert.equal(out.same, false);
  assert.match(p.calls[0].system, /These lyrics are sung in English/);
  const plainSong = fakeProvider([OK(2)]);
  await createLyricsTranslator({ complete: plainSong.complete }).translate(ASK);
  assert.doesNotMatch(plainSong.calls[0].system, /These lyrics are sung in/, 'no hint when the language is not certain');
});

test('a stored "already in your language" for a surely English song is not served', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-lyrics-stale-'));
  fs.writeFileSync(path.join(dir, 'lyrics-translations.json'),
    JSON.stringify({ entries: [[`${ASK_EN.songKey}|it|`, { same: true, tr: [], read: [] }]] }));
  const p = fakeProvider([EN_OK]);
  const t = createLyricsTranslator({ dataDir: dir, complete: p.complete });
  assert.equal((await t.translate({ ...ASK_EN, cachedOnly: true })).error, 'not_cached');
  const out = await t.translate(ASK_EN);
  assert.equal(out.same, false);
  assert.equal(out.tr.length, EN_SONG.length);
  assert.equal(p.calls.length, 1);
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

test('the cost estimate prices the model, from a typical song until songs are measured', async () => {
  const p = fakeProvider([{ ...OK(2), tokens: 3000, input: 1000, output: 2000 }]);
  const t = createLyricsTranslator({ complete: p.complete });
  const before = await t.usage(200, 'claude-haiku-5-5');
  assert.equal(before.estimate.measured, false);
  assert.equal(before.estimate.songs, 100);
  await t.translate(ASK);
  const after = await t.usage(200, 'claude-haiku-5-5');
  assert.equal(after.model, 'claude-haiku-5-5');
  assert.equal(after.estimate.measured, true);
  // 100 × (1000 × $0.10 + 2000 × $0.50) / 1M
  assert.equal(after.estimate.usd, 0.11);
  assert.equal((await t.usage(200, 'some-unknown-model')).estimate, null, 'never a guessed price');
  assert.equal((await t.usage(200, '')).estimate, null, 'Ollama: no model, no price');
});

test('priceFor takes the longest matching prefix', () => {
  assert.equal(P.priceFor('gpt-5-mini-2026-08-07').prefix, 'gpt-5-mini');
  assert.equal(P.priceFor('gemini-3.5-flash-lite').input, 0.30);
  assert.equal(P.priceFor('gpt-5'), null);
  assert.equal(P.priceFor('haiku'), null, 'a plan alias has no price');
});

test('the price table published on the site parses and matches the built-in one', () => {
  const file = fileURLToPath(new URL('../../docs/community/ai-prices.json', import.meta.url));
  const published = P.normalizeTable(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.ok(published, 'docs/community/ai-prices.json is a usable table');
  assert.ok(published.checked >= P.BUILT_IN.checked, 'the site is never older than the app');
  for (const b of P.BUILT_IN.models) assert.deepEqual(P.priceFor(b.prefix, published.models), { ...b });
});

test('a newer published table wins, a broken or older one is ignored', async () => {
  const serve = (body) => P._setFetcher(async () => ({ text: JSON.stringify(body) }));
  try {
    P._reset();
    serve({ checked: '2099-01-01', currency: 'USD', models: [{ prefix: 'claude-haiku-5-5', input: 1, output: 1 }, { prefix: 'Bad Prefix!', input: 1, output: 1 }] });
    await P.refresh();
    assert.equal(P.priceFor('claude-haiku-5-5').input, 1);
    assert.equal(P.priceFor('gemini-3.5-flash-lite'), null, 'the newer table replaces the old one whole');
    assert.equal(P.estimate('claude-haiku-5-5').checked, '2099-01-01');

    P._reset();
    serve({ checked: '2000-01-01', currency: 'USD', models: [{ prefix: 'claude-haiku-5-5', input: 9, output: 9 }] });
    await P.refresh();
    assert.equal(P.priceFor('claude-haiku-5-5').input, 0.10, 'older than the built-in: ignored');

    P._reset();
    P._setFetcher(async () => ({ text: '<html>' }));
    await P.refresh();
    assert.equal(P.priceFor('claude-haiku-5-5').input, 0.10, 'unreadable: the built-in stays');
    assert.equal(P.normalizeTable({ checked: '2099-01-01', currency: 'EUR', models: [{ prefix: 'x1', input: 1, output: 1 }] }), null);
    assert.equal(P.normalizeTable({ checked: '2099-01-01', currency: 'USD', models: [{ prefix: 'x1', input: -1, output: 1e9 }] }), null);
  } finally {
    P._setFetcher(null);
    P._reset();
  }
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

// A song surely in the user's language never reaches the provider.
const ITALIAN = [
  'Cammino da solo sulla strada di casa', 'Non so dove vado ma sono contento',
  'La luna è alta e il vento mi parla', 'Ti ho cercato in ogni città che ho visto',
  'Ma tu non c\'eri più, non c\'eri già', 'Una finestra accesa dentro la nebbia',
  'Quando torni dimmi che cosa è successo', 'Io resto qui senza fare rumore',
];

test('a song surely in the user\'s language costs nothing, even with the cap spent or cachedOnly', async () => {
  const p = fakeProvider([]);
  const t = createLyricsTranslator({ complete: p.complete });
  const ask = { songKey: 'nova|casa|200', texts: ITALIAN, lang: 'it', reading: true };
  assert.deepEqual(plain(await t.translate({ ...ask, cap: 200, cachedOnly: true })), { ok: true, same: true, tr: [], read: [] });
  assert.deepEqual(plain(await t.translate({ ...ask, cap: 50 })), { ok: true, same: true, tr: [], read: [] });
  assert.equal(p.calls.length, 0);
  assert.equal((await t.usage(200)).songs, 0);
});

test('the same song for another language still goes to the provider', async () => {
  const p = fakeProvider([{ text: JSON.stringify({ src: 'it', tr: ITALIAN.map((_, i) => 'tr' + i) }), tokens: 90 }]);
  const t = createLyricsTranslator({ complete: p.complete });
  const out = await t.translate({ songKey: 'nova|casa|200', texts: ITALIAN, lang: 'en', reading: true, cap: 200 });
  assert.equal(out.ok, true);
  assert.equal(out.same, false);
  assert.equal(p.calls.length, 1);
});

test('a Japanese song for a Japanese user still gets its reading from the provider', async () => {
  const lines = ITALIAN.map((_, i) => (i === 0 ? '東京の夜はまだ明るい' : ITALIAN[i]));
  const p = fakeProvider([{ text: JSON.stringify({ src: 'ja', tr: [], read: lines.map(() => 'x') }), tokens: 90 }]);
  const t = createLyricsTranslator({ complete: p.complete });
  await t.translate({ songKey: 'nova|mix|200', texts: lines, lang: 'ja', reading: true, cap: 200 });
  assert.equal(p.calls.length, 1);
});

test('an empty Sparks balance is not a failed song: nothing counted, asked again later', async () => {
  const empty = Object.assign(new Error('Xenon credits: no_credits'), { code: 'no_credits' });
  const p = fakeProvider([empty, OK(2)]);
  const t = createLyricsTranslator({ complete: p.complete });
  assert.deepEqual(plain(await t.translate(ASK)), { ok: false, error: 'no_credits' });
  assert.equal((await t.usage(200)).songs, 0);
  // With Sparks again the same song is translated at once, not after the failure wait.
  assert.equal((await t.translate(ASK)).ok, true);
  assert.equal(p.calls.length, 2);
});
