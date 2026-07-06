import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { splitSentences, MAX } = require('../tts-chunks.js');

// splitSentences powers the pipelined TTS: it breaks a reply into sentence-sized
// chunks so the server can speak the first sentence while it synths the rest.

test('splits a reply into sentences', () => {
  assert.deepEqual(
    splitSentences('Apro Spotify e alzo il volume. Poi metto la playlist. Fatto adesso.'),
    ['Apro Spotify e alzo il volume.', 'Poi metto la playlist.', 'Fatto adesso.'],
  );
});

test('folds a trivially short leading fragment into the next chunk', () => {
  // "Certo!" (6 chars) is below the fold threshold → merged forward.
  assert.deepEqual(
    splitSentences('Certo! Apro subito Spotify per te adesso.'),
    ['Certo! Apro subito Spotify per te adesso.'],
  );
});

test('keeps a lone short reply as its own chunk', () => {
  assert.deepEqual(splitSentences('Ok.'), ['Ok.']);
  assert.deepEqual(splitSentences('Fatto!'), ['Fatto!']);
});

test('handles question and exclamation marks and ellipsis', () => {
  // each sentence ≥24 chars so none is folded into another
  assert.deepEqual(
    splitSentences('Vuoi che continui a leggere il resto? Certo, allora procedo subito adesso! Ecco tutto quanto pronto…'),
    ['Vuoi che continui a leggere il resto?', 'Certo, allora procedo subito adesso!', 'Ecco tutto quanto pronto…'],
  );
});

test('splits CJK sentence terminators', () => {
  // sentences long enough (≥24 chars) that the short-fragment fold doesn't merge them
  const a = '今日はとても良い天気で外を散歩するのにぴったりの一日です。';
  const b = '明日はおそらく雨が降る予報なので傘を持って出かけましょう。';
  assert.deepEqual(splitSentences(a + b), [a, b]);
});

test('normalizes whitespace and newlines', () => {
  // first sentence is ≥24 chars so it isn't folded into the next
  assert.deepEqual(
    splitSentences('  Questa è la prima frase completa.\n\n   Seconda   frase   qui.  '),
    ['Questa è la prima frase completa.', 'Seconda frase qui.'],
  );
});

test('hard-splits an over-long run-on sentence within the cap', () => {
  const long = 'parola '.repeat(80).trim(); // ~560 chars, no punctuation
  const out = splitSentences(long);
  assert.ok(out.length > 1);
  for (const c of out) assert.ok(c.length <= MAX, `chunk length ${c.length} exceeds ${MAX}`);
  // recombining the words yields the original set (no words dropped)
  assert.equal(out.join(' ').split(/\s+/).length, 80);
});

test('empty / whitespace input yields no chunks', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   '), []);
  assert.deepEqual(splitSentences(null), []);
});
