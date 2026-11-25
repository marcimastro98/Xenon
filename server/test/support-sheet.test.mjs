// The support sheet (js/store-supporters/support-sheet.js): every "become a supporter"
// key opens it first, and its main key goes on to the hub's counter with the caller's
// label and the plan picked.
//
// The rules these tests hold:
//  - yearly is the plan picked unless the caller asked for monthly; yearly adds
//    &p=yearly, monthly is the hub's plain link, the one-time tip adds &p=once;
//  - without the shared constants the links still reach Buy Me a Coffee;
//  - the prices come from SUPPORT_PRICES alone, in the viewer's language;
//  - "Try 7 days free" is offered only when TrialPass says this install may have it;
//  - every caller reaches the sheet with its own label, and keeps a real link for a
//    page that has no sheet;
//  - its strings exist in all 11 languages, placeholders kept, no dash.
// The sheet on a real page (390px and desktop) is checked by tools/support-sheet-check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { textsOf } from './i18n-source.mjs';
// Through the reader: a browser file split later is still read whole.
import { readFileSync } from './browser-source.mjs';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '..', rel), 'utf8');
const Sheet = require('../js/store-supporters/support-sheet.js');
const consts = require('../../packages/core/src/constants.js');
const HUB = 'https://xenon-supporter-hub.xenonedge.workers.dev/go/support';
const BMC = 'https://www.buymeacoffee.com/marcimastro98';
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

test('the yearly plan is picked unless the caller asks for monthly', () => {
  assert.equal(Sheet.planOf('monthly'), 'monthly');
  for (const plan of ['yearly', undefined, '', 'once', 'weekly', '<x>']) assert.equal(Sheet.planOf(plan), 'yearly', String(plan));
});

test('each plan goes to the hub with the caller\'s label', () => {
  assert.equal(Sheet.linkFor('store-locked', 'yearly', consts), HUB + '?s=store-locked&p=yearly');
  assert.equal(Sheet.linkFor('store-locked', undefined, consts), HUB + '?s=store-locked&p=yearly');
  assert.equal(Sheet.linkFor('settings', 'monthly', consts), HUB + '?s=settings', 'monthly is the plain link');
  assert.equal(Sheet.linkFor('app-ask', 'once', consts), HUB + '?s=app-ask&p=once');
  assert.equal(Sheet.linkFor('<b>', 'yearly', consts), HUB + '?s=other&p=yearly', 'a bad label is counted as other');
});

test('without the shared constants the links still reach Buy Me a Coffee', () => {
  assert.equal(Sheet.linkFor('settings', 'yearly', null), BMC + '/membership');
  assert.equal(Sheet.linkFor('settings', 'monthly', undefined), BMC + '/membership');
  assert.equal(Sheet.linkFor('settings', 'once', {}), BMC);
});

test('the prices come from the one constant, in the viewer\'s language', () => {
  const en = Sheet.priceTexts(consts.SUPPORT_PRICES, 'en');
  assert.deepEqual(en, { year: '$50', month: '$5', yearMonth: '$4.17', less: '$0.83' });
  const it = Sheet.priceTexts(consts.SUPPORT_PRICES, 'it');
  assert.match(it.year, /^50\s(USD|\$)$/);
  assert.match(it.yearMonth, /^4,17\s(USD|\$)$/);
  const other = Sheet.priceTexts({ currency: 'EUR', monthly: 6, yearly: 60 }, 'en');
  assert.deepEqual(other, { year: '€60', month: '€6', yearMonth: '€5', less: '€1' }, 'nothing else holds a price');
  assert.equal(Sheet.money(5, 'EUR', 'not a language'), '5 EUR');
});

test('no other file of the app writes the membership\'s price by hand', () => {
  const src = read('js/store-supporters/support-sheet.js');
  assert.doesNotMatch(src, /\b50\b|4[.,]17/);
  assert.match(src, /consts\(\)\.SUPPORT_PRICES/);
});

// TrialPass.available on a stub page: the free week only for an install that never
// had it and keeps no supporter code.
async function trialAvailable(trial, supporter) {
  const box = {
    console, Promise, URL,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async (url) => ({ json: async () => (String(url).endsWith('/trial') ? trial : supporter) }),
  };
  box.window = box;
  box.document = { addEventListener() {}, getElementById: () => null, querySelectorAll: () => [], visibilityState: 'visible' };
  box.addEventListener = () => {};
  vm.createContext(box);
  vm.runInContext(read('js/store-supporters/trial-pass-ui.js'), box);
  return box.TrialPass.available();
}

