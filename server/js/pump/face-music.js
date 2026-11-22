// The Music face (pump-face.html): the song playing now, as its cover with the
// time around the bezel, as a turning record, or as the cover with rings that
// breathe while it plays. Joins window.PumpFaceKit; no global.
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;

  // Where the song is now, in seconds: the event's position plus the time since it came.
  function positionNow(m, at) {
    const base = Number.isFinite(m.positionMs) ? m.positionMs / 1000 : Number(m.position) || 0;
    return m.playbackStatus === 'Playing' ? base + (Date.now() - at) / 1000 : base;
  }

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
    const backdrop = cover('pf-music-backdrop');
    const box = Kit.svg('svg', { viewBox: '0 0 100 100', class: 'pf-rings', 'aria-hidden': 'true' });
    const time = opts.style === 'cover' ? Kit.gauge(box, { r: 47.5, width: 2.4, start: 0, sweep: 359.9, slot: 1 }) : null;
    const disc = Kit.el('div', 'pf-music-disc');
    const art = cover('pf-music-cover', true);
    disc.append(art.node);
    if (opts.style === 'pulse') for (let i = 0; i < 3; i += 1) disc.prepend(Kit.el('span', `pf-pulse pf-pulse-${i + 1}`));
    const text = Kit.el('div', 'pf-music-text');
    const title = Kit.el('div', 'pf-music-title');
    const artist = Kit.el('div', 'pf-music-artist');
    text.append(title, artist);
    root.append(backdrop.node, box, disc, text);

    let media = null;
    let at = 0;
    function paintTime() {
      if (!time) return;
      const length = media && Number(media.duration);
      time.set(length > 0 ? positionNow(media, at) / length : 0, 'ok');
    }

    return {
      update(data) {
        // An app heard with only its name (a browser tab's sound) is no song to show.
        const m = data.media?.fallback === true && data.media.title === data.media.app ? null : data.media;
        const on = !!m?.title;
        if (m !== media) { media = m; at = Date.now(); }
        const playing = on && m.playbackStatus === 'Playing';
        root.classList.toggle('pf-playing', playing);
        root.classList.toggle('pf-idle', !on);
        title.textContent = on ? m.title : Kit.t('pump_face_nothing_playing', 'Nothing playing');
        artist.textContent = on ? (m.artist || '') : '';
        const pic = on ? m.thumbnail : '';
        art.set(pic);
        backdrop.set(opts.style === 'cover' ? pic : '');
        paintTime();
      },
      tick: paintTime,
    };
  });
})();
