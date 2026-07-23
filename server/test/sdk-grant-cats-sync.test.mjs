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

// Every all-or-nothing boolean capability. Adding one to the SDK means adding it
// here — the three tests below then pin the three places it must be wired.
const BOOLEAN_CAPS = ['storage', 'secrets', 'island', 'islandDynamic', 'islandFull', 'badge', 'clipboard', 'accent'];

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

// The grant rebuild is an allowlist: a key it omits is stripped on every save.
// Omitting the BOOLEAN capabilities (storage/secrets/island/badge) silently
// revoked them and — because grantNeedsReview asks "does the manifest declare
// something the grant lacks?" — pinned any widget requesting them in a
// permanent "asks for new permissions" re-prompt loop. Pin all of them so
// they can't drop again.
test('settings.js normalizeSdkWidgets keeps the boolean capability grants', () => {
  const src = readFileSync(join(ROOT, 'server', 'js', 'settings.js'), 'utf8');
  for (const flag of BOOLEAN_CAPS) {
    assert.ok(new RegExp(flag + ':\\s*g\\.' + flag + ' === true').test(src),
      'normalizeSdkWidgets must rebuild grants.' + flag + ' (boolean-grant lockstep)');
  }
});

// The OTHER half of the same lockstep, and the half that was missed when `badge`
// was added: grantNeedsReview must re-prompt when the manifest declares a
// boolean capability the stored grant lacks. Omit a capability here and a widget
// that gains it in an update mounts with the capability silently dead — no
// badge, no island, no prompt, no error.
test('custom-widget.js grantNeedsReview covers every boolean capability', () => {
  const src = readFileSync(join(ROOT, 'server', 'js', 'custom-widget.js'), 'utf8');
  const fn = src.match(/function grantNeedsReview\(pkg\)\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(fn, 'grantNeedsReview not found in custom-widget.js');
  for (const flag of BOOLEAN_CAPS) {
    assert.ok(new RegExp('pkg\\.' + flag + ' === true && !g\\.' + flag).test(fn[0]),
      'grantNeedsReview must re-prompt for a missing ' + flag + ' grant');
  }
});

// The grant the Allow button persists must carry every boolean capability too —
// a capability missing there is granted in the dialog and gone on the next save.
test('custom-widget.js persists every boolean capability in the grant patch', () => {
  const src = readFileSync(join(ROOT, 'server', 'js', 'custom-widget.js'), 'utf8');
  const patch = src.match(/grants: \{ \.\.\.\(cur\.grants \|\| \{\}\), \[pkg\.id\]: \{[^}]*\}/);
  assert.ok(patch, 'grant patch object not found in custom-widget.js');
  for (const flag of BOOLEAN_CAPS) {
    assert.ok(new RegExp('\\b' + flag + ':').test(patch[0]),
      'the Allow grant patch must include ' + flag);
  }
});

test('advanced island grants can justify a background service frame', () => {
  const src = readFileSync(join(ROOT, 'server', 'js', 'custom-widget.js'), 'utf8');
  assert.match(src, /const islandLive = pkg\.islandDynamic === true && grant\.island && grant\.islandDynamic/);
  assert.match(src, /!handlersLive && !badgeLive && !islandLive/);
});
