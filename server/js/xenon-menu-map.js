'use strict';

// The map of the Widgets section: the person's real screens, as they stand on the desktop,
// with the real widgets on them. Dragged here a widget moves by the same rules as on the
// screen (js/layer-drag.js), also from one monitor to another, and where it is let go is
// where it stays. Rows, acts and words come from the server (server/menu-widgets.js).
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./layer-drag.js') : root.LayerDrag);
  if (node) module.exports = api;
  if (root) root.XenonMenuMap = api;
})(typeof window !== 'undefined' ? window : globalThis, function (LayerDrag) {
  const CLICK_PX = 4;          // less than this is a tap, not a drag
  const SNAP = 0.012;          // of the screen: the pull of an edge, a middle, another widget
  const NUDGE = 0.01;          // an arrow key
  const MIN_BOX = Object.freeze({ w: 0.04, h: 0.05 });
  // Of the screen: past these the letters of the performance words stop changing.
  const WORDS_WIDTH = Object.freeze({ min: 0.05, max: 0.25 });
  const AREA = Object.freeze({ w: 1, h: 1 });
  const NO_SCREENS = Object.freeze([{ key: '', width: 16, height: 9 }]);
  // The places for the windows of the apps, as fractions of the main screen.
  const APP_W = 0.29;
  const APP_H = 0.4;
  const APP_SLOTS = Object.freeze([
    { x: 0.66, y: 0.5 }, { x: 0.35, y: 0.5 }, { x: 0.04, y: 0.5 },
    { x: 0.66, y: 0.06 }, { x: 0.35, y: 0.06 }, { x: 0.04, y: 0.06 },
  ]);
  const ARROWS = Object.freeze({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] });

  const hasPlace = (m) => Number.isInteger(m.x) && Number.isInteger(m.y);
  const sizeOf = (m) => ({ w: m.width || 16, h: m.height || 9 });

  // Every screen with its place: the shell's, or in a row when it sends none.
  function placed(screens) {
    if (screens.every(hasPlace)) return screens.map((m) => ({ ...m, ...sizeOf(m) }));
    let x = 0;
    return screens.map((m) => {
      const at = { ...m, ...sizeOf(m), x, y: 0 };
      x += at.w;
      return at;
    });
  }

  // Each screen in percent of the box around them all, and that box's shape.
  function layout(screens) {
    const all = placed(screens.length ? screens : NO_SCREENS);
    const left = Math.min(...all.map((m) => m.x));
    const top = Math.min(...all.map((m) => m.y));
    const w = Math.max(...all.map((m) => m.x + m.w)) - left;
    const h = Math.max(...all.map((m) => m.y + m.h)) - top;
    return {
      ratio: w / h,
      screens: all.map((m) => ({
        ...m, left: (m.x - left) / w * 100, top: (m.y - top) / h * 100, width: m.w / w * 100, height: m.h / h * 100,
      })),
    };
  }

  const rectText = (r) => ['x', 'y', 'w', 'h'].map((n) => Math.round(r[n] * 10000) / 10000).join(',');

  // What a drop writes: the exact box, and the screen when it changed.
  function moveFor(row, box, screen) {
    const run = { type: 'layerMove', target: row.at.lead, position: 'keep', size: 'keep', rect: rectText(box) };
    if (screen === row.at.monitor) return run;
    return { ...run, ...(screen ? { monitor: screen } : { screen: 'main' }) };
  }

  // One box per group of tabs: they share a place.
  function boxesOf(rows) {
    const seen = new Set();
    return rows.filter((r) => r.at.rect && !seen.has(r.at.lead) && seen.add(r.at.lead));
  }

  // ctx: { el, say, perform, thumb, open }
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  /** Where `count` app windows go: first the places no widget covers, then the others. */
  function windowSpots(count, taken) {
    const covered = (s) => taken.some((t) => overlaps({ ...s, w: APP_W, h: APP_H }, t));
    const order = [...APP_SLOTS.filter((s) => !covered(s)), ...APP_SLOTS.filter(covered)];
    return Array.from({ length: count }, (_, i) => order[i % order.length]);
  }

  function create(ctx) {
    const { el, say, perform, thumb, open } = ctx;
    let held = false;
    let saving = Promise.resolve();

    // From the drop on, the map is what is true: the server answers later, and a drag
    // started from the old box put the old size back. Saves wait their turn, because
    // the menu drops an action while another one runs.
    function save(r, box, screen) {
      const act = { run: moveFor(r, box, screen) };
      r.at.rect = box;
      r.at.monitor = screen;
      saving = saving.then(() => perform(r, act));
    }

    function place(node, r) {
      for (const n of ['x', 'y', 'w', 'h']) node.style.setProperty('--xm-m' + n, r[n] * 100 + '%');
    }

    function guide(screen, axis, at) {
      if (at === null) return;
      const line = el('i', 'xm-snap xm-snap--' + axis);
      line.style.setProperty('--xm-at', at * 100 + '%');
      screen.appendChild(line);
    }

    function widgetNode(r, picked) {
      const look = r.at.words ? ' is-words' : r.at.bare ? ' is-bare' : '';
      const node = el('div', `xm-mapw${look}${r.id === picked ? ' is-picked' : ''}`);
      node.tabIndex = 0;
      node.setAttribute('role', 'button');
      node.setAttribute('aria-label', say(r.label));
      node.title = say(r.label);
      node.dataset.keep = `map:${r.id}`;
      node.appendChild(thumb(r));
      place(node, r.at.rect);
      return node;
    }

    // Document listeners, never a capture: crossing screens moves the node in the page.
    function track(move, done) {
      const stop = (e) => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', stop);
        document.removeEventListener('pointercancel', stop);
        held = false;
        done(e);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', stop);
      document.addEventListener('pointercancel', stop);
    }

    function drag(node, r, view) {
      node.addEventListener('pointerdown', (down) => {
        if (down.button) return;
        down.preventDefault();
        const start = view.screenOf(r);
        const first = start.node.getBoundingClientRect();
        let from = start;
        let box = r.at.rect;
        let moved = false;
        let grab = { x: (down.clientX - first.left) / first.width - box.x, y: (down.clientY - first.top) / first.height - box.y };
        const follow = (e) => {
          if (!moved && Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < CLICK_PX) return;
          moved = true;
          held = true;
          node.classList.add('is-moving');
          const to = view.screenAt(e.clientX, e.clientY) || from;
          const area = to.node.getBoundingClientRect();
          const at = { x: (e.clientX - area.left) / area.width, y: (e.clientY - area.top) / area.height };
          if (to !== from) {
            box = LayerDrag.carry(box, from, to, at);
            grab = { x: box.w / 2, y: box.h / 2 };
            from = to;
            to.node.appendChild(node);
          }
          const step = LayerDrag.move({ ...box, x: 0, y: 0 }, at.x - grab.x, at.y - grab.y, AREA, LayerDrag.linesFor(AREA, view.others(r, to)), SNAP);
          box = step.box;
          place(node, box);
          view.clearGuides();
          guide(to.node, 'x', step.guides.x);
          guide(to.node, 'y', step.guides.y);
        };
        track(follow, (e) => {
          node.classList.remove('is-moving');
          view.clearGuides();
          if (moved) save(r, box, from.key);
          else if (e.type === 'pointerup') open(r);
        });
      });
    }

    // The widget in view has a corner to pull. Words grow as a whole, so they stay readable.
    function corner(node, r, view) {
      const grip = el('span', 'xm-mapgrip');
      grip.setAttribute('aria-hidden', 'true');
      grip.addEventListener('pointerdown', (down) => {
        if (down.button) return;
        down.preventDefault();
        down.stopPropagation();
        const screen = view.screenOf(r);
        const area = screen.node.getBoundingClientRect();
        const start = r.at.rect;
        const lines = LayerDrag.linesFor(AREA, view.others(r, screen));
        let box = null;
        track((e) => {
          held = true;
          node.classList.add('is-moving');
          const dx = (e.clientX - down.clientX) / area.width;
          const dy = (e.clientY - down.clientY) / area.height;
          const step = r.at.words
            ? { box: LayerDrag.scaleWords(start, start, dx, AREA, WORDS_WIDTH), guides: { x: null, y: null } }
            : LayerDrag.stretch(start, dx, dy, AREA, lines, SNAP, MIN_BOX);
          box = step.box;
          place(node, box);
          view.clearGuides();
          guide(screen.node, 'x', step.guides.x);
          guide(screen.node, 'y', step.guides.y);
        }, () => {
          node.classList.remove('is-moving');
          view.clearGuides();
          if (box) save(r, box, screen.key);
        });
      });
      node.appendChild(grip);
    }

    function keys(node, r, view) {
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(r); return; }
        const way = ARROWS[e.key];
        if (!way) return;
        e.preventDefault();
        const { x, y, w, h } = r.at.rect;
        const box = e.shiftKey
          ? LayerDrag.stretch(r.at.rect, way[0] * NUDGE, way[1] * NUDGE, AREA, { xs: [], ys: [] }, 0, MIN_BOX).box
          : { x: Math.min(Math.max(x + way[0] * NUDGE, 0), 1 - w), y: Math.min(Math.max(y + way[1] * NUDGE, 0), 1 - h), w, h };
        save(r, box, view.screenOf(r).key);
      });
    }

    // A widget on an app has no place on a screen: it goes where the window goes. So the
    // map draws the window, on the main screen, with the widget in its corner.
    function appNode(r, spot) {
      const node = el('div', 'xm-mapapp');
      node.tabIndex = 0;
      node.setAttribute('role', 'button');
      node.setAttribute('aria-label', say(r.label));
      node.dataset.keep = `map:${r.id}`;
      node.style.setProperty('--xm-mx', (spot.x * 100) + '%');
      node.style.setProperty('--xm-my', (spot.y * 100) + '%');
      const part = el('span', `xm-mapapp-widget is-${r.at.corner}`);
      part.appendChild(thumb(r));
      node.append(el('span', 'xm-mapapp-bar', r.at.app), part);
      node.addEventListener('click', () => open(r));
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(r); }
      });
      return node;
    }

    function screenNode(m) {
      const node = el('div', 'xm-mapscreen');
      for (const n of ['left', 'top', 'width', 'height']) node.style.setProperty('--xm-s' + n, m[n] + '%');
      node.style.setProperty('--xm-ratio', String(m.w / m.h));
      if (m.label) node.appendChild(el('span', 'xm-mapname', say(m.label)));
      return node;
    }

    // `rows`: the widgets to show. `picked`: the one this screen is about, if any.
    function draw(screens, rows, picked) {
      const shape = layout(screens);
      const map = el('div', 'xm-map');
      map.style.setProperty('--xm-ratio', String(shape.ratio));
      const all = shape.screens.map((m) => ({ ...m, node: screenNode(m) }));
      map.append(...all.map((m) => m.node));
      const shown = boxesOf(rows);
      const view = {
        screenOf: (r) => all.find((m) => m.key === r.at.monitor) || all[0],
        screenAt: (x, y) => all.find((m) => {
          const b = m.node.getBoundingClientRect();
          return x >= b.left && x < b.right && y >= b.top && y < b.bottom;
        }),
        others: (r, m) => shown.filter((o) => o !== r && view.screenOf(o) === m).map((o) => o.at.rect),
        clearGuides: () => map.querySelectorAll('.xm-snap').forEach((g) => g.remove()),
      };
      for (const r of shown) {
        const node = widgetNode(r, picked);
        drag(node, r, view);
        keys(node, r, view);
        if (r.id === picked) corner(node, r, view);
        view.screenOf(r).node.appendChild(node);
      }
      const main = all.find((m) => !m.key) || all[0];
      const apps = rows.filter((r) => r.at.corner);
      const spots = windowSpots(apps.length, shown.filter((r) => view.screenOf(r) === main).map((r) => r.at.rect));
      apps.forEach((r, i) => main.node.appendChild(appNode(r, spots[i])));
      return map;
    }

    return { draw, holds: () => held };
  }

  return { create, layout, moveFor, boxesOf, windowSpots };
});