test('"Try 7 days free" is offered only when TrialPass says this install may have it', async () => {
  assert.equal(await trialAvailable({ ok: true, used: false }, { saved: false }), true);
  assert.equal(await trialAvailable({ ok: true, used: true }, { saved: false }), false, 'the trial was used');
  assert.equal(await trialAvailable({ ok: true, used: false }, { saved: true }), false, 'a supporter code is kept');
  assert.equal(await trialAvailable({ ok: false }, { saved: false }), false, 'the server could not say');
  assert.equal(await trialAvailable(null, null), false);
  const src = read('js/store-supporters/support-sheet.js');
  assert.match(src, /trial\.hidden = true;/, 'hidden until TrialPass answers');
  assert.match(src, /window\.TrialPass\.available\(\)\.then\(\(yes\) => \{ if \(yes && trial\.isConnected\) trial\.hidden = false; \}/);
});

test('every link to the membership carries its label for the sheet and keeps its own href', () => {
  const links = [
    ['js/community-gallery/community-gallery.js', /a\.href = supportHref\(source \|\| 'store-locked'\);[^\n]*a\.dataset\.supportSource = source \|\| 'store-locked';/],
    ['js/presets/preset-share.js', /joinLink\.href = consts[\s\S]{0,300}joinLink\.dataset\.supportSource = 'store-unlock';/],
    ['js/store-catalog/buy-sheet-parts.js', /node\.href = href;[^\n]*\n\s*node\.dataset\.supportSource = 'store-unlock';/],
    ['js/media/lyrics-widget.js', /join\.href = supportHref\('lyrics'\); join\.dataset\.supportSource = 'lyrics';/],
    ['js/media/lyrics-widget.js', /keep\.href = supportHref\('lyrics-trial'\); keep\.dataset\.supportSource = 'lyrics-trial';/],
    ['js/store-supporters/devclean-pitch.js', /join\.href = s\.supportUrl;\s*join\.dataset\.supportSource = 'devclean';/],
    ['js/store-supporters/sparks-store.js', /go\.href = opts\.href;\s*go\.dataset\.supportSource = opts\.source;/],
    ['js/store-supporters/sparks-store.js', /href: ctx\.supportHref\('sparks-shop'\), source: 'sparks-shop'/],
  ];
  for (const [file, re] of links) assert.match(read(file), re, file);
  const html = read('index.html');
  assert.match(html, /href="https:\/\/xenon-supporter-hub\.xenonedge\.workers\.dev\/go\/support\?s=settings" data-support-source="settings" data-support-plan="monthly"/);
  assert.match(html, /\?s=settings-year&amp;p=yearly" data-support-source="settings-year" data-support-plan="yearly"/);
  assert.match(html, /id="xai-support" href="[^"]*\?s=ai" data-support-source="ai"/);
  assert.match(html, /<a class="support-plan" href="[^"]*\?s=settings&amp;p=once" target/, 'the one-time tile stays a direct link');
});

test('every button that asked to join opens the sheet first, the page without it', () => {
  const buttons = [
    ['js/store-supporters/support-card.js', /if \(window\.SupportSheet\) window\.SupportSheet\.open\('app-ask', \{ plan: 'monthly' \}\); else open\(supportLink\('monthly'\)\);/],
    ['js/store-supporters/support-appeal.js', /if \(window\.SupportSheet\) window\.SupportSheet\.open\('app-appeal', \{ plan: 'monthly' \}\); else open\(supportLink\('monthly'\)\);/],
    ['js/store-supporters/bit-trial-end.js', /if \(window\.SupportSheet\) \{ window\.SupportSheet\.open\(source\); return; \}/],
    ['js/store-supporters/trial-pass-ui.js', /window\.SupportSheet \? window\.SupportSheet\.open\(source \|\| 'trial-end', \{ plan \}\) : openLink\(supportUrl\(source \|\| 'trial-end'\)\)/],
    ['js/ai/client-actions.js', /case 'open_support_sheet':\s*if \(window\.SupportSheet\) SupportSheet\.open\('bit'\);/],
  ];
  for (const [file, re] of buttons) assert.match(read(file), re, file);
  // The one-time tips stay direct: they are not the membership the sheet sells.
  assert.match(read('js/store-supporters/support-card.js'), /once\.addEventListener\('click', \(\) => \{ open\(supportLink\('once'\)\); close\(\); \}\);/);
});

test('no file opens the membership on its own any more', () => {
  const dir = path.join(here, '..', 'js');
  const known = new Set([
    'ai/ai-xenon-settings.js', 'community-gallery/community-gallery.js', 'devclean-widget/devclean-widget.js', 'media/lyrics-widget.js',
    'presets/preset-share.js', 'store-supporters/support-appeal.js', 'store-supporters/support-card.js', 'store-supporters/support-sheet.js',
    'store-supporters/trial-pass-ui.js', 'store-supporters/bit-trial-end.js', 'bit-companion/wardrobe-keep.js',
  ]);
  const found = [];
  const walk = (at) => {
    for (const ent of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, ent.name);
      if (ent.isDirectory()) { if (ent.name !== 'i18n') walk(full); continue; }
      if (!ent.name.endsWith('.js')) continue;
      const text = readFileSync(full, 'utf8');
      if (/go\/support|\.supportUrl\(|buymeacoffee\.com\/marcimastro98\/membership/.test(text)) found.push(path.relative(dir, full).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  assert.deepEqual(found.filter((f) => !known.has(f)), [], 'a new way to the membership must open the sheet first');
});

test('the page loads the sheet after the constants and the focus keeper, and its stylesheet', () => {
  const html = read('index.html');
  const at = (s) => html.indexOf(s);
  assert.ok(at('<script src="js/store-supporters/support-sheet.js"></script>') > at('<script src="shared/src/constants.js"></script>'));
  assert.ok(at('<script src="js/store-supporters/support-sheet.js"></script>') > at('js/dialog-focus.js'));
  assert.ok(at('<link rel="stylesheet" href="components/SupportSheet/SupportSheet.css">') > 0);
  assert.match(read('js/settings/modal.js'), /if \(cat === 'support' && window\.SupportSheet\) SupportSheet\.paintPrices\(\);/);
});

test('Bit can open the sheet, on the dashboard and in the menu\'s window', () => {
  const tools = read('ai/core-tools-dashboard.js');
  assert.match(tools, /\{ name: 'open_support_sheet', description: '[^']*supporter[^']*', parameters: \{ type: 'OBJECT', properties: \{\} \} \}/);
  assert.match(engineSource(), /const CLIENT_ACTIONS = new Set\(\[[^\]]*'open_support_sheet'/);
  assert.match(read('ai/ai-surface.js'), /const SHEET_OK = new Set\(\[[^\]]*'open_support_sheet'/);
});

test('the sheet is text only and keeps the page\'s keyboard rules', () => {
  const src = read('js/store-supporters/support-sheet.js');
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|eval\(|new Function/);
  assert.match(src, /window\.DialogFocus\.hold\(built\.sheet, \{ start: built\.go, onEsc: close \}\)/);
  assert.match(src, /window\.addEventListener\('click', [\s\S]*?\}, true\);/, 'taken before the native shell\'s link catcher');
  assert.match(src, /'noopener noreferrer'/);
});

test('its strings exist in all 11 languages, placeholders kept, no dash', () => {
  const keys = ['title', 'lead', 'perk_widgets', 'perk_store', 'perk_discord', 'perk_hall', 'plans', 'yearly', 'monthly',
    'per_year', 'per_month', 'yearly_note', 'yearly_theme', 'monthly_note', 'annual_hint', 'go', 'code_note', 'once'];
  for (const key of keys.map((k) => 'support_sheet_' + k)) {
    const texts = textsOf(key);
    assert.deepEqual(texts.map(([code]) => code).sort(), [...LANGS].sort(), key);
    const want = (texts.find(([code]) => code === 'en')[1].match(/\{\w+\}/g) || []).sort();
    for (const [code, text] of texts) {
      assert.deepEqual((text.match(/\{\w+\}/g) || []).sort(), want, `${key} ${code}`);
      assert.doesNotMatch(text, /[—–]/, `${key} ${code}`);
    }
  }
  for (const [code, text] of textsOf('support_sheet_annual_hint')) assert.match(text, /Pay annually/, code);
});
