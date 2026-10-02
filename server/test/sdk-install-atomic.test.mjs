import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// POST /sdk/install writes through the SAME swap-and-rollback install the automatic
// update uses (sdk-widgets.installPackageStaged, which has its own behavioural
// tests). The route's handler lives in server.js and cannot be required, so what
// is pinned here is the property that matters and is easy to lose in a refactor:
// the package is never written file by file into the live folder.
const SRC = readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

function installWidgetPayloadBody() {
  const at = SRC.indexOf('async function installWidgetPayload(payload, origin, catalogVersion) {');
  assert.ok(at > 0, 'installWidgetPayload not found — did it move?');
  const end = SRC.indexOf('\n}\n', at);
  assert.ok(end > at);
  return SRC.slice(at, end);
}

test('a manual install builds the package beside the live one and swaps it in', () => {
  const body = installWidgetPayloadBody();
  assert.match(body, /sdkWidgets\.installPackageStaged\(SDK_WIDGETS_DIR, SDK_STAGING_DIR, v,/);
  assert.ok(!/fs\.promises\.writeFile\(abs/.test(body), 'files must not be written one by one into the live folder');
  assert.ok(!/mkdir\(dest, \{ recursive: true \}\)/.test(body), 'the live folder is not created or filled in place');
});

test('a failed swap is reported as a failed install and records nothing', () => {
  const body = installWidgetPayloadBody();
  const failed = body.indexOf('if (!swapped.ok) return { ok: false, error: \'install_failed\' };');
  const recorded = body.indexOf('await recordWidgetOrigin(');
  assert.ok(failed > 0 && recorded > failed, 'the origin is recorded only after the swap succeeded');
});

test('the swap verifies the package really loaded at the version it claims', () => {
  const body = installWidgetPayloadBody();
  assert.match(body, /scan\.packages\.some\(\(p\) => p\.id === v\.id && p\.version === v\.manifest\.version\)/);
});
