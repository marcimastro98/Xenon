// Bit kit for Xenon widgets: the Bit engine and XenonBit.mount(host).set(bitStreamData).
// Copy it into your widget package and load it before your own script. See docs/WIDGET_SDK.md, "Your own Bit".

// ---- bit-clips.js
;(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitClips = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Bit, drawn. Every pose and animation of Xenon's guardian as plain data:
   * cells on Bit's 12x12 grid, frames with a duration, nothing that draws.
   * bit.js turns a frame into rectangles; the app, the site, the Maker and the
   * export tool all read the same data, so Bit moves the same everywhere.
   *
   * THE BODY NEVER CHANGES (brand rule). What Bit does shows in its face, in
   * what it holds or wears, in what floats around it and in its color.
   *
   * Coordinates are Bit's grid: the body spans x 2..9, y 0..10 (antenna on
   * top, feet on y 10), the floor is y 11. The stage around it runs x -3..14,
   * y -5..12, so hats, sparks and rain have room. A cell is [x, y, w, h].
   *
   * A frame: { ms, eyes, mouth, brows, cheeks, ex, dx, dy, sx, sy, tint, glitch }
   *   eyes/mouth/brows name a shape below (defaults: open, flat, none);
   *   ex lists extras: 'name' or ['name', dx, dy, opacity];
   *   dx/dy move the body, sx/sy squash it from the feet (sx < 0 mirrors);
   *   tint names a mood color or 'r,g,b'; glitch splits the body in color.
   * A clip: { id, kind: mood|fidget|react, frames, loop, when, weight, rare }.
   */

  const INK = '#0d1117';

  const MOOD_RGB = Object.freeze({
    idle: '255,215,94',
    listen: '255,215,94',
    think: '180,160,255',
    work: '110,231,135',
    done: '110,231,135',
    happy: '110,231,135',
    worry: '255,166,87',
    angry: '255,90,95',
    sleep: '138,180,248',
    hot: '255,128,96',
    cold: '150,205,255',
    w0: '110,231,135',
    w1: '94,234,212',
    w2: '125,211,252',
    w3: '255,215,94',
  });

  const BODY = [[6, 0], [6, 1], [3, 2, 6], [2, 3, 8, 6], [3, 9, 6], [3, 10, 2], [7, 10, 2]];

  const EYES = Object.freeze({
    open: [[4, 4, 1, 2], [7, 4, 1, 2]],
    blink: [[4, 5], [7, 5]],
    happy: [[3, 5], [4, 4], [5, 5], [6, 5], [7, 4], [8, 5]],
    up: [[5, 4], [8, 4]],
    left: [[3, 4, 1, 2], [6, 4, 1, 2]],
    right: [[5, 4, 1, 2], [8, 4, 1, 2]],
    down: [[4, 6], [7, 6]],
    wide: [[3, 4, 2, 2], [7, 4, 2, 2]],
    wink: [[3, 5], [4, 4], [5, 5], [7, 4, 1, 2]],
    squint: [[3, 5, 2], [7, 5, 2]],
    dizzy: [[3, 4], [5, 4], [4, 5], [3, 6], [5, 6], [7, 4], [9, 4], [8, 5], [7, 6], [9, 6]],
    hearts: { fill: '#ff5a6e', cells: [[3, 4], [5, 4], [3, 5, 3], [4, 6], [7, 4], [9, 4], [7, 5, 3], [8, 6]] },
    shades: [[3, 4, 2, 2], [7, 4, 2, 2], [5, 4, 2, 1]],
    stars: { fill: '#ffe58a', cells: [[4, 4], [3, 5, 3], [4, 6], [7, 4], [6, 5, 3], [7, 6]] },
    none: [],
  });

  const MOUTHS = Object.freeze({
    flat: [[5, 7, 2]],
    smile: [[4, 7], [5, 8, 2], [7, 7]],
    grin: [[3, 7], [4, 8, 4], [8, 7]],
    open: [[5, 7, 2, 2]],
    yawn: [[4, 6, 4, 3]],
    sad: [[4, 8], [5, 7, 2], [7, 8]],
    low: [[5, 8, 2]],
    wavy: [[4, 8], [5, 7], [6, 8], [7, 7]],
    whistle: [[6, 7]],
    none: [],
  });

  const BROWS = Object.freeze({
    up: [[4, 3], [7, 3]],
    angry: [[3, 3, 2], [7, 3, 2]],
    none: [],
  });

  const CHEEKS = { fill: '#ff8fa3', cells: [[2, 6], [9, 6]], opacity: 0.85 };

  // Extras. attach: false = the part stays put while the body moves (rain,
  // stars, a UFO); back: true = drawn behind the body.
  const P = (fill, cells, opts) => Object.freeze({ fill, cells, attach: true, back: false, ...opts });
  const SPARK = '#ffe58a';
  const PARTS = Object.freeze({
    spark: P(SPARK, [[6, -2], [5, -1], [7, -1]]),
    sparkBig: P(SPARK, [[6, -4], [6, -3], [4, -1], [8, -1], [6, -2], [5, -1], [7, -1]]),
    armsOut: P('body', [[0, 6, 2], [10, 6, 2]]),
    armsUp: P('body', [[1, 4], [0, 3], [10, 4], [11, 3]]),
    armL: P('body', [[1, 4], [0, 3]]),
    armR: P('body', [[10, 4], [11, 3]]),
    armLOut: P('body', [[0, 6, 2]]),
    armROut: P('body', [[10, 6, 2]]),
    waveA: P('body', [[10, 5], [11, 4], [12, 3]]),
    waveB: P('body', [[10, 5], [11, 4], [11, 3]]),
    dot1: P('body', [[9, 1]]),
    dot2: P('body', [[10, 0]]),
    dot3: P('body', [[11, -1]]),
    z: P('#8ab4f8', [[0, 0, 3], [1, 1], [0, 2, 3]], { attach: false }),
    zSmall: P('#8ab4f8', [[0, 0, 2], [0, 1, 2]], { attach: false }),
    sweat: P('#4fc3f7', [[10, 4]]),
    tear: P('#7dd3fc', [[4, 6]]),
    waveIn: P('body', [[0, 5, 1, 2], [11, 5, 1, 2]]),
    waveOut: P('body', [[-2, 4, 1, 4], [13, 4, 1, 4]], { opacity: 0.6 }),
    note: P('#b4a0ff', [[0, 2, 2, 2], [1, -1, 1, 3], [2, -1]], { attach: false }),
    heart: P('#ff5a6e', [[0, 0], [2, 0], [0, 1, 3], [1, 2]], { attach: false }),
    star: P('#ffffff', [[1, 0], [0, 1, 3], [1, 2]], { attach: false }),
    dot: P('#ffffff', [[0, 0]], { attach: false }),
    exclaim: P('#ffd75e', [[0, 0, 1, 3], [0, 4]], { attach: false }),
    question: P('#ffd75e', [[0, 0, 2], [2, 1], [1, 2], [1, 4]], { attach: false }),
    bulb: P('#ffe58a', [[1, 0, 2], [0, 1, 4, 2], [1, 3, 2]], { attach: false }),
    bulbBase: P('#a6b1ad', [[1, 4, 2]], { attach: false }),
    headphones: P('#3b4250', [[2, 2], [3, 1, 6], [9, 2]]),
    cups: P('#ff5a6e', [[1, 3, 1, 3], [10, 3, 1, 3]]),
    controller: P('#3b4250', [[2, 7, 8, 2]]),
    pad: P('#a6b1ad', [[3, 7], [3, 8]]),
    btnA: P('#ff5a6e', [[8, 7]]),
    btnB: P('#6ee787', [[7, 8]]),
    cup: P('#c08a5b', [[11, 5, 2, 2], [10, 6]]),
    cupUp: P('#c08a5b', [[8, 6, 2, 2]]),
    steam: P('#a6b1ad', [[0, 0], [1, -1]], { attach: false, opacity: 0.8 }),
    umbrella: P('#5eead4', [[8, -2, 7], [9, -3, 5], [10, -4, 3]]),
    handle: P('#a6b1ad', [[11, -1, 1, 7], [10, 6]]),
    drop: P('#7dd3fc', [[0, 0, 1, 2]], { attach: false, opacity: 0.85 }),
    snow: P('#ffffff', [[0, 0]], { attach: false, opacity: 0.9 }),
    scarf: P('#ff5a6e', [[2, 8, 8], [8, 9, 1, 2]]),
    shadesGlint: P('#ffffff', [[3, 4], [7, 4]], { opacity: 0.7 }),
    partyHat: P('#ff5a6e', [[3, 1, 3], [4, 0]]),
    partyPom: P('#5eead4', [[4, -1]]),
    santaHat: P('#e5484d', [[3, 1, 6], [4, 0, 4], [5, -1, 3], [7, -2, 2]]),
    santaTrim: P('#f0f3f1', [[2, 2, 8], [9, -2]]),
    pumpkin: P('#ff9f43', [[11, 6, 3], [10, 7, 5, 2], [11, 9, 3]]),
    pumpkinStem: P('#6ee787', [[12, 5]]),
    pumpkinFace: P(INK, [[11, 7], [13, 7], [11, 8, 3]]),
    book: P('#f0f3f1', [[3, 7, 6, 2]]),
    bookSpine: P('#5eead4', [[6, 7, 1, 2]]),
    ball: P('#ff5a6e', [[0, 0]], { attach: false }),
    ufo: P('#a6b1ad', [[2, -4, 8]], { attach: false }),
    ufoDome: P('#7dd3fc', [[4, -5, 4]], { attach: false }),
    ufoLights: P('#ffd75e', [[2, -4], [6, -4], [9, -4]], { attach: false }),
    beam: P('#ffe58a', [[3, -3, 6, 15]], { attach: false, back: true, opacity: 0.18 }),
    confetti: P('#ff5a6e', [[0, 0]], { attach: false }),
    confettiB: P('#5eead4', [[0, 0]], { attach: false }),
    confettiC: P('#ffd75e', [[0, 0]], { attach: false }),
    confettiD: P('#b4a0ff', [[0, 0]], { attach: false }),
    puff: P('#f0f3f1', [[0, 0], [2, 0], [1, 1]], { attach: false, opacity: 0.7 }),
    hotSteam: P('#f0f3f1', [[0, 0], [1, -1], [0, -2]], { attach: false, opacity: 0.5 }),
    tongue: P('#ff8fa3', [[6, 8]]),
  });

  // ── frame helpers ──────────────────────────────────────────────
  const F = (ms, props) => Object.freeze({ ms, ...props });
  const times = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
  const flat = (a) => a.flat(Infinity);
  const CONF = ['confetti', 'confettiB', 'confettiC', 'confettiD'];
  const W = ['w0', 'w1', 'w2', 'w3'];

  // Confetti falling from fixed starting points; i is the frame index.
  const confettiAt = (i) =>
    [[-2, -4], [1, -5], [4, -3], [9, -5], [12, -4], [14, -2], [-1, -1]].map(([x, y], k) => [
      CONF[k % CONF.length],
      x + ((i + k) % 2),
      y + i * 2,
      i > 3 ? 1 - (i - 3) * 0.25 : 1,
    ]);

  // ── mood loops: what Bit does while in a state ────────────────
  const MOODS = [
    { id: 'idle', frames: [F(1200, {}), F(1100, { sy: 1.03, sx: 0.985 })] },
    {
      id: 'listen',
      frames: [
        F(260, { eyes: 'wide', ex: ['waveIn'] }),
        F(260, { eyes: 'wide', ex: ['waveIn', 'waveOut'] }),
        F(260, { eyes: 'wide', ex: ['waveOut'] }),
        F(260, { eyes: 'wide' }),
      ],
    },
    {
      id: 'think',
      frames: [
        F(340, { eyes: 'up', ex: ['dot1'] }),
        F(340, { eyes: 'up', ex: ['dot1', 'dot2'] }),
        F(420, { eyes: 'up', ex: ['dot1', 'dot2', 'dot3'] }),
        F(380, { eyes: 'left', ex: ['dot1', 'dot2', 'dot3'] }),
        F(300, { eyes: 'up' }),
      ],
    },
    {
      id: 'work',
      frames: times(8, (i) =>
        F(170, {
          mouth: 'smile',
          ex: [i % 2 ? 'armsOut' : 'armsUp', 'spark'],
          dy: i % 2 ? 0 : -1,
          sy: i % 4 === 3 ? 0.92 : 1,
          tint: W[Math.floor(i / 2) % 4],
        }),
      ),
    },
    {
      id: 'talk',
      frames: [
        F(140, { mouth: 'open' }),
        F(110, { mouth: 'smile' }),
        F(170, { mouth: 'open' }),
        F(100, { mouth: 'flat' }),
        F(130, { mouth: 'open' }),
        F(150, { mouth: 'smile' }),
        F(120, { mouth: 'open', dy: -0.5 }),
        F(160, { mouth: 'flat' }),
      ],
    },
    { id: 'happy', frames: [F(700, { mouth: 'smile', tint: 'happy' }), F(700, { mouth: 'smile', tint: 'happy', dy: -0.5 })] },
    {
      id: 'worry',
      frames: [
        F(420, { brows: 'up', mouth: 'low', ex: [['sweat', 0, 0, 1]] }),
        F(420, { brows: 'up', mouth: 'low', ex: [['sweat', 0, 1, 1]] }),
        F(420, { brows: 'up', mouth: 'low', ex: [['sweat', 0, 2, 0.4]] }),
        F(500, { brows: 'up', mouth: 'low', eyes: 'left' }),
      ],
    },
    {
      id: 'sleep',
      frames: [
        F(700, { eyes: 'blink', mouth: 'low', ex: [['z', 9, -2, 0.35]] }),
        F(700, { eyes: 'blink', mouth: 'low', sy: 1.03, ex: [['z', 9, -3, 1]] }),
        F(700, { eyes: 'blink', mouth: 'low', sy: 1.03, ex: [['z', 10, -4, 0.7], ['zSmall', 8, -1, 0.5]] }),
        F(700, { eyes: 'blink', mouth: 'low', ex: [['zSmall', 8, -2, 1]] }),
      ],
    },
    {
      id: 'drowsy',
      frames: [
        F(900, { eyes: 'blink', mouth: 'low' }),
        F(500, { eyes: 'blink', mouth: 'low', dy: 1 }),
        F(250, { eyes: 'open', mouth: 'low', dy: 0 }),
        F(900, { eyes: 'blink', mouth: 'low', ex: [['zSmall', 9, -2, 0.8]] }),
      ],
    },
    {
      id: 'angry',
      frames: [
        F(200, { brows: 'angry', mouth: 'sad', dx: -0.5 }),
        F(200, { brows: 'angry', mouth: 'sad', dx: 0.5 }),
      ],
    },
  ].map((c) => ({ kind: 'mood', loop: true, tint: c.id in MOOD_RGB ? c.id : 'idle', ...c }));

  // ── idle fidgets: small surprises while Bit waits ─────────────
  const FIDGETS = [
    {
      id: 'lookAround',
      frames: [F(600, { eyes: 'left' }), F(250, {}), F(600, { eyes: 'right' }), F(300, {})],
    },
    { id: 'doubleBlink', frames: [F(90, { eyes: 'blink' }), F(110, {}), F(90, { eyes: 'blink' }), F(400, {})] },
    {
      id: 'yawn',
      frames: [
        F(250, { eyes: 'blink', mouth: 'open', sy: 1.03 }),
        F(800, { eyes: 'blink', mouth: 'yawn', sy: 1.07, ex: ['armsUp'] }),
        F(300, { eyes: 'blink', mouth: 'low' }),
        F(400, {}),
      ],
    },
    {
      id: 'stretch',
      frames: [
        F(200, { ex: ['armsOut'] }),
        F(700, { eyes: 'happy', mouth: 'smile', sy: 1.1, sx: 0.94, ex: ['armsUp'] }),
        F(200, { sy: 0.94, sx: 1.04 }),
        F(300, { mouth: 'smile' }),
      ],
    },
    {
      id: 'hop',
      frames: [
        F(120, { sy: 0.88, sx: 1.06 }),
        F(140, { dy: -2, sy: 1.06, mouth: 'smile' }),
        F(140, { dy: -3, mouth: 'smile', eyes: 'happy' }),
        F(120, { dy: -1 }),
        F(110, { sy: 0.9, sx: 1.05 }),
        F(300, {}),
      ],
    },
    {
      id: 'spin',
      frames: [1, 0.5, 0.12, -0.5, -1, -0.5, 0.12, 0.5, 1].map((sx, i) =>
        F(i === 8 ? 300 : 70, { sx, mouth: i > 2 && i < 7 ? 'smile' : 'flat', dy: i > 1 && i < 7 ? -1 : 0 }),
      ),
    },
    {
      id: 'wave',
      frames: flat([
        times(3, () => [F(200, { mouth: 'smile', ex: ['waveA'] }), F(200, { mouth: 'smile', ex: ['waveB'] })]),
        [F(300, { mouth: 'smile', eyes: 'happy' })],
      ]),
    },
    {
      id: 'antennaSpark',
      frames: [
        F(120, { eyes: 'up', ex: ['spark'] }),
        F(120, { eyes: 'up', ex: ['sparkBig'] }),
        F(120, { eyes: 'up', ex: ['spark'] }),
        F(120, { eyes: 'up', ex: ['sparkBig'] }),
        F(400, { eyes: 'happy', mouth: 'smile' }),
      ],
    },
    {
      id: 'dance',
      frames: flat(
        times(4, (i) => [
          F(180, { dx: -1, mouth: 'smile', eyes: 'happy', ex: ['armL', ['note', 12, -3 - i, 1]] }),
          F(180, { dx: 1, dy: -1, mouth: 'smile', eyes: 'happy', ex: ['armR', ['note', -2, -2 - i, 0.8]] }),
        ]),
      ),
    },
    {
      id: 'sneeze',
      frames: [
        F(300, { eyes: 'squint', mouth: 'open', sy: 1.04 }),
        F(300, { eyes: 'squint', mouth: 'open', sy: 1.08, dy: -0.5 }),
        F(120, { eyes: 'blink', mouth: 'open', sy: 0.85, sx: 1.12, ex: ['sparkBig', ['puff', 9, 6, 1], ['puff', 0, 6, 1]] }),
        F(160, { eyes: 'dizzy', mouth: 'flat', ex: [['puff', 10, 5, 0.6], ['puff', -1, 5, 0.6]] }),
        F(450, { eyes: 'dizzy', mouth: 'wavy', dx: 0.5 }),
        F(300, { mouth: 'smile' }),
      ],
    },
    { id: 'wink', frames: [F(700, { eyes: 'wink', mouth: 'smile', cheeks: true }), F(250, {})] },
    {
      id: 'peek',
      frames: [
        F(160, { dy: 3 }),
        F(160, { dy: 7 }),
        F(500, { dy: 10, noShadow: true }),
        F(400, { dy: 6, eyes: 'left' }),
        F(400, { dy: 6, eyes: 'right' }),
        F(140, { dy: -2, eyes: 'wide', mouth: 'grin' }),
        F(400, { mouth: 'smile' }),
      ],
    },
    {
      id: 'whistle',
      frames: times(6, (i) =>
        F(260, { eyes: 'up', mouth: 'whistle', ex: [['note', 11 + (i % 2), -1 - i, 1 - i * 0.12]] }),
      ),
    },
    {
      id: 'idea',
      frames: [
        F(300, { eyes: 'up' }),
        F(140, { eyes: 'wide', ex: [['bulb', 10, -6, 0.5], ['bulbBase', 10, -6, 0.5]] }),
        F(700, { eyes: 'wide', mouth: 'grin', dy: -1, ex: [['bulb', 10, -6, 1], ['bulbBase', 10, -6, 1]] }),
        F(300, { mouth: 'smile' }),
      ],
    },
    {
      id: 'juggle',
      frames: times(8, (i) => {
        const arc = [[0, 2], [1, -1], [3, -3], [5, -4], [7, -3], [9, -1], [10, 2], [5, -4]];
        const [x, y] = arc[i];
        return F(130, { eyes: 'up', mouth: 'smile', ex: ['armsUp', ['ball', x + 1, y, 1]] });
      }),
    },
    {
      id: 'bow',
      frames: [F(200, { dy: 1, eyes: 'happy', sy: 0.94 }), F(500, { dy: 2, eyes: 'happy', sy: 0.9 }), F(300, { mouth: 'smile' })],
    },
    {
      id: 'cool',
      frames: [
        F(160, { mouth: 'flat', ex: [['shadesGlint', 0, -3, 0]], eyes: 'open' }),
        F(900, { eyes: 'shades', mouth: 'grin', ex: ['shadesGlint'] }),
        F(300, { eyes: 'shades', mouth: 'smile' }),
        F(300, {}),
      ],
    },
    {
      id: 'reading',
      frames: flat([
        times(3, () => [F(700, { eyes: 'down', ex: ['book', 'bookSpine'] }), F(200, { eyes: 'blink', ex: ['book', 'bookSpine'] })]),
        [F(400, { eyes: 'up', mouth: 'smile', ex: ['book', 'bookSpine'] })],
      ]),
    },
  ].map((c) => ({ kind: 'fidget', weight: 3, ...c }));

  // Rare fidgets: a handful of lucky moments.
  const RARE = [
    {
      id: 'ufo',
      frames: flat([
        times(3, (i) => F(180, { eyes: 'up', ex: [['ufo', 0, i - 2, 1], ['ufoDome', 0, i - 2, 1], ['ufoLights', 0, i - 2, i % 2]] })),
        times(4, (i) => F(200, { eyes: 'wide', mouth: 'open', dy: -i, ex: ['beam', 'ufo', 'ufoDome', ['ufoLights', 0, 0, i % 2]] })),
        [F(140, { eyes: 'dizzy', dy: 0, sy: 0.85, sx: 1.08, ex: [['ufo', 0, -3, 0.6], ['ufoDome', 0, -3, 0.6]] })],
        [F(500, { eyes: 'dizzy', mouth: 'wavy' })],
      ]),
    },
    {
      id: 'glitch',
      frames: [
        F(80, { glitch: 1 }),
        F(60, { glitch: 2, dx: 1 }),
        F(80, { glitch: 1, eyes: 'none', mouth: 'none' }),
        F(60, { glitch: 2, dx: -1 }),
        F(400, { eyes: 'wide' }),
      ],
    },
    {
      id: 'love',
      frames: times(6, (i) =>
        F(220, { eyes: 'hearts', mouth: 'smile', cheeks: true, dy: i % 2 ? -0.5 : 0, ex: [['heart', 10, -1 - i, 1 - i * 0.15]] }),
      ),
    },
    {
      id: 'moonwalk',
      frames: [
        ...times(5, (i) => F(160, { dx: -i * 0.8, sx: -1, eyes: 'shades', mouth: 'grin', dy: i % 2 ? -0.5 : 0 })),
        ...times(5, (i) => F(160, { dx: -3.2 + i * 0.8, eyes: 'shades', mouth: 'grin', dy: i % 2 ? -0.5 : 0 })),
        F(300, { mouth: 'smile' }),
      ],
    },
  ].map((c) => ({ kind: 'fidget', rare: true, weight: 0.35, ...c }));

  // Fidgets that only fit a moment: the hour, the weather, what the PC does.
  const rainAt = (i) => [[-2, -3], [1, -5], [13, -4], [4, -2], [14, 1], [-1, 2]].map(([x, y], k) => ['drop', x, y + ((i * 3 + k * 2) % 9), 0.85]);
  const snowAt = (i) => [[-2, -3], [1, -5], [13, -4], [4, -2], [14, 1], [-1, 2], [10, -5]].map(([x, y], k) => ['snow', x + ((i + k) % 2), y + ((i * 2 + k * 3) % 12), 0.9]);
  const CONTEXT = [
    {
      id: 'coffee',
      when: { hours: [6, 11] },
      frames: [
        F(500, { ex: ['cup', ['steam', 12, 3, 0.8]] }),
        F(500, { ex: ['cup', ['steam', 11, 2, 0.6]] }),
        F(700, { eyes: 'happy', mouth: 'none', ex: ['cupUp', ['steam', 9, 4, 0.6]] }),
        F(500, { eyes: 'happy', mouth: 'smile', cheeks: true, ex: ['cup'] }),
      ],
    },
    {
      id: 'stargaze',
      when: { hours: [21, 5] },
      frames: times(6, (i) =>
        F(380, {
          eyes: 'up',
          mouth: i > 3 ? 'smile' : 'flat',
          ex: [['star', -2, -4, i % 2 ? 1 : 0.3], ['dot', 12, -3, i % 3 ? 0.4 : 1], ['star', 11, -1, i % 2 ? 0.3 : 1], ['dot', 1, -4, i % 2 ? 1 : 0.4]],
        }),
      ),
    },
    {
      id: 'umbrella',
      when: { weather: ['rain', 'storm', 'drizzle'] },
      frames: times(8, (i) => F(150, { eyes: i % 4 === 3 ? 'up' : 'open', ex: ['handle', 'umbrella', ...rainAt(i)] })),
    },
    {
      id: 'snow',
      when: { weather: ['snow'] },
      frames: times(8, (i) => F(200, { eyes: 'up', mouth: i > 4 ? 'smile' : 'flat', ex: ['scarf', ...snowAt(i)] })),
    },
    {
      id: 'sunny',
      when: { hot: true },
      frames: [
        F(300, { tint: 'hot', mouth: 'open', ex: ['tongue', 'sweat'] }),
        F(300, { tint: 'hot', mouth: 'open', eyes: 'squint', ex: ['tongue', ['sweat', 0, 1, 1]] }),
        F(900, { tint: 'hot', eyes: 'shades', mouth: 'grin', ex: ['shadesGlint'] }),
      ],
    },
    {
      id: 'shiver',
      when: { cold: true },
      frames: times(8, (i) => F(90, { tint: 'cold', mouth: 'wavy', dx: i % 2 ? 0.5 : -0.5, ex: ['scarf'] })),
    },
    {
      id: 'headbang',
      when: { music: true },
      frames: times(8, (i) =>
        F(220, { dy: i % 2, eyes: 'happy', mouth: 'smile', ex: ['headphones', 'cups', ['note', i % 4 < 2 ? 12 : -3, -2 - (i % 4), 1]] }),
      ),
    },
    {
      id: 'gaming',
      when: { gaming: true },
      frames: [
        F(300, { eyes: 'left', ex: ['controller', 'pad', 'btnA', 'btnB'] }),
        F(200, { eyes: 'right', ex: ['controller', 'pad', 'btnA', 'btnB'], dx: 0.5 }),
        F(200, { eyes: 'left', ex: ['controller', 'pad', 'btnA', 'btnB'], dx: -0.5 }),
        F(500, { eyes: 'wide', mouth: 'open', ex: ['controller', 'pad', 'btnA', 'btnB', ['exclaim', 12, -3, 1]] }),
        F(400, { eyes: 'happy', mouth: 'grin', ex: ['controller', 'pad', 'btnA', 'btnB'] }),
      ],
    },
    {
      id: 'overheat',
      when: { cpuHot: true },
      frames: times(6, (i) =>
        F(220, { tint: 'hot', mouth: 'open', eyes: i % 3 ? 'squint' : 'open', ex: ['tongue', ['sweat', 0, i % 3, 1], ['hotSteam', 3 + (i % 2) * 5, -1 - (i % 3), 0.5]] }),
      ),
    },
    {
      id: 'pumpkin',
      when: { season: 'halloween' },
      frames: [
        F(400, { ex: ['pumpkin', 'pumpkinStem', 'pumpkinFace'] }),
        F(140, { dy: -2, eyes: 'wide', mouth: 'open', ex: ['pumpkin', 'pumpkinStem', 'pumpkinFace', 'armL'] }),
        F(600, { eyes: 'wide', mouth: 'grin', ex: ['pumpkin', 'pumpkinStem', 'pumpkinFace', 'armL'] }),
        F(400, { eyes: 'happy', mouth: 'smile', ex: ['pumpkin', 'pumpkinStem', 'pumpkinFace'] }),
      ],
    },
    {
      id: 'santa',
      when: { season: 'christmas' },
      frames: times(8, (i) => F(200, { eyes: i > 5 ? 'happy' : 'open', mouth: 'smile', ex: ['santaHat', 'santaTrim', ...snowAt(i)] })),
    },
    {
      id: 'party',
      when: { season: ['birthday', 'newyear'] },
      frames: times(6, (i) => F(180, { eyes: 'happy', mouth: 'grin', dy: i % 2 ? -1 : 0, ex: ['partyHat', 'partyPom', 'armsUp', ...confettiAt(i)] })),
    },
  ].map((c) => ({ kind: 'fidget', weight: 6, ...c }));

  // ── reactions: Bit answers something that just happened ───────
  const REACTS = [
    {
      id: 'hello',
      frames: flat([
        [F(120, { sy: 0.9 }), F(140, { dy: -2, ex: ['sparkBig'] })],
        times(2, () => [F(180, { mouth: 'smile', ex: ['waveA', 'spark'] }), F(180, { mouth: 'smile', ex: ['waveB', 'spark'] })]),
        [F(300, { eyes: 'happy', mouth: 'smile' })],
      ]),
    },
    {
      id: 'welcomeBack',
      frames: [
        F(300, { eyes: 'wide', mouth: 'open', ex: [['exclaim', 11, -4, 1]] }),
        F(120, { sy: 0.86, sx: 1.08 }),
        F(160, { dy: -3, eyes: 'happy', mouth: 'grin', ex: ['armsUp'] }),
        F(160, { dy: -2, eyes: 'happy', mouth: 'grin', ex: ['armsUp'] }),
        F(110, { sy: 0.9 }),
        F(600, { eyes: 'happy', mouth: 'smile', cheeks: true, ex: ['waveA'] }),
      ],
    },
    {
      id: 'celebrate',
      frames: times(7, (i) =>
        F(i === 6 ? 500 : 150, {
          eyes: 'happy',
          mouth: 'grin',
          tint: i === 6 ? 'happy' : W[i % 4],
          dy: [0, -2, -3, -2, 0, -1, 0][i],
          sy: i === 4 ? 0.88 : 1,
          ex: ['armsUp', 'sparkBig', ...confettiAt(i)],
        }),
      ),
    },
    {
      id: 'nod',
      frames: [F(160, { dy: 1, eyes: 'happy', mouth: 'smile' }), F(160, { mouth: 'smile' }), F(160, { dy: 1, eyes: 'happy', mouth: 'smile' }), F(400, { mouth: 'smile' })],
    },
    {
      id: 'oops',
      frames: [
        F(200, { eyes: 'wide', mouth: 'open', tint: 'worry', ex: [['question', 11, -4, 1]] }),
        F(400, { brows: 'up', mouth: 'low', tint: 'worry', ex: ['sweat', ['question', 11, -4, 1]] }),
        F(500, { brows: 'up', mouth: 'wavy', tint: 'worry', ex: ['armsOut', ['sweat', 0, 1, 1]] }),
        F(400, { brows: 'up', mouth: 'low', tint: 'worry' }),
      ],
    },
    {
      id: 'recharge',
      frames: [
        ...times(5, (i) =>
          F(140, {
            eyes: 'up',
            tint: 'sleep',
            ex: [[-3, -5], [14, -5], [-3, 6], [14, 6]].map(([x, y]) => ['spark', (x - 6) * (1 - i / 4), (y + 1) * (1 - i / 4), 1]),
          }),
        ),
        F(120, { eyes: 'stars', tint: 'idle', ex: ['sparkBig'], sy: 0.88 }),
        F(160, { eyes: 'stars', tint: 'idle', dy: -3, mouth: 'grin', ex: ['sparkBig', 'armsUp'] }),
        F(600, { eyes: 'happy', tint: 'idle', mouth: 'smile', cheeks: true, ex: ['spark'] }),
      ],
    },
    {
      id: 'giggle',
      frames: [
        F(90, { sy: 0.85, sx: 1.1, eyes: 'squint', mouth: 'grin' }),
        ...times(5, (i) => F(80, { dx: i % 2 ? 0.5 : -0.5, eyes: 'squint', mouth: 'grin', cheeks: true })),
        F(300, { mouth: 'smile', cheeks: true }),
      ],
    },
    {
      id: 'surprised',
      frames: [F(80, { sy: 1.1, eyes: 'wide', mouth: 'open', ex: [['exclaim', 11, -4, 1]] }), F(500, { eyes: 'wide', mouth: 'open', ex: [['exclaim', 11, -4, 1]] }), F(300, { mouth: 'smile' })],
    },
    {
      id: 'thanks',
      frames: [
        F(200, { dy: 1, sy: 0.92, eyes: 'happy', mouth: 'smile' }),
        F(500, { dy: 2, sy: 0.88, eyes: 'happy', mouth: 'smile', cheeks: true }),
        ...times(4, (i) => F(200, { eyes: 'hearts', mouth: 'smile', cheeks: true, ex: [['heart', 10, -1 - i, 1 - i * 0.2]] })),
      ],
    },
    {
      id: 'goodbye',
      frames: flat([
        times(2, () => [F(200, { mouth: 'smile', ex: ['waveA'] }), F(200, { mouth: 'smile', ex: ['waveB'] })]),
        [F(400, { eyes: 'happy', mouth: 'smile' }), F(500, { eyes: 'blink', mouth: 'low', tint: 'sleep' })],
      ]),
    },
  ].map((c) => ({ kind: 'react', ...c }));

  // Which reaction a tap on Bit plays, in turn.
  const POKES = Object.freeze(['giggle', 'surprised', 'spin', 'hop', 'wink']);

  const CLIPS = Object.freeze([...MOODS, ...FIDGETS, ...RARE, ...CONTEXT, ...REACTS]);

  return { INK, MOOD_RGB, BODY, EYES, MOUTHS, BROWS, CHEEKS, PARTS, CLIPS, POKES };
});

