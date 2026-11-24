// The 'live' colours of a line (pump-faces.js COLOR_SETS): each of a face's four colours follows
// what its part shows. A reading goes from cool to hot as it works harder (face-kit.js strain), so
// a ring, a bar or a number warms with its own value; a clock takes the light of the hour; a song
// and a picture their own colours, which face-colors.js reads off the face. Colours move in steps,
// so the ring of lights that follows them is told a new one only when it shows.
// Joins window.PumpFaceKit as the part "live"; no global.
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;
  const Faces = window.PumpFaces;
  // From cool to hot (pump-faces.js LIVE_RAMP: a calm sky, Xenon's green, amber, red), each at its point.
  const RAMP = Object.freeze([0, 0.4, 0.7, 1].map((at, i) => [at, Faces.LIVE_RAMP[i]]));
  const STEPS = 20;
  // The light of the day on a clock, by the hour it is at its fullest; between two, a mix.
  const DAY = Object.freeze([
    [1, ['#8a7dff', '#5b8cff', '#ff5c6c', '#c3b5ff']],
    [7, ['#ffb38a', '#ffd7a0', '#ff5c6c', '#ffc2d1']],
    [13, ['#7fd7ff', '#ffe08a', '#ff5c6c', '#bfefff']],
    [19, ['#ff8a5c', '#d68bff', '#ff4d6d', '#ffc29e']],
  ]);
  const QUARTERS = 4;   // the clock's colours change each quarter of an hour
  // The faces whose colours are read off what they show.
  const READ = Object.freeze(['music', 'picture']);

  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, f) => { const x = rgb(a); const y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * f)); };

  // A strain 0..1 on the ramp, in STEPS.
  function heat(s) {
    const v = Math.round(Kit.clamp01(s) * STEPS) / STEPS;
    for (let i = 1; i < RAMP.length; i++) {
      const [to, b] = RAMP[i];
      const [from, a] = RAMP[i - 1];
      if (v <= to) return mix(a, b, (v - from) / (to - from));
    }
    return RAMP[RAMP.length - 1][1];
  }

  function daylight(at) {
    const h = at.getHours() + Math.floor(at.getMinutes() / (60 / QUARTERS)) / QUARTERS;
    const next = DAY.findIndex(([peak]) => peak > h);
    const b = DAY[Math.max(0, next)];
    const a = DAY[(next < 0 ? DAY.length : next) - 1] || DAY[DAY.length - 1];
    const span = (b[0] - a[0] + 24) % 24 || 24;
    const f = ((h - a[0] + 24) % 24) / span;
    return a[1].map((c, i) => mix(c, b[1][i], f));
  }

  // show: the face as normalized. Returns (data) => four colours now, or null when they come from
  // what the face shows (a song, a picture) or there is nothing to follow yet.
  function create(show) {
    if (READ.includes(show.face)) return () => null;
    if (show.face === 'clock') return () => daylight(new Date());
    if (show.face !== 'sensors' && show.face !== 'game') return () => null;
    const base = Faces.colorsOf('xenon');
    const names = Array.isArray(show.readings) ? show.readings : [];
    return (data) => {
      if (!data?.system) return null;
      return base.map((c, i) => {
        const s = names[i] ? Kit.strain(Kit.reading(names[i], data.system)) : null;
        return s == null ? c : heat(s);
      });
    };
  }

  Kit.add('part', 'live', create);
})();
