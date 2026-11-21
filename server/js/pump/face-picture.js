// The Picture face (pump-face.html): the person's own pictures, GIFs and videos
// (uploaded to Xenon, served from /uploads/) and the moving pictures drawn here
// (face-art.js), one after another with a crossfade. Joins window.PumpFaceKit.
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;
  const VIDEO = /\.(mp4|webm|m4v|mov)$/i;
  const FPS = 30;
  // The canvas never holds more pixels than the biggest pump screen shows.
  const MAX_SIDE = 720;

  // A drawn picture: its own canvas and loop, at most FPS frames a second,
  // stopped while the page is hidden and for good on stop().
  function artLayer(name) {
    const make = Kit.get('art', name);
    const canvas = Kit.el('canvas', 'pf-art');
    const ctx = canvas.getContext('2d');
    const side = Math.min(MAX_SIDE, Math.round(Math.max(window.innerWidth, window.innerHeight) * Math.min(2, window.devicePixelRatio || 1)));
    canvas.width = side;
    canvas.height = side;
    const art = make ? make(ctx, side, side) : null;
    let raf = 0;
    let last = 0;
    const loop = (ms) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || ms - last < 1000 / FPS - 2) return;
      last = ms;
      art.frame(ms / 1000);
    };
    if (art) raf = requestAnimationFrame(loop);
    return { node: canvas, stop() { cancelAnimationFrame(raf); raf = 0; } };
  }

  function fileLayer(url, fit) {
    const safe = Kit.safeImage(url);
    if (VIDEO.test(safe)) {
      const v = Kit.el('video', `pf-pic pf-fit-${fit}`);
      v.muted = true;
      v.loop = true;
      v.autoplay = true;
      v.playsInline = true;
      v.src = safe;
      v.play().catch(() => { /* a muted video may still be refused: its first frame stays */ });
      return { node: v, stop() { v.pause(); v.removeAttribute('src'); v.load(); } };
    }
    const img = Kit.el('img', `pf-pic pf-fit-${fit}`);
    img.alt = '';
    img.decoding = 'async';
    if (safe) img.src = safe;
    return { node: img, stop() { img.removeAttribute('src'); } };
  }

  function layerFor(item, fit) {
    return item.startsWith('art:') ? artLayer(item.slice(4)) : fileLayer(item, fit);
  }

  Kit.add('face', 'picture', (root, opts) => {
    root.classList.add('pf-face-picture');
    const items = opts.items.length ? opts.items : ['art:aurora'];
    let index = 0;
    let shown = null;
    let leaving = null;
    let since = Date.now();

    function show(i) {
      const next = layerFor(items[i], opts.fit);
      next.node.classList.add('pf-layer');
      root.append(next.node);
      if (leaving) leaving.stop();
      leaving = shown;
      if (leaving) {
        leaving.node.classList.add('pf-layer-out');
        const gone = leaving;
        setTimeout(() => { gone.stop(); gone.node.remove(); if (leaving === gone) leaving = null; }, 700);
      }
      shown = next;
      since = Date.now();
    }

    show(0);
    return {
      update() { /* pictures need no reading */ },
      tick() {
        if (items.length < 2 || Date.now() - since < opts.every * 1000) return;
        index = (index + 1) % items.length;
        show(index);
      },
      stop() {
        for (const l of [shown, leaving]) if (l) { l.stop(); l.node.remove(); }
        shown = null;
        leaving = null;
      },
    };
  });
})();
