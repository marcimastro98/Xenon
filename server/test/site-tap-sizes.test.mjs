// Links people tap on the text pages are 44px tall rows, not 26px lines of
// text: the section links under a guide's title, a release's entries (the
// whole row opens it, without !important), and the two links on the share page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const rule = (css, selector) => {
  const at = css.indexOf(selector + ' {');
  assert.ok(at >= 0, `no rule ${selector}`);
  return css.slice(at, css.indexOf('}', at));
};

test('a guide\'s section links are 44px rows', () => {
  assert.match(rule(read('docs', 'guide.css'), '.jump a'), /min-height: 44px/);
});

test('a release entry opens from its whole row, with no !important', () => {
  for (const src of [read('tools', 'build-releases.mjs'), read('docs', 'releases.html')]) {
    assert.match(rule(src, '.rel-items summary'), /padding: 10px 0/);
    assert.doesNotMatch(src, /\.rel-one \{[^}]*!important/);
  }
});

test('the theme switch on every page is 44px and speaks every site language', () => {
  const js = read('docs', 'theme.js');
  assert.match(js, /\.xt-btn\{[^}]*min-height:44px/);
  assert.match(js, /\.xt-menu button\{[^}]*padding:12px 10px/);
  for (const l of ['en', 'it', 'es', 'fr', 'ja', 'ko', 'zh']) assert.match(js, new RegExp(`\\n    ${l}: \\{ label:`), l);
});

test('the share page\'s two links are 44px rows', () => {
  assert.match(rule(read('docs', 'get', 'index.html'), '.links a'), /min-height: 44px/);
});
