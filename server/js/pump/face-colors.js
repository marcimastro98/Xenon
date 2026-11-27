// The colours of what a pump's face shows, for the ring of lights around the pump
// (pump-screen/ring.js): while the screen's lights follow it, the biggest picture, video or
// drawing in the face is shrunk to a few pixels and its strongest colours picked the way an
// album cover's are (media/album-theme.js), so a GIF or a song's cover colours the ring. A
// face with no picture gives its own colours. Said to Xenon when they change, and again every
// half minute: Xenon drops colours no page says any more (pump-screen/ring.js). A ring lit up to
// the reading is told how far the line is too (its first reading, the song's time), whatever
// its colours follow.
// Joins window.PumpFaceKit as the part "colors"; no global.
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;
  const SAMPLE = 32;
  const WHITE = '#ffffff';
  const OWN_TOKENS = ['--pf-c1', '--pf-c2'];
  const HEX = /^#[0-9a-f]{6}$/i;
  const SAY_AGAIN_MS = 30000;
  // The ring's own colours need no picture read: only how far the line is.
  const RING_SAYS = ['screen', 'theme', 'own'];

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

  // How far a line is, 0..1 in hundredths, or null with nothing to measure: the first reading
  // (the frame rate in a game, as the faces default), or the song's time. With the heat, how hard
  // that reading works (face-kit.js strain: a low frame rate is hot).
  function levelOf(show, data, song, effect) {
    let v = null;
    if (show.face === 'music') {
      const m = data.media;
      const length = m?.title ? Number(m.duration) : 0;
      v = length > 0 ? Kit.songAt(m, song.at) / length : null;
    } else if (show.face === 'sensors' || show.face === 'game') {
      const name = (Array.isArray(show.readings) && show.readings[0]) || (show.face === 'game' ? 'fps' : 'cpuTemp');
      const r = Kit.reading(name, data.system);
      v = r && r.value != null ? (effect === 'heat' ? Kit.strain(r) : r.fraction) : null;
    }
    return v == null || !Number.isFinite(v) ? null : Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
  }

  // What the ring wants of this line: its colours read off the face, how far it is, both or nothing.
  // A widget drawing the line may say them itself (`asked`, its pumpRing message) and how it moves.
  function ringWants(face, settings, data, song, asked) {
    const leds = settings?.leds;
    const follow = leds?.follow;
    if (!RING_SAYS.includes(follow)) return { pixels: false, colors: null, level: null, effect: null };
    const Faces = window.PumpFaces;
    const widget = asked && Faces.drawnAs(settings.style, face.show.face) === Faces.WIDGET ? asked : null;
    const effect = Faces.ringEffect(leds, face.show, settings.style, widget?.effect);
    const lit = window.PumpRingEffects?.about(effect).needs === 'level';
    return {
      pixels: follow === 'screen' && !widget?.colors, colors: follow === 'screen' ? widget?.colors || null : null,
      level: lit ? widget?.level ?? levelOf(face.show, data, song, effect) : null, effect: widget?.effect || null,
    };
  }

  // What Xenon is told: the colours (the widget's, else read off the face), how far, how a widget moves it.
  function ringOf(want, read) {
    const colors = want.colors || (want.pixels ? read : null);
    const ring = { ...(colors ? { colors } : {}), ...(want.level != null ? { level: want.level } : {}), ...(want.effect ? { effect: want.effect } : {}) };
    return Object.keys(ring).length ? ring : null;
  }

  // post(colors, ring): the colours to the face's look (null: none read), and to Xenon what the
  // ring wants ({ colors, level }, or null); resolves true once it took them.
  function create(post) {
    // A cover from another site taints the canvas for good, so each one that fails gets a new one.
    const sampler = () => Object.assign(document.createElement('canvas'), { width: SAMPLE, height: SAMPLE }).getContext('2d', { willReadFrequently: true });
    let ctx = sampler();
    let said = '';
    let saidAt = 0;
    let busy = false;
    let asked = null;   // what the widget drawing the line asked of the ring, until the face changes
    const song = { media: null, at: 0 };   // when the song's last news came, for its time

    function fromPixels(node) {
      try {
        ctx.clearRect(0, 0, SAMPLE, SAMPLE);
        ctx.drawImage(node, 0, 0, SAMPLE, SAMPLE);
        return asList(window.extractAlbumAccent.pick(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data));
      } catch { ctx = sampler(); return null; }   // a cover from another site cannot be read from the page
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
      // Once a second with the face on show; `settings` null (the menu's picture) says nothing to the ring.
      async tick(face, settings, data) {
        face.look?.live?.(data);
        if (data.media !== song.media) { song.media = data.media; song.at = Date.now(); }
        const want = ringWants(face, settings, data, song, asked);
        const read = want.pixels || !!Kit.get('part', 'reads-picture')?.(face.show);
        if (!read && want.level == null && !want.colors && !want.effect) { said = ''; return; }
        if (busy || (read && typeof window.extractAlbumAccent !== 'function')) return;
        busy = true;
        try {
          const colours = read ? await coloursOf(face.layer) : null;
          const ring = ringOf(want, colours);
          const key = JSON.stringify([colours, ring]);
          const due = key !== said || Date.now() - saidAt >= SAY_AGAIN_MS;
          if (due && await post(colours, ring)) { said = key; saidAt = Date.now(); }
        } finally { busy = false; }
      },
      // Xenon forgot them (it restarted) or the screen's lights stopped following it.
      reset() { said = ''; },
      // A widget's ask (pump-widget-host.js checked it); null when another face comes.
      ask(a) { asked = a && typeof a === 'object' ? a : null; },
    };
  }

  Kit.add('part', 'colors', create);
})();
