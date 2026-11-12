// tools/page-strings: one patch sets a page's text in all seven site languages,
// in the English page itself and in the JSON-LD that repeats it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStrings, setPageString } from '../../tools/page-strings.mjs';

const LANGS = ['it', 'es', 'fr', 'ja', 'ko', 'zh'];
const all = (v) => Object.fromEntries(['en', ...LANGS].map((l) => [l, v]));

test('a complete patch passes', () => {
  assert.deepEqual(validateStrings('faq.html', { 'f.a.temp': all('Press <strong>Install sensors</strong>.') }, LANGS), []);
});

test('a missing language, an em-dash, changed markup and a title key are reported', () => {
  const s = all('Press <strong>Install</strong>.');
  delete s.ko;
  s.it = 'Premi Installa — subito';
  const errors = validateStrings('faq.html', { 'f.a.temp': s, 'meta.title': all('x') }, LANGS).join('\n');
  assert.match(errors, /f\.a\.temp ko: missing/);
  assert.match(errors, /f\.a\.temp it: em-dash/);
  assert.match(errors, /f\.a\.temp it: markup differs from en/);
  assert.match(errors, /meta\.title: titles go through tools\/page-meta\.mjs/);
});

test('a text key is escaped, an html key keeps its markup, every copy of the key changes', () => {
  const html = '<p data-i18n="a">old</p><td data-i18n="a">old</td><div data-i18n-html="b"><p>old <a href="/x">link</a></p></div>';
  let out = setPageString(html, 'a', 'Fans & watts <now>');
  out = setPageString(out, 'b', '<p>new <a href="/y">link</a></p>');
  assert.equal(out, '<p data-i18n="a">Fans &amp; watts &lt;now&gt;</p><td data-i18n="a">Fans &amp; watts &lt;now&gt;</td><div data-i18n-html="b"><p>new <a href="/y">link</a></p></div>');
});

test('an ld. key swaps its old English inside the JSON-LD, quotes included', () => {
  const html = '<script type="application/ld+json">{"text":"Press \\"Enable\\" now."}</script>';
  const out = setPageString(html, 'ld.a2', 'Press "Install" once.', 'Press "Enable" now.');
  assert.equal(out, '<script type="application/ld+json">{"text":"Press \\"Install\\" once."}</script>');
});

test('a key the page does not carry fails instead of writing nothing', () => {
  assert.throws(() => setPageString('<p data-i18n="a">x</p>', 'b', 'y'), /b: no element carries it/);
  assert.throws(() => setPageString('<p>x</p>', 'ld.q1', 'y', 'not there'), /old English is not in the JSON-LD/);
});
