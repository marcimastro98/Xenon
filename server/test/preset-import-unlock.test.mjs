// The import dialog's unlock area: the 7-day offer only for someone with no
// code at all, a saved code means nothing to type, and rows marked hidden
// really disappear (a display rule used to beat the hidden attribute, so the
// offer showed to supporters too).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');
const share = read('js/preset-share.js');
const css = read('components/SettingsModal/SettingsModal.css');
const dialog = share.slice(share.indexOf('function openImportDialog('), share.indexOf("importBtn.addEventListener('click'"));

test('rows that set a display still hide with the hidden attribute', () => {
  assert.match(css, /\.preset-unlock-saved\[hidden\], \.preset-unlock-label\[hidden\] \{ display: none; \}/);
});

test('the 7-day offer needs no saved code and no running trial', () => {
  assert.match(dialog, /tryRow\.hidden = !\(remote && trialEligible && !emptyOk\(\) && trialRun && trialRun\.used === false\);/);
  assert.doesNotMatch(dialog, /tryBtn\.className = 'settings-btn primary/, 'one primary button: Import');
});

test('with a saved code the field stays out of the way until asked for', () => {
  assert.match(dialog, /const useSaved = remote && emptyOk\(\) && !typingOther;/);
  assert.match(dialog, /const quiet = useSaved \|\| savedPays;/);
  assert.match(dialog, /unlockLabel\.hidden = quiet;/);
  assert.match(dialog, /unlockNote\.hidden = !remote \|\| quiet;/);
  assert.match(dialog, /typingOther = true;/);
});

test('from the Store the dialog shows the name, not the code', () => {
  assert.match(dialog, /const fromStore = !!prefill && importSource\.source === 'catalog';/);
  assert.match(dialog, /field\.hidden = true;/);
  assert.match(share, /fileBtn\.hidden = fromStore;/);
  assert.match(read('js/community-gallery.js'), /name: entry\.name \|\| '' \}\)/);
});

