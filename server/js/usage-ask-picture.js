'use strict';

// The picture of the first question: the person's real screens as they stand on the desk,
// each with what it will show. The screens are laid out live, because they have to fit any
// monitor, a 32:9 Edge and a screen turned on its side included; what they show are real
// pictures of Xenon (tools/first-run-shots), one per shape. The words are in js/usage-ask.js
// and the rules in js/usage-ask-plan.js. A monitor's name comes from the monitor itself, so
// it only ever goes in as text.
(function () {
  const PICTURES = 'assets/first-run/';
  const STARTERS = Object.freeze(['weather', 'media', 'system']);   // as in js/usage-ask-plan.js
  const EDGE_RATIO = 2.4;

  function el(tag, className, ...kids) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    n.append(...kids);
    return n;
  }

  // Under the splash nothing decodes a picture, so it would pop in as the splash lifts.
  function pic(name, className = '') {
    const img = el('img', `ua-pic ${className}`.trim());
    img.decoding = 'sync';
    img.addEventListener('load', () => img.classList.add('is-in'), { once: true });
    img.src = `${PICTURES}${name}.webp`;
    img.alt = '';
    img.draggable = false;
    return img;
  }

  function shapeOf(ratio) {
    if (ratio < 1) return 'tall';
    return ratio >= EDGE_RATIO ? 'edge' : 'wide';
  }

  // The first widgets, top right of the desktop, as the plan places them.
  function widgets() {
    const layer = el('span', 'ua-layer ua-widgets');
    STARTERS.forEach((name, i) => {
      const w = pic(`widget-${name}`, 'ua-w');
      w.style.setProperty('--i', String(i));
      layer.append(w);
    });
    return layer;
  }

  // The desktop with a window on it only suits a wide screen: cropped, the window reads as a mistake.
  function face(shape) {
    const n = el('span', 'ua-face',
      el('span', 'ua-layer ua-desk', pic(shape === 'wide' ? 'desk' : 'desk-plain')),
      widgets(),
      el('span', 'ua-layer ua-windowed', el('span', 'ua-window', el('span', 'ua-window-bar'), pic(`dash-${shape}`))),
      el('span', 'ua-layer ua-full', pic(`dash-${shape}`)));
    n.setAttribute('aria-hidden', 'true');
    return n;
  }

  // ctx: { onTap(id), nameOf(display, list), tapLabel(name) }
  function create(ctx) {
    const map = el('div', 'ua-map');
    const phone = el('div', 'ua-phone-shape', pic('dash-phone'));
    phone.setAttribute('aria-hidden', 'true');
    const node = el('div', 'ua-stage', map, phone);
    let screens = [];

    function screen(display, box, list) {
      const b = el('button', 'ua-screen');
      const name = display.id ? ctx.nameOf(display, list) : '';
      b.type = 'button';
      b.dataset.id = display.id || '';
      b.setAttribute('aria-label', ctx.tapLabel(name));
      ['left', 'top', 'width', 'height'].forEach((side) => { b.style[side] = box[side] + '%'; });
      const chin = el('span', 'ua-chin');
      chin.textContent = name;
      const ratio = box.w / box.h;
      b.style.setProperty('--shape', String(ratio));
      b.append(face(shapeOf(ratio)), chin);
      b.addEventListener('click', () => ctx.onTap(b.dataset.id));
      return b;
    }

    function draw(list) {
      const shape = window.XenonMenuMap.layout(list);
      map.style.setProperty('--ratio', String(shape.ratio));
      screens = shape.screens.map((box, i) => screen(list[i] || {}, box, list));
      map.replaceChildren(...screens);
    }

    // Classes and attributes only: the nodes stay, so the change fades.
    function paint({ shows, dash, phoneOn, movable }) {
      screens.forEach((b, i) => {
        const here = !!b.dataset.id && b.dataset.id === dash && shows[i] === 'dash';
        b.dataset.show = shows[i] || 'plain';
        b.disabled = !movable || !b.dataset.id;
        b.classList.toggle('is-dash', here);
        b.setAttribute('aria-pressed', here ? 'true' : 'false');
      });
      phone.classList.toggle('is-on', phoneOn === true);
    }

    return { node, draw, paint };
  }

  window.UsageAskPicture = { create };
})();
