// The purchase sheet: what it shows at each moment of a sale, the colours it takes from
// a Store entry, what it keeps of the catalog text, and its strings in every language.
// The rules that protect the buyer live in the import dialog and are pinned in
// preset-import-unlock.test.mjs; the flows on a real page are in tools/buy-sheet-check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');
vm.runInThisContext(read('js/buy-sheet-model.js'));
const M = globalThis.BuySheetModel;

const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
const PACKS = {
  haunted: { accent: '#EE7A2B', bg: '#3F5079', text: '#E6DCC8' },
  atelier: { accent: '#a861c5', bg: '#120b0f', text: '#f2e6d4' },
  nitrato: { accent: '#D6AA6A', bg: '#201A13', text: '#EADFC8' },
  codex: { accent: '#B03A2E', bg: '#E8DCC0', text: '#2A2118' },
};
const READABLE = 4.5;
const HEX6 = /^#[0-9a-f]{6}$/;

test('every real pack keeps its own paper and ink, and the button reads on both', () => {
  for (const [name, preview] of Object.entries(PACKS)) {
    const c = M.palette(preview);
    assert.equal(c.paper, preview.bg.toLowerCase(), name);
    assert.equal(c.ink, preview.text.toLowerCase(), name);
    assert.equal(c.mark, preview.accent.toLowerCase(), name);
    assert.ok(M.contrast(c.ink, c.paper) >= READABLE, name + ' ink');
    assert.ok(M.contrast(c.markInk, c.mark) >= READABLE, name + ' label');
  }
});

test('a preview with no usable colours gets the Store defaults, never the raw value', () => {
  for (const preview of [null, undefined, 'x', {}, { bg: 'url(x)', text: 'red;', accent: 'javascript:1' }, { bg: 12, text: [], accent: {} }]) {
    const c = M.palette(preview);
    for (const value of Object.values(c)) assert.match(value, HEX6);
    assert.ok(M.contrast(c.ink, c.paper) >= READABLE);
  }
});

test('short hex expands, unreadable ink is replaced, an accent lost in the paper gives way', () => {
  assert.equal(M.palette({ bg: '#FFF' }).paper, '#ffffff');
  const grey = M.palette({ bg: '#777777', text: '#787878', accent: '#777778' });
  assert.ok(['#000000', '#ffffff'].includes(grey.ink));
  assert.ok(M.contrast(grey.ink, grey.paper) >= READABLE);
  assert.equal(grey.mark, grey.ink);
});

test('the pitch keeps the opening sentence', () => {
  assert.equal(M.firstSentence('A haunted house.  It lives on your screen.'), 'A haunted house.');
  assert.equal(M.firstSentence('Version 2.0 is here! More to come.'), 'Version 2.0 is here!');
  assert.equal(M.firstSentence('お化け屋敷。画面に住みます。'), 'お化け屋敷。');
  assert.equal(M.firstSentence('no full stop at all'), 'no full stop at all');
  assert.equal(M.firstSentence('  two\n lines. '), 'two lines.');
  assert.equal(M.firstSentence(null), '');
});

test('a long sentence is cut at a word and says so', () => {
  const out = M.firstSentence('word '.repeat(60).trim() + '.');
  assert.ok(out.length <= 161, String(out.length));
  assert.match(out, /word…$/);
  const solid = M.firstSentence('x'.repeat(300));
  assert.equal(solid, 'x'.repeat(160) + '…');
});

test('only the launch kit size is zoomed past its margin', () => {
  assert.equal(M.artZoom(1280, 680), 1.12);
  assert.equal(M.artZoom(1920, 1080), 1);
});

test('a picture far from the frame is shown whole, a normal shot fills it', () => {
  assert.equal(M.artFit(1280, 680), 'cover');
  assert.equal(M.artFit(1920, 1080), 'cover');
  assert.equal(M.artFit(1600, 1000), 'cover');
  assert.equal(M.artFit(800, 800), 'contain');
  assert.equal(M.artFit(720, 1280), 'contain');
  assert.equal(M.artFit(2560, 720), 'contain');
  assert.equal(M.artFit(0, 0), 'cover');
});

test('catalog data is checked where it enters the sheet', () => {
  const c = M.card({
    name: 'n'.repeat(200), kind: 'k'.repeat(99), line: 'Hello there. Bye.', preview: PACKS.codex,
    art: ['https://x.test/a.webp', 'http://x.test/b.webp', 'javascript:alert(1)', 'data:image/png;base64,AA', 7, null],
  });
  assert.equal(c.name.length, 80);
  assert.equal(c.kind.length, 40);
  assert.equal(c.line, 'Hello there.');
  assert.deepEqual(c.art, ['https://x.test/a.webp']);
  assert.equal(c.colors.paper, '#e8dcc0');
  const empty = M.card(null);
  assert.deepEqual([empty.name, empty.kind, empty.line, empty.art.length], ['', '', '', 0]);
});

