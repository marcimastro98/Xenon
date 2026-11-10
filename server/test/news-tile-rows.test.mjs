// A list longer than the tile used to squeeze its rows instead of scrolling: every headline
// on two lines lost the second one halfway through, leaving the tops of its letters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../components/NewsWidget/NewsWidget.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const rule = (selector) => css.slice(css.indexOf(`${selector} {`), css.indexOf('}', css.indexOf(`${selector} {`)));

test('a headline row keeps its height and the list scrolls', () => {
  assert.match(rule('.nw-item'), /flex: 0 0 auto;/);
  assert.match(rule('.nw-list'), /overflow: hidden auto;/);
});
