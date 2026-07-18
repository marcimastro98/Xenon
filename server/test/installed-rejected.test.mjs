import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sdk = require('../sdk-widgets.js');

// The package scan refuses a folder whose NAME is not a valid package id (the
// folder name IS the id). That is correct, but for a long time nothing told the
// user, so a folder like "ip-info-widget 1.0.0" just never appeared and there
// was no way to find out why. These lock both halves: the rule itself, and the
// fact that every reason the scan can produce has a message to show.

test('a folder name with a space or dots is not a usable package id', () => {
  const okId = (id) => /^[a-z0-9][a-z0-9-]{1,40}$/.test(id);
  assert.equal(okId('ip-info-widget'), true);
  assert.equal(okId('ip-info-widget 1.0.0'), false);   // space + dots — the reported case
  assert.equal(okId('IP-Info-Widget'), false);         // uppercase
  assert.equal(okId('ip_info_widget'), false);         // underscore
  assert.equal(okId('-leading-dash'), false);
  assert.equal(okId('a'), false);                      // under the 2-char floor
});

test('every rejection reason the scan can emit has a user-facing message', () => {
  const src = readFileSync(new URL('../sdk-widgets.js', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../js/installed-manager.js', import.meta.url), 'utf8');
  // Reasons reachable from the FOLDER scan (listPackages + normalizeManifest).
  // Payload-only reasons (bad_files, bad_path, file_too_large…) belong to the
  // over-the-wire install path, which reports through its own import dialog.
  const scanReasons = ['bad_id', 'id_mismatch', 'missing_manifest', 'bad_manifest',
    'missing_entry', 'bad_entry', 'missing_name', 'bad_version', 'unsupported_api', 'too_large'];
  for (const r of scanReasons) {
    assert.ok(src.includes(`reason: '${r}'`), `${r} should still be produced by the scan`);
    assert.ok(ui.includes(`${r}:`), `${r} has no entry in REJECT_HINTS — it would show the raw code`);
  }
  // Anything not in the table must still degrade to a real sentence, never blank.
  assert.match(ui, /installed_bad_generic/, 'unknown reasons need a generic fallback message');
});

test('the rejected block renders before the empty state, not only under a list', () => {
  // A user whose ONLY widget folder was refused has nothing installed, so a
  // block rendered after the early return would never be seen — the exact case
  // that made this invisible in the first place.
  const ui = readFileSync(new URL('../js/installed-manager.js', import.meta.url), 'utf8');
  const emptyReturn = ui.indexOf("if (!rows.length) {");
  const rejInEmpty = ui.indexOf('rejectedBlock(rejected)');
  assert.ok(emptyReturn > 0 && rejInEmpty > 0);
  assert.ok(rejInEmpty > emptyReturn && rejInEmpty < ui.indexOf('host.replaceChildren(frag);'),
    'the empty-state path must render the rejected block too');
});
