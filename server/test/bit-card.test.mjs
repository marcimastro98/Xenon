// The card of the person's own Bit, to post (js/bit-companion/card.js): what it says, that it
// is drawn from the engine and never from the page, and that the sheet offers it. Every number
// and name here is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SRC = read('js/bit-companion/card.js');

function load() {
  const window = {};
  vm.runInNewContext(SRC, { window, makeEl: () => ({}) });
  return window.BitCard;
}
const say = (key, vars = {}) => `${key}${Object.keys(vars).length ? JSON.stringify(vars) : ''}`;
const num = (n) => String(n);
const date = (iso) => iso.slice(0, 10);

test('the card: the name first, then the number and the hatch day in one sentence, then plain sentences', () => {
  const C = load();
  const bit = { number: 1284, name: '  Pixel ', born: '2026-11-04T10:00:00.000Z', founder: true,
    rarity: [{ gene: 'shiny', id: 'shiny', oneIn: 4096 }, { gene: 'tip', id: 'leaf', oneIn: 9 }] };
  const w = JSON.parse(JSON.stringify(C.words(bit, say, num, date, 'en')));
  assert.equal(w.big, 'Pixel');
  assert.equal(w.small, 'mybit_share_born_of{"number":"mybit_number{\\"n\\":\\"1284\\"}","date":"2026-11-04"}');
  assert.equal(w.about, 'mybit_founder mybit_rare_shiny{"n":"4096"}');
  assert.equal(w.tagline, 'mybit_share_tagline');
  assert.ok(!('chips' in w), 'no chips: sentences only');
  // Japanese and Chinese put no space between sentences.
  assert.equal(C.words(bit, say, num, date, 'ja').about, 'mybit_foundermybit_rare_shiny{"n":"4096"}');

  const plain = JSON.parse(JSON.stringify(C.words({ number: 7, rarity: [{ gene: 'palette', id: 'classic', oneIn: 512 }] }, say, num, date)));
  assert.equal(plain.big, 'mybit_number{"n":"7"}');
  assert.equal(plain.small, '');
  assert.equal(plain.about, 'mybit_rare_classic{"n":"512"}');

  // A name but no number yet: the hatch day alone.
  assert.equal(C.words({ name: 'Pixel', born: '2026-11-04T10:00:00.000Z' }, say, num, date).small, 'mybit_share_born{"date":"2026-11-04"}');

  // Born on this PC, offline: no number, no odds to show.
  const local = JSON.parse(JSON.stringify(C.words({ born: 'not a date' }, say, num, () => '')));
  assert.deepEqual([local.big, local.small, local.about], ['mybit_title', '', '']);
  assert.equal(C.rareLine({ rarity: [{ gene: 'eyes', id: 'gold', oneIn: 40 }] }, say, num), 'mybit_rare_trait{"n":"40"}');
  assert.equal(C.rareLine(null, say, num), '');
  assert.equal(C.aboutLine({ founder: true }, say, num, 'en'), 'mybit_founder');
});

test('the card is drawn from the engine and the server view, never a capture of the page', () => {
  assert.match(SRC, /X\.bit\.frameSvg\(/);
  assert.match(SRC, /X\.bitWardrobe\.outfit\(bit\.worn/, 'what it owns, never a try-on');
  for (const bad of ['innerHTML', 'html2canvas', 'getDisplayMedia', 'captureVisibleTab', 'BitWardrobe']) {
    assert.ok(!SRC.includes(bad), bad);
  }
  assert.match(SRC, /const SITE = 'https:\/\/xenon-app\.com\/';/, 'the QR leads to the site, never this PC');
  assert.match(SRC, /ground\(said\.tagline, pageOf\(bit\) \|\| SITE\)/, 'or to its own page there, once shown');
  assert.match(SRC, /qrCode\(target\)/, 'the ground draws the QR it is given');
  assert.match(SRC, /bit\.page\.startsWith\(PAGE\) && \/\^\[1-9\]\\d\{0,8\}\$\/\.test/, 'a page only on the site, by number');
});

test('the site choice: a switch that asks the server, a line on what is shown, the link once shown', () => {
  assert.match(SRC, /h\.post\('\/api\/bit\/publish', \{ public: input\.checked \}\)/);
  assert.match(SRC, /if \(!bit\.number \|\| bit\.local\) return null;/, 'only a Bit with the hub\'s number');
  assert.match(SRC, /link\.rel = 'noopener noreferrer';/);
  for (const code of ['en', 'it', 'de', 'es', 'fr', 'ja', 'ko', 'nl', 'pt', 'ru', 'zh']) {
    const text = read(`js/i18n/${code}.js`);
    for (const key of ['mybit_site', 'mybit_site_line', 'mybit_site_open', 'mybit_site_failed', 'mybit_site_taken_down']) {
      assert.match(text, new RegExp(`\\n  ${key}: '`), `${code} ${key}`);
    }
  }
});

test('the sheet offers the card, the page loads it, and the QR helpers it borrows exist', () => {
  assert.match(read('js/bit-companion/sheet.js'), /window\.BitCard\?\.section\(bit, wardrobeHands\(\)\)/);
  const page = read('index.html');
  const card = page.indexOf('src="js/bit-companion/card.js"');
  assert.ok(card > 0 && card < page.indexOf('src="js/bit-companion/sheet.js"'));
  assert.match(read('js/presets/share-card.js'), /window\.ShareCard = \{ open, close, pickQrTarget, loadQrLib, drawQr \}/);
});

test('every word of the card in all 11 languages', () => {
  const keys = ['mybit_share', 'mybit_share_born', 'mybit_share_tagline', 'mybit_share_failed',
    'sharecard_download', 'sharecard_copy_image', 'sharecard_copied_image', 'sharecard_copy_image_fail', 'sharecard_share', 'save_file_failed'];
  for (const code of ['en', 'it', 'de', 'es', 'fr', 'ja', 'ko', 'nl', 'pt', 'ru', 'zh']) {
    const text = read(`js/i18n/${code}.js`);
    for (const key of keys) assert.match(text, new RegExp(`\\n  ${key}: '`), `${code} ${key}`);
    assert.match(text.match(/\n {2}mybit_share_born: '([^']*)'/)[1], /\{date\}/, `${code} keeps {date}`);
  }
});
