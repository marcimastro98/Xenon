// album-theme.js — derive a vibrant accent colour from the now-playing album art.
//
// Pure client side: the SMTC thumbnail arrives as a same-origin data: URL, so we
// can draw it to a canvas and read its pixels without tainting. media.js calls
// extractAlbumAccent(thumbUrl) and gets { accent, led }: `accent` is the
// UI-readable variant (settings.js applies it as a runtime-only override of
// --accent — the user's saved accent is never touched), `led` is the same hue at
// full vividness for the RGB lighting bridge. When no usable colour can be found
// we resolve to null so the caller restores the user's theme.

(() => {
  'use strict';

  const SAMPLE = 48;            // downscale the cover to SAMPLE×SAMPLE before sampling
  const MIN_ALPHA = 125;        // ignore mostly-transparent pixels
  const MIN_SAT = 0.15;         // a pixel below this is treated as greyscale (no colour)
  const SKIP_DARK = 0.07;       // ignore near-black pixels
  const SKIP_LIGHT = 0.96;      // ignore near-white pixels
  // Monochrome guard: covers with no real colour fall back to the user's theme
  // instead of amplifying JPEG noise into an arbitrary vivid hue. Kept fairly
  // permissive — dark/muted covers (very common) should still yield their hue.
  const MONO_MIN_SAT = 0.16;    // the winning swatch must be at least this colourful
  const MONO_MIN_RATIO = 0.025; // …and colourful pixels must carry this share of weight
  // Final accent is nudged into a band that reads well as an action colour, while
  // keeping the source hue (the strongest coherence cue) intact.
  const ACCENT_MIN_SAT = 0.42;
  const ACCENT_MAX_SAT = 0.85;
  const ACCENT_MIN_LIGHT = 0.42;
  const ACCENT_MAX_LIGHT = 0.62;
  // LED variant: RGB LEDs render the accent band above as a washed-out pastel
  // (mid lightness ≈ adding white), making every cover look alike. LEDs get the
  // SAME hue at full vividness instead — high saturation, l=0.5 (full value).
  const LED_MIN_SAT = 0.80;
  const LED_LIGHT = 0.5;
  // LED palette: up to 3 cover colours for the per-LED gradient. Secondary
  // colours must be a genuinely different hue (≥40° on the wheel), reasonably
  // colourful, and carry real weight in the artwork — otherwise JPEG noise
  // would smear random stripes across the LEDs.
  const PALETTE_MAX = 3;
  const PALETTE_HUE_DIST = 40 / 360;
  const PALETTE_MIN_SCORE = 0.10;  // share of the dominant bin's score
  const PALETTE_MIN_SAT = 0.20;

  let _canvas = null;
  let _cacheKey = '';
  let _cacheVal = null;

  function getCtx() {
    if (!_canvas) _canvas = document.createElement('canvas');
    _canvas.width = SAMPLE;
    _canvas.height = SAMPLE;
    return _canvas.getContext('2d', { willReadFrequently: true });
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    if (s === 0) {
      const v = Math.round(l * 255);
      return [v, v, v];
    }
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, h) * 255),
      Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    ];
  }

  const toHex = (r, g, b) =>
    '#' + [r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');

  // Pick a colour that's genuinely present in the cover, then nudge it into a
  // readable accent band. Pixels are grouped into coarse colour bins (so similar
  // shades average together instead of smearing across the whole hue wheel), and
  // each bin is scored by how *populous* and how *colourful* it is, preferring
  // mid-lightness. This keeps the hue coherent with the artwork rather than
  // chasing a handful of rare saturated pixels. Returns null when the cover is
  // essentially greyscale so the caller restores the user's theme.
  function pickAccent(data) {
    const bins = new Map();
    let totalWeight = 0, colourfulWeight = 0;

    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < MIN_ALPHA) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const [, s, l] = rgbToHsl(r, g, b);
      if (l < SKIP_DARK || l > SKIP_LIGHT) continue;
      totalWeight++;
      if (s >= MIN_SAT) colourfulWeight++;
      // 4 bits per channel → group near-identical colours into the same bin.
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      let bin = bins.get(key);
      if (!bin) { bin = { n: 0, r: 0, g: 0, b: 0 }; bins.set(key, bin); }
      bin.n++; bin.r += r; bin.g += g; bin.b += b;
    }
    if (!totalWeight) return null;

    const scored = [];
    for (const bin of bins.values()) {
      const [h, s, l] = rgbToHsl(bin.r / bin.n, bin.g / bin.n, bin.b / bin.n);
      const lumaWeight = 1 - Math.abs(l - 0.5) * 1.1; // peak at mid lightness
      if (lumaWeight <= 0) continue;
      // Population matters, but emphasise saturation so a smaller colourful
      // region beats a large flat grey background.
      scored.push({ h, s, l, score: bin.n * Math.pow(s, 1.7) * lumaWeight });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    // Greyscale / near-monochrome cover → let the user's theme stand.
    if (best.s < MONO_MIN_SAT || colourfulWeight / totalWeight < MONO_MIN_RATIO) return null;

    // Secondary palette colours: walk the scored bins (already sorted) and keep
    // the strongest ones whose hue is genuinely distinct from everything chosen.
    const chosen = [best];
    for (const cand of scored) {
      if (chosen.length >= PALETTE_MAX) break;
      if (cand.score < best.score * PALETTE_MIN_SCORE) break; // sorted → rest is weaker
      if (cand.s < PALETTE_MIN_SAT) continue;
      const distinct = chosen.every(c => {
        let d = Math.abs(c.h - cand.h);
        if (d > 0.5) d = 1 - d;                 // hue wraps around the wheel
        return d >= PALETTE_HUE_DIST;
      });
      if (distinct) chosen.push(cand);
    }

    const s = Math.min(ACCENT_MAX_SAT, Math.max(best.s, ACCENT_MIN_SAT));
    const l = Math.min(ACCENT_MAX_LIGHT, Math.max(best.l, ACCENT_MIN_LIGHT));
    const [r, g, b] = hslToRgb(best.h, s, l);
    const vivid = (c) => toHex(...hslToRgb(c.h, Math.min(1, Math.max(c.s, LED_MIN_SAT)), LED_LIGHT));
    return { accent: toHex(r, g, b), led: vivid(best), ledPalette: chosen.map(vivid) };
  }

  // Resolve to { accent, led } hex strings (UI-readable and LED-vivid variants of
  // the same hue), or null when nothing usable was found.
  function extractAlbumAccent(thumbUrl) {
    if (!thumbUrl) return Promise.resolve(null);
    if (thumbUrl === _cacheKey) return Promise.resolve(_cacheVal);

    return new Promise(resolve => {
      const img = new Image();
      // Covers can be remote URLs (e.g. Apple's mzstatic CDN) as well as inline
      // data: URLs. Request CORS so the canvas stays readable for cross-origin
      // images; data:/same-origin sources ignore this harmlessly. If a remote
      // host serves no CORS headers the load simply errors and we fall back.
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const ctx = getCtx();
          ctx.clearRect(0, 0, SAMPLE, SAMPLE);
          ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
          const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
          const pair = pickAccent(data);
          _cacheKey = thumbUrl;
          _cacheVal = pair;
          resolve(pair);
        } catch (e) {
          resolve(null); // tainted canvas or decode issue — fall back to user theme
        }
      };
      img.onerror = () => resolve(null);
      img.src = thumbUrl;
    });
  }

  if (typeof window !== 'undefined') window.extractAlbumAccent = extractAlbumAccent;
  // Node (unit tests): expose the DOM-free extraction logic.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { pickAccent, rgbToHsl, hslToRgb };
  }
})();
