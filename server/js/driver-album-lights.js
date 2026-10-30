'use strict';

// The lights follow the album cover in "widgets only" too. On a dashboard
// media.js reads the cover's colours (album-theme.js) and sends them to the
// lighting bridge; with no dashboard nobody did, so the "music album" effect
// stayed on its last colour. The hidden driver page (js/shell-driver.js) does
// the same from the `media` stream: the server has no image decoder and the
// page already holds a canvas for free. The bridge ignores the colour when the
// effect is off, like the dashboard's push.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DriverAlbumLights = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // The server drops the ~80 KB thumbnail from a broadcast while the track is
  // unchanged (server.js mediaForBroadcast), so the cover is kept per track,
  // with the same key.
  const trackKey = (d) => `${(d && d.title) || ''}|${(d && (d.artist || d.album)) || ''}`;

  function coverFor(prev, d) {
    if (!d || !d.active) return { key: '', thumb: '' };
    const key = trackKey(d);
    if (typeof d.thumbnail === 'string' && d.thumbnail) return { key, thumb: d.thumbnail };
    return { key, thumb: key === prev.key ? prev.thumb : '' };
  }

  // What media.js pushAlbumToLighting sends for the same pair.
  function bodyFor(pair) {
    const color = (pair && pair.led) || null;
    if (!color) return { clear: true };
    const palette = Array.isArray(pair.ledPalette) && pair.ledPalette.length >= 2 ? pair.ledPalette : null;
    return { color, palette };
  }

  // extract(thumb) -> Promise<pair|null> (album-theme.js); post(body) sends it.
  function create({ extract, post }) {
    let cover = { key: '', thumb: '' };
    let sent = null;

    function send(body) {
      const key = JSON.stringify(body);
      if (key === sent) return;
      sent = key;
      post(body);
    }

    function onMedia(d) {
      const next = coverFor(cover, d);
      if (next.thumb === cover.thumb) { cover = next; return; }
      cover = next;
      if (!next.thumb) { send({ clear: true }); return; }
      const thumb = next.thumb;
      Promise.resolve(extract(thumb)).catch(() => null).then((pair) => {
        if (thumb === cover.thumb) send(bodyFor(pair)); // a newer cover wins
      });
    }

    return { onMedia };
  }

  return Object.freeze({ coverFor, bodyFor, create });
});
