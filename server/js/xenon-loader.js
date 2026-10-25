// The Xenon X as the app's one loading mark (components/XenonLoader/XenonLoader.css).
//
// XenonLoader.create() returns a fresh element for any wait: a tile loading, a
// modal working, an update installing. The boot splash in index.html writes the
// same three paths by hand, because it paints before any other script runs.
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // The logo's geometry (images/logo/logo-mark.png, 256 px grid).
  const VIEW_BOX = '32 50 194 156';
  const PIECES = [
    ['xloader-chev', 'M39 54H93L156 128L93 202H39L99 128Z'],
    ['xloader-up', 'M162 54H219L161.3 116.7L134 84.5Z'],
    ['xloader-down', 'M162 202H219L161.3 139.3L134 171.5Z'],
  ];
  const SIZES = ['sm', 'md', 'lg'];

  function mark() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'xloader-mark');
    svg.setAttribute('viewBox', VIEW_BOX);
    svg.setAttribute('aria-hidden', 'true');
    for (const [cls, d] of PIECES) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('class', cls);
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  // size: 'sm' | 'md' | 'lg'; bar: the running bar under the mark, for waits
  // that fill a tile or a screen.
  function create({ size = 'md', bar = false } = {}) {
    const el = document.createElement('span');
    el.className = 'xloader';
    if (SIZES.includes(size) && size !== 'md') el.classList.add('xloader--' + size);
    el.setAttribute('aria-hidden', 'true');
    el.appendChild(mark());
    if (bar) {
      const run = document.createElement('span');
      run.className = 'xloader-bar';
      el.appendChild(run);
    }
    return el;
  }

  window.XenonLoader = { create, VIEW_BOX, PIECES };
})();