test('the price splits into number and word in every language, and always names USD', () => {
  const i18n = read('js/i18n.js');
  const templates = i18n.match(/gallery_sparks_price: "[^"]*"/g).map((m) => m.slice(m.indexOf('"') + 1, -1));
  assert.equal(templates.length, LANGS.length);
  for (const template of templates) {
    const parts = M.priceParts(template, 300);
    assert.equal(parts.n, '300');
    assert.ok(parts.unit.length > 0 && !/[{}]/.test(parts.unit), template);
  }
  assert.equal(M.usd(300), '3.00 USD');
  assert.equal(M.usd(1), '0.01 USD');
});

test('a headline too long for a phone is drawn smaller', () => {
  assert.equal(M.doneIsLong('È tuo.'), false);
  assert.equal(M.doneIsLong('It\'s yours.'), true);
  assert.equal(M.doneIsLong('あなたのものです。'), true);
});

const sale = (over) => M.decide({
  known: true, selling: true, opens: false, member: false, canPay: true, typing: false, typed: '',
  sparksOnly: true, price: 300, chosen: false, bought: false, held: 500, ...over,
});

test('enough Sparks: the offer, the box, one button', () => {
  const d = sale();
  assert.equal(d.view, 'offer');
  assert.equal(d.line, 'left');
  assert.deepEqual([d.gets, d.tick, d.buy, d.seller, d.other], [true, true, true, true, true]);
  assert.deepEqual([d.short, d.more, d.joinAlt, d.back, d.code, d.have], [false, false, false, false, false, false]);
  assert.equal(d.slot, null);
});

test('exactly the price is enough', () => {
  const d = sale({ held: 300 });
  assert.deepEqual([d.short, d.line, d.buy], [false, 'left', true]);
});

test('short of Sparks: no box, no Buy, the way to get more', () => {
  const d = sale({ held: 299 });
  assert.deepEqual([d.short, d.line, d.tick, d.buy, d.gets], [true, 'short', false, false, false]);
  assert.deepEqual([d.more, d.joinAlt], [true, true]);
  // A supporter is never asked to join.
  assert.equal(sale({ held: 299, member: true }).joinAlt, false);
});

test('an unknown balance is never drawn as a number', () => {
  const pays = sale({ held: null });
  assert.deepEqual([pays.line, pays.short, pays.buy], [null, false, true]);
  // Nothing here can pay: said as soon as it is known, without a false zero.
  const none = sale({ held: null, canPay: false });
  assert.deepEqual([none.line, none.short, none.more, none.buy], [null, true, true, false]);
});

test('before the local reads are in, nothing says "not enough" and nobody is asked to join', () => {
  const d = sale({ known: false, held: null, canPay: false });
  assert.deepEqual([d.short, d.more, d.joinAlt, d.buy], [false, false, false, true]);
});

test('a drop the pass opens too: the pass leads, then the single purchase', () => {
  const d = sale({ sparksOnly: false });
  assert.equal(d.view, 'pass');
  assert.deepEqual([d.have, d.other, d.back, d.seller], [true, false, false, false]);
  const only = sale({ sparksOnly: false, chosen: true });
  assert.equal(only.view, 'offer');
  assert.deepEqual([only.back, only.have, only.seller, only.buy], [true, false, true, true]);
});

test('a Sparks or pass code typed in the field is sold against, a copy code is redeemed', () => {
  for (const typed of ['XCABCD', 'XSABCD']) {
    const d = sale({ typing: true, typed, held: null, canPay: false });
    assert.deepEqual([d.view, d.short, d.tick, d.buy, d.more, d.seller], ['offer', false, true, true, false, true], typed);
    assert.deepEqual([d.code, d.back, d.other, d.slot], [true, true, false, 'code'], typed);
  }
  const copy = sale({ typing: true, typed: 'XLABCD', held: 500 });
  assert.deepEqual([copy.short, copy.line, copy.tick, copy.buy, copy.more, copy.seller], [false, null, false, false, false, false]);
  assert.equal(copy.slot, 'code');
});

test('an empty field in front of an empty wallet still shows the way out', () => {
  const d = sale({ typing: true, typed: '', held: 0, canPay: false });
  assert.deepEqual([d.view, d.short, d.line, d.more, d.code, d.back], ['offer', true, 'short', true, true, true]);
});

test('a saved code that opens it: nothing to pay, one button', () => {
  const d = sale({ opens: true, selling: false });
  assert.equal(d.view, 'opens');
  assert.deepEqual([d.slot, d.other, d.seller, d.code], ['act', true, false, false]);
  const typing = sale({ opens: true, selling: false, typing: true });
  assert.deepEqual([typing.view, typing.slot, typing.code, typing.back], ['code', 'code', true, true]);
});

test('bought: only the receipt and Install', () => {
  for (const over of [{}, { typing: true }, { sparksOnly: false }, { chosen: true }]) {
    const d = sale({ bought: true, selling: false, ...over });
    assert.deepEqual([d.view, d.slot], ['done', 'act']);
    assert.deepEqual([d.other, d.back, d.code, d.seller, d.have], [false, false, false, false, false]);
  }
});

