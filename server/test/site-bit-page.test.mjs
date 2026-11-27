// The site's Bit page (docs/bit.html + docs/bit-page.js): a person's own Bit by its number, only
// what the hub shows (GET /bit/<n>, /bit/stats), drawn with the Bit kit; every name as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { LANG_PAGES } from '../../tools/lang-pages.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const PAGE = read('docs', 'bit.html');
const JS = read('docs', 'bit-page.js');
const LANGS = ['en', 'es', 'fr', 'it', 'ja', 'ko', 'zh'];

test('the page loads the engine before its own script, and is in every list of pages', () => {
  const kit = PAGE.indexOf('<script src="/create/bit-kit.js" defer>');
  assert.ok(kit > 0 && kit < PAGE.indexOf('<script src="/bit-page.js" defer>'));
  assert.ok(LANG_PAGES.some((p) => p.page === 'bit.html' && p.dict === 'bit'));
  assert.match(read('tools', 'build-seo.mjs'), /loc: '\/bit\.html'/);
  assert.match(read('docs', 'sitemap.xml'), /<loc>https:\/\/xenon-app\.com\/bit\.html<\/loc>/);
  for (const l of LANGS.slice(1)) assert.match(read('docs', l, 'bit.html'), new RegExp(`<html lang="${l}"`), l);
});

test('only the hub\'s public answers, without cookies, and a number from the hash', () => {
  assert.match(JS, /const HUB = 'https:\/\/xenon-supporter-hub\.xenonedge\.workers\.dev';/);
  assert.match(JS, /fetch\(HUB \+ path, \{ credentials: 'omit', signal: ctl\.signal \}\)/);
  assert.match(JS, /const HASH = \/\^#\(\[1-9\]\\d\{0,8\}\)\$\/;/);
  assert.match(JS, /getJson\('\/bit\/' \+ n\)/);
  assert.match(JS, /getJson\('\/bit\/stats'\)/);
});

test('names go in as text and the small Bits as pictures, never as markup', () => {
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
    assert.ok(!JS.includes(bad), bad);
  }
  assert.match(JS, /'data:image\/svg\+xml;charset=utf-8,' \+ encodeURIComponent\(svg\)/);
  assert.match(JS, /img\.alt = '';/);
  assert.match(JS, /textContent: bit\.name \|\| number/);
  assert.match(JS, /if \(!bit \|\| bit\.number !== n\)/, 'an answer for another Bit is not drawn');
});

test('every word the script writes, in the seven languages of the site', () => {
  const m = /const WORDS = (\{[\s\S]*?\n {2}\});/.exec(JS);
  assert.ok(m, 'WORDS table');
  const words = vm.runInNewContext(`(${m[1]})`);
  assert.deepEqual(Object.keys(words).sort(), [...LANGS].sort());
  const keys = Object.keys(words.en).sort();
  for (const l of LANGS) {
    assert.deepEqual(Object.keys(words[l]).sort(), keys, l);
    for (const k of ['number', 'looking', 'missing']) assert.match(words[l][k], /\{n\}/, `${l} ${k}`);
    assert.match(words[l].count, /\{born\}[\s\S]*\{shown\}/, `${l} count`);
  }
});

test('the page says what it shows and how a Bit gets on it, in every language', () => {
  const dict = JSON.parse(read('tools', 'i18n', 'bit.json'));
  const keys = Object.keys(dict.en).sort();
  for (const l of LANGS) assert.deepEqual(Object.keys(dict[l]).sort(), keys, l);
  // The switch is named as the app names it (mybit_site), so a person finds it.
  const app = { en: 'en', es: 'es', fr: 'fr', it: 'it', ja: 'ja', ko: 'ko', zh: 'zh' };
  for (const [l, code] of Object.entries(app)) {
    const label = /\n {2}mybit_site: '([^']+)'/.exec(read('server', 'js', 'i18n', `${code}.js`))[1];
    assert.ok(dict[l]['bit.how.p1'].includes(`<strong>${label}</strong>`), `${l}: ${label}`);
  }
});

