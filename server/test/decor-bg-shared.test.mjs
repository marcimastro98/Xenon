// js/decor-bg.js: the Deck well background (image and/or gradient) drew nothing in
// the Virtual Deck popup and on a light layer page, because deck.js called
// tileGradCss/paintDecorBgLayer from dashboard-layout.js, which those pages never
// load (ReferenceError, empty Deck). Pinned here: every page that loads deck.js
// loads decor-bg.js first, and the helpers live in one place.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

test('every page with deck.js loads decor-bg.js before it', () => {
  for (const page of ['index.html', 'deck-popup.html']) {
    const html = read(page);
    const deck = html.indexOf('<script src="js/deck.js">');
    const bg = html.indexOf('<script src="js/decor-bg.js">');
    assert.ok(deck > 0, `${page} loads deck.js`);
    assert.ok(bg > 0 && bg < deck, `${page} loads decor-bg.js before deck.js`);
  }
  const { TILES } = require('../js/layer-tiles.js');
  const js = TILES.deck.js;
  assert.ok(js.indexOf('js/decor-bg.js') >= 0 && js.indexOf('js/decor-bg.js') < js.indexOf('js/deck.js'), 'light page Deck row');
});

test('the helpers are defined once, in decor-bg.js', () => {
  assert.doesNotMatch(read('js/dashboard-layout.js'), /function (tileGradCss|paintDecorBgLayer)\(/);
  assert.doesNotMatch(read('js/deck.js'), /function paintDecorBgLayer\(/);
});

test('gradient over image, fit honoured', () => {
  const ctx = { cssUrl: (src) => (src ? `url("${src}")` : '') };
  vm.createContext(ctx);
  vm.runInContext(read('js/decor-bg.js'), ctx);
  assert.equal(ctx.tileGradCss({ c1: '#000', c2: '#fff' }), 'linear-gradient(135deg, #000, #fff)');
  assert.equal(ctx.tileGradCss({ c1: '#000' }), '');
  const node = { style: {} };
  ctx.paintDecorBgLayer(node, 'linear-gradient(1deg, #000, #fff)', '/uploads/a.png', 'tile');
  assert.deepEqual({ ...node.style }, {
    backgroundImage: 'linear-gradient(1deg, #000, #fff), url("/uploads/a.png")',
    backgroundRepeat: 'no-repeat, repeat', backgroundSize: 'cover, auto', backgroundPosition: 'center',
  });
  const only = { style: {} };
  ctx.paintDecorBgLayer(only, '', '/uploads/a.png', 'contain');
  assert.deepEqual([only.style.backgroundRepeat, only.style.backgroundSize], ['no-repeat', 'contain']);
});
