'use strict';

// The colour maths every light effect draws with (light-fx.js), and the ready palettes a person
// can pick. An LED gives its numbers as light (0..255 is how long it is on), so two colours blend
// as light does, then the blend is lifted back to the brightness of its ends: red to blue passes
// through a full purple, not a dim one, and never picks up a green the two do not have. Shared by
// the lights (server) and the menu's moving cards (browser): the same numbers in both.
((root, factory) => {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) { root.LightFxParts = root.LightFxParts || {}; root.LightFxParts.colour = api; }
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const clamp8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const wrap = (x) => ((x % 1) + 1) % 1;

  const peak = (c) => Math.max(c.r, c.g, c.b);
  // A blend of two colours, f of the way from a to b, as bright as its ends at that point.
  function mix(a, b, f) {
    // Rounded so a blend and its mirror (a to b at f, b to a at 1 - f) give the same LED.
    const k = Math.round(clamp01(f) * 1e9) / 1e9;
    const r = a.r + (b.r - a.r) * k, g = a.g + (b.g - a.g) * k, bl = a.b + (b.b - a.b) * k;
    const top = Math.max(r, g, bl);
    const lift = top > 0 ? (peak(a) + (peak(b) - peak(a)) * k) / top : 1;
    return { r: clamp8(r * lift), g: clamp8(g * lift), b: clamp8(bl * lift) };
  }
  // A colour at k of its strength. Scaled in light, as the LEDs give it.
  const dim = (c, k) => { const f = clamp01(k); return { r: clamp8(c.r * f), g: clamp8(c.g * f), b: clamp8(c.b * f) }; };
  // Two lights on the same LED: their light adds up.
  const add = (a, b) => ({ r: clamp8(a.r + b.r), g: clamp8(a.g + b.g), b: clamp8(a.b + b.b) });

  /**
   * A set of colours read once per frame, then sampled anywhere along it.
   * @param {{ r: number, g: number, b: number }[]} colours
   */
  function palette(colours) {
    const list = colours.length ? colours : [{ r: 255, g: 255, b: 255 }];
    const n = list.length;
    const at = (i, j, f) => (f <= 0 ? list[i] : f >= 1 ? list[j] : mix(list[i], list[j], f));
    return {
      list,
      size: n,
      // Round the loop: the last colour runs back into the first.
      loop(x) {
        if (n === 1) return list[0];
        const p = wrap(x) * n;
        const i = Math.floor(p);
        return at(i % n, (i + 1) % n, p - i);
      },
      // From the first colour to the last, for a scale or a strip with two ends.
      line(x) {
        if (n === 1) return list[0];
        const p = clamp01(x) * (n - 1);
        const i = Math.min(n - 2, Math.floor(p));
        return at(i, i + 1, p - i);
      },
      pick: (i) => list[((i % n) + n) % n],
    };
  }

  // A hue round the colour wheel, at full colour.
  function hue(h) {
    const k = (n) => (n + wrap(h) * 6) % 6;
    const ch = (n) => clamp8(255 * (1 - Math.max(0, Math.min(k(n), 4 - k(n), 1)) * 0.92));
    return { r: ch(5), g: ch(3), b: ch(1) };
  }

  const hex = (s) => ({ r: parseInt(s.slice(1, 3), 16), g: parseInt(s.slice(3, 5), 16), b: parseInt(s.slice(5, 7), 16) });
  // Ready palettes, as '#rrggbb' so a setting stores them as it stores any colour.
  const PALETTES = Object.freeze({
    sunset: Object.freeze(['#ff5e3a', '#ff2a68', '#7a2cff']),
    ocean: Object.freeze(['#00c6ff', '#0062ff', '#00e0b0']),
    neon: Object.freeze(['#ff00d4', '#00f0ff', '#7cff00']),
    forest: Object.freeze(['#1f9e3a', '#a8e05f', '#0b5d4b']),
    lava: Object.freeze(['#ff2a00', '#ff8a00', '#ffd000']),
    ice: Object.freeze(['#e8f7ff', '#7fd4ff', '#3a7bff']),
    sakura: Object.freeze(['#ffb3d1', '#ff5fa2', '#fff0f6']),
    aurora: Object.freeze(['#00ff9c', '#00b3ff', '#b14bff']),
  });
  const PALETTE_IDS = Object.freeze(Object.keys(PALETTES));

  return Object.freeze({ clamp8, clamp01, wrap, mix, dim, add, palette, hue, hex, PALETTES, PALETTE_IDS });
});
