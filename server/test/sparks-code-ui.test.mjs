// The Sparks code (XC) on the dashboard side: Settings keeps it in the same box
// as the supporter pass, Bit turns on for someone who holds only Sparks, and the
// copy never says Sparks are for supporters only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync } from './browser-source.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appStringsSource } from './i18n-source.mjs';
import { engineSource } from './engine-source.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '..', rel), 'utf8');
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
  assert.match(engineSource('server/ai-xenon-credits.js'), /await redeem\.readSavedCode\(dataDir\) \|\| await sparksWallet\.readWalletCode\(dataDir\)/);
});

test('the new lines exist in all 11 languages and the "no code" line names both codes', () => {
  const i18n = appStringsSource();
  for (const k of ['settings_sparks_code_saved', 'settings_sparks_code_note', 'xai_offer_title_wallet', 'xai_offer_line_wallet']) {
    assert.equal((i18n.match(new RegExp('\\b' + k + ':', 'g')) || []).length, 11, k);
  }
  assert.match(i18n, /settings_xenon_no_code: ["']To use Sparks, save your supporter code or your Sparks code\./);
});

// A supporter who bought Sparks with another email got an XC code by mail with no
// field to paste it into: the box hid itself beside the saved pass (10 Nov 2026).
test('Settings: beside a saved pass the box stays open for a Sparks code, and only for one', () => {
  assert.match(box, /const open = !saved \|\| \(pass && !wallet\);/);
  assert.match(box, /field\.hidden = !open;/);
  assert.match(box, /field\.dataset\.mode = pass \? 'sparks' : '';/);
  assert.match(box, /pass \? 'settings_sparks_add_note' : 'settings_sparks_code_note'/);
  // Anything but an XC code typed there would replace the pass: refused before any request.
  const save = box.slice(box.indexOf('async function saveSupporterCode('));
  const guard = save.indexOf("if (!isSparks && field.dataset.mode === 'sparks')");
  assert.ok(guard > 0 && guard < save.indexOf('fetch('), 'checked before the request');
  assert.ok(guard < save.indexOf('btn.disabled = true'), 'the button is never left disabled');
  const i18n = appStringsSource();
  assert.equal((i18n.match(/\bsettings_sparks_add_note:/g) || []).length, 11);
});
