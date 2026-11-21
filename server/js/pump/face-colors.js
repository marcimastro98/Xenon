// The colours of what a pump's face shows, for the ring of lights around the pump
// (pump-screen/ring.js): while the screen's lights follow it, the biggest picture, video or
// drawing in the face is shrunk to a few pixels and its strongest colours picked the way an
// album cover's are (media/album-theme.js), so a GIF or a song's cover colours the ring. A
// face with no picture gives its own colours. Said to Xenon when they change, and again every
// half minute: Xenon drops colours no page says any more (pump-screen/ring.js).
// Joins window.PumpFaceKit as the part "colors"; no global.
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;
  const SAMPLE = 32;
  const WHITE = '#ffffff';
  const OWN_TOKENS = ['--pf-c1', '--pf-c2'];
  const HEX = /^#[0-9a-f]{6}$/i;
  const SAY_AGAIN_MS = 30000;

  function ready(n) {
    if (n.tagName === 'IMG') return n.complete && n.naturalWidth > 0;
    if (n.tagName === 'VIDEO') return n.readyState >= 2;
    return n.width > 0 && n.height > 0;
  }

  // The picture that fills most of the face now (a slideshow's incoming one wins once it shows).
  function biggest(layer) {
    let best = null;
    let area = 0;
    for (const n of layer.querySelectorAll('img, video, canvas')) {
      if (!ready(n)) continue;
      const r = n.getBoundingClientRect();
      const a = r.width * r.height * Number(getComputedStyle(n).opacity || 1);
      if (a > area) { area = a; best = n; }
    }
    return best;
  }

  // A pick from album-theme.js as the ring's colours; a grey picture lights it white.
  const asList = (pick) => (pick ? [pick.led, ...pick.ledPalette.filter((c) => c !== pick.led)].slice(0, 3) : [WHITE]);

  function ownColours(layer) {
    const style = getComputedStyle(layer);
    const list = OWN_TOKENS.map((t) => style.getPropertyValue(t).trim().toLowerCase()).filter((c) => HEX.test(c));
    return list.length ? list : [WHITE];
  }

  // post(colors): sends them to Xenon, resolves true once it took them.
  function create(post) {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let said = '';
    let saidAt = 0;
    let busy = false;

    function fromPixels(node) {
      try {
        ctx.clearRect(0, 0, SAMPLE, SAMPLE);
        ctx.drawImage(node, 0, 0, SAMPLE, SAMPLE);
        return asList(window.extractAlbumAccent.pick(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data));
      } catch { return null; }   // a cover from another site cannot be read from the page
    }

    async function coloursOf(layer) {
      const node = biggest(layer);
      if (!node) return ownColours(layer);
      const read = fromPixels(node);
      if (read) return read;
      // Read again through a copy that asks the other site's leave (as the dashboard's covers do).
      const src = node.tagName === 'IMG' ? node.currentSrc || node.src : '';
      return src ? asList(await window.extractAlbumAccent(src)) : ownColours(layer);
    }

    return {
      async tick(layer) {
        if (busy || !layer || typeof window.extractAlbumAccent !== 'function') return;
        busy = true;
        try {
          const colours = await coloursOf(layer);
          const key = colours.join(',');
          const due = key !== said || Date.now() - saidAt >= SAY_AGAIN_MS;
          if (due && await post(colours)) { said = key; saidAt = Date.now(); }
        } finally { busy = false; }
      },
      // Xenon forgot them (it restarted) or the screen's lights stopped following it.
      reset() { said = ''; },
    };
  }

  Kit.add('part', 'colors', create);
})();
