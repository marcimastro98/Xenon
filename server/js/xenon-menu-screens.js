'use strict';

// The screens of the Look section (rows from server/menu-look.js), laid out like a
// widget's screen: the real screens stay in place on one side, the one tapped plays its
// scene, and its choices sit in tabs beside it. A scene list is one answer per line, and
// passing over a line plays that scene in the screen's picture. Which screen and tab are
// open is this page's own; a tap redraws only this block.
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./xenon-menu-map.js') : root.XenonMenuMap);
  if (node) module.exports = api;
  if (root) root.XenonMenuScreens = api;
})(typeof window !== 'undefined' ? window : globalThis, function (MenuMap) {
  // The one shown: the screen tapped before if it is still there, else the first.
  const pickedOf = (screens, key) => screens.find((m) => m.key === key) || screens[0] || null;
  const tabOf = (view, id) => (view.tabs || []).find((t) => t.id === id) || (view.tabs || [])[0] || null;

  // ctx: { el, button, say, DRAW, perform, icon, slot, hold, settle }
  function create(ctx) {
    const { el, button, say, DRAW, perform, icon } = ctx;
    let picked = '';
    const chosenTab = new Map();   // screen key -> the tab left open
    let moreOpen = false;

    function says(line) {
      const row = el('span', 'xm-scrsays');
      row.append(el('span', 'xm-scrsays-label', say(line.label)), el('span', 'xm-scrsays-value', say(line.value)));
      return row;
    }

    function screenNode(m, on, pick, live) {
      const b = button('xm-mapscreen xm-scrpick');
      for (const n of ['left', 'top', 'width', 'height']) b.style.setProperty('--xm-s' + n, m[n] + '%');
      b.style.setProperty('--xm-ratio', String(m.w / m.h));
      b.setAttribute('aria-pressed', String(on));
      b.dataset.keep = 'screen:' + m.key;
      if (on && live) b.appendChild(live);
      const words = el('span', 'xm-scrwords');
      words.append(el('span', 'xm-scrname', say(m.label)), ...(m.says || []).map(says));
      b.appendChild(words);
      b.addEventListener('click', () => pick(m.key));
      return b;
    }

    function moreItem(more, redraw) {
      const box = el('div', 'xm-scenemore');
      const b = button('xm-sceneopt xm-sceneopt--more');
      b.setAttribute('aria-expanded', String(moreOpen));
      b.dataset.keep = 'scenes:more';
      const words = el('span', 'xm-sceneopt-words');
      words.append(el('span', 'xm-sceneopt-name', say(more.label)), el('span', 'xm-sub', say(more.sub)));
      b.append(icon('plus') || '', words);
      b.addEventListener('click', () => { moreOpen = !moreOpen; redraw(); });
      box.appendChild(b);
      if (moreOpen && DRAW.button) box.appendChild(DRAW.button(more));
      return box;
    }

    // One scene per line, with a tick on the one in use.
    function sceneList(r, live, more, redraw) {
      const li = ctx.rowShell(r, 'xm-row--stack xm-scenes');
      const list = el('div', 'xm-scenelist');
      list.setAttribute('role', 'group');
      list.setAttribute('aria-label', say(r.label));
      for (const o of r.options || []) {
        const on = String(o.value) === String(r.value);
        const b = button('xm-sceneopt');
        b.setAttribute('aria-pressed', String(on));
        b.dataset.keep = `${r.id}:${o.value}`;
        b.append(el('span', 'xm-sceneopt-name', say(o.label)), el('span', 'xm-sceneopt-tick'));
        b.addEventListener('click', () => { if (!on) perform(r, o.act); });
        if (live) live.follow(b, o.value);
        list.appendChild(b);
      }
      if (more) list.appendChild(moreItem(more, redraw));
      li.appendChild(list);
      return li;
    }

    function tabBar(view, current, choose) {
      const bar = el('div', 'xm-wtabs xm-scrtabs');
      bar.setAttribute('role', 'tablist');
      bar.append(...view.tabs.map((t) => {
        const b = button('xm-wtab');
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(t.id === current.id));
        b.dataset.keep = `screen:${view.key}:${t.id}`;
        b.append(el('span', 'xm-wtab-name', say(t.label)), el('span', 'xm-wtab-value', say(t.value)));
        b.addEventListener('click', () => choose(t.id));
        return b;
      }));
      return bar;
    }

    // The tab's rows; a scene list carries the screen's moving preview (`live`).
    function panelOf(tab, r, redraw) {
      let live = null;
      const panel = el('div', 'xm-list xm-wpanel xm-scrrows');
      panel.setAttribute('role', 'tabpanel');
      for (const x of tab ? tab.rows : []) {
        if (x.scenes) {
          if (x.live && !live && ctx.slot) live = ctx.slot(x.value);
          panel.appendChild(sceneList(x, live, r.more, redraw));
        } else if (DRAW[x.kind]) panel.appendChild(DRAW[x.kind](x));
      }
      return { panel, live };
    }

    function paint(box, r) {
      const view = pickedOf(r.screens, picked);
      const redraw = (focus) => {
        if (ctx.hold) ctx.hold();
        paint(box, r);
        if (ctx.settle) ctx.settle();
        const again = focus && box.querySelector(`[data-keep="${CSS.escape(focus)}"]`);
        if (again) again.focus();
      };
      const pick = (key) => {
        if (key === picked) return;
        picked = key;
        moreOpen = false;
        redraw('screen:' + key);
      };
      const tab = view ? tabOf(view, chosenTab.get(view.key)) : null;
      const { panel, live } = panelOf(tab, r, () => redraw('scenes:more'));
      const shape = MenuMap.layout(r.screens);
      const map = el('div', 'xm-map xm-scrmap');
      map.style.setProperty('--xm-ratio', String(shape.ratio));
      map.append(...shape.screens.map((m) => screenNode(m, !!view && m.key === view.key, pick, live && live.box)));
      const pic = el('div', 'xm-detail-pic');
      pic.append(map, el('p', 'xm-cap', say(r.sub)));
      const choices = el('div', 'xm-detail-choices');
      if (view) {
        const choose = (id) => { chosenTab.set(view.key, id); moreOpen = false; redraw(`screen:${view.key}:${id}`); };
        choices.append(el('h3', 'xm-scrtitle', say(view.label)), tabBar(view, tab, choose), panel);
      }
      const grid = el('div', 'xm-detail');
      grid.append(pic, choices);
      const parts = [grid];
      if (r.theme && DRAW.button) {
        const theme = el('div', 'xm-list xm-scrtheme');
        theme.appendChild(DRAW.button(r.theme));
        parts.push(theme);
      }
      box.replaceChildren(...parts);
    }

    function draw(r) {
      const li = el('div', 'xm-row xm-row--stack xm-scrrow');
      li.dataset.row = r.id;
      const box = el('div', 'xm-detailbox xm-scrbox');
      li.appendChild(box);
      paint(box, r);
      return li;
    }

    return { draw };
  }

  return { create, pickedOf, tabOf };
});
