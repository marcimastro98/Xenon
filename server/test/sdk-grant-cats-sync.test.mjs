// The client grant normalizer (server/js/settings.js) filters each package's
// granted streams/actions against its OWN allowlists. If those lists drift from
// the server's authoritative sdk-widgets.js, a grant for a valid capability is
// silently stripped on save — the widget is "granted" something it can never use
// (the bug where a to-do widget's `tasks` stream+action were dropped). This test
// pins the two client lists to the server allowlists so they can't drift again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sdk = require(join(ROOT, 'server', 'sdk-widgets.js'));

// Pull a `const NAME = Object.freeze([...])` string array out of settings.js.
function clientList(name) {
  const src = readFileSync(join(ROOT, 'server', 'js', 'settings.js'), 'utf8');
  const m = src.match(new RegExp(name + "\\s*=\\s*Object\\.freeze\\(\\[([^\\]]*)\\]\\)"));
  assert.ok(m, name + ' not found in settings.js');
  return m[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
}

test('settings.js SDK_WIDGET_STREAMS mirrors sdk-widgets.js SDK_STREAMS', () => {
  assert.deepEqual(clientList('SDK_WIDGET_STREAMS').sort(), [...sdk.SDK_STREAMS].sort());
});

test('settings.js SDK_WIDGET_ACTION_CATS mirrors sdk-widgets.js SDK_ACTION_CATEGORIES keys', () => {
  assert.deepEqual(clientList('SDK_WIDGET_ACTION_CATS').sort(), Object.keys(sdk.SDK_ACTION_CATEGORIES).sort());
});

// The grants blob now carries a 4th per-package list — handler ids. The client
// normalizer must keep (and bound) it, or a granted handler is silently dropped
// on save and the key dies with not_granted. Pin the normalizer's output shape.
test('settings.js normalizeSdkWidgets keeps a valid handlers grant list', () => {
  const src = readFileSync(join(ROOT, 'server', 'js', 'settings.js'), 'utf8');
  assert.ok(/handlers:\s*Array\.isArray\(g\.handlers\)/.test(src),
    'normalizeSdkWidgets must rebuild grants.handlers (grant-list lockstep)');
});
