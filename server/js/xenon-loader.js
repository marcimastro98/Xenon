// Bit thinking as the app's one loading mark (components/XenonLoader/XenonLoader.css).
//
// XenonLoader.create() returns a fresh element for any wait: a tile loading, a
// modal working, an update installing. The picture animates itself (an SVG made
// from Bit's own clip), so the element needs no teardown: remove it and it is gone.
(() => {
  'use strict';

  const SIZES = ['sm', 'md', 'lg'];

  // size: 'sm' beside a line of text, 'md' in a tile, 'lg' for a whole screen.
  function create({ size = 'md' } = {}) {
    const el = document.createElement('span');
    el.className = 'xloader';
    if (SIZES.includes(size) && size !== 'md') el.classList.add('xloader--' + size);
    el.setAttribute('aria-hidden', 'true');
    const pic = document.createElement('span');
    pic.className = 'xloader-bit';
    el.appendChild(pic);
    return el;
  }

  window.XenonLoader = { create, SIZES };
})();
