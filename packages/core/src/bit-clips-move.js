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

  /* Bit on the move: the loops it plays while it walks somewhere and when it sits down there.
   * Same data shape as bit-clips.js. The body never changes, so a step is a bob and a lean;
   * the walk itself is the place moving the Bit (bit-companion/stroll.js), and a Bit going left
   * is the same clip mirrored by its place. Every loop faces right. A clip on its way somewhere is
   * `travel`: its prop stays behind, and on a ride a step is a glide (bit.js).
   * And the loops it rests in at its own desk (bit-companion/moments.js): coding while Claude Code or Codex
   * work, gaming while the person plays. */

  const P = (fill, cells, opts) => Object.freeze({ fill, cells, attach: false, back: true, ...opts });
  const PARTS = Object.freeze({
    // Dust kicked up behind a step, on the floor line.
    dust: P('#a6b1ad', [[0, 0], [1, -1], [2, 0]], { opacity: 0.55 }),
    // Its own computer, on a little desk beside it: the monitor and the desk stay put while it bobs; one cell
    // of code at a time, and a hand that types.
    pcFrame: P('#6b7686', [[10, 1, 5], [10, 6, 5], [10, 2, 1, 4], [14, 2, 1, 4]], { attach: false }),
    pcScreen: P('#14202c', [[11, 2, 3, 4]], { attach: false }),
    pcStand: P('#6b7686', [[12, 7]], { attach: false }),
    desk: P('#9a7650', [[10, 8, 5], [10, 9, 1, 2], [14, 9, 1, 2]], { attach: false }),
    handIn: P('body', [[10, 7]]),
    handOut: P('body', [[10, 7, 2, 1]]),
    codeA: P('#b4a0ff', [[0, 0]], { attach: false }),
    codeB: P('#6ee787', [[0, 0]], { attach: false }),
    codeC: P('#7dd3fc', [[0, 0]], { attach: false }),
    cursor: P('#f0f3f1', [[0, 0]], { attach: false }),
    // Bits of code that pop out of the top of the screen and float away: { } 1 0.
    bitOpen: P('#b4a0ff', [[1, 0], [0, 1], [1, 2]], { attach: false }),
    bitClose: P('#b4a0ff', [[0, 0], [1, 1], [0, 2]], { attach: false }),
    bitOne: P('#6ee787', [[0, 0], [1, 0, 1, 3]], { attach: false }),
    bitZero: P('#7dd3fc', [[0, 0, 3], [0, 2, 3], [0, 1], [2, 1]], { attach: false }),
    // The little game on its screen while the person plays: its ship, the one it shoots at, the shot.
    gameShip: P('#6ee787', [[0, 0]], { attach: false }),
    gameFoe: P('#ff5a6e', [[0, 0]], { attach: false }),
    gameShot: P('#ffe58a', [[0, 0]], { attach: false }),
    // Its pad held low, under its smile (bit-clips.js 'controller' covers the mouth).
    padLow: P('#3b4250', [[3, 9, 6, 1]], { attach: true, back: false }),
    padKeys: P('#a6b1ad', [[4, 9]], { attach: true, back: false }),
    padA: P('#ff5a6e', [[7, 9]], { attach: true, back: false }),
    padB: P('#6ee787', [[6, 9]], { attach: true, back: false }),
  });

  const F = (ms, props) => Object.freeze({ ms, ...props });
  const SIGN = ['signPost', 'signBoard', 'signLines', 'armR'];
  // At its computer: the screen fills with code one cell at a time, a cursor blinking where the next goes.
  const PC = ['pcFrame', 'pcScreen', 'pcStand', 'desk'];
  const CODE = [['codeA', 11, 2], ['codeA', 12, 2], ['codeB', 12, 3], ['codeB', 13, 3], ['codeC', 12, 4], ['codeB', 13, 4], ['codeC', 11, 5], ['codeC', 12, 5]];
  const typed = (n, blink, hand = 'handIn') => [...PC, hand, ...CODE.slice(0, n), ...(blink && n < CODE.length ? [['cursor', ...CODE[n].slice(1)]] : [])];
  // One bit of code out of the screen every third frame: it rises above the monitor and fades in four frames.
  const BITS = ['bitOpen', 'bitOne', 'bitClose', 'bitZero'];
  const FADE = [0.9, 0.7, 0.45, 0.2];
  const popped = (i) => [1, 4, 7, 10].flatMap((at, k) => {
    const age = i - at;
    return age >= 0 && age < FADE.length ? [[BITS[k], k % 2 ? 12 : 10, -2 - age, FADE[age]]] : [];
  });
  // The game: its ship along the bottom of the screen, the foe along the top, a shot between them; a hit
  // sends a star out of the screen.
  const PAD = ['padLow', 'padKeys', 'padA', 'padB'];
  const SHIP = [12, 11, 11, 12, 13, 13, 12, 12];
  const FOE = [11, 12, 13, 13, 12, 12, 0, 0];
  const game = (i) => [...PC, ...PAD, ['gameShip', SHIP[i], 5],
    ...(FOE[i] ? [['gameFoe', FOE[i], 2]] : []), ...(i % 3 === 1 ? [['gameShot', SHIP[i], 4]] : i % 3 === 2 ? [['gameShot', SHIP[i - 1], 3]] : []),
    ...(i === 6 ? [['star', 10, -3, 1]] : i === 7 ? [['star', 10, -4, 0.5]] : [])];
  const step = (ms, lift, extra = {}) => [
    F(ms, { eyes: 'right', sx: 1.03, sy: 0.97, ...extra }),
    F(ms, { eyes: 'right', dy: -lift, ...extra, ex: [...(extra.ex || []), ['dust', -3, 10, 0.5]] }),
  ];

  const MOVES = [
    { id: 'walk', travel: true, frames: [...step(170, 0.5), ...step(170, 0.5, { mouth: 'smile' })] },
    { id: 'run', travel: true, frames: [...step(110, 1, { mouth: 'open' }), ...step(110, 1, { mouth: 'open', brows: 'up' })] },
    // Carrying news: the sign of bit-clips-life.js held up while it walks.
    { id: 'walkSign', travel: true, frames: [...step(190, 0.5, { ex: SIGN }), ...step(190, 0.5, { mouth: 'smile', ex: SIGN })] },
    {
      id: 'sit',
      frames: [
        F(1700, { dy: 1, sx: 1.04, sy: 0.92 }),
        F(1500, { dy: 1, sx: 1.03, sy: 0.94, eyes: 'left' }),
        F(110, { dy: 1, sx: 1.04, sy: 0.92, eyes: 'blink' }),
        F(1600, { dy: 1, sx: 1.04, sy: 0.92 }),
      ],
    },
    // At its own computer while Claude Code or Codex work (bit-companion/moments.js): it types, reads, thinks.
    // calm: it plays on the slow pace too, at about three frames a second (bit-player.js).
    {
      id: 'code',
      calm: true,
      frames: [
        ...CODE.map((_, i) => F(260, { eyes: 'right', ex: [...typed(i, i % 2 === 0, i % 2 ? 'handOut' : 'handIn'), ...popped(i)] })),
        F(900, { eyes: 'right', mouth: 'smile', ex: [...typed(CODE.length), ...popped(8)] }),
        F(110, { eyes: 'blink', ex: [...typed(CODE.length), ...popped(9)] }),
        F(800, { eyes: 'up', ex: [...typed(CODE.length), ...popped(10)] }),
        F(500, { eyes: 'right', ex: [...typed(0, true), ...popped(11)] }),
      ],
    },
    // Gaming beside the person while a game runs, pad in hand, a little game on its screen. Calm too.
    {
      id: 'gamer',
      calm: true,
      frames: [
        ...SHIP.map((_, i) => F(i >= 6 ? 420 : 260, { eyes: 'right', mouth: i >= 6 ? 'smile' : 'flat', dy: i % 2 ? 0.3 : 0, ex: game(i) })),
        F(110, { eyes: 'blink', ex: game(0) }),
        F(600, { eyes: 'wide', ex: game(0) }),
      ],
    },
  ].map((c) => ({ kind: 'mood', loop: true, tint: 'idle', ...c }));

  // Turning round: Bit narrows to a sliver, its place mirrors it, and it opens up the other way.
  const TURNS = [
    { id: 'turn', travel: true, frames: [F(80, { sx: 0.55, eyes: 'open' }), F(80, { sx: 0.15, eyes: 'open' })] },
  ].map((c) => ({ kind: 'react', ...c }));

  return { PARTS, CLIPS: Object.freeze([...MOVES, ...TURNS]) };
});
