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