test('no code and no trial: the dialog says how to get one, never to a supporter', () => {
  assert.match(dialog, /joinRow\.hidden = !\(remote && supporterDrop && passKnown && !emptyOk\(\) && tryRow\.hidden\);/);
  // passKnown waits for both reads, so a supporter never sees it flash.
  assert.match(dialog, /Promise\.all\(\[pass, trial, sparks\]\)\.then\(\(\) => \{ passKnown = true;/);
  assert.match(dialog, /joinLink\.rel = 'noopener noreferrer';/);
  // Limited and Sparks-only drops are not opened by a membership: no join line there.
  assert.match(read('js/community-gallery.js'), /supporterDrop: !entry\.limited && !sparksOnly\(entry\) && \(entry\.locked === true \|\| entry\.supportersOnly === true\)/);
});

test('on a phone the detail actions stay pinned under the description', () => {
  assert.match(css, /\.cgal-detail-cta:not\(:empty\) \{\s*\/\*[^*]*\*\/\s*position: sticky; bottom: -20px;/);
});

test('the new lines exist in all 11 languages and the retired ones are gone', () => {
  const i18n = read('js/i18n.js');
  for (const k of ['preset_redeem_other', 'preset_redeem_saved_ready', 'trial_import_ready', 'preset_join_note']) {
    assert.ok((i18n.match(new RegExp('\\b' + k + ':', 'g')) || []).length >= 11, k);
  }
  for (const k of ['preset_redeem_forget', 'preset_redeem_saved_placeholder', 'trial_import_row', 'preset_redeem_label3']) {
    assert.doesNotMatch(i18n, new RegExp('\\b' + k + ':'), k);
  }
});

test('a drop sold for Sparks: bought after a confirmation, then opened with the key the buy returned', () => {
  // Two presses, the price then "Confirm", because it spends.
  assert.match(dialog, /if \(!confirmBuy\) \{ confirmBuy = true; confirmAt = Date\.now\(\); syncBuy\(\); \(sparksOnly \? importBtn : buyBtn\)\.focus\(\); return; \}/);
  // A double tap on a touch screen is one tap, not a price and a confirmation.
  assert.match(dialog, /if \(Date\.now\(\) - confirmAt < CONFIRM_GAP_MS\) return;/);
  assert.match(share, /const CONFIRM_GAP_MS = 600;/);
  // Typing another code takes the confirmation back: it was given for the old one.
  assert.match(dialog, /unlockField\.addEventListener\('input', \(\) => \{\s*if \(!confirmBuy && !sparksOnly\) return;\s*confirmBuy = false;\s*syncBuy\(\);/);
  assert.match(dialog, /fetch\('\/api\/community\/buy'/);
  // Only a pass or Sparks code typed in the field is sent; empty = what this PC remembers.
  assert.match(dialog, /code: \/\^X\[CS\]\/\.test\(typed\) \? unlockField\.value : ''/);
  assert.match(share, /if \(locked\.remote && boughtCek\) \{\s*\/\/[^\n]*\n\s*inner = await unlockWithCek\(locked, boughtCek\);/);
  // A Sparks-only drop is never "opened by your saved code": the pass and the trial do not open it.
  // A pass the hub just called expired no longer opens it either.
  assert.match(dialog, /const emptyOk = \(\) => !sparksOnly && \(\(savedPass && !passLapsed\) \|\| trialActive\(\)\);/);
  // With a pass saved, a supporters-or-Sparks drop shows no buy line, until the
  // hub says the pass is past its window: then the price comes back.
  assert.match(dialog, /buyRow\.hidden = !\(remote && sparksPrice && !boughtCek && !useRedeem && !\(savedPass && !sparksOnly && !passLapsed\)\);/);
  assert.match(share, /\} else if \(err === 'expired'\) \{\s*passLapsed = true;\s*syncUnlockVisibility\(\);/);
  // "included" hands over to redeem once, so Import cannot loop back into a buy.
  assert.match(dialog, /if \(err === 'included'\) \{\s*useRedeem = true;/);
});

test('Import on a Sparks-only drop, or with a Sparks code typed, goes through the same confirmation', () => {
  assert.match(share, /if \(locked\.remote && sparksPrice && !boughtCek && !useRedeem && !typedItem && \(sparksOnly \|\| typedSparks\)\) \{\s*syncUnlockVisibility\(\);\s*buyWithSparks\(locked\);\s*return;/);
  // An XL copy typed in the field is redeemed: never charged over, never refused.
  assert.match(share, /const typedItem = canonCode\(unlockField\.value\)\.startsWith\('XL'\);/);
});

test('the Store passes the price and never offers a membership for a Sparks-only drop', () => {
  const gal = read('js/community-gallery.js');
  assert.match(gal, /sparks: entry\.limited \? 0 : \(entry\.sparks \|\| 0\), sparksOnly: sparksOnly\(entry\)/);
  assert.match(gal, /const sparksOnly = \(entry\) => !!entry && !entry\.limited && entry\.sparks > 0 && entry\.supportersOnly !== true;/);
  assert.match(gal, /if \(sparksOnly\(entry\)\) \{\s*cta\.appendChild\(importButton\(entry, [^\n]*unlockLabel\(entry\)/);
  assert.match(gal, /if \(entry && sparksOnly\(entry\)\) return t\('gallery_unlock_sparks'/);
  // Every amount names its currency.
  assert.match(gal, /\(n \/ 100\)\.toFixed\(2\) \+ ' USD\)'/);
  assert.match(css, /\.preset-unlock-forget\[hidden\] \{ display: none; \}/);
});

test('sold only for Sparks: one main action, the price, never a second buy button', () => {
  // The row's own button steps aside and Import carries the price and the confirmation.
  assert.match(dialog, /buyBtn\.hidden = sparksOnly;/);
  assert.match(dialog, /if \(importBtnRef\) importBtnRef\.textContent = \(boughtCek \|\| typedItem\) \? tr\('preset_import_apply', 'Import'\) : label;/);
  assert.match(share, /importBtnRef = importBtn;\s*if \(sparksOnly\) syncBuy\(\);/);
  // The price comes first, the field is for "your Sparks code".
  assert.match(dialog, /if \(sparksOnly\) unlockWrap\.insertBefore\(buyRow, unlockLabel\); else unlockWrap\.appendChild\(buyRow\);/);
  assert.match(dialog, /unlockText\.textContent = sparksOnly \? tr\('sparks_code_label'/);
  // A saved code pays: one line says which, with "Use another code" beside it.
  assert.match(dialog, /const savedPays = remote && sparksOnly && \(savedWallet \|\| savedPass\) && !typingOther;/);
  assert.match(dialog, /savedRow\.hidden = !quiet;/);
  // Nothing here can pay: where to get Sparks shows before the first tap.
  assert.match(dialog, /if \(passKnown && !savedCanBuy\) buyMore\.hidden = false;/);
});

test('the Store names the Sparks way in next to the supporter one', () => {
  const gal = read('js/community-gallery.js');
  assert.match(gal, /if \(!entry\.limited && entry\.sparks > 0\) \{\s*node\.appendChild\(el\('span', null, t\('gallery_or_sparks'/);
  assert.match(gal, /unlockLabel\(entry, true\)/);
  assert.match(gal, /t\('gallery_unlock_code_or_sparks', 'Unlock with a code or \{price\}'\)/);
  // The detail no longer repeats the price in a third chip.
  assert.doesNotMatch(gal, /cgal-metachip[^\n]*sparks/);
});

test('the Sparks lines exist in all 11 languages, each price line in USD', () => {
  const i18n = read('js/i18n.js');
  for (const k of ['gallery_sparks_price', 'gallery_unlock_sparks', 'sparks_buy_line_only', 'sparks_buy_line_or', 'sparks_buy_btn',
    'sparks_buy_confirm', 'sparks_buy_more', 'sparks_bought', 'sparks_owned', 'sparks_left', 'sparks_err_included', 'sparks_err_no_code',
    'sparks_err_short', 'sparks_err_short_plain', 'sparks_err_not_for_sale', 'sparks_err_sold_out', 'sparks_err_revoked',
    'gallery_or_sparks', 'gallery_unlock_code_or_sparks', 'sparks_code_label', 'sparks_saved_pays', 'sparks_saved_pays_pass']) {
    assert.equal((i18n.match(new RegExp('\\b' + k + ':', 'g')) || []).length, 11, k);
  }
  for (const line of i18n.match(/sparks_buy_line_(?:only|or): "[^"]*"/g)) assert.match(line, /\{usd\} USD/, line);
});
