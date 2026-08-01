import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The display state crosses three layers written in two languages, and each layer
// names its fields ONE BY ONE:
//
//   monitor.rs   display_state()  builds the JSON the shell injects
//   native-bridge.js  displayState()  rebuilds it as a plain object for the page
//   settings.js  renderSurfaceSection()  has a literal fallback for the browser,
//                where there is no shell at all
//
// Nothing in that chain spreads. A field added to the Rust half and not to the
// bridge is dropped silently: the page reads `undefined`, which is falsy, so the
// feature it drives simply never appears and no error is raised anywhere. That is
// how `gpuMismatch` was very nearly shipped dead — the bridge is an allowlist, and
// an allowlist that nobody re-reads when a producer grows is the whole bug class.
//
// So this pins the three lists to each other. It reads the REAL declarations out of
// the real files rather than restating them, because a restated copy would keep
// passing while the originals drifted apart.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(HERE, '..', ...p), 'utf8');

const RUST = fs.readFileSync(
  path.join(HERE, '..', '..', 'apps', 'native', 'src-tauri', 'src', 'monitor.rs'),
  'utf8',
);
const BRIDGE = read('js', 'native-bridge.js');
const SETTINGS = read('js', 'settings.js');

/** Slice from `open` to its matching close brace, brace-counted. */
function block(source, open, label) {
  const at = source.indexOf(open);
  assert.notEqual(at, -1, `${label}: "${open}" not found`);
  let depth = 0;
  for (let i = at + open.length - 1; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  assert.fail(`${label}: "${open}" is never closed`);
}

/** The `display` sub-object of the JSON monitor.rs emits. */
function rustDisplayKeys() {
  const state = block(RUST, 'pub fn display_state(', 'display_state');
  const display = block(state, '"display": {', 'display object');
  // Past the opening brace, so the block's OWN key ("display") is not counted
  // as one of the fields inside it.
  const inner = display.slice(display.indexOf('{') + 1);
  return [...inner.matchAll(/"([A-Za-z][A-Za-z0-9_]*)"\s*:/g)].map((m) => m[1]).sort();
}

/** The object literal `displayState()` returns in native-bridge.js. */
function bridgeKeys() {
  const fn = block(BRIDGE, 'function displayState()', 'displayState');
  const ret = block(fn, 'return {', 'displayState return');
  return [...ret.matchAll(/^\s{6}([A-Za-z][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]).sort();
}

/** The browser-path fallback literal in renderSurfaceSection(). */
function settingsFallbackKeys() {
  const m = /:\s*\{\s*supported:\s*false,[^}]*\}/.exec(SETTINGS);
  assert.ok(m, 'the browser-path fallback literal was not found in settings.js');
  return [...m[0].matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*:/g)].map((k) => k[1]).sort();
}

// `supported` and `displays` are the bridge's own: the first is "is there a shell
// at all", the second is lifted from the caps root rather than from the `display`
// block. Everything else must come from Rust and reach the page.
const BRIDGE_OWN = ['displays', 'supported'];

test('every field monitor.rs emits is forwarded by the native bridge', () => {
  const rust = rustDisplayKeys();
  const bridge = bridgeKeys();
  assert.ok(rust.length >= 6, `expected a populated display block, got ${rust.join(', ')}`);
  const dropped = rust.filter((k) => !bridge.includes(k));
  assert.deepEqual(
    dropped,
    [],
    `native-bridge.js drops ${dropped.join(', ')} — the page would read undefined, silently`,
  );
});

test('the bridge invents nothing the shell does not send', () => {
  const rust = rustDisplayKeys();
  const invented = bridgeKeys().filter((k) => !rust.includes(k) && !BRIDGE_OWN.includes(k));
  assert.deepEqual(
    invented,
    [],
    `native-bridge.js returns ${invented.join(', ')}, which monitor.rs never sets — it would be permanently undefined`,
  );
});

test('the browser fallback has the same shape as the native path', () => {
  assert.deepEqual(
    settingsFallbackKeys(),
    bridgeKeys(),
    'settings.js reads a different set of fields on the browser path than the shell provides, so a feature would behave differently with and without the native app for no stated reason',
  );
});

test('gpuMismatch survives the whole chain', () => {
  // The specific field this file was written for. Kept as its own case so a
  // regression names itself instead of arriving as a list diff.
  assert.ok(rustDisplayKeys().includes('gpuMismatch'), 'monitor.rs no longer emits gpuMismatch');
  assert.ok(bridgeKeys().includes('gpuMismatch'), 'native-bridge.js no longer forwards gpuMismatch');
  assert.match(
    SETTINGS,
    /if \(state\.gpuMismatch\)/,
    'settings.js no longer renders the GPU-mismatch notice, so the field would be carried and never shown',
  );
});

test('the mismatch notice is translated everywhere surface_missing is', () => {
  // Both strings live in the same panel, so the set of languages carrying one is
  // exactly the set that must carry the other. Counting against a sibling key is
  // what makes this survive a twelfth language being added.
  const i18n = read('js', 'i18n.js');
  const count = (key) => [...i18n.matchAll(new RegExp(`["']${key}["']\\s*:`, 'g'))].length;
  assert.equal(
    count('surface_gpu_mismatch'),
    count('surface_missing'),
    'surface_gpu_mismatch is missing from at least one language, so those users get the Italian source string',
  );
});
