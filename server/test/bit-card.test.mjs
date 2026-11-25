// The card of the person's own Bit, to post (js/bit-companion/card.js): what it says, that it
// is drawn from the engine and never from the page, and that the room's sharing drawer offers it. Every number
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
  assert.equal(w.about, 'mybit_founder mybit_share_unique', 'the odds are on the DNA strip');
  assert.equal(w.tagline, 'mybit_share_tagline');
  assert.ok(!('chips' in w), 'no chips: sentences only');
  // Japanese and Chinese put no space between sentences.
  assert.equal(C.words(bit, say, num, date, 'ja').about, 'mybit_foundermybit_share_unique');

  const plain = JSON.parse(JSON.stringify(C.words({ number: 7, rarity: [{ gene: 'palette', id: 'classic', oneIn: 512 }] }, say, num, date)));
  assert.equal(plain.big, 'mybit_number{"n":"7"}');
  assert.equal(plain.small, '');
  assert.equal(plain.about, 'mybit_share_unique');
  assert.equal(C.words({ number: 7, local: true }, say, num, date).about, '', 'one of a kind only when the hub numbered it');

  // A name but no number yet: the hatch day alone.
  assert.equal(C.words({ name: 'Pixel', born: '2026-11-04T10:00:00.000Z' }, say, num, date).small, 'mybit_share_born{"date":"2026-11-04"}');

  // Born on this PC, offline: no number, no odds to show.
  const local = JSON.parse(JSON.stringify(C.words({ born: 'not a date' }, say, num, () => '')));
  assert.deepEqual([local.big, local.small, local.about], ['mybit_title', '', '']);
  // One gene alone repeats across Bits (every pastel colour is 1 in 39): the line gives the whole look's odds.
  assert.equal(C.rareLine({ rarity: [{ gene: 'eyes', id: 'gold', oneIn: 40 }], lookOneIn: 52000 }, say, num), 'mybit_look_odds{"n":"52000"}');
  assert.equal(C.rareLine(null, say, num), '');
  assert.equal(C.rareLine({ rarity: [{ gene: 'eyes', id: 'gold', oneIn: 40 }] }, say, num), '', 'no look odds, no line');
  assert.equal(C.rareLine({ rarity: [{ gene: 'shiny', id: 'shiny', oneIn: 4096 }], lookOneIn: 9000000 }, say, num),
    'mybit_rare_shiny{"n":"4096"} mybit_look_odds{"n":"9000000"}', 'shiny first, then the whole look');
  assert.equal(C.rareLine({ rarity: [{ gene: 'palette', id: 'classic', oneIn: 512 }], lookOneIn: 1 }, say, num), 'mybit_rare_classic{"n":"512"}');
  assert.equal(C.aboutLine({ founder: true }, say, num, 'en'), 'mybit_founder');
});

test('the card is drawn from the engine and the server view, never a capture of the page', () => {
  assert.match(SRC, /X\.bit\.frameSvg\(/);
  assert.match(SRC, /X\.bitWardrobe\.outfit\(bit\.worn/, 'what it owns, never a try-on');
  for (const bad of ['innerHTML', 'html2canvas', 'getDisplayMedia', 'captureVisibleTab', 'BitWardrobe']) {
    assert.ok(!SRC.includes(bad), bad);
  }
  assert.match(SRC, /const SITE = 'https:\/\/xenon-app\.com\/';/, 'the QR leads to the site, never this PC');
  assert.match(SRC, /ground\(said\.tagline, pageOf\(bit\) \|\| SITE, tone\)/, 'or to its own page there, once shown, on its own colour');
  assert.match(SRC, /BitDna\?\.strip\(ctx, bit,/, 'its DNA with the true odds');
  assert.match(SRC, /D\?\.pose\(D\.poseOf\(bit\)\)/, 'in its own pose');
  assert.match(SRC, /qrCode\(target\)/, 'the ground draws the QR it is given');
  assert.match(SRC, /bit\.page\.startsWith\(PAGE\) && \/\^\[1-9\]\\d\{0,8\}\$\/\.test/, 'a page only on the site, by number');
});

test('the site choice: a switch that asks the server, a line on what is shown, the link once shown', () => {
  const panels = read('js/bit-companion/room-panels.js');
  assert.match(panels, /h\.post\('\/api\/bit\/publish', \{ public: input\.checked \}\)/);
  assert.match(panels, /if \(!bit\.number \|\| bit\.local\) return null;/, 'only a Bit with the hub\'s number');
  assert.match(panels, /link\.rel = 'noopener noreferrer';/);
  for (const code of ['en', 'it', 'de', 'es', 'fr', 'ja', 'ko', 'nl', 'pt', 'ru', 'zh']) {
    const text = read(`js/i18n/${code}.js`);
    for (const key of ['mybit_site', 'mybit_site_line', 'mybit_site_open', 'mybit_site_failed', 'mybit_site_taken_down']) {
      assert.match(text, new RegExp(`\\n  ${key}: '`), `${code} ${key}`);
    }
  }
});

test('the room\'s sharing drawer offers the card, the page loads it, and the QR helpers it borrows exist', () => {
  const panels = read('js/bit-companion/room-panels.js');
  assert.match(panels, /tools\.append\(\.\.\.\[choice\(h\.say\('mybit_ground'\), 'card', GROUNDS,[^\n]*pose\(bit, h\)\]\.filter\(Boolean\)\)/, 'its ground and pose in one row');
  assert.match(panels, /window\.BitCard\?\.section\(bit, h, \[tools\]\)/, 'under its card');
  assert.match(panels, /if \(window\.ShareCard\) tabs\.push\(\['setup', 'mybit_share_setup'\]\)/, 'the setup card is one of the choices');
  assert.match(panels, /\[nameField\(bit, h\), facts, traits\(bit, h\), prefs\(bit, h\), site\(bit, h\)\]/, 'the site choice sits with its settings');
  assert.match(panels, /window\.ShareCard\.open\(\{ source: 'setup' \}\)/, 'the setup card opens from the same drawer');
  const page = read('index.html');
  const card = page.indexOf('src="js/bit-companion/card.js"');
  assert.ok(card > 0 && card < page.indexOf('src="js/bit-companion/room-panels.js"'));
  const draw = page.indexOf('src="js/presets/share-card-draw.js"');
  assert.ok(draw > 0 && draw < page.indexOf('src="js/presets/share-card.js"'), 'the setup card is drawn by its own file, loaded first');
  assert.match(read('js/presets/share-card.js'), /window\.ShareCard = \{ open, close, pickQrTarget, loadQrLib, drawQr \}/);
});

test('every word of the card in all 11 languages', () => {
  const keys = ['mybit_share', 'mybit_share_born', 'mybit_share_tagline', 'mybit_share_failed',
    'mybit_act_copy', 'mybit_act_share', 'mybit_act_save', 'sharecard_copied_image', 'sharecard_copy_image_fail', 'save_file_failed',
    'mybit_share_title', 'mybit_share_card', 'mybit_share_clip', 'mybit_share_setup', 'mybit_share_recap', 'mybit_setup_line', 'mybit_setup_go', 'mybit_pose', 'mybit_pose_change'];
  for (const code of ['en', 'it', 'de', 'es', 'fr', 'ja', 'ko', 'nl', 'pt', 'ru', 'zh']) {
    const text = read(`js/i18n/${code}.js`);
    for (const key of keys) assert.match(text, new RegExp(`\\n  ${key}: '`), `${code} ${key}`);
    assert.match(text.match(/\n {2}mybit_share_born: '([^']*)'/)[1], /\{date\}/, `${code} keeps {date}`);
  }
});
