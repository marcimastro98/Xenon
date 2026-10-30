'use strict';

// The Xenon menu's icons (js/xenon-menu.js): one 24×24 stroke path per name the
// server's rows use (server/xenon-menu.js `icon`). Data only, drawn with
// createElementNS so nothing goes through innerHTML.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XenonMenuIcons = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const PATHS = Object.freeze({
    bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8z',
    widgets: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    gauge: 'M12 14l4-4M4 18a8 8 0 1 1 16 0',
    camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    area: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
    record: 'M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    replay: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4M12 8v4l3 2',
    gallery: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5',
    keyboard: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8',
    palette: 'M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3.5 3H16a2 2 0 0 0-1.4 3.4A1.6 1.6 0 0 1 12 21zM7.5 11h.01M10 7.5h.01M14 7.5h.01',
    screens: 'M3 5h18v11H3zM8 20h8M12 16v4',
    bit: 'M6 5h12v12H6zM9 9h1M14 9h1M9 13h6M10 17v3M14 17v3',
    close: 'M6 6l12 12M18 6L6 18',
    plus: 'M12 5v14M5 12h14',
  });
  const NS = 'http://www.w3.org/2000/svg';

  // An <svg> for `name`, or null when there is none (the row shows no icon).
  function make(doc, name) {
    const d = PATHS[name];
    if (!d || !doc) return null;
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
