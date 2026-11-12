// A widget could not match the Liquid Glass look (#153).
//
// The palette reaches a widget as #rrggbb read from the tile's computed tokens.
// On Liquid Glass a tile's line, cards and keys are white or black at 8-16%
// (liquid-tiles.css), and the alpha was dropped: every widget got a solid white
// `line` and `control` and a black `surfaceAlt`, so a row drawn with `line` had
// a hard white edge where native tiles have none. The tile's own edge (the
// user's Panel border dial) and the look's name never reached the frame either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ThemePalette = require('../js/theme-palette.js');
const SRC = readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'utf8');

/** The real computedHex + lookMode + themePayload, for a tile with these computed tokens. */
function payloadFor(tokens, hubSettings = {}, withFrame = true) {
  const start = SRC.indexOf('  function computedHex(');
  const end = SRC.indexOf('  function langCode(');
  assert.ok(start > 0 && end > start, 'computedHex / themePayload not found');
  const make = new Function('ThemePalette', 'getComputedStyle', 'window', 'hubSettings', `
    const surfaceAppearance = () => 'dark';
    const skinMode = () => 'glass';
    ${SRC.slice(start, end)}
    return { themePayload, computedHex };
  `);
  const cs = { getPropertyValue: (name) => (name in tokens ? tokens[name] : '') };
  const fns = make(ThemePalette, () => cs, { ThemePalette }, { accent: '#1ed760', background: '#070808', text: '#f0f3f1', ...hubSettings });
  return { payload: fns.themePayload(withFrame ? { frame: { closest: () => null } } : {}), computedHex: fns.computedHex };
}

// What Chromium reports on a custom tile's frame under Liquid Glass, dark tone
// (measured headless against global.css + themes-liquid.css + liquid-tiles.css).
const LIQUID_DARK = {
  '--bg': 'rgb(7, 8, 8)',
  '--surface': '#111314',
  '--surface-alt': 'rgba(8, 9, 16, 0.16)',
  '--control-bg': 'rgba(255, 255, 255, 0.09)',
  '--line': 'rgba(255, 255, 255, 0.08)',
  '--text': '#f0f3f1',
  '--panel-soft': 'rgba(22, 25, 26, 0.92)',
  '--panel-soft-alpha': '0.92',
  '--panel-border': 'rgba(255, 255, 255, 0.12)',
  '--panel-border-alpha': '0.12',
};

test('a see-through role is laid over the tile, not turned solid', () => {
  const { palette } = payloadFor(LIQUID_DARK, { styleMode: 'liquid' }).payload;
  // 8% white over #111314, 9% white over #111314, 16% of #080910 over #111314.
  assert.equal(palette.line, '#242627');
  assert.equal(palette.control, '#262829');
  assert.equal(palette.surfaceAlt, '#101113');
  assert.notEqual(palette.line, '#ffffff');
  assert.notEqual(palette.control, '#ffffff');
});

test("the tile's edge and the user's Panel border alpha reach the widget", () => {
  const { payload } = payloadFor(LIQUID_DARK, { styleMode: 'liquid' });
  assert.equal(payload.palette.panelBorder, 'rgba(255, 255, 255, 0.12)');
  assert.equal(payload.palette.panelBorderAlpha, 0.12);
  // Flat aliases mirror the palette, as for every other role.
  assert.equal(payload.panelBorderAlpha, 0.12);
});

test("Retro's edge is the accent, so the colour travels, not just the alpha", () => {
  const { palette } = payloadFor({ ...LIQUID_DARK, '--panel-border': 'rgba(30, 215, 96, 0.45)' }, { styleMode: 'retro' }).payload;
  assert.equal(palette.panelBorder, 'rgba(30, 215, 96, 0.45)');
});

test('without readable tokens the edge fields are null, never a guess', () => {
  const { palette } = payloadFor({ '--surface': '#111314' }).payload;
  assert.equal(palette.panelBorder, null);
  assert.equal(palette.panelBorderAlpha, null);
});

test('look names the dashboard look on both payload shapes, and skin stays as it was', () => {
  for (const mode of ['liquid', 'glass', 'retro', 'comic']) {
    assert.equal(payloadFor(LIQUID_DARK, { styleMode: mode }).payload.look, mode);
  }
  assert.equal(payloadFor(LIQUID_DARK, { styleMode: 'nonsense' }).payload.look, 'glass');
  const flat = payloadFor({}, { styleMode: 'liquid' }, false).payload;
  assert.equal(flat.look, 'liquid');
  assert.equal(flat.skin, 'glass');
});

test('computedHex blends by alpha, in both the comma and the slash syntax', () => {
  const { computedHex } = payloadFor({});
  assert.equal(computedHex('rgba(255, 255, 255, 0.5)', '#000000'), '#808080');
  assert.equal(computedHex('rgb(255 255 255 / 50%)', '#000000'), '#808080');
  assert.equal(computedHex('rgba(255, 255, 255, 1)', '#000000'), '#ffffff');
  assert.equal(computedHex('rgba(255, 255, 255, 0%)', '#000000'), '');
  // No colour under it: the old reading, alpha dropped.
  assert.equal(computedHex('rgba(171, 205, 239, 0.5)'), '#abcdef');
});
