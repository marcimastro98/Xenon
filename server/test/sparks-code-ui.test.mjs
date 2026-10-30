// The Sparks code (XC) on the dashboard side: Settings keeps it in the same box
// as the supporter pass, Bit turns on for someone who holds only Sparks, and the
// copy never says Sparks are for supporters only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');
const settings = read('js/settings.js');
const box = settings.slice(settings.indexOf('async function syncSupporterCodeBox('), settings.indexOf('window.saveSupporterCode = saveSupporterCode;'));

test('Settings: one box for both codes, each saved and removed through its own store', () => {
  assert.match(box, /fetch\('\/api\/community\/sparks', \{ cache: 'no-store' \}\)/);
  assert.match(box, /isSparks \? '\/api\/community\/sparks\/save' : '\/api\/community\/supporter\/save'/);
  assert.match(box, /btn\.dataset\.which === 'sparks' \? '\/api\/community\/sparks\/forget' : '\/api\/community\/supporter\/forget'/);
  // The pass wins the state line: with both, the server has already moved the Sparks onto it.
  assert.match(box, /forget\.dataset\.which = pass \? 'pass' : 'sparks';/);
  // Never a code back from the server: booleans only.
  assert.doesNotMatch(box, /out\.code\b/);
  assert.match(read('index.html'), /data-i18n="settings_sparks_code_note"/);
});

test('Bit: a Sparks code alone is enough to turn Xenon AI on', () => {
  const ai = read('js/ai-xenon-settings.js');
  assert.match(ai, /const hasSparks = supporter \|\| wallet;/);
  assert.match(ai, /show\('xai-use', hasSparks\);/);
  assert.match(ai, /show\('xai-support', !hasSparks\);/);
  assert.match(read('js/xenon-credits.js'), /async function sparksCodeSaved\(\) \{[\s\S]{0,200}\/api\/community\/sparks/);
  // The balance itself is asked with the XC code when there is no pass.
  assert.match(read('ai-xenon-credits.js'), /await redeem\.readSavedCode\(dataDir\) \|\| await sparksWallet\.readWalletCode\(dataDir\)/);
});

test('the new lines exist in all 11 languages and the "no code" line names both codes', () => {
  const i18n = read('js/i18n.js');
  for (const k of ['settings_sparks_code_saved', 'settings_sparks_code_note', 'xai_offer_title_wallet', 'xai_offer_line_wallet']) {
    assert.equal((i18n.match(new RegExp('\\b' + k + ':', 'g')) || []).length, 11, k);
  }
  assert.match(i18n, /settings_xenon_no_code: "To use Sparks, save your supporter code or your Sparks code in Settings/);
});