// ---- bit-color.js
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

// ---- bit-genes.js
;((root, factory) => {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitGenes = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  /* What a personal Bit can be, as plain data. The body shape is never a gene
   * (brand rule, bit-clips.js): every Bit is recognisably Bit, and what makes
   * one unique is its colours, markings, antenna tip, eyes, cheeks and
   * character. Cells use Bit's 12x12 grid like bit-clips.js.
   *
   * Every variant has a tier: c(ommon), u(ncommon) or r(are). A gene first
   * draws a tier with TIER_ODDS, then a variant inside it, so the odds a
   * birth card shows are exact: tier odds / variants in that tier.
   *
   * NEVER reorder or remove an entry: decoded Bits refer to these ids, and a
   * fingerprint registered on the hub must keep meaning the same look. New
   * variants go at the end of their list, with a decoder version bump. */

  const TIER_ODDS = Object.freeze({ c: 0.8, u: 0.17, r: 0.03 });

  // 16 hues x 4 tones = 64 palettes. Hue in OKLCH degrees.
  const HUES = Object.freeze([
    ['rose', 10], ['red', 28], ['coral', 45], ['orange', 62], ['gold', 80], ['lemon', 100], ['lime', 120], ['green', 142],
    ['mint', 162], ['teal', 185], ['cyan', 210], ['sky', 232], ['blue', 255], ['indigo', 275], ['violet', 300], ['magenta', 330],
  ]);

  // Lightness never under 0.66, so the ink face keeps at least 4.5:1 contrast.
  const TONES = Object.freeze([
    { id: 'pastel', L: 0.89, C: 0.085, tier: 'c' },
    { id: 'vivid', L: 0.78, C: 0.19, tier: 'c' },
    { id: 'deep', L: 0.66, C: 0.16, tier: 'u' },
    { id: 'muted', L: 0.74, C: 0.05, tier: 'u' },
  ]);

  // The logo Bit's green (docs/images/bit.svg): 1 Bit in 512 is born classic.
  const CLASSIC = '#6ee787';
  const CLASSIC_ODDS = 1 / 512;
  const SHINY_ODDS = 1 / 4096;

  /* Markings. `role: 'mark'` paints in the Bit's shadow or accent colour and
   * stays off the face (x 3..8, y 3..8) so eyes and mouth always read;
   * `role: 'cream'` is a light patch that may sit under the face, because ink
   * on cream reads even better. bit-look.js clips every cell to the body. */
  const PATTERNS = Object.freeze([
    { id: 'plain', tier: 'c', role: 'none', cells: [] },
    { id: 'cap', tier: 'c', role: 'mark', cells: [[3, 2, 6]] },
    { id: 'socks', tier: 'c', role: 'mark', cells: [[3, 10, 2], [7, 10, 2]] },
    { id: 'boots', tier: 'c', role: 'mark', cells: [[3, 9, 6], [3, 10, 2], [7, 10, 2]] },
    { id: 'sides', tier: 'c', role: 'mark', cells: [[2, 3, 1, 6], [9, 3, 1, 6]] },
    { id: 'ears', tier: 'c', role: 'mark', cells: [[3, 2], [8, 2], [2, 3], [9, 3]] },
    { id: 'antenna', tier: 'c', role: 'mark', cells: [[6, 0, 1, 2]] },
    { id: 'skirt', tier: 'c', role: 'mark', cells: [[2, 7, 1, 2], [9, 7, 1, 2], [3, 9, 6]] },
    { id: 'belt', tier: 'c', role: 'mark', cells: [[3, 9, 6]] },
    { id: 'topknot', tier: 'c', role: 'mark', cells: [[6, 0, 1, 2], [5, 2, 2]] },
    { id: 'dipped', tier: 'c', role: 'mark', cells: [[2, 6, 1, 3], [9, 6, 1, 3], [3, 9, 6], [3, 10, 2], [7, 10, 2]] },
    { id: 'stripes', tier: 'u', role: 'mark', cells: [[2, 3], [9, 3], [2, 5], [9, 5], [2, 7], [9, 7], [3, 9, 6]] },
    { id: 'half', tier: 'u', role: 'mark', cells: [[3, 2, 3], [2, 3, 1, 6], [3, 9, 3], [3, 10, 2]] },
    { id: 'points', tier: 'u', role: 'mark', cells: [[3, 2], [8, 2], [2, 3], [9, 3], [3, 10, 2], [7, 10, 2], [6, 0, 1, 2]] },
    { id: 'hood', tier: 'u', role: 'mark', cells: [[3, 2, 6], [2, 3, 1, 3], [9, 3, 1, 3], [6, 0, 1, 2]] },
    { id: 'spots', tier: 'u', role: 'mark', cells: [[4, 2], [2, 5], [9, 7], [7, 9], [3, 9], [9, 3]] },
    { id: 'diagonal', tier: 'u', role: 'mark', cells: [[3, 2, 2], [2, 3, 1, 2], [7, 9, 2], [9, 7, 1, 2], [7, 10, 2]] },
    { id: 'oneside', tier: 'u', role: 'mark', cells: [[9, 3, 1, 6], [8, 2], [7, 9, 2], [7, 10, 2]] },
    { id: 'muzzle', tier: 'u', role: 'cream', cells: [[4, 6, 4, 3]] },
    { id: 'mask', tier: 'u', role: 'cream', cells: [[3, 3, 6, 3]] },
    { id: 'bib', tier: 'u', role: 'cream', cells: [[4, 8, 4], [3, 9, 6]] },
    { id: 'face', tier: 'r', role: 'cream', cells: [[3, 3, 6, 6]] },
    { id: 'check', tier: 'r', role: 'mark', cells: [[3, 2], [5, 2], [7, 2], [2, 4], [2, 6], [2, 8], [9, 3], [9, 5], [9, 7], [4, 9], [6, 9], [8, 9]] },
    { id: 'frame', tier: 'r', role: 'mark', cells: [[3, 2, 6], [2, 3, 1, 6], [9, 3, 1, 6], [3, 9, 6]] },
  ]);

  const PATTERN_COLORS = Object.freeze([
    { id: 'shadow', tier: 'c' },
    { id: 'accent', tier: 'c' },
  ]);

  /* Antenna tips, on top of the antenna (6,0)-(6,1). `stem` cells take the
   * body colour; `light` cells glow in the mood colour, so the tip is also
   * how a personal Bit shows its mood. Tips stay in rows -1 and -2: Bit jumps
   * up to 3 cells and the stage ends at y -5, and hats need the room. */
  const TIPS = Object.freeze([
    { id: 'bulb', tier: 'c', stem: [], light: [[6, -1]] },
    { id: 'bead', tier: 'c', stem: [[6, -1]], light: [[6, -2]] },
    { id: 'capsule', tier: 'c', stem: [], light: [[6, -2, 1, 2]] },
    { id: 'bar', tier: 'c', stem: [], light: [[5, -1, 3]] },
    { id: 'orb', tier: 'c', stem: [], light: [[5, -2, 3, 2]] },
    { id: 'tee', tier: 'c', stem: [[6, -1]], light: [[5, -2, 3]] },
    { id: 'leaf', tier: 'u', stem: [[6, -1]], light: [[7, -2]] },
    { id: 'sprout', tier: 'u', stem: [[6, -1]], light: [[5, -2], [7, -2]] },
    { id: 'twin', tier: 'u', stem: [[5, -1, 3]], light: [[5, -2], [7, -2]] },
    { id: 'arrow', tier: 'u', stem: [[6, -1]], light: [[5, -1], [7, -1], [6, -2]] },
    { id: 'flag', tier: 'u', stem: [[6, -2, 1, 2]], light: [[7, -2, 2]] },
    { id: 'beam', tier: 'u', stem: [], light: [[4, -1, 5]] },
    { id: 'chunk', tier: 'u', stem: [], light: [[6, -2, 2, 2]] },
    { id: 'cup', tier: 'r', stem: [], light: [[5, -1, 3], [5, -2], [7, -2]] },
    { id: 'hook', tier: 'r', stem: [[6, -1], [7, -1]], light: [[8, -2]] },
    { id: 'dish', tier: 'r', stem: [[6, -1]], light: [[4, -2, 5]] },
  ]);

  // Eye colours: all dark enough to keep 4.5:1 on every palette and on cream.
  const EYES = Object.freeze([
    { id: 'ink', tier: 'c', L: null },
    { id: 'navy', tier: 'c', L: 0.25, C: 0.07, h: 255 },
    { id: 'cocoa', tier: 'c', L: 0.25, C: 0.05, h: 55 },
    { id: 'forest', tier: 'u', L: 0.25, C: 0.06, h: 145 },
    { id: 'plum', tier: 'u', L: 0.25, C: 0.07, h: 320 },
    { id: 'teal', tier: 'u', L: 0.25, C: 0.05, h: 195 },
    { id: 'wine', tier: 'r', L: 0.25, C: 0.08, h: 15 },
    { id: 'violet', tier: 'r', L: 0.25, C: 0.09, h: 290 },
  ]);

  // Cheeks show when a clip blushes; `always` keeps them on, softer.
  const CHEEKS = Object.freeze([
    { id: 'pink', tier: 'c', fill: '#ff8fa3', always: false },
    { id: 'peach', tier: 'c', fill: '#ffb08a', always: false },
    { id: 'lilac', tier: 'u', fill: '#c9a7ff', always: false },
    { id: 'coral', tier: 'u', fill: '#ff7a70', always: false },
    { id: 'rosy', tier: 'u', fill: '#ff8fa3', always: true },
    { id: 'freckles', tier: 'r', fill: 'shadow', always: true, cells: [[2, 5], [9, 5], [2, 7], [9, 7]] },
  ]);

  // Character: rhythm of fidgets and how big reactions are (bit-director.js).
  const TEMPERAMENTS = Object.freeze(['lively', 'calm', 'curious', 'sleepy', 'dramatic', 'shy'].map((id) => ({ id, tier: 'c' })));

  // A favourite fidget, played twice as often (ids from bit-clips.js).
  const QUIRKS = Object.freeze(
    ['hop', 'spin', 'wave', 'antennaSpark', 'dance', 'sneeze', 'wink', 'peek', 'whistle', 'juggle', 'cool', 'reading'].map((id) => ({ id, tier: 'c' })),
  );

  // Chiptune voice: pitch multiplier and oscillator for Bit's sounds.
  const VOICES = Object.freeze(
    [['low', 0.8, 'square'], ['warm', 0.9, 'triangle'], ['mid', 1, 'square'], ['soft', 1, 'triangle'], ['bright', 1.12, 'square'], ['tiny', 1.25, 'triangle'], ['buzzy', 0.95, 'sawtooth'], ['chirpy', 1.35, 'square']].map(
      ([id, pitch, wave]) => ({ id, tier: 'c', pitch, wave }),
    ),
  );

  return { TIER_ODDS, HUES, TONES, CLASSIC, CLASSIC_ODDS, SHINY_ODDS, PATTERNS, PATTERN_COLORS, TIPS, EYES, CHEEKS, TEMPERAMENTS, QUIRKS, VOICES };
});

