'use strict';

// The light effects that follow something (light-fx.js lists them and what each needs): the
// music the PC plays, a reading, the clock, how hard the PC works, the fans, today's sky, the
// weather outside, a running timer. K.in holds what is known now, null where it is not; every
// effect still draws something sensible without it. Draws as in light-fx-calm.js.
((root, factory) => {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory;
  if (root) { root.LightFxParts = root.LightFxParts || {}; root.LightFxParts.pc = factory; }
})(typeof window !== 'undefined' ? window : globalThis, (h) => {
  const { dim, mix, add, swell, bump, hash, wrap, clamp01, hex, WHITE, WARM, HOT } = h;

  // Today's sky through the day, by minutes from sunrise (rise) and sunset (set):
  // [when, minutes from it, top of the sky, horizon, how bright].
  /** @type {Array<[string, number, string, string, number]>} */
  const KEYS = [
    ['rise', -75, '#0a1640', '#1a2a6a', 0.3],
    ['rise', -20, '#2b3a8c', '#ff6a4a', 0.55],
    ['rise', 25, '#7fb2ff', '#ffb070', 0.85],
    ['rise', 120, '#8fd0ff', '#fff1d0', 1],
    ['set', -120, '#8fd0ff', '#fff1d0', 1],
    ['set', -25, '#ffb35c', '#ff6a3a', 0.9],
    ['set', 20, '#5a2c91', '#ff4e3a', 0.7],
    ['set', 75, '#0a1640', '#1a2a6a', 0.3],
  ];
  const SKY = KEYS.map(([from, mins, top, low, bright]) => ({ from, mins, top: hex(top), low: hex(low), bright }));
  const DAY = 1440;

  function skyNow(K) {
    const d = new Date(K.now);
    const at = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
    const rise = K.in.sky?.rise ?? 390;
    const set = K.in.sky?.set ?? 1140;
    // Every time counted from the first key (night before dawn), so a sunrise near midnight or a
    // day said from anywhere on the clock still reads in order.
    const from = rise + SKY[0].mins;
    const since = (m) => ((m - from) % DAY + DAY) % DAY;
    const keys = SKY.map((k) => ({ ...k, at: since((k.from === 'rise' ? rise : set) + k.mins) }));
    const t = since(at);
    // The last key before now and the next one, round midnight.
    let j = 0;
    while (j + 1 < keys.length && keys[j + 1].at <= t) j++;
    const a = keys[j];
    const b = keys[(j + 1) % keys.length];
    const span = (b.at - a.at + DAY) % DAY || DAY;
    const f = clamp01((t - a.at) / span);
    return { top: mix(a.top, b.top, f), low: mix(a.low, b.low, f), bright: a.bright + (b.bright - a.bright) * f };
  }

  // What each kind of weather looks like, drawn by another effect in its own colours.
  const WEATHER = {
    clear: { effect: 'lava', colours: ['#ffd27a', '#ffb347', '#fff1c4'], size: 0.7 },
    night: { effect: 'starry', colours: ['#9fb7ff', '#ffffff'], size: 0.5, glow: 0.06 },
    clouds: { effect: 'lava', colours: ['#7f8fa6', '#c9d3e0', '#56657d'], size: 0.8 },
    fog: { effect: 'breathe', colours: ['#a9b4c2'], speed: 25, glow: 0.35 },
    rain: { effect: 'rain', colours: ['#3a8dff', '#0b1f4a'], size: 0.6, glow: 0.2 },
    snow: { effect: 'starry', colours: ['#ffffff', '#bfe3ff'], size: 0.9, glow: 0.12 },
    storm: { effect: 'lava', colours: ['#2a3550', '#56657d', '#141a2a'], size: 0.8 },
  };
  const LIGHTNING_MS = 2600;

  return {
    beat: (x, _i, K) => {
      const s = K.in.sound;
      if (s == null) return K.along(x);
      return K.lit(K.along(x + 0.12 * s), Math.sqrt(s));
    },

    // From the bottom of a ring up both sides (from the start of a strip), cool to hot.
    meter: (x, _i, K) => {
      const up = 1 - K.from(x, true);
      const scale = K.memo('scale', () => h.palette([K.c0, WARM, HOT]));
      return K.lit(scale.line(up), clamp01(((K.in.sound ?? 0) * 1.02 - up) * K.count * 0.5 + 0.5));
    },

    // A scale lit LED by LED up to the reading, from the first colour to the last.
    level: (_x, i, K) => {
      const along = K.palette.line(K.count > 1 ? i / (K.count - 1) : 0);
      const lv = K.in.level;
      return lv == null ? along : K.lit(along, clamp01(lv * K.count - i));
    },

    heat: (_x, _i, K) => {
      const lv = K.in.level ?? 0;
      const colour = K.memo('heat', () => h.palette([K.c0, WARM, HOT]).line(lv));
      return dim(colour, 1 - (0.15 + 0.35 * lv) * swell(K.t(lv > 0.75 ? 1400 : 3200, 1)));
    },

    // An arc from the top for the hours, a dot for the minutes, a spark with a short tail for the seconds.
    clock: (x, _i, K) => {
      const hands = K.memo('hands', () => {
        const d = new Date(K.now);
        const s = (d.getSeconds() + d.getMilliseconds() / 1000) / 60;
        const m = (d.getMinutes() + s) / 60;
        return { s, m, hr: ((d.getHours() % 12) + m) / 12 };
      });
      const pos = K.ring ? wrap(x) : x;
      const arc = 0.3 * (pos <= hands.hr ? 1 : clamp01(1 - (pos - hands.hr) * K.count));
      const out = add(K.lit(K.c0, arc), dim(K.c1, bump(K.dist(x, hands.m), 0.035)));
      return add(out, dim(WHITE, 0.9 * K.tail(x, hands.s, 0.06)));
    },

    // A tail that goes round faster, and warmer, the harder the PC works.
    load: (x, _i, K) => {
      const lv = K.in.load ?? 0;
      const head = K.turn(0.12 + 1.1 * lv);
      const colour = K.memo('load', () => mix(K.c0, K.ncol > 1 ? K.c1 : HOT, lv ** 1.5));
      return K.lit(colour, K.tail(x, head, 0.2 + 0.5 * K.size));
    },

    // Blades of light that turn with the fans: still when they stop.
    fans: (x, _i, K) => {
      const blades = 2 + Math.round(2 * K.size);
      const head = K.turn(Math.min(1.5, (K.in.fans ?? 0) / 1400), blades);
      let lit = 0;
      for (let b = 0; b < blades; b++) lit = Math.max(lit, K.tail(x, head + b / blades, 0.5 / blades));
      return K.lit(K.along(x - head), lit);
    },

    // The sky above the horizon at the bottom of a ring (the start of a strip), stars at night.
    sky: (x, i, K) => {
      const sky = K.memo('sky', () => skyNow(K));
      const up = 1 - K.from(x, true);
      let out = dim(mix(sky.low, sky.top, up ** 0.7), sky.bright);
      const night = clamp01((0.6 - sky.bright) / 0.3);
      if (night > 0) {
        const run = K.now / 2600 + hash(i, 11);
        const star = hash(i, Math.floor(run)) < 0.18 ? swell(run - Math.floor(run)) ** 3 : 0;
        out = add(out, dim(WHITE, 0.45 * star * night * up));
      }
      // By day a cloud's shadow drifts across, so the sky is alive in daylight too.
      return dim(out, 1 - 0.4 * (1 - night) * bump(K.dist(x, K.t(9000)), 0.18));
    },

    weather: (x, i, K) => {
      const w = K.in.weather;
      const look = !w ? null : w.kind === 'clear' && w.night ? WEATHER.night : WEATHER[w.kind];
      if (!look) return K.lit(K.along(x), 0.3);
      const W = K.memo('look', () => K.with(look.effect, { colours: look.colours.map(hex), size: look.size, glow: look.glow, speed: look.speed ?? 50 }));
      const out = h.draw(look.effect)(x, i, W);
      if (w.kind !== 'storm') return out;
      // Dark clouds and now and then lightning: one flash that fades, one in each slot at most.
      const slot = Math.floor(K.now / LIGHTNING_MS);
      const into = K.now - slot * LIGHTNING_MS;
      const flash = hash(slot, 29) < 0.35 ? (into < 60 ? bump(into - 60, 40) : Math.exp(-(into - 60) / 220)) : 0;
      return mix(out, WHITE, flash * 0.85);
    },

    // The lights empty as the timer runs down, warmer and breathing in its last part.
    timer: (_x, i, K) => {
      const t = K.in.timer;
      // No timer running: full and breathing slowly, ready.
      if (!t) return K.lit(K.c0, 0.55 + 0.45 * swell(K.t(6000)));
      const late = clamp01(1 - t.left / 0.25);
      const colour = K.memo('timer', () => (K.ncol > 1 ? K.palette.line(1 - t.left) : mix(K.c0, WARM, late)));
      const pulse = t.left < 0.1 ? 0.6 + 0.4 * swell(K.t(1200, 1)) : 1;
      return K.lit(colour, clamp01(t.left * K.count - i) * pulse);
    },
  };
});
