'use strict';

// The Xenon menu's icons (js/xenon-menu.js): one 24×24 stroke path per name the
// server's rows use (server/xenon-menu.js `icon`), drawn with createElementNS.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XenonMenuIcons = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const PATHS = Object.freeze({
    bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8z',
    widgets: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    pages: 'M9 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM4 7v11a2 2 0 0 0 2 2h11',
    gauge: 'M12 14l4-4M4 18a8 8 0 1 1 16 0',
    camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    area: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
    record: 'M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    replay: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4M12 8v4l3 2',
    gallery: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5',
    keyboard: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8',
    palette: 'M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3.5 3H16a2 2 0 0 0-1.4 3.4A1.6 1.6 0 0 1 12 21zM7.5 11h.01M10 7.5h.01M14 7.5h.01',
    screens: 'M3 5h18v11H3zM8 20h8M12 16v4',
    search: 'M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM16 16l5 5',
    close: 'M6 6l12 12M18 6L6 18',
    back: 'M15 5l-7 7 7 7',
    chevron: 'M9 5l7 7-7 7',
    minimize: 'M5 12h14',
    maximize: 'M5 5h14v14H5z',
    settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
    plus: 'M12 5v14M5 12h14',
    store: 'M4 9l1.5-5h13L20 9M4 9h16v11H4zM9 13a3 3 0 0 0 6 0',
    marker: 'M6 21V4M6 4h11l-2.5 4L17 12H6',
    timelapse: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    steps: 'M4 6h3v3H4zM4 15h3v3H4zM11 7.5h9M11 16.5h9',
    text: 'M5 6V4h14v2M12 4v16M9 20h6',
    colour: 'M14 6l4 4M5 19l1-4 8.5-8.5 3 3L9 18l-4 1zM13 4l7 7',
    ruler: 'M3 16 16 3l5 5L8 21zM7 12l2 2M10 9l3 3M13 6l2 2',
    draw: 'M4 20l1-4L16 5l3 3L8 19l-4 1zM14 7l3 3',
    pin: 'M12 17v5M8 3h8l-1 7 3 3v2H6v-2l3-3z',
    cover: 'M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6zM4 4l16 16',
    bug: 'M8 9h8v7a4 4 0 0 1-8 0zM9 9a3 3 0 0 1 6 0M4 13h4M16 13h4M5 7l3 3M19 7l-3 3M5 19l3-2M19 19l-3-2',
    why: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1.9-1.1 1.8M12 17h.01',
    benchmark: 'M5 20v-6M12 20V5M19 20v-10',
    mixer: 'M6 4v16M12 4v16M18 4v16M4 15h4M10 8h4M16 13h4',
    edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
    companion: 'M7 8h10a4 4 0 0 1 4 4v3a3 3 0 0 1-5.4 1.8L14 15h-4l-1.6 1.8A3 3 0 0 1 3 15v-3a4 4 0 0 1 4-4zM7 11v3M5.5 12.5h3M15 12h.01M18 13h.01',
    dnd: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
    whatsnew: 'M4 11h16v9H4zM3 7h18v4H3zM12 7v13M12 7C10.5 3 6 3 6 5.5 6 7 9 7 12 7zM12 7c1.5-4 6-4 6-1.5C18 7 15 7 12 7z',
  });
  const NS = 'http://www.w3.org/2000/svg';

  // Bit and the Scintilla are never stroke icons: they come from the same engines
  // as the dashboard and the site (js/bit-app.js, shared/src/bit-spark.js). The markup
  // is built from their own constants, so nothing untrusted reaches the template.
  // The brand Bit is green (site, Settings, app icon); the engine's idle mood is yellow.
  const BRAND_GREEN = '110,231,135';
  const MARKS = Object.freeze({
    bit: () => (window.BitApp ? window.BitApp.icon('idle', BRAND_GREEN) : ''),
    spark: () => (window.Xenon && window.Xenon.spark ? window.Xenon.spark.svg({ still: true }) : ''),
  });

  function officialMark(doc, name) {
    const markup = typeof window !== 'undefined' ? MARKS[name]() : '';
    if (!markup) return null;
    const tpl = doc.createElement('template');
    tpl.innerHTML = markup;
    const svg = tpl.content.firstElementChild;
    if (!svg) return null;
    // The floor clip shares one id per document: a hidden copy would blank this one.
    svg.querySelectorAll('defs').forEach((d) => d.remove());
    svg.querySelectorAll('[clip-path]').forEach((g) => g.removeAttribute('clip-path'));
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.classList.add('xm-ic', 'xm-mark', 'xm-mark-' + name);
    return svg;
  }

  // An <svg> for `name`, or null when there is none (the row shows no icon).
  function make(doc, name) {
    if (!doc) return null;
    if (MARKS[name]) return officialMark(doc, name);
    const d = PATHS[name];
    if (!d) return null;
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'xm-ic');
    const path = doc.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  return { PATHS, make };
});
