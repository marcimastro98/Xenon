;((root, factory) => {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitColor = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  /* Colour maths for personal Bits. Palettes are designed in OKLCH because
   * equal steps there look equal to the eye, so 16 hues at one lightness read
   * as one family. Contrast is WCAG's, the same rule the app's themes use. */

  const clamp01 = (v) => Math.min(1, Math.max(0, v));

  function toGamma(c) {
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  function toLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function oklabToLinearRgb(L, a, b) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ];
  }

  function inGamut(rgb) {
    return rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);
  }

  function hex(rgb) {
    return '#' + rgb.map((c) => Math.round(clamp01(toGamma(c)) * 255).toString(16).padStart(2, '0')).join('');
  }

  /**
   * OKLCH to '#rrggbb'. Out-of-gamut colours keep lightness and hue and lose
   * chroma until they fit, so a vivid blue never turns into a different blue.
   * @param {number} L 0..1  @param {number} C chroma  @param {number} h degrees
   */
  function oklch(L, C, h) {
    const rad = (((h % 360) + 360) % 360) * (Math.PI / 180);
    const at = (c) => oklabToLinearRgb(L, c * Math.cos(rad), c * Math.sin(rad));
    let rgb = at(C);
    if (inGamut(rgb)) return hex(rgb);
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(at(mid))) lo = mid;
      else hi = mid;
    }
    rgb = at(lo);
    return hex(rgb);
  }

  function parseHex(value) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(value));
    if (!m) throw new Error(`Not a colour: ${value}`);
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  /** '#rrggbb' to [L, C, h], for deriving shades of a fixed brand colour. */
  function toOklch(value) {
    const [r, g, b] = parseHex(value).map((c) => toLinear(c / 255));
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    const h = (Math.atan2(bb, a) * 180) / Math.PI;
    return [L, Math.hypot(a, bb), (h + 360) % 360];
  }

  function luminance(value) {
    const [r, g, b] = parseHex(value).map((c) => toLinear(c / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /** WCAG contrast ratio between two '#rrggbb' colours, 1..21. */
  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  /** '#rrggbb' to 'r,g,b', the form bit.js tints take. */
  function triplet(value) {
    return parseHex(value).join(',');
  }

  return { oklch, toOklch, contrast, luminance, parseHex, triplet };
});
