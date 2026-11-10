'use strict';

// Small moving pictures in the Xenon menu that show what a word means: where a widget
// can sit, what a page is, where the webcam goes. No words in them, so they need no
// translation, and no files: spans moved by components/XenonMenu/XenonMenuGuide.css.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XenonMenuGuide = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Painted in this order, so a later part sits above an earlier one. A part inside
  // another moves with it, the way an attached widget moves with its app.
  const SCENES = Object.freeze({
    desktop: ['widget', 'win'],
    overlay: ['win', 'widget', 'key'],
    anchor: [{ part: 'win', inside: ['widget'] }],
    pages: ['one', 'two', 'three', 'dot-a', 'dot-b'],
    webcam: ['clip', 'face'],
  });

  // ctx: { el, button, say, rowShell, tt }
  function create(ctx) {
    const { el, button, say, rowShell, tt } = ctx;
    let open = null;    // the person's choice; until then the server's default holds

    function part(spec) {
      const name = typeof spec === 'string' ? spec : spec.part;
      const box = el('span', 'xm-demo-' + name);
      if (spec.inside) box.append(...spec.inside.map(part));
      return box;
    }

    function demo(name) {
      const box = el('span', 'xm-demo xm-demo--' + name);
      box.setAttribute('aria-hidden', 'true');
      box.append(...(SCENES[name] || []).map(part));
      return box;
    }

    function card(c) {
      const box = el('div', 'xm-guide-card');
      box.append(demo(c.demo), el('span', 'xm-label', say(c.label)), el('span', 'xm-sub', say(c.sub)));
      return box;
    }

    function draw(r) {
      const shown = open === null ? r.open === true : open;
      const li = rowShell(r, shown ? 'xm-row--wrap' : '');
      const toggle = button('ui-btn ui-btn--secondary xm-act', tt(shown ? 'xmenu_guide_hide' : 'xmenu_guide_show'));
      toggle.setAttribute('aria-expanded', String(shown));
      toggle.dataset.keep = r.id;
      toggle.addEventListener('click', () => { open = !shown; ctx.redraw(); });
      li.appendChild(toggle);
      if (!shown) return li;
      const cards = el('div', 'xm-guide');
      cards.append(...(r.cards || []).map(card));
      li.appendChild(cards);
      return li;
    }

    return { draw, demo };
  }

  return { create, SCENES };
});
