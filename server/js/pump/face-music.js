// The Music face (pump-face.html): the song playing now, as its cover inside the drop that
// breathes while it plays (Xenon's own style, face-drop.js), as a turning record, or as the cover
// with rings that breathe while it plays. Joins window.PumpFaceKit; no global.
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;

  // A song with no cover, or no song: the line's colours and four bars that dance while
  // something plays and rest when nothing does, never an empty grey hole.
  function standIn() {
    const art = Kit.el('div', 'pf-cover-art');
    for (let i = 0; i < 4; i += 1) art.append(Kit.el('span', `pf-eq pf-eq-${i + 1}`));
    return art;
  }

  function cover(cls, drawn) {
    const wrap = Kit.el('div', cls);
    const img = Kit.el('img', 'pf-cover-img');
    img.alt = '';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    wrap.append(img);
    if (drawn) wrap.append(standIn());
    // null, not '': the first song with no cover must still mark the frame empty.
    let shown = null;
    return {
      node: wrap,
      set(url) {
        const safe = Kit.safeImage(url);
        if (safe === shown) return;
        shown = safe;
        wrap.classList.toggle('pf-cover-empty', !safe);
        if (safe) img.src = safe; else img.removeAttribute('src');
      },
    };
  }

  Kit.add('face', 'music', (root, opts) => {
    root.classList.add('pf-face-music', `pf-style-${opts.style}`);
    const art = cover('pf-music-cover', true);
    if (opts.style === 'cover') {
      Kit.get('part', 'drop')(root, 'pf-drop-music').front.append(art.node);
    } else {
      const disc = Kit.el('div', 'pf-music-disc');
      disc.append(art.node);
      if (opts.style === 'pulse') for (let i = 0; i < 3; i += 1) disc.prepend(Kit.el('span', `pf-pulse pf-pulse-${i + 1}`));
      root.append(disc);
    }
    const text = Kit.el('div', 'pf-music-text');
    const title = Kit.el('div', 'pf-music-title');
    const artist = Kit.el('div', 'pf-music-artist');
    text.append(title, artist);
    root.append(text);

    return {
      update(data) {
        // An app heard with only its name (a browser tab's sound) is no song to show.
        const m = data.media?.fallback === true && data.media.title === data.media.app ? null : data.media;
        const on = !!m?.title;
        const playing = on && m.playbackStatus === 'Playing';
        root.classList.toggle('pf-playing', playing);
        root.classList.toggle('pf-idle', !on);
        title.textContent = on ? m.title : Kit.t('pump_face_nothing_playing', 'Nothing playing');
        artist.textContent = on ? (m.artist || '') : '';
        const pic = on ? m.thumbnail : '';
        art.set(pic);
      },
    };
  });
})();
