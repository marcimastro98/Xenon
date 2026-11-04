// tools/page-meta: one patch sets a page's search title and description in all
// seven site languages, inside the limits a results page shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMeta, setHead, indentOf, LIMITS } from '../../tools/page-meta.mjs';

const LANGS = ['en', 'it', 'es', 'fr', 'ja', 'ko', 'zh'];
const all = (title, desc) => Object.fromEntries(LANGS.map((l) => [l, { title, desc }]));

test('a complete patch inside the limits passes', () => {
  assert.deepEqual(validateMeta('deck.html', all('Xenon Deck', 'Touch macro keys.')), []);
});

test('a missing language, a long title and an em-dash are reported', () => {
  const m = all('Xenon Deck', 'Touch macro keys.');
  delete m.ko;
  m.en.title = 'x'.repeat(LIMITS.title + 1);
  m.it.desc = 'Tasti macro — gratis';
  const errors = validateMeta('deck.html', m).join('\n');
  assert.match(errors, /ko: missing title/);
  assert.match(errors, /en: title 61 > 60/);
  assert.match(errors, /it: em-dash/);
});

test('CJK languages get the shorter limits, counted by characters', () => {
  const m = all('Xenon Deck', 'Touch macro keys.');
  m.ja.title = 'あ'.repeat(LIMITS.cjkTitle + 1);
  m.zh.desc = '字'.repeat(LIMITS.cjkDesc);
  const errors = validateMeta('deck.html', m);
  assert.deepEqual(errors, [`deck.html ja: title ${LIMITS.cjkTitle + 1} > ${LIMITS.cjkTitle}`]);
});

test('setHead rewrites every title tag and adds the twitter pair when missing', () => {
  const head = [
    '<title>Old</title>',
    '<meta name="description" content="old">',
    '<meta property="og:title" content="Old">',
    '<meta property="og:description" content="old">',
    '<meta name="twitter:card" content="summary_large_image">',
  ].join('\n');
  const out = setHead(head, { title: 'New & "fast"', desc: 'A <b> desc' });
  assert.match(out, /<title>New &amp; "fast"<\/title>/);
  assert.match(out, /<meta name="description" content="A &lt;b&gt; desc">/);
  assert.match(out, /<meta property="og:title" content="New &amp; &quot;fast&quot;">/);
  assert.match(out, /<meta name="twitter:title" content="New &amp; &quot;fast&quot;">/);
  assert.match(out, /<meta name="twitter:description" content="A &lt;b&gt; desc">/);
  // Run twice: the pair is replaced, never added a second time.
  const again = setHead(out, { title: 'T', desc: 'D' });
  assert.equal(again.match(/twitter:title/g).length, 1);
});

test('setHead refuses a page without a title or description', () => {
  assert.throws(() => setHead('<meta name="description" content="x">', { title: 'T', desc: 'D' }), /no <title>/);
  assert.throws(() => setHead('<title>x</title>', { title: 'T', desc: 'D' }), /no meta description/);
});

test('a dictionary keeps its own indentation', () => {
  assert.equal(indentOf('{\n "en": {}\n}\n'), ' ');
  assert.equal(indentOf('{\r\n  "en": {}\r\n}\r\n'), '  ');
  assert.equal(indentOf('{}'), 2);
});
