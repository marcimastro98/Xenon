// When the Store may draw an entry on its own paper and ink: the colours as numbers, their light,
// and whether the two can be read together.
'use strict';

(() => {
  const HERO_CONTRAST = 4.5;   // the pack's own paper and ink, when they can be read

  // The pack's own colours, when the catalog's pair can be read. They come from the
  // server's hex check and only ever reach a CSS variable.
  function hexRgb(c) {
    let h = String(c || '').replace('#', '');
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    if (!/^[0-9a-f]{6}/i.test(h)) return null;
    const n = parseInt(h.slice(0, 6), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function luminance(rgb) {
    const [r, g, b] = rgb.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function readablePair(preview) {
    const paper = hexRgb(preview && preview.bg), ink = hexRgb(preview && preview.text);
    if (!paper || !ink) return false;
    const [hi, lo] = [luminance(paper), luminance(ink)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05) >= HERO_CONTRAST;
  }

  window.CommunityGalleryPaper = { hexRgb, readablePair };
})();
