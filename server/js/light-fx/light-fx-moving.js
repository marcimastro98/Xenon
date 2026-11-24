'use strict';

// The light effects that move round the lights (light-fx.js lists them). Every head is soft over
// two or three LEDs, so a light glides instead of jumping from one LED to the next, and nothing
// flashes the whole set more than three times a second. Draws as in light-fx-calm.js.
((root, factory) => {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory;
  if (root) { root.LightFxParts = root.LightFxParts || {}; root.LightFxParts.moving = factory; }
})(typeof window !== 'undefined' ? window : globalThis, (h) => {
  const { dim, mix, add, swell, bump, hash, drift, wrap, hue, WHITE, WARM } = h;

  const FIRE_PACE = 1;

  return {
    spin: (x, _i, K) => {
      const head = K.t(2400);
      return K.lit(K.along(x - head), K.tail(x, head, 0.15 + 0.6 * K.size));
    },

    // The colours go round, every LED lit: brightest on each colour, never dark, so the turn shows with one colour or colours alike.
    turn: (x, _i, K) => {
      const at = x - K.t(5000);
      return dim(K.along(at), 0.4 + 0.6 * swell(0.5 + at * Math.max(2, K.ncol)));
    },

    comet: (x, _i, K) => {
      const lit = K.tail(x, K.t(1800), 0.1 + 0.5 * K.size);
      return K.lit(mix(K.c1, K.c0, lit), lit);
    },

    orbit: (x, _i, K) => {
      const head = K.t(2600);
      const long = 0.08 + 0.3 * K.size;
      const a = dim(K.c0, K.tail(x, head, long));
      const b = dim(K.c1, K.tail(x, head + 0.5, long));
      return add(add(a, b), dim(K.pick(2), K.glow));
    },

    // From one end to the other and back; on a ring, down both sides at once.
    scanner: (x, _i, K) => {
      const p = K.t(2200, 3);
      const at = p < 0.5 ? p * 2 : 2 - p * 2;
      return K.lit(K.along(at), bump(K.from(x) - at, 0.06 + 0.2 * K.size));
    },

    // Lights in small groups step forward together, like a theatre sign.
    // One LED in each group lights at a time, so a step never lights the whole set: three a second at most.
    chase: (x, i, K) => {
      const gap = 2 + Math.round(2 * K.size);
      const step = K.now / Math.max(170 * K.pace, 340 / gap) + K.phase * gap;
      const on = (((i - Math.floor(step)) % gap) + gap) % gap === 0;
      return K.lit(K.along(x), on ? 1 - 0.4 * (step - Math.floor(step)) : 0);
    },

    bands: (x, _i, K) => K.lit(K.along(x), swell(x * (1 + Math.round(2 * K.size)) - K.t(2000))),

    // The lights fill one by one, stay full a moment, then empty; the next colour each time.
    fill: (x, _i, K) => {
      const run = K.now / (4200 * K.pace) + K.phase;
      const p = run - Math.floor(run);
      const pos = K.ring ? wrap(x) : x;
      const on = p < 0.4 ? pos <= p / 0.4 : p < 0.5 ? true : p < 0.9 ? pos > (p - 0.5) / 0.4 : false;
      return K.lit(K.pick(Math.floor(run)), on ? 1 : 0);
    },

    // Rings of light spread from the top (from the middle on a strip), a new colour each time.
    ripple: (x, _i, K) => {
      const run = K.now / (1900 * K.pace) + K.phase;
      const r = run - Math.floor(run);
      const d = K.ring ? K.from(x) : Math.abs(x - 0.5) * 2;
      return K.lit(K.pick(Math.floor(run)), bump(d - r, 0.05 + 0.18 * K.size) * (1 - r * 0.6));
    },

    // Each LED keeps its own beat and glints at most once in it: never more than three a second.
    sparkle: (x, i, K) => {
      const run = K.now / Math.max(440 * K.pace, h.FLASH_GAP) + hash(i, 3);
      const slot = Math.floor(run);
      const glint = hash(i, slot) < 0.1 + 0.4 * K.size ? (1 - (run - slot)) ** 2 : 0;
      return mix(K.lit(K.along(x), 0), WHITE, glint * 0.6);
    },

    // Along a strip the last LED stops a step short of the first one's hue, so no two match.
    rainbow: (x, _i, K) => hue((K.ring ? x : (x * (K.count - 1)) / K.count) * Math.max(1, Math.round(3 * K.size - 0.5)) + K.t(5200)),

    // Two beats and a rest, never more than three a second.
    heartbeat: (x, _i, K) => {
      const p = K.t(1250, 3);
      return K.lit(K.along(x), Math.max(bump(p - 0.08, 0.05), 0.6 * bump(p - 0.3, 0.05)));
    },

    // Flames rise from the bottom of a ring (the start of a strip), hot at the root. Faster speeds
    // make the flames taller and livelier, never a flicker quicker than as made.
    fire: (x, i, K) => {
      const height = 1 - K.from(x, true);
      const flick = Math.max(K.pace, FIRE_PACE);
      const reach = (0.3 + 0.55 * K.size) * (0.75 + 0.25 * drift(i, K.now / (260 * flick)));
      const heat = h.clamp01(1 - height / reach) * (0.8 + 0.2 * drift(i + 41, K.now / (60 * flick)));
      const scale = [dim(K.c0, 0.2), K.c0, K.ncol > 1 ? K.c1 : WARM, mix(K.ncol > 2 ? K.pick(2) : WARM, WHITE, 0.5)];
      return K.lit(h.palette(scale).line(heat), heat > 0.02 ? 1 : 0);
    },

    // Drops slide down from the top of a ring (from the end of a strip) and fade out.
    rain: (x, _i, K) => {
      const drops = 2 + Math.round(6 * K.size);
      // Spread out in time, and slow enough that no LED sees more than three a second.
      const run = K.now / Math.max(1700 * K.pace, (drops * h.FLASH_GAP) / 0.7) + K.phase;
      let lit = 0;
      for (let j = 0; j < drops; j++) {
        const own = run + (j + 0.3 * hash(j, 17)) / drops;
        const cycle = Math.floor(own);
        const fall = (own - cycle) ** 1.4;
        const left = hash(j, cycle) < 0.5;
        const at = K.ring ? (left ? 1 - fall / 2 : fall / 2) : 1 - fall;
        lit = Math.max(lit, bump(K.dist(x, at), 0.04) * (1 - 0.5 * fall));
      }
      return add(dim(K.c1, K.glow), dim(K.c0, lit));
    },

    // One wide beam turns slowly with a bright core, as from a lighthouse.
    lighthouse: (x, _i, K) => {
      const d = K.dist(x, K.t(5200));
      const width = 0.04 + 0.2 * K.size;
      const core = bump(d, width);
      const beam = Math.max(core, 0.35 * bump(d, width * 2.6));
      return K.lit(mix(K.c0, WHITE, 0.3 * core), beam);
    },
  };
});