// ---- bit-genome.js
;((root, factory) => {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const genes = node ? require('./bit-genes.js') : root.Xenon.bitGenes;
  const color = node ? require('./bit-color.js') : root.Xenon.bitColor;
  const mod = factory(genes, color);
  if (node) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitGenome = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, (G, color) => {
  'use strict';

  /* A personal Bit's DNA. The hub issues and signs a 64-bit seed (16 hex
   * characters); this file turns it into genes, always the same way on every
   * PC, in the browser, in a widget and on the hub. Each gene draws from its
   * own stream (seed + gene name), so adding a gene later never changes the
   * genes a Bit already has. Pure: no clock, no Math.random. */

  const VERSION = 1;
  const SEED_RE = /^[0-9a-f]{16}$/;

  // ── deterministic randomness ──────────────────────────────────
  function hash32(text) {
    let h = 1779033703 ^ text.length;
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^ (h >>> 16)) >>> 0;
  }

  // mulberry32: a 32-bit generator, exact in every JS engine.
  function stream(seed, label) {
    let a = hash32(`${seed}:${label}`);
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Draw a tier with TIER_ODDS (only tiers the list has), then a variant. */
  function pickTiered(list, rand) {
    const tiers = ['c', 'u', 'r'].filter((t) => list.some((v) => v.tier === t));
    const total = tiers.reduce((s, t) => s + G.TIER_ODDS[t], 0);
    let roll = rand() * total;
    let tier = tiers[tiers.length - 1];
    for (const t of tiers) {
      roll -= G.TIER_ODDS[t];
      if (roll < 0) {
        tier = t;
        break;
      }
    }
    const pool = list.filter((v) => v.tier === tier);
    return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
  }

  /** The exact chance of one variant of a gene, from the tier rules above. */
  function odds(list, id) {
    const v = list.find((x) => x.id === id);
    if (!v) return 0;
    const tiers = ['c', 'u', 'r'].filter((t) => list.some((x) => x.tier === t));
    const total = tiers.reduce((s, t) => s + G.TIER_ODDS[t], 0);
    return G.TIER_ODDS[v.tier] / total / list.filter((x) => x.tier === v.tier).length;
  }

  // ── palettes ──────────────────────────────────────────────────
  function paletteFrom(L, C, h) {
    return Object.freeze({
      body: color.oklch(L, C, h),
      shadow: color.oklch(L - 0.14, C * 1.05, h),
      accent: color.oklch(Math.max(0.68, L - 0.04), Math.max(0.1, C), h + 150),
      cream: color.oklch(0.95, 0.025, h),
      // Outline for light backgrounds, where a pale body would fade away.
      line: color.oklch(0.45, Math.min(C, 0.12), h),
    });
  }

  const PALETTES = Object.freeze(
    G.TONES.flatMap((tone) =>
      G.HUES.map(([hue, h]) => Object.freeze({ id: `${hue}-${tone.id}`, tier: tone.tier, ...paletteFrom(tone.L, tone.C, h) })),
    ),
  );
  const CLASSIC = Object.freeze({ id: 'classic', tier: 'r', ...paletteFrom(...color.toOklch(G.CLASSIC)), body: G.CLASSIC });
  const BY_PALETTE = new Map([...PALETTES, CLASSIC].map((p) => [p.id, p]));

  function palette(id) {
    return BY_PALETTE.get(id) || null;
  }

  // ── decoding ──────────────────────────────────────────────────
  function normalizeSeed(seed) {
    const s = String(seed == null ? '' : seed).trim().toLowerCase();
    return SEED_RE.test(s) ? s : null;
  }

  /**
   * Seed to genes. Throws on a malformed seed: a Bit must never be built
   * from data that did not come from the hub or the local fallback.
   * @param {string} seed 16 hex characters
   */
  function decode(seed) {
    const s = normalizeSeed(seed);
    if (!s) throw new Error('Bit seed must be 16 hex characters');
    const pick = (list, label) => pickTiered(list, stream(s, label)).id;
    const classic = stream(s, 'classic')() < G.CLASSIC_ODDS;
    const pattern = G.PATTERNS.find((p) => p.id === pick(G.PATTERNS, 'pattern'));
    const patternColor = pattern.role === 'mark' ? pick(G.PATTERN_COLORS, 'patternColor') : pattern.role;
    return Object.freeze({
      v: VERSION,
      seed: s,
      classic,
      shiny: stream(s, 'shiny')() < G.SHINY_ODDS,
      palette: classic ? 'classic' : pick(PALETTES, 'palette'),
      pattern: pattern.id,
      patternColor,
      tip: pick(G.TIPS, 'tip'),
      eyes: pick(G.EYES, 'eyes'),
      cheeks: pick(G.CHEEKS, 'cheeks'),
      temperament: pick(G.TEMPERAMENTS, 'temperament'),
      quirk: pick(G.QUIRKS, 'quirk'),
      voice: pick(G.VOICES, 'voice'),
    });
  }

  /**
   * What makes a Bit look unique, as one string. The hub keeps it UNIQUE, so
   * no two registered Bits ever look the same. Character, quirk and voice
   * are left out on purpose: two Bits that only behave differently would
   * still look identical in a picture.
   */
  function fingerprint(g) {
    return [g.palette, g.pattern, g.patternColor, g.tip, g.eyes, g.cheeks, g.shiny ? 'shiny' : 'plain'].join('.');
  }

  /** Every distinct fingerprint the genes can produce, for the hub's alarm. */
  function lookCount() {
    const colourings = G.PATTERNS.reduce((s, p) => s + (p.role === 'mark' ? G.PATTERN_COLORS.length : 1), 0);
    return (PALETTES.length + 1) * colourings * G.TIPS.length * G.EYES.length * G.CHEEKS.length * 2;
  }

  /**
   * The chance of each visible trait, rarest first, for the birth card.
   * @returns {{gene: string, id: string, chance: number, oneIn: number}[]}
   */
  function rarity(g) {
    const paletteChance = g.classic ? G.CLASSIC_ODDS : (1 - G.CLASSIC_ODDS) * odds(PALETTES, g.palette);
    const pattern = G.PATTERNS.find((p) => p.id === g.pattern);
    const traits = [
      { gene: 'palette', id: g.palette, chance: paletteChance },
      { gene: 'pattern', id: g.pattern, chance: odds(G.PATTERNS, g.pattern) },
      { gene: 'tip', id: g.tip, chance: odds(G.TIPS, g.tip) },
      { gene: 'eyes', id: g.eyes, chance: odds(G.EYES, g.eyes) },
      { gene: 'cheeks', id: g.cheeks, chance: odds(G.CHEEKS, g.cheeks) },
    ];
    if (pattern && pattern.role === 'mark') traits.push({ gene: 'patternColor', id: g.patternColor, chance: odds(G.PATTERN_COLORS, g.patternColor) });
    if (g.shiny) traits.push({ gene: 'shiny', id: 'shiny', chance: G.SHINY_ODDS });
    return traits.map((t) => ({ ...t, oneIn: Math.round(1 / t.chance) })).sort((a, b) => a.chance - b.chance);
  }

  return { VERSION, PALETTES, palette, normalizeSeed, decode, fingerprint, lookCount, rarity, odds, stream };
});

// ---- bit-look.js
;((root, factory) => {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const deps = node
    ? [require('./bit-clips.js'), require('./bit-genes.js'), require('./bit-genome.js'), require('./bit-color.js')]
    : [root.Xenon.bitClips, root.Xenon.bitGenes, root.Xenon.bitGenome, root.Xenon.bitColor];
  const mod = factory(deps[0], deps[1], deps[2], deps[3]);
  if (node) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitLook = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, (clips, G, genome, color) => {
  'use strict';

  /* Genes (bit-genome.js) plus what the Bit wears, turned into a `look`:
   * ready-made coloured cells that bit.js paints around the fixed body.
   * bit.js stays a plain painter; every decision about colour lives here. */

  const { BODY, CHEEKS, INK } = clips;
  const OUTLINE_BELOW = 3; // contrast with the background under which Bit gets an outline
  const SHINE = '#ffffff';
  const SPARKLE = '#fff6c8';

  function unitCells(list) {
    const out = [];
    for (const [x, y, w = 1, h = 1] of list) {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push([x + i, y + j]);
    }
    return out;
  }

  const BODY_SET = new Set(unitCells(BODY).map(([x, y]) => `${x},${y}`));
  const inBody = ([x, y]) => BODY_SET.has(`${x},${y}`);
  // Eyes, brows and mouth live here; only light (cream) markings may sit under them.
  const inFace = ([x, y]) => x >= 3 && x <= 8 && y >= 3 && y <= 8;

  const byId = (list, id) => list.find((v) => v.id === id);
  const cellRects = (cells, fill, o = 1) => cells.map(([x, y]) => ({ x, y, w: 1, h: 1, fill, o }));

  function markings(pattern, roleColor, pal) {
    if (!pattern || pattern.role === 'none') return [];
    const fill = pattern.role === 'cream' ? pal.cream : pal[roleColor] || pal.shadow;
    const cells = unitCells(pattern.cells).filter((c) => inBody(c) && (pattern.role === 'cream' || !inFace(c)));
    return cellRects(cells, fill);
  }

  function eyeColor(id) {
    const e = byId(G.EYES, id);
    return e && e.L != null ? color.oklch(e.L, e.C, e.h) : INK;
  }

  function cheeks(id, pal) {
    const c = byId(G.CHEEKS, id) || G.CHEEKS[0];
    const fill = c.fill === 'shadow' ? pal.shadow : c.fill;
    const opacity = c.cells ? 1 : c.always ? 0.6 : CHEEKS.opacity;
    return { fill, always: c.always, opacity, cells: c.cells || CHEEKS.cells };
  }

  // A shiny Bit: a gloss on the top-left of the head and a twinkle beside it.
  function shine(shiny) {
    if (!shiny) return [];
    return [...cellRects([[3, 2], [4, 2], [2, 3]], SHINE, 0.75), ...cellRects(unitCells([[10, -2], [9, -1, 3], [10, 0]]), SPARKLE)];
  }

  function resolveFill(fill, pal) {
    if (fill === 'ink') return INK;
    return pal[fill] || fill;
  }

  /* Worn items (bit-wardrobe.js), each split by layer: `back` goes behind
   * the body, `face` over the face (glasses), the rest over the body. `box`
   * (cell edges) lets bit.js set an item down in a clip it would not fit. */
  function wornItems(items, pal) {
    return (items || []).map((item) => {
      const out = { id: item.id, behind: [], over: [], face: [] };
      const slotLayer = item.slot === 'back' ? 'behind' : item.slot === 'face' ? 'face' : 'over';
      const cells = [];
      for (const part of item.layers) {
        const unit = unitCells(part.cells);
        cells.push(...unit);
        out[part.layer || slotLayer].push(...cellRects(unit, resolveFill(part.fill, pal), part.o == null ? 1 : part.o));
      }
      const xs = cells.map((c) => c[0]);
      out.box = { x0: Math.min(...xs), x1: Math.max(...xs) + 1, y0: Math.min(...cells.map((c) => c[1])) };
      return out;
    });
  }

  function outlineFor(pal, background) {
    if (!/^#[0-9a-f]{6}$/i.test(background || '')) return null;
    if (color.contrast(pal.body, background) >= OUTLINE_BELOW) return null;
    return color.luminance(background) > 0.4 ? pal.line : pal.cream;
  }

  /**
   * @param {{ palette: string, pattern: string, patternColor: string, tip: string, eyes: string, cheeks: string, shiny: boolean }} g
   *   genes from bitGenome.decode()
   * @param {{worn?: object[], background?: string}} [opts]
   *   worn: item definitions from bitWardrobe; background: '#rrggbb' behind Bit
   */
  function lookOf(g, opts = {}) {
    const pal = genome.palette(g.palette);
    if (!pal) throw new Error(`Unknown Bit palette: ${g.palette}`);
    const tip = byId(G.TIPS, g.tip) || G.TIPS[0];
    return Object.freeze({
      body: pal.body,
      accent: pal.accent,
      marks: [...markings(byId(G.PATTERNS, g.pattern), g.patternColor, pal), ...shine(g.shiny)],
      tip: { stem: cellRects(unitCells(tip.stem), pal.body), light: unitCells(tip.light) },
      eyes: eyeColor(g.eyes),
      cheeks: cheeks(g.cheeks, pal),
      worn: wornItems(opts.worn, pal),
      outline: outlineFor(pal, opts.background),
    });
  }

  return { lookOf, unitCells, inBody, inFace };
});

// ---- bit-wardrobe.js
;((root, factory) => {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitWardrobe = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  /* What a personal Bit can wear, as plain data on Bit's 12x12 grid. A fill is '#rrggbb' or a
   * role of the Bit's own palette ('body', 'accent', 'shadow', 'cream', 'line', 'ink'), so the
   * same beanie looks different on every Bit. One item per slot; `back` is drawn behind the
   * body, the rest over it, face items under the eyes so Bit always looks out (a part may set
   * `layer` itself). Every item keeps the antenna (x 6, y <= 1) and its tip visible (the tip
   * shows mood), stays above the floor and fits every mood pose (where a big move such as
   * moonwalk would take it off the stage, x -3..14 y -5..12, bit.js sets it down for that
   * clip), and has no hearts, confetti or glows: validate() and the Bit Lab check it. Ids are
   * permanent (owned items are stored by id). A daily item has a tier (c, u, r: the gift's
   * odds, server/bit/gifts.js), a season item its season (SEASONS), a supporter item its month
   * ('YYYY-MM', one a month) and a shop item its price in Sparks; those two are kept through
   * the hub's key entryOf(item) (server/bit/keep.js). */

  const SLOTS = Object.freeze(['head', 'face', 'neck', 'back', 'feet', 'hand']);
  const SOURCES = Object.freeze(['trait', 'daily', 'season', 'supporter', 'shop', 'founder']);
  const SLATE = '#3b4250';
  const WHITE = '#f0f3f1';
  const GOLD = '#ffd75e';
  const PINK = '#ff8fa3';
  const RED = '#ff5a6e';
  const BROWN = '#8a5a3b';
  const LEAF = '#6fcf73';
  const ORANGE = '#ff8c2e';
  /** @typedef {{ id: string, slot: string, source: string, tier?: string, season?: string, month?: string, price?: number, layers: readonly object[] }} WardrobeItem */
  /** @type {(id: string, slot: string, source: string, layers: object[], extra?: { tier?: string, season?: string, month?: string, price?: number }) => Readonly<WardrobeItem>} */
  const I = (id, slot, source, layers, extra = {}) => Object.freeze({ id, slot, source, ...extra, layers: Object.freeze(layers) });
  const D = (tier) => ({ tier });
  const S = (season) => ({ season });
  const M = (month) => ({ month });
  const P = (price) => ({ price });
  const ARM = { fill: 'body', cells: [[10, 6]] };

  // When each season's items are given: [month, day] to [month, day], both kept.
  // 'birthday' is the Bit's own week, from the day it hatched (seasonsOn).
  const SEASONS = Object.freeze({
    winter: [[12, 1], [2, 29]],
    christmas: [[12, 15], [12, 31]],
    spring: [[3, 20], [6, 20]],
    summer: [[6, 21], [9, 22]],
    halloween: [[10, 15], [11, 2]],
    birthday: null,
  });
  const TIERS = Object.freeze(['c', 'u', 'r']);

  const ITEMS = Object.freeze([
    // head: around the antenna, never over it
    I('beanie', 'head', 'daily', [
      { fill: 'accent', cells: [[3, 1, 3], [7, 1, 2]] },
      { fill: 'cream', cells: [[2, 2, 8]] },
    ], D('c')),
    I('cap', 'head', 'daily', [
      { fill: 'accent', cells: [[3, 1, 3], [7, 1, 2], [3, 2, 6]] },
      { fill: SLATE, cells: [[9, 2, 2]] },
    ], D('c')),
    I('crown', 'head', 'supporter', [
      { fill: GOLD, cells: [[3, 1], [5, 1], [7, 1], [8, 1], [3, 2, 6]] },
      { fill: '#ff5a6e', cells: [[4, 2]] },
      { fill: '#5eead4', cells: [[7, 2]] },
    ], M('2026-12')),
    I('nightcap', 'head', 'trait', [
      { fill: '#8ab4f8', cells: [[3, 1, 3], [7, 1, 2], [2, 2, 8], [9, 1], [10, 2, 1, 2]] },
      { fill: WHITE, cells: [[10, 4]] },
    ]),
    I('headband', 'head', 'trait', [{ fill: '#ff5a6e', cells: [[3, 2, 6], [9, 2], [10, 3]] }]),
    I('flower', 'head', 'season', [
      { fill: '#ff8fa3', cells: [[8, 0], [7, 1], [9, 1], [8, 2]] },
      { fill: GOLD, cells: [[8, 1]] },
    ], S('spring')),
    I('headset', 'head', 'trait', [
      { fill: SLATE, cells: [[3, 1, 3], [7, 1, 2], [2, 2], [9, 2], [2, 8], [3, 9]] },
      { fill: 'accent', cells: [[1, 3, 1, 4], [10, 3, 1, 4]] },
    ]),
    I('earbuds', 'head', 'trait', [{ fill: WHITE, cells: [[1, 4, 1, 2], [10, 4, 1, 2]] }]),
    // face: under the eyes
    // round rims around each eye, open at the inner corners so they read as glasses, not a visor
    I('glasses', 'face', 'trait', [{ fill: 'line', cells: [[4, 3], [7, 3], [3, 4, 1, 2], [8, 4, 1, 2], [5, 4, 2], [4, 6], [7, 6]] }]),
    I('monocle', 'face', 'shop', [
      { fill: GOLD, cells: [[6, 3, 3], [6, 6, 3], [6, 4, 1, 2], [8, 4, 1, 2]] },
      { fill: GOLD, o: 0.7, cells: [[9, 7], [9, 8]] },
    ], P(150)),
    // neck
    I('scarf', 'neck', 'season', [{ fill: 'accent', cells: [[2, 8, 8], [8, 9, 1, 2]] }], S('winter')),
    // Two wings that flare at the tips, round a darker knot: upright bars by the mouth read as fangs.
    I('bowtie', 'neck', 'shop', [
      { fill: 'accent', cells: [[3, 8], [8, 8], [3, 9, 2], [7, 9, 2]] },
      { fill: 'shadow', cells: [[5, 9, 2]] },
    ], P(50)),
    I('medal', 'neck', 'founder', [
      { fill: 'accent', cells: [[4, 8], [7, 8], [5, 9, 2]] },
      { fill: GOLD, cells: [[5, 10, 2]] },
    ]),
    // back: behind the body, with front straps where needed
    I('backpack', 'back', 'trait', [
      { fill: 'accent', cells: [[1, 4, 1, 5], [10, 4, 1, 5]] },
      { fill: SLATE, layer: 'over', cells: [[2, 3, 1, 6], [9, 3, 1, 6]] },
    ]),
    I('cape', 'back', 'supporter', [{ fill: 'accent', cells: [[1, 3, 1, 7], [10, 3, 1, 7], [1, 10, 2], [9, 10, 2]] }], M('2027-01')),
    // White on top, grey feathers under: all-white wings vanish on a light theme.
    I('wings', 'back', 'supporter', [
      { fill: WHITE, cells: [[0, 3, 2], [0, 4, 2], [10, 3, 2], [10, 4, 2]] },
      { fill: '#c3cad3', cells: [[-1, 4], [12, 4]] },
      { fill: '#8d97a5', cells: [[0, 5, 2], [10, 5, 2]] },
    ], M('2027-02')),
    // feet
    I('sneakers', 'feet', 'daily', [
      { fill: WHITE, cells: [[3, 10, 2], [7, 10, 2]] },
      { fill: 'accent', cells: [[4, 10], [8, 10]] },
    ], D('c')),
    I('boots', 'feet', 'shop', [{ fill: '#8a5a3b', cells: [[3, 9, 2, 2], [7, 9, 2, 2]] }], P(100)),
    // hand: held on Bit's right, with a little arm in its own colour
    I('mug', 'hand', 'trait', [
      { fill: 'body', cells: [[10, 6]] },
      { fill: WHITE, cells: [[11, 5, 2, 3], [13, 6]] },
      { fill: 'accent', cells: [[11, 6, 2]] },
    ]),
    I('camera', 'hand', 'trait', [
      { fill: 'body', cells: [[10, 6]] },
      { fill: SLATE, cells: [[11, 5, 3, 2]] },
      { fill: 'cream', cells: [[12, 5]] },
    ]),

    // ── the daily gift's pool ──
    I('bandana', 'head', 'daily', [
      { fill: 'accent', cells: [[3, 1, 3], [7, 1, 2], [2, 2, 8], [10, 2], [11, 3]] },
      { fill: 'cream', cells: [[4, 1], [8, 1], [3, 2], [6, 2], [9, 2]] },
    ], D('c')),
    I('bucketHat', 'head', 'daily', [
      { fill: '#d9c9a3', cells: [[3, 0, 3], [7, 0, 2], [1, 2, 10]] },
      { fill: 'shadow', cells: [[3, 1, 3], [7, 1, 2]] },
    ], D('c')),
    I('bow', 'head', 'daily', [{ fill: PINK, cells: [[8, 0, 1, 3], [10, 0, 1, 3]] }, { fill: '#e0607a', cells: [[9, 1]] }], D('c')),
    I('beret', 'head', 'daily', [{ fill: 'accent', cells: [[2, 1, 4], [7, 1, 3], [1, 2, 9]] }, { fill: 'shadow', cells: [[4, 0]] }], D('u')),
    I('seedling', 'head', 'daily', [{ fill: '#3f9a4a', cells: [[8, 0, 1, 2]] }, { fill: LEAF, cells: [[7, 0], [9, -1, 2]] }], D('u')),
    I('goggles', 'head', 'daily', [{ fill: SLATE, cells: [[2, 2, 8]] }, { fill: '#5eead4', cells: [[3, 1, 2], [7, 1, 2]] }], D('u')),
    I('topHat', 'head', 'daily', [{ fill: SLATE, cells: [[3, 0, 3], [7, 0, 3], [1, 2, 10]] }, { fill: 'accent', cells: [[3, 1, 3], [7, 1, 3]] }], D('r')),
    I('kerchief', 'neck', 'daily', [
      { fill: 'accent', cells: [[3, 8, 6], [4, 9, 4], [5, 10, 2]] },
      { fill: 'cream', cells: [[4, 8], [7, 8], [6, 9]] },
    ], D('c')),
    I('collar', 'neck', 'daily', [{ fill: RED, cells: [[2, 8, 8]] }, { fill: GOLD, cells: [[5, 9, 2]] }], D('c')),
    I('tie', 'neck', 'daily', [{ fill: 'shadow', cells: [[5, 8, 2]] }, { fill: 'accent', cells: [[5, 9, 2, 2]] }], D('u')),
    I('slippers', 'feet', 'daily', [{ fill: PINK, cells: [[2, 10, 3], [7, 10, 3]] }, { fill: WHITE, cells: [[2, 10], [9, 10]] }], D('c')),
    I('rainBoots', 'feet', 'daily', [{ fill: GOLD, cells: [[3, 9, 2, 2], [7, 9, 2, 2]] }], D('u')),
    I('lollipop', 'hand', 'daily', [
      ARM,
      { fill: WHITE, cells: [[11, 4, 1, 3]] },
      { fill: PINK, cells: [[11, 2, 2, 2]] },
      { fill: WHITE, cells: [[12, 2]] },
    ], D('c')),
    I('book', 'hand', 'daily', [
      ARM,
      { fill: '#4a7bd0', cells: [[11, 5, 2, 3]] },
      { fill: WHITE, cells: [[13, 5, 1, 3]] },
    ], D('u')),
    I('gamepad', 'hand', 'daily', [
      ARM,
      { fill: SLATE, cells: [[11, 6, 3, 2]] },
      { fill: WHITE, cells: [[11, 6]] },
      { fill: RED, cells: [[13, 6]] },
    ], D('u')),
    I('balloon', 'hand', 'daily', [
      ARM,
      { fill: 'line', cells: [[11, 2, 1, 5]] },
      { fill: RED, cells: [[10, -1, 3, 3]] },
      { fill: WHITE, cells: [[10, -1]] },
    ], D('r')),
    I('guitar', 'back', 'daily', [
      { fill: '#c47a3d', cells: [[10, 6, 2, 3]] },
      { fill: SLATE, cells: [[11, 7], [10, 1, 2]] },
      { fill: BROWN, cells: [[10, 2, 1, 4]] },
    ], D('r')),

    // ── seasons: given to every Bit while the season lasts, kept for good ──
    I('santaHat', 'head', 'season', [
      { fill: '#e5484d', cells: [[3, 1, 3], [7, 1, 2], [8, 0, 2], [10, 1]] },
      { fill: WHITE, cells: [[2, 2, 8], [11, 2]] },
    ], S('christmas')),
    I('antlers', 'head', 'season', [{ fill: BROWN, cells: [[3, 0, 1, 2], [2, -1], [1, -2, 2], [8, 0, 1, 2], [9, -1], [9, -2, 2]] }], S('winter')),
    I('witchHat', 'head', 'season', [
      { fill: '#5b3f8c', cells: [[1, 2, 10], [4, 0, 2], [7, 0, 3], [10, -1]] },
      { fill: ORANGE, cells: [[3, 1, 3], [7, 1, 3]] },
    ], S('halloween')),
    I('pumpkin', 'hand', 'season', [
      ARM,
      { fill: ORANGE, cells: [[11, 5, 3, 3]] },
      { fill: '#3f9a4a', cells: [[12, 4]] },
      { fill: SLATE, cells: [[11, 6], [13, 6]] },
    ], S('halloween')),
    I('partyHat', 'head', 'season', [
      { fill: 'accent', cells: [[8, 1, 3], [9, 0]] },
      { fill: WHITE, cells: [[9, 1]] },
      { fill: GOLD, cells: [[9, -1]] },
    ], S('birthday')),
    I('lei', 'neck', 'season', [
      { fill: PINK, cells: [[2, 8], [4, 8], [6, 8], [8, 8]] },
      { fill: GOLD, cells: [[3, 8], [5, 8], [7, 8], [9, 8]] },
    ], S('summer')),
    I('iceCream', 'hand', 'season', [
      ARM,
      { fill: PINK, cells: [[11, 4, 2, 2]] },
      { fill: '#d9a066', cells: [[11, 6, 2], [11, 7]] },
    ], S('summer')),
  ]);

  const BY_ID = new Map(ITEMS.map((i) => [i.id, i]));

  const item = (id) => BY_ID.get(id) || null;

  function cellsOf(it) {
    const out = [];
    for (const part of it.layers) {
      for (const [x, y, w = 1, h = 1] of part.cells) {
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push([x + i, y + j]);
      }
    }
    return out;
  }

  /**
   * The problems with one item, empty when it keeps every rule. `tipCells`
   * are the antenna-tip cells of the Bit (or of every tip), which must stay
   * visible.
   * @returns {string[]}
   */
  function validate(it, tipCells = []) {
    const errors = [];
    if (!/^[a-z][a-zA-Z0-9]{1,31}$/.test(it.id || '')) errors.push('id');
    if (!SLOTS.includes(it.slot)) errors.push('slot');
    if (!SOURCES.includes(it.source)) errors.push('source');
    if (it.source === 'daily' && !TIERS.includes(it.tier)) errors.push('tier');
    if (it.source === 'season' && !Object.hasOwn(SEASONS, it.season)) errors.push('season');
    if (it.source === 'supporter' && !MONTH.test(it.month || '')) errors.push('month');
    if (it.source === 'shop' && !(Number.isInteger(it.price) && it.price >= 50 && it.price <= 300)) errors.push('price');
    const keep = new Set([[6, 0], [6, 1], ...tipCells].map(([x, y]) => `${x},${y}`));
    for (const [x, y] of cellsOf(it)) {
      if (x < -3 || x > 14 || y < -5 || y > 10) errors.push(`outside ${x},${y}`);
      if (keep.has(`${x},${y}`)) errors.push(`covers antenna ${x},${y}`);
    }
    for (const part of it.layers) {
      if (!/^(#[0-9a-f]{6}|body|accent|shadow|cream|line|ink)$/i.test(part.fill)) errors.push(`fill ${part.fill}`);
      if (part.layer && !['behind', 'over', 'face'].includes(part.layer)) errors.push(`layer ${part.layer}`);
    }
    return errors;
  }

  const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
  /** The month of `date` as 'YYYY-MM', in UTC: the app and the hub agree on when a month starts. */
  const monthOf = (date) => date.toISOString().slice(0, 7);
  /** The supporter items out by `date`: this month's and every one before it. */
  const supporterOut = (date) => ITEMS.filter((it) => it.source === 'supporter' && it.month <= monthOf(date));
  /** The hub's key of a supporter or shop item: 'bit-' and the id in kebab case (topHat → bit-top-hat). */
  const entryOf = (it) => `bit-${it.id.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

  const md = (m, d) => m * 100 + d;
  const DAY_MS = 864e5;
  /**
   * The seasons running on `date` (local time). `born` is when the Bit hatched:
   * from its first birthday on, the week that starts on that day is its own season.
   * @returns {string[]}
   */
  function seasonsOn(date, born) {
    const today = md(date.getMonth() + 1, date.getDate());
    const out = [];
    for (const [id, span] of Object.entries(SEASONS)) {
      if (!span) continue;
      const from = md(...span[0]);
      const to = md(...span[1]);
      if (from <= to ? today >= from && today <= to : today >= from || today <= to) out.push(id);
    }
    const b = born ? new Date(born) : null;
    if (b && !Number.isNaN(b.getTime()) && date.getFullYear() > b.getFullYear()) {
      const birthday = new Date(date.getFullYear(), b.getMonth(), b.getDate());
      const since = Math.round((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - birthday.getTime()) / DAY_MS);
      if (since >= 0 && since < 7) out.push('birthday');
    }
    return out;
  }

  /** One item per slot, last one wins; unknown ids are dropped. */
  function outfit(ids) {
    const bySlot = new Map();
    for (const id of ids || []) {
      const it = item(id);
      if (it) bySlot.set(it.slot, it);
    }
    return SLOTS.map((s) => bySlot.get(s)).filter(Boolean);
  }

  return { SLOTS, SOURCES, TIERS, SEASONS, ITEMS, item, cellsOf, validate, outfit, seasonsOn, monthOf, supporterOut, entryOf };
});

// ---- bit.js
;((root, factory) => {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const clips = node ? require('./bit-clips.js') : root.Xenon.bitClips;
  // Extra clip packs (the hatch, life moments). In a page a pack loaded before this file
  // waits in Xenon.bitPacks, one loaded after calls addPack(); a page that skips one just
  // lacks those clips.
  const packs = node ? [require('./bit-clips-life.js')] : (root.Xenon?.bitPacks) || [];
  const mod = factory(clips, packs);
  if (node) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bit = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, (data, packs) => {
  'use strict';

  /* Bit's renderer: a clip frame in, plain rectangles out. Pure, so the same
   * output feeds the live SVG player, the export tool and the tests. Layers
   * are drawn in order: shadow, back extras, glitch ghosts, body (with its
   * face and attached extras, moved by the frame's transform), front extras. */

  const { INK, MOOD_RGB, BODY, EYES, MOUTHS, BROWS, CHEEKS, POKES } = data;
  const PARTS = Object.assign({}, data.PARTS);
  const CLIPS = [...data.CLIPS];

  // The stage around Bit's 12x12 grid; see bit-clips.js for the coordinates.
  const STAGE = Object.freeze({ x: -3, y: -5, w: 18, h: 17 });
  const PIVOT_X = 6;
  const FLOOR_Y = 11;
  const GLITCH = ['255,90,95', '94,234,212'];

  const BY_ID = new Map(CLIPS.map((c) => [c.id, c]));

  function clip(id) {
    return BY_ID.get(id) || null;
  }

  /** Adds a clip pack's parts and clips; an id already known keeps its first definition. */
  function addPack(pack) {
    for (const [name, part] of Object.entries((pack?.PARTS) || {})) if (!(name in PARTS)) PARTS[name] = part;
    for (const c of (pack?.CLIPS) || []) {
      if (BY_ID.has(c.id)) continue;
      CLIPS.push(c);
      BY_ID.set(c.id, c);
    }
  }
  packs.forEach(addPack);

  function rgb(tint) {
    if (!tint) return MOOD_RGB.idle;
    return MOOD_RGB[tint] || (/^\d{1,3},\d{1,3},\d{1,3}$/.test(tint) ? tint : MOOD_RGB.idle);
  }

  function shapeCells(shape) {
    if (!shape) return { fill: INK, cells: [] };
    return Array.isArray(shape) ? { fill: INK, cells: shape } : shape;
  }

  function rects(cells, fill, dx = 0, dy = 0, o = 1) {
    return cells.map(([x, y, w = 1, h = 1]) => ({ x: x + dx, y: y + dy, w, h, fill, o }));
  }

  // An extra is 'name' or ['name', dx, dy, opacity]; unknown names are skipped.
  function extra(entry, bodyFill, accent) {
    const [name, dx = 0, dy = 0, op = 1] = Array.isArray(entry) ? entry : [entry];
    const part = PARTS[name];
    if (!part || op <= 0) return null;
    const fill = part.fill === 'body' ? bodyFill : part.fill === 'accent' ? accent : part.fill;
    const o = op * (part.opacity == null ? 1 : part.opacity);
    return { part, rects: rects(part.cells, fill, dx, dy, o) };
  }

  // A personal look (bit-look.js) recolours the ink eyes and brings its own cheeks.
  function face(frame, look) {
    const eyes = shapeCells(EYES[frame.eyes || 'open'] || EYES.open);
    const mouth = shapeCells(MOUTHS[frame.mouth || 'flat'] || MOUTHS.flat);
    const brows = shapeCells(BROWS[frame.brows || 'none'] || BROWS.none);
    const eyeFill = look && eyes.fill === INK ? look.eyes : eyes.fill;
    const out = [...rects(eyes.cells, eyeFill), ...rects(mouth.cells, mouth.fill), ...rects(brows.cells, brows.fill)];
    const ch = look ? look.cheeks : CHEEKS;
    if (frame.cheeks || ch.always) out.unshift(...rects(ch.cells, ch.fill, 0, 0, frame.cheeks ? Math.max(ch.opacity, CHEEKS.opacity) : ch.opacity));
    return out;
  }

  // The look's markings, antenna tip (its light shows the mood) and worn items.
  function personal(look, mood, over) {
    return [...look.marks, ...look.tip.stem, ...rects(look.tip.light, mood), ...over];
  }

  // A half-cell ring of the body shape, so a pale Bit stays visible on a pale background.
  function outline(fill) {
    return [[-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5]].flatMap(([dx, dy]) => rects(BODY, fill, dx, dy));
  }

  // Body transform: move by dx/dy, scale from the middle of the feet.
  function transform(frame) {
    const dx = frame.dx || 0;
    const dy = frame.dy || 0;
    const sx = frame.sx == null ? 1 : frame.sx;
    const sy = frame.sy == null ? 1 : frame.sy;
    if (!dx && !dy && sx === 1 && sy === 1) return null;
    return { dx, dy, sx, sy, px: PIVOT_X, py: FLOOR_Y };
  }

  /* A worn item that would leave the stage in any frame of a clip is set down
   * for that whole clip (a held mug in the moonwalk) instead of being cut off.
   * Cached per clip and item: the answer depends only on the item's cells. */
  const fitCache = new WeakMap();
  function inStage(frame, box) {
    const { dx, dy, sx, sy } = transform(frame) || { dx: 0, dy: 0, sx: 1, sy: 1 };
    const xs = [box.x0, box.x1].map((v) => dx + PIVOT_X + sx * (v - PIVOT_X));
    const top = dy + FLOOR_Y + sy * (box.y0 - FLOOR_Y);
    return Math.min(...xs) >= STAGE.x - 0.01 && Math.max(...xs) <= STAGE.x + STAGE.w + 0.01 && top >= STAGE.y - 0.01;
  }
  function wornFor(look, c) {
    if (!fitCache.has(c)) fitCache.set(c, new Map());
    const fits = fitCache.get(c);
    const out = { behind: [], over: [], face: [] };
    for (const w of look.worn) {
      if (!fits.has(w.id)) fits.set(w.id, c.frames.every((f) => inStage(f, w.box)));
      if (fits.get(w.id)) for (const k of Object.keys(out)) out[k].push(...w[k]);
    }
    return out;
  }

  /**
   * Render one frame of a clip to layers of rectangles.
   * @param {object|string} clipOrId  a clip from bit-clips.js or its id
   * @param {number} index            frame index (wraps)
   * @param {{tint?: string, look?: { body: string, accent: string, outline?: string } & Record<string, any>}} [opts]  tint overrides the clip's color;
   *   look (bit-look.js) draws a personal Bit, whose mood then lights the antenna tip
   * @returns {{ layers: Array<{ transform: object|null, clipFloor: boolean, rects: Array }> }}
   */
  function renderFrame(clipOrId, index = 0, opts = {}) {
    const c = typeof clipOrId === 'string' ? clip(clipOrId) : clipOrId;
    if (!c?.frames.length) throw new Error(`Unknown Bit clip: ${clipOrId}`);
    const frame = c.frames[((index % c.frames.length) + c.frames.length) % c.frames.length];
    const mood = `rgb(${rgb(frame.tint || opts.tint || c.tint)})`;
    const look = opts.look || null;
    const fill = look ? look.body : mood;
    const worn = look ? wornFor(look, c) : null;
    const t = transform(frame);

    const back = [];
    const front = [];
    const attached = [];
    for (const entry of frame.ex || []) {
      const e = extra(entry, fill, look ? look.accent : fill);
      if (!e) continue;
      if (e.part.back) back.push(...e.rects);
      else if (e.part.attach) attached.push(...e.rects);
      else front.push(...e.rects);
    }

    const layers = [];
    if (!frame.noShadow) {
      const lift = Math.max(0, -(frame.dy || 0));
      const w = Math.max(2, 6 - lift);
      layers.push({ transform: null, clipFloor: false, rects: [{ x: PIVOT_X - w / 2 + (frame.dx || 0), y: FLOOR_Y, w, h: 0.6, fill, o: 0.16 }] });
    }
    if (back.length) layers.push({ transform: null, clipFloor: false, rects: back });
    if (frame.glitch) {
      const off = frame.glitch;
      GLITCH.forEach((g, k) => {
        const shift = k ? off : -off;
        layers.push({ transform: t, clipFloor: true, rects: rects(BODY, `rgb(${g})`, shift, 0, 0.75) });
      });
    }
    if (look?.outline) layers.push({ transform: t, clipFloor: true, rects: outline(look.outline) });
    if (worn?.behind.length) layers.push({ transform: t, clipFloor: true, rects: worn.behind });
    const own = look ? personal(look, mood, worn.over) : [];
    layers.push({ transform: t, clipFloor: true, rects: [...rects(BODY, fill), ...own, ...attached, ...(worn ? worn.face : []), ...face(frame, look)] });
    if (front.length) layers.push({ transform: null, clipFloor: false, rects: front });
    return { layers };
  }

  function round(n) {
    return Math.round(n * 1000) / 1000;
  }

  function transformAttr(t) {
    if (!t) return '';
    const tx = round(t.dx + t.px - t.px * t.sx);
    const ty = round(t.dy + t.py - t.py * t.sy);
    return `translate(${tx} ${ty}) scale(${round(t.sx)} ${round(t.sy)})`;
  }

  /**
   * A layer's rects as paths, one per run of the same colour, in paint order.
   * Bit is painted anti-aliased on purpose: crispEdges snaps every cell on its
   * own, so at 2.5 device pixels a cell (a 20 px icon at 150%) one eye comes out
   * 2 px wide and the other 3. One path per colour leaves no seam between cells.
   * @returns {{d: string, fill: string, o: number}[]}
   */
  function paths(rects) {
    const out = [];
    for (const r of rects) {
      const seg = `M${round(r.x)} ${round(r.y)}h${round(r.w)}v${round(r.h)}h${round(-r.w)}z`;
      const last = out[out.length - 1];
      if (last && last.fill === r.fill && last.o === r.o) last.d += seg;
      else out.push({ d: seg, fill: r.fill, o: r.o });
    }
    return out;
  }

  /**
   * One frame as standalone SVG markup, for the export tool and static
   * images. Only numbers and colors from bit-clips.js go in, never user text.
   */
  function frameSvg(clipOrId, index = 0, opts = {}) {
    const { layers } = renderFrame(clipOrId, index, opts);
    const size = opts.size || 144;
    const clipId = /^[A-Za-z][\w-]{0,40}$/.test(opts.clipId || '') ? opts.clipId : 'bitfloor';
    const body = layers
      .map((l) => {
        const rs = paths(l.rects)
          .map((p) => `<path d="${p.d}" fill="${p.fill}"${p.o < 1 ? ` opacity="${round(p.o)}"` : ''}/>`)
          .join('');
        const tr = transformAttr(l.transform);
        const g = `<g${tr ? ` transform="${tr}"` : ''}>${rs}</g>`;
        return l.clipFloor ? `<g clip-path="url(#${clipId})">${g}</g>` : g;
      })
      .join('');
    const bg = opts.background ? `<rect x="${STAGE.x}" y="${STAGE.y}" width="${STAGE.w}" height="${STAGE.h}" fill="${opts.background}"/>` : '';
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${STAGE.x} ${STAGE.y} ${STAGE.w} ${STAGE.h}" width="${size}" height="${round((size * STAGE.h) / STAGE.w)}">` +
      `<defs><clipPath id="${clipId}"><rect x="${STAGE.x}" y="${STAGE.y}" width="${STAGE.w}" height="${FLOOR_Y - STAGE.y}"/></clipPath></defs>` +
      bg +
      body +
      '</svg>'
    );
  }

  function duration(clipOrId) {
    const c = typeof clipOrId === 'string' ? clip(clipOrId) : clipOrId;
    return c ? c.frames.reduce((s, f) => s + f.ms, 0) : 0;
  }

  return {
    STAGE,
    INK,
    MOOD_RGB,
    POKES,
    parts: PARTS,
    clips: CLIPS,
    clip,
    addPack,
    rgb,
    renderFrame,
    paths,
    frameSvg,
    transformAttr,
    duration,
  };
});

// ---- bit-clips-life.js
;((root, factory) => {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else if (root.Xenon?.bit?.addPack) root.Xenon.bit.addPack(mod);
  else {
    root.Xenon = root.Xenon || {};
    root.Xenon.bitPacks = root.Xenon.bitPacks || [];
    root.Xenon.bitPacks.push(mod);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  /* Bit's life moments: the hatch, the moments the director (bit-director.js) reacts with (the
   * PC, Xenon, the Vitals) and a few fidgets for the weather and the music. Same data shape as
   * bit-clips.js (which is full and may only shrink); bit.js adds these parts and clips to its
   * own. No hearts, confetti, star eyes or springy bounces: a personal Bit reacts like a small
   * creature, not like a notification, and jumps stay within two cells so what it wears stays
   * on. The egg is drawn in front of Bit and covers it whole (antenna tips included, up to
   * y -4), so the body never changes shape: Bit is inside from the first frame and the shell
   * simply comes off. Spots use the Bit's accent colour, a first hint of who is coming out. */

  const SHELL = '#f3ede0';
  const CRACK = '#b9ae95';
  const P = (fill, cells, opts) => Object.freeze({ fill, cells, attach: false, back: false, ...opts });
  const A = (fill, cells, opts) => P(fill, cells, { attach: true, ...opts });
  const INK = '#3b4250';
  const STEEL = '#a6b1ad';
  const PAPER = '#f0f3f1';
  const CARD = '#c08a5b';

  const PARTS = Object.freeze({
    eggTop: P(SHELL, [[4, -4, 4], [3, -3, 6], [2, -2, 8], [1, -1, 10, 7], [1, 6], [3, 6], [5, 6], [7, 6], [9, 6]]),
    eggBottom: P(SHELL, [[2, 6], [4, 6], [6, 6], [8, 6], [10, 6], [1, 7, 10, 2], [2, 9, 8], [3, 10, 6]]),
    eggSpotsTop: P('accent', [[3, 0], [7, -2], [8, 3]]),
    eggSpotsBottom: P('accent', [[3, 8], [7, 9], [9, 7]]),
    crackA: P(CRACK, [[6, -2], [5, -1], [6, 0], [5, 1]]),
    crackB: P(CRACK, [[1, 6], [2, 5], [3, 6], [4, 5], [5, 6], [6, 5], [7, 6], [8, 5], [9, 6], [10, 5]]),
    shard: P(SHELL, [[0, 0, 2], [0, 1]]),
    // Held things move with Bit (A); things in the world stay put (P).
    fanA: A(STEEL, [[10, 6], [11, 4, 1, 2], [12, 3, 1, 2]]),
    fanB: A(STEEL, [[10, 6], [11, 6, 1, 2], [12, 6, 1, 2]]),
    guitar: A('#ff5a6e', [[1, 7, 3, 2], [2, 9]]),
    neck: A(CARD, [[4, 7], [5, 6], [6, 5], [7, 4], [8, 3]]),
    lid: A(INK, [[3, 7, 6, 2]]),
    lidMark: A('accent', [[5, 7, 2, 1]], { opacity: 0.9 }),
    keys: A(STEEL, [[2, 9, 8, 1]]),
    check: P('#7be38f', [[10, 0], [11, 1], [12, 0], [13, -1], [14, -2]]),
    signPost: A(CARD, [[11, 0, 1, 5]]),
    signBoard: A(PAPER, [[9, -3, 5, 3]]),
    signLines: A(STEEL, [[10, -2, 3, 1]]),
    watch: A('#ffd75e', [[0, 6]]),
    box: P(CARD, [[0, 0, 3, 3]]),
    tape: P(PAPER, [[1, 0, 1, 3]]),
    wrenchA: A(STEEL, [[10, 5], [11, 4], [12, 3], [12, 2], [13, 3]]),
    wrenchB: A(STEEL, [[10, 5], [11, 5], [12, 5], [13, 4], [13, 6]]),
    gift: P('accent', [[3, 8, 6, 3]]),
    ribbon: P('#ffd75e', [[5, 8, 2, 3], [3, 9, 6, 1]]),
    giftLid: P('accent', [[2, 7, 8, 1]]),
    spk: P('#ffe58a', [[1, 0], [0, 1, 3], [1, 2]]),
    glass: A('#7dd3fc', [[10, 5, 2, 3]], { opacity: 0.85 }),
    glassUp: A('#7dd3fc', [[8, 6, 2, 2]], { opacity: 0.85 }),
    cone: A(CARD, [[10, 6, 1, 2]]),
    scoop: A('#ff8fa3', [[10, 4, 2, 2]]),
    snowBase: P(PAPER, [[11, 8, 3, 3]]),
    snowHead: P(PAPER, [[11.5, 6, 2, 2]]),
    snowFace: P(INK, [[12, 6.5, 0.5, 0.5], [13, 6.5, 0.5, 0.5]]),
    snowNose: P('#ff9f43', [[13.5, 7, 0.8, 0.5]]),
  });

  const F = (ms, props) => Object.freeze({ ms, ...props });
  const times = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

  const top = (dx, dy, o) => [['eggTop', dx, dy, o], ['eggSpotsTop', dx, dy, o]];
  const bottom = (dy = 0, o = 1) => [['eggBottom', 0, dy, o], ['eggSpotsBottom', 0, dy, o]];
  // Both halves of the shell before the spots: one colour in a row is painted as one path,
  // so the zigzag where they meet shows no seam until the crack is drawn.
  const whole = (dx = 0, cracks = []) => [
    ['eggTop', dx, 0, 1], ['eggBottom', 0, 0, 1], ['eggSpotsTop', dx, 0, 1], ['eggSpotsBottom', 0, 0, 1],
    ...cracks.map((n) => [n, dx, 0, 1]),
  ];
  const wobble = (n, ms, cracks) => times(n, (i) => F(ms, { ex: whole(i % 2 ? 0.5 : -0.5, cracks) }));
  // The shell's top bursts into pieces that fly out and fall: t is time, o opacity.
  const SHARDS = [[1, -1, -1], [4, -3, -0.5], [7, -3, 0.5], [9, -1, 1], [1, 3, -1.2], [10, 3, 1.2]];
  const shards = (t, o) => SHARDS.map(([x, y, dir]) => ['shard', x + dir * t * 1.5, y - t + t * t * 0.4, o]);

  const LIFE = [
    {
      id: 'hatch',
      frames: [
        F(900, { ex: whole() }),
        ...wobble(4, 100, []),
        F(600, { ex: whole(0, ['crackA']) }),
        ...wobble(6, 80, ['crackA']),
        F(500, { ex: whole(0, ['crackA', 'crackB']) }),
        F(120, { eyes: 'wide', ex: [...bottom(), ...top(0, -1, 1)] }),
        F(120, { eyes: 'wide', ex: [...bottom(), ...shards(0, 1)] }),
        F(120, { eyes: 'wide', ex: [...bottom(), ...shards(1.5, 0.8)] }),
        F(140, { eyes: 'wide', ex: [...bottom(), ...shards(3, 0.45)] }),
        F(700, { ex: bottom() }),
        F(120, { eyes: 'blink', ex: bottom() }),
        F(500, { eyes: 'left', ex: bottom() }),
        F(500, { eyes: 'right', ex: bottom() }),
        F(160, { sy: 0.9, ex: bottom() }),
        F(180, { dy: -3, eyes: 'happy', mouth: 'grin', ex: bottom(1, 0.6) }),
        F(180, { dy: -2, eyes: 'happy', mouth: 'grin', ex: bottom(3, 0.2) }),
        F(140, { sy: 0.88, eyes: 'happy', mouth: 'smile' }),
        F(900, { eyes: 'happy', mouth: 'smile', cheeks: true, ex: ['spark'] }),
        ...times(2, () => [F(220, { mouth: 'smile', ex: ['waveA'] }), F(220, { mouth: 'smile', ex: ['waveB'] })]).flat(),
        F(600, { mouth: 'smile' }),
      ],
    },
    // The egg before it hatches (the companion's place): still, with a wobble now and then.
    { id: 'egg', kind: 'mood', frames: [F(1300, { ex: whole() }), F(1300, { ex: whole() }), ...wobble(4, 110, []), F(1600, { ex: whole() })] },
  ].map((c) => ({ kind: 'react', ...c }));

  // What the director reacts with (bit-director.js EVENTS names them).
  const held = (n, ms, fn) => times(n, (i) => F(ms, fn(i)));
  const lap = ['lid', 'lidMark', 'keys'];
  const sign = ['signPost', 'signBoard', 'signLines', 'armR'];
  const pad = ['controller', 'pad', 'btnA', 'btnB'];
  const gift = (lidDy, o = 1) => [['gift', 0, 0, 1], ['ribbon', 0, 0, 1], ['giftLid', 0, lidDy, o]];
  const sparks = (n) => [[1, -4], [5, -5], [9, -4]].slice(0, n).map(([x, y]) => ['spk', x, y, 1]);
  const box = (y) => [['box', 4.5, y, 1], ['tape', 4.5, y, 1]];

  const REACT = [
    { id: 'fanSelf', frames: held(8, 180, (i) => ({ tint: 'hot', eyes: 'squint', mouth: 'open', ex: [i % 2 ? 'fanB' : 'fanA', ['sweat', -9, i % 2, 1]] })) },
    {
      id: 'panic',
      frames: [
        ...held(6, 110, (i) => ({ tint: 'hot', eyes: 'wide', mouth: 'open', dx: i % 2 ? 1 : -1, ex: ['sweat', ['sweat', -9, 0, 1], ['exclaim', 12, -4, 1]] })),
        F(500, { tint: 'hot', eyes: 'squint', mouth: 'wavy', ex: ['sweat'] }),
      ],
    },
    {
      id: 'wobble',
      frames: [
        ...held(6, 140, (i) => ({ eyes: 'dizzy', mouth: 'wavy', dx: [0.5, -0.5, 0.5, -0.5, 0.3, 0][i], sx: i % 2 ? 0.97 : 1.01 })),
        F(160, { eyes: 'blink' }),
        F(400, { mouth: 'flat' }),
      ],
    },
    {
      id: 'padReady',
      frames: [
        F(300, { eyes: 'down', ex: pad }),
        F(200, { dy: 1, eyes: 'squint', brows: 'angry', ex: pad }),
        F(700, { eyes: 'squint', brows: 'angry', mouth: 'flat', ex: pad }),
        F(300, { eyes: 'wink', mouth: 'grin', ex: pad }),
      ],
    },
    {
      id: 'cheer',
      frames: [
        ...held(4, 200, (i) => ({ dy: i % 2 ? 0 : -1, eyes: 'happy', mouth: 'grin', ex: [i % 2 ? 'armsOut' : 'armsUp'] })),
        F(600, { eyes: 'happy', mouth: 'smile', cheeks: true, ex: ['armsUp', 'spark'] }),
      ],
    },
    {
      id: 'airGuitar',
      frames: held(8, 200, (i) => ({
        dy: i % 2,
        eyes: i % 4 < 2 ? 'happy' : 'squint',
        mouth: i % 4 < 2 ? 'grin' : 'open',
        ex: ['guitar', 'neck', i % 2 ? 'armROut' : 'armR', ['note', i % 2 ? 12 : 11, -3 - (i % 3), 1]],
      })),
    },
    {
      id: 'laptop',
      frames: [
        F(300, { eyes: 'down', ex: lap }),
        ...held(6, 160, (i) => ({ eyes: 'down', dy: i % 2 ? 0.3 : 0, ex: [...lap.slice(0, i % 3 ? 1 : 2), 'keys'] })),
        F(500, { eyes: 'up', mouth: 'flat', ex: lap }),
      ],
    },
    { id: 'allDone', frames: [F(200, { dy: 1, eyes: 'happy' }), F(800, { eyes: 'wink', mouth: 'grin', ex: ['armR', 'check'] }), F(300, { mouth: 'smile', ex: [['check', 0, 0, 0.6]] })] },
    {
      id: 'sign',
      frames: [
        F(160, { eyes: 'up', ex: [['signBoard', 0, 3, 0.4], 'signPost', 'armR'] }),
        F(900, { eyes: 'right', mouth: 'open', ex: sign }),
        F(400, { eyes: 'open', mouth: 'smile', ex: sign }),
      ],
    },
    {
      id: 'watch',
      frames: [
        F(400, { eyes: 'left', ex: ['armLOut', 'watch'] }),
        F(300, { eyes: 'down', ex: ['armLOut', 'watch'] }),
        F(500, { eyes: 'wide', mouth: 'open', ex: ['armLOut', 'watch', ['exclaim', -2, -3, 1]] }),
        F(300, { eyes: 'open', mouth: 'flat' }),
      ],
    },
    {
      id: 'catchBox',
      frames: [
        F(200, { eyes: 'up', ex: box(-5) }),
        F(140, { eyes: 'up', mouth: 'open', ex: ['armsUp', ...box(-3)] }),
        F(160, { sy: 0.92, eyes: 'squint', ex: ['armsUp', ...box(-1.5)] }),
        F(600, { eyes: 'happy', mouth: 'smile', ex: ['armsUp', ...box(-1)] }),
      ],
    },
    { id: 'wrench', frames: [...held(6, 180, (i) => ({ eyes: 'squint', mouth: 'flat', ex: [i % 2 ? 'wrenchB' : 'wrenchA'] })), F(500, { eyes: 'happy', mouth: 'smile', ex: ['wrenchA', 'spark'] })] },
    {
      id: 'unbox',
      frames: [
        F(500, { eyes: 'down', ex: gift(0) }),
        F(160, { eyes: 'wide', ex: gift(-2) }),
        F(160, { eyes: 'wide', mouth: 'open', ex: gift(-4, 0.5) }),
        F(900, { eyes: 'happy', mouth: 'grin', cheeks: true, ex: [...gift(-6, 0), 'sparkBig'] }),
      ],
    },
    {
      id: 'countSparks',
      frames: [
        ...times(3, (i) => [F(260, { eyes: ['left', 'up', 'right'][i], ex: sparks(i + 1) }), F(160, { dy: 1, eyes: 'happy', ex: sparks(i + 1) })]).flat(),
        F(700, { eyes: 'happy', mouth: 'smile', ex: sparks(3) }),
      ],
    },
    {
      id: 'bowThanks',
      frames: [
        F(260, { dy: 1, sy: 0.94, eyes: 'happy' }),
        F(900, { dy: 2, sy: 0.88, eyes: 'blink' }),
        F(200, { dy: 1, eyes: 'happy' }),
        F(700, { eyes: 'happy', mouth: 'smile', cheeks: true, ex: ['spark'] }),
      ],
    },
    {
      id: 'sip',
      frames: [
        F(300, { eyes: 'right', ex: ['glass'] }),
        F(200, { eyes: 'open', ex: ['armR', 'glassUp'] }),
        ...held(3, 260, (i) => ({ eyes: 'blink', mouth: 'none', dy: i === 1 ? 0.3 : 0, ex: ['armR', 'glassUp'] })),
        F(600, { eyes: 'happy', mouth: 'smile', ex: ['glass'] }),
      ],
    },
    {
      id: 'grow',
      frames: [
        F(300, { eyes: 'up', ex: ['spark'] }),
        F(200, { sy: 0.92 }),
        F(260, { sy: 1.08, eyes: 'wide', ex: ['sparkBig'] }),
        F(200, { sy: 1.04, eyes: 'wide', ex: ['sparkBig'] }),
        F(900, { eyes: 'happy', mouth: 'grin', cheeks: true, ex: ['spark'] }),
      ],
    },
    // The wardrobe's turn and the card's photo, asked for by the person.
    {
      id: 'twirl',
      frames: [1, 0.5, 0.1, -0.5, -1, -0.5, 0.1, 0.5, 1].map((sx, i) =>
        F(i === 8 ? 600 : 80, { sx, eyes: i === 8 ? 'wink' : 'open', mouth: 'smile', ex: i > 2 && i < 7 ? ['armsOut'] : [] }),
      ),
    },
    {
      id: 'pose',
      frames: [
        F(200, { eyes: 'blink' }),
        F(700, { eyes: 'wink', mouth: 'grin', ex: ['armR'] }),
        F(700, { dx: -0.5, eyes: 'happy', mouth: 'smile', ex: ['armsOut'] }),
        F(700, { eyes: 'open', mouth: 'grin', cheeks: true, ex: ['armL', 'armR'] }),
      ],
    },
  ].map((c) => ({ kind: 'react', ...c }));

  // Idle fidgets for a hot day, snow and music.
  const FIDGETS = [
    {
      id: 'icecream',
      when: { hot: true },
      frames: [
        F(400, { eyes: 'right', ex: ['cone', 'scoop'] }),
        ...held(4, 220, (i) => ({ eyes: 'happy', mouth: i % 2 ? 'open' : 'smile', ex: ['cone', 'scoop', ...(i % 2 ? ['tongue'] : [])] })),
        F(600, { eyes: 'happy', mouth: 'smile', ex: ['cone', ['scoop', 0, 0.5, 1]] }),
      ],
    },
    {
      id: 'snowman',
      when: { weather: ['snow'] },
      frames: [
        F(400, { eyes: 'right', ex: ['scarf', 'snowBase'] }),
        F(400, { eyes: 'right', ex: ['scarf', 'snowBase', 'snowHead'] }),
        F(300, { eyes: 'right', mouth: 'open', ex: ['scarf', 'snowBase', 'snowHead', 'snowFace'] }),
        F(1000, { eyes: 'happy', mouth: 'grin', ex: ['scarf', 'snowBase', 'snowHead', 'snowFace', 'snowNose'] }),
      ],
    },
    {
      id: 'shuffle',
      when: { music: true },
      frames: held(8, 200, (i) => ({ dx: [0, -1, 0, 1][i % 4], dy: i % 2 ? 0 : 0.5, eyes: 'happy', mouth: 'whistle', ex: [['note', i % 4 < 2 ? 12 : -3, -2 - (i % 3), 1]] })),
    },
    {
      id: 'sway',
      when: { music: true },
      frames: held(6, 420, (i) => ({ dx: i % 2 ? 0.5 : -0.5, sx: i % 2 ? 0.98 : 1, eyes: 'happy', mouth: 'smile', ex: [['note', 12 - (i % 3), -3 - (i % 2), 0.8]] })),
    },
  ].map((c) => ({ kind: 'fidget', ...c }));

  return { PARTS, CLIPS: Object.freeze([...LIFE, ...REACT, ...FIDGETS]) };
});

// ---- bit-director.js
;((root, factory) => {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const bit = node ? require('./bit.js') : root.Xenon.bit;
  const mod = factory(bit);
  if (node) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitDirector = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, (bit) => {
  'use strict';

  /* What Bit does next, and when: the part that keeps Bit from getting old.
   * Pure (time and randomness come in), so the same rules run in the app, the
   * Bit Lab and the tests. bit.js draws; this file only chooses.
   *
   * - fits() / pickFidget() / seasonOf(): which idle surprise fits the moment,
   *   never one of the last few played.
   * - createDirector(): one personal Bit's rhythm. Its temperament sets how
   *   often it moves and how much it reacts; its quirk is played twice as often.
   *   Reactions to what happens on the PC have a priority, a cooldown each and
   *   a cap per hour, and wait while a game runs or at night unless they matter. */

  const IDLE_GAP_MS = [7000, 16000];
  const HOUR_MS = 3600000;
  const QUIRK_BOOST = 2;
  // Kept out of a personal Bit's idle pool: hearts read as filler (no-AI-slop rule).
  const NEVER_IDLE = new Set(['love']);

  // gap: idle pause factor; cap: reactions per hour factor; big: prefers the bigger clip
  const TEMPERAMENTS = Object.freeze({
    lively: { gap: 0.7, cap: 1.3, big: true },
    calm: { gap: 1.4, cap: 0.7, big: false },
    curious: { gap: 0.9, cap: 1, big: false },
    sleepy: { gap: 1.5, cap: 0.8, big: false },
    dramatic: { gap: 1, cap: 1.2, big: true },
    shy: { gap: 1.3, cap: 0.6, big: false },
  });

  /* A reaction: candidate clips (the first one this engine knows, or with
   * `big` the last), priority 1-3 (3 gets through a game and the night), the
   * pause before the same event may react again, and whether it may play
   * while a game runs. Clip ids from bit-clips.js and its packs. */
  const EVENTS = Object.freeze({
    hello: { clips: ['hello'], priority: 3, cooldown: 0 },
    welcomeBack: { clips: ['welcomeBack'], priority: 2, cooldown: 30 * 60000 },
    hatch: { clips: ['hatch'], priority: 3, cooldown: 0 },
    cpuHot: { clips: ['fanSelf', 'overheat'], priority: 2, cooldown: 20 * 60000 },
    gpuHot: { clips: ['fanSelf', 'overheat'], priority: 2, cooldown: 20 * 60000 },
    veryHot: { clips: ['panic', 'overheat'], priority: 2, cooldown: 20 * 60000 },
    fpsDrop: { clips: ['wobble', 'oops'], priority: 1, cooldown: 15 * 60000, gaming: true },
    gameStart: { clips: ['padReady', 'nod'], priority: 1, cooldown: 30 * 60000, gaming: true },
    gameEnd: { clips: ['cheer', 'celebrate'], priority: 2, cooldown: 10 * 60000 },
    trackChange: { clips: ['airGuitar', 'headbang'], priority: 1, cooldown: 10 * 60000 },
    claudeWorking: { clips: ['laptop', 'think'], priority: 1, cooldown: 20 * 60000 },
    claudeDone: { clips: ['allDone', 'nod'], priority: 2, cooldown: 5 * 60000 },
    notification: { clips: ['sign', 'surprised'], priority: 1, cooldown: 5 * 60000 },
    calendarSoon: { clips: ['watch', 'surprised'], priority: 2, cooldown: 10 * 60000 },
    download: { clips: ['catchBox', 'nod'], priority: 1, cooldown: 15 * 60000 },
    update: { clips: ['wrench', 'nod'], priority: 1, cooldown: 60 * 60000 },
    storeDrop: { clips: ['unbox', 'celebrate'], priority: 2, cooldown: 60 * 60000 },
    sparks: { clips: ['countSparks', 'thanks'], priority: 1, cooldown: 10 * 60000 },
    supporter: { clips: ['bowThanks', 'thanks'], priority: 3, cooldown: 0 },
    drink: { clips: ['sip', 'coffee'], priority: 2, cooldown: 20 * 60000 },
    birthday: { clips: ['party'], priority: 3, cooldown: 12 * HOUR_MS },
    stage: { clips: ['grow', 'celebrate'], priority: 3, cooldown: 0 },
    // Asked for by the person: the wardrobe's turn, the card's photo.
    wardrobe: { clips: ['twirl'], priority: 3, cooldown: 0 },
    photo: { clips: ['pose'], priority: 3, cooldown: 0 },
  });

  const DEFAULT_CAP = 6;
  const NIGHT = [0, 6];

  function inHours(range, hour) {
    const [a, b] = range;
    return a <= b ? hour >= a && hour <= b : hour >= a || hour <= b;
  }

  function oneOf(want, have) {
    return Array.isArray(want) ? want.includes(have) : want === have;
  }

  /** Does a clip's `when` fit the moment? Clips without `when` always fit. */
  function fits(c, ctx = {}) {
    const w = c.when;
    if (!w) return true;
    if (w.hours && !(Number.isFinite(ctx.hour) && inHours(w.hours, ctx.hour))) return false;
    if (w.weather && !oneOf(w.weather, ctx.weather)) return false;
    if (w.season && !oneOf(w.season, ctx.season)) return false;
    for (const flag of ['hot', 'cold', 'music', 'gaming', 'cpuHot']) {
      if (w[flag] && !ctx[flag]) return false;
    }
    return true;
  }

  /**
   * Pick the next idle fidget: weighted, fitted to the moment, never one of
   * the last few played, rare ones only now and then.
   * @param {object} ctx        { hour, weather, season, hot, cold, music, gaming, cpuHot }
   * @param {string[]} recent   ids played lately, newest last
   * @param {() => number} rand Math.random or a seeded stand-in
   * @param {{quirk?: string, personal?: boolean}} [favour] a personal Bit's quirk plays
   *   twice as often, and it never idles with hearts
   */
  function pickFidget(ctx = {}, recent = [], rand = Math.random, favour = {}) {
    const memory = new Set(recent.slice(-6));
    const usable = (c) => c.kind === 'fidget' && fits(c, ctx) && !(favour.personal && NEVER_IDLE.has(c.id));
    let pool = bit.clips.filter((c) => usable(c) && !memory.has(c.id));
    if (!pool.length) pool = bit.clips.filter((c) => usable(c) && c.id !== recent[recent.length - 1]);
    if (!pool.length) return null;
    const weight = (c) => (c.weight || 1) * (c.id === favour.quirk ? QUIRK_BOOST : 1);
    const total = pool.reduce((s, c) => s + weight(c), 0);
    let roll = rand() * total;
    for (const c of pool) {
      roll -= weight(c);
      if (roll < 0) return c.id;
    }
    return pool[pool.length - 1].id;
  }

  /** The season a date falls in, for seasonal fidgets; null most days. */
  function seasonOf(date, birthday) {
    const m = date.getMonth() + 1;
    const d = date.getDate();
    if (birthday && birthday.month === m && birthday.day === d) return 'birthday';
    if ((m === 12 && d === 31) || (m === 1 && d === 1)) return 'newyear';
    if (m === 10 && d >= 24) return 'halloween';
    if (m === 12 && d >= 20 && d <= 26) return 'christmas';
    return null;
  }

  function clipFor(event, big) {
    const known = event.clips.filter((id) => bit.clip(id));
    if (!known.length) return null;
    return big ? known[known.length - 1] : known[0];
  }

  /**
   * One personal Bit's rhythm.
   * @param {{temperament?: string, quirk?: string}} [genes]  from bitGenome.decode()
   * @param {{cap?: number, rand?: () => number}} [opts] cap: reactions per hour (setting)
   */
  function createDirector(genes = {}, opts = {}) {
    const mood = TEMPERAMENTS[genes.temperament] || TEMPERAMENTS.calm;
    const rand = opts.rand || Math.random;
    const capOf = (perHour) => Math.max(0, Math.round((perHour == null ? DEFAULT_CAP : perHour) * mood.cap));
    let cap = capOf(opts.cap);
    const played = []; // times of reactions in the last hour
    const last = new Map(); // event -> time it last reacted

    function idleGapMs(ctx = {}) {
      const [lo, hi] = IDLE_GAP_MS;
      const night = Number.isFinite(ctx.hour) && inHours(NIGHT, ctx.hour) ? 2 : 1;
      return Math.round((lo + rand() * (hi - lo)) * mood.gap * night);
    }

    function nextFidget(ctx, recent) {
      return pickFidget(ctx, recent, rand, { quirk: genes.quirk, personal: true });
    }

    /**
     * The clip to play for something that happened, or null when Bit lets it
     * pass (unknown event, cooling down, over the hourly cap, a game or the
     * night and the event is not important enough).
     */
    function react(name, ctx = {}, now = Date.now()) {
      const ev = EVENTS[name];
      if (!ev) return null;
      const id = clipFor(ev, mood.big);
      if (!id) return null;
      if (ev.priority < 3) {
        if (ctx.gaming && !ev.gaming) return null;
        if (Number.isFinite(ctx.hour) && inHours(NIGHT, ctx.hour) && ev.priority < 2) return null;
        if (last.has(name) && now - last.get(name) < ev.cooldown) return null;
        while (played.length && now - played[0] >= HOUR_MS) played.shift();
        if (played.length >= cap) return null;
        played.push(now);
      }
      last.set(name, now);
      return id;
    }

    return {
      idleGapMs, nextFidget, react, temperament: genes.temperament || 'calm',
      get cap() { return cap; },
      /** The person's choice of how often (reactions an hour, before the temperament). */
      setCap(perHour) { if (Number.isFinite(perHour)) cap = capOf(perHour); },
    };
  }

  return { TEMPERAMENTS, EVENTS, IDLE_GAP_MS, fits, pickFidget, seasonOf, createDirector };
});

// ---- bit-player.js
;(function (root, factory) {
  'use strict';
  const node = typeof module === 'object' && module.exports;
  const bit = node ? require('./bit.js') : root.Xenon.bit;
  // Read when Bit idles, not now: a page may load bit-director.js after this file.
  const director = node ? () => require('./bit-director.js') : () => root.Xenon.bitDirector || null;
  const mod = factory(bit, director);
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.bitPlayer = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (bit, director) {
  'use strict';

  /* Bit, alive: mounts an SVG in a host element and plays clips on it.
   * A mood loops; while Bit is idle a fidget plays now and then (fitted to
   * the moment, never the same twice in a row); react() plays one clip and
   * goes back to the mood. Stops itself while the page or the element is
   * hidden, or while the host holds it (hold(true): the app's own freeze
   * states); reduced motion shows still poses and no fidgets. */

  const NS = 'http://www.w3.org/2000/svg';
  const CALM_FACTOR = 2.5;

  // Without a personal Bit's director: the classic rhythm, any fidget that fits.
  // A page without bit-director.js gets no idle fidgets, never an error.
  function classic() {
    const d = director();
    if (!d) return null;
    return {
      idleGapMs() {
        const [lo, hi] = d.IDLE_GAP_MS;
        return lo + Math.random() * (hi - lo);
      },
      nextFidget: (ctx, recent) => d.pickFidget(ctx, recent),
    };
  }
  let uid = 0;

  function el(name, attrs) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  }

  // The frame a still pose shows: the longest one, usually the clearest face.
  // The page's own Bit (BitApp.setOwn): every player without a look of its own draws it.
  let pageLook = null;
  const live = new Set();

  /** Every Bit in the page wears this look from now on (null: the classic Bit). */
  function useLook(look) {
    pageLook = look || null;
    for (const p of live) p.refresh();
  }

  function stillIndex(c) {
    let best = 0;
    c.frames.forEach((f, i) => {
      if (f.ms > c.frames[best].ms) best = i;
    });
    return best;
  }

  /**
   * @param {Element} host
   * @param {object} [opts]
   * @param {string} [opts.mood]          starting mood clip id (default 'idle')
   * @param {string} [opts.label]         accessible name; omit for decorative
   * @param {boolean} [opts.fidgets]      idle surprises (default true)
   * @param {boolean} [opts.calm]         fewer surprises
   * @param {boolean} [opts.reducedMotion] force still poses (default: OS setting)
   * @param {() => object} [opts.context] the moment, for bitDirector.fits()
   * @param {(id: string) => void} [opts.onClip] told when a clip starts
   * @param {() => object|null} [opts.look] a look of its own (bit-look.js), read on every
   *   frame: a try-on preview. Without it the player draws the page's look (useLook)
   * @param {object|(() => object|null)} [opts.director] a personal Bit's rhythm
   *   (bitDirector.createDirector), or a getter for it; default the classic one
   */
  function mount(host, opts = {}) {
    const id = `bit-floor-${++uid}`;
    const { STAGE } = bit;
    const svg = el('svg', { viewBox: `${STAGE.x} ${STAGE.y} ${STAGE.w} ${STAGE.h}`, class: 'xbit' });
    if (opts.label) {
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', opts.label);
    } else {
      svg.setAttribute('aria-hidden', 'true');
    }
    const defs = el('defs', {});
    const cp = el('clipPath', { id });
    cp.appendChild(el('rect', { x: STAGE.x, y: STAGE.y, width: STAGE.w, height: 11 - STAGE.y }));
    defs.appendChild(cp);
    const stage = el('g', {});
    svg.append(defs, stage);
    host.appendChild(svg);

    const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    const state = {
      mood: bit.clip(opts.mood) ? opts.mood : 'idle',
      current: null,
      index: 0,
      timer: 0,
      idleTimer: 0,
      recent: [],
      pokes: 0,
      tint: null,
      running: false,
      pageVisible: typeof document === 'undefined' || !document.hidden,
      inView: true,
      held: false,
      resolveReact: null,
      drawn: 0,
    };

    const reduced = () => (opts.reducedMotion != null ? !!opts.reducedMotion : !!(motionQuery && motionQuery.matches));
    const rhythm = () => (typeof opts.director === 'function' ? opts.director() : opts.director) || classic();

    function draw(c, i) {
      const { layers } = bit.renderFrame(c, i, { tint: state.tint, look: opts.look ? opts.look() : pageLook });
      state.drawn = i;
      const groups = layers.map((l) => {
        const g = el('g', {});
        const tr = bit.transformAttr(l.transform);
        if (tr) g.setAttribute('transform', tr);
        for (const p of bit.paths(l.rects)) {
          const path = el('path', { d: p.d, fill: p.fill });
          if (p.o < 1) path.setAttribute('opacity', p.o);
          g.appendChild(path);
        }
        if (!l.clipFloor) return g;
        const wrap = el('g', { 'clip-path': `url(#${id})` });
        wrap.appendChild(g);
        return wrap;
      });
      stage.replaceChildren(...groups);
    }

    function clearTimers() {
      clearTimeout(state.timer);
      clearTimeout(state.idleTimer);
      state.timer = 0;
      state.idleTimer = 0;
    }

    function finishReact() {
      const done = state.resolveReact;
      state.resolveReact = null;
      if (done) done();
    }

    function scheduleIdle() {
      clearTimeout(state.idleTimer);
      const pace = rhythm();
      if (!pace || !state.running || reduced() || opts.fidgets === false || state.mood !== 'idle') return;
      const ctx = opts.context ? opts.context() : {};
      const gap = pace.idleGapMs(ctx) * (opts.calm ? CALM_FACTOR : 1);
      state.idleTimer = setTimeout(() => {
        if (state.current && state.current.kind !== 'mood') return;
        const next = pace.nextFidget(opts.context ? opts.context() : {}, state.recent);
        if (next) play(next);
      }, gap);
    }

    function step() {
      const c = state.current;
      draw(c, state.index);
      if (reduced()) return;
      state.timer = setTimeout(() => {
        state.index += 1;
        if (state.index < c.frames.length) return step();
        if (c.kind === 'mood') {
          state.index = 0;
          return step();
        }
        finishReact();
        start(bit.clip(state.mood));
      }, c.frames[state.index].ms);
    }

    function start(c) {
      clearTimeout(state.timer);
      state.current = c;
      state.index = 0;
      if (opts.onClip) opts.onClip(c.id);
      if (reduced()) {
        draw(c, stillIndex(c));
        if (c.kind !== 'mood') state.timer = setTimeout(() => (finishReact(), start(bit.clip(state.mood))), bit.duration(c));
        return;
      }
      if (!state.running) return draw(c, 0);
      step();
      if (c.kind === 'mood') scheduleIdle();
    }

    function play(clipId) {
      const c = bit.clip(clipId);
      if (!c) return Promise.resolve();
      if (c.kind === 'mood') {
        setMood(clipId);
        return Promise.resolve();
      }
      finishReact();
      state.recent.push(c.id);
      if (state.recent.length > 12) state.recent.shift();
      return new Promise((resolve) => {
        state.resolveReact = resolve;
        start(c);
      });
    }

    function setMood(mood, tint) {
      if (!bit.clip(mood)) return;
      state.tint = tint || null;
      const same = state.mood === mood;
      state.mood = mood;
      if (same && state.current && state.current.kind === 'mood') return;
      finishReact();
      start(bit.clip(mood));
    }

    function poke() {
      const order = bit.POKES;
      return play(order[state.pokes++ % order.length]);
    }

    function updateRunning() {
      const should = state.pageVisible && state.inView && !state.held;
      if (should === state.running) return;
      state.running = should;
      if (!should) {
        clearTimers();
        return;
      }
      start(state.current && state.current.kind !== 'mood' ? state.current : bit.clip(state.mood));
    }

    const onVisibility = () => {
      state.pageVisible = !document.hidden;
      updateRunning();
    };
    const onMotion = () => start(state.current || bit.clip(state.mood));
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    if (motionQuery && motionQuery.addEventListener) motionQuery.addEventListener('change', onMotion);
    const io =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            state.inView = entries.some((e) => e.isIntersecting);
            updateRunning();
          })
        : null;
    if (io) io.observe(svg);

    state.running = state.pageVisible && state.inView;
    start(bit.clip(state.mood));

    const api = {
      element: svg,
      setMood,
      play,
      poke,
      hold(held) {
        state.held = !!held;
        updateRunning();
      },
      get mood() {
        return state.mood;
      },
      get clip() {
        return state.current ? state.current.id : null;
      },
      /** Draws the frame on screen again: after the look changed. */
      refresh() {
        if (state.current) draw(state.current, state.drawn || 0);
      },
      destroy() {
        clearTimers();
        finishReact();
        state.running = false;
        if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
        if (motionQuery && motionQuery.removeEventListener) motionQuery.removeEventListener('change', onMotion);
        if (io) io.disconnect();
        svg.remove();
        live.delete(api);
      },
    };
    live.add(api);
    return api;
  }

  return { mount, stillIndex, useLook, look: () => pageLook };
});

// ---- kit-api.js
'use strict';
// The end of the Bit kit (server/bit/kit.js puts the engine before it): what a widget
// calls to draw the person's own Bit from the SDK `bit` stream. Never loaded by the
// dashboard. A widget copies the kit into its package (the frame runs no outside script):
//
//   const bit = XenonBit.mount(document.getElementById('bit'), { label: 'Bit' });
//   // on every `data` message of the `bit` stream, and on `theme`:
//   bit.set(m.data, { light: theme.appearance === 'light' });
//
// Not hatched yet: the egg. A move played on the dashboard (data.played) plays here too.
// `classic: true` draws the classic Bit with its own rhythm, as the app does where the person
// chose the classic Bit (data.everywhere === false).
(() => {
  const X = globalThis.Xenon;
  const BACKGROUND = { dark: '#15191c', light: '#f4f6f5' };

  function mount(host, opts = {}) {
    let look = null;
    let director = null;
    let seen = 0;
    let key = '';
    const player = X.bitPlayer.mount(host, {
      label: opts.label, mood: 'egg', look: () => look, director: () => director,
    });

    function set(data, { light = false, classic = false } = {}) {
      if (data?.ok !== true) return;
      if (data.hatched !== true || !data.genes) {
        look = null;
        key = '';
        player.setMood('egg');
        return;
      }
      const next = JSON.stringify([data.genes, data.worn, light, classic === true]);
      if (next !== key) {
        key = next;
        look = classic === true ? null
          : X.bitLook.lookOf(data.genes, { worn: X.bitWardrobe.outfit(data.worn || []), background: light ? BACKGROUND.light : BACKGROUND.dark });
        director = X.bitDirector.createDirector(data.genes);
        if (player.mood === 'egg') player.setMood('idle');
        player.refresh();
      }
      const p = data.played;
      if (p && p.at > seen) {
        // The first answer only says where things stand: a move from before is not replayed.
        if (seen) player.play(p.clip);
        seen = p.at;
      } else if (!seen) seen = 1;
    }

    return { set, play: (clip) => player.play(clip), destroy: () => player.destroy() };
  }

  globalThis.XenonBit = { mount, clips: () => X.bit.clips.map((c) => c.id) };
})();