const SHEET_KEYS = {
  left: ['{b}', '{r}'], short: ['{b}', '{m}'], have: ['{b}'], get_pcs: [], get_updates: [], get_now: [], wait: [],
  join_note: ['{n}', '{usd}'], pass_head: [], pass_line: ['{n}', '{usd}'], only: [], have_code: [], back: [],
  done: [], mail: [], install: [], done_foot: [], unlock: [],
};

test('the sheet is in all 11 languages, with every number it needs', () => {
  const i18n = read('js/i18n.js');
  for (const [key, holes] of Object.entries(SHEET_KEYS)) {
    const lines = i18n.match(new RegExp(`\\bsparks_sheet_${key}: "[^"]*"`, 'g')) || [];
    assert.equal(lines.length, LANGS.length, key);
    for (const line of lines) {
      for (const hole of holes) assert.ok(line.includes(hole), `${line} needs ${hole}`);
      assert.doesNotMatch(line, /—/, line);
    }
  }
});

test('the box has one bold lead, names the 14 days and the right it gives up', () => {
  const lines = read('js/i18n.js').match(/\bsparks_buy_consent: "[^"]*"/g);
  assert.equal(lines.length, LANGS.length);
  for (const line of lines) {
    assert.equal(line.split('|').length, 2, line);
    assert.match(line, /14/, line);
    assert.doesNotMatch(line, /—/, line);
  }
});

const sources = ['js/buy-sheet.js', 'js/buy-sheet-parts.js', 'js/buy-sheet-motion.js'].map(read).join('\n');

test('the sheet never ticks the box and never writes catalog text as markup', () => {
  assert.doesNotMatch(sources, /\.checked\s*=/);
  assert.doesNotMatch(sources, /\beval\(|new Function|document\.write|outerHTML|insertAdjacentHTML/);
  assert.deepEqual(sources.match(/\.innerHTML\s*=[^\n]*/g), ['.innerHTML = ICONS[name];']);
});

test('closing the sheet stops everything it started', () => {
  const sheet = read('js/buy-sheet.js');
  const destroy = sheet.slice(sheet.indexOf('function destroy()'));
  for (const step of [/gone = true;/, /stop\.abort\(\);/, /motion\.stop\(\);/, /unwatch\(\)/, /BitApp\.sweep\(\)/]) assert.match(destroy, step);
  const motion = read('js/buy-sheet-motion.js');
  assert.match(motion, /run\.cancel\(\)/);
  assert.match(motion, /cancelAnimationFrame\(raf\)/);
  // A wait for the count that was cut short must not hang the purchase.
  assert.match(motion, /if \(release\) release\(\);/);
});

test('a copy already bought skips the sale, and never sends the box it did not tick', () => {
  const dialog = read('js/preset-share.js');
  assert.match(dialog, /if \(!again && !buyBox\.checked\)/);
  assert.match(dialog, /consent: again \? undefined : BUY_CONSENT/);
  assert.match(dialog, /if \(owned\) await buyWithSparks\(locked, true\);/);
  assert.match(dialog, /known: passKnown && ownedKnown/);
});

test('the balance only ever counts down', () => {
  // requestAnimationFrame stamps the first frame before performance.now() ran: seen in the real shell.
  assert.match(read('js/buy-sheet-motion.js'), /Math\.min\(1, Math\.max\(0, \(now - start\) \/ COUNT_MS\)\)/);
});

test('a wrong code on the sheet never says it was a supporter code', () => {
  const dialog = read('js/preset-share.js');
  const buy = dialog.slice(dialog.indexOf('A saved Sparks code the hub no longer knows'));
  assert.match(buy.slice(0, 400), /tr\('preset_unlock_bad'/);
});

test('nothing moves with reduced motion or on a low-power GPU', () => {
  const motion = read('js/buy-sheet-motion.js');
  assert.match(motion, /classList\.contains\('low-power-gpu'\)\s*\|\| window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.match(motion, /fly\(from, to\) \{\s*if \(still\(\)\) return Promise\.resolve\(\);/);
  assert.match(motion, /count\(from, to, show\) \{\s*if \(still\(\) /);
});

test('the page loads the sheet before the dialog that opens it', () => {
  const page = read('index.html');
  const at = (name) => page.indexOf(`src="js/${name}.js"`);
  const order = ['utils', 'buy-sheet-model', 'buy-sheet-parts', 'buy-sheet-motion', 'buy-sheet', 'preset-share'].map(at);
  assert.ok(order.every((n) => n > 0), String(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(page, /href="components\/BuySheet\/BuySheet\.css"/);
});

test('the sheet stays alive under the freeze its own overlay asks for, and only then', () => {
  const css = read('components/BuySheet/BuySheet.css');
  // All three frames of the Spark, each one stopping for a real freeze.
  const rules = css.match(/body\.overlay-frozen[^{]*\{/g);
  assert.equal(rules.length, 3);
  for (const rule of rules) assert.match(rule, /^body\.overlay-frozen:not\(\.ambient-idle, ?\.game-mode, ?\.low-power-gpu, ?\.perf-mode\) /);
  assert.match(css, /prefers-reduced-motion: no-preference/);
  const sheet = read('js/buy-sheet.js');
  assert.match(sheet, /TILE_HOLD\.filter\(\(name\) => name !== 'overlay-frozen'\)/);
});
