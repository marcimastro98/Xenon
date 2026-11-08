'use strict';

// One widget's screen in the Xenon menu: the map of the screens with it picked out, or
// on an app that app's window with corners to press, and "When do you see it?" beside the
// picture. That is all it shows at first; every other choice waits under one row.
// The screen around it comes from js/xenon-menu-widgets.js; every row still draws through
// the menu's own DRAW map, so a choice works the same here and in the search results.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XenonMenuWidgetView = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const CORNERS = Object.freeze([['top-left', 'c-tl'], ['top-right', 'c-tr'], ['bottom-left', 'c-bl'], ['bottom-right', 'c-br']]);
  // What the picture already says, so these rows are not drawn again beside it.
  const ON_PICTURE = new Set(['h-where', 'corner', 'screen']);
  // The window of an app is drawn at this size, so a widget's pixels show to scale.
  const APP_W = 1280;
  const APP_H = 800;
  const GLIDE = Object.freeze({ duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' });

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const partOf = (r, name) => (r.tune || []).find((x) => x.id === `${r.id}:${name}`);

  // Where the widget sits on the window of its app, in percent of it.
  function spot(at) {
    const w = clamp((at.width / APP_W) * 100 || 0, 14, 60);
    const h = clamp((at.height / APP_H) * 100 || 0, 14, 60);
    return { x: at.corner.endsWith('left') ? 3 : 100 - w - 3, y: at.corner.startsWith('top') ? 17 : 100 - h - 6, w, h, o: 1 };
  }

  // The frames that carry the widget from where it was. In percent of itself, so nothing
  // is measured and only the compositor works.
  function glideFrames(from, to) {
    if (!from || ['x', 'y', 'w', 'h'].every((n) => from[n] === to[n])) return null;
    const x = ((from.x - to.x) / to.w) * 100;
    const y = ((from.y - to.y) / to.h) * 100;
    const transform = `translate(${x}%, ${y}%) scale(${from.w / to.w}, ${from.h / to.h})`;
    return [{ transformOrigin: '0 0', transform }, { transformOrigin: '0 0', transform: 'none' }];
  }

  // Everything else on the widget's screen, in the order the server gives it.
  const choiceParts = (r) => (r.tune || []).filter((x) => !ON_PICTURE.has(x.id.slice(r.id.length + 1)));
  const moreParts = (r) => choiceParts(r).filter((x) => x !== partOf(r, 'place'));

  // ctx: { el, button, say, tt, perform, redraw, DRAW, Place, thumb, icon, removed, map }
  function create(ctx) {
    const { el, button, say, tt, perform, redraw, DRAW, Place, thumb, icon, removed, map } = ctx;
    let last = { id: '', at: null };
    const opened = new Map();   // widget id -> "More options" as the person left it

    function shapes(cls, n) {
      const box = el('span', cls);
      for (let i = 0; i < n; i += 1) box.appendChild(el('i'));
      return box;
    }

    function appWindow(at) {
      const bar = el('span', 'xm-appbar');
      const pic = at.icon && Place ? Place.picture(el, at.icon) : null;
      if (pic) bar.appendChild(pic);
      bar.appendChild(el('span', 'xm-appname', at.app));
      const marks = el('span', 'xm-appmarks');
      marks.append(...['minimize', 'maximize', 'close'].map((n) => icon(n) || ''));
      bar.appendChild(marks);
      const body = el('span', 'xm-appbody');
      body.append(shapes('xm-appside', 4), shapes('xm-appgrid', 6));
      const win = el('span', 'xm-appwin');
      win.append(bar, body);
      return win;
    }

    function cornerButton(row, name, cls) {
      const o = (row.options || []).find((x) => x.value === name);
      const pressed = row.value === name;
      const b = button(`xm-corner ${cls}`);
      b.setAttribute('aria-label', say(o.label));
      b.setAttribute('aria-pressed', String(pressed));
      b.dataset.keep = `${row.id}:${name}`;
      b.addEventListener('click', () => { if (!pressed) perform(row, o.act); });
      return b;
    }

    function glide(node, id, to) {
      const frames = last.id === id ? glideFrames(last.at, to) : null;
      last = { id, at: to };
      const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (frames && !calm) node.animate(frames, GLIDE);
    }

    function stage(r) {
      const { at } = r;
      const where = spot(at);
      const box = el('div', `xm-stage xm-stage--${at.surface}`);
      const set = (name, value) => box.style.setProperty(name, String(value));
      set('--xm-ratio', APP_W / APP_H);
      for (const n of ['x', 'y', 'w', 'h']) set(`--xm-${n}`, `${where[n]}%`);
      set('--xm-o', where.o);
      const bare = partOf(r, 'bare');
      const widget = el('span', `xm-stage-widget${bare && bare.on ? ' xm-stage-widget--bare' : ''}`);
      widget.appendChild(thumb(r));
      box.append(appWindow(at), widget);
      const corner = partOf(r, 'corner');
      if (corner) box.append(...CORNERS.map(([name, cls]) => cornerButton(corner, name, cls)));
      glide(widget, r.id, where);
      return box;
    }

    // Only the strip on an app needs words here: the place row already says the rest.
    const underStrip = (r) => r.at.surface === 'anchor' && String(r.at.corner).startsWith('top');

    function picture(r, screens, rows) {
      const col = el('div', 'xm-detail-pic');
      if (!r.at.corner) {
        col.append(el('p', 'xm-tap', tt('see_drag_hint')), map.draw(screens, rows, r.id));
        return col;
      }
      col.appendChild(el('p', 'xm-tap', tt('xmenu_tap_corner')));
      col.appendChild(stage(r));
      if (underStrip(r)) col.appendChild(el('p', 'xm-cap', tt('xmenu_anchor_top_caption')));
      return col;
    }

    const drawn = (x) => (DRAW[x.kind] || DRAW.choice)(x);

    function question(r) {
      const box = el('div', 'xm-tune');
      const place = partOf(r, 'place');
      if (place) box.appendChild(drawn(place));
      return box;
    }

    function moreChoices(r) {
      const box = el('div', 'xm-tune xm-moreparts');
      box.append(...moreParts(r).map(drawn));
      const gone = button('ui-btn ui-btn--secondary xm-act xm-remove', tt('xmenu_remove_widget'));
      gone.dataset.keep = `${r.id}:remove`;
      gone.addEventListener('click', () => perform(r, r.act, removed));
      box.appendChild(gone);
      return box;
    }

    // Open by itself only when the answer is in there: a widget of "other situations".
    function more(r) {
      const open = opened.has(r.id) ? opened.get(r.id) : r.group === 'other';
      const b = button('xm-moreopen');
      b.dataset.keep = `${r.id}:more`;
      b.setAttribute('aria-expanded', String(open));
      b.append(el('span', '', tt('xmenu_more_options')), icon('chevron') || '');
      b.addEventListener('click', () => { opened.set(r.id, !open); redraw(); });
      const box = el('div', 'xm-more');
      box.appendChild(b);
      if (open) box.appendChild(moreChoices(r));
      return box;
    }

    function detail(r, screens, rows) {
      const grid = el('div', 'xm-detail');
      grid.append(picture(r, screens, rows), question(r));
      const box = el('div', 'xm-detailbox');
      box.append(grid, more(r));
      return box;
    }

    return { detail };
  }

  return { create, spot, partOf, glideFrames, choiceParts, moreParts };
});
