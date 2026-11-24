'use strict';

// The calm light effects (light-fx.js lists them): slow, soft, never a dark gap that runs round.
// Each draw is (x 0..1 along the lights, i the LED's number, K the frame) -> colour; K and the
// helpers h are described in light-fx.js.
((root, factory) => {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory;
  if (root) { root.LightFxParts = root.LightFxParts || {}; root.LightFxParts.calm = factory; }
})(typeof window !== 'undefined' ? window : globalThis, (h) => {
  const { dim, mix, swell, bump, hash, drift, TAU, WHITE } = h;

  // A soft step from 0 to 1 between a and b.
  const step = (a, b, v) => { const f = h.clamp01((v - a) / (b - a)); return f * f * (3 - 2 * f); };

  return {
    still: (x, _i, K) => K.along(x),

    breathe: (x, _i, K) => K.lit(K.along(x), swell(K.t(4000, 1))),

    // The second colour comes in from the bottom while the first goes back to the top, and back,
    // brighter where they meet. One colour rises over its own dark, so the tide always shows.
    alternate: (x, _i, K) => {
      const tide = 0.15 + 0.7 * swell(K.t(6000));
      const at = K.from(x);
      const low = K.ncol > 1 ? K.c1 : dim(K.c0, 0.2);
      return dim(mix(K.c0, low, step(tide - 0.3, tide + 0.3, at)), 0.5 + 0.5 * bump(at - tide, 0.18));
    },

    aurora: (x, _i, K) => {
      const t = K.t(11000);
      const curtains = 1 + Math.round(2 * K.size);
      const glow = swell(x * curtains + t + 0.25 * Math.sin(TAU * (x + t * 2)));
      return K.lit(K.along(x + 0.18 * Math.sin(TAU * t)), 0.25 + 0.75 * glow);
    },

    // Each LED flickers on its own, with a slower sway under it, as a flame does: deeper and
    // redder as it sinks. The quick flicker stays small, so it never flashes.
    candle: (x, i, K) => {
      // Faster makes it livelier, never a flicker quicker than as made.
      const pace = Math.max(K.pace, 1);
      const flick = drift(i, K.now / (110 * pace));
      const sway = drift(i + 97, K.now / (900 * K.pace));
      const k = 0.3 + 0.22 * flick + 0.48 * sway;
      const c = K.along(x);
      return K.lit(mix(c, { r: c.r, g: c.g * 0.45, b: c.b * 0.2 }, 1 - k), k);
    },

    // A few LEDs at a time light up softly and go out again, each in its own time.
    starry: (x, i, K) => {
      const period = 2600 + 2600 * hash(i, 3);
      const run = K.now / (period * K.pace) + hash(i, 11);
      // On a few LEDs each one is a star more often, so a single light still twinkles.
      const lit = hash(i, Math.floor(run)) < Math.max(0.1 + 0.45 * K.size, 2 / K.count);
      const twinkle = lit ? swell(run - Math.floor(run)) ** 3 : 0;
      return K.lit(mix(K.along(x), WHITE, 0.35 * twinkle), twinkle);
    },

    // Slow blobs of the colours drift round at their own pace, swell and shrink, and melt into
    // each other, with dark between them so one colour still shows them moving.
    lava: (x, _i, K) => {
      const t = K.now / (6000 * K.pace) + K.phase;
      const width = 0.07 + 0.16 * K.size;
      let out = { r: 0, g: 0, b: 0 };
      let total = 0;
      for (let j = 0; j < 3; j++) {
        const centre = hash(j, 5) + t * [0.21, -0.15, 0.11][j];
        const w = bump(K.dist(x, centre), width * (0.7 + 0.6 * swell(t * 0.4 + j / 3)));
        out = total + w > 0 ? mix(out, K.pick(j), w / (total + w)) : out;
        total += w;
      }
      return dim(out, K.glow + (1 - K.glow) * Math.min(1, total));
    },

    // Every light together, from one colour to the next, dimming a little as it changes so colours
    // alike still show it; one colour goes round the colour wheel.
    shift: (_x, _i, K) => {
      if (K.ncol < 2) return h.hue(K.t(14000));
      const p = K.now / (3200 * K.pace) + K.phase * K.ncol;
      const k = Math.floor(p);
      return dim(mix(K.pick(k), K.pick(k + 1), step(0.35, 0.65, p - k)), 1 - 0.45 * bump(p - k - 0.5, 0.15));
    },
  };
});
