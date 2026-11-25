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