test('the wardrobe: a made-up Bit for each way, the app\'s words, and the way to support', () => {
  const WEAR = read('docs', 'bit-wear.js');
  assert.ok(PAGE.indexOf('<script src="/create/bit-kit.js" defer>') < PAGE.indexOf('<script src="/bit-wear.js" defer>'));
  assert.deepEqual([...PAGE.matchAll(/class="bitp-way-pic" data-way="(\w+)"/g)].map((m) => m[1]), ['supporter', 'shop', 'free']);
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) assert.ok(!WEAR.includes(bad), bad);
  assert.match(WEAR, /fetch\(HUB \+ '\/bit\/items', \{ credentials: 'omit', signal: ctl\.signal \}\)/);
  const seeds = Object.values(vm.runInNewContext(`(${/const SEEDS = (\{[^}]+\});/.exec(WEAR)[1]})`));
  assert.equal(new Set(seeds).size, 3);
  for (const s of seeds) assert.match(s, /^[0-9a-f]{16}$/);
  // Each way is named as the app's wardrobe tab names it, so the page and the app agree.
  const dict = JSON.parse(read('tools', 'i18n', 'bit.json'));
  const word = (l, key) => new RegExp(`\n {2}${key}: '([^']+)'`).exec(read('server', 'js', 'i18n', `${l}.js`))[1];
  for (const l of LANGS) {
    assert.equal(dict[l]['bit.wear.sup.h'], word(l, 'mybit_group_supporter'), l);
    assert.equal(dict[l]['bit.wear.shop.h'], word(l, 'mybit_group_shop'), l);
    assert.equal(dict[l]['bit.wear.free.h'], word(l, 'mybit_tab_free'), l);
    const page = l === 'en' ? PAGE : read('docs', l, 'bit.html');
    const to = l === 'en' ? '/#support' : `/${l}/#support`;
    assert.ok(page.includes(`<a class="bitp-way-key" href="${to}" data-track="support_section" data-track-location="bit_wardrobe"`), l);
  }
  // The home's supporters section points here, in each language's own copy of the page.
  const home = read('docs', 'index.html');
  const lines = [...home.matchAll(/\n {4}"sup\.bit": "(.+)",?\n/g)].map((m) => m[1]);
  assert.equal(lines.length, LANGS.length);
  for (const l of LANGS) assert.ok(lines.some((t) => t.includes(`href=\\"${l === 'en' ? '' : `/${l}`}/bit.html#wardrobe\\"`)), l);
  assert.match(JS, /if \(location\.hash && !HASH\.test\(location\.hash\)\) return;/, 'the #wardrobe anchor keeps its place');
});

test('the wardrobe\'s Bits try on their way\'s items, the hub\'s too, and only while on screen', async () => {
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('docs', 'create', 'bit-kit.js'), ctx);
  const ways = ['supporter', 'shop', 'free'];
  const section = {};
  const pics = ways.map((way) => ({ dataset: { way }, kids: [], replaceChildren(...k) { this.kids = k; }, closest: () => section }));
  let tick = null;
  let seen = null;
  const beanie = ctx.Xenon.bitWardrobe.item('beanie');
  const feed = [{ id: 'testCrown', slot: beanie.slot, source: 'supporter', month: '2026-12', layers: beanie.layers }, { id: 'bad id', source: 'supporter' }];
  let answer;
  const fed = new Promise((r) => { answer = r; });
  Object.assign(ctx, {
    window: ctx,
    document: { visibilityState: 'visible', querySelectorAll: () => pics, addEventListener() {} },
    matchMedia: () => ({ matches: false }),
    Image: class { constructor(w, h) { this.width = w; this.height = h; this.src = ''; } },
    IntersectionObserver: class { constructor(cb) { seen = cb; } observe() {} },
    setInterval: (fn) => { tick = fn; return 1; },
    clearInterval: () => { tick = null; },
    setTimeout: () => 0,
    clearTimeout() {},
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    fetch: async () => { setImmediate(answer); return { json: async () => ({ ok: true, items: feed }) }; },
  });
  vm.runInContext(read('docs', 'bit-wear.js'), ctx);
  const src = () => pics.map((p) => p.kids[0].src);
  const first = src();
  for (const s of first) assert.match(s, /^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
  assert.equal(new Set(first).size, 3, 'three Bits that look nothing alike');
  assert.equal(tick, null, 'nothing turns before the section is on screen');
  seen([{ isIntersecting: true }]);
  assert.equal(typeof tick, 'function');
  tick();
  const next = src();
  assert.equal(next[0], first[0], 'no supporters\' item yet: that Bit holds still');
  assert.notEqual(next[1], first[1], 'the shop\'s Bit tries the next item on');
  await fed;
  await new Promise((r) => setImmediate(r));
  assert.ok(ctx.Xenon.bitWardrobe.item('testCrown'), 'the hub\'s item, checked by the wardrobe');
  assert.equal(ctx.Xenon.bitWardrobe.item('bad id'), null, 'what fails the check is left out');
  assert.notEqual(src()[0], first[0], 'the supporters\' Bit wears it');
  seen([{ isIntersecting: false }]);
  assert.equal(tick, null, 'off screen it stops');
});
