// The look a line gives its face (pump-faces.js LOOK): its colours, what is behind it, how big
// its numbers are, whether a warm reading changes colour, and a line of the person's own.
// The face draws as always; this sets its colours (--pf-c1..4) and classes, and puts the
// background under it and the words over it. Joins window.PumpFaceKit as the part "look".
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;
  const Faces = window.PumpFaces;
  const TOKENS = ['--pf-c1', '--pf-c2', '--pf-c3', '--pf-c4'];
  const HEX = /^#[0-9a-f]{6}$/i;

  function paint(layer, list) {
    TOKENS.forEach((t, i) => {
      if (list && HEX.test(list[i] || '')) layer.style.setProperty(t, list[i]);
      else layer.style.removeProperty(t);
    });
  }

  // A picture behind the face, the face page's own (face-picture.js), dimmed by the CSS.
  function backdrop(layer, bg) {
    if (!Faces.isPicture(bg)) return null;
    const make = Kit.get('part', 'layer');
    const pic = make ? make(bg, 'cover') : null;
    if (!pic) return null;
    pic.node.classList.add('pf-bg-pic');
    layer.prepend(pic.node);
    return pic;
  }

  // show: the face as normalized (pump-faces.js). Returns stop(), and fromPicture(list), which
  // the colours read off the face (face-colors.js) reach while the look says 'picture'.
  function apply(layer, show) {
    const look = { ...Faces.LOOK, ...Faces.lookOf(show) };
    Kit.useUnits(look.units);
    paint(layer, Faces.colorsOf(look.colors, Kit.prefs().accent));
    layer.classList.toggle('pf-big', look.size === 'big');
    layer.classList.toggle('pf-nowarn', look.warn === false);
    layer.classList.toggle('pf-bg-glow', look.bg === 'glow');
    const pic = show.face === 'picture' ? null : backdrop(layer, look.bg);
    if (pic) layer.classList.add('pf-has-bg');
    if (look.text) layer.append(Kit.el('div', 'pf-own-text', look.text));
    return {
      fromPicture(list) {
        if (look.colors !== 'picture' || !Array.isArray(list) || !list.length) return;
        const first = list[0];
        paint(layer, [first, list[1] || first, list[2] || list[1] || first, list[1] || first]);
      },
      stop() { if (pic) { pic.stop(); pic.node.remove(); } },
    };
  }

  Kit.add('part', 'look', apply);
})();
