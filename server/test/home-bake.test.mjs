// tools/home-bake.mjs: dictionary strings written into the home markup (text, html, alt, aria-label).
import test from 'node:test';
import assert from 'node:assert/strict';
import { bake, readTables, syncEnglish } from '../../tools/home-bake.mjs';

const page = (en) => `<p data-i18n="a">old</p><div data-i18n-html="b"><b>old</b></div>
<img src="x.webp" alt="old" data-i18n-alt="c"><button aria-label="old" data-i18n-aria="d">x</button>
<script>
  I18N.en = {
    ${Object.entries(en).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v).replace(/<\//g, '<\\/')},`).join('\n    ')}
  };
</script>`;

test('bakes text escaped, html raw, alt and aria-label escaped', () => {
  const { out, baked } = bake(page({}), { a: 'A < B', b: '<i>B</i>', c: 'C "q"', d: 'D & E' });
  assert.equal(baked, 4);
  assert.ok(out.includes('<p data-i18n="a">A &lt; B</p>'));
  assert.ok(out.includes('<div data-i18n-html="b"><i>B</i></div>'));
  assert.ok(out.includes('alt="C &quot;q&quot;"'));
  assert.ok(out.includes('aria-label="D &amp; E"'));
});

test('falls back, and leaves keys with no value untouched', () => {
  const { out } = bake(page({}), { a: 'A' }, { b: 'B' });
  assert.ok(out.includes('>A</p>') && out.includes('>B</div>'));
  assert.ok(out.includes('alt="old"') && out.includes('aria-label="old"'));
});

test('readTables parses the dictionaries, escaped closing tags included', () => {
  assert.deepEqual(readTables(page({ a: '<a href="/x">y</a>' })).en, { a: '<a href="/x">y</a>' });
});

test('syncEnglish rewrites the markup from I18N.en and leaves the script alone', () => {
  const src = page({ a: 'New', b: '<b>New</b>', c: 'New alt', d: 'New aria' });
  const out = syncEnglish(src);
  assert.ok(out.includes('<p data-i18n="a">New</p>'));
  assert.ok(out.includes('alt="New alt"') && out.includes('aria-label="New aria"'));
  assert.equal(out.slice(out.indexOf('<script>')), src.slice(src.indexOf('<script>')));
  assert.equal(syncEnglish(out), out);
});
