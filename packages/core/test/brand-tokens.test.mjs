// The one brand set (src/brand-tokens.js). What a user would notice if it
// broke: grey text that cannot be read on a panel, a Bit colour that vanishes
// on light grey, a main button whose label is lost, or Bit wearing a colour
// that is not one of his moods.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MODES, RADIUS, FONT, MOTION } = require('../src/brand-tokens.js');
const { MOOD_RGB } = require('../src/bit-clips.js');

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const toHex = (rgb) => '#' + rgb.split(',').map((v) => Number(v).toString(16).padStart(2, '0')).join('');

for (const [mode, t] of Object.entries(MODES)) {
  test(`${mode}: every text grey reads at 4.5:1 on every surface`, () => {
    for (const ink of t.text) {
      for (const s of t.surface) assert.ok(ratio(ink, s) >= 4.5, `${ink} on ${s}: ${ratio(ink, s).toFixed(2)}`);
    }
  });

  test(`${mode}: the main button's label reads on it, at rest and on hover`, () => {
    assert.ok(ratio(t.mainInk, t.main) >= 4.5);
    assert.ok(ratio(t.mainInk, t.mainHover) >= 4.5);
    // The fill itself stands out from every surface: that contrast is what finds it.
    for (const s of t.surface) assert.ok(ratio(t.main, s) >= 3, `${t.main} on ${s}`);
  });

  test(`${mode}: Bit's colours and the selection hold 3:1 on every surface`, () => {
    for (const [name, c] of Object.entries({ ...t.bit, select: t.select })) {
      for (const s of t.surface) assert.ok(ratio(c, s) >= 3, `${name} ${c} on ${s}: ${ratio(c, s).toFixed(2)}`);
    }
  });

  test(`${mode}: the green as words (links, what is picked) reads at 4.5:1 on every surface`, () => {
    for (const s of t.surface) assert.ok(ratio(t.mainText, s) >= 4.5, `${t.mainText} on ${s}: ${ratio(t.mainText, s).toFixed(2)}`);
  });

  test(`${mode}: the base stays grey; the only interface colour is Bit's green`, () => {
    const grey = (c) => c.slice(1, 3) === c.slice(3, 5) && c.slice(3, 5) === c.slice(5, 7);
    for (const c of [...t.surface, ...t.text, t.rule, t.ruleStrong, t.stage]) {
      assert.ok(grey(c), `${c} is not a neutral grey`);
    }
    assert.equal(t.main, t.bit.ok, 'the main action wears the green of the mark');
  });
}

test("dark mode wears Bit's own mood colours, unchanged", () => {
  for (const [name, mood] of Object.entries({ ok: 'happy', idle: 'idle', worry: 'worry', angry: 'angry', think: 'think', sleep: 'sleep' })) {
    assert.equal(MODES.dark.bit[name], toHex(MOOD_RGB[mood]), name);
  }
  assert.deepEqual(Object.keys(MODES.light.bit), Object.keys(MODES.dark.bit));
});

test('corners, type and motion stay on their scale', () => {
  assert.deepEqual(RADIUS, { tag: 4, control: 6, panel: 10 });
  assert.ok(RADIUS.tag < RADIUS.control, 'a tag is squarer than a button');
  assert.match(FONT.display, /^'Sofia Sans Semi Condensed'/);
  assert.match(FONT.text, /^'Sofia Sans'/);
  assert.ok(MOTION.fast < MOTION.base && MOTION.base < MOTION.slow && MOTION.slow <= 300);
});
