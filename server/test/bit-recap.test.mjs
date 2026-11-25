// The recap cards of the person's own Bit (js/bit-companion/recap.js): what they say in each
// language's plural forms, which recaps a view carries, the sheet's buttons, and the one
// message that tells about a closed month (companion.js). Every number and name is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { appStrings, APP_LANGS } from './i18n-source.mjs';
import { makeDom } from './mini-dom.mjs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SRC = read('js/bit-companion/recap.js');
const FACTS = ['days', 'gaming', 'music', 'coding', 'night', 'early', 'items', 'hot'];

// Its answers as plain values of this realm, so deepEqual compares them as such.
const plain = (v) => JSON.parse(JSON.stringify(v));

function load(extra = {}) {
  const window = { ...extra };
  vm.runInNewContext(SRC, { window, Intl, Date, JSON, Math, Number, String, Array, Object, makeEl: extra.makeEl || (() => ({})) });
  const R = window.BitRecap;
  return { ...R, words: (...a) => plain(R.words(...a)), recapsOf: (...a) => plain(R.recapsOf(...a)) };
}

// The app's say() on one language's own words, English behind them (js/i18n.js t()).
function sayIn(code) {
  const { en } = appStrings();
  const own = appStrings()[code];
  return (key, vars = {}) => String(own[key] ?? en[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
const num = (n) => String(n);

const month = { key: '2026-11', days: 21, gaming: 2530, music: 59, coding: 0, hot: 30, night: 3, early: 0, items: ['beanie', 'scarf'] };
const bit = { number: 1284, name: 'Pixel', worn: [], genes: {} };

test('a month in English: the name in the title, the number under it, the days, then four facts at most', () => {
  const w = load().words(month, 'month', bit, sayIn('en'), num, 'en');
  assert.equal(w.title, 'Your November with Pixel');
  assert.equal(w.small, 'Bit #1284');
  assert.deepEqual(w.lines, ['21 days together', '42 hours of games', '1 hour of music', '3 nights at the PC after 1 am', '2 new things in the wardrobe']);
  assert.equal(w.button, 'Your November');
  assert.equal(w.file, 'my-bit-2026-11.png');
  const quiet = load().words({ ...month, days: 1, gaming: 20, music: 0, hot: 0, night: 0, items: [] }, 'month', { number: 7 }, sayIn('en'), num, 'en');
  assert.deepEqual([quiet.title, quiet.small, quiet.lines], ['Your November with Bit #7', '', ['1 day together']], 'under half an hour is no hour');
});

test('the year card and other languages: their own plural forms, the month in their own words', () => {
  const R = load();
  const year = { ...month, key: '2026' };
  assert.equal(R.words(year, 'year', bit, sayIn('it'), num, 'it').title, 'Il tuo 2026 con Pixel');
  const ru = R.words({ ...month, days: 22, gaming: 5 * 60, music: 21 * 60 }, 'month', bit, sayIn('ru'), num, 'ru');
  assert.deepEqual(ru.lines.slice(0, 3), ['22 дня вместе', '5 часов игр', '21 час музыки']);
  assert.equal(ru.title, 'Ваш ноябрь с Pixel');
  const ja = R.words(month, 'month', bit, sayIn('ja'), num, 'ja');
  assert.equal(ja.title, 'Pixel と過ごした11月');
  assert.equal(ja.lines[0], '一緒に21日');
  assert.equal(R.words(month, 'month', bit, sayIn('fr'), num, 'fr').title, 'Novembre avec Pixel', 'a title that starts with the month starts with a capital');
});

test('every recap word in all 11 languages, with its {n} and the forms its plural rules ask for', () => {
  const tables = appStrings();
  for (const code of APP_LANGS) {
    const own = tables[code];
    for (const key of ['mybit_recap_month', 'mybit_recap_year', 'mybit_recap_month_btn', 'mybit_recap_year_btn', 'mybit_recap_msg', 'mybit_recap_open']) {
      assert.ok(own[key], `${code} ${key}`);
    }
    for (const fact of FACTS) {
      for (const n of [1, 2, 3, 5, 11, 21, 22, 25, 101]) {
        const form = new Intl.PluralRules(code).select(n);
        const text = own[`mybit_recap_${fact}_${form}`];
        assert.ok(text, `${code} ${fact} ${form}`);
        assert.match(text, /\{n\}/, `${code} ${fact} ${form} keeps {n}`);
      }
      assert.ok(own[`mybit_recap_${fact}_other`], `${code} ${fact} other, behind every form`);
    }
    assert.match(own.mybit_recap_month, /\{month\}/);
    assert.match(own.mybit_recap_year, /\{year\}/);
  }
});

test('only well-made recaps make a button: the year first, then the month', () => {
  const R = load();
  assert.deepEqual(R.recapsOf({ recap: { month: null, year: null } }), []);
  assert.deepEqual(R.recapsOf({}), []);
  assert.deepEqual(R.recapsOf({ recap: { month: { key: '2026-13', days: 3, items: [] } } }), []);
  assert.deepEqual(R.recapsOf({ recap: { month: { key: '2026-11', days: 0, items: [] } } }), []);
  assert.deepEqual(R.recapsOf({ recap: { month: { key: '2026-11', days: 4 } } }), [], 'no items list: not one of ours');
  const both = R.recapsOf({ recap: { month, year: { ...month, key: '2026' } } });
  assert.deepEqual(both.map((r) => r.kind), ['year', 'month']);
});

test('the sheet\'s part: a button per recap, nothing without one', () => {
  const { document } = makeDom();
  const makeEl = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const R = load({ makeEl, BitCard: { paint: {} } });
  const h = { say: sayIn('en'), num, note() {}, redraw() {}, signal: new AbortController().signal };
  assert.equal(R.section({ ...bit, recap: { month: null, year: null } }, h), null);
  const part = R.section({ ...bit, recap: { month, year: { ...month, key: '2026' } } }, h);
  assert.deepEqual([...part.querySelectorAll('button')].map((b) => b.textContent), ['Your 2026', 'Your November']);
  assert.equal(load({ makeEl }).section({ ...bit, recap: { month } }, h), null, 'no card painter: no buttons that do nothing');
});

test('the card is drawn on the birth card\'s ground, never from the page; the sheet offers it', () => {
  assert.match(SRC, /P\.bitPicture\(bit, BIT, tone\.ink\)/);
  assert.match(SRC, /P\.ground\(said\.tagline, P\.pageOf\(bit\) \|\| P\.SITE, tone\)/);
  for (const bad of ['innerHTML', 'html2canvas', 'getDisplayMedia', 'frameSvg']) assert.ok(!SRC.includes(bad), bad);
  assert.match(read('js/bit-companion/sheet.js'), /window\.BitRecap\?\.section\(bit, hands\)/);
  assert.match(read('js/bit-companion/sheet.js'), /window\.BitRecap\?\.reset\(\);/);
  const page = read('index.html');
  const at = page.indexOf('src="js/bit-companion/recap.js"');
  assert.ok(at > page.indexOf('src="js/bit-companion/card.js"') && at < page.indexOf('src="js/bit-companion/companion.js"'));
});
