import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeWidgetIcon } = require('../js/dashboard-instances.js');
const sdk = require('../sdk-widgets.js');

// A widget's own glyph (manifest `icon`): what its tab and its "+" result show
// instead of the generic puzzle. The path is set with setAttribute('d') on an
// inert SVG <path> and never parsed as markup, but this is the boundary a
// package arrives through, so the character set is an allowlist, like a shape's.

test('a single path, a list of paths and the object form all normalize to one shape', () => {
  assert.deepEqual(normalizeWidgetIcon('M3 12h18'), { path: ['M3 12h18'] });
  assert.deepEqual(normalizeWidgetIcon(['M3 6h18', 'M3 18h18']), { path: ['M3 6h18', 'M3 18h18'] });
  assert.deepEqual(normalizeWidgetIcon({ path: 'M4 4h16v16H4z', fill: true }), { path: ['M4 4h16v16H4z'], fill: true });
  // Anything but the literal true is a stroke glyph, like the built-in icons.
  assert.deepEqual(normalizeWidgetIcon({ path: 'M3 12h18', fill: 'yes' }), { path: ['M3 12h18'] });
});

test('anything that is not plain path data is refused whole', () => {
  for (const bad of [
    'url(#x)', '<path d="M0 0"/>', 'M0 0" onload="x', 'javascript:alert(1)', 'L3 3', '',
    ['M3 3h1', 'expression(1)'],                 // one bad path spoils the glyph
    ['M1 1', 'M2 2', 'M3 3', 'M4 4', 'M5 5'],     // over the four-path cap
    'M' + '1 '.repeat(400),                        // over the length cap
    42, true, { fill: true },
  ]) assert.equal(normalizeWidgetIcon(bad), null, JSON.stringify(bad));
  assert.equal(normalizeWidgetIcon(null), null);
});

test('the SDK manifest carries the icon through the same validator, and drops a bad one', () => {
  const ok = sdk.normalizeManifest({ api: 1, name: 'River', icon: ['M3 6h6l2-3 2 5h8', 'M3 12h18'] }, 'river');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.manifest.icon, { path: ['M3 6h6l2-3 2 5h8', 'M3 12h18'] });
  // A malformed cosmetic is dropped, never a rejected package: the puzzle stays.
  const bad = sdk.normalizeManifest({ api: 1, name: 'River', icon: 'url(#evil)' }, 'river');
  assert.equal(bad.ok, true);
  assert.equal(bad.manifest.icon, null);
  // No grant: a glyph confined to the package's own tab asks for nothing.
  assert.equal(sdk.normalizeManifest({ api: 1, name: 'River' }, 'river').manifest.icon, null);
});
