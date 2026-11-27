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
   * `travel`: its prop stays behind, and on a ride a step is a glide (bit.js). */

  const P = (fill, cells, opts) => Object.freeze({ fill, cells, attach: false, back: true, ...opts });
  const PARTS = Object.freeze({
    // Dust kicked up behind a step, on the floor line.
    dust: P('#a6b1ad', [[0, 0], [1, -1], [2, 0]], { opacity: 0.55 }),
  });

  const F = (ms, props) => Object.freeze({ ms, ...props });
  const SIGN = ['signPost', 'signBoard', 'signLines', 'armR'];
  const LAP = ['lid', 'lidMark', 'keys']; // its laptop (bit-clips-life.js parts)
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
    // At its own laptop while Claude Code or Codex work (bit-companion/moments.js): it types, reads, thinks.
    // calm: it plays on the slow pace too, at about three frames a second (bit-player.js).
    {
      id: 'code',
      calm: true,
      frames: [
        F(900, { eyes: 'down', ex: LAP }),
        ...[0, 1, 2, 3, 4, 5].map((i) => F(240, { eyes: 'down', dy: i % 2 ? 0.3 : 0, ex: i % 3 ? ['lid', 'keys'] : LAP })),
        F(110, { eyes: 'blink', ex: LAP }),
        F(1100, { eyes: 'down', ex: LAP }),
        F(800, { eyes: 'up', mouth: 'flat', ex: LAP }),
        ...[0, 1, 2, 3].map((i) => F(240, { eyes: 'down', dy: i % 2 ? 0.3 : 0, ex: i % 2 ? ['lid', 'keys'] : LAP })),
        F(600, { eyes: 'down', mouth: 'smile', ex: LAP }),
      ],
    },
  ].map((c) => ({ kind: 'mood', loop: true, tint: 'idle', ...c }));

  // Turning round: Bit narrows to a sliver, its place mirrors it, and it opens up the other way.
  const TURNS = [
    { id: 'turn', travel: true, frames: [F(80, { sx: 0.55, eyes: 'open' }), F(80, { sx: 0.15, eyes: 'open' })] },
  ].map((c) => ({ kind: 'react', ...c }));

  return { PARTS, CLIPS: Object.freeze([...MOVES, ...TURNS]) };
});
