// Guards docs/WIDGET_SDK.md against drift from the code. The "Capability
// reference" block is generated from server/sdk-widgets.js (SDK_STREAMS +
// SDK_ACTION_CATEGORIES) by tools/gen-sdk-reference.mjs. If someone adds or
// removes a stream/action category/type without regenerating the doc, this test
// fails — so a widget developer can never read a stale capability list (the exact
// bug where new `lighting` actions were added but the doc wasn't updated).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GEN = join(ROOT, 'tools', 'gen-sdk-reference.mjs');

test('WIDGET_SDK.md capability reference is in sync with the SDK allowlists', () => {
  try {
    execFileSync(process.execPath, [GEN, '--check'], { stdio: 'pipe' });
  } catch (e) {
    const detail = e.stderr ? e.stderr.toString() : (e.message || '');
    assert.fail('docs/WIDGET_SDK.md is stale — run: node tools/gen-sdk-reference.mjs\n' + detail);
  }
});
