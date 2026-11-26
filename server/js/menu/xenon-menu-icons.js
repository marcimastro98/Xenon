'use strict';

// The Xenon menu's icons (js/menu/xenon-menu.js): one 24×24 stroke path per name the
// server's rows use (server/menu/xenon-menu.js `icon`), drawn with createElementNS.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XenonMenuIcons = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const PATHS = Object.freeze({
    bolt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8z',
    drop: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
    fan: 'M12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM12 10.5C12 6 13 3 16 3s4 3 0 6l-2.6 2M13.5 12c4.5 0 7.5 1 7.5 4s-3 4-6 0l-2-2.6M12 13.5c0 4.5-1 7.5-4 7.5s-4-3 0-6l2.6-2M10.5 12C6 12 3 11 3 8s3-4 6 0l2 2.6',
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
    phone: 'M8.5 2h7A2.5 2.5 0 0 1 18 4.5v15a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 6 19.5v-15A2.5 2.5 0 0 1 8.5 2zM10.5 18.5h3',
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
    lines: 'M4 6.5h16M4 12h16M4 17.5h10',
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
    // The pages of Settings (js/menu/xenon-pages.js), drawn as they were in its rail.
    sliders: 'M4 7h10M18 7h2M4 12h4M12 12h8M4 17h13M20 17h.01M14 7a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M8 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M16.5 17a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
    paint: 'M11 6.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0M4 11.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0M14.5 14a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0M7 18a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0',
    island: 'M8 7h8a5 5 0 0 1 5 5v0a5 5 0 0 1 -5 5h-8a5 5 0 0 1 -5 -5v0a5 5 0 0 1 5 -5zM8 12h3M15 12h1',
    picture: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2zM7 9.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0M4 18l5-4 4 3 3-2 4 3',
    monitor: 'M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2zM8 21h8M12 17v4',
    timer: 'M10 2h4M12 14l3-3M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
    mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
    bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z',
    pulse: 'M3 12h4l3-8 4 16 3-8h4',
    cloud: 'M6.5 18a4.5 4.5 0 0 1 .4-9 5.5 5.5 0 0 1 10.5 1.4A3.8 3.8 0 0 1 17 18Z',
    chart: 'M3 3v18h18M7 14l3-3 3 3 5-6M17 8h4v4',
    slides: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2zM7 10a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0M4 17l4.5-4 3.5 2.5 3-2.5L20 17',
    code: 'M8 9l-3 3 3 3M16 9l3 3-3 3M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z',
    bulb: 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1h6c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2Z',
    home: 'M3 11l9-8 9 8M5 10v10h14V10',
    cctv: 'M2 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2ZM16 9l4.6-2.6a1 1 0 0 1 1.5.9v9.4a1 1 0 0 1-1.5.9L16 15M6.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0',
    radio: 'M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0M7.5 7.5a6 6 0 0 0 0 9M16.5 7.5a6 6 0 0 1 0 9M4.5 4.5a10 10 0 0 0 0 15M19.5 4.5a10 10 0 0 1 0 15',
    globe: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0M3 12h18M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18',
    cast: 'M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-9a2 2 0 0 1 2 -2zM8 21h8M12 17v4M14 8l3 2.5-3 2.5',
    remote: 'M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2zM8 21h8M12 17v4M9 10a3 3 0 1 0 6 0a3 3 0 1 0 -6 0M12 7v0M12 13v0',
    speed: 'M5 19a9 9 0 1 1 14 0M12 13l4-4M10.8 13a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0 -2.4 0',
    puzzle: 'M14 7h4a1 1 0 0 1 1 1v3.5a1.5 1.5 0 0 0 0 3V18a1 1 0 0 1-1 1h-3.5a1.5 1.5 0 0 1-3 0H8a1 1 0 0 1-1-1v-3.5a1.5 1.5 0 0 1 0-3V8a1 1 0 0 1 1-1h3.5a1.5 1.5 0 0 1 3 0Z',
    info: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0M12 11v5M12 8h.01',
    calendar: 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2zM16 2v4M8 2v4M3 10h18',
  });
  // Two marks are drawn filled, not stroked: a stroke would turn them into outlines.
  const FILLS = Object.freeze({
    spotify: 'M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.42 1.56-.299.421-1.02.599-1.559.3z',
    heart: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z',
  });
  const NS = 'http://www.w3.org/2000/svg';

  // Bit and the Scintilla are never stroke icons: they come from the same engines
  // as the dashboard and the site (js/ai/bit-app.js, shared/src/bit-spark.js). The markup
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
    const d = PATHS[name] || FILLS[name];
    if (!d) return null;
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', FILLS[name] ? 'xm-ic xm-fill' : 'xm-ic');
    const path = doc.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
    return svg;
  }

  return { PATHS, make };
});
