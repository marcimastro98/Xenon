// What stands between opening Xenon and its first frame. Seen 7 Nov 2026 on a new install: the
// stylesheet of the Retro and Comic fonts sat in <head>, so the screen stayed black until
// Google answered, and Bit's hello was fetched only when its turn came, so Bit vanished
// for half a second just before the first question.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const headOf = (page) => page.slice(0, page.indexOf('</head>'));
const PAGES = ['index.html', 'layer-lite.html'];

for (const name of PAGES) {
  test(`${name}: no remote stylesheet holds the first paint`, () => {
    const links = headOf(read(`../${name}`)).match(/<link\b[^>]*>/g) || [];
    const remote = links.filter((link) => /rel="stylesheet"/.test(link) && /href="https?:/.test(link));
    assert.deepEqual(remote, []);
  });

  test(`${name}: the fonts of the other looks still load, and hold nothing`, () => {
    assert.match(headOf(read(`../${name}`)), /<script src="js\/skin-fonts\.js" async><\/script>/);
  });
}

test('the fonts of Retro, Comic and the pet are all asked for', () => {
  const added = [];
  const document = {
    createElement: () => ({}),
    head: { append: (node) => added.push(node) },
  };
  vm.runInNewContext(read('../js/skin-fonts.js'), { document });
  assert.equal(added.length, 1);
  assert.equal(added[0].rel, 'stylesheet');
  const url = new URL(added[0].href);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'fonts.googleapis.com');
  assert.deepEqual(url.searchParams.getAll('family').map((family) => family.split(':')[0]),
    ['Press Start 2P', 'VT323', 'Bangers', 'Comic Neue']);
  assert.equal(url.searchParams.get('display'), 'swap');
});

test('Bit is on hand before its turn: both pictures of the splash load with the page', () => {
  const head = headOf(read('../index.html'));
  const css = read('../components/BootSplash/BootSplash.css');
  for (const file of ['bit-recharge.svg', 'bit-hello.svg']) {
    const href = `public/images/loader/${file}`;
    const link = (head.match(/<link\b[^>]*>/g) || []).find((tag) => tag.includes(`href="${href}"`));
    assert.ok(link, file);
    assert.match(link, /rel="preload"/);
    assert.match(link, /as="image"/);
    // Without motion the splash shows the still picture and neither of these.
    assert.match(link, /media="\(prefers-reduced-motion: no-preference\)"/);
    assert.ok(existsSync(new URL(`../${href}`, import.meta.url)), file);
    assert.ok(css.includes(`../../${href}`), 'the very file the splash asks for');
  }
  assert.ok(head.indexOf('bit-hello.svg') < head.indexOf('styles/global.css'), 'ahead of the stylesheets');
});
