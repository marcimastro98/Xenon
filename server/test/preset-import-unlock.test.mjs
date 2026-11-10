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
  assert.match(dialog, /unlockLabel\.hidden = useSaved;/);
  assert.match(dialog, /unlockNote\.hidden = !remote \|\| useSaved;/);
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
  assert.match(read('components/CommunityStore/CommunityStore.css'), /\.cst-detail \.cgal-detail-cta:not\(:empty\) \{\s*position: sticky; bottom: -24px;/);
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

test('a drop sold for Sparks: bought with the box ticked, then opened with the key the buy returned', () => {
  // Nothing spends without the box: it starts empty and a press only points at it.
  assert.match(dialog, /if \(!again && !buyBox\.checked\) \{\s*sale\.askTick\(\);\s*return;\s*\}/);
  assert.doesNotMatch(dialog, /buyBox\.checked = true|defaultChecked/);
  // One tick is one buy, and the hub gets the version of the box that was ticked.
  assert.match(dialog, /buyBox\.checked = false;\s*buyBtn\.disabled = true;/);
  assert.match(dialog, /consent: again \? undefined : BUY_CONSENT \}/);
  assert.match(share, /const BUY_CONSENT = 'item-2026-11';/);
  // Typing another code takes the tick back: it was given for the old one.
  assert.match(dialog, /unlockField\.addEventListener\('input', \(\) => \{\s*if \(!sale\) return;\s*buyBox\.checked = false;\s*syncUnlockVisibility\(\);/);
  // The two-tap confirmation is gone; the button says what it does.
  assert.doesNotMatch(share, /confirmBuy|CONFIRM_GAP_MS/);
  assert.match(dialog, /buyBtn\.textContent = tr\('sparks_buy_now', 'Buy now'\);/);
  // A hub that wants the box says so in the same words.
  assert.match(dialog, /err === 'consent_required'\) \{\s*toast\(tr\('sparks_tick_first'/);
  assert.match(dialog, /fetch\('\/api\/community\/buy'/);
  // Only a pass or Sparks code typed in the field is sent; empty = what this PC remembers.
  assert.match(dialog, /code: \/\^X\[CS\]\/\.test\(typed\) \? unlockField\.value : ''/);
  // The buy's copy number rides on the catalog receipt, which hands it to the widget (init.edition).
  assert.match(share, /boughtCopyNo = Number\.isInteger\(r\.copyNo\) && r\.copyNo > 0 \? r\.copyNo : 0;/);
  assert.match(share, /if \(locked\.remote && boughtCek\) \{\s*(\/\/[^\n]*\n\s*)+if \(!importSource\.sourceId\) importSource = \{ source: 'catalog', sourceId: locked\.entryId, sourceVersion: '' \};\s*if \(boughtCopyNo\) importSource = \{ \.\.\.importSource, copyNo: boughtCopyNo \};\s*importBtn\.disabled = true;\s*inner = await unlockWithCek\(locked, boughtCek\);\s*importBtn\.disabled = false;/);
  // A Sparks-only drop is never "opened by your saved code": the pass and the trial do not open it.
  // A pass the hub just called expired no longer opens it either.
  assert.match(dialog, /const emptyOk = \(\) => !sparksOnly && \(\(savedPass && !passLapsed\) \|\| trialActive\(\)\);/);
  // With a pass saved, a supporters-or-Sparks drop shows no buy line, until the
  // hub says the pass is past its window: then the price comes back.
  assert.match(dialog, /selling: remote && !boughtCek && !useRedeem && !\(savedPass && !sparksOnly && !passLapsed\),/);
  assert.match(share, /\} else if \(err === 'expired'\) \{\s*passLapsed = true;\s*syncUnlockVisibility\(\);/);
  // "included" hands over to redeem once, so Import cannot loop back into a buy.
  assert.match(dialog, /if \(err === 'included'\) \{\s*useRedeem = true;/);
});

test('Import on a Sparks-only drop, or with a Sparks code typed, goes through the same box', () => {
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

test('sold for Sparks: the sheet takes the dialog over and the rules stay here', () => {
  // Only a remote-locked Store entry has a sale, so every other import keeps its dialog.
  assert.match(dialog, /const sparksPrice = window\.BuySheet && sealed && sealed\.remote && Number\.isInteger\(source\.sparks\) && source\.sparks > 0 \? source\.sparks : 0;/);
  // It draws the dialog's own controls, so the checks on them still apply.
  assert.match(share, /sale = window\.BuySheet\.mount\(\{/);
  assert.match(share, /box: buyBox, buy: buyBtn, more: buyMore, other: otherBtn,/);
  assert.match(share, /code: unlockLabel, codeNote: unlockNote, open: importBtn, note: perfNote,/);
  // Closing the window stops what the sheet started.
  assert.match(dialog, /buildModal\(importTitle\(\), \(\) => \{ if \(sale\) sale\.destroy\(\); \}\)/);
  // The field is for "your Sparks code".
  assert.match(dialog, /unlockText\.textContent = sparksOnly \? tr\('sparks_code_label'/);
  // A buy that fell short shows what this code really holds.
  assert.match(dialog, /err === 'no_sparks'\) \{\s*sale\.setHeld\(r\.balance\);/);
  // A saved code the hub no longer knows stops paying, a typed one says nothing about it.
  assert.match(dialog, /if \(err === 'bad_code' && !canonCode\(unlockField\.value\)\) savedCanBuy = false;/);
  // The sheet says the outcome; closed meanwhile, it is paid for, so a toast does.
  assert.match(dialog, /const shown = await sale\.finish\(\{ bought: r\.bought === true, balance, emailed: r\.emailed === true \}\);/);
  assert.match(dialog, /if \(shown \|\| again\) return;\s*\/\/[^\n]*\n\s*const done = r\.bought/);
  // Back takes the tick and the typed code with it.
  assert.match(share, /onBack: \(\) => \{\s*typingOther = false;\s*buyBox\.checked = false;\s*unlockField\.value = '';/);
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
  for (const k of ['gallery_sparks_price', 'gallery_unlock_sparks', 'sparks_buy_now',
    'sparks_buy_consent', 'sparks_buy_seller', 'sparks_tick_first', 'sparks_pack_note', 'sparks_buy_more', 'sparks_bought', 'sparks_owned', 'sparks_left', 'sparks_err_included', 'sparks_err_no_code',
    'sparks_err_short', 'sparks_err_short_plain', 'sparks_err_not_for_sale', 'sparks_err_sold_out', 'sparks_err_revoked',
    'gallery_or_sparks', 'gallery_unlock_code_or_sparks', 'sparks_code_label']) {
    assert.equal((i18n.match(new RegExp('\\b' + k + ':', 'g')) || []).length, 11, k);
  }
  for (const line of i18n.match(/sparks_sheet_(?:join_note|pass_line): "[^"]*"/g)) assert.match(line, /\{usd\} USD/, line);
  assert.doesNotMatch(i18n, /\bsparks_buy_(?:btn|confirm|line_only|line_or):|\bsparks_saved_pays/);
  // Every language names the seller, and the pack note says where to write.
  for (const line of i18n.match(/sparks_(?:buy_seller|pack_note): "[^"]*"/g)) assert.match(line, /Xenon/, line);
  for (const line of i18n.match(/sparks_pack_note: "[^"]*"/g)) assert.match(line, /\{mail\}.*14|14.*\{mail\}/, line);
});
