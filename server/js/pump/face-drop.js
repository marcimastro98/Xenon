// Goccia, the shape Xenon's own style draws its faces on (pump-faces.js SCREEN_STYLES 'xenon'):
// a soft drop that breathes in the middle of the screen, in the line's first colour, warm or hot
// when a reading it carries is, and moving faster as the PC works harder. The words sit over it
// in ink that reads on its colour (PumpFaceDrop.css). Joins window.PumpFaceKit as the part "drop".
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;
  // Working its hardest, the drop moves this many times faster than at rest. The pace goes in
  // steps, so it changes seldom, and it changes the animation's rate in place: never a restart,
  // which would make the shape jump.
  const FASTEST = 3;
  const STEPS = 4;
  const RANK = Object.freeze({ none: 0, ok: 0, warm: 1, hot: 2 });

  // The hottest tone among the readings (face-kit.js reading), 'ok' when none is warm.
  function hottest(list) {
    return list.reduce((top, r) => (r && RANK[r.tone] > RANK[top] ? r.tone : top), 'ok');
  }

  // The pace for the hardest-working reading: 1 at rest up to FASTEST.
  function paceOf(list) {
    const strain = Math.max(0, ...list.map((r) => Kit.strain(r) ?? 0));
    return 1 + (Math.round(strain * STEPS) / STEPS) * (FASTEST - 1);
  }

  function setPace(node, rate) {
    if (typeof node.getAnimations !== 'function') return;
    for (const a of node.getAnimations({ subtree: true })) a.updatePlaybackRate(rate);
  }

  // root: the face's layer, which takes the tone (its colour reaches the drop and the ink alike).
  // Made before the face's own parts. cls: where this face puts its drop. Returns
  // { node, front, set(readings) }; front holds what the drop shows inside its shape (a cover).
  function create(root, cls = '') {
    const node = Kit.el('div', ['pf-drop', cls].filter(Boolean).join(' '));
    const front = Kit.el('div', 'pf-drop-front');
    node.append(Kit.el('div', 'pf-drop-back'), front);
    // Before the face's own parts and after a picture behind (face-look.js): both sit under the words.
    root.append(node);
    root.dataset.drop = 'ok';
    let rate = 1;
    return {
      node,
      front,
      set(readings) {
        const list = (Array.isArray(readings) ? readings : []).filter(Boolean);
        root.dataset.drop = hottest(list);
        const next = paceOf(list);
        if (next === rate) return;
        rate = next;
        setPace(node, rate);
      },
    };
  }

  Kit.add('part', 'drop', create);
})();
