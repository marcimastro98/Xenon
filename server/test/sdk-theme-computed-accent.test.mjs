// A tile's own accent and background never reached a custom widget.
//
// themePayload reads the tile's colours with getComputedStyle, and --accent and
// --bg are registered <color>s (@property in global.css, so a theme change can
// animate). A registered colour computes to rgb(...), not the hex it was set
// as; ThemePalette.normalizeHex reads hex only, so both fell back to the global
// palette and the widget drew the dashboard's accent inside a tile styled with
// another. Reported by a widget author on 4.11.10 (accent); the background had
// the same fault. Every other token is unregistered and computes as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ThemePalette = require('../js/theme-palette.js');
const SRC = readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../styles/global.css', import.meta.url), 'utf8');

/** The real computedHex + themePayload, run against a frame with these computed tokens. */
function payloadFor(tokens) {
  const start = SRC.indexOf('  function computedHex(');
  const end = SRC.indexOf('  function langCode(');
  assert.ok(start > 0 && end > start, 'computedHex / themePayload not found');
  const make = new Function('ThemePalette', 'getComputedStyle', 'window', 'hubSettings', `
    const surfaceAppearance = () => 'dark';
    const skinMode = () => 'default';
    ${SRC.slice(start, end)}
    return { themePayload, computedHex };
  `);
  const cs = { getPropertyValue: (name) => (name in tokens ? tokens[name] : '') };
  const frame = { closest: () => null };
  const fns = make(ThemePalette, () => cs, { ThemePalette }, { accent: '#1ed760', background: '#070808', text: '#f0f3f1' });
  return { payload: fns.themePayload({ frame }), computedHex: fns.computedHex };
}

test('the two registered colours are the ones that compute to rgb()', () => {
  // If a third token is ever registered, it needs the same conversion; this
  // keeps the list honest.
  const registered = [...CSS.matchAll(/@property (--[\w-]+) \{\s*syntax: '<color>'/g)].map((m) => m[1]).sort();
  assert.deepEqual(registered, ['--accent', '--bg']);
});

test("a tile's accent and background reach the widget as the tile has them", () => {
  const { payload } = payloadFor({
    '--accent': 'rgb(255, 102, 0)',     // what Chromium returns for a registered <color>
    '--bg': 'rgb(16, 32, 48)',
    '--text': '#eeeeee',                // unregistered: computes as written
  });
  assert.equal(payload.accent, '#ff6600');
  assert.equal(payload.palette.accent, '#ff6600');
  assert.equal(payload.background, '#102030');
  assert.equal(payload.text, '#eeeeee');
});

test('computedHex reads the rgb shapes a browser serializes, and leaves the rest alone', () => {
  const { computedHex } = payloadFor({});
  assert.equal(computedHex('rgb(171, 205, 239)'), '#abcdef');
  assert.equal(computedHex('rgba(171, 205, 239, 0.5)'), '#abcdef');
  assert.equal(computedHex('rgb(171 205 239 / 50%)'), '#abcdef');
  assert.equal(computedHex(' #abcdef '), '#abcdef');
  assert.equal(computedHex('rgba(0, 0, 0, 0)'), '', 'transparent is no colour: the fallback applies');
  assert.equal(computedHex(''), '');
  assert.equal(computedHex('var(--x)'), 'var(--x)');
});
