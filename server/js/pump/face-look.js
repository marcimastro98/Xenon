// The look a line gives its face (pump-faces.js LOOK): its colours, what is behind it, how big
// its numbers are, whether a warm reading changes colour, and a line of the person's own.
// The face draws as always; this sets its colours (--pf-c1..4, too hot, warm, the colour behind)
// and classes, and puts the background under it and the words over it. Joins window.PumpFaceKit as the part "look".
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

  // Too hot, warm and the colour behind: Xenon's for a set of its own, the person's for theirs.
  // On a light colour the words turn dark, so they still read.
  function paintEdges(layer, colors) {
    const edges = Faces.edgesOf(colors);
    layer.style.setProperty('--pf-hot', edges.warn);
    layer.style.setProperty('--pf-warm', edges.warm);
    layer.style.setProperty('--pf-bg', edges.background);
    layer.classList.toggle('pf-light', Faces.isLight(edges.background));
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

  // Whether the colours read off the face (face-colors.js) are this line's: 'picture', or 'live'
  // on a song or a picture.
  const readsPicture = (show) => {
    const set = Faces.colorSetOf(show);
    return set === 'picture' || (set === 'live' && ['music', 'picture'].includes(show.face));
  };

  // show: the face as normalized (pump-faces.js). Returns stop(), fromPicture(list), which the
  // colours read off the face (face-colors.js) reach while the line takes them, and live(data),
  // once a second, which moves 'live' colours with what the face shows (face-live.js).
  function apply(layer, show) {
    const look = { ...Faces.LOOK, ...Faces.lookOf(show) };
    const follow = look.colors === 'live' ? Kit.get('part', 'live')?.(show) : null;
    let said = '';
    Kit.useUnits(look.units);
    paint(layer, Faces.colorsOf(look.colors, Kit.prefs().accent));
    paintEdges(layer, look.colors);
    layer.classList.toggle('pf-big', look.size === 'big');
    layer.classList.toggle('pf-nowarn', look.warn === false);
    layer.classList.toggle('pf-bg-glow', look.bg === 'glow');
    const pic = show.face === 'picture' ? null : backdrop(layer, look.bg);
    if (pic) layer.classList.add('pf-has-bg');
    if (look.text) layer.append(Kit.el('div', 'pf-own-text', look.text));
    layer.classList.toggle('pf-live', look.colors === 'live');
    return {
      fromPicture(list) {
        if (!readsPicture(show) || !Array.isArray(list) || !list.length) return;
        const first = list[0];
        paint(layer, [first, list[1] || first, list[2] || list[1] || first, list[1] || first]);
      },
      live(data) {
        const list = follow ? follow(data) : null;
        const key = list ? list.join() : '';
        if (!list || key === said) return;
        said = key;
        paint(layer, list);
      },
      stop() { if (pic) { pic.stop(); pic.node.remove(); } },
    };
  }

  Kit.add('part', 'look', apply);
  Kit.add('part', 'reads-picture', readsPicture);
})();
