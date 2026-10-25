// A tile's own button colours (Widget style → Controls) reach an SDK widget as
// theme.controls. CSS variables do not cross into the widget's frame, so the
// host reads the tile's computed values and sends them in the theme message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ThemePalette = require('../js/theme-palette.js');
const TileControls = require('../js/tile-controls.js');
const SRC = readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'utf8');

/** The real themePayload, for a frame on a tile with these controls and computed tokens. */
function payloadFor(controls, tokens) {
  const start = SRC.indexOf('  function computedHex(');
  const end = SRC.indexOf('  function langCode(');
  assert.ok(start > 0 && end > start, 'themePayload not found');
  const make = new Function('ThemePalette', 'getComputedStyle', 'window', 'hubSettings', `
    const surfaceAppearance = () => 'dark';
    const skinMode = () => 'glass';
    ${SRC.slice(start, end)}
    return themePayload;
  `);
  const cs = { getPropertyValue: (name) => (name in tokens ? tokens[name] : '') };
  const tile = { _xenonTileControls: controls };
  const frame = { closest: () => tile };
  globalThis.getComputedStyle = () => cs;
  try {
    const themePayload = make(ThemePalette, () => cs, { ThemePalette, TileControls }, { accent: '#1ed760' });
    return themePayload({ frame });
  } finally {
    delete globalThis.getComputedStyle;
  }
}

test('a tile with no controls sends controls: null', () => {
  assert.equal(payloadFor(null, {}).controls, null);
});

test("the tile's resolved colours arrive as CSS values the widget can use", () => {
  const p = payloadFor({ variant: 'outline', radius: 12 }, {
    // What the browser computes on the tile: var(--accent) already substituted.
    '--tb-border': 'rgb(255, 95, 162)',
    '--tb-text': 'rgb(255, 95, 162)',
  });
  assert.equal(p.controls.variant, 'outline');
  assert.equal(p.controls.border, 'rgb(255, 95, 162)');
  assert.equal(p.controls.text, 'rgb(255, 95, 162)');
  assert.equal(p.controls.bg, 'transparent', 'falls back to the resolved value when the tile reads nothing');
  assert.equal(p.controls.radius, 12);
  assert.equal(p.controls.borderWidth, undefined);
});

test('controlsPayload lists only what the tile sets, with readable text picked for a colour', () => {
  const out = TileControls.controlsPayload({ bg: '#101010', activeBg: '#ffffff', fieldBorder: '#333333' }, () => '');
  assert.deepEqual(out, {
    variant: 'filled', bg: '#101010', text: '#ffffff', border: '#101010',
    hover: out.hover, activeBg: '#ffffff', activeText: '#111111', fieldBorder: '#333333',
  });
  assert.match(out.hover, /^color-mix\(/);
  assert.equal(TileControls.controlsPayload({}, () => ''), null);
  assert.equal(TileControls.readTileControls({}), null, 'a tile never painted sends nothing');
});
