'use strict';

// One widget's screen in the Xenon menu: the picture of the screens (or, on an app, that
// app's window with corners to press) stays in place on one side, and the choices sit in
// four named tabs beside it: when it shows, where, what it shows, how it looks. Each tab
// is short, so nothing waits under a closed row and the picture never scrolls away.
// The screen around it comes from js/xenon-menu-widgets.js; every row still draws through
// the menu's own DRAW map, so a choice works the same here and in the search results.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.XenonMenuWidgetView = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const CORNERS = Object.freeze([['top-left', 'c-tl'], ['top-right', 'c-tr'], ['bottom-left', 'c-bl'], ['bottom-right', 'c-br']]);
  const TABS = Object.freeze([['when', 'timelapse'], ['where', 'screens'], ['what', 'lines'], ['look', 'palette']]);
  // Which tab a row of the server goes in, by the part of its id after the widget's.
  // The headings of the server are left out: the tab already names its part.
  const PART_TAB = Object.freeze({
    place: 'when', when: 'when', key: 'when', keymode: 'when', keyoffer: 'when',
    screen: 'where', page: 'where', corner: 'where', leave: 'where', tabs: 'where',
    size: 'look', opacity: 'look', bare: 'look',
  });
  const HEADS = new Set(['h-where', 'h-look', 'h-what', 'h-keys']);
  // A place answer that is not one of the cards: a situation, or a mix of them.
  const MOMENTS = new Set(['other', 'custom']);
  // The window of an app is drawn at this size, so a widget's pixels show to scale.
  const APP_W = 1280;
  const APP_H = 800;
  const GLIDE = Object.freeze({ duration: 180, easing: 'cubic-bezier(.2,.7,.2,1)' });

  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const partOf = (r, name) => (r.tune || []).find((x) => x.id === `${r.id}:${name}`);
  const nameOf = (r, x) => x.id.slice(r.id.length + 1);

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

  // The rows of each tab, in the server's order. What the widget shows starts at the
  // server's "what" heading; a key for one of its functions goes with it too.
  function tabParts(r) {
    const out = { when: [], where: [], what: [], look: [] };
    let inWhat = false;
    for (const x of r.tune || []) {
      const name = nameOf(r, x);
      if (name === 'h-what') inWhat = true;
      if (HEADS.has(name)) continue;
      // A row this file does not know yet still shows, with the looks.
      const tab = inWhat || name.startsWith('fn-') ? 'what' : PART_TAB[name] || 'look';
      out[tab].push(x);
    }
    return out;
  }

  // ctx: { el, button, say, tt, perform, redraw, DRAW, Place, thumb, icon, removed, map }
  function create(ctx) {
    const { el, button, say, tt, perform, redraw, DRAW, Place, thumb, icon, removed, map } = ctx;
    let last = { id: '', at: null };
    const chosenTab = new Map();   // widget id -> the tab the person left open
    let moments = '';              // the widget whose "at certain moments" card was pressed
    let shown = '';                // the widget on screen, so another one starts closed

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
        col.append(map.draw(screens, rows, r.id), el('p', 'xm-cap', tt('see_drag_hint')));
        return col;
      }
      col.appendChild(stage(r));
      col.appendChild(el('p', 'xm-cap', tt('xmenu_tap_corner')));
      if (underStrip(r)) col.appendChild(el('p', 'xm-cap', tt('xmenu_anchor_top_caption')));
      return col;
    }

    const drawn = (x) => (DRAW[x.kind] || DRAW.choice)(x);

    // "When do you see it?" with a fifth card of the page's own: at certain moments. It
    // opens the situations under the cards; any other card closes them again.
    const momentsOpen = (r, place) => place.value !== 'anchor' && (moments === r.id || MOMENTS.has(place.value));

    function placeRow(r, place, open) {
      const choose = (o) => (here) => {
        moments = '';
        if (here) redraw();
        else perform(place, o.act);
      };
      const cards = (place.options || []).map((o) => (o.act ? { ...o, press: choose(o) } : o));
      cards.push({
        value: 'moments', label: { key: 'see_moments' }, sub: { key: 'see_moments_sub' },
        press: () => { moments = r.id; redraw(); },
      });
      return drawn({ ...place, options: cards, value: open ? 'moments' : place.value });
    }

    function whenTab(r, parts) {
      const place = partOf(r, 'place');
      const open = !!place && momentsOpen(r, place);
      return parts.flatMap((x) => {
        if (x === place) return [placeRow(r, place, open)];
        // Named after the card that opened it: "other situations" would ask which others.
        if (x.kind === 'when') return open ? [drawn({ ...x, start: true, label: { key: 'see_moments' } })] : [];
        return [drawn(x)];
      });
    }

    function lookTab(r, parts) {
      const gone = button('ui-btn ui-btn--secondary xm-act xm-remove', tt('xmenu_remove_widget'));
      gone.dataset.keep = `${r.id}:remove`;
      gone.addEventListener('click', () => perform(r, r.act, removed));
      return [...parts.map(drawn), gone];
    }

    function tabBar(r, tabs, current) {
      const bar = el('div', 'xm-wtabs');
      bar.setAttribute('role', 'tablist');
      bar.append(...tabs.map(([name, pic]) => {
        const b = button('xm-wtab');
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(name === current));
        b.dataset.keep = `${r.id}:tab-${name}`;
        b.append(icon(pic) || '', el('span', '', tt('xmenu_tab_' + name)));
        b.addEventListener('click', () => { chosenTab.set(r.id, name); redraw(); });
        return b;
      }));
      return bar;
    }

    // The tabs with something in them: "what it shows" only where the widget has options.
    function choices(r) {
      const parts = tabParts(r);
      const tabs = TABS.filter(([name]) => name === 'look' || parts[name].length);
      const want = chosenTab.get(r.id);
      const current = tabs.some(([name]) => name === want) ? want : tabs[0][0];
      const body = { when: whenTab, look: lookTab }[current] || ((_r, list) => list.map(drawn));
      const panel = el('div', 'xm-tune xm-wpanel');
      panel.setAttribute('role', 'tabpanel');
      panel.append(...body(r, parts[current]));
      const col = el('div', 'xm-detail-choices');
      col.append(tabBar(r, tabs, current), panel);
      return col;
    }

    function detail(r, screens, rows) {
      if (shown !== r.id) { moments = ''; shown = r.id; }
      const grid = el('div', 'xm-detail');
      grid.append(picture(r, screens, rows), choices(r));
      const box = el('div', 'xm-detailbox');
      box.appendChild(grid);
      return box;
    }

    return { detail };
  }

  return { create, spot, partOf, glideFrames, tabParts };
});
