// The site's cookie box, run for real against a small DOM: where it sits, and who holds the
// keyboard when the privacy page's key opens it again.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { makeDom } from './mini-dom.mjs';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const SOURCE = read('docs/consent.js');
const STORE_KEY = 'xenon.site.consent';

function site(choice) {
  const { document } = makeDom();
  document.readyState = 'complete';
  document.documentElement.lang = 'en';
  document.head = document.createElement('head');
  document.documentElement.appendChild(document.head);
  const store = new Map(choice ? [[STORE_KEY, choice]] : []);
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const box = {
    document,
    localStorage,
    location: { hash: '', search: '', pathname: '/privacy.html' },
    navigator: { language: 'en', languages: ['en'] },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
  };
  box.window = box;
  box.parent = box;
  vm.runInNewContext(SOURCE, box);
  const key = document.createElement('button');
  key.id = 'consent-reset';
  document.body.appendChild(key);
  return { document, window: box, store, key, cookieBox: () => document.getElementById('xc-consent') };
}

test('a first visit asks without taking the keyboard from anyone', () => {
  const { document, cookieBox } = site();
  assert.ok(cookieBox(), 'the box shows when nothing is stored');
  assert.notEqual(document.activeElement, cookieBox());
});

test('a stored choice shows nothing', () => {
  assert.equal(site('denied').cookieBox(), null);
});

test('the key on the privacy page takes the keyboard to the box', () => {
  const { document, window, key, store, cookieBox } = site('denied');
  key.focus();
  window.xenonConsentReset();
  assert.equal(store.has(STORE_KEY), false, 'the old choice is gone');
  assert.equal(document.activeElement, cookieBox());
  assert.equal(document.body.children[0], cookieBox(), 'first in the page, so Tab goes on to its keys');
});

test('pressed again with the box still open, the key finds it instead of doing nothing', () => {
  const { document, window, key, cookieBox } = site('denied');
  key.focus();
  window.xenonConsentReset();
  const open = cookieBox();
  key.focus();
  window.xenonConsentReset();
  assert.equal(cookieBox(), open, 'still one box');
  assert.equal(document.activeElement, open);
});

for (const [name, sel, stored] of [['Reject', '.xc-no', 'denied'], ['Accept', '.xc-yes', 'granted']]) {
  test(`after ${name} the keyboard is back on the key that asked`, () => {
    const { document, window, key, store, cookieBox } = site('granted');
    key.focus();
    window.xenonConsentReset();
    cookieBox().querySelector(sel).click();
    assert.equal(cookieBox(), null);
    assert.equal(store.get(STORE_KEY), stored);
    assert.equal(document.activeElement, key);
  });
}

test('a key that left the page in the meantime is not given the focus back', () => {
  const { document, window, key, cookieBox } = site('denied');
  key.focus();
  window.xenonConsentReset();
  key.remove();
  const open = cookieBox();
  open.querySelector('.xc-no').focus();
  const was = document.activeElement;
  open.querySelector('.xc-no').click();
  assert.equal(document.activeElement, was);
});

// Utz et al., CCS 2019: on one German shop the notice at the bottom left drew the most answers. The
// box is the only thing on these pages that was centred; everything else starts at the header's edge.
test('the box starts where the page starts, at every width', () => {
  const { document } = site();
  const css = document.getElementById('xc-consent-style').textContent;
  const header = read('docs/site.css');

  const wide = /\.xh \.xh-w \{ max-width: (\d+)px; margin: 0 auto; padding: 0 (\d+)px;/.exec(header);
  const narrow = /\.xh \.xh-w \{ height: \d+px; gap: \d+px; padding: 0 (\d+)px; \}/.exec(header);
  assert.ok(wide && narrow, 'the header no longer says where the page starts');
  const [, column, edge] = wide;
  const [, phoneEdge] = narrow;
  const breakpoint = [...header.slice(0, narrow.index).matchAll(/@media \(max-width: (\d+)px\)/g)].at(-1)[1];

  assert.match(css, new RegExp(`#xc-consent\\{position:fixed;left:${phoneEdge}px;right:${phoneEdge}px;`));
  const computers = new RegExp(`@media \\(min-width:${Number(breakpoint) + 1}px\\)\\{#xc-consent\\{([^}]*)\\}\\}`).exec(css);
  assert.ok(computers, 'no rule for computers at the header\'s own breakpoint');
  assert.match(computers[1], new RegExp(`left:${edge}px`));
  // A percentage, not 100vw: a page with a scrollbar is centred in what the bar leaves.
  assert.match(computers[1], new RegExp(`margin-left:max\\(0px,calc\\(50% - ${column / 2}px\\)\\)`));
  assert.doesNotMatch(css, /margin:0 auto/, 'nothing centres it again');
});
