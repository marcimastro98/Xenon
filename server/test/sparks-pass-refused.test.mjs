// A supporter pass refused on a drop sold for Sparks (the hub's "item" key, which a
// pass never opens): the import dialog says the pass does not open it and shows the
// sale, instead of the "wrong code" line that left supporters stuck.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { appStringsSource } from './i18n-source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');
const require = createRequire(import.meta.url);
require('../js/buy-sheet-model.js');
const { decide } = globalThis.BuySheetModel;

const share = read('js/preset-share.js');
const refused = share.slice(share.indexOf('const passRefusedOnSale = async'), share.indexOf('const buyWithSparks = async'));

test('wrong_code tries the sale before the old "wrong code" line', () => {
  assert.match(share, /err === 'wrong_code'\) \{\s*if \(!\(await passRefusedOnSale\(locked\)\)\) \{\s*toast\(tr\('preset_redeem_wrong'/);
});

test('an item code (XL) keeps its own refusal: it belongs to another drop', () => {
  assert.match(refused, /canonCode\(unlockField\.value\)\.startsWith\('XL'\)\) return false;/);
});

test('with a sale in this window the drop turns Sparks-only and the sheet follows', () => {
  assert.match(refused, /if \(sale\) \{\s*sparksOnly = true;\s*syncUnlockVisibility\(\);/);
  assert.match(share, /let sparksOnly = sparksPrice > 0 && source\.sparksOnly === true;/);
  assert.match(share, /selling: remote && [^\n]*,\s*sparksOnly,/);
  assert.match(read('js/buy-sheet.js'), /sparksOnly: o\.sparksOnly \|\| last\.sparksOnly === true/);
});

test('without a sale here, only a drop the catalog sells for Sparks goes to its Store page', () => {
  assert.match(refused, /fetch\('\/api\/community\/catalog'\)/);
  assert.match(refused, /if \(!entry \|\| entry\.limited \|\| !\(entry\.sparks > 0\) \|\| !window\.CommunityGallery\) return false;/);
  assert.match(refused, /close\(\);[\s\S]*CommunityGallery\.openEntryById\(locked\.entryId\)/);
});

test('the sheet model: once Sparks-only, a saved pass is offered the purchase, not the pass pitch', () => {
  const base = { known: true, selling: true, opens: false, member: true, canPay: true, typing: false, typed: '', price: 300, chosen: false, bought: false, held: 300 };
  assert.equal(decide({ ...base, sparksOnly: false }).view, 'pass');
  const d = decide({ ...base, sparksOnly: true });
  assert.equal(d.view, 'offer');
  assert.equal(d.buy, true);
});

test('the new line exists in all 11 languages', () => {
  const n = (appStringsSource().match(/\bsparks_err_pass_not_this:/g) || []).length;
  assert.equal(n, 11);
});
